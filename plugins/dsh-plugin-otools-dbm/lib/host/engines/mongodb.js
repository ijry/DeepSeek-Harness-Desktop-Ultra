/**
 * MongoDB, seen through a panel that was built for tables.
 *
 * Two facts about this engine will bite whoever reads it next:
 *
 * 1. There is no schema, so `tableStruct` SAMPLES. It reads 50 documents and unions
 *    their top-level keys in first-seen order; a field that none of those 50 happen
 *    to carry does not exist as far as the designer is concerned. What comes back is
 *    a picture of the data, never a definition of it.
 * 2. The credentials travel inside a URI, so they have to be percent-encoded. A
 *    password holding `@` or `/` — both legal, both common — turns a concatenated
 *    `mongodb://user:p@ss@host:27017/` into a host of `ss@host`, and the driver then
 *    reports a DNS failure for what is really a password problem.
 *
 * The console deliberately does not evaluate JavaScript; see `executeScript`.
 *
 * @module dsh-plugin-otools-dbm/host/engines/mongodb
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
import { columnsFromRows, elapsedSince, queryResult } from './result.js'
import { FILTER_OPERATORS } from './sql-engine.js'

/** Documents `tableStruct` reads before it stops guessing a shape. */
const SAMPLE_SIZE = 50

/** One column shape for every write, so the workbench renders them all alike. */
const WRITE_COLUMNS = ['acknowledged', 'insertedCount', 'modifiedCount', 'deletedCount', 'matchedCount']

/** Operations the console's JSON form accepts. */
const OPERATIONS = new Set([
  'find',
  'countDocuments',
  'distinct',
  'aggregate',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'listCollections',
])

/** What the console accepts, shown verbatim whenever it is handed anything else. */
const USAGE = [
  'MongoDB 控制台只接受两种写法：',
  '1) JSON：{"collection": "users", "operation": "find", "filter": {}, "limit": 50}',
  '   operation 可选 find / countDocuments / distinct / aggregate / insertOne / insertMany /',
  '   updateOne / updateMany / deleteOne / deleteMany / listCollections',
  '2) 简写：db.users.find({"age": {"$gt": 18}})、db.users.aggregate([...])、db.users.countDocuments({})',
  '本插件不执行 JavaScript，参数必须是合法 JSON；ObjectId 请写成 {"$oid": "..."}，日期写成 {"$date": "..."}',
].join('\n')

/** `db.<collection>.<operation>(<json>)` — the only shorthand this console parses. */
const SHORTHAND = /^db\s*\.\s*([A-Za-z0-9_$.-]+)\s*\.\s*([A-Za-z]+)\s*\(([\s\S]*)\)\s*;?$/

export class MongoEngine {
  /** @param connection - the stored DbConnection record. */
  constructor(connection) {
    this.connection = connection ?? {}
    this.kind = 'mongodb'
    this.dbType = 'mongodb'
    this.client = undefined
    /** The driver's ObjectId class, loaded together with the client. */
    this.ObjectId = undefined
    this.closed = false
  }

  /** The database a call runs against when it names none. */
  defaultDatabase() {
    const configured = String(this.connection.database ?? '').trim()
    return configured.length > 0 ? configured : 'admin'
  }

  /**
   * `mongodb://user:pass@host:port/`.
   *
   * `encodeURIComponent` on BOTH credentials is the point of this method — see the
   * header comment for what an unencoded `@` in a password does. A host that already
   * carries a scheme is passed through untouched, because the panel's host field is
   * the only place a `mongodb+srv://…` Atlas string can be typed and rewriting it
   * would break the SRV lookup.
   */
  uri() {
    const host = String(this.connection.host ?? '').trim()
    if (/^mongodb(\+srv)?:\/\//i.test(host)) {
      return host
    }
    const port = Number(this.connection.port) || 27017
    const user = String(this.connection.username ?? '')
    const password = String(this.connection.password ?? '')
    const credentials = user.length === 0
      ? ''
      : `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
    // A replica-set seed list may be typed as `a:27017,b:27017`; only the members
    // that carry no port of their own get the connection's.
    const hosts = (host.length > 0 ? host : '127.0.0.1')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.includes(':') ? entry : `${entry}:${port}`))
      .join(',')
    return `mongodb://${credentials}${hosts}/`
  }

