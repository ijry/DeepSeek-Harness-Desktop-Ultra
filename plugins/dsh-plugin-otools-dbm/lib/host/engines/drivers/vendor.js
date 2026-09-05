/**
 * The four engines that need a vendor client of their own: SQL Server, ClickHouse,
 * Oracle, Snowflake.
 *
 * The contract is `sql.js`'s — `open` / `close` / `exec` / `ping` plus two flags —
 * but none of these four packages is promise-first, so most of this file is careful
 * promisification. One thing each that will bite a reader:
 *
 * - SQL Server (tedious) is callbacks and events all the way down, and since v18 the
 *   constructor no longer connects: a handle nobody called `.connect()` on simply
 *   never answers. Every bind needs an explicit TDS type, which is also why the
 *   dialect's placeholder is `@p1` rather than `?`.
 * - ClickHouse splits reads from writes in the CLIENT: `query()` for a SELECT,
 *   `command()` for DDL/DML. Send DDL through `query()` and it fails — and no write
 *   ever reports an affected-row count.
 * - Oracle rejects a statement that ends in `;`, and hands back a CLOB as a stream
 *   object unless the driver is told to fetch it as a string.
 * - Snowflake's `account` is not a hostname (the SDK appends
 *   `.snowflakecomputing.com` itself), and its rows arrive as objects keyed by
 *   column name, not as arrays.
 *
 * Oracle and Snowflake are optionalDependencies: `loadDriver` throwing
 * `driver_missing` is a normal outcome here rather than a bug, and the panel turns it
 * into "驱动未安装".
 *
 * @module dsh-plugin-otools-dbm/host/engines/drivers/vendor
 */
import { classifyConnectionError, connectionErrorMessage, DbmError, ERR } from '../../../shared/protocol.js'
import { leadingKeyword } from '../../sql/split.js'

import { loadDriver, loadDriverNamed } from './load.js'

/**
 * Wrap a driver's connect failure in the code the panel localizes.
 *
 * Copied from `sql.js` rather than shared: two files of drivers should not import
 * each other, and a four-line helper is not worth a third module.
 */
function connectionFailure(dbType, error) {
  const kind = classifyConnectionError(error)
  const detail = String(error?.message ?? error ?? '')
  return new DbmError(`${dbType}_conn`, connectionErrorMessage(dbType, kind, detail), { cause: error })
}

