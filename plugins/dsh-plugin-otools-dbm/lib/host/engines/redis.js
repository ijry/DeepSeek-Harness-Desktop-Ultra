/**
 * Redis, presented to the panel as one more database.
 *
 * The mapping is the reference's: a logical DB (`db0`…`db15`) is a "database", a key
 * is a "table", and one key's contents are that table's rows. Three Redis facts
 * shape the whole file and will bite anyone editing it:
 *
 * 1. SCAN, never KEYS. `KEYS *` walks the entire keyspace inside a single command
 *    and blocks every other client while it does, which on a production instance is
 *    an outage. Everything here pages with SCAN, and that is also why the tree gets
 *    a `next_cursor` rather than a total: SCAN cannot count.
 * 2. One client per logical DB. `SELECT` is connection state, so two concurrent
 *    panel calls sharing one client would answer from whichever database selected
 *    last. The Map below costs one socket per db the user actually opens.
 * 3. Saving a hash/list/set/zset REWRITES the key. The editor sends the whole value,
 *    so the write is `DEL` + rebuild — and this port puts both inside one `MULTI`
 *    (the reference issued them separately, where a concurrent reader could catch
 *    the key missing or half-built).
 *
 * @module dsh-plugin-otools-dbm/host/engines/redis
 */
import {
  boundedInt,
  classifyConnectionError,
  connectionErrorMessage,
  DbmError,
  ERR,
} from '../../shared/protocol.js'
import { previewOf } from '../sql/split.js'

import { unsupported } from './contract.js'
import { loadDriver } from './drivers/load.js'
import { elapsedSince, normalizeValue, queryResult } from './result.js'
import { messageOf } from './sql-engine.js'

/** Keys one SCAN round trip asks for — a hint to the server, not a limit. */
const SCAN_COUNT = 500

/** Keys `listTables` collects before it stops scanning. */
const MAX_TABLE_KEYS = 2000

/** Rows one key's preview shows: enough to see the shape, cheap to read. */
const MAX_PREVIEW_ROWS = 200

/** SCAN round trips one tree page may cost before it hands the cursor back. */
const MAX_SCAN_ROUNDS = 200

/** Logical DBs to assume when the server refuses `CONFIG GET databases`. */
const DEFAULT_DATABASE_COUNT = 16

/** Tree page size the panel may ask for, and the default when it asks for none. */
const TREE_PAGE = { fallback: 100, min: 20, max: 2000 }

/** The value types the panel's editor can write. */
const WRITABLE_TYPES = ['string', 'hash', 'list', 'set', 'zset']

/** The "container is empty" error per type, in codes the panel already localizes. */
const EMPTY_ERRORS = {
  hash: ['DBM_REDIS_HASH_EMPTY', 'Hash 至少需要一个 field'],
  list: ['DBM_REDIS_LIST_EMPTY', 'List 至少需要一条记录'],
  set: ['DBM_REDIS_SET_EMPTY', 'Set 至少需要一个成员'],
  zset: ['DBM_REDIS_ZSET_EMPTY', 'ZSet 至少需要一个成员'],
}

export class RedisEngine {
  /** @param connection - the stored DbConnection record. */
  constructor(connection) {
    this.connection = connection
    this.kind = 'redis'
    this.dbType = 'redis'
    // Logical DB index → ioredis client. See fact 2 in the header: SELECT is
    // per-connection state, so one shared client would let two concurrent panel
    // calls read each other's database.
    this.clients = new Map()
    this.databaseCount = null
    this.closed = false
  }

  // ---------------------------------------------------------------- connection
  /**
   * The logical DB index behind a panel-supplied name.
   *
   * The tree sends `db3`, some callers send `3`, and the stored connection's
   * `database` field can be either — one helper so all three agree.
   */
  resolveDbIndex(name) {
    const text = String(name ?? '').trim()
    if (text.length === 0) {
      return this.defaultDbIndex()
    }
    const match = /^(?:db)?(\d+)$/i.exec(text)
    if (match === null) {
      throw new DbmError(ERR.invalidInput, `无法识别的 Redis 数据库: ${text}`)
    }
    return Number.parseInt(match[1], 10)
  }