  /**
   * MongoClientOptions from `connection.mongodb`.
   *
   * The panel stores that block in snake_case (`auth_source`, `tls_ca_file`) because
   * that is the reference's on-disk shape, so every key is translated by hand here
   * rather than spread into the options object.
   */
  clientOptions() {
    const extra = this.connection.mongodb ?? {}
    const options = {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    }
    const strings = [
      ['auth_source', 'authSource'],
      ['auth_mechanism', 'authMechanism'],
      ['replica_set', 'replicaSet'],
      ['read_preference', 'readPreference'],
      ['tls_ca_file', 'tlsCAFile'],
      ['tls_certificate_key_file', 'tlsCertificateKeyFile'],
      ['tls_certificate_key_file_password', 'tlsCertificateKeyFilePassword'],
    ]
    for (const [from, to] of strings) {
      const value = text(extra[from])
      if (value.length > 0) {
        options[to] = value
      }
    }
    // Booleans are forwarded only when the panel actually set them: the driver's own
    // defaults (retryWrites on, tls off) beat a stray `false` from an empty form.
    if (typeof extra.retry_writes === 'boolean') {
      options.retryWrites = extra.retry_writes
    }
    if (extra.tls === true || this.connection.ssl === true) {
      options.tls = true
    }
    if (extra.tls_allow_invalid_certificates === true) {
      options.tlsAllowInvalidCertificates = true
    }
    return options
  }

  /** The connected client, opened on first use. */
  async clientFor() {
    if (this.closed) {
      throw new DbmError(ERR.connectionClosed, '连接已关闭，请重新连接')
    }
    if (this.client !== undefined) {
      return this.client
    }
    const MongoClient = await loadDriverNamed('mongodb', 'MongoDB', 'MongoClient')
    this.ObjectId = await loadDriverNamed('mongodb', 'MongoDB', 'ObjectId')
    const client = new MongoClient(this.uri(), this.clientOptions())
    try {
      await client.connect()
    } catch (error) {
      // A client that failed to connect still owns a topology that would keep
      // retrying server selection in the background, so force it shut.
      await client.close(true).catch(() => {})
      throw connectionFailure(error)
    }
    this.client = client
    return client
  }

  /** A `Db` handle, defaulting to the connection's own database. */
  async dbFor(database) {
    const client = await this.clientFor()
    const name = String(database ?? '').trim()
    return client.db(name.length > 0 ? name : this.defaultDatabase())
  }

  /** A collection handle, with the name checked. */
  async collectionFor(database, collection) {
    const name = String(collection ?? '').trim()
    if (name.length === 0) {
      throw new DbmError(ERR.invalidInput, '集合名不能为空')
    }
    const db = await this.dbFor(database)
    return db.collection(name)
  }

  /** Liveness probe; never throws. */
  async ping() {
    if (this.closed) {
      return false
    }
    try {
      const db = await this.dbFor(undefined)
      await db.command({ ping: 1 })
      return true
    } catch {
      return false
    }
  }

  /** Release the client. Idempotent. */
  async close() {
    this.closed = true
    const client = this.client
    this.client = undefined
    if (client === undefined) {
      return
    }
    try {
      await client.close()
    } catch {
      // A connection that is already gone is the outcome we wanted.
    }
  }

  // ------------------------------------------------------------- introspection
  async listDatabases() {
    const client = await this.clientFor()
    try {
      const result = await client.db('admin').admin().listDatabases({ nameOnly: true })
      return sorted((result?.databases ?? []).map((entry) => text(entry?.name)))
    } catch {
      // `listDatabases` needs a cluster-wide privilege that a per-database user does
      // not have. Answering with the one database the connection names keeps the
      // tree usable for exactly that user instead of failing the whole panel.
      const configured = String(this.connection.database ?? '').trim()
      return [configured.length > 0 ? configured : 'admin']
    }
  }

  async listSchemas() {
    // No schema level in MongoDB; the panel skips the folder when this is empty.
    return []
  }

  /** `{name, type}` for every collection — the one call both lists share. */
  async collectionInfos(database) {
    const db = await this.dbFor(database)
    const infos = await db.listCollections({}, { nameOnly: true }).toArray()
    return infos
      .map((info) => ({ name: text(info?.name), type: text(info?.type) }))
      .filter((info) => info.name.length > 0)
  }

