/**
 * Oracle, and 达梦 DM at the bottom of the file.
 *
 * Two things about Oracle bite everyone who reads these statements:
 *
 * 1. Unquoted identifiers are folded to UPPER CASE when a statement is parsed, so
 *    `users` and `"users"` are two different tables — quoting every name the way
 *    the MySQL dialect does would miss every table anyone created normally.
 *    `quote()` below quotes only what has to be quoted. The same folding is why
 *    every output alias here is quoted lower-case: `AS name` comes back as `NAME`,
 *    and the engine looks the contract's column names up verbatim.
 * 2. In a column definition DEFAULT comes BEFORE NOT NULL. Written the MySQL way
 *    round (`NOT NULL DEFAULT 0`) Oracle answers ORA-00907 "missing right
 *    parenthesis", which sends you hunting for a bracket instead of a keyword.
 *
 * An Oracle "database" is a user/schema: the panel's `databaseName` is the owner,
 * so `hasSchemas` is true and there is nothing to `USE`. Table-scoped statements
 * take `(database, table, schema)`; the last two mean the same thing here, so
 * whichever one the engine fills in names the owner.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/oracle
 */
import { SqlDialect } from '../sql-dialect.js'

export class OracleDialect extends SqlDialect {
  get dbType() {
    return 'oracle'
  }

  get hasSchemas() {
    return true
  }

  /** oracledb binds positionally: `:1`, `:2`, … */
  placeholder(index) {
    return `:${index}`
  }