  /** The index a call runs against when it names no database. */
  defaultDbIndex() {
    const match = /^(?:db)?(\d+)$/i.exec(String(this.connection?.database ?? '').trim())
    return match === null ? 0 : Number.parseInt(match[1], 10)
  }

  /** Open (or reuse) the client bound to one logical DB. */
  async clientFor(database) {
    if (this.closed) {
      throw new DbmError(ERR.connectionClosed, '连接已关闭，请重新连接')
    }
    const index = this.resolveDbIndex(database)
    const existing = this.clients.get(index)
    if (existing !== undefined) {
      return existing
    }
    const client = await this.openClient(index)
    this.clients.set(index, client)
    return client
  }

  /** A fresh ioredis client already switched to `index`. */
  async openClient(index) {
    const Redis = await loadDriver('ioredis', 'Redis')
    const connection = this.connection ?? {}
    const username = String(connection.username ?? '').trim()
    const options = {
      host: connection.host || '127.0.0.1',
      port: Number(connection.port) || 6379,
      password: connection.password ? String(connection.password) : undefined,
      db: index,
      // Connect explicitly below, so a bad host fails this call instead of whatever
      // command the panel happens to send first.
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 15000,
      enableReadyCheck: true,
    }
    if (username.length > 0) {
      // ACL usernames are Redis 6+; sending one to an older server is an error, so it
      // only goes on the options when the user filled it in.
      options.username = username
    }
    if (connection.ssl === true) {
      // ioredis switches to TLS on the presence of the object, not on `true`; `{}`
      // means "TLS with the platform defaults".
      options.tls = {}
    }

    const client = new Redis(options)
    // ioredis emits 'error' on a dropped socket; without a listener that is an
    // uncaught exception that would take the whole dsh process down.
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      client.disconnect()
      throw connectionFailure(error)
    }
    return client
  }

  /** Liveness probe. Never throws. */
  async ping() {
    if (this.closed) {
      return false
    }
    try {
      const client = await this.clientFor(undefined)
      return String(await client.ping()).toUpperCase() === 'PONG'
    } catch {
      return false
    }
  }

  /** Quit every cached client. Idempotent. */
  async close() {
    this.closed = true
    const clients = Array.from(this.clients.values())
    this.clients.clear()
    for (const client of clients) {
      try {
        await client.quit()
      } catch {
        // A connection that is already gone is the outcome we wanted.
      }
      try {
        // `quit` waits for a reply the server may never send; `disconnect` is the
        // unconditional teardown, and a no-op on an already-closed socket.
        client.disconnect()
      } catch {
        // Nothing left to release.
      }
    }
  }

  // -------------------------------------------------------------- introspection
  /**
   * The logical DBs, as the tree's "databases".
   *
   * `CONFIG GET databases` is the only way to learn how many there are, and managed
   * Redis usually has CONFIG disabled — hence the 16 the server itself defaults to.
   */
  async listDatabases() {
    const count = await this.databaseCountOf()
    return Array.from({ length: count }, (_, index) => `db${index}`)
  }

  /** How many logical DBs this server has, asked once. */
  async databaseCountOf() {
    if (this.databaseCount !== null) {
      return this.databaseCount
    }
    let count = DEFAULT_DATABASE_COUNT
    try {
      const client = await this.clientFor(undefined)
      // CONFIG GET answers as a flat [name, value] array.
      const reply = await client.call('CONFIG', 'GET', 'databases')
      const parsed = Number.parseInt(String((Array.isArray(reply) ? reply[1] : '') ?? ''), 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        count = Math.min(parsed, 256)
      }
    } catch {
      // CONFIG is disabled on most managed Redis; the default stands.
    }
    this.databaseCount = count
    return count
  }

  /** Redis has no schemas, views or routines. */
  async listSchemas() {
    return []
  }

  async listViews() {
    return []
  }

  async listProcedures() {
    return []
  }

  async viewDefinition() {
    return ''
  }

  async procedureDefinition() {
    return ''
  }

  /**
   * The keys of one logical DB, as the tree's flat "table" list.
   *
   * Sorted and capped, because this feeds the object list and the export dialogs,
   * not the key browser (that is `treeChildren`). KEYS is never used here — see fact
   * 1 in the header — so a keyspace larger than the cap is simply cut off.
   */
  async listTables(database) {
    const client = await this.clientFor(database)
    const keys = new Set()
    let cursor = '0'
    do {
      const [next, batch] = await client.scan(cursor, 'COUNT', SCAN_COUNT)
      cursor = String(next)
      for (const key of batch) {
        // SCAN may hand the same key back twice across iterations; the Set is what
        // makes the list stable.
        keys.add(String(key))
      }
    } while (cursor !== '0' && keys.size < MAX_TABLE_KEYS)
    return Array.from(keys).sort().slice(0, MAX_TABLE_KEYS)
  }

  // ---------------------------------------------------------------- key browser
  /**
   * One page of the key tree.
   *
   * Browse mode groups keys by their next `:` segment, which is how a Redis keyspace
   * pretends to have folders. Search mode drops the MATCH and filters every key by
   * all keywords, because `*cart*` over several segments is not something the
   * panel's keyword box can express as one glob.
   *
   * A page may overshoot `limit`: SCAN returns a whole batch at a time and its
   * cursor cannot point into the middle of one, so the batch that fills the page is
   * kept whole rather than dropping keys no later page would ever scan again.
   */
  async treeChildren({ database, prefix, cursor, limit, keywords } = {}) {
    const client = await this.clientFor(database)
    const base = String(prefix ?? '')
    const words = (Array.isArray(keywords) ? keywords : [])
      .map((word) => String(word ?? '').trim().toLowerCase())
      .filter((word) => word.length > 0)
    const pageSize = boundedInt(limit, TREE_PAGE.fallback, TREE_PAGE.min, TREE_PAGE.max)

    const nodes = []
    const seen = new Set()
    let position = String(cursor ?? '0')
    if (position.length === 0) {
      position = '0'
    }
    let rounds = 0

    do {
      const args = words.length > 0
        ? [position, 'COUNT', SCAN_COUNT]
        : [position, 'MATCH', `${globEscape(base)}*`, 'COUNT', SCAN_COUNT]
      const [next, batch] = await client.scan(...args)
      position = String(next)
      rounds += 1

      for (const raw of batch) {
        const key = String(raw)
        const node = words.length > 0 ? searchNode(key, words) : browseNode(key, base)
        if (node === null || seen.has(node.full_path)) {
          continue
        }
        seen.add(node.full_path)
        nodes.push(node)
      }
      // A keyword search can match nothing for a very long time on a big keyspace;
      // bounding the round trips keeps one request short and leaves the panel a
      // cursor to continue from.
    } while (position !== '0' && nodes.length < pageSize && rounds < MAX_SCAN_ROUNDS)

    return { nodes, next_cursor: position === '0' ? null : position }
  }

  /** Type, TTL and a bounded preview of one key. */
  async keyInfo(database, key) {
    const client = await this.clientFor(database)
    const name = requireKeyName(key)
    const type = String(await client.type(name))
    const ttl = Number(await client.ttl(name))
    const preview = await this.previewOfKey(client, name, type)
    return {
      key: name,
      database: `db${this.resolveDbIndex(database)}`,
      value_type: type,
      ttl_seconds: Number.isFinite(ttl) ? ttl : -2,
      ttl_label: ttlLabel(ttl),
      columns: preview.columns,
      rows: preview.rows.map((row) => row.map((cell) => normalizeValue(cell))),
    }
  }

  /** `columns`/`rows` for one key, per type — the grid's whole view of a key. */
  async previewOfKey(client, key, type) {
    switch (type) {
      case 'string': {
        return { columns: ['value'], rows: [[await client.get(key)]] }
      }
      case 'hash': {
        // Uncapped on purpose: HGETALL has no range form, and HSCAN would page a
        // preview the panel has no pager for. A hash with a million fields hurts.
        const entries = Object.entries(await client.hgetall(key))
        return { columns: ['field', 'value'], rows: entries.map(([field, value]) => [field, value]) }
      }
      case 'list': {
        const items = await client.lrange(key, 0, MAX_PREVIEW_ROWS - 1)
        return { columns: ['index', 'value'], rows: items.map((value, index) => [index, value]) }
      }
      case 'set': {
        const members = await client.smembers(key)
        return { columns: ['value'], rows: members.slice(0, MAX_PREVIEW_ROWS).map((value) => [value]) }
      }
      case 'zset': {
        const flat = await client.zrange(key, 0, MAX_PREVIEW_ROWS - 1, 'WITHSCORES')
        const rows = []
        for (let index = 0; index + 1 < flat.length; index += 2) {
          rows.push([flat[index], flat[index + 1]])
        }
        return { columns: ['member', 'score'], rows }
      }
      case 'stream': {
        const entries = await client.xrange(key, '-', '+', 'COUNT', MAX_PREVIEW_ROWS)
        return {
          columns: ['id', 'fields'],
          rows: entries.map((entry) => [entry?.[0], flattenStreamFields(entry?.[1])]),
        }
      }
      default:
        // 'none' (the key is gone) plus the types the panel cannot render.
        return { columns: ['message'], rows: [['当前键没有可预览的内容']] }
    }
  }

  // ----------------------------------------------------------------- key writes
  /**
   * Write one key and read it back.
   *
   * The read-back is not a courtesy: the editor renders from it, and the effective
   * TTL is only knowable after the write.
   */
  async setKey(database, mutation) {
    const client = await this.clientFor(database)
    const record = mutationOf(mutation, '')
    const queue = client.multi()
    appendWrite(queue, record)
    await execMulti(queue, [record.key])
    return this.keyInfo(database, record.key)
  }

  async deleteKey(database, key) {
    const client = await this.clientFor(database)
    await client.del(requireKeyName(key))
  }

  /**
   * The grid's save path.
   *
   * Every row is a whole key, not a cell: the panel's `RedisKeyMutation`
   * (`{key_name, value_type, ttl_seconds, entries}`), with `key`/`type`/`ttl`
   * accepted as aliases because TableContent's conflict retry looks a row's key up
   * under both `key` and `key_name`. A row that names no key falls back to the
   * opened key (`table`), which is how a single-key grid tab saves.
   *
   * `validate_only` is the panel's pre-check: validate everything, write nothing.
   * `redis_atomic_batch` puts the whole batch in one MULTI, and `redis_watch_keys`
   * WATCHes every touched key so a concurrent writer aborts it.
   */
  async saveRows({ database, table, changes } = {}) {
    const client = await this.clientFor(database)
    const request = changes ?? {}
    const fallbackKey = String(table ?? '').trim()

    const writes = []
    for (const row of asRows(request.added)) {
      writes.push({ mutation: mutationOf(row, fallbackKey), kind: 'inserted', drop: null })
    }
    for (const change of asRows(request.modified)) {
      const mutation = mutationOf(change?.current ?? change, fallbackKey)
      // A row whose key changed is a delete plus a write; without the DEL the old
      // key would linger as a duplicate of the new one.
      const previous = keyNameOf(change?.original, fallbackKey)
      const drop = previous.length > 0 && previous !== mutation.key ? previous : null
      writes.push({ mutation, kind: 'updated', drop })
    }
    const drops = asRows(request.deleted).map((row) => requireKeyName(keyNameOf(row, fallbackKey)))

    const counts = {
      inserted: writes.filter((item) => item.kind === 'inserted').length,
      updated: writes.filter((item) => item.kind === 'updated').length,
      deleted: drops.length,
    }
    if (request.validate_only === true) {
      // Everything above already validated; answer with the counts the real save
      // would report and touch nothing.
      return counts
    }

    const touched = dedupe([
      ...writes.flatMap((item) => (item.drop === null ? [item.mutation.key] : [item.drop, item.mutation.key])),
      ...drops,
    ])
    if (touched.length === 0) {
      return counts
    }

    if (request.redis_atomic_batch === true) {
      if (request.redis_watch_keys === true) {
        // WATCH is connection state and this client is shared by every concurrent
        // call on this logical DB, so another save's EXEC can clear our watch: what
        // this buys is "we notice an outside writer", not a lock.
        await client.watch(...touched)
      }
      const queue = client.multi()
      for (const item of writes) {
        if (item.drop !== null) {
          queue.del(item.drop)
        }
        appendWrite(queue, item.mutation)
      }
      for (const key of drops) {
        queue.del(key)
      }
      await execMulti(queue, touched)
      return counts
    }

    // Not a batch, but every key still gets its own MULTI, so a failing row can
    // never leave one key half-written.
    for (const item of writes) {
      const queue = client.multi()
      if (item.drop !== null) {
        queue.del(item.drop)
      }
      appendWrite(queue, item.mutation)
      await execMulti(queue, [item.mutation.key])
    }
    if (drops.length > 0) {
      await client.del(...drops)
    }
    return counts
  }

  // ------------------------------------------------------------------ table data
  /** One key in the grid: the key's own preview, in QueryResult clothing. */
  async tableData({ database, table } = {}) {
    const started = process.hrtime.bigint()
    const info = await this.keyInfo(database, table)
    return queryResult({
      columns: info.columns,
      rows: info.rows,
      rowCount: info.rows.length,
      executionTime: elapsedSince(started),
    })
  }

  /**
   * A key described as a table.
   *
   * Redis has no schema, so the columns are the preview's columns and nothing more:
   * every one is a nullable string, there is no key and no index. The value type goes
   * in the comment, which is the only place the struct tab can show it.
   */
  async tableStruct(database, table) {
    const info = await this.keyInfo(database, table)
    return {
      table_name: info.key,
      columns: info.columns.map((name) => ({
        name,
        data_type: 'string',
        is_nullable: true,
        default_value: null,
        is_primary_key: false,
        character_maximum_length: null,
        column_comment: '',
      })),
      primary_keys: [],
      foreign_keys: [],
      indexes: [],
      comment: `Redis ${info.value_type} 键，TTL ${info.ttl_label}`,
    }
  }

  /** Async so the route's `await` rejects rather than throwing under it. */
  async createTableStatement() {
    unsupported('Redis', '建表语句')
  }

  // --------------------------------------------------------------------- console
  /**
   * The workbench, as a Redis command console.
   *
   * One command per line, `#` comments and blank lines skipped, quotes respected so
   * `SET greeting "hello world"` is three tokens. The result is one row per command,
   * which is why a failure is a row too: the console is a transcript, so unlike the
   * SQL engine this keeps going unless the caller asks for `stopOnError: true`.
   */
  async executeScript(script, options = {}) {
    const client = await this.clientFor(options.database)
    const commands = splitCommands(script)
    if (commands.length === 0) {
      throw new DbmError(ERR.invalidInput, '没有可执行的 Redis 命令')
    }

    const started = process.hrtime.bigint()
    const rows = []
    const statements = []
    let failedIndex = null
    let batchError = null

    for (const [index, command] of commands.entries()) {
      const record = {
        statement_index: index,
        sql: command.text,
        sql_preview: previewOf(command.text),
        columns: ['command', 'result'],
        rows: [],
        row_count: null,
        execution_time: null,
        success: true,
        error_message: null,
      }
      const mark = process.hrtime.bigint()
      try {
        const cell = flattenReply(await client.call(command.name, ...command.args))
        rows.push([command.text, cell])
        record.rows = [[command.text, cell]]
        record.row_count = 1
      } catch (error) {
        const message = messageOf(error)
        rows.push([command.text, message])
        record.rows = [[command.text, message]]
        record.row_count = 0
        record.success = false
        record.error_message = message
        if (failedIndex === null) {
          failedIndex = index
          batchError = `第 ${index + 1} 条命令执行失败: ${message}`
        }
      }
      record.execution_time = Math.round(elapsedSince(mark))
      statements.push(record)
      if (!record.success && options.stopOnError === true) {
        break
      }
    }

    return {
      ...queryResult({
        columns: ['command', 'result'],
        rows,
        rowCount: rows.length,
        executionTime: elapsedSince(started),
      }),
      statements,
      has_errors: failedIndex !== null,
      batch_error_message: batchError,
      failed_statement_index: failedIndex,
    }
  }

  /** The workbench's single-statement entry point is the same console. */
  async run(sql, options = {}) {
    return this.executeScript(sql, options)
  }

  /**
   * Per-DB key counts from `INFO`.
   *
   * `used_memory` is the whole instance — Redis reports no per-DB memory — so every
   * row repeats the instance total rather than pretending to a split.
   */
  async stats() {
    const client = await this.clientFor(undefined)
    const info = String(await client.info())
    const databases = []
    let usedMemory = 0

    for (const line of info.split(/\r?\n/)) {
      const memory = /^used_memory:(\d+)/.exec(line)
      if (memory !== null) {
        usedMemory = Number(memory[1])
        continue
      }
      // `db0:keys=12,expires=1,avg_ttl=0` — only the DBs that hold something appear.
      const keyspace = /^db(\d+):keys=(\d+)/.exec(line)
      if (keyspace !== null) {
        const keys = Number(keyspace[2])
        databases.push({
          name: `db${keyspace[1]}`,
          table_count: keys,
          row_count: keys,
          data_size: 0,
          index_size: 0,
        })
      }
    }

    return { databases: databases.map((entry) => ({ ...entry, data_size: usedMemory })) }
  }
}