  async listTables(database) {
    const infos = await this.collectionInfos(database)
    // Views are excluded the way every SQL dialect here keeps them out of SHOW
    // TABLES: the tree has its own 视图 folder, and a name in both is confusing.
    return sorted(infos.filter((info) => info.type !== 'view').map((info) => info.name))
  }

  async listViews(database) {
    const infos = await this.collectionInfos(database)
    return sorted(infos.filter((info) => info.type === 'view').map((info) => info.name))
  }

  async listProcedures() {
    return []
  }

  /** A view's aggregation pipeline — the closest thing Mongo has to a definition. */
  async viewDefinition(database, view) {
    const db = await this.dbFor(database)
    const infos = await db.listCollections({ name: String(view ?? '') }).toArray()
    const pipeline = infos[0]?.options?.pipeline
    return pipeline === undefined ? '' : JSON.stringify(pipeline, null, 2)
  }

  async procedureDefinition() {
    return ''
  }

  async createTableStatement() {
    // A collection has no DDL: it comes into existence on first insert.
    unsupported('MongoDB', '建表语句')
  }

  /**
   * A collection's shape, INFERRED from a sample of `SAMPLE_SIZE` documents.
   *
   * Nothing authoritative exists to read — see the header. A field carrying more than
   * one type across the sample is reported as `string|number`, because that is what
   * the data says and hiding it would mislead the row editor.
   */
  async tableStruct(database, collection) {
    const handle = await this.collectionFor(database, collection)
    const documents = await handle.find({}).limit(SAMPLE_SIZE).toArray()

    const fields = new Map()
    for (const document of documents) {
      for (const [name, value] of Object.entries(document ?? {})) {
        const field = fields.get(name) ?? { name, types: [], present: 0, nulls: 0 }
        const type = observedType(value)
        if (!field.types.includes(type)) {
          field.types.push(type)
        }
        field.present += 1
        if (value === null || value === undefined) {
          field.nulls += 1
        }
        fields.set(name, field)
      }
    }

    // An empty collection still needs a column list, or the designer shows nothing
    // and the grid has no header to add a row under.
    if (fields.size === 0) {
      fields.set('_id', { name: '_id', types: ['objectid'], present: 0, nulls: 0 })
    }

    const columns = Array.from(fields.values()).map((field) => ({
      name: field.name,
      data_type: field.types.join('|'),
      // A field missing from part of the sample is nullable in every sense the grid
      // cares about; `_id` is the one key MongoDB guarantees.
      is_nullable: field.name !== '_id' && (field.nulls > 0 || field.present < documents.length),
      default_value: null,
      is_primary_key: field.name === '_id',
      character_maximum_length: null,
      column_comment: '',
    }))

    let indexes = []
    try {
      const raw = await handle.listIndexes().toArray()
      indexes = raw.map((index) => ({
        name: text(index?.name),
        columns: Object.keys(index?.key ?? {}),
        is_unique: index?.unique === true,
      }))
    } catch {
      // listIndexes needs metadata access; a user with only `find` should still get
      // the columns rather than an error dialog.
    }

    return {
      table_name: String(collection ?? ''),
      columns,
      primary_keys: ['_id'],
      foreign_keys: [],
      indexes,
      comment: '',
    }
  }

  async stats() {
    const client = await this.clientFor()
    const names = await this.listDatabases()
    const databases = []
    for (const name of names) {
      try {
        const raw = await client.db(name).stats()
        databases.push({
          name,
          table_count: number(raw?.collections),
          row_count: number(raw?.objects),
          data_size: number(raw?.dataSize),
          index_size: number(raw?.indexSize),
        })
      } catch {
        // dbStats is refused on a database the user cannot read; a zero row keeps the
        // dashboard's totals honest about what it could see.
        databases.push({ name, table_count: 0, row_count: 0, data_size: 0, index_size: 0 })
      }
    }
    return { databases }
  }

