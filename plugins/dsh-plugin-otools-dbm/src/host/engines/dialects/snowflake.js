/**
 * Snowflake.
 *
 * Two things to know before reading the statements below.
 *
 * 1. Snowflake folds unquoted identifiers to UPPER CASE exactly the way Oracle
 *    does, so `quote()` here is the same "quote only when you must" rule — see the
 *    long comment in `oracle.js` for why quoting everything would be wrong. Output
 *    aliases are quoted lower-case for the same reason: `AS name` comes back as
 *    `NAME` and the engine looks the contract's names up verbatim.
 * 2. `information_schema` is per DATABASE, not per account. The metadata of a
 *    database the session has not `USE`d is only readable as
 *    `"THAT_DB".information_schema.…`, which is why every statement builds its FROM
 *    through `catalog()`.
 *
 * There is no index metadata because there are no indexes, and no key metadata in
 * `information_schema` at all, so `showIndexes`/`showPrimaryKeys`/`showForeignKeys`
 * return null instead of a statement the panel would have to pretend about.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/snowflake
 */
import { SqlDialect } from '../sql-dialect.js'

export class SnowflakeDialect extends SqlDialect {
  get dbType() {
    return 'snowflake'
  }

  get hasSchemas() {
    return true
  }

  // `placeholder()`/`supportsBind` (`?`), `paginate` (`LIMIT n OFFSET m`),
  // `literal()` (Snowflake DOES process backslash escapes in a string literal, so
  // the base's doubling is right here), `countSql`, `emptySelect`, `addColumn`,
  // `dropColumn`, `truncateTable`, `createDatabase` and `dropDatabase` are all the
  // base's: Snowflake's spelling of them is the MySQL-shaped default.

  /** Same rule as `oracle.js`: an upper-case name needs no quotes, anything else does. */
  quote(name) {
    const text = String(name)
    if (/^[A-Z][A-Z0-9_$]*$/.test(text)) {
      return text
    }
    return `"${text.replace(/"/g, '""')}"`
  }

  /**
   * `"DB"."SCHEMA"."TABLE"` — all three parts, unlike Postgres.
   *
   * Snowflake really does take the database inline, and a two-part name means
   * schema.table, so a database with no schema has to name one or `"MYDB"."T"`
   * would be read as schema MYDB. PUBLIC is the schema every database is created
   * with. (Snowflake's `db..table` shorthand means the same thing; spelled out it
   * is greppable.)
   */
  qualify({ database, schema, table } = {}) {
    const parts = []
    const hasDatabase = database !== undefined && database !== null && String(database).length > 0
    const hasSchema = schema !== undefined && schema !== null && String(schema).length > 0
    if (hasDatabase) {
      parts.push(this.quote(database))
      parts.push(this.quote(this.schemaName(schema)))
    } else if (hasSchema) {
      parts.push(this.quote(schema))
    }
    if (table !== undefined && table !== null && String(table).length > 0) {
      parts.push(this.quote(table))
    }
    return parts.join('.')
  }

  /**
   * The `information_schema` to read from, qualified with the database when we know
   * it. Unqualified it resolves in the session's current database, which is only
   * the right answer while the panel is looking at that one.
   */
  catalog(database) {
    if (database === undefined || database === null || String(database).length === 0) {
      return 'information_schema'
    }
    return `${this.quote(database)}.information_schema`
  }

  /**
   * The schema a statement is about, or Snowflake's default PUBLIC.
   *
   * Used as written, never folded: a Snowflake account built through dbt often has
   * genuinely lower-case schema and table names, and upper-casing here (which is
   * what `oracle.js` does, where lower-case names are freakish) would hide them.
   */
  schemaName(schema) {
    const text = schema === undefined || schema === null ? '' : String(schema).trim()
    return text.length === 0 ? 'PUBLIC' : text
  }

  /** WHERE fragment pinning an information_schema view to one schema. */
  schemaFilter(schema, column = 'table_schema') {
    return `${column} = ${this.literal(this.schemaName(schema))}`
  }

  useDatabase(database) {
    return `USE DATABASE ${this.quote(database)}`
  }

