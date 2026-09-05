/**
 * Turning whatever a driver hands back into the `QueryResult` the panel expects.
 *
 * The panel's grid is `columns: string[]` + `rows: any[][]` of JSON-safe values,
 * so every driver's private value types have to be flattened here — once, in one
 * place, so MySQL and Postgres and SQLite all render a DATETIME the same way. The
 * rules below are the reference's observable behaviour, not an improvement on it:
 *
 * - Dates become `YYYY-MM-DD HH:mm:ss` in the host's local zone (`.000` stripped),
 *   because that is what the grid's inline editor writes back.
 * - BigInt and Postgres `numeric` stay STRINGS. Turning them into JS numbers is
 *   silent data loss on an id column past 2^53.
 * - Buffers become `0x…` hex, which is both what a MySQL client prints and a form
 *   that can be pasted back into a WHERE clause.
 * - Objects/arrays (JSON, jsonb, composite types) become compact JSON text.
 *
 * @module dsh-plugin-otools-dbm/host/engines/result
 */

const pad = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD HH:mm:ss[.mmm]` in local time, matching the panel's editor. */
export function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  const head = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const millis = date.getMilliseconds()
  return millis === 0 ? `${head} ${time}` : `${head} ${time}.${String(millis).padStart(3, '0')}`
}

/** Hex form of a byte buffer, truncated with a marker past `limit` bytes. */
export function formatBuffer(value, limit = 64 * 1024) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (buffer.length > limit) {
    return `0x${buffer.subarray(0, limit).toString('hex')}…(${buffer.length} bytes)`
  }
  return `0x${buffer.toString('hex')}`
}

/** One cell, JSON-safe. */
export function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null
  }
  const type = typeof value
  if (type === 'string' || type === 'boolean') {
    return value
  }
  if (type === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (type === 'bigint') {
    return value.toString()
  }
  if (value instanceof Date) {
    return formatDate(value)
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return formatBuffer(value)
  }
  if (Array.isArray(value) || type === 'object') {
    // Driver objects that know how to print themselves (pg intervals, Mongo
    // ObjectId, Oracle Lob metadata) do it better than JSON.stringify would.
    if (typeof value.toJSON === 'function') {
      try {
        return normalizeValue(value.toJSON())
      } catch {
        /* fall through to JSON.stringify */
      }
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** One row (object → array in `columns` order, array → normalized in place). */
export function normalizeRow(row, columns) {
  if (Array.isArray(row)) {
    return row.map((cell) => normalizeValue(cell))
  }
  return columns.map((column) => normalizeValue(row?.[column]))
}

/**
 * Build a QueryResult.
 * @param options.columns - column names in order.
 * @param options.rows - array of arrays or array of objects.
 * @param options.rowCount - affected rows for a write, row count for a read.
 * @param options.executionTime - milliseconds.
 */
export function queryResult(options = {}) {
  const columns = Array.isArray(options.columns) ? options.columns.map((name) => String(name)) : []
  const rawRows = Array.isArray(options.rows) ? options.rows : []
  const rows = rawRows.map((row) => normalizeRow(row, columns))
  return {
    columns,
    rows,
    row_count: options.rowCount === undefined || options.rowCount === null ? rows.length : Number(options.rowCount),
    execution_time: options.executionTime === undefined ? null : Math.round(Number(options.executionTime) || 0),
  }
}

/** A result that only reports how many rows a write touched. */
export function affectedResult(affected, executionTime) {
  return queryResult({
    columns: ['affected_rows'],
    rows: [[Number(affected) || 0]],
    rowCount: Number(affected) || 0,
    executionTime,
  })
}

/** An empty result with a message column — used where a driver says nothing. */
export function messageResult(message, executionTime) {
  return queryResult({
    columns: ['message'],
    rows: [[String(message)]],
    rowCount: 0,
    executionTime,
  })
}

/** Column names from the first object row, for drivers with no metadata. */
export function columnsFromRows(rows) {
  const names = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  return names
}

/** Milliseconds since a `process.hrtime.bigint()` mark. */
export function elapsedSince(mark) {
  return Number(process.hrtime.bigint() - mark) / 1e6
}
