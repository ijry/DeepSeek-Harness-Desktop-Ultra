/**
 * The generic SQL engine: one implementation for every SQL dialect.
 *
 * It owns three things a dialect must not: connection handles, row mapping, and
 * the multi-statement script protocol the workbench speaks. A dialect supplies SQL
 * text; a driver supplies `open/close/exec`; this class is the only place that
 * knows how those two fit together.
 *
 * Two connection strategies, chosen by the driver's `perDatabaseConnection` flag:
 *
 * - MySQL, SQL Server, Oracle-family: ONE handle, and switching database is a
 *   statement (`USE db`). Cheap, and it keeps session state (temp tables,
 *   variables) alive across the panel's calls.
 * - PostgreSQL, SQLite: a handle PER database, because in those engines a
 *   connection is bound to one database for its lifetime. The handles are cached
 *   and closed together.
 *
 * @module dsh-plugin-otools-dbm/host/engines/sql-engine
 */
import { DbmError, ERR } from '../../shared/protocol.js'
import { leadingKeyword, previewOf, returnsRows, splitStatements } from '../sql/split.js'

import { columnsFromRows, elapsedSince, normalizeValue, queryResult } from './result.js'

/** Filter operators the panel's advanced filter can send, longest match first. */
const FILTER_OPERATORS = [
  'IS_NOT_NULL',
  'IS_NULL',
  'NOT_LIKE',
  'LIKE',
  '>=',
  '<=',
  '!=',
  '=',
  '>',
  '<',
]

/** How many rows one statement may return before the host refuses to buffer it. */
export const MAX_ROWS = 200000

export class SqlEngine {
  /**
   * @param options.connection - the stored DbConnection record.
   * @param options.dialect - a SqlDialect instance.
   * @param options.driver - `{ open, close, exec, ping?, perDatabaseConnection?, supportsMultipleStatements? }`.
   */
  constructor({ connection, dialect, driver }) {
    this.connection = connection
    this.dialect = dialect
    this.driver = driver
    this.kind = 'sql'
    this.dbType = String(connection?.db_type ?? dialect.dbType).toLowerCase()
    /** database name → handle (single entry keyed '' when not per-database). */
    this.handles = new Map()
    this.currentDatabase = undefined
    this.closed = false
  }

  /** The database a call should run against when it names none. */
  defaultDatabase() {
    const configured = String(this.connection?.database ?? '').trim()
    return configured.length > 0 ? configured : undefined
  }

  /** Open (or reuse) a handle for `database`. */
  async handleFor(database) {
    if (this.closed) {
      throw new DbmError(ERR.connectionClosed, '连接已关闭，请重新连接')
    }
    const target = database ?? this.defaultDatabase()

    if (this.driver.perDatabaseConnection === true) {
      const key = target ?? ''
      const existing = this.handles.get(key)
      if (existing !== undefined) {
        return existing
      }
      const handle = await this.driver.open(this.connection, { database: target })
      this.handles.set(key, handle)
      return handle
    }

    let handle = this.handles.get('')
    if (handle === undefined) {
      handle = await this.driver.open(this.connection, { database: target })
      this.handles.set('', handle)
      this.currentDatabase = target
      return handle
    }
    if (target !== undefined && target !== this.currentDatabase) {
      const statement = this.dialect.useDatabase(target)
      if (statement !== null && statement !== undefined) {
        await this.driver.exec(handle, statement, [])
      }
      this.currentDatabase = target
    }
    return handle
  }

  /** Liveness probe. */
  async ping() {
    if (this.closed) {
      return false
    }
    try {
      const handle = await this.handleFor(undefined)
      if (typeof this.driver.ping === 'function') {
        return await this.driver.ping(handle)
      }
      await this.driver.exec(handle, this.dialect.pingSql ? this.dialect.pingSql() : 'SELECT 1', [])
      return true
    } catch {
      return false
    }
  }

  /** Close every handle. Idempotent. */
  async close() {
    this.closed = true
    const handles = Array.from(this.handles.values())
    this.handles.clear()
    for (const handle of handles) {
      try {
        await this.driver.close(handle)
      } catch {
        // A connection that is already gone is the outcome we wanted.
      }
    }
  }