/** @param connection - the stored DbConnection record. */
export function createRedisEngine(connection) {
  return new RedisEngine(connection)
}

/** An error in the `[CODE] detail` form the panel's humanizer localizes. */
function redisError(code, detail) {
  return new DbmError(code, `[${code}] ${detail}`)
}

/** Wrap a connect failure in the code the panel localizes, as drivers/sql.js does. */
function connectionFailure(error) {
  const kind = classifyConnectionError(error)
  const detail = String(error?.message ?? error ?? '')
  return new DbmError('redis_conn', connectionErrorMessage('redis', kind, detail), { cause: error })
}

/** A non-empty key name, trimmed. */
function requireKeyName(value) {
  const key = String(value ?? '').trim()
  if (key.length === 0) {
    throw redisError('DBM_REDIS_KEY_EMPTY', 'Redis 键名不能为空')
  }
  return key
}

/** The key a row names, or `fallback` (the opened key) when it names none. */
function keyNameOf(row, fallback) {
  const named = String(row?.key_name ?? row?.key ?? '').trim()
  return named.length > 0 ? named : String(fallback ?? '').trim()
}

const asRows = (value) => (Array.isArray(value) ? value : [])

const dedupe = (values) => Array.from(new Set(values))

/** Escape glob metacharacters so a prefix containing `*` or `[` still matches. */
function globEscape(text) {
  return String(text).replace(/([\\*?[\]])/g, '\\$1')
}