  // ---------------------------------------------------------------- table data
  /** The panel's `field_OPERATOR` map as a Mongo query document. */
  buildFilter(filters) {
    const conditions = []
    for (const [key, value] of Object.entries(filters ?? {})) {
      const operator = FILTER_OPERATORS.find((candidate) => key.endsWith(`_${candidate}`))
      if (operator === undefined) {
        continue
      }
      const field = key.slice(0, key.length - operator.length - 1)
      if (field.length === 0) {
        continue
      }
      conditions.push({ [field]: this.conditionFor(field, operator, value) })
    }
    if (conditions.length === 0) {
      return {}
    }
    // Two filters on the SAME field would overwrite each other inside one document,
    // so anything past the first condition goes through `$and`.
    return conditions.length === 1 ? conditions[0] : { $and: conditions }
  }

  /** One panel operator → one Mongo condition. */
  conditionFor(field, operator, value) {
    switch (operator) {
      case 'IS_NULL':
        // `$eq: null` also matches a document where the field is absent, which is
        // what "为空" means to someone reading a schemaless collection.
        return { $eq: null }
      case 'IS_NOT_NULL':
        return { $ne: null }
      case 'LIKE':
        return { $regex: likePattern(value), $options: 'i' }
      case 'NOT_LIKE':
        // `$not` gets a RegExp instance: the `{$not: {$regex: …}}` spelling needs
        // MongoDB 4.0.7 and this port still talks to older servers.
        return { $not: new RegExp(likePattern(value), 'i') }
      case '>':
        return { $gt: comparable(value) }
      case '<':
        return { $lt: comparable(value) }
      case '>=':
        return { $gte: comparable(value) }
      case '<=':
        return { $lte: comparable(value) }
      case '!=': {
        const candidates = equalityCandidates(field, value, this.ObjectId)
        return candidates.length === 1 ? { $ne: candidates[0] } : { $nin: candidates }
      }
      default: {
        const candidates = equalityCandidates(field, value, this.ObjectId)
        return candidates.length === 1 ? { $eq: candidates[0] } : { $in: candidates }
      }
    }
  }

  /**
   * One page of a collection plus the TOTAL match count.
   *
   * The count is a second round trip because the panel's pager needs the total, not
   * the page length. `countDocuments` scans when the filter is unindexed, so a
   * failure (timeout, no privilege) degrades to the page length rather than failing
   * the read outright.
   */
  async tableData({ database, table, limit = 100, offset = 0, orderBy, filters }) {
    const handle = await this.collectionFor(database, table)
    const filter = this.buildFilter(filters)
    // `limit: 0` means "no limit" to the driver, which is the one value the grid must
    // never be able to send it.
    const size = boundedInt(limit, 100, 1, 10000)
    const skip = boundedInt(offset, 0, 0, Number.MAX_SAFE_INTEGER)

    const started = process.hrtime.bigint()
    let cursor = handle.find(filter).skip(skip).limit(size)
    const sort = sortSpec(orderBy)
    if (sort !== undefined) {
      cursor = cursor.sort(sort)
    }
    const documents = await cursor.toArray()
    const executionTime = elapsedSince(started)

    let total = documents.length + skip
    try {
      total = await handle.countDocuments(filter)
    } catch {
      // Keep the page usable when counting is not allowed or times out.
    }

    // `_id` renders as its hex string for free: `normalizeValue` prefers an object's
    // own `toJSON`, and ObjectId's returns the hex form.
    return queryResult({
      columns: columnsFromRows(documents),
      rows: documents,
      rowCount: total,
      executionTime,
    })
  }

  // ------------------------------------------------------------------- console
  /**
   * The panel's Mongo console.
   *
   * The reference ran the console text through `eval` with a `db` object in scope.
   * This port refuses to: the script arrives over HTTP from a webview, and `eval` in
   * the host is arbitrary code execution inside the dsh process, not a database
   * query. Two safe forms are accepted instead (see `USAGE`), and anything else is
   * refused with that text. MongoDB Extended JSON (`{"$oid": …}`, `{"$date": …}`) is
   * revived on the way in, because plain JSON cannot spell an ObjectId.
   */
  async executeScript(script, options = {}) {
    const body = String(script ?? '').trim()
    if (body.length === 0) {
      throw new DbmError(ERR.invalidInput, '没有可执行的语句')
    }
    // The client is opened first so `this.ObjectId` exists for the reviver.
    await this.clientFor()
    return this.runRequest(parseRequest(body, this.ObjectId), options.database)
  }

  /** The workbench's single-statement path; a Mongo script has only one form. */
  async run(script, options = {}) {
    return this.executeScript(script, options)
  }