  // ------------------------------------------------------------------ raw SQL
  /**
   * Run one statement and normalize the result.
   * @param sql - a single statement.
   * @param options.database - database to run against.
   * @param options.values - bind values, when the driver takes them.
   */
  async run(sql, options = {}) {
    const handle = await this.handleFor(options.database)
    const started = process.hrtime.bigint()
    const raw = await this.driver.exec(handle, sql, options.values ?? [])
    const executionTime = elapsedSince(started)

    const rows = Array.isArray(raw?.rows) ? raw.rows : []
    if (rows.length > MAX_ROWS) {
      throw new DbmError(ERR.tooLarge, `结果集超过 ${MAX_ROWS} 行，请加上 LIMIT 后重试`)
    }
    const columns = Array.isArray(raw?.columns) && raw.columns.length > 0 ? raw.columns : columnsFromRows(rows)

    if (columns.length === 0 && rows.length === 0) {
      const affected = Number(raw?.rowCount ?? 0) || 0
      return queryResult({
        columns: ['affected_rows'],
        rows: [[affected]],
        rowCount: affected,
        executionTime,
      })
    }
    return queryResult({
      columns,
      rows,
      rowCount: raw?.rowCount === undefined || raw?.rowCount === null ? rows.length : raw.rowCount,
      executionTime,
    })
  }

  /** Run a statement and hand back plain objects, for introspection mapping. */
  async select(sql, options = {}) {
    if (sql === null || sql === undefined) {
      return []
    }
    const handle = await this.handleFor(options.database)
    const raw = await this.driver.exec(handle, String(sql), options.values ?? [])
    const rows = Array.isArray(raw?.rows) ? raw.rows : []
    if (rows.length === 0) {
      return []
    }
    if (!Array.isArray(rows[0])) {
      return rows
    }
    const columns = Array.isArray(raw?.columns) ? raw.columns : []
    return rows.map((row) => {
      const record = {}
      columns.forEach((name, index) => {
        record[name] = row[index]
      })
      return record
    })
  }

  /** First column of every row, as strings — the shape every list route wants. */
  async selectColumn(sql, options = {}) {
    const rows = await this.select(sql, options)
    return rows
      .map((row) => {
        const values = Object.values(row)
        return values.length === 0 ? '' : normalizeValue(values[0])
      })
      .filter((value) => value !== null && value !== undefined && String(value).length > 0)
      .map((value) => String(value))
  }

  /** Run DDL (one statement or many) and report how many statements ran. */
  async runDdl(statements, options = {}) {
    const list = (Array.isArray(statements) ? statements : [statements]).filter(
      (statement) => typeof statement === 'string' && statement.trim().length > 0,
    )
    if (list.length === 0) {
      throw new DbmError(ERR.invalidInput, '没有可执行的语句')
    }
    const started = process.hrtime.bigint()
    let affected = 0
    for (const statement of list) {
      const handle = await this.handleFor(options.database)
      const raw = await this.driver.exec(handle, statement, [])
      affected += Number(raw?.rowCount ?? 0) || 0
    }
    return queryResult({
      columns: ['affected_rows'],
      rows: [[affected]],
      rowCount: affected,
      executionTime: elapsedSince(started),
    })
  }

