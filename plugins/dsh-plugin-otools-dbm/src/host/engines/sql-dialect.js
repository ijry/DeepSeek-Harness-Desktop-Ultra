/**
 * The dialect layer: SQL text, and nothing else.
 *
 * A dialect never touches a connection. It answers "what statement asks this
 * engine for its tables" and "how does this engine spell ALTER TABLE", and the
 * engine runs it. That split is lifted from AirDB (`src/service/dialect/*`), and it
 * is what makes fourteen engines tractable: the generic SqlEngine is written once
 * and each dialect is a page of strings.
 *
 * Introspection statements have a fixed output contract, so the engine can map
 * rows without knowing which dialect produced them. Alias your columns exactly:
 *
 *   showDatabases   → one column, any name
 *   showSchemas     → one column, any name
 *   showTables      → one column, any name  (same for views / procedures)
 *   showColumns     → name, data_type, full_type, is_nullable, default_value,
 *                     is_primary_key, character_maximum_length, column_comment
 *   showPrimaryKeys → column_name
 *   showForeignKeys → constraint_name, column_name, referenced_schema,
 *                     referenced_table, referenced_column
 *   showIndexes     → name, column_name, is_unique  (one row per column)
 *   showTableComment→ comment
 *
 * `is_nullable` may be a boolean, 'YES'/'NO' or 1/0 — the engine normalizes.
 *
 * @module dsh-plugin-otools-dbm/host/engines/sql-dialect
 */
import { DbmError, ERR } from '../../shared/protocol.js'

/** Base dialect: ANSI-ish with MySQL's backticks and LIMIT/OFFSET. */
export class SqlDialect {
  /** Engine name this dialect serves. */
  get dbType() {
    return 'sql'
  }

  /** Does the engine have schemas inside databases? */
  get hasSchemas() {
    return false
  }

  /** Does the driver take bind parameters? */
  get supportsBind() {
    return true
  }

  /** Placeholder for the nth (1-based) bind value. */
  placeholder() {
    return '?'
  }