  useSchema(schema) {
    return `USE SCHEMA ${this.quote(schema)}`
  }

  // ------------------------------------------------------------ introspection
  /**
   * The databases the current role can see.
   *
   * `SHOW DATABASES` is the other way to ask and it is the worse one here: its
   * output is a fixed set of SHOW columns (`name`, `created_on`, `origin`, …) that
   * cannot be aliased, filtered or paginated as part of the statement, so the engine
   * would need a SHOW-specific row mapping for this one call. It is the fallback if
   * a deployment ever hides `information_schema.databases`.
   */
  showDatabases() {
    return `SELECT database_name AS "name" FROM information_schema.databases
      ORDER BY database_name`
  }

  showSchemas(database) {
    return `SELECT schema_name AS "name" FROM ${this.catalog(database)}.schemata
      WHERE schema_name <> 'INFORMATION_SCHEMA'
      ORDER BY schema_name`
  }

  showTables(database, schema) {
    // Transient, temporary and external tables are all tables as far as the tree is
    // concerned; Snowflake spells each of them out in `table_type`, and only
    // materialized views are deliberately left to `showViews`.
    return `SELECT table_name AS "name" FROM ${this.catalog(database)}.tables
      WHERE ${this.schemaFilter(schema)}
        AND table_type IN ('BASE TABLE', 'TEMPORARY TABLE', 'EXTERNAL TABLE')
      ORDER BY table_name`
  }

  showViews(database, schema) {
    return `SELECT table_name AS "name" FROM ${this.catalog(database)}.views
      WHERE ${this.schemaFilter(schema)} ORDER BY table_name`
  }

  showProcedures(database, schema) {
    return `SELECT procedure_name AS "name" FROM ${this.catalog(database)}.procedures
      WHERE ${this.schemaFilter(schema, 'procedure_schema')} ORDER BY procedure_name`
  }

  /**
   * Fields and their comments — Snowflake has a real `comment` column, no join.
   *
   * `is_primary_key` is a flat 0: there is no key metadata in
   * `information_schema.columns`, and the only way to get it is `SHOW PRIMARY KEYS IN
   * TABLE …`, whose SHOW-shaped output the engine does not run. A Snowflake primary
   * key is unenforced documentation anyway, so the grid loses nothing it can act on.
   *
   * Note that a plain VARCHAR reports as `TEXT` with the maximum 16 MB length, so
   * `full_type` reads `TEXT(16777216)` — that is genuinely what the column is.
   */
  showColumns(database, table, schema) {
    return `SELECT
        column_name AS "name",
        data_type AS "data_type",
        CASE
          WHEN character_maximum_length IS NOT NULL
            THEN data_type || '(' || character_maximum_length || ')'
          WHEN numeric_precision IS NOT NULL
            THEN data_type || '(' || numeric_precision || ',' || COALESCE(numeric_scale, 0) || ')'
          ELSE data_type
        END AS "full_type",
        is_nullable AS "is_nullable",
        column_default AS "default_value",
        0 AS "is_primary_key",
        character_maximum_length AS "character_maximum_length",
        comment AS "column_comment"
      FROM ${this.catalog(database)}.columns
      WHERE ${this.schemaFilter(schema)} AND table_name = ${this.literal(table)}
      ORDER BY ordinal_position`
  }

  /**
   * Null: the keys exist but are not queryable as a SELECT.
   *
   * `SHOW PRIMARY KEYS IN TABLE db.schema.t` is the only source, and SHOW returns a
   * fixed result shape the engine has no mapping for — so the panel gets "no key
   * information" rather than a wrong answer.
   */
  showPrimaryKeys() {
    return null
  }

  /** Null for the same reason: only `SHOW IMPORTED KEYS IN TABLE …` knows. */
  showForeignKeys() {
    return null
  }

  /** Null because Snowflake has no indexes. Clustering keys are not per-column. */
  showIndexes() {
    return null
  }

  showTableComment(database, table, schema) {
    return `SELECT comment AS "comment" FROM ${this.catalog(database)}.tables
      WHERE ${this.schemaFilter(schema)} AND table_name = ${this.literal(table)}`
  }