  /**
   * Quote an identifier — but only when quoting is the right answer.
   *
   * A plain upper-case name is what Oracle stores for an unquoted `CREATE TABLE
   * users`, and it needs no quotes; anything else — lower or mixed case, a space,
   * punctuation, a leading digit, a reserved word — does. The cost of the
   * exception is inherited: a table the designer names `users` is created as
   * `"users"` and has to stay quoted forever after, here and in every
   * hand-written script that touches it.
   */
  quote(name) {
    const text = String(name)
    if (/^[A-Z][A-Z0-9_$#]*$/.test(text)) {
      return text
    }
    return `"${text.replace(/"/g, '""')}"`
  }

  /**
   * Oracle has no backslash escapes in a string literal: `''` is the only escape
   * and a backslash is just a backslash. The base's MySQL-shaped `literal()`
   * doubles them, which would write `C:\\tmp` into a table comment.
   */
  literal(value) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  /**
   * `"OWNER"."TABLE"`.
   *
   * The base drops `database` as soon as an engine has schemas, which is wrong
   * here: the panel's `databaseName` IS the owner, and losing it would point every
   * statement at whatever schema the session happens to be set to.
   */
  qualify({ database, schema, table } = {}) {
    const parts = []
    const owner = this.ownerName(database, schema)
    if (owner.length > 0) {
      parts.push(this.quote(owner))
    }
    if (table !== undefined && table !== null && String(table).length > 0) {
      parts.push(this.quote(table))
    }
    return parts.join('.')
  }

  /**
   * The owner a statement is about, in dictionary case.
   *
   * `schema` when the caller has one, otherwise `database` — the same thing in
   * Oracle, and the panel fills in whichever field it has. Upper-cased because it
   * often arrives from a hand-typed connection setting (`hr`) while the dictionary
   * stores `HR`; the cost is that a user genuinely created as `"hr"` cannot be
   * read, which is rare enough to live with.
   */
  ownerName(database, schema) {
    const name = schema !== undefined && schema !== null && String(schema).length > 0 ? schema : database
    return String(name ?? '').trim().toUpperCase()
  }

  /** WHERE fragment pinning a dictionary view to one owner. */
  ownerFilter(database, schema, column = 'owner') {
    const owner = this.ownerName(database, schema)
    return owner.length === 0 ? '1 = 1' : `${column} = ${this.literal(owner)}`
  }

  /**
   * A table/view/procedure name as a literal for a dictionary filter, exactly as
   * the tree read it. Deliberately NOT upper-cased: the panel gets these names out
   * of the dictionary already in stored case, so folding them here would lose the
   * quoted lower-case tables `quote()` goes out of its way to support.
   */
  objectLiteral(name) {
    return this.literal(String(name ?? '').trim())
  }

  /** An instance has one database; there is nothing to switch to. */
  useDatabase() {
    return null
  }

  useSchema(schema) {
    return `ALTER SESSION SET CURRENT_SCHEMA = ${this.quote(schema)}`
  }

  /**
   * The 12c row-limiting clause. 11g has no OFFSET/FETCH and needs the ROWNUM
   * sandwich (`SELECT * FROM (SELECT a.*, ROWNUM rn FROM (…) a WHERE ROWNUM <= n)
   * WHERE rn > m`); this port targets 12c and up, which is also what DM8 speaks.
   */
  paginate(sql, limit, offset) {
    const body = String(sql).replace(/;\s*$/, '')
    const size = Math.max(0, Number(limit) || 0)
    const start = Math.max(0, Number(offset) || 0)
    return `${body} OFFSET ${start} ROWS FETCH NEXT ${size} ROWS ONLY`
  }

  /**
   * The schemas an Oracle install creates for itself — noise in the panel's tree.
   * Best-effort: every release adds a few, and `all_users` only shows what the
   * connection is allowed to see anyway. DM overrides it with its own list.
   */
  get systemSchemaList() {
    return `'SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'AUDSYS', 'GSMADMIN_INTERNAL',
        'WMSYS', 'XDB', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'OLAPSYS', 'SYSMAN', 'EXFSYS',
        'DIP', 'ORACLE_OCM', 'ANONYMOUS', 'LBACSYS', 'DVSYS', 'DVF', 'GGSYS', 'SYS$UMF',
        'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'XS$NULL', 'MDDATA', 'REMOTE_SCHEDULER_AGENT',
        'SPATIAL_CSW_ADMIN_USR', 'SI_INFORMTN_SCHEMA', 'FLOWS_FILES', 'APEX_PUBLIC_USER'`
  }

  // ------------------------------------------------------------ introspection
  showDatabases() {
    return `SELECT username AS "name" FROM all_users
      WHERE username NOT IN (${this.systemSchemaList})
      ORDER BY username`
  }

  /** A schema and a "database" are the same list here. */
  showSchemas() {
    return this.showDatabases()
  }

  showTables(database, schema) {
    // `BIN$…` is a dropped table still sitting in the recycle bin; the tree should
    // not offer it as a table you can open.
    return `SELECT table_name AS "name" FROM all_tables
      WHERE ${this.ownerFilter(database, schema)} AND table_name NOT LIKE 'BIN$%'
      ORDER BY table_name`
  }

  showViews(database, schema) {
    return `SELECT view_name AS "name" FROM all_views
      WHERE ${this.ownerFilter(database, schema)} ORDER BY view_name`
  }

  showProcedures(database, schema) {
    // Oracle keeps procedures, functions and packages in one object table; a
    // PACKAGE BODY is deliberately left out, it is the same name twice in the tree.
    return `SELECT object_name AS "name" FROM all_objects
      WHERE ${this.ownerFilter(database, schema)}
        AND object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')
      ORDER BY object_name`
  }

  /**
   * Fields, comments and the primary-key flag in one statement.
   *
   * `data_default` is a LONG, not a VARCHAR2. Selecting it is fine — the driver
   * hands back a string — but it can never appear in a WHERE, a GROUP BY or inside
   * a function, so nothing here trims the trailing newline Oracle stores with a
   * default; that is the panel's job.
   */
  showColumns(database, table, schema) {
    return `SELECT
        c.column_name AS "name",
        c.data_type AS "data_type",
        CASE
          WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR')
            THEN c.data_type || '(' || c.char_length || ')'
          WHEN c.data_type = 'RAW' THEN 'RAW(' || c.data_length || ')'
          WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL AND NVL(c.data_scale, 0) > 0
            THEN 'NUMBER(' || c.data_precision || ',' || c.data_scale || ')'
          WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL
            THEN 'NUMBER(' || c.data_precision || ')'
          ELSE c.data_type
        END AS "full_type",
        CASE WHEN c.nullable = 'Y' THEN 'YES' ELSE 'NO' END AS "is_nullable",
        c.data_default AS "default_value",
        CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS "is_primary_key",
        NULLIF(c.char_length, 0) AS "character_maximum_length",
        m.comments AS "column_comment"
      FROM all_tab_columns c
      LEFT JOIN all_col_comments m
        ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
      LEFT JOIN (
        SELECT cc.owner, cc.table_name, cc.column_name
        FROM all_cons_columns cc
        JOIN all_constraints k ON k.owner = cc.owner AND k.constraint_name = cc.constraint_name
        WHERE k.constraint_type = 'P'
      ) pk ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name
      WHERE ${this.ownerFilter(database, schema, 'c.owner')}
        AND c.table_name = ${this.objectLiteral(table)}
      ORDER BY c.column_id`
  }

  showPrimaryKeys(database, table, schema) {
    return `SELECT cc.column_name AS "column_name"
      FROM all_cons_columns cc
      JOIN all_constraints k ON k.owner = cc.owner AND k.constraint_name = cc.constraint_name
      WHERE k.constraint_type = 'P' AND ${this.ownerFilter(database, schema, 'cc.owner')}
        AND cc.table_name = ${this.objectLiteral(table)}
      ORDER BY cc.position`
  }

  /**
   * Foreign keys, one row per column pair.
   *
   * The `pc.position = cc.position` half of the last join is what pairs each
   * referencing column with the column it references; without it a two-column key
   * fans out into four rows and the panel draws nonsense.
   */
  showForeignKeys(database, table, schema) {
    return `SELECT
        k.constraint_name AS "constraint_name",
        cc.column_name AS "column_name",
        pk.owner AS "referenced_schema",
        pk.table_name AS "referenced_table",
        pc.column_name AS "referenced_column"
      FROM all_constraints k
      JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
      JOIN all_constraints pk ON pk.owner = k.r_owner AND pk.constraint_name = k.r_constraint_name
      JOIN all_cons_columns pc ON pc.owner = pk.owner AND pc.constraint_name = pk.constraint_name
        AND pc.position = cc.position
      WHERE k.constraint_type = 'R' AND ${this.ownerFilter(database, schema, 'k.owner')}
        AND k.table_name = ${this.objectLiteral(table)}
      ORDER BY k.constraint_name, cc.position`
  }

  showIndexes(database, table, schema) {
    // A function-based index reports Oracle's hidden expression column
    // (`SYS_NC00004$`) as its column name — that is the dictionary's answer, not a
    // bug here. LOB indexes fall out on their own: they have no ind_columns rows.
    return `SELECT
        i.index_name AS "name",
        ic.column_name AS "column_name",
        CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END AS "is_unique"
      FROM all_indexes i
      JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
      WHERE ${this.ownerFilter(database, schema, 'i.table_owner')}
        AND i.table_name = ${this.objectLiteral(table)}
      ORDER BY i.index_name, ic.column_position`
  }

  /**
   * The table's comment.
   *
   * The alias is quoted lower-case for two reasons: COMMENT is a reserved word, so
   * Oracle refuses it as a bare alias, and an unquoted alias would come back folded
   * to `COMMENT` while the engine looks up `comment`.
   */
  showTableComment(database, table, schema) {
    return `SELECT comments AS "comment" FROM all_tab_comments
      WHERE ${this.ownerFilter(database, schema)} AND table_name = ${this.objectLiteral(table)}`
  }

  /**
   * There is no `SHOW CREATE TABLE`; DBMS_METADATA rebuilds the DDL instead.
   *
   * Its arguments are strings, not identifiers, so they carry dictionary case. It
   * returns a CLOB, which means the adapter has to fetch CLOBs as strings
   * (`oracledb.fetchAsString = [oracledb.CLOB]`) or the panel shows a Lob object
   * instead of DDL. Wrapping it in TO_CHAR is not a fix: that fails past 4000 bytes.
   */
  showCreateTable(database, table, schema) {
    return `SELECT DBMS_METADATA.GET_DDL('TABLE', ${this.objectLiteral(table)},
        ${this.literal(this.ownerName(database, schema))}) AS "ddl" FROM dual`
  }

  viewSource(database, view, schema) {
    // `all_views.text` is a LONG as well — same rule as `data_default`: read it,
    // never filter on it.
    return `SELECT text AS "definition" FROM all_views
      WHERE ${this.ownerFilter(database, schema)} AND view_name = ${this.objectLiteral(view)}`
  }

  /**
   * A procedure/function/package body.
   *
   * `LISTAGG(text, '') WITHIN GROUP (ORDER BY line)` over `all_source` is the
   * obvious way and it dies with ORA-01489 the moment the concatenation passes 4000
   * bytes, which nearly every real procedure does. GET_DDL returns a CLOB and has no
   * such ceiling, so it wins. Its first argument is the object type in GET_DDL's
   * spelling, which uses underscores (`PACKAGE_BODY`) where the dictionary uses
   * spaces (`PACKAGE BODY`) — the three types listed here are the ones where both
   * spellings agree.
   */
  procedureSource(database, procedure, schema) {
    return `SELECT
        DBMS_METADATA.GET_DDL(o.object_type, o.object_name, o.owner) AS "definition",
        o.object_type AS "routine_type",
        o.object_name AS "routine_name"
      FROM all_objects o
      WHERE ${this.ownerFilter(database, schema, 'o.owner')}
        AND o.object_name = ${this.objectLiteral(procedure)}
        AND o.object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')`
  }

  /**
   * Per-schema table count and size.
   *
   * These are DBMS_STATS' numbers, so they are estimates and are NULL until a
   * schema has been analysed — the same deal as the `table_rows`/`data_length` the
   * MySQL dialect reads out of information_schema. The exact bytes live in
   * `dba_segments` (`SUM(bytes)` grouped by owner), but that view needs
   * SELECT_CATALOG_ROLE and an ordinary application account gets ORA-00942 instead
   * of a dashboard; `user_segments` never errors but only ever shows the connected
   * user's own schema. So: estimate, for every connection. `index_size` stays 0 for
   * the same privilege reason. 8192 is the default `db_block_size`.
   */
  stats() {
    return `SELECT
        t.owner AS "database_name",
        COUNT(*) AS "table_count",
        COALESCE(SUM(t.num_rows), 0) AS "row_count",
        COALESCE(SUM(t.blocks), 0) * 8192 AS "data_size",
        0 AS "index_size"
      FROM all_tables t
      WHERE t.owner NOT IN (${this.systemSchemaList})
      GROUP BY t.owner
      ORDER BY t.owner`
  }

  // -------------------------------------------------------------------- DDL
  // `dropColumn`, `dropTable`, `truncateTable`, `createIndex`, `countSql` and
  // `emptySelect` are the base's: Oracle spells all of them the ANSI way.
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'VARCHAR2(255)'
    }
    // Already spelled out in full (`NUMBER(10,2)`, `VARCHAR2(64)`) → as written,
    // same rule as the MySQL dialect.
    if (/[(]/.test(type)) {
      return type
    }
    const length = Number(column?.character_maximum_length)
    const width = Number.isFinite(length) && length > 0 ? length : 255
    switch (type.toLowerCase()) {
      case 'varchar':
      case 'varchar2':
      case 'nvarchar':
      case 'nvarchar2':
        return `VARCHAR2(${width})`
      case 'char':
        return `CHAR(${width})`
      case 'nchar':
        return `NCHAR(${width})`
      case 'tinyint':
        return 'NUMBER(3)'
      case 'smallint':
        return 'NUMBER(5)'
      case 'int':
      case 'integer':
        return 'NUMBER(10)'
      case 'bigint':
        return 'NUMBER(19)'
      case 'decimal':
      case 'numeric':
        return 'NUMBER'
      case 'float':
        return 'BINARY_FLOAT'
      case 'double':
        return 'BINARY_DOUBLE'
      case 'boolean':
      case 'bool':
      case 'bit':
        // A real BOOLEAN only exists in 23c; everything older stores flags as
        // NUMBER(1), which is also what the panel's checkbox editor expects.
        return 'NUMBER(1)'
      case 'datetime':
      case 'timestamp':
        return 'TIMESTAMP'
      case 'time':
        // No standalone TIME type. A TIMESTAMP whose date part is ignored is what
        // every migration into Oracle ends up doing.
        return 'TIMESTAMP'
      case 'text':
      case 'mediumtext':
      case 'longtext':
      case 'json':
        // JSON is a CLOB (plus an IS JSON check) until 21c gave it its own type.
        return 'CLOB'
      case 'blob':
      case 'binary':
      case 'varbinary':
        return 'BLOB'
      default:
        return type.toUpperCase()
    }
  }

