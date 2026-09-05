/**
 * Kafka, pretending to be a database because one panel needs it to.
 *
 * Kafka is an append-only log: no query language, no row to update, no row to delete.
 * So the tree gets topics, the grid gets the TAIL of a topic, and everything else is
 * refused with a Chinese sentence rather than a driver stack trace.
 *
 * The part to be careful with is reading. A consumer belongs to a group, and a group
 * member that is never disconnected holds its slot until the broker's session timeout
 * expires — which forces a rebalance on any real application sharing that group id.
 * That is why `tableData` uses a throwaway group id, never commits an offset, and
 * disconnects in a `finally` even when the read timed out.
 *
 * @module dsh-plugin-otools-dbm/host/engines/kafka
 */
import {
  boundedInt,
  classifyConnectionError,
  connectionErrorMessage,
  DbmError,
  ERR,
} from '../../shared/protocol.js'

import { unsupported } from './contract.js'
import { loadDriverNamed } from './drivers/load.js'
import { elapsedSince, queryResult } from './result.js'
import { messageOf } from './sql-engine.js'

/** The synthetic database name the tree shows above the topic list. */
const DATABASE = 'topics'

/** What a message browser shows; Kafka has no schema, so these ARE the columns. */
const MESSAGE_COLUMNS = ['topic', 'partition', 'offset', 'timestamp', 'key', 'value']

/** Column types for the six synthetic columns. */
const MESSAGE_TYPES = {
  topic: 'string',
  partition: 'int',
  offset: 'bigint',
  timestamp: 'datetime',
  key: 'string',
  value: 'string',
}

/** A preview read gives up after this long: a quiet partition never answers. */
const READ_TIMEOUT_MS = 10000

/** How this plugin identifies itself to the broker, in every log the ops team reads. */
const CLIENT_ID = 'dsh-otools-dbm'

export class KafkaEngine {
  /** @param connection - the stored DbConnection record. */
  constructor(connection) {
    this.connection = connection ?? {}
    this.kind = 'kafka'
    this.dbType = 'kafka'
    this.kafka = undefined
    this.admin = undefined
    this.closed = false
  }