/**
 * One browse-mode node for a key.
 *
 * The remainder after `prefix` splits on its FIRST `:`: a non-empty head with a
 * non-empty tail is a folder (`user:1:name` under no prefix yields `user:`), anything
 * else is a leaf.
 */
function browseNode(key, prefix) {
  if (prefix.length > 0 && !key.startsWith(prefix)) {
    return null
  }
  const remainder = key.slice(prefix.length)
  const separator = remainder.indexOf(':')
  const head = separator === -1 ? '' : remainder.slice(0, separator)
  const tail = separator === -1 ? '' : remainder.slice(separator + 1)
  if (head.length > 0 && tail.length > 0) {
    return { node_type: 'prefix', label: head, full_path: `${prefix}${head}:` }
  }
  // A key equal to the prefix itself would otherwise render as a blank row.
  return { node_type: 'key', label: remainder.length > 0 ? remainder : key, full_path: key }
}

/** One search-mode node: every keyword must appear in the key, case-insensitively. */
function searchNode(key, words) {
  const haystack = key.toLowerCase()
  return words.every((word) => haystack.includes(word))
    ? { node_type: 'key', label: key, full_path: key }
    : null
}

/** `-2` / `-1` are Redis's "no key" / "no expiry"; the rest is a rounded duration. */
function ttlLabel(ttl) {
  const seconds = Number(ttl)
  if (!Number.isFinite(seconds) || seconds === -2) {
    return '键不存在'
  }
  if (seconds === -1) {
    return '永久'
  }
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  if (seconds < 3600) {
    return `${(seconds / 60).toFixed(1)} 分钟`
  }
  if (seconds < 86400) {
    return `${(seconds / 3600).toFixed(1)} 小时`
  }
  return `${(seconds / 86400).toFixed(1)} 天`
}