  // ------------------------------------------------------------------- scripts
  /**
   * The workbench protocol: split a buffer, run each statement, and report all of
   * them — including the ones that failed.
   *
   * `stopOnError` is what the panel expects of the tree's "execute" (abort) versus
   * the workbench's "run all" (keep going and mark the failures), which is why the
   * two routes differ only by this flag.
   */
  async executeScript(script, options = {}) {
    const statements = splitStatements(script, { dbType: this.dbType })
    if (statements.length === 0) {
      throw new DbmError(ERR.invalidInput, '没有可执行的 SQL')
    }

    const perStatement = []
    let last = null
    let failedIndex = null
    let batchError = null

    for (const statement of statements) {
      const record = {
        statement_index: statement.index,
        sql: statement.sql,
        sql_preview: previewOf(statement.sql),
        columns: [],
        rows: [],
        row_count: null,
        execution_time: null,
        success: true,
        error_message: null,
      }
      try {
        const result = await this.run(statement.sql, { database: options.database })
        record.columns = result.columns
        record.rows = result.rows
        record.row_count = result.row_count
        record.execution_time = result.execution_time
        if (returnsRows(statement.sql) || result.columns.length > 1 || last === null) {
          last = result
        }
      } catch (error) {
        record.success = false
        record.error_message = messageOf(error)
        if (failedIndex === null) {
          failedIndex = statement.index
          batchError = `第 ${statement.index + 1} 条 SQL 执行失败: ${record.error_message}`
        }
        perStatement.push(record)
        if (options.stopOnError !== false) {
          // Strict mode (the tree, the dashboard) reports a failure as a failure:
          // the panel's own error humanizer knows this exact prefix and unwraps it,
          // and a caller that asked for one statement wants an exception, not a
          // result object it has to inspect. The workbench asks for the other
          // behaviour by passing stopOnError: false.
          throw new DbmError(
            ERR.internal,
            `${batchError}${statements.length > 1 ? `\nSQL语句: ${statement.sql}` : ''}`,
            { cause: error },
          )
        }
        continue
      }
      perStatement.push(record)
    }

    const successes = perStatement.filter((record) => record.success)
    const shaped = last ?? {
      columns: successes.length > 0 ? successes[successes.length - 1].columns : [],
      rows: successes.length > 0 ? successes[successes.length - 1].rows : [],
      row_count: successes.length > 0 ? successes[successes.length - 1].row_count : 0,
      execution_time: 0,
    }

    const total = perStatement.reduce((sum, record) => sum + (Number(record.execution_time) || 0), 0)
    return {
      ...shaped,
      execution_time: Math.round(total),
      statements: perStatement,
      has_errors: failedIndex !== null,
      batch_error_message: batchError,
      failed_statement_index: failedIndex,
    }
  }

  // -------------------------------------------------------------- introspection
  async listDatabases() {
    const sql = this.dialect.showDatabases()
    return sql === null ? [] : this.selectColumn(sql)
  }

  async listSchemas(database) {
    const sql = this.dialect.showSchemas(database)
    return sql === null ? [] : this.selectColumn(sql, { database })
  }

  async listTables(database, schema) {
    const sql = this.dialect.showTables(database, schema)
    return sql === null ? [] : this.selectColumn(sql, { database })
  }

  async listViews(database, schema) {
    const sql = this.dialect.showViews(database, schema)
    return sql === null ? [] : this.selectColumn(sql, { database })
  }

  async listProcedures(database, schema) {
    const sql = this.dialect.showProcedures(database, schema)
    return sql === null ? [] : this.selectColumn(sql, { database })
  }

  async viewDefinition(database, view, schema) {
    const sql = this.dialect.viewSource(database, view, schema)
    if (sql === null) {
      return ''
    }
    const rows = await this.select(sql, { database })
    return firstTextValue(rows)
  }

  async procedureDefinition(database, procedure, schema) {
    const sql = this.dialect.procedureSource(database, procedure, schema)
    if (sql === null) {
      return ''
    }
    const rows = await this.select(sql, { database })
    return firstTextValue(rows)
  }

  /** Full structure of one table, in the panel's TableStruct shape. */
  async tableStruct(database, table, schema) {
    const columnRows = await this.select(this.dialect.showColumns(database, table, schema), { database })
    const columns = columnRows.map((row) => mapColumn(row))

    const primaryFromColumns = columns.filter((column) => column.is_primary_key).map((column) => column.name)
    let primaryKeys = primaryFromColumns
    if (primaryKeys.length === 0) {
      const sql = this.dialect.showPrimaryKeys(database, table, schema)
      if (sql !== null && sql !== undefined) {
        const rows = await this.select(sql, { database })
        primaryKeys = rows
          .map((row) => String(normalizeValue(pick(row, 'column_name')) ?? ''))
          .filter((name) => name.length > 0)
        for (const column of columns) {
          if (primaryKeys.includes(column.name)) {
            column.is_primary_key = true
          }
        }
      }
    }

    const foreignKeys = []
    const foreignSql = this.dialect.showForeignKeys(database, table, schema)
    if (foreignSql !== null && foreignSql !== undefined) {
      for (const row of await this.select(foreignSql, { database })) {
        foreignKeys.push({
          constraint_name: text(pick(row, 'constraint_name')),
          column_name: text(pick(row, 'column_name')),
          referenced_schema: optional(pick(row, 'referenced_schema')),
          referenced_table: text(pick(row, 'referenced_table')),
          referenced_column: text(pick(row, 'referenced_column')),
        })
      }
    }

    const indexes = []
    const indexSql = this.dialect.showIndexes(database, table, schema)
    if (indexSql !== null && indexSql !== undefined) {
      const byName = new Map()
      for (const row of await this.select(indexSql, { database })) {
        const name = text(pick(row, 'name'))
        if (name.length === 0) {
          continue
        }
        const bucket = byName.get(name) ?? { name, columns: [], is_unique: truthy(pick(row, 'is_unique')) }
        const column = text(pick(row, 'column_name'))
        if (column.length > 0 && !bucket.columns.includes(column)) {
          bucket.columns.push(column)
        }
        byName.set(name, bucket)
      }
      indexes.push(...byName.values())
    }

    let comment = ''
    const commentSql = this.dialect.showTableComment(database, table, schema)
    if (commentSql !== null && commentSql !== undefined) {
      const rows = await this.select(commentSql, { database })
      comment = firstTextValue(rows)
    }

    return {
      table_name: table,
      columns,
      primary_keys: primaryKeys,
      foreign_keys: foreignKeys,
      indexes,
      comment,
    }
  }

