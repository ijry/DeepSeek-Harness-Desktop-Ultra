/**
 * Microsoft SQL Server, driven by `tedious`.
 *
 * Two things about this engine shape everything below. Identifiers are bracketed
 * (`[dbo].[Order Details]`) with `]` doubled, and there is no `LIMIT`: paging is
 * `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, which the standard only allows after an
 * `ORDER BY`. A grid that has not asked for a sort still needs a page, so an
 * unsorted query gets `ORDER BY (SELECT NULL)` — the idiom every SQL Server client
 * uses to say "any order will do".
 *
 * Column and table comments live in extended properties (`MS_Description`), not in
 * the catalogue, which is why the comment lookups join `sys.extended_properties`.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/mssql
 */
import { SqlDialect } from '../sql-dialect.js'

/** Schemas SQL Server ships with; a user never means these. */
const SYSTEM_SCHEMAS = ['sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin',
  'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter',
  'db_denydatareader', 'db_denydatawriter']

export class MssqlDialect extends SqlDialect {
  get dbType() {
    return 'sqlserver'
  }

  get hasSchemas() {
    return true
  }

  get supportsBind() {
    return true
  }

  placeholder(index) {
    return `@p${index}`
  }

  quote(name) {
    return `[${String(name).replace(/]/g, ']]')}]`
  }

  /** The schema a caller left out; SQL Server's default is `dbo`. */
  schemaOf(schema) {
    const text = String(schema ?? '').trim()
    return text.length > 0 ? text : 'dbo'
  }

  qualify({ database, schema, table } = {}) {
    const parts = []
    if (database !== undefined && database !== null && String(database).trim().length > 0) {
      parts.push(this.quote(database))
    }
    parts.push(this.quote(this.schemaOf(schema)))
    if (table !== undefined && table !== null && String(table).length > 0) {
      parts.push(this.quote(table))
    }
    return parts.join('.')
  }

  useDatabase(database) {
    return `USE ${this.quote(database)}`
  }

  paginate(sql, limit, offset) {
    const body = String(sql).replace(/;\s*$/, '')
    const size = Math.max(0, Number(limit) || 0)
    const start = Math.max(0, Number(offset) || 0)
    // `OFFSET` is only legal after an ORDER BY, and the grid frequently has none.
    const order = /\border\s+by\b/i.test(body) ? '' : ' ORDER BY (SELECT NULL)'
    return `${body}${order} OFFSET ${start} ROWS FETCH NEXT ${size} ROWS ONLY`
  }

  catalogFilter(database, schema) {
    return `TABLE_SCHEMA = ${this.literal(this.schemaOf(schema))}`
  }

  routineFilter(database, schema) {
    return `ROUTINE_SCHEMA = ${this.literal(this.schemaOf(schema))}`
  }

  showDatabases() {
    return `SELECT name FROM sys.databases
      WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
      ORDER BY name`
  }

  showSchemas() {
    return `SELECT name FROM sys.schemas
      WHERE name NOT IN (${SYSTEM_SCHEMAS.map((name) => this.literal(name)).join(', ')})
      ORDER BY name`
  }

  showTables(database, schema) {
    return `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
      WHERE ${this.catalogFilter(database, schema)} AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`
  }

  showViews(database, schema) {
    return `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.VIEWS
      WHERE ${this.catalogFilter(database, schema)} ORDER BY TABLE_NAME`
  }

  showProcedures(database, schema) {
    return `SELECT ROUTINE_NAME AS name FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ${this.routineFilter(database, schema)} ORDER BY ROUTINE_NAME`
  }

  showColumns(database, table, schema) {
    const owner = this.literal(this.schemaOf(schema))
    const name = this.literal(table)
    return `SELECT
        c.COLUMN_NAME AS name,
        c.DATA_TYPE AS data_type,
        c.DATA_TYPE + CASE
          WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)'
          WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(12)) + ')'
          WHEN c.DATA_TYPE IN ('decimal', 'numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(12)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(12)) + ')'
          ELSE ''
        END AS full_type,
        c.IS_NULLABLE AS is_nullable,
        c.COLUMN_DEFAULT AS default_value,
        CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_primary_key,
        c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
        CAST(ISNULL(ep.value, '') AS nvarchar(4000)) AS column_comment
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT k.COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
        JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
          ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
        WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' AND k.TABLE_SCHEMA = ${owner} AND k.TABLE_NAME = ${name}
      ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
      LEFT JOIN sys.extended_properties ep
        ON ep.major_id = OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)})
        AND ep.minor_id = COLUMNPROPERTY(OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)}), c.COLUMN_NAME, 'ColumnId')
        AND ep.name = 'MS_Description'
      WHERE c.TABLE_SCHEMA = ${owner} AND c.TABLE_NAME = ${name}
      ORDER BY c.ORDINAL_POSITION`
  }