  /** GET_DDL takes the object's name as a STRING, so the qualified name is quoted twice over. */
  showCreateTable(database, table, schema) {
    return `SELECT GET_DDL('TABLE', ${this.literal(this.qualify({ database, schema, table }))}) AS "ddl"`
  }

  viewSource(database, view, schema) {
    // `view_definition` is empty for a role that may use the view but not read its
    // text; `GET_DDL('VIEW', …)` is the fallback when that happens.
    return `SELECT view_definition AS "definition" FROM ${this.catalog(database)}.views
      WHERE ${this.schemaFilter(schema)} AND table_name = ${this.literal(view)}`
  }

  /**
   * A procedure's body.
   *
   * `GET_DDL('PROCEDURE', …)` is the direct answer and it needs more than a name:
   * Snowflake procedures are overloaded on their arguments, so the name has to carry
   * the signature — `GET_DDL('PROCEDURE', 'db.schema.p(FLOAT, VARCHAR)')` — and the
   * panel only has `p`. information_schema hands back the body and the signature in
   * one plain SELECT, so that is what we ask for; `argument_signature` is exactly
   * what you would paste into GET_DDL by hand.
   */
  procedureSource(database, procedure, schema) {
    return `SELECT
        procedure_definition AS "definition",
        'PROCEDURE' AS "routine_type",
        procedure_name AS "routine_name",
        argument_signature AS "argument_signature"
      FROM ${this.catalog(database)}.procedures
      WHERE ${this.schemaFilter(schema, 'procedure_schema')}
        AND procedure_name = ${this.literal(procedure)}`
  }

  /**
   * Per-schema table count and size.
   *
   * Unlike MySQL's and Oracle's estimates these are the numbers Snowflake keeps for
   * the table itself: exact for base tables, NULL for views. `index_size` is 0
   * because there are no indexes to size.
   */
  stats(database) {
    return `SELECT
        table_schema AS "database_name",
        COUNT(*) AS "table_count",
        COALESCE(SUM(row_count), 0) AS "row_count",
        COALESCE(SUM(bytes), 0) AS "data_size",
        0 AS "index_size"
      FROM ${this.catalog(database)}.tables
      WHERE table_schema <> 'INFORMATION_SCHEMA'
      GROUP BY table_schema
      ORDER BY table_schema`
  }