  /** `SHOW CREATE TABLE` where the engine has it, composed DDL where it does not. */
  async createTableStatement(database, table, schema) {
    const sql = this.dialect.showCreateTable(database, table, schema)
    if (sql !== null && sql !== undefined) {
      const rows = await this.select(sql, { database })
      if (rows.length > 0) {
        // MySQL's SHOW CREATE TABLE puts the DDL in the LAST column; the
        // information-schema/GET_DDL variants have exactly one.
        const values = Object.values(rows[0]).map((value) => normalizeValue(value))
        const ddl = values.length === 1 ? values[0] : values[values.length - 1]
        if (typeof ddl === 'string' && ddl.trim().length > 0) {
          return ddl
        }
      }
    }
    const struct = await this.tableStruct(database, table, schema)
    const statements = this.dialect.createTable({
      database,
      schema,
      table,
      columns: struct.columns,
      comment: struct.comment,
    })
    return statements.join(';\n') + ';'
  }

  async stats() {
    const sql = this.dialect.stats()
    if (sql === null || sql === undefined) {
      return { databases: [] }
    }
    const rows = await this.select(sql)
    return {
      databases: rows.map((row) => ({
        name: text(pick(row, 'database_name')),
        table_count: number(pick(row, 'table_count')),
        row_count: number(pick(row, 'row_count')),
        data_size: number(pick(row, 'data_size')),
        index_size: number(pick(row, 'index_size')),
      })),
    }
  }

  // ------------------------------------------------------------------ table data
  /** WHERE body plus bind values for the panel's `field_OPERATOR` filter map. */
  buildWhere(filters, startIndex = 1) {
    const entries = Object.entries(filters ?? {})
    const clauses = []
    const values = []
    let index = startIndex

    for (const [key, value] of entries) {
      const operator = FILTER_OPERATORS.find((candidate) => key.endsWith(`_${candidate}`))
      if (operator === undefined) {
        continue
      }
      const field = key.slice(0, key.length - operator.length - 1)
      if (field.length === 0) {
        continue
      }
      const column = this.dialect.quote(field)

      if (operator === 'IS_NULL') {
        clauses.push(`${column} IS NULL`)
        continue
      }
      if (operator === 'IS_NOT_NULL') {
        clauses.push(`${column} IS NOT NULL`)
        continue
      }

      const comparison = operator === 'NOT_LIKE' ? 'NOT LIKE' : operator
      const bound = operator === 'LIKE' || operator === 'NOT_LIKE' ? likeValue(value) : value

      if (this.dialect.supportsBind) {
        clauses.push(`${column} ${comparison} ${this.dialect.placeholder(index)}`)
        values.push(bound)
        index += 1
      } else {
        clauses.push(`${column} ${comparison} ${this.dialect.literal(String(bound ?? ''))}`)
      }
    }

    return { where: clauses.join(' AND '), values }
  }

