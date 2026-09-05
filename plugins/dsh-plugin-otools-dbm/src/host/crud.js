/**
 * Row editing: the grid's save button, and the four single-row commands behind the
 * row context menu.
 *
 * The important thing here is how a row is identified. The reference hard-coded the
 * column name `id` into every UPDATE and DELETE, so a table whose key is
 * `user_uuid` silently updated whatever an `id` column happened to hold, and a
 * composite key was impossible. This uses the primary key from the table's
 * structure, requires ALL of its parts, and refuses the edit when the table has no
 * key at all — an honest error beats a write that hits the wrong row.
 *
 * A save runs in one transaction per table where the engine has transactions, so a
 * failure halfway through a 200-row paste leaves nothing behind.
 *
 * @module dsh-plugin-otools-dbm/host/crud
 */
import { DbmError, ERR } from '../shared/protocol.js'

import { queryResult } from './engines/result.js'

/** `BEGIN`-flavour per engine; null where the engine has no transactions. */
const TRANSACTIONS = {
  mysql: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mariadb: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  postgresql: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  kingbasees: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlite: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlserver: { begin: 'BEGIN TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  snowflake: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  // Oracle and Dameng open a transaction implicitly on the first DML; there is no
  // BEGIN to send, only the two ends.
  oracle: { begin: null, commit: 'COMMIT', rollback: 'ROLLBACK' },
  dameng: { begin: null, commit: 'COMMIT', rollback: 'ROLLBACK' },
  // ClickHouse has no transactions worth the name for this use.
  clickhouse: null,
}

/** Run `fn` inside a transaction when the engine has one. */
export async function inTransaction(engine, database, fn) {
  const flavour = TRANSACTIONS[engine.dbType]
  if (flavour === undefined || flavour === null) {
    return fn()
  }
  if (flavour.begin !== null) {
    await engine.run(flavour.begin, { database })
  }
  try {
    const outcome = await fn()
    await engine.run(flavour.commit, { database })
    return outcome
  } catch (error) {
    try {
      await engine.run(flavour.rollback, { database })
    } catch {
      // The original error is the one worth reporting.
    }
    throw error
  }
}

/** Columns of a table, and its primary key, as the writers need them. */
async function tableShape(engine, { database, schema, table }) {
  const struct = await engine.tableStruct(database, table, schema)
  const columns = new Map(struct.columns.map((column) => [column.name, column]))
  return { struct, columns, primaryKeys: struct.primary_keys ?? [] }
}

/** Drop keys the table does not have — a grid row carries UI-only fields. */
function pickColumns(row, columns) {
  const output = {}
  for (const [key, value] of Object.entries(row ?? {})) {
    if (columns.has(key)) {
      output[key] = value
    }
  }
  return output
}

/** A value on its way into a bind slot. */
function bindValue(value) {
  if (value === undefined) {
    return null
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (value instanceof Date) {
    return value
  }
  return JSON.stringify(value)
}

/** INSERT for one row. */
function insertStatement(engine, { database, schema, table }, row) {
  const dialect = engine.dialect
  const names = Object.keys(row)
  if (names.length === 0) {
    throw new DbmError(ERR.invalidInput, '没有要写入的字段')
  }
  const values = []
  const placeholders = names.map((name, index) => {
    if (dialect.supportsBind) {
      values.push(bindValue(row[name]))
      return dialect.placeholder(index + 1)
    }
    return literalOf(dialect, row[name])
  })
  const columns = names.map((name) => dialect.quote(name)).join(', ')
  return {
    sql: `INSERT INTO ${dialect.qualify({ database, schema, table })} (${columns}) VALUES (${placeholders.join(', ')})`,
    values,
  }
}

/** UPDATE for one row, keyed on every primary-key column. */
function updateStatement(engine, target, { row, key, primaryKeys }) {
  const dialect = engine.dialect
  const assignments = []
  const values = []
  let index = 1

  for (const [name, value] of Object.entries(row)) {
    if (primaryKeys.includes(name)) {
      // A key column is the address, not the payload: changing it would move the
      // row out from under the WHERE clause.
      continue
    }
    if (dialect.supportsBind) {
      assignments.push(`${dialect.quote(name)} = ${dialect.placeholder(index)}`)
      values.push(bindValue(value))
      index += 1
    } else {
      assignments.push(`${dialect.quote(name)} = ${literalOf(dialect, value)}`)
    }
  }
  if (assignments.length === 0) {
    return undefined
  }

  const { clause, values: keyValues } = whereKey(engine, key, primaryKeys, index)
  return {
    sql: `UPDATE ${dialect.qualify(target)} SET ${assignments.join(', ')} WHERE ${clause}`,
    values: [...values, ...keyValues],
  }
}

/** DELETE for one row. */
function deleteStatement(engine, target, { key, primaryKeys }) {
  const dialect = engine.dialect
  const { clause, values } = whereKey(engine, key, primaryKeys, 1)
  return { sql: `DELETE FROM ${dialect.qualify(target)} WHERE ${clause}`, values }
}

/** `pk1 = ? AND pk2 = ?`, or `IS NULL` for a null part. */
function whereKey(engine, key, primaryKeys, startIndex) {
  const dialect = engine.dialect
  if (primaryKeys.length === 0) {
    throw new DbmError(
      ERR.unsupported,
      '这张表没有主键，无法定位要修改的行。请先加主键，或改用 SQL 工作台执行带条件的语句。',
    )
  }
  const clauses = []
  const values = []
  let index = startIndex

  for (const column of primaryKeys) {
    if (!(column in key)) {
      throw new DbmError(ERR.invalidInput, `缺少主键字段 ${column} 的值，无法定位这一行`)
    }
    const value = key[column]
    if (value === null || value === undefined) {
      clauses.push(`${dialect.quote(column)} IS NULL`)
      continue
    }
    if (dialect.supportsBind) {
      clauses.push(`${dialect.quote(column)} = ${dialect.placeholder(index)}`)
      values.push(bindValue(value))
      index += 1
    } else {
      clauses.push(`${dialect.quote(column)} = ${literalOf(dialect, value)}`)
    }
  }
  return { clause: clauses.join(' AND '), values }
}

/** An inline literal, for the engines whose driver takes no binds. */
function literalOf(dialect, value) {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0'
  }
  return dialect.literal(typeof value === 'string' ? value : JSON.stringify(value))
}

/** The key of a row: the primary-key columns, read from `original` when given. */
function keyOf(row, primaryKeys) {
  const key = {}
  for (const column of primaryKeys) {
    if (row !== null && row !== undefined && column in row) {
      key[column] = row[column]
    }
  }
  return key
}

// ---------------------------------------------------------------- single row
export async function insertRecord(engine, { database, schema, table, data }) {
  const target = { database, schema, table }
  const { columns } = await tableShape(engine, target)
  const row = pickColumns(data, columns)
  const statement = insertStatement(engine, target, row)
  return engine.run(statement.sql, { database, values: statement.values })
}

export async function updateRecord(engine, { database, schema, table, id, data }) {
  const target = { database, schema, table }
  const { columns, primaryKeys } = await tableShape(engine, target)
  const row = pickColumns(data, columns)
  const key = keyOf(idToKey(id, primaryKeys, data), primaryKeys)
  const statement = updateStatement(engine, target, { row, key, primaryKeys })
  if (statement === undefined) {
    return queryResult({ columns: ['affected_rows'], rows: [[0]], rowCount: 0, executionTime: 0 })
  }
  return engine.run(statement.sql, { database, values: statement.values })
}

export async function deleteRecord(engine, { database, schema, table, id }) {
  const target = { database, schema, table }
  const { primaryKeys } = await tableShape(engine, target)
  const key = keyOf(idToKey(id, primaryKeys, {}), primaryKeys)
  const statement = deleteStatement(engine, target, { key, primaryKeys })
  return engine.run(statement.sql, { database, values: statement.values })
}

/**
 * The row context menu sends a bare `id` value, not a key object.
 *
 * With a single-column key that is unambiguous. With a composite key it is not, so
 * the row's own values are used when they are available and the edit is refused
 * when they are not.
 */
function idToKey(id, primaryKeys, row) {
  if (id !== null && typeof id === 'object' && !Array.isArray(id)) {
    return id
  }
  if (primaryKeys.length === 1) {
    return { [primaryKeys[0]]: id }
  }
  const fromRow = keyOf(row, primaryKeys)
  if (Object.keys(fromRow).length === primaryKeys.length) {
    return fromRow
  }
  throw new DbmError(
    ERR.invalidInput,
    `这张表是复合主键（${primaryKeys.join(', ')}），需要每一列的值才能定位行`,
  )
}

export async function bulkInsert(engine, { database, schema, table, records }) {
  const rows = Array.isArray(records) ? records : []
  if (rows.length === 0) {
    throw new DbmError(ERR.invalidInput, '没有要写入的数据')
  }
  const target = { database, schema, table }
  const { columns } = await tableShape(engine, target)

  let affected = 0
  await inTransaction(engine, database, async () => {
    for (const record of rows) {
      const statement = insertStatement(engine, target, pickColumns(record, columns))
      const outcome = await engine.run(statement.sql, { database, values: statement.values })
      affected += Number(outcome.row_count ?? 0) || 0
    }
  })
  return queryResult({ columns: ['affected_rows'], rows: [[affected]], rowCount: affected, executionTime: 0 })
}

// ------------------------------------------------------------------ grid save
/**
 * The grid's save button.
 *
 * `changes.validate_only` runs every check and writes nothing, which is what the
 * panel's pre-save probe uses. The Redis/Mongo/ES engines take over through their
 * own `saveRows`, because "row" means something different there.
 */
export async function saveTableData(engine, { database, schema, table, changes }) {
  const payload = changes ?? {}
  const added = Array.isArray(payload.added) ? payload.added : []
  const modified = Array.isArray(payload.modified) ? payload.modified : []
  const deleted = Array.isArray(payload.deleted) ? payload.deleted : []
  const validateOnly = payload.validate_only === true

  if (typeof engine.saveRows === 'function') {
    return engine.saveRows({ database, schema, table, changes: payload })
  }

  const target = { database, schema, table }
  const { columns, primaryKeys } = await tableShape(engine, target)

  const statements = []
  for (const row of added) {
    statements.push(insertStatement(engine, target, pickColumns(row, columns)))
  }
  for (const entry of modified) {
    const current = pickColumns(entry?.current, columns)
    const original = entry?.original ?? entry?.current
    const key = keyOf(original, primaryKeys)
    // Only the columns that actually changed go into the SET list: a grid sends
    // the whole row back, and rewriting untouched columns is how a concurrent
    // edit by someone else gets silently reverted.
    const changed = {}
    for (const [name, value] of Object.entries(current)) {
      const before = original === null || original === undefined ? undefined : original[name]
      if (!sameValue(before, value)) {
        changed[name] = value
      }
    }
    const statement = updateStatement(engine, target, { row: changed, key, primaryKeys })
    if (statement !== undefined) {
      statements.push(statement)
    }
  }
  for (const row of deleted) {
    statements.push(deleteStatement(engine, target, { key: keyOf(row, primaryKeys), primaryKeys }))
  }

  if (validateOnly) {
    return { validated: statements.length, inserted: 0, updated: 0, deleted: 0 }
  }
  if (statements.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0 }
  }

  await inTransaction(engine, database, async () => {
    for (const statement of statements) {
      await engine.run(statement.sql, { database, values: statement.values })
    }
  })

  return { inserted: added.length, updated: modified.length, deleted: deleted.length }
}

/** Loose equality for grid values: everything arrives as a string from the DOM. */
function sameValue(left, right) {
  if (left === right) {
    return true
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined || right === ''
  }
  if (right === null || right === undefined) {
    return left === ''
  }
  return String(left) === String(right)
}

// ------------------------------------------------------------------ pagination
/** `paginated_query`: the same page the grid asks for, addressed by page number. */
export async function paginatedQuery(engine, { database, schema, table, page, pageSize, orderBy, filters }) {
  const size = Math.min(5000, Math.max(1, Number(pageSize) || 100))
  const index = Math.max(1, Number(page) || 1)
  return engine.tableData({
    database,
    schema,
    table,
    limit: size,
    offset: (index - 1) * size,
    orderBy,
    filters,
  })
}