  /** Run one parsed console request. */
  async runRequest(request, database) {
    const operation = text(request?.operation)
    if (!OPERATIONS.has(operation)) {
      throw new DbmError(ERR.invalidInput, USAGE)
    }
    const started = process.hrtime.bigint()
    const target = database ?? request.database

    if (operation === 'listCollections') {
      const infos = await this.collectionInfos(target)
      return queryResult({
        columns: ['name', 'type'],
        rows: infos.map((info) => [info.name, info.type]),
        rowCount: infos.length,
        executionTime: elapsedSince(started),
      })
    }

    const handle = await this.collectionFor(target, request.collection)
    const filter = asDocument(request.filter, 'filter')

    if (operation === 'find') {
      let cursor = handle.find(filter)
      if (request.projection !== undefined) {
        cursor = cursor.project(asDocument(request.projection, 'projection'))
      }
      if (request.sort !== undefined) {
        cursor = cursor.sort(asDocument(request.sort, 'sort'))
      }
      const documents = await cursor
        .skip(boundedInt(request.skip, 0, 0, Number.MAX_SAFE_INTEGER))
        .limit(boundedInt(request.limit, 100, 1, 10000))
        .toArray()
      return queryResult({
        columns: columnsFromRows(documents),
        rows: documents,
        rowCount: documents.length,
        executionTime: elapsedSince(started),
      })
    }

    if (operation === 'countDocuments') {
      const count = await handle.countDocuments(filter)
      return queryResult({
        columns: ['count'],
        rows: [[count]],
        rowCount: count,
        executionTime: elapsedSince(started),
      })
    }

    if (operation === 'distinct') {
      const field = text(request.field)
      if (field.length === 0) {
        throw new DbmError(ERR.invalidInput, 'distinct 需要 field 字段，例如 {"operation": "distinct", "field": "status"}')
      }
      const values = await handle.distinct(field, filter)
      return queryResult({
        columns: [field],
        rows: values.map((value) => [value]),
        rowCount: values.length,
        executionTime: elapsedSince(started),
      })
    }

    if (operation === 'aggregate') {
      if (!Array.isArray(request.pipeline)) {
        throw new DbmError(ERR.invalidInput, 'aggregate 需要 pipeline 数组，例如 {"pipeline": [{"$group": {...}}]}')
      }
      const documents = await handle.aggregate(request.pipeline).toArray()
      return queryResult({
        columns: columnsFromRows(documents),
        rows: documents,
        rowCount: documents.length,
        executionTime: elapsedSince(started),
      })
    }

    if (operation === 'insertOne' || operation === 'insertMany') {
      const documents = insertDocuments(request)
      const outcome = operation === 'insertOne'
        ? await handle.insertOne(documents[0])
        : await handle.insertMany(documents)
      return writeResult(outcome, started)
    }

    if (operation === 'updateOne' || operation === 'updateMany') {
      const update = asDocument(request.update, 'update')
      if (!Object.keys(update).some((key) => key.startsWith('$'))) {
        // Mongo rejects a replacement document here; saying which operator is missing
        // is more useful than relaying "Update document requires atomic operators".
        throw new DbmError(ERR.invalidInput, 'update 必须使用 $set 等更新操作符，例如 {"$set": {"name": "x"}}')
      }
      const outcome = operation === 'updateOne'
        ? await handle.updateOne(filter, update)
        : await handle.updateMany(filter, update)
      return writeResult(outcome, started)
    }

    const outcome = operation === 'deleteOne'
      ? await handle.deleteOne(filter)
      : await handle.deleteMany(filter)
    return writeResult(outcome, started)
  }