/** A stream entry's flat field array as `"f=v, f=v"`. */
function flattenStreamFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  const pairs = []
  for (let index = 0; index < list.length; index += 2) {
    pairs.push(`${String(list[index])}=${String(list[index + 1] ?? '')}`)
  }
  return pairs.join(', ')
}

/** One console reply as a single cell: arrays joined, everything else normalized. */
function flattenReply(value) {
  if (Array.isArray(value)) {
    return value.map((item) => flattenReply(item)).join(', ')
  }
  return normalizeValue(value)
}

/** Validate one panel row into `{key, type, ttl, entries}`, or throw its own error. */
function mutationOf(row, fallbackKey) {
  const key = requireKeyName(keyNameOf(row, fallbackKey))
  const type = String(row?.value_type ?? row?.type ?? '').trim().toLowerCase()
  if (type.length === 0) {
    throw redisError(
      'DBM_REDIS_VALUE_TYPE_MISSING',
      'Redis 记录缺少 value_type 字段（支持 string/hash/list/set/zset）',
    )
  }
  if (!WRITABLE_TYPES.includes(type)) {
    throw redisError('DBM_REDIS_TYPE_UNSUPPORTED', `Redis 类型 ${type} 暂不支持通过界面写入`)
  }
  return { key, type, ttl: ttlOf(row), entries: entriesOf(row, type) }
}