// ---------------------------------------------------------------- SQL Server
export const mssqlDriver = {
  // tedious can `USE db` on a live connection, so one handle serves every database.
  perDatabaseConnection: false,
  supportsMultipleStatements: true,

  async open(connection, { database }) {
    const tedious = await loadDriver('tedious', 'SQL Server')
    const client = new tedious.Connection({
      server: connection.host || '127.0.0.1',
      options: {
        port: Number(connection.port) || 1433,
        database: database || connection.database || undefined,
        // Azure SQL refuses an unencrypted login and a self-hosted instance usually
        // has nothing but a self-signed certificate: encrypt, but do not ask the
        // certificate to prove anything — the same trade `tlsOptions` makes for
        // mysql2 and pg in `sql.js`.
        encrypt: true,
        trustServerCertificate: true,
        // Rows are consumed from the 'row' event, so collecting them on the request
        // as well would keep a second copy of a 200k-row result in memory.
        rowCollectionOnRequestCompletion: false,
        // With this off a row arrives as an ARRAY of cells, which is the shape the
        // grid wants and the only one that survives a join's duplicate column names.
        useColumnNames: false,
        connectTimeout: 15000,
        // No per-request deadline: the workbench legitimately runs migrations that
        // take minutes. A dead socket still ends the request with an error.
        requestTimeout: 0,
      },
      authentication: {
        type: 'default',
        options: {
          userName: connection.username || 'sa',
          password: connection.password ?? '',
        },
      },
    })

    try {
      await new Promise((resolve, reject) => {
        // Two ways this ends: 'connect', whose argument is the login/timeout error
        // when there is one, or a bare 'error'. Both are wired, because a promise
        // that can only resolve is a hang waiting to happen.
        const onConnect = (error) => {
          client.removeListener('error', onError)
          if (error) {
            reject(error)
            return
          }
          resolve()
        }
        const onError = (error) => {
          client.removeListener('connect', onConnect)
          reject(error)
        }
        client.once('connect', onConnect)
        client.once('error', onError)
        // tedious 18 does not connect from the constructor any more; without this
        // call the handle sits in INITIALIZED for ever.
        client.connect()
      })
    } catch (error) {
      try {
        client.close()
      } catch {
        // Nothing to release when the connection never came up.
      }
      throw connectionFailure(connection.db_type, error)
    }

    // From here on an 'error' event (server restart, dropped socket) has no listener
    // of its own, and an EventEmitter without one throws — which in this process
    // means taking dsh's web server down with it.
    client.on('error', () => {})
    return client
  },

  async close(handle) {
    await new Promise((resolve) => {
      let timer
      const settle = () => {
        clearTimeout(timer)
        resolve()
      }
      // `close()` is synchronous and reports completion with 'end'. The timer covers
      // the case where 'end' never arrives: `SqlEngine.close` awaits every handle in
      // turn, so one silent socket must not wedge the rest.
      timer = setTimeout(settle, 5000)
      timer.unref()
      handle.once('end', settle)
      try {
        handle.close()
      } catch {
        settle()
      }
    })
  },

  async ping(handle) {
    await mssqlDriver.exec(handle, 'SELECT 1', [])
    return true
  },

  async exec(handle, sql, values) {
    // `load.js` caches the module, so this is a Map hit, not a second import.
    const tedious = await loadDriver('tedious', 'SQL Server')
    return await new Promise((resolve, reject) => {
      let columns = []
      let rows = []

      const request = new tedious.Request(String(sql), (error, affected) => {
        if (error) {
          reject(error)
          return
        }
        resolve({
          columns,
          rows,
          // The callback's rowCount is the AFFECTED count, so it is only trusted
          // when no column metadata arrived at all — for a SELECT it is a repeat of
          // the row count at best.
          rowCount: columns.length > 0 ? rows.length : Number(affected ?? 0) || 0,
        })
      })

      request.on('columnMetadata', (metadata) => {
        // A batch emits this once per result set, and the panel shows one grid, so
        // the LAST result set wins — the same choice the pg driver makes.
        columns = (Array.isArray(metadata) ? metadata : []).map((column) => String(column?.colName ?? ''))
        rows = []
      })

      // `useColumnNames: false` makes a row an array of `{ value, metadata }`.
      request.on('row', (row) => {
        rows.push((Array.isArray(row) ? row : []).map((cell) => cell?.value))
      })

      const parameters = values ?? []
      for (let index = 0; index < parameters.length; index += 1) {
        const value = parameters[index]
        request.addParameter(`p${index + 1}`, parameterType(tedious, value), bindValue(value))
      }

      handle.execSql(request)
    })
  },
}

/**
 * The TDS type for one bind value.
 *
 * tedious infers nothing: `addParameter` demands a type, and getting it wrong is a
 * server-side conversion error rather than a client one. That requirement is why the
 * SQL Server dialect names its placeholders (`@p1`) instead of positioning them.
 * Integers past 32 bits go through BigInt rather than Float so that a bigint id
 * keeps every digit on its way into a WHERE clause.
 */
function parameterType(tedious, value) {
  const types = tedious.TYPES
  if (typeof value === 'boolean') {
    return types.Bit
  }
  if (typeof value === 'bigint') {
    return types.BigInt
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return types.Float
    }
    return value >= -2147483648 && value <= 2147483647 ? types.Int : types.BigInt
  }
  if (value instanceof Date) {
    return types.DateTime
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return types.VarBinary
  }
  return types.NVarChar
}

/** tedious binds primitives, Date and Buffer; anything else goes as JSON text. */
function bindValue(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date || Buffer.isBuffer(value)) {
    return value
  }
  // VarBinary insists on a real Buffer and throws 'Invalid buffer.' on a bare
  // Uint8Array, which is what a JSON round-trip of a blob leaves behind.
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return value
}