  // ------------------------------------------------------------------ grid save
  /**
   * The grid's save path (`save_table_data` calls this instead of building SQL).
   *
   * Every row is addressed by `_id`, and a modified or deleted row without one is
   * refused rather than guessed at: a filter built from the remaining fields could
   * match — and then rewrite — several documents.
   */
  async saveRows({ database, table, changes }) {
    const handle = await this.collectionFor(database, table)
    const added = Array.isArray(changes?.added) ? changes.added : []
    const modified = Array.isArray(changes?.modified) ? changes.modified : []
    const deleted = Array.isArray(changes?.deleted) ? changes.deleted : []

    // Everything is validated before anything is written, so `validate_only` is the
    // same code path with the writes skipped.
    const inserts = added.map((row) => insertableRow(row, this.ObjectId))
    const updates = modified
      .map((entry) => updateFor(entry, this.ObjectId))
      .filter((update) => Object.keys(update.set).length > 0)
    const removals = deleted.map((row) => idMatch(requireId(row), this.ObjectId))

    if (changes?.validate_only === true) {
      return { inserted: inserts.length, updated: updates.length, deleted: removals.length }
    }

    let inserted = 0
    // One document at a time: an `insertMany` that fails halfway reports an index the
    // grid cannot map back to a row, and it would leave the first half written.
    for (const document of inserts) {
      await handle.insertOne(document)
      inserted += 1
    }
    let updated = 0
    for (const update of updates) {
      const outcome = await handle.updateOne({ _id: update.id }, { $set: update.set })
      updated += number(outcome?.modifiedCount)
    }
    let removed = 0
    for (const match of removals) {
      const outcome = await handle.deleteOne({ _id: match })
      removed += number(outcome?.deletedCount)
    }
    return { inserted, updated, deleted: removed }
  }
}

/** Factory the engine registry calls. */
export function createMongoEngine(connection) {
  return new MongoEngine(connection)
}

/** Wrap a connect failure in the code the panel localizes. */
function connectionFailure(error) {
  const kind = classifyConnectionError(error)
  const detail = String(error?.message ?? error ?? '')
  return new DbmError('mongodb_conn', connectionErrorMessage('mongodb', kind, detail), { cause: error })
}

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

/**
 * The type actually observed in one value, in the panel's lowercase spelling.
 *
 * The BSON number wrappers (Long, Int32, Double, Decimal128) are reported as `number`
 * rather than `object`: a reader of the designer wants to know the field holds a
 * number, not which of five encodings the driver handed back.
 */