  /**
   * One page of a table, plus the total row count.
   *
   * `row_count` is the TOTAL matching rows, not the page length — the panel's
   * pager depends on that, which is why a second COUNT(*) runs. A COUNT that fails
   * (a view without statistics, a permission gap) degrades to the page length
   * rather than failing the whole read.
   */
  async tableData({ database, schema, table, limit = 100, offset = 0, orderBy, filters }) {
    const qualified = this.dialect.qualify({ database, schema, table })
    const { where, values } = this.buildWhere(filters)
    const filter = where.length > 0 ? ` WHERE ${where}` : ''
    const order = orderBy !== undefined && orderBy !== null && String(orderBy).trim().length > 0
      ? ` ORDER BY ${sanitizeOrderBy(String(orderBy), this.dialect)}`
      : ''

    const page = await this.run(
      this.dialect.paginate(`SELECT * FROM ${qualified}${filter}${order}`, limit, offset),
      { database, values },
    )

    let total = page.rows.length + Number(offset || 0)
    try {
      const counted = await this.select(this.dialect.countSql(qualified, where), { database, values })
      if (counted.length > 0) {
        total = number(Object.values(counted[0])[0])
      }
    } catch {
      // Keep the page usable even when COUNT(*) is not allowed here.
    }

    return { ...page, row_count: total }
  }
}

/** `%value%`, unless the user already wrote their own wildcards. */
function likeValue(value) {
  const text_ = String(value ?? '')
  return text_.includes('%') || text_.includes('_') ? text_ : `%${text_}%`
}

/**
 * An ORDER BY the panel supplied.
 *
 * The grid sends `column` or `column DESC`, never an expression, so anything else
 * is dropped rather than passed through — an ORDER BY is a place a subquery could
 * otherwise be smuggled in.
 */
function sanitizeOrderBy(input, dialect) {
  const parts = input
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = /^([A-Za-z0-9_一-龥$]+)(?:\s+(asc|desc))?$/i.exec(part)
      if (match === null) {
        throw new DbmError(ERR.invalidInput, `排序字段不合法: ${part}`)
      }
      const direction = match[2] === undefined ? '' : ` ${match[2].toUpperCase()}`
      return `${dialect.quote(match[1])}${direction}`
    })
  if (parts.length === 0) {
    throw new DbmError(ERR.invalidInput, '排序字段不合法')
  }
  return parts.join(', ')
}

/** Case-insensitive property read — drivers disagree on column-name case. */
function pick(row, name) {
  if (row === null || row === undefined) {
    return undefined
  }
  if (name in row) {
    return row[name]
  }
  const lower = name.toLowerCase()
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) {
      return row[key]
    }
  }
  return undefined
}

const text = (value) => {
  const normalized = normalizeValue(value)
  return normalized === null ? '' : String(normalized)
}

const optional = (value) => {
  const normalized = text(value)
  return normalized.length === 0 ? null : normalized
}

const number = (value) => {
  const parsed = Number(normalizeValue(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const truthy = (value) => {
  const normalized = normalizeValue(value)
  if (typeof normalized === 'boolean') {
    return normalized
  }
  const asText = String(normalized ?? '').toLowerCase()
  return asText === '1' || asText === 'true' || asText === 'yes' || asText === 't'
}

/** One column of one row, as text — for the definition/comment lookups. */
function firstTextValue(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return ''
  }
  const values = Object.values(rows[0])
  if (values.length === 0) {
    return ''
  }
  const normalized = normalizeValue(values.length === 1 ? values[0] : values[values.length - 1])
  return normalized === null ? '' : String(normalized)
}

/** One introspection row → ColumnSchema. */
function mapColumn(row) {
  const nullable = pick(row, 'is_nullable')
  const nullableText = String(normalizeValue(nullable) ?? '').toLowerCase()
  const fullType = text(pick(row, 'full_type'))
  const dataType = text(pick(row, 'data_type'))
  const length = pick(row, 'character_maximum_length')
  const parsedLength = Number(normalizeValue(length))

  return {
    name: text(pick(row, 'name')),
    data_type: fullType.length > 0 ? fullType : dataType,
    is_nullable: nullableText === 'yes' || nullableText === 'true' || nullableText === '1' || nullable === true,
    default_value: optional(pick(row, 'default_value')),
    is_primary_key: truthy(pick(row, 'is_primary_key')),
    character_maximum_length: Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null,
    column_comment: text(pick(row, 'column_comment')),
  }
}

/** Message of anything throwable, never `[object Object]`. */
export function messageOf(error) {
  if (error === null || error === undefined) {
    return '未知错误'
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}

export { FILTER_OPERATORS, leadingKeyword }
