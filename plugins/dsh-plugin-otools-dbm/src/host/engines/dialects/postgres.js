/**
 * PostgreSQL, and Kingbase ES which is a fork of it.
 *
 * Three things here trip up a reader arriving from mysql.js:
 *
 * - A pg connection is bound to one database for its whole life. There is no
 *   `USE`, so `useDatabase` is null and the engine opens a separate connection per
 *   database; every `database` argument below is ignored on purpose, because the
 *   catalogs only ever describe the database the connection is already in. The
 *   second level of a name is the schema, and `qualify` never prints a database.
 * - There is no inline column comment and no SHOW CREATE TABLE. Any designer edit
 *   that touches a comment becomes a second `COMMENT ON …` statement, which is why
 *   the DDL methods here return several statements where MySQL returns one.
 * - `information_schema` alone cannot describe a pg column: it spells `data_type`
 *   as 'character varying' with the length in another field and knows nothing
 *   about comments, so the readable type and the comment are read from the
 *   catalogs with `format_type` / `col_description` instead.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/postgres
 */
import { SqlDialect } from '../sql-dialect.js'

/** Types where the designer's length box belongs inside the type name. */
const SIZED_TYPES = /^(varchar|character varying|char|character|bpchar)$/i

/** pg's `serial` macros, and the real integer type each one expands to. */
const SERIAL_TYPES = { smallserial: 'SMALLINT', serial: 'INTEGER', bigserial: 'BIGINT' }

export class PostgresDialect extends SqlDialect {
  get dbType() {
    return 'postgresql'
  }

  get hasSchemas() {
    return true
  }

  quote(name) {
    return `"${String(name).replace(/"/g, '""')}"`
  }

  /**
   * Only the quote doubles.
   *
   * The base class doubles backslashes too, which is MySQL's rule; with
   * `standard_conforming_strings = on` (pg's default since 9.1) a backslash inside
   * a literal is just a backslash, so doubling it would corrupt the value — and
   * these literals carry user prose, not only identifiers.
   */
  literal(value) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  /** pg binds are positional: `$1`, `$2`, … */
  placeholder(index) {
    const position = Math.trunc(Number(index) || 1)
    return `$${position > 0 ? position : 1}`
  }

  /**
   * `"schema"."table"`.
   *
   * The database never appears. pg cannot reach another database from inside a
   * session, so a three-part name would not even parse, and the engine has already
   * chosen the connection that sees this table.
   */
  qualify({ schema, table } = {}) {
    const parts = []
    if (schema !== undefined && schema !== null && String(schema).length > 0) {
      parts.push(this.quote(schema))
    }
    if (table !== undefined && table !== null && String(table).length > 0) {
      parts.push(this.quote(table))
    }
    return parts.join('.')
  }

  /** Nothing — switching database means a new connection, which the engine opens. */
  useDatabase() {
    return null
  }

  useSchema(schema) {
    return `SET search_path TO ${this.quote(schema)}`
  }

  /** The schema to introspect: the caller's, else pg's own default. */
  schemaOrDefault(schema) {
    return schema === undefined || schema === null || String(schema).length === 0 ? 'public' : String(schema)
  }

  catalogFilter(_database, schema) {
    return `table_schema = ${this.literal(this.schemaOrDefault(schema))}`
  }

  routineFilter(_database, schema) {
    return `routine_schema = ${this.literal(this.schemaOrDefault(schema))}`
  }

  // ------------------------------------------------------------ introspection
  showDatabases() {
    return `SELECT datname AS name FROM pg_database
      WHERE datistemplate = false AND datallowconn = true
      ORDER BY datname`
  }

  /**
   * pg's own schemas are `pg_catalog`, `pg_toast`, `pg_temp_*`. The underscore is
   * escaped because it is LIKE's single-character wildcard: a plain 'pg_%' would
   * also swallow a user schema called `pgagent`.
   */
  showSchemas() {
    return `SELECT schema_name AS name FROM information_schema.schemata
      WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema'
      ORDER BY schema_name`
  }