  // -------------------------------------------------------------------- DDL
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'VARCHAR'
    }
    // Already spelled out in full (`NUMBER(10,2)`, `VARCHAR(64)`) → as written.
    if (/[(]/.test(type)) {
      return type
    }
    const length = Number(column?.character_maximum_length)
    const width = Number.isFinite(length) && length > 0 ? length : 0
    switch (type.toLowerCase()) {
      case 'varchar':
      case 'nvarchar':
      case 'char':
      case 'nchar':
      case 'string':
        // CHAR is VARCHAR(1) here and every character type is one implementation, so
        // there is nothing to gain by keeping the distinction.
        return width > 0 ? `VARCHAR(${width})` : 'VARCHAR'
      case 'text':
      case 'mediumtext':
      case 'longtext':
      case 'clob':
        return 'VARCHAR'
      case 'tinyint':
      case 'smallint':
      case 'int':
      case 'integer':
      case 'bigint':
      case 'decimal':
      case 'numeric':
        // One numeric type: NUMBER(38,0) by default, and INT is an alias for it.
        return 'NUMBER'
      case 'float':
      case 'double':
      case 'real':
        return 'FLOAT'
      case 'boolean':
      case 'bool':
      case 'bit':
        return 'BOOLEAN'
      case 'datetime':
      case 'timestamp':
        // Bare TIMESTAMP is an alias whose meaning follows the TIMESTAMP_TYPE_MAPPING
        // session parameter, so name the wall-clock one and stop it moving.
        return 'TIMESTAMP_NTZ'
      case 'json':
      case 'jsonb':
        return 'VARIANT'
      case 'blob':
      case 'binary':
      case 'varbinary':
        return 'BINARY'
      default:
        return type.toUpperCase()
    }
  }

  /** A DEFAULT the designer typed. Same idea as the MySQL dialect's, Snowflake's names. */
  defaultExpression(value) {
    const text = String(value).trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text
    }
    if (/^(null|true|false|current_timestamp(\(\))?|current_date|current_timestamp\(\d*\)|localtimestamp)$/i.test(text)) {
      return text.toUpperCase()
    }
    if (/^'.*'$/.test(text)) {
      return text
    }
    // A sequence (`app_seq.NEXTVAL`) or any function call.
    if (/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)+$/.test(text)) {
      return text
    }
    if (/^[A-Za-z_][A-Za-z0-9_$]*\s*\(.*\)$/.test(text)) {
      return text
    }
    return this.literal(text)
  }

  /**
   * One column inside CREATE TABLE / ADD COLUMN.
   *
   * Snowflake takes an inline `COMMENT 'x'` on a column, so there is no
   * `COMMENT ON COLUMN` round trip the way `oracle.js` needs. DEFAULT before NOT NULL
   * is the documented order, and COMMENT last is how `GET_DDL` prints it back.
   */
  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    const fallback = column.default_value
    if (fallback !== undefined && fallback !== null && String(fallback).length > 0) {
      parts.push(`DEFAULT ${this.defaultExpression(fallback)}`)
    }
    if (column.is_nullable === false) {
      parts.push('NOT NULL')
    }
    const comment = column.column_comment
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      parts.push(`COMMENT ${this.literal(comment)}`)
    }
    return parts.join(' ')
  }

  createTable({ database, schema, table, columns, comment }) {
    const body = columns.map((column) => this.columnDefinition(column))
    // Snowflake records a PRIMARY KEY and does not enforce it; it is documentation
    // the optimizer is allowed to trust, which is worth keeping in the DDL.
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    const tail = comment !== undefined && comment !== null && String(comment).length > 0
      ? ` COMMENT = ${this.literal(comment)}`
      : ''
    return [
      `CREATE TABLE ${this.qualify({ database, schema, table })} (\n  ${body.join(',\n  ')}\n)${tail}`,
    ]
  }

  /**
   * One column change, as the several statements Snowflake wants.
   *
   * Unlike Oracle, Snowflake does not mind being told what is already true, so the
   * nullability and the comment go out every time. Two limits are the server's, not
   * ours: `SET DATA TYPE` only widens (a longer VARCHAR, more NUMBER precision) and
   * rejects a narrowing change, and `SET DEFAULT` accepts ONLY a sequence's NEXTVAL
   * — a literal default cannot be added to a column that already exists, so a
   * literal is skipped here rather than sent to be refused. Clearing a default is
   * `DROP DEFAULT`, which does work.
   */
  modifyColumn({ database, schema, table, column }) {
    const target = this.qualify({ database, schema, table })
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    const statements = []
    // Rename first, so everything after it can talk about the new name.
    if (from !== column.name) {
      statements.push(`ALTER TABLE ${target} RENAME COLUMN ${this.quote(from)} TO ${this.quote(column.name)}`)
    }
    const name = this.quote(column.name)
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} SET DATA TYPE ${this.columnType(column)}`)
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} ${column.is_nullable === false ? 'SET' : 'DROP'} NOT NULL`)
    const fallback = column.default_value
    if (fallback === undefined || fallback === null || String(fallback).length === 0) {
      statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} DROP DEFAULT`)
    } else if (/\.NEXTVAL$/i.test(String(fallback).trim())) {
      statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} SET DEFAULT ${this.defaultExpression(fallback)}`)
    }
    const comment = column.column_comment
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} COMMENT ${this.literal(comment)}`)
    } else {
      statements.push(`ALTER TABLE ${target} ALTER COLUMN ${name} UNSET COMMENT`)
    }
    return statements
  }

  setTableComment({ database, schema, table, comment }) {
    return [`COMMENT ON TABLE ${this.qualify({ database, schema, table })} IS ${this.literal(comment ?? '')}`]
  }

  createIndex() {
    return this.unsupported('索引（Snowflake 没有索引）')
  }

  dropIndex() {
    return this.unsupported('索引（Snowflake 没有索引）')
  }
}