/** Seconds, where 0 (or absent) means "no expiry". */
function ttlOf(row) {
  const raw = row?.ttl_seconds ?? row?.ttl ?? null
  if (raw === null || raw === undefined || String(raw).trim().length === 0) {
    return 0
  }
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw redisError('DBM_REDIS_TTL_INVALID', 'Redis ttl_seconds 不能小于 0')
  }
  return Math.trunc(seconds)
}

/**
 * The entries of one mutation.
 *
 * A string key is one value, so a row carrying only `value` is complete on its own.
 * Containers are only ever rewritten wholesale (fact 3 in the header), so a row that
 * did not spell out every entry is refused rather than silently truncating the key
 * to the one entry it happened to mention.
 */
function entriesOf(row, type) {
  const supplied = Array.isArray(row?.entries) ? row.entries : null

  if (type === 'string') {
    const value = supplied === null ? row?.value : supplied[0]?.value
    return [{ value: String(value ?? '') }]
  }

  const entries = supplied ?? []
  if (entries.length === 0) {
    const [code, detail] = EMPTY_ERRORS[type]
    throw redisError(code, detail)
  }
  if (type === 'hash') {
    return entries.map((entry) => {
      const field = String(entry?.field ?? '')
      if (field.trim().length === 0) {
        throw redisError('DBM_REDIS_HASH_FIELD_EMPTY', 'Hash field 不能为空')
      }
      return { field, value: String(entry?.value ?? '') }
    })
  }
  if (type === 'zset') {
    return entries.map((entry) => ({ value: String(entry?.value ?? ''), score: scoreOf(entry) }))
  }
  return entries.map((entry) => ({ value: String(entry?.value ?? '') }))
}