// ---------------------------------------------------------------- ClickHouse
/** Leading keywords ClickHouse answers with a result set rather than an ack. */
const CLICKHOUSE_READS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXISTS', 'EXPLAIN'])

export const clickhouseDriver = {
  // The database is baked into the client at creation, so a handle per database.
  perDatabaseConnection: true,
  supportsMultipleStatements: false,

  async open(connection, { database }) {
    const createClient = await loadDriverNamed('@clickhouse/client', 'ClickHouse', 'createClient')
    const port = Number(connection.port) || 8123
    // 8443 is ClickHouse Cloud's HTTPS port; treating it as the TLS signal saves the
    // user from having to find the checkbox for the only port it can mean.
    const secure = connection.ssl === true || connection.use_ssl === true || port === 8443
    const scheme = secure ? 'https' : 'http'
    try {
      return createClient({
        url: `${scheme}://${connection.host || '127.0.0.1'}:${port}`,
        username: connection.username || 'default',
        password: connection.password ?? '',
        database: database || connection.database || 'default',
        request_timeout: 60000,
        // Explicitly empty: session settings belong to the statement the user typed,
        // not to a default this plugin quietly applies to every query.
        clickhouse_settings: {},
      })
    } catch (error) {
      // Only a malformed URL or option gets here — `createClient` does no I/O, so a
      // wrong host or password surfaces on the first `ping`/`query` instead.
      throw connectionFailure(connection.db_type, error)
    }
  },

  async close(handle) {
    await handle.close()
  },

  async ping(handle) {
    const result = await handle.ping()
    return result?.success === true
  },

  async exec(handle, sql, values) {
    // The ClickHouse dialect sets `supportsBind = false`, so the engine inlines every
    // literal and this array is empty. A non-empty one means a caller went around the
    // dialect, and silently dropping the values would run the wrong statement.
    if ((values ?? []).length > 0) {
      throw new DbmError(ERR.unsupported, 'ClickHouse 不支持绑定参数')
    }

    const statement = String(sql)
    if (CLICKHOUSE_READS.has(leadingKeyword(statement))) {
      const response = await handle.query({ query: statement, format: 'JSON' })
      const payload = await response.json()
      const columns = (payload?.meta ?? []).map((column) => String(column?.name ?? ''))
      const data = Array.isArray(payload?.data) ? payload.data : []
      const reported = Number(payload?.rows)
      return {
        columns,
        // JSON format hands back one object per row, keyed by column name.
        rows: data.map((row) => columns.map((name) => row?.[name])),
        rowCount: Number.isFinite(reported) ? reported : data.length,
      }
    }

    // INSERT/ALTER/CREATE/DROP/OPTIMIZE go through `command`, which reads no body.
    await handle.command({ query: statement })
    // ClickHouse's HTTP interface reports no affected-row count for a write, and
    // inventing one would make the panel's "N 行受影响" a lie.
    return { columns: [], rows: [], rowCount: 0 }
  },
}