  /**
   * A DEFAULT the designer typed, in Oracle's spelling.
   *
   * Same idea as the MySQL dialect's — a number must not be quoted, `hello` must be
   * — with two Oracle wrinkles: there is no TRUE/FALSE to default a flag column to
   * before 23c, so `true`/`false` become 1/0, and the clock is SYSTIMESTAMP.
   */
  defaultExpression(value) {
    const text = String(value).trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return text
    }
    if (/^true$/i.test(text)) {
      return '1'
    }
    if (/^false$/i.test(text)) {
      return '0'
    }
    if (/^now\(\)$/i.test(text)) {
      return 'SYSTIMESTAMP'
    }
    if (/^(null|sysdate|systimestamp|current_date|current_timestamp|user)$/i.test(text)) {
      return text.toUpperCase()
    }
    if (/^'.*'$/.test(text)) {
      return text
    }
    // A sequence (`app_seq.NEXTVAL`) or a package constant.
    if (/^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)+$/.test(text)) {
      return text
    }
    // Any function call.
    if (/^[A-Za-z_][A-Za-z0-9_$#]*\s*\(.*\)$/.test(text)) {
      return text
    }
    return this.literal(text)
  }

  /**
   * One column inside CREATE TABLE / ADD.
   *
   * DEFAULT before NOT NULL, per the header. No inline comment either: Oracle keeps
   * column notes in `COMMENT ON COLUMN`, which is why every DDL method here returns
   * more than one statement. And no bare `NULL` — it is legal in CREATE TABLE but
   * ORA-01451 in MODIFY, and one spelling for both is worth more than the keyword.
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
    return parts.join(' ')
  }

  /**
   * The body of `MODIFY (…)`: name, type, DEFAULT — and deliberately no nullability.
   *
   * Oracle rejects both directions when nothing actually changes: ORA-01451 for
   * `MODIFY (c … NULL)` on an already-nullable column, ORA-01442 for `… NOT NULL` on
   * one that is already mandatory. The panel sends the column's new state, not a
   * diff, so we cannot tell a change from a no-op — and the no-ops are the common
   * case (someone widening a VARCHAR2). Leaving the clause out means a nullability
   * change has to be run by hand; putting it in would break every ordinary type
   * change instead.
   */
  modifyBody(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    const fallback = column.default_value
    if (fallback !== undefined && fallback !== null && String(fallback).length > 0) {
      parts.push(`DEFAULT ${this.defaultExpression(fallback)}`)
    }
    return parts.join(' ')
  }

  /** `COMMENT ON COLUMN …`, or null when the designer left the note empty. */
  columnCommentStatement({ database, schema, table, column }) {
    const note = column?.column_comment
    if (note === undefined || note === null || String(note).length === 0) {
      return null
    }
    const target = this.qualify({ database, schema, table })
    return `COMMENT ON COLUMN ${target}.${this.quote(column.name)} IS ${this.literal(note)}`
  }

  createTable({ database, schema, table, columns, comment }) {
    const target = this.qualify({ database, schema, table })
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    const statements = [`CREATE TABLE ${target} (\n  ${body.join(',\n  ')}\n)`]
    for (const column of columns) {
      const note = this.columnCommentStatement({ database, schema, table, column })
      if (note !== null) {
        statements.push(note)
      }
    }
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      statements.push(`COMMENT ON TABLE ${target} IS ${this.literal(comment)}`)
    }
    return statements
  }

  addColumn({ database, schema, table, column }) {
    // Oracle only lets a mandatory column be added to a non-empty table when it
    // brings a DEFAULT (ORA-01758); the panel shows that error rather than us
    // inventing a value.
    const statements = [`ALTER TABLE ${this.qualify({ database, schema, table })} ADD (${this.columnDefinition(column)})`]
    const note = this.columnCommentStatement({ database, schema, table, column })
    if (note !== null) {
      statements.push(note)
    }
    return statements
  }

  modifyColumn({ database, schema, table, column }) {
    const target = this.qualify({ database, schema, table })
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    const statements = []
    // Rename first, so everything after it can talk about the new name.
    if (from !== column.name) {
      statements.push(`ALTER TABLE ${target} RENAME COLUMN ${this.quote(from)} TO ${this.quote(column.name)}`)
    }
    statements.push(`ALTER TABLE ${target} MODIFY (${this.modifyBody(column)})`)
    const note = this.columnCommentStatement({ database, schema, table, column })
    if (note !== null) {
      statements.push(note)
    }
    return statements
  }

  setTableComment({ database, schema, table, comment }) {
    return [`COMMENT ON TABLE ${this.qualify({ database, schema, table })} IS ${this.literal(comment ?? '')}`]
  }

  /** An index belongs to a schema, not to a table — so no ON clause. */
  dropIndex({ database, schema, index }) {
    return [`DROP INDEX ${this.qualify({ database, schema, table: index })}`]
  }

  createDatabase() {
    return this.unsupported('创建/删除数据库（Oracle 里数据库是实例）')
  }

  dropDatabase() {
    return this.unsupported('创建/删除数据库（Oracle 里数据库是实例）')
  }
}