/** A zset score as text Redis will accept. */
function scoreOf(entry) {
  const raw = entry?.score
  const text = raw === null || raw === undefined ? '' : String(raw).trim()
  if (text.length === 0) {
    // The editor turns a cleared score box into `undefined`, and its own default for
    // a new member is '0' — so a blank score means 0 rather than an error.
    return '0'
  }
  if (!Number.isFinite(Number(text))) {
    throw redisError('DBM_REDIS_ZSET_SCORE_INVALID', `无效的 score: ${text}`)
  }
  return text
}

/**
 * Queue one key's write onto a MULTI.
 *
 * A container save is a REWRITE: `DEL` then rebuild, both inside the caller's MULTI,
 * so no reader ever sees the key missing or half-built. The reference sent the DEL
 * and the rebuild as separate commands; this port always uses MULTI.
 */
function appendWrite(queue, record) {
  const { key, type, ttl, entries } = record

  if (type === 'string') {
    queue.set(key, entries[0]?.value ?? '')
  } else {
    queue.del(key)
    if (type === 'hash') {
      const flat = []
      for (const entry of entries) {
        flat.push(entry.field, entry.value)
      }
      queue.hset(key, ...flat)
    } else if (type === 'list') {
      queue.rpush(key, ...entries.map((entry) => entry.value))
    } else if (type === 'set') {
      queue.sadd(key, ...entries.map((entry) => entry.value))
    } else {
      // ZADD takes score before member.
      const flat = []
      for (const entry of entries) {
        flat.push(entry.score, entry.value)
      }
      queue.zadd(key, ...flat)
    }
  }

  if (ttl > 0) {
    queue.expire(key, ttl)
  } else {
    // Both branches above already drop any old TTL (`DEL`, and a plain `SET` without
    // KEEPTTL), so this is belt-and-braces: `ttl_seconds` of 0 must end up as a key
    // without an expiry whatever the write path did.
    queue.persist(key)
  }
}