// -------------------------------------------------------------------- Oracle
export const oracleDriver = {
  // One handle: what the panel calls a database is a schema here, and the dialect
  // switches it with a session statement rather than a new connection.
  perDatabaseConnection: false,
  supportsMultipleStatements: false,

  async open(connection) {
    const oracledb = await loadDriver('oracledb', 'Oracle')
    // Arrays, like every other driver in this directory hands back.
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY
    // Without this a CLOB column arrives as a readable stream object: the grid would
    // render `[object Object]`, and nothing downstream is async enough to drain it.
    oracledb.fetchAsString = [oracledb.CLOB]

    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port) || 1521
    // The panel's "database" field is Oracle's SERVICE name; FREEPDB1 is the default
    // pluggable database of Oracle Free, which is what a developer usually has.
    const serviceName = connection.database || 'FREEPDB1'
    try {
      // oracledb 6+ defaults to Thin mode: pure JS, no Oracle Instant Client to
      // install. That is the only reason Oracle can be an npm optional dependency
      // here instead of a page of manual setup instructions.
      return await oracledb.getConnection({
        user: connection.username || 'system',
        password: connection.password ?? '',
        connectString: `${host}:${port}/${serviceName}`,
      })
    } catch (error) {
      throw connectionFailure(connection.db_type, error)
    }
  },

  async close(handle) {
    await handle.close()
  },

  async ping(handle) {
    await oracleDriver.exec(handle, 'SELECT 1 FROM DUAL', [])
    return true
  },

  async exec(handle, sql, values) {
    // Oracle rejects a trailing semicolon: it is SQL*Plus's statement terminator, not
    // part of the statement, and callers that compose DDL leave it behind.
    const statement = String(sql).replace(/;\s*$/, '')
    // autoCommit per statement, because the panel has no transaction UI — an INSERT
    // the user ran must be visible to the next SELECT.
    const result = await handle.execute(statement, values ?? [], { autoCommit: true })
    const columns = (result?.metaData ?? []).map((column) => String(column?.name ?? ''))
    const rows = Array.isArray(result?.rows) ? result.rows : []
    return {
      columns,
      rows,
      // `rowsAffected` is undefined for a SELECT, so it only decides the count when
      // there was no result set — as in the pg driver.
      rowCount: columns.length > 0 ? rows.length : Number(result?.rowsAffected ?? 0) || 0,
    }
  },
}

// ----------------------------------------------------------------- Snowflake
export const snowflakeDriver = {
  // One session; `USE DATABASE` switches it, so the dialect does that rather than
  // paying for a second login per database.
  perDatabaseConnection: false,
  supportsMultipleStatements: false,

  async open(connection) {
    const snowflake = await loadDriver('snowflake-sdk', 'Snowflake')
    let client
    try {
      // `createConnection` is inside the try because unlike pg's constructor it
      // validates eagerly and throws on a bad account — a user error that deserves
      // the same localized message as a refused login.
      //
      // `host` carries the ACCOUNT IDENTIFIER (`ab12345.eu-central-1`), not a
      // hostname: the SDK appends `.snowflakecomputing.com` itself, so a full
      // hostname pasted in here fails with a DNS error that names the wrong problem.
      client = snowflake.createConnection({
        account: connection.host || '',
        username: connection.username || '',
        password: connection.password ?? '',
        database: connection.database || undefined,
        // Snowflake resolves unqualified names against a schema; PUBLIC is the one
        // every database is created with.
        schema: 'PUBLIC',
        application: 'DSH-OTOOLS-DBM',
      })
      await new Promise((resolve, reject) => {
        client.connect((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    } catch (error) {
      throw connectionFailure(connection.db_type, error)
    }

    // Same reasoning as tedious: a lost session must not become an uncaught
    // exception. Older SDK builds are not EventEmitters, hence the guard.
    if (typeof client.on === 'function') {
      client.on('error', () => {})
    }
    return client
  },

  async close(handle) {
    await new Promise((resolve, reject) => {
      // `destroy` is the SDK's disconnect, and it is callback-only. Rejecting on its
      // error costs nothing: `SqlEngine.close` treats a failed close as "already
      // gone" and moves on.
      handle.destroy((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  },

  async ping(handle) {
    await snowflakeDriver.exec(handle, 'SELECT 1', [])
    return true
  },

  async exec(handle, sql, values) {
    return await new Promise((resolve, reject) => {
      handle.execute({
        sqlText: String(sql),
        binds: values ?? [],
        complete(error, statement, rows) {
          if (error) {
            reject(error)
            return
          }
          const columns = (statement?.getColumns?.() ?? []).map((column) => String(column?.getName?.() ?? ''))
          const list = Array.isArray(rows) ? rows : []
          const affected = statement?.getNumRowsAffected?.()
          resolve({
            columns,
            // Rows come back as objects keyed by column name; the grid wants arrays
            // in column order.
            rows: list.map((row) => columns.map((name) => row?.[name])),
            rowCount: columns.length > 0 ? list.length : Number(affected ?? list.length) || 0,
          })
        },
      })
    })
  },
}
