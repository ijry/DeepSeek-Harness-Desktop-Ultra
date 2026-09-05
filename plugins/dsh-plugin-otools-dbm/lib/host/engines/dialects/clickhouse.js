/**
 * ClickHouse, over its HTTP interface.
 *
 * The two things that will surprise a reader coming from MySQL: nullability is part
 * of the TYPE (`Nullable(String)`, not `String NULL`), and a MergeTree table cannot
 * be created without an `ORDER BY` — so `createTable` always emits one, falling back
 * to `tuple()` when the designer gave no primary key. Get either wrong and the
 * server rejects the DDL outright.
 *
 * Binds are not used: the HTTP client takes named `{p:Type}` parameters rather than
 * positional ones, so `supportsBind` is false and the engine inlines literals
 * through `literal()`.
 *
 * @module dsh-plugin-otools-dbm/host/engines/dialects/clickhouse
 */
import { SqlDialect } from '../sql-dialect.js'

export class ClickHouseDialect extends SqlDialect {
  get dbType() {
    return 'clickhouse'
  }

  get hasSchemas() {
    return false
  }

  /** The HTTP client's parameters are named, not positional. */
  get supportsBind() {
    return false
  }

  useDatabase(database) {
    return `USE ${this.quote(database)}`
  }

  showDatabases() {
    return `SELECT name FROM system.databases
      WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
      ORDER BY name`
  }

  showTables(database) {
    return `SELECT name FROM system.tables
      WHERE database = ${this.literal(database ?? 'default')} AND engine NOT LIKE '%View'
      ORDER BY name`
  }

  showViews(database) {
    return `SELECT name FROM system.tables
      WHERE database = ${this.literal(database ?? 'default')} AND engine LIKE '%View'
      ORDER BY name`
  }

  /** ClickHouse has no stored procedures; the engine reads null as an empty list. */
  showProcedures() {
    return null
  }

  showColumns(database, table) {
    return `SELECT
        name AS name,
        type AS data_type,
        type AS full_type,
        if(startsWith(type, 'Nullable('), 'YES', 'NO') AS is_nullable,
        default_expression AS default_value,
        is_in_primary_key AS is_primary_key,
        NULL AS character_maximum_length,
        comment AS column_comment
      FROM system.columns
      WHERE database = ${this.literal(database ?? 'default')} AND table = ${this.literal(table)}
      ORDER BY position`
  }

  showPrimaryKeys(database, table) {
    return `SELECT name AS column_name FROM system.columns
      WHERE database = ${this.literal(database ?? 'default')} AND table = ${this.literal(table)}
        AND is_in_primary_key = 1
      ORDER BY position`
  }

  /** ClickHouse has no foreign keys at all. */
  showForeignKeys() {
    return null
  }

  /**
   * Data-skipping indices, mapped onto the contract as best they fit.
   *
   * They are not unique indices and not even column indices — `expr` can be any
   * expression — so `is_unique` is always 0 and the expression goes in the column
   * slot. Showing them is still better than showing nothing, because the designer's
   * index list is the only place a user would look for them.
   */
  showIndexes(database, table) {
    return `SELECT
        name AS name,
        expr AS column_name,
        0 AS is_unique
      FROM system.data_skipping_indices
      WHERE database = ${this.literal(database ?? 'default')} AND table = ${this.literal(table)}
      ORDER BY name`
  }

  showTableComment(database, table) {
    return `SELECT comment FROM system.tables
      WHERE database = ${this.literal(database ?? 'default')} AND name = ${this.literal(table)}`
  }

  showCreateTable(database, table) {
    return `SHOW CREATE TABLE ${this.qualify({ database, table })}`
  }

  viewSource(database, view) {
    return `SELECT create_table_query AS definition FROM system.tables
      WHERE database = ${this.literal(database ?? 'default')} AND name = ${this.literal(view)}`
  }

  procedureSource() {
    return null
  }

  stats() {
    return `SELECT
        database AS database_name,
        uniqExact(table) AS table_count,
        sum(rows) AS row_count,
        sum(bytes_on_disk) AS data_size,
        sum(primary_key_bytes_in_memory_allocated) AS index_size
      FROM system.parts
      WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
      GROUP BY database
      ORDER BY database`
  }

  // -------------------------------------------------------------------- DDL
  columnType(column) {
    const raw = String(column?.data_type ?? '').trim()
    const base = raw.length > 0 ? raw : 'String'
    // Nullability is part of the type here, so it is applied once, in one place.
    if (column?.is_nullable === false) {
      return base.startsWith('Nullable(') ? base.slice('Nullable('.length, -1) : base
    }
    return base.startsWith('Nullable(') ? base : `Nullable(${base})`
  }

  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    if (column.default_value !== undefined && column.default_value !== null && String(column.default_value).length > 0) {
      parts.push(`DEFAULT ${column.default_value}`)
    }
    if (column.column_comment !== undefined && String(column.column_comment).length > 0) {
      parts.push(`COMMENT ${this.literal(column.column_comment)}`)
    }
    return parts.join(' ')
  }

  createTable({ database, schema, table, columns, comment }) {
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    // A MergeTree with no ORDER BY is refused by the server; `tuple()` is the
    // documented way to say "no sorting key".
    const order = keys.length > 0 ? `(${keys.join(', ')})` : 'tuple()'
    const tail = comment !== undefined && comment !== null && String(comment).length > 0
      ? `\nCOMMENT ${this.literal(comment)}`
      : ''
    return [
      `CREATE TABLE ${this.qualify({ database, schema, table })} (\n  ${body.join(',\n  ')}\n)`
      + `\nENGINE = MergeTree()\nORDER BY ${order}${tail}`,
    ]
  }

  modifyColumn({ database, schema, table, column }) {
    const target = this.qualify({ database, schema, table })
    const statements = []
    const from = column.old_name !== undefined && String(column.old_name).length > 0 ? column.old_name : column.name
    if (from !== column.name) {
      statements.push(`ALTER TABLE ${target} RENAME COLUMN ${this.quote(from)} TO ${this.quote(column.name)}`)
    }
    statements.push(`ALTER TABLE ${target} MODIFY COLUMN ${this.columnDefinition(column)}`)
    return statements
  }

  addColumn({ database, schema, table, column }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} ADD COLUMN ${this.columnDefinition(column)}`]
  }

  dropColumn({ database, schema, table, column }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} DROP COLUMN ${this.quote(column)}`]
  }

  setTableComment({ database, schema, table, comment }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} MODIFY COMMENT ${this.literal(comment ?? '')}`]
  }

  /**
   * A data-skipping index, not a b-tree.
   *
   * `unique` is ignored because ClickHouse has no unique constraint — a MergeTree
   * deduplicates by sorting key, not by index. The panel's checkbox therefore has
   * no effect here, which is better than emitting DDL the server rejects.
   */
  createIndex({ database, schema, table, index, columns }) {
    const expression = columns.map((column) => this.quote(column)).join(', ')
    return [
      `ALTER TABLE ${this.qualify({ database, schema, table })} ADD INDEX ${this.quote(index)} `
      + `(${expression}) TYPE minmax GRANULARITY 4`,
    ]
  }

  dropIndex({ database, schema, table, index }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} DROP INDEX ${this.quote(index)}`]
  }

  truncateTable({ database, schema, table }) {
    return [`TRUNCATE TABLE ${this.qualify({ database, schema, table })}`]
  }
}