  showPrimaryKeys(database, table, schema) {
    return `SELECT k.COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
      JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
        ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
      WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND k.TABLE_SCHEMA = ${this.literal(this.schemaOf(schema))}
        AND k.TABLE_NAME = ${this.literal(table)}
      ORDER BY k.ORDINAL_POSITION`
  }

  showForeignKeys(database, table, schema) {
    return `SELECT
        fk.name AS constraint_name,
        pc.name AS column_name,
        rs.name AS referenced_schema,
        rt.name AS referenced_table,
        rc.name AS referenced_column
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
      JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE ps.name = ${this.literal(this.schemaOf(schema))} AND pt.name = ${this.literal(table)}
      ORDER BY fk.name, fkc.constraint_column_id`
  }

  showIndexes(database, table, schema) {
    return `SELECT
        i.name AS name,
        c.name AS column_name,
        CASE WHEN i.is_unique = 1 THEN 1 ELSE 0 END AS is_unique
      FROM sys.indexes i
      JOIN sys.tables t ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.name IS NOT NULL AND i.is_hypothetical = 0
        AND s.name = ${this.literal(this.schemaOf(schema))} AND t.name = ${this.literal(table)}
      ORDER BY i.name, ic.key_ordinal`
  }

  showTableComment(database, table, schema) {
    return `SELECT CAST(ISNULL(ep.value, '') AS nvarchar(4000)) AS comment
      FROM sys.extended_properties ep
      WHERE ep.major_id = OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)})
        AND ep.minor_id = 0 AND ep.name = 'MS_Description'`
  }

  /**
   * SQL Server has no SHOW CREATE TABLE, and `sys.sql_modules` only covers
   * programmable objects. The engine composes the DDL from the table structure
   * instead — that is why this returns null rather than a best-effort guess.
   */
  showCreateTable() {
    return null
  }