  /**
   * The broker list.
   *
   * The panel has a single host field, so a cluster is typed into it separated by
   * commas, semicolons or newlines. Only the entries with no port of their own get the
   * connection's port.
   */
  brokers() {
    const port = Number(this.connection.port) || 9092
    const list = String(this.connection.host ?? '')
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.includes(':') ? entry : `${entry}:${port}`))
    return list.length > 0 ? list : [`127.0.0.1:${port}`]
  }

  /** The Kafka client, built on first use. */
  async kafkaFor() {
    if (this.closed) {
      throw new DbmError(ERR.connectionClosed, '连接已关闭，请重新连接')
    }
    if (this.kafka !== undefined) {
      return this.kafka
    }
    const Kafka = await loadDriverNamed('kafkajs', 'Kafka', 'Kafka')
    const logLevel = await loadDriverNamed('kafkajs', 'Kafka', 'logLevel')
    const username = String(this.connection.username ?? '')
    this.kafka = new Kafka({
      clientId: CLIENT_ID,
      brokers: this.brokers(),
      ssl: this.connection.ssl === true || this.connection.use_ssl === true,
      // One username/password pair is SASL/PLAIN; SCRAM would need a mechanism picker
      // the panel's connection form does not have.
      sasl: username.length === 0
        ? undefined
        : { mechanism: 'plain', username, password: String(this.connection.password ?? '') },
      // kafkajs logs to stdout, and this process' stdout carries the dsh protocol:
      // anything below ERROR is noise in it.
      logLevel: logLevel.ERROR,
      connectionTimeout: 10000,
      requestTimeout: 15000,
      retry: { retries: 2 },
    })
    return this.kafka
  }

  /** The shared admin client, connected once. */
  async adminFor() {
    if (this.admin !== undefined) {
      return this.admin
    }
    const kafka = await this.kafkaFor()
    const admin = kafka.admin()
    try {
      await admin.connect()
    } catch (error) {
      await admin.disconnect().catch(() => {})
      throw connectionFailure(error)
    }
    this.admin = admin
    return admin
  }

  /** Liveness probe; never throws. */
  async ping() {
    if (this.closed) {
      return false
    }
    try {
      const admin = await this.adminFor()
      await admin.listTopics()
      return true
    } catch {
      return false
    }
  }

  /** Disconnect the admin client. Idempotent. */
  async close() {
    this.closed = true
    const admin = this.admin
    this.admin = undefined
    this.kafka = undefined
    if (admin === undefined) {
      return
    }
    try {
      await admin.disconnect()
    } catch {
      // A connection that is already gone is the outcome we wanted.
    }
  }

  // ------------------------------------------------------------- introspection
  async listDatabases() {
    // The tree needs a level above the topic list and Kafka has nothing to put there.
    return [DATABASE]
  }

  async listSchemas() {
    return []
  }

  async listTables() {
    const admin = await this.adminFor()
    const topics = await admin.listTopics()
    // `__consumer_offsets` and `__transaction_state` are the broker's own bookkeeping;
    // a user browsing their messages never wants to open them.
    return sorted(asArray(topics).map((name) => text(name)).filter((name) => !name.startsWith('__')))
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

  async createTableStatement() {
    // Topics are created with a partition count and a replication factor, not DDL.
    unsupported('Kafka', '建表语句')
  }

  /**
   * The synthetic shape a message browser shows.
   *
   * Kafka stores two byte arrays and some metadata per message, so these six columns
   * are the whole structure. A message is addressed by WHERE it sits in the log —
   * the same key legitimately appears in a thousand messages — which is why the
   * primary key is `partition` + `offset` rather than `key`.
   */
  async tableStruct(_database, table) {
    const topic = requireTopic(table)
    return {
      table_name: topic,
      columns: MESSAGE_COLUMNS.map((name) => messageColumn(name)),
      primary_keys: ['partition', 'offset'],
      foreign_keys: [],
      indexes: [],
      comment: '',
    }
  }

  async stats() {
    const admin = await this.adminFor()
    const topics = await this.listTables()
    let partitions = 0
    if (topics.length > 0) {
      try {
        const metadata = await admin.fetchTopicMetadata({ topics })
        for (const topic of asArray(metadata?.topics)) {
          partitions += asArray(topic?.partitions).length
        }
      } catch {
        // Metadata for a topic the user may not describe is refused; the topic count is
        // still worth showing on the dashboard.
      }
    }
    return {
      databases: [
        {
          name: DATABASE,
          table_count: topics.length,
          // Kafka has no row count and no size the admin API gives up cheaply, so the
          // partition count goes where the dashboard shows rows.
          row_count: partitions,
          data_size: 0,
          index_size: 0,
        },
      ],
    }
  }

  // ---------------------------------------------------------------- table data
  /**
   * The tail of a topic.
   *
   * A log has no random access by row number, so the pager's `offset` walks the window
   * BACK from the head: offset 0 is the newest `limit` messages, offset 100 the hundred
   * before those.
   */
  async tableData({ table, limit = 100, offset = 0 }) {
    const topic = requireTopic(table)
    const admin = await this.adminFor()
    const size = boundedInt(limit, 100, 1, 1000)
    const skip = boundedInt(offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const started = process.hrtime.bigint()

    let offsets
    try {
      offsets = await admin.fetchTopicOffsets(topic)
    } catch (error) {
      throw new DbmError(ERR.internal, `读取主题 ${topic} 的位点失败：${messageOf(error)}`, { cause: error })
    }

    const windows = []
    let total = 0
    for (const entry of asArray(offsets)) {
      const low = number(entry?.low)
      const high = number(entry?.high)
      total += Math.max(0, high - low)
      const end = Math.max(low, high - skip)
      const start = Math.max(low, end - size)
      if (end > start) {
        windows.push({ partition: number(entry?.partition), start, end })
      }
    }

    const messages = windows.length === 0 ? [] : await this.readTail(topic, windows, size)
    // partition ASC, offset DESC — newest first inside each partition, which is what a
    // message browser is for.
    messages.sort((left, right) => (left.partition - right.partition) || (right.offset - left.offset))

    return queryResult({
      columns: MESSAGE_COLUMNS,
      rows: messages.slice(0, size),
      // The length of the log, gaps from compaction and retention included: Kafka has
      // no exact "how many messages are in here" to ask for.
      rowCount: total,
      executionTime: elapsedSince(started),
    })
  }

  /**
   * Read at most `limit` messages out of the given per-partition windows.
   *
   * The group id is throwaway and `autoCommit` is off, so this read cannot move a real
   * consumer group's offsets. The `finally` is the important part — see the header for
   * what a leaked group member costs.
   */
  async readTail(topic, windows, limit) {
    const kafka = await this.kafkaFor()
    const groupId = `dsh-dbm-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const consumer = kafka.consumer({ groupId, sessionTimeout: 10000, allowAutoTopicCreation: false })
    const byPartition = new Map(windows.map((window) => [window.partition, window]))
    const collected = []

    let stop = () => {}
    const finished = new Promise((resolve) => {
      // The hard deadline: a partition whose window turns out to be empty never calls
      // eachMessage, so nothing else would ever end this read.
      const timer = setTimeout(resolve, READ_TIMEOUT_MS)
      stop = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    try {
      await consumer.connect()
      await consumer.subscribe({ topic, fromBeginning: true })
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          const window = byPartition.get(partition)
          const offset = number(message?.offset)
          if (window === undefined || offset >= window.end) {
            return
          }
          collected.push({
            topic,
            partition,
            offset,
            timestamp: timestampOf(message?.timestamp),
            key: decode(message?.key),
            value: decode(message?.value),
          })
          if (collected.length >= limit) {
            stop()
          }
        },
      })
      // `seek` only takes effect after `run`, and it is what makes this a tail read
      // instead of a replay of the entire topic.
      for (const window of windows) {
        consumer.seek({ topic, partition: window.partition, offset: String(window.start) })
      }
      await finished
    } catch (error) {
      throw new DbmError(ERR.internal, `读取主题 ${topic} 的消息失败：${messageOf(error)}`, { cause: error })
    } finally {
      // `stop()` also clears the deadline timer, so a failed connect does not keep the
      // event loop alive for another ten seconds.
      stop()
      await consumer.disconnect().catch(() => {})
    }
    return collected
  }

  // ------------------------------------------------------------------- console
  /** No query language exists; pretending otherwise only wastes the user's time. */
  async executeScript() {
    throw new DbmError(ERR.unsupported, 'Kafka 不支持 SQL 查询，请在左侧浏览主题与消息')
  }

  async run() {
    return this.executeScript()
  }

  // ------------------------------------------------------------------ grid save
  /**
   * Produce the added rows as messages.
   *
   * There is no update and no delete — a log is append-only, and the panel warns about
   * that before it calls here (`kafkaSaveConfirmMessage`). Refusing the two operations
   * is more honest than faking them by appending something the user did not ask for.
   */
  async saveRows({ table, changes }) {
    const topic = requireTopic(table)
    const added = Array.isArray(changes?.added) ? changes.added : []
    const modified = Array.isArray(changes?.modified) ? changes.modified : []
    const deleted = Array.isArray(changes?.deleted) ? changes.deleted : []

    // The panel's own confirm dialog promises this behaviour before it sends the
    // save: "修改将追加新消息，删除将发送 tombstone 消息". A log cannot be edited in
    // place, so an edit becomes another message with the same key and a delete
    // becomes a null-valued message — which is exactly what a compacted topic
    // treats as "this key is gone".
    const messages = added.map((row) => messageFor(row))
    for (const entry of modified) {
      const row = entry?.current ?? entry
      const key = String(row?.key ?? '').trim()
      if (key.length === 0) {
        throw new DbmError(
          ERR.invalidInput,
          'Kafka 修改一条消息其实是追加一条同 key 的新消息，所以 key 不能为空',
        )
      }
      messages.push(messageFor(row))
    }
    const tombstones = []
    for (const row of deleted) {
      const key = String(row?.key ?? '').trim()
      if (key.length === 0) {
        throw new DbmError(
          ERR.invalidInput,
          'Kafka 删除一条消息其实是发送一条 tombstone（value 为空的同 key 消息），所以 key 不能为空',
        )
      }
      const message = messageFor({ ...row, value: null })
      message.value = null
      tombstones.push(message)
    }

    const outgoing = [...messages, ...tombstones]
    if (outgoing.length === 0) {
      return { inserted: 0, updated: 0, deleted: 0 }
    }
    if (changes?.validate_only === true) {
      return { inserted: added.length, updated: modified.length, deleted: deleted.length }
    }

    const kafka = await this.kafkaFor()
    const producer = kafka.producer({ allowAutoTopicCreation: false })
    try {
      await producer.connect()
      await producer.send({ topic, messages: outgoing })
    } finally {
      // Same reasoning as the consumer: a producer left connected holds a socket and a
      // metadata refresh timer for the rest of the process' life.
      await producer.disconnect().catch(() => {})
    }
    return { inserted: added.length, updated: modified.length, deleted: deleted.length }
  }
}

/** Factory the engine registry calls. */
export function createKafkaEngine(connection) {
  return new KafkaEngine(connection)
}

/** Wrap a broker connect failure in the code the panel localizes. */
function connectionFailure(error) {
  const kind = classifyConnectionError(error)
  return new DbmError('kafka_conn', connectionErrorMessage('kafka', kind, messageOf(error)), { cause: error })
}

/** One of the six synthetic columns, as a ColumnSchema. */
function messageColumn(name) {
  return {
    name,
    data_type: MESSAGE_TYPES[name] ?? 'string',
    // A message may have no key and a tombstone has no value.
    is_nullable: name === 'key' || name === 'value',
    default_value: null,
    is_primary_key: name === 'partition' || name === 'offset',
    character_maximum_length: null,
    column_comment: '',
  }
}

/**
 * One grid row as a message to produce.
 *
 * A row with no `value` column at all is sent as JSON of the whole row, which is what
 * the grid hands over when the user pastes a document into a fresh row.
 */
function messageFor(row) {
  const record = row ?? {}
  const message = {}
  const key = record.key
  if (key !== null && key !== undefined && String(key).length > 0) {
    message.key = String(key)
  }
  if (Object.prototype.hasOwnProperty.call(record, 'value')) {
    message.value = record.value === null || record.value === undefined ? null : String(record.value)
  } else {
    message.value = JSON.stringify(record)
  }
  // The grid creates a new row with every column set to `''`, and `Number('')` is 0 —
  // so an untouched partition cell must NOT pin the message to partition 0. Only text
  // the user actually typed counts.
  const partition = String(record.partition ?? '').trim()
  if (partition.length > 0 && Number.isInteger(Number(partition)) && Number(partition) >= 0) {
    message.partition = Number(partition)
  }
  return message
}

/** A message's bytes as text: a Kafka payload is JSON or a string in practice. */
function decode(value) {
  if (value === null || value === undefined) {
    return null
  }
  // Left as a Buffer this would render as `0x…` hex, which tells a message browser
  // nothing about what was published.
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

/** A broker timestamp (milliseconds, as a string) as a Date. */
function timestampOf(value) {
  const millis = Number(value)
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : null
}

/** A topic name the panel supplied. */
function requireTopic(table) {
  const topic = text(table)
  if (topic.length === 0) {
    throw new DbmError(ERR.invalidInput, '主题名不能为空')
  }
  return topic
}

const asArray = (value) => (Array.isArray(value) ? value : [])

const sorted = (names) => names.filter((name) => name.length > 0).sort((a, b) => a.localeCompare(b))

const text = (value) => {
  if (value === null || value === undefined) {
    return ''
  }
  return typeof value === 'string' ? value.trim() : String(value)
}

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