/**
 * 达梦 DM8 — Oracle with a different badge on it.
 *
 * The difference really is this small. DM ships the same `ALL_USERS`, `ALL_TABLES`,
 * `ALL_VIEWS`, `ALL_TAB_COLUMNS`, `ALL_COL_COMMENTS`, `ALL_TAB_COMMENTS`,
 * `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_INDEXES`, `ALL_IND_COLUMNS` and
 * `DUAL`, folds unquoted identifiers to upper case the same way, understands the
 * 12c `OFFSET … FETCH NEXT` clause, and retrieves DDL through
 * `DBMS_METADATA.GET_DDL` — so the only thing overridden here is which schemas
 * count as the server's own.
 *
 * Two DM-only things to know when something comes back empty: `DBMS_METADATA` is
 * an optional system package, so `showCreateTable` and `procedureSource` need
 * `CALL SP_CREATE_SYSTEM_PACKAGES(1)` to have been run once on the server; and
 * DM's `SYSDBA` schema is where user tables usually live, which is why it is NOT
 * filtered out the way Oracle's `SYSTEM` is.
 */
export class DamengDialect extends OracleDialect {
  get dbType() {
    return 'dameng'
  }

  /** DM's own system users — SYSDBA is a working schema, not one of them. */
  get systemSchemaList() {
    return `'SYS', 'SYSSSO', 'SYSAUDITOR', 'SYSDBO', 'CTISYS', 'SYSJOB'`
  }
}