  showTables(database, schema) {
    return `SELECT table_name AS name FROM information_schema.tables
      WHERE ${this.catalogFilter(database, schema)} AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  }

  showViews(database, schema) {
    return `SELECT table_name AS name FROM information_schema.views
      WHERE ${this.catalogFilter(database, schema)} ORDER BY table_name`
  }

  showProcedures(database, schema) {
    return `SELECT routine_name AS name FROM information_schema.routines
      WHERE ${this.routineFilter(database, schema)} ORDER BY routine_name`
  }

  /**
   * The one query in this file worth reading twice.
   *
   * `information_schema.columns` holds the portable half — nullability, default,
   * declared length — but spells the type in standard prose ('character varying'),
   * so the displayable type comes from `format_type` over `pg_attribute`. The
   * comment is looked up by `attnum` and not by `ordinal_position`: the two drift
   * apart the moment a column has been dropped from the table, and the wrong one
   * would hand every comment after the hole to its neighbour.
   *
   * `extra` is MySQL's column, filled in here so the designer can see that a
   * default of `nextval(…)` is what pg calls a serial.
   */
  showColumns(_database, table, schema) {
    const owner = this.literal(this.schemaOrDefault(schema))
    return `SELECT
        c.column_name AS name,
        c.data_type AS data_type,
        COALESCE(format_type(a.atttypid, a.atttypmod), c.data_type) AS full_type,
        c.is_nullable AS is_nullable,
        c.column_default AS default_value,
        CASE WHEN EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c2.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
        ) THEN 1 ELSE 0 END AS is_primary_key,
        c.character_maximum_length AS character_maximum_length,
        COALESCE(col_description(c2.oid, a.attnum::int), '') AS column_comment,
        CASE WHEN c.column_default LIKE 'nextval(%' THEN 'auto_increment' ELSE '' END AS extra
      FROM information_schema.columns c
      LEFT JOIN pg_namespace n ON n.nspname = c.table_schema
      LEFT JOIN pg_class c2 ON c2.relnamespace = n.oid AND c2.relname = c.table_name
      LEFT JOIN pg_attribute a ON a.attrelid = c2.oid AND a.attname = c.column_name
        AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.table_schema = ${owner} AND c.table_name = ${this.literal(table)}
      ORDER BY c.ordinal_position`
  }

  showPrimaryKeys(_database, table, schema) {
    return `SELECT kcu.column_name AS column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = ${this.literal(this.schemaOrDefault(schema))}
        AND tc.table_name = ${this.literal(table)}
      ORDER BY kcu.ordinal_position`
  }

  /**
   * Read from `pg_constraint` rather than from `information_schema`, because the
   * standard views cannot pair a composite key up: joining `key_column_usage` to
   * `constraint_column_usage` crosses every local column with every referenced one,
   * so a two-column foreign key comes back as four wrong rows. `conkey` and
   * `confkey` are real arrays and unnest side by side in the right order.
   */
  showForeignKeys(_database, table, schema) {
    return `SELECT
        con.conname AS constraint_name,
        a.attname AS column_name,
        fn.nspname AS referenced_schema,
        fc.relname AS referenced_table,
        fa.attname AS referenced_column
      FROM pg_constraint con
      JOIN pg_class ct ON ct.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = ct.relnamespace
      JOIN pg_class fc ON fc.oid = con.confrelid
      JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(att, fatt, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.att
      JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fatt
      WHERE con.contype = 'f'
        AND n.nspname = ${this.literal(this.schemaOrDefault(schema))}
        AND ct.relname = ${this.literal(table)}
      ORDER BY con.conname, k.ord`
  }

  /**
   * One row per indexed column, in index order — `indkey` is a vector of attnums,
   * and only `unnest … WITH ORDINALITY` keeps that order once it is joined out.
   *
   * An expression index stores attnum 0 and has no `pg_attribute` row, so those
   * columns (and an index made only of expressions) drop out of the join. The
   * panel's index list is a list of plain column indexes; the DDL text it shows
   * elsewhere is where an expression index stays readable.
   */
  showIndexes(_database, table, schema) {
    return `SELECT
        ci.relname AS name,
        a.attname AS column_name,
        CASE WHEN ix.indisunique THEN 1 ELSE 0 END AS is_unique
      FROM pg_index ix
      JOIN pg_class ct ON ct.oid = ix.indrelid
      JOIN pg_class ci ON ci.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = ct.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = ct.oid AND a.attnum = k.attnum
      WHERE n.nspname = ${this.literal(this.schemaOrDefault(schema))}
        AND ct.relname = ${this.literal(table)}
      ORDER BY ci.relname, k.ord`
  }

  /**
   * The `::regclass` cast is how pg turns a name into the oid the comment hangs
   * off, and it raises an error rather than returning null when the table is gone —
   * which is fine here, because the caller is always looking at a table it has just
   * listed.
   */
  showTableComment(_database, table, schema) {
    const target = this.literal(this.qualify({ schema: this.schemaOrDefault(schema), table }))
    return `SELECT obj_description(${target}::regclass) AS comment`
  }

  /**
   * Nothing. pg has no SHOW CREATE TABLE — pg_dump composes the DDL on the client
   * side — so the engine falls back to composing it from the table struct it has
   * already read through `showColumns` / `showIndexes`.
   */
  showCreateTable() {
    return null
  }

  viewSource(_database, view, schema) {
    const target = this.literal(this.qualify({ schema: this.schemaOrDefault(schema), table: view }))
    return `SELECT pg_get_viewdef(${target}::regclass, true) AS definition`
  }

  /**
   * A pg function name is not unique — it can be overloaded — so this can return
   * several rows and the engine shows the first; the identity arguments come along
   * so the panel can say which overload it is showing.
   *
   * `pg_get_functiondef` errors on an aggregate, which never reaches here: the tree
   * lists routines from `information_schema.routines`, and that view leaves
   * aggregates out.
   */
  procedureSource(_database, procedure, schema) {
    return `SELECT
        pg_get_functiondef(p.oid) AS definition,
        p.proname AS routine_name,
        pg_get_function_identity_arguments(p.oid) AS routine_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${this.literal(this.schemaOrDefault(schema))}
        AND p.proname = ${this.literal(procedure)}
      ORDER BY p.oid`
  }

  /**
   * Grouped per schema, not per database: one connection only ever sees one
   * database, so the schema is the level the panel can actually compare. The alias
   * stays `database_name` because that is the column the dashboard reads.
   *
   * `reltuples` is the planner's estimate, not a count — it is -1 on a table that
   * has never been analysed, hence the GREATEST — and a real count over every table
   * is far too expensive for a dashboard panel.
   */
  stats() {
    return `SELECT
        n.nspname AS database_name,
        COUNT(*) AS table_count,
        COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint AS row_count,
        COALESCE(SUM(pg_total_relation_size(c.oid) - pg_indexes_size(c.oid)), 0) AS data_size,
        COALESCE(SUM(pg_indexes_size(c.oid)), 0) AS index_size
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      GROUP BY n.nspname
      ORDER BY n.nspname`
  }

  // -------------------------------------------------------------------- DDL
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'TEXT'
    }
    // A type the designer already spelled out in full (`varchar(64)`, `numeric(10,2)`)
    // is used as written; the length box only applies to the bare character types.
    if (/[(]/.test(type)) {
      return type
    }
    if (SERIAL_TYPES[type.toLowerCase()] !== undefined) {
      return type.toUpperCase()
    }
    const length = Number(column?.character_maximum_length)
    if (Number.isFinite(length) && length > 0 && SIZED_TYPES.test(type)) {
      return `${type.toUpperCase()}(${length})`
    }
    return type
  }

  /**
   * The type for `ALTER COLUMN … TYPE`.
   *
   * `serial` only exists inside CREATE TABLE, where pg expands it into an integer
   * plus a sequence plus a default. An ALTER has to name that integer instead, or
   * the server answers "type serial does not exist".
   */
  alterType(column) {
    const type = this.columnType(column)
    return SERIAL_TYPES[type.toLowerCase()] ?? type
  }

  /** No inline COMMENT: pg has no such syntax, so comments follow as statements. */
  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    parts.push(column.is_nullable === false ? 'NOT NULL' : 'NULL')
    const fallback = column.default_value
    if (fallback !== undefined && fallback !== null && String(fallback).length > 0) {
      parts.push(`DEFAULT ${this.defaultExpression(fallback)}`)
    }
    return parts.join(' ')
  }

  /**
   * A DEFAULT the designer typed.
   *
   * Same problem as MySQL — `0` must not be quoted and `hello` must — with two pg
   * twists: a cast suffix (`'{}'::jsonb`, `now()::date`) has to survive untouched,
   * and a double-quoted word is an *identifier* here, not a string, so it is quoted
   * as text like any other prose the user typed.
   */
  defaultExpression(value) {
    const text = String(value).trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text
    }
    if (/^(null|true|false|current_timestamp|current_date|current_time|localtimestamp)$/i.test(text)) {
      return text.toUpperCase()
    }
    if (/^'.*'(::[\w ."[\]]+)?$/.test(text)) {
      return text
    }
    if (/^[A-Za-z_][\w.]*\s*\(.*\)(::[\w ."[\]]+)?$/.test(text)) {
      return text
    }
    return this.literal(text)
  }

  /**
   * The `COMMENT ON COLUMN` follow-up, or nothing.
   *
   * An empty string is the designer deliberately clearing a comment, which pg spells
   * `IS NULL`; `undefined` means the caller is not touching the comment at all, so
   * no statement is produced and whatever is there survives.
   */
  columnComment(target, column) {
    const comment = column?.column_comment
    if (comment === undefined || comment === null) {
      return []
    }
    const text = String(comment).length === 0 ? 'NULL' : this.literal(comment)
    return [`COMMENT ON COLUMN ${target}.${this.quote(column.name)} IS ${text}`]
  }

  createTable({ database, schema, table, columns, comment }) {
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    const target = this.qualify({ database, schema, table })
    const statements = [`CREATE TABLE ${target} (\n  ${body.join(',\n  ')}\n)`]
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      statements.push(`COMMENT ON TABLE ${target} IS ${this.literal(comment)}`)
    }
    for (const column of columns) {
      if (String(column.column_comment ?? '').length > 0) {
        statements.push(...this.columnComment(target, column))
      }
    }
    return statements
  }

  addColumn({ database, schema, table, column }) {
    const target = this.qualify({ database, schema, table })
    const statements = [`ALTER TABLE ${target} ADD COLUMN ${this.columnDefinition(column)}`]
    if (String(column.column_comment ?? '').length > 0) {
      statements.push(...this.columnComment(target, column))
    }
    return statements
  }

  /**
   * What MySQL says in one MODIFY COLUMN, pg says in one statement per property —
   * and there is no way to hand it a whole column at once. The designer submits the
   * finished column rather than a diff, so every property is set unconditionally;
   * the `USING` clause is what makes the type change cast the existing rows instead
   * of being refused.
   */
  modifyColumn({ database, schema, table, column }) {
    const target = this.qualify({ database, schema, table })
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    const name = this.quote(column.name)
    const type = this.alterType(column)
    const statements = []
    if (from !== column.name) {
      statements.push(`ALTER TABLE ${target} RENAME COLUMN ${this.quote(from)} TO ${name}`)
    }
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} TYPE ${type} USING ${name}::${type}`)
    const nullability = column.is_nullable === false ? 'SET NOT NULL' : 'DROP NOT NULL'
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} ${nullability}`)
    const fallback = column.default_value
    const hasDefault = fallback !== undefined && fallback !== null && String(fallback).length > 0
    statements.push(hasDefault
      ? `ALTER TABLE ${target} ALTER COLUMN ${name} SET DEFAULT ${this.defaultExpression(fallback)}`
      : `ALTER TABLE ${target} ALTER COLUMN ${name} DROP DEFAULT`)
    return [...statements, ...this.columnComment(target, column)]
  }

  setTableComment({ database, schema, table, comment }) {
    const text = comment === undefined || comment === null || String(comment).length === 0
      ? 'NULL'
      : this.literal(comment)
    return [`COMMENT ON TABLE ${this.qualify({ database, schema, table })} IS ${text}`]
  }

  /** An index is a schema object of its own in pg, and DROP INDEX takes no table. */
  dropIndex({ schema, index }) {
    return [`DROP INDEX ${this.qualify({ schema, table: index })}`]
  }
}

/**
 * Kingbase ES.
 *
 * A PostgreSQL fork, close enough that everything above is inherited unchanged. The
 * one thing that bites: not every build answers `obj_description(…::regclass)`, and
 * a table comment that errors would take the whole table load down with it, so the
 * comment is simply not read here — a missing comment costs the panel one grey line,
 * a broken statement costs it the table.
 */
export class KingbaseDialect extends PostgresDialect {
  get dbType() {
    return 'kingbasees'
  }

  showTableComment() {
    return null
  }
}