/**
 * Run a MULTI and turn its two silent failure modes into panel errors.
 *
 * ioredis resolves `exec()` to `null` when a WATCHed key changed (the transaction was
 * discarded), and to `[[error, reply], …]` otherwise — a failed command inside the
 * transaction is an entry, not a rejection, so it has to be looked for.
 */
async function execMulti(queue, watched) {
  let replies
  try {
    replies = await queue.exec()
  } catch (error) {
    throw redisError('DBM_REDIS_TXN_EXEC', `Redis 事务执行失败: ${messageOf(error)}`)
  }
  if (replies === null) {
    throw redisError(
      'DBM_REDIS_WATCH_CONFLICT',
      `Redis WATCH 检测到并发修改，事务已取消，请重试（冲突键：${watched.join(', ')}）`,
    )
  }
  for (const [error] of replies) {
    if (error) {
      throw redisError('DBM_REDIS_TXN_EXEC', `Redis 事务执行失败: ${messageOf(error)}`)
    }
  }
  return replies
}

/** One console command per line; blanks and `#` comments dropped. */
function splitCommands(script) {
  const commands = []
  for (const line of String(script ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (text.length === 0 || text.startsWith('#')) {
      continue
    }
    const tokens = tokenize(text)
    if (tokens.length === 0) {
      continue
    }
    commands.push({ text, name: tokens[0], args: tokens.slice(1) })
  }
  return commands
}

/**
 * Split one command line into tokens.
 *
 * Both quote characters are honoured and neither survives into the argument, so
 * `SET greeting "hello world"` is three tokens and `SET blank ""` really does send an
 * empty string — which is why an opened quote marks the token as present even when it
 * ends up empty.
 */
function tokenize(line) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false

  for (const char of String(line)) {
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
  }

  if (started || current.length > 0) {
    tokens.push(current)
  }
  return tokens
}
