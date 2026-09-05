/**
 * The three drivers this port treats as first-class: MySQL/MariaDB, PostgreSQL
 * (and its Kingbase fork), SQLite.
 *
 * A driver is deliberately tiny — `open` / `close` / `exec` / `ping` and two flags.
 * Everything above it (dialect SQL, row shaping, statement splitting) is engine
 * code shared by all fourteen.
 *
 * The `exec` contract: `{ columns: string[], rows: unknown[][], rowCount: number }`.
 * `columns` must be present even when `rows` is empty — the table designer reads a
 * column list off an empty SELECT — and `rowCount` is the affected count for
 * writes.
 *
 * @module dsh-plugin-otools-dbm/host/engines/drivers/sql
 */
import { classifyConnectionError, connectionErrorMessage, DbmError, ERR } from '../../../shared/protocol.js'

import { loadDriver, loadDriverNamed } from './load.js'

/** Wrap a driver's connect failure in the code the panel localizes. */
function connectionFailure(dbType, error) {
  const kind = classifyConnectionError(error)
  const detail = String(error?.message ?? error ?? '')
  return new DbmError(`${dbType}_conn`, connectionErrorMessage(dbType, kind, detail), { cause: error })
}

/** TLS options shared by mysql2 and pg: opt in, and do not verify by default. */
function tlsOptions(connection) {
  if (connection?.ssl !== true && connection?.use_ssl !== true) {
    return undefined
  }
  return { rejectUnauthorized: false }
}

// --------------------------------------------------------------------- MySQL
export const mysqlDriver = {
  perDatabaseConnection: false,
  supportsMultipleStatements: false,

  async open(connection, { database }) {
    const mysql = await loadDriver('mysql2/promise', 'MySQL/MariaDB')
    try {
      return await mysql.createConnection({
        host: connection.host || '127.0.0.1',
        port: Number(connection.port) || 3306,
        user: connection.username || 'root',
        password: connection.password ?? '',
        database: database || undefined,
        // The panel splits scripts itself, so the driver must not: leaving this
        // off is what keeps a `;` inside a string literal from becoming two
        // statements on the wire.
        multipleStatements: false,
        // Big integers and decimals arrive as strings so a bigint id column is
        // not silently rounded on its way to the grid.
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        dateStrings: false,
        connectTimeout: 15000,
        ssl: tlsOptions(connection),
      })
    } catch (error) {
      throw connectionFailure(connection.db_type, error)
    }
  },

  async close(handle) {
    await handle.end()
  },

  async ping(handle) {
    await handle.ping()
    return true
  },

  async exec(handle, sql, values) {
    const [rows, fields] = await handle.query({ sql, rowsAsArray: true }, values ?? [])
    if (Array.isArray(rows)) {
      return {
        columns: (fields ?? []).map((field) => field.name),
        rows,
        rowCount: rows.length,
      }
    }
    // OkPacket / ResultSetHeader for a write.
    return { columns: [], rows: [], rowCount: Number(rows?.affectedRows ?? 0) || 0 }
  },
}

// ---------------------------------------------------------------- PostgreSQL
export const postgresDriver = {
  // A pg connection is bound to one database for its lifetime; switching means a
  // new connection, so the engine caches one handle per database.
  perDatabaseConnection: true,
  supportsMultipleStatements: false,

  async open(connection, { database }) {
    const Client = await loadDriverNamed('pg', 'PostgreSQL', 'Client')
    const fallback = String(connection.db_type).toLowerCase() === 'kingbasees' ? 'kingbase' : 'postgres'
    const client = new Client({
      host: connection.host || '127.0.0.1',
      port: Number(connection.port) || 5432,
      user: connection.username || 'postgres',
      password: connection.password ?? '',
      database: database || connection.database || fallback,
      connectionTimeoutMillis: 15000,
      ssl: tlsOptions(connection),
      // An idle plugin connection must not keep the event loop alive.
      keepAlive: true,
    })
    // pg emits 'error' on a dropped socket; without a listener that is an
    // uncaught exception that would take the whole dsh process down.
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      throw connectionFailure(connection.db_type, error)
    }
    return client
  },

  async close(handle) {
    await handle.end()
  },

  async exec(handle, sql, values) {
    const result = await handle.query({ text: sql, values: values ?? [], rowMode: 'array' })
    // A multi-statement text (pg allows it without binds) yields an array.
    const last = Array.isArray(result) ? result[result.length - 1] : result
    const columns = (last?.fields ?? []).map((field) => field.name)
    const rows = Array.isArray(last?.rows) ? last.rows : []
    const affected = Number(last?.rowCount ?? 0) || 0
    return { columns, rows, rowCount: columns.length > 0 ? rows.length : affected }
  },
}

// --------------------------------------------------------------------- SQLite
export const sqliteDriver = {
  perDatabaseConnection: true,
  supportsMultipleStatements: true,

  /**
   * `node:sqlite` rather than an npm driver.
   *
   * The reference plugin shelled out to a bundled `sqlite3` binary and AirDB does
   * the same; both then have to ship (and find) a platform executable. Node has had
   * SQLite built in since 22.5, which is why this plugin's `engines.node` says
   * `>=22.5`: no native module to compile, no binary to bundle, no PATH lookup.
   */
  async open(connection) {
    const path = String(connection.database ?? '').trim()
    if (path.length === 0) {
      throw new DbmError(ERR.invalidInput, 'SQLite 需要一个数据库文件路径')
    }
    const DatabaseSync = await loadDriverNamed('node:sqlite', 'SQLite', 'DatabaseSync')
    try {
      const db = new DatabaseSync(path)
      // Foreign keys are off by default in SQLite; a table designer that shows FK
      // constraints should also enforce them.
      db.exec('PRAGMA foreign_keys = ON')
      return db
    } catch (error) {
      throw connectionFailure(connection.db_type, error)
    }
  },

  async close(handle) {
    handle.close()
  },

  async ping(handle) {
    handle.prepare('SELECT 1').get()
    return true
  },

  async exec(handle, sql, values) {
    const statement = handle.prepare(sql)
    const parameters = (values ?? []).map((value) => normalizeBind(value))

    // `columns()` answers even for a statement that returns no rows, which is how
    // the designer gets a column list out of `SELECT * … WHERE 1 = 0`.
    let columns = []
    try {
      columns = statement.columns().map((column) => column.name ?? column.column ?? '')
    } catch {
      columns = []
    }

    if (columns.length > 0) {
      const rows = statement.all(...parameters)
      return {
        columns,
        rows: rows.map((row) => columns.map((name) => row[name])),
        rowCount: rows.length,
      }
    }

    const outcome = statement.run(...parameters)
    return { columns: [], rows: [], rowCount: Number(outcome?.changes ?? 0) || 0 }
  },
}

/** node:sqlite only binds null/number/bigint/string/Buffer. */
function normalizeBind(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value)
  }
  return value
}