  /** Quote one identifier. */
  quote(name) {
    return `\`${String(name).replace(/`/g, '``')}\``
  }

  /** Quote a string literal. */
  literal(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  }

  /** `db`.`schema`.`table`, skipping the parts this engine or caller lacks. */
  qualify({ database, schema, table } = {}) {
    const parts = []
    if (database !== undefined && database !== null && String(database).length > 0 && !this.hasSchemas) {
      parts.push(this.quote(database))
    }
    if (this.hasSchemas) {
      if (schema !== undefined && schema !== null && String(schema).length > 0) {
        parts.push(this.quote(schema))
      }
    }
    if (table !== undefined && table !== null && String(table).length > 0) {
      parts.push(this.quote(table))
    }
    return parts.join('.')
  }

  /** Add a page window to a SELECT. */
  paginate(sql, limit, offset) {
    const body = String(sql).replace(/;\s*$/, '')
    const size = Math.max(0, Number(limit) || 0)
    const start = Math.max(0, Number(offset) || 0)
    return start > 0 ? `${body} LIMIT ${size} OFFSET ${start}` : `${body} LIMIT ${size}`
  }

  /** `SELECT COUNT(*)` over a qualified table with an optional WHERE body. */
  countSql(qualified, where) {
    const filter = where !== undefined && where !== null && String(where).length > 0 ? ` WHERE ${where}` : ''
    return `SELECT COUNT(*) AS total FROM ${qualified}${filter}`
  }

  /** Statement that switches the current database, or null when there is none. */
  useDatabase(database) {
    return `USE ${this.quote(database)}`
  }

  /** Statement that switches the current schema, or null. */
  useSchema() {
    return null
  }

  // ------------------------------------------------------------ introspection
  showDatabases() {
    return this.unsupported('列出数据库')
  }

  showSchemas() {
    return null
  }

  showTables(database, schema) {
    return `SELECT table_name FROM information_schema.tables WHERE ${this.catalogFilter(database, schema)} AND table_type = 'BASE TABLE' ORDER BY table_name`
  }

  showViews(database, schema) {
    return `SELECT table_name FROM information_schema.views WHERE ${this.catalogFilter(database, schema)} ORDER BY table_name`
  }

  showProcedures(database, schema) {
    return `SELECT routine_name FROM information_schema.routines WHERE ${this.routineFilter(database, schema)} ORDER BY routine_name`
  }

  showColumns() {
    return this.unsupported('读取字段')
  }

  showPrimaryKeys() {
    return null
  }

  showForeignKeys() {
    return null
  }

  showIndexes() {
    return null
  }

  showTableComment() {
    return null
  }

  showCreateTable() {
    return null
  }

  viewSource() {
    return null
  }

  procedureSource() {
    return null
  }

  stats() {
    return null
  }

  /** WHERE fragment selecting one database/schema in information_schema.tables. */
  catalogFilter(database, schema) {
    const owner = this.hasSchemas ? schema : database
    return owner === undefined || owner === null || String(owner).length === 0
      ? '1 = 1'
      : `table_schema = ${this.literal(owner)}`
  }

  /** Same, for information_schema.routines. */
  routineFilter(database, schema) {
    const owner = this.hasSchemas ? schema : database
    return owner === undefined || owner === null || String(owner).length === 0
      ? '1 = 1'
      : `routine_schema = ${this.literal(owner)}`
  }

  // -------------------------------------------------------------------- DDL
  /** The engine-specific spelling of one column's type. */
  columnType(column) {
    const type = String(column?.data_type ?? '').trim()
    if (type.length === 0) {
      return 'TEXT'
    }
    const length = column?.character_maximum_length
    if (/^(var)?char$/i.test(type) && Number(length) > 0) {
      return `${type.toUpperCase()}(${Number(length)})`
    }
    return type
  }

  /** One column's definition inside CREATE TABLE. */
  columnDefinition(column) {
    const parts = [this.quote(column.name), this.columnType(column)]
    parts.push(column.is_nullable === false ? 'NOT NULL' : 'NULL')
    if (column.default_value !== undefined && column.default_value !== null && String(column.default_value).length > 0) {
      parts.push(`DEFAULT ${column.default_value}`)
    }
    return parts.join(' ')
  }

  createTable({ database, schema, table, columns }) {
    const body = columns.map((column) => this.columnDefinition(column))
    const keys = columns.filter((column) => column.is_primary_key === true).map((column) => this.quote(column.name))
    if (keys.length > 0) {
      body.push(`PRIMARY KEY (${keys.join(', ')})`)
    }
    return [`CREATE TABLE ${this.qualify({ database, schema, table })} (\n  ${body.join(',\n  ')}\n)`]
  }

  dropTable({ database, schema, table }) {
    return [`DROP TABLE ${this.qualify({ database, schema, table })}`]
  }

  addColumn({ database, schema, table, column }) {
    return [
      `ALTER TABLE ${this.qualify({ database, schema, table })} ADD COLUMN ${this.columnDefinition(column)}`,
    ]
  }

  modifyColumn() {
    return this.unsupported('修改字段')
  }

  dropColumn({ database, schema, table, column }) {
    return [`ALTER TABLE ${this.qualify({ database, schema, table })} DROP COLUMN ${this.quote(column)}`]
  }

  setTableComment() {
    return this.unsupported('修改表注释')
  }

  createIndex({ database, schema, table, index, columns, unique }) {
    const list = columns.map((column) => this.quote(column)).join(', ')
    return [
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.quote(index)} ON ${this.qualify({ database, schema, table })} (${list})`,
    ]
  }

  dropIndex({ database, schema, table, index }) {
    return [`DROP INDEX ${this.quote(index)} ON ${this.qualify({ database, schema, table })}`]
  }

  createDatabase(database) {
    return [`CREATE DATABASE ${this.quote(database)}`]
  }

  dropDatabase(database) {
    return [`DROP DATABASE ${this.quote(database)}`]
  }

  truncateTable({ database, schema, table }) {
    return [`TRUNCATE TABLE ${this.qualify({ database, schema, table })}`]
  }

  /** How this engine says "give me no rows, just the shape". */
  emptySelect(qualified) {
    return `SELECT * FROM ${qualified} WHERE 1 = 0`
  }

  /** Refuse an operation this engine does not have, with a panel-ready message. */
  unsupported(what) {
    throw new DbmError(ERR.unsupported, `${this.dbType} 不支持${what}`)
  }
}
