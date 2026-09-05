/**
 * Which engine object serves which connection, and who holds it open.
 *
 * One engine instance per saved connection, cached until the user closes the
 * connection or edits it. That is what makes the tree feel instant: expanding a
 * database, reading a table's structure and paging its rows all reuse the same
 * handle instead of paying a TCP + auth round trip each.
 *
 * The SSH tunnel is resolved here, before the engine is built, and the engine is
 * handed a connection whose host/port point at the loopback end of the tunnel — so
 * no driver or dialect in this plugin has any idea tunnelling exists.
 *
 * @module dsh-plugin-otools-dbm/host/connections
 */
import { DbmError, ERR, requireDbType } from '../shared/protocol.js'

import { mysqlDriver, postgresDriver, sqliteDriver } from './engines/drivers/sql.js'
import { clickhouseDriver, mssqlDriver, oracleDriver, snowflakeDriver } from './engines/drivers/vendor.js'
import { ClickHouseDialect } from './engines/dialects/clickhouse.js'
import { MariadbDialect, MysqlDialect } from './engines/dialects/mysql.js'
import { MssqlDialect } from './engines/dialects/mssql.js'
import { DamengDialect, OracleDialect } from './engines/dialects/oracle.js'
import { KingbaseDialect, PostgresDialect } from './engines/dialects/postgres.js'
import { SnowflakeDialect } from './engines/dialects/snowflake.js'
import { SqliteDialect } from './engines/dialects/sqlite.js'
import { createElasticsearchEngine } from './engines/elasticsearch.js'
import { createKafkaEngine } from './engines/kafka.js'
import { createMongoEngine } from './engines/mongodb.js'
import { createRedisEngine } from './engines/redis.js'
import { SqlEngine } from './engines/sql-engine.js'
import { closeTunnel, resolveTunnel } from './tunnel.js'

/** dbType → { dialect, driver } for every SQL engine. */
const SQL_ENGINES = {
  mysql: { Dialect: MysqlDialect, driver: mysqlDriver },
  mariadb: { Dialect: MariadbDialect, driver: mysqlDriver },
  postgresql: { Dialect: PostgresDialect, driver: postgresDriver },
  kingbasees: { Dialect: KingbaseDialect, driver: postgresDriver },
  sqlite: { Dialect: SqliteDialect, driver: sqliteDriver },
  sqlserver: { Dialect: MssqlDialect, driver: mssqlDriver },
  oracle: { Dialect: OracleDialect, driver: oracleDriver },
  dameng: { Dialect: DamengDialect, driver: oracleDriver },
  clickhouse: { Dialect: ClickHouseDialect, driver: clickhouseDriver },
  snowflake: { Dialect: SnowflakeDialect, driver: snowflakeDriver },
}

/** dbType → factory, for the engines that are not SQL at all. */
const SPECIAL_ENGINES = {
  redis: createRedisEngine,
  mongodb: createMongoEngine,
  elasticsearch: createElasticsearchEngine,
  kafka: createKafkaEngine,
}

/**
 * Build an engine for one connection record.
 *
 * Note on 达梦 (Dameng): it speaks Oracle's dialect and its own `dmdb` driver is a
 * native module, so this port drives it through `oracledb`. That works for the
 * Oracle-compatible surface the panel uses and fails clearly for the rest — which
 * is a better trade than a dependency that cannot install on half the machines.
 */
export async function createEngine(connection) {
  const dbType = requireDbType(connection?.db_type)

  const tunnel = await resolveTunnel(connection)
  const resolved = tunnel === undefined ? connection : { ...connection, host: tunnel.host, port: tunnel.port }

  const special = SPECIAL_ENGINES[dbType]
  if (special !== undefined) {
    return special(resolved)
  }

  const sql = SQL_ENGINES[dbType]
  if (sql === undefined) {
    throw new DbmError(ERR.unsupported, `不支持的数据库类型: ${dbType}`)
  }
  return new SqlEngine({ connection: resolved, dialect: new sql.Dialect(), driver: sql.driver })
}

export class ConnectionManager {
  /** @param options.store - the ConnectionStore, for looking records up by id. */
  constructor({ store }) {
    this.store = store
    /** connection id → engine */
    this.engines = new Map()
    /** connection id → in-flight open, so two clicks do not open two connections */
    this.opening = new Map()
  }

  /** Whether the panel should draw this connection as connected. */
  isActive(id) {
    return this.engines.has(String(id ?? ''))
  }

  /** Open (or reuse) the engine for a saved connection. */
  async engineFor(id) {
    const key = String(id ?? '')
    const cached = this.engines.get(key)
    if (cached !== undefined) {
      return cached
    }
    const pending = this.opening.get(key)
    if (pending !== undefined) {
      return pending
    }

    const promise = (async () => {
      const connection = await this.store.require(key)
      const engine = await createEngine(connection)
      this.engines.set(key, engine)
      this.opening.delete(key)
      return engine
    })()
    this.opening.set(key, promise)
    try {
      return await promise
    } catch (error) {
      this.opening.delete(key)
      throw error
    }
  }

  /**
   * Open a connection the panel has NOT saved yet — the "test connection" button
   * and the first connect from the edit form both send the whole record.
   */
  async openTransient(connection) {
    const engine = await createEngine(connection)
    try {
      const alive = await engine.ping()
      if (!alive) {
        throw new DbmError(ERR.internal, '连接测试失败：数据库没有响应')
      }
      return true
    } finally {
      await engine.close().catch(() => {})
    }
  }

  /** Open and cache, as the tree's "connect" does. */
  async open(connection) {
    const key = String(connection?.id ?? '')
    if (key.length === 0) {
      return this.openTransient(connection)
    }
    await this.close(key)
    const engine = await createEngine(connection)
    const alive = await engine.ping()
    if (!alive) {
      await engine.close().catch(() => {})
      throw new DbmError(ERR.internal, '连接失败：数据库没有响应')
    }
    this.engines.set(key, engine)
    return true
  }

  /** Close one connection and drop its tunnel. Always reports success. */
  async close(id) {
    const key = String(id ?? '')
    const engine = this.engines.get(key)
    this.engines.delete(key)
    if (engine !== undefined) {
      await engine.close().catch(() => {})
    }
    await closeTunnel(key)
    return true
  }

  /** Close everything, for plugin teardown. */
  async closeAll() {
    const ids = Array.from(this.engines.keys())
    await Promise.all(ids.map((id) => this.close(id)))
  }

  /** Run `fn` with the engine for `id`, opening it if needed. */
  async with(id, fn) {
    const engine = await this.engineFor(id)
    return fn(engine)
  }
}