function observedType(value) {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'string') {
    return 'string'
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'number'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (value instanceof Date) {
    return 'date'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  const bsonType = String(value?._bsontype ?? '')
  if (bsonType === 'ObjectId') {
    return 'objectid'
  }
  if (bsonType === 'Long' || bsonType === 'Int32' || bsonType === 'Double' || bsonType === 'Decimal128') {
    return 'number'
  }
  return 'object'
}

/**
 * A SQL `LIKE` value as an anchored regex source.
 *
 * `%` and `_` are the SQL wildcards, everything else is escaped, and the pattern is
 * anchored because `LIKE 'abc'` matches the whole value. A value with no wildcard at
 * all is wrapped in `%…%` first, mirroring `sql-engine.js` so the same filter behaves
 * the same on MySQL and here.
 */
function likePattern(value) {
  const raw = String(value ?? '')
  const wrapped = raw.includes('%') || raw.includes('_') ? raw : `%${raw}%`
  const escaped = wrapped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`
}

/**
 * A filter value for `>`/`<`/`>=`/`<=`.
 *
 * BSON compares across types by type order, so `{age: {$gt: "30"}}` matches no
 * numeric document at all. The grid only ever sends text, so a numeric-looking value
 * becomes a number here. (A date column filtered as text stays text and will not
 * match a BSON Date — there is no schema to tell us it was one.)
 */
function comparable(value) {
  if (typeof value !== 'string') {
    return value
  }
  const trimmed = value.trim()
  if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
    return Number(trimmed)
  }
  return value
}

/**
 * Every value an `=`/`!=` filter could plausibly mean, for an `$in`/`$nin`.
 *
 * The grid sends text, so `{"age_=": "30"}` has to match the number 30, and an `_id`
 * has to match the ObjectId whose hex string the grid rendered. Offering both instead
 * of choosing keeps a genuine string field working too.
 */
function equalityCandidates(field, value, ObjectId) {
  const candidates = [value]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
      candidates.push(Number(trimmed))
    }
    if (trimmed === 'true' || trimmed === 'false') {
      candidates.push(trimmed === 'true')
    }
    const objectId = asObjectId(trimmed, ObjectId)
    if (objectId !== undefined && (field === '_id' || field.endsWith('_id'))) {
      candidates.push(objectId)
    }
  }
  return candidates
}

/** An ObjectId when the text is one, `undefined` when it is not. */
function asObjectId(value, ObjectId) {
  if (typeof ObjectId !== 'function' || !/^[0-9a-fA-F]{24}$/.test(String(value ?? ''))) {
    return undefined
  }
  try {
    return new ObjectId(String(value))
  } catch {
    return undefined
  }
}

/**
 * A filter value that finds the document the grid means by `_id`.
 *
 * `tableData` renders an ObjectId as its hex string, so a saved row hands that string
 * back — but an `_id` is allowed to BE a string, and a 24-char hex one is
 * indistinguishable here. Matching both keeps either case working; a collection
 * holding ObjectId("x") *and* "x" would be ambiguous, and no real one does.
 */
function idMatch(value, ObjectId) {
  const objectId = asObjectId(value, ObjectId)
  return objectId === undefined ? value : { $in: [objectId, value] }
}

/** `_id` of a grid row, or a message the user can act on. */
function requireId(row) {
  const raw = row?._id
  if (raw === null || raw === undefined || String(raw).trim().length === 0) {
    throw new DbmError(ERR.invalidInput, '这一行没有 _id，MongoDB 无法定位要修改的文档，请刷新数据后重试')
  }
  return raw
}

/** The panel's `column` / `column DESC` order clause as a Mongo sort document. */
function sortSpec(orderBy) {
  const raw = String(orderBy ?? '').trim()
  if (raw.length === 0) {
    return undefined
  }
  const spec = {}
  for (const part of raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    // Dotted paths are legal Mongo field names; anything with an operator or a quote
    // in it is not something the grid sends.
    const match = /^([A-Za-z0-9_$.一-龥]+)(?:\s+(asc|desc))?$/i.exec(part)
    if (match === null) {
      throw new DbmError(ERR.invalidInput, `排序字段不合法: ${part}`)
    }
    spec[match[1]] = String(match[2] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
  }
  return Object.keys(spec).length === 0 ? undefined : spec
}

/** Console text → a request object, or a refusal that shows both accepted forms. */
function parseRequest(script, ObjectId) {
  if (script.startsWith('{')) {
    return revive(parseJson(script), ObjectId)
  }
  const match = SHORTHAND.exec(script)
  if (match === null) {
    throw new DbmError(ERR.invalidInput, USAGE)
  }
  const collection = match[1]
  const operation = match[2]
  const argument = match[3].trim()
  const parsed = argument.length === 0 ? undefined : revive(parseJson(argument), ObjectId)

  if (operation === 'find') {
    return { collection, operation: 'find', filter: parsed ?? {} }
  }
  if (operation === 'countDocuments' || operation === 'count') {
    return { collection, operation: 'countDocuments', filter: parsed ?? {} }
  }
  if (operation === 'aggregate') {
    return { collection, operation: 'aggregate', pipeline: parsed ?? [] }
  }
  throw new DbmError(
    ERR.invalidInput,
    `简写只支持 find / aggregate / countDocuments，db.${collection}.${operation}(…) 请改用 JSON 形式。\n${USAGE}`,
  )
}

/** JSON.parse with a message that names the problem. */
function parseJson(body) {
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new DbmError(ERR.invalidInput, `不是合法的 JSON：${String(error?.message ?? error)}\n${USAGE}`)
  }
}

/**
 * Revive MongoDB Extended JSON in place: `{"$oid": …}` → ObjectId, `{"$date": …}` →
 * Date. Without this a console user has no way to write an `_id`, because JSON has no
 * literal for one and this engine will not evaluate `ObjectId("…")`.
 */
function revive(value, ObjectId) {
  if (Array.isArray(value)) {
    return value.map((entry) => revive(entry, ObjectId))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$oid') {
    const objectId = asObjectId(text(value.$oid), ObjectId)
    if (objectId === undefined) {
      throw new DbmError(ERR.invalidInput, `$oid 必须是 24 位十六进制字符串：${text(value.$oid)}`)
    }
    return objectId
  }
  if (keys.length === 1 && keys[0] === '$date') {
    const date = new Date(value.$date)
    if (Number.isNaN(date.getTime())) {
      throw new DbmError(ERR.invalidInput, `$date 不是合法时间：${text(value.$date)}`)
    }
    return date
  }
  const revived = {}
  for (const key of keys) {
    revived[key] = revive(value[key], ObjectId)
  }
  return revived
}

/** A field that must be a plain document, defaulting to `{}`. */
function asDocument(value, field) {
  if (value === undefined || value === null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DbmError(ERR.invalidInput, `${field} 必须是一个 JSON 对象`)
  }
  return value
}

/** `documents` (or a single `document`) for the insert operations. */
function insertDocuments(request) {
  const raw = request?.documents ?? request?.document
  const list = Array.isArray(raw) ? raw : [raw]
  const documents = list.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
  if (documents.length === 0) {
    throw new DbmError(ERR.invalidInput, 'insertOne/insertMany 需要 documents 字段（一个文档或文档数组）')
  }
  return documents
}

/** Any write outcome, in the one shape `WRITE_COLUMNS` describes. */
function writeResult(outcome, started) {
  const inserted = outcome?.insertedCount === undefined
    ? (outcome?.insertedId === undefined ? 0 : 1)
    : number(outcome.insertedCount)
  const modified = number(outcome?.modifiedCount)
  const removed = number(outcome?.deletedCount)
  const matched = number(outcome?.matchedCount)
  return queryResult({
    columns: WRITE_COLUMNS,
    rows: [[outcome?.acknowledged === true, inserted, modified, removed, matched]],
    rowCount: inserted + modified + removed,
    executionTime: elapsedSince(started),
  })
}

/**
 * One added grid row as a document to insert.
 *
 * The grid creates a new row with every column set to `''`, `_id` included, so an
 * empty `_id` has to be dropped or the collection ends up with a document keyed by
 * the empty string — and the second such insert fails on a duplicate key.
 */
function insertableRow(row, ObjectId) {
  const document = {}
  for (const [key, value] of Object.entries(row ?? {})) {
    // The panel strips its own `__row_key__`/`__status__` before sending; this is the
    // belt to that braces.
    if (key.startsWith('__')) {
      continue
    }
    if (key === '_id') {
      const raw = typeof value === 'string' ? value.trim() : value
      if (raw === null || raw === undefined || raw === '') {
        continue
      }
      document._id = asObjectId(raw, ObjectId) ?? raw
      continue
    }
    document[key] = value
  }
  return document
}

/**
 * One `{current, original}` pair as `{id, set}` — only the fields that changed.
 *
 * `$set` of the whole row would resurrect a field another writer had just removed and
 * would rewrite untouched subdocuments, so the diff against `original` is what gets
 * written. `original` is the row as the grid received it, which is also why the types
 * in it can be trusted: `normalizeValue` kept numbers as numbers.
 */
function updateFor(entry, ObjectId) {
  const current = entry?.current ?? {}
  const original = entry?.original ?? {}
  const id = idMatch(requireId({ _id: current._id ?? original._id }), ObjectId)
  const set = {}
  for (const [key, value] of Object.entries(current)) {
    if (key === '_id' || key.startsWith('__')) {
      continue
    }
    if (sameValue(original[key], value)) {
      continue
    }
    set[key] = coerceLike(original[key], value)
  }
  return { id, set }
}

/** Whether an edited cell still holds what it held before. */
function sameValue(before, next) {
  if (before === next) {
    return true
  }
  if ((before === null || before === undefined) && (next === null || next === undefined)) {
    return true
  }
  if (typeof before === 'object' || typeof next === 'object') {
    return JSON.stringify(before ?? null) === JSON.stringify(next ?? null)
  }
  // The editor hands text back for a number it never touched.
  return String(before) === String(next)
}

/**
 * Bring an edited cell back to the type its original had.
 *
 * The inline editor writes text, so without this a numeric field silently becomes a
 * string and every later `$gt` filter stops matching it. Objects and arrays need no
 * help: `TableContent.vue` re-parses JSON-looking cells for MongoDB before it posts
 * them (`normalizeMongoRow`). A date cannot be recovered — the grid only ever saw the
 * formatted text — so an edited date column is written back as a string.
 */
function coerceLike(before, next) {
  if (typeof next !== 'string') {
    return next
  }
  const trimmed = next.trim()
  if (typeof before === 'number' && trimmed.length > 0 && Number.isFinite(Number(trimmed))) {
    return Number(trimmed)
  }
  if (typeof before === 'boolean') {
    if (trimmed === 'true' || trimmed === '1') {
      return true
    }
    if (trimmed === 'false' || trimmed === '0') {
      return false
    }
  }
  return next
}