  viewSource(database, view, schema) {
    return `SELECT OBJECT_DEFINITION(OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${view}`)})) AS definition`
  }

  procedureSource(database, procedure, schema) {
    return `SELECT OBJECT_DEFINITION(OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${procedure}`)})) AS definition`
  }

  /**
   * Per-schema size for the CURRENT database only.
   *
   * `sys.dm_db_partition_stats` is scoped to the connected database, and walking
   * every database would need either dynamic SQL per database or `sp_MSforeachdb`,
   * neither of which is worth a dashboard tile.
   */
  stats() {
    return `SELECT
        s.name AS database_name,
        COUNT(DISTINCT t.object_id) AS table_count,
        SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS row_count,
        SUM(p.in_row_data_page_count + p.lob_used_page_count) * 8192 AS data_size,
        SUM(p.used_page_count - p.in_row_data_page_count - p.lob_used_page_count) * 8192 AS index_size
      FROM sys.dm_db_partition_stats p
      JOIN sys.tables t ON t.object_id = p.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      GROUP BY s.name
      ORDER BY s.name`
  }

  // -------------------------------------------------------------------- DDL
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'NVARCHAR(255)'
    }
    if (type.includes('(')) {
      return type
    }
    const length = Number(column?.character_maximum_length)
    if (/^(n?var)?(char|binary)$/i.test(type) || /^n?varchar$/i.test(type)) {
      if (Number.isFinite(length) && length > 0) {
        return `${type.toUpperCase()}(${length})`
      }
      return `${type.toUpperCase()}(MAX)`
    }
    return type
  }

  columnDefinition(column) {
    // SQL Server has no inline column comment; the designer's comment becomes an
    // extended property in a follow-up statement.
    const parts = [this.quote(column.name), this.columnType(column)]
    parts.push(column.is_nullable === false ? 'NOT NULL' : 'NULL')
    if (column.default_value !== undefined && column.default_value !== null && String(column.default_value).length > 0) {
      parts.push(`DEFAULT ${column.default_value}`)
    }
    if (column.auto_increment === true) {
      parts.push('IDENTITY(1,1)')
    }
    return parts.join(' ')
  }

  createTable({ database, schema, table, columns, comment }) {
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    const statements = [
      `CREATE TABLE ${this.qualify({ database, schema, table })} (\n  ${body.join(',\n  ')}\n)`,
    ]
    if (comment !== undefined && comment !== null && String(comment).length > 0) {
      statements.push(...this.setTableComment({ database, schema, table, comment }))
    }
    for (const column of columns) {
      if (column.column_comment !== undefined && String(column.column_comment).length > 0) {
        statements.push(this.columnCommentStatement({ schema, table, column }))
      }
    }
    return statements
  }

  /** `MS_Description` on one column, added or updated. */
  columnCommentStatement({ schema, table, column }) {
    const owner = this.literal(this.schemaOf(schema))
    const name = this.literal(table)
    const target = this.literal(column.name)
    const value = this.literal(column.column_comment ?? '')
    return `IF EXISTS (SELECT 1 FROM sys.extended_properties
        WHERE major_id = OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)})
          AND minor_id = COLUMNPROPERTY(OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)}), ${target}, 'ColumnId')
          AND name = 'MS_Description')
      EXEC sp_updateextendedproperty N'MS_Description', ${value}, N'SCHEMA', ${owner}, N'TABLE', ${name}, N'COLUMN', ${target}
      ELSE
      EXEC sp_addextendedproperty N'MS_Description', ${value}, N'SCHEMA', ${owner}, N'TABLE', ${name}, N'COLUMN', ${target}`
  }

  addColumn({ database, schema, table, column }) {
    const statements = [
      `ALTER TABLE ${this.qualify({ database, schema, table })} ADD ${this.columnDefinition(column)}`,
    ]
    if (column.column_comment !== undefined && String(column.column_comment).length > 0) {
      statements.push(this.columnCommentStatement({ schema, table, column }))
    }
    return statements
  }

  /**
   * A rename, a retype and a comment, in that order.
   *
   * Note what is missing: changing a DEFAULT needs the name of the existing default
   * constraint in order to drop it, and the panel does not send one. So a default
   * change adds a constraint and will fail if the column already has one — better a
   * clear error than dropping a constraint this code guessed the name of.
   */
  modifyColumn({ database, schema, table, column }) {
    const statements = []
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    const owner = this.schemaOf(schema)
    if (from !== column.name) {
      statements.push(
        `EXEC sp_rename ${this.literal(`${owner}.${table}.${from}`)}, ${this.literal(column.name)}, 'COLUMN'`,
      )
    }
    statements.push(
      `ALTER TABLE ${this.qualify({ database, schema, table })} ALTER COLUMN ${this.quote(column.name)} `
      + `${this.columnType(column)} ${column.is_nullable === false ? 'NOT NULL' : 'NULL'}`,
    )
    if (column.default_value !== undefined && column.default_value !== null && String(column.default_value).length > 0) {
      statements.push(
        `ALTER TABLE ${this.qualify({ database, schema, table })} ADD CONSTRAINT `
        + `${this.quote(`DF_${table}_${column.name}`)} DEFAULT ${column.default_value} FOR ${this.quote(column.name)}`,
      )
    }
    if (column.column_comment !== undefined && String(column.column_comment).length > 0) {
      statements.push(this.columnCommentStatement({ schema, table, column }))
    }
    return statements
  }

  setTableComment({ database, schema, table, comment }) {
    const owner = this.literal(this.schemaOf(schema))
    const name = this.literal(table)
    const value = this.literal(comment ?? '')
    return [
      `IF EXISTS (SELECT 1 FROM sys.extended_properties
        WHERE major_id = OBJECT_ID(${this.literal(`${this.schemaOf(schema)}.${table}`)})
          AND minor_id = 0 AND name = 'MS_Description')
      EXEC sp_updateextendedproperty N'MS_Description', ${value}, N'SCHEMA', ${owner}, N'TABLE', ${name}
      ELSE
      EXEC sp_addextendedproperty N'MS_Description', ${value}, N'SCHEMA', ${owner}, N'TABLE', ${name}`,
    ]
  }

  dropIndex({ database, schema, table, index }) {
    return [`DROP INDEX ${this.quote(index)} ON ${this.qualify({ database, schema, table })}`]
  }
}
