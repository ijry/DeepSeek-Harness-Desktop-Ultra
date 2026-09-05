/**
 * Elasticsearch, spoken to over plain HTTP.
 *
 * There is no driver package here on purpose. `@elastic/elasticsearch` is a large
 * dependency that refuses to talk to a server whose major version it does not match,
 * and what it wraps is a JSON REST API; AirDB reaches for axios for the same reason,
 * and Node 22 already ships `fetch`. The cost of that choice is that this file owns
 * its own timeouts and error classification, which is why every call goes through
 * `request()` with an `AbortSignal.timeout`.
 *
 * The other thing to know: the panel's tree is connection → database → index list, and
 * Elasticsearch has nothing to put in the middle, so `listDatabases()` answers with
 * the one synthetic name `indices` and every other method ignores the database it is
 * handed.
 *
 * @module dsh-plugin-otools-dbm/host/engines/elasticsearch
 */
import {
  boundedInt,
  classifyConnectionError,
  connectionErrorMessage,
  DbmError,
  ERR,
} from '../../shared/protocol.js'

import { unsupported } from './contract.js'
import { columnsFromRows, elapsedSince, queryResult } from './result.js'
import { FILTER_OPERATORS } from './sql-engine.js'

/** The synthetic database name the tree shows above the index list. */
const DATABASE = 'indices'

/** Every call is bounded: a cluster under load answers slowly or not at all. */
const REQUEST_TIMEOUT_MS = 15000

/** `from + size` past this is a hard error in ES (`index.max_result_window`). */
const MAX_RESULT_WINDOW = 10000

/** Methods the console may use. */
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'])

/** Hit metadata the grid displays but a document may not contain. */
const METADATA_FIELDS = new Set([
  '_id',
  '_index',
  '_type',
  '_score',
  '_routing',
  '_source',
  '_seq_no',
  '_primary_term',
  '_version',
  '_ignored',
])

/** The console's format, shown whenever the first line is not one. */
const USAGE = [
  'Elasticsearch 控制台的格式是：第一行写 METHOD /路径，之后是可选的 JSON 请求体，例如',
  'GET /my-index/_search',
  '{"query": {"match_all": {}}, "size": 10}',
].join('\n')

export class ElasticsearchEngine {
  /** @param connection - the stored DbConnection record. */
  constructor(connection) {
    this.connection = connection ?? {}
    this.kind = 'elasticsearch'
    this.dbType = 'elasticsearch'
    this.closed = false
  }

  /** `http(s)://host:port`, no trailing slash. */
  baseUrl() {
    const raw = String(this.connection.host ?? '').trim()
    if (/^https?:\/\//i.test(raw)) {
      // A pasted URL already answers the scheme question.
      return raw.replace(/\/+$/, '')
    }
    const port = Number(this.connection.port) || 9200
    // 443 and 9243 are the ports a hosted cluster listens on and both are TLS-only;
    // guessing http there fails every request with a protocol error instead of a
    // certificate one, which is a confusing way to find out.
    const secure = this.connection.ssl === true
      || this.connection.use_ssl === true
      || port === 443
      || port === 9243
    return `${secure ? 'https' : 'http'}://${raw.length > 0 ? raw : '127.0.0.1'}:${port}`
  }

  /** Request headers, with HTTP Basic auth when the connection has a user. */
  headers(contentType) {
    const headers = { accept: 'application/json' }
    if (contentType !== undefined) {
      headers['content-type'] = contentType
    }
    const user = String(this.connection.username ?? '')
    if (user.length > 0) {
      const token = Buffer.from(`${user}:${String(this.connection.password ?? '')}`).toString('base64')
      headers.authorization = `Basic ${token}`
    }
    return headers
  }

  /**
   * One REST call. A string `body` is sent verbatim (that is how `_bulk` NDJSON has
   * to travel); anything else is JSON-encoded.
   */
  async request(method, path, body) {
    if (this.closed) {
      throw new DbmError(ERR.connectionClosed, '连接已关闭，请重新连接')
    }
    const hasBody = body !== undefined && body !== null
    const raw = typeof body === 'string'
    // Node's fetch throws on a GET with a body, and the Kibana convention writes
    // `GET /index/_search` with one. ES treats POST and GET the same for a search, so
    // the method is promoted rather than the body dropped.
    const verb = hasBody && (method === 'GET' || method === 'HEAD') ? 'POST' : method
    const init = {
      method: verb,
      headers: this.headers(hasBody ? (raw ? 'application/x-ndjson' : 'application/json') : undefined),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
    if (hasBody) {
      init.body = raw ? body : JSON.stringify(body)
    }

    let response
    try {
      response = await fetch(`${this.baseUrl()}${path.startsWith('/') ? path : `/${path}`}`, init)
    } catch (error) {
      // Everything network-shaped lands here: DNS, refused socket, TLS, and the
      // AbortError the timeout raises.
      throw connectionFailure(error)
    }
    const payload = await readPayload(response)
    if (!response.ok) {
      throw responseFailure(response, payload)
    }
    return payload
  }

  /** Liveness probe; never throws. */
  async ping() {
    try {
      await this.request('GET', '/')
      return true
    } catch {
      return false
    }
  }

  /**
   * Nothing to release: `fetch` uses undici's global pool, which this plugin does not
   * own. The flag is here so a closed connection fails the way the others do.
   */
  async close() {
    this.closed = true
  }

  // ------------------------------------------------------------- introspection
  async listDatabases() {
    // The tree needs one level above the index list and ES has nothing to put there,
    // so it gets a synthetic name that every other method then ignores.
    return [DATABASE]
  }

  async listSchemas() {
    return []
  }

  async listTables() {
    const rows = await this.request('GET', '/_cat/indices?format=json&h=index')
    // A dot-prefixed index is ES's own bookkeeping (.security, .kibana, .ds-*): left
    // in, it buries the user's three indices under twenty system ones.
    return sorted(asArray(rows).map((row) => text(row?.index)).filter((name) => !name.startsWith('.')))
  }

  /** Aliases are the closest thing ES has to a view. */
  async listViews() {
    const rows = await this.request('GET', '/_cat/aliases?format=json&h=alias')
    return sorted(unique(asArray(rows).map((row) => text(row?.alias)).filter((name) => !name.startsWith('.'))))
  }

  async listProcedures() {
    return []
  }

  /** An alias's own definition (filter, routing) as pretty JSON. */
  async viewDefinition(_database, view) {
    const name = text(view)
    if (name.length === 0) {
      return ''
    }
    try {
      const payload = await this.request('GET', `/_alias/${encodeURIComponent(name)}`)
      return JSON.stringify(payload ?? {}, null, 2)
    } catch {
      // An alias that has since been removed is not worth an error dialog.
      return ''
    }
  }

  async procedureDefinition() {
    return ''
  }

  async createTableStatement() {
    // An index is created by a mapping PUT, not by DDL; the console is where that
    // belongs, so there is nothing honest to hand back here.
    unsupported('Elasticsearch', '建表语句')
  }

  /**
   * An index's mapping, flattened into the panel's column list.
   *
   * The mapping is the only schema ES has, and it is a tree: `user.name` is an object
   * property inside an object property. The grid wants a flat list, so the dotted path
   * is the column name — which is also how the search API refers to it.
   */
  async tableStruct(_database, table) {
    const index = requireIndex(table)
    const payload = await this.request('GET', `/${encodeURIComponent(index)}/_mapping`)
    // The response is keyed by CONCRETE index name, so an alias or a pattern answers
    // with several entries; the first is the one the grid is showing.
    const first = Object.values(payload ?? {})[0]
    const properties = first?.mappings?.properties ?? {}
    return {
      table_name: index,
      // `_id` is not in the mapping but it is in every hit, and `tableData` returns it
      // as the first column, so the designer has to know about it.
      columns: [idColumn(), ...flattenProperties(properties, '')],
      primary_keys: ['_id'],
      foreign_keys: [],
      indexes: [],
      comment: '',
    }
  }

  async stats() {
    const payload = await this.request('GET', '/_cluster/stats')
    const indices = payload?.indices ?? {}
    return {
      databases: [
        {
          // Named after `listDatabases()` rather than after the cluster, so the AI
          // dashboard can line the two up.
          name: DATABASE,
          table_count: number(indices?.count),
          row_count: number(indices?.docs?.count),
          data_size: number(indices?.store?.size_in_bytes),
          // ES reports no separate index size; segment memory is the nearest thing,
          // and 0 on the versions that stopped reporting it.
          index_size: number(indices?.segments?.memory_in_bytes),
        },
      ],
    }
  }

  // ---------------------------------------------------------------- table data
  /**
   * One page of an index.
   *
   * The grid's sort is deliberately NOT forwarded: sorting on a `text` field without a
   * `keyword` sub-field is a 400 from ES, and a click on a column header should not be
   * able to break the page.
   */
  async tableData({ table, limit = 100, offset = 0, filters }) {
    const index = requireIndex(table)
    const started = process.hrtime.bigint()
    const payload = await this.request('POST', `/${encodeURIComponent(index)}/_search`, {
      // `from + size` past the result window is a hard error, so the pager is capped
      // rather than allowed to produce one.
      from: boundedInt(offset, 0, 0, MAX_RESULT_WINDOW),
      size: boundedInt(limit, 100, 1, MAX_RESULT_WINDOW),
      // Without this ES stops counting at 10000 and the pager believes every large
      // index holds exactly 10000 documents.
      track_total_hits: true,
      query: buildQuery(filters),
    })
    return searchResult(payload, elapsedSince(started))
  }

  // ------------------------------------------------------------------- console
  /**
   * The panel's ES console: `METHOD /path` on the first line, an optional JSON body
   * beneath it. That is the Kibana convention, which AirDB copied and which the
   * workbench sends through unchanged.
   */
  async executeScript(script) {
    const body = String(script ?? '').trim()
    if (body.length === 0) {
      throw new DbmError(ERR.invalidInput, '没有可执行的语句')
    }
    const newline = body.indexOf('\n')
    const head = (newline === -1 ? body : body.slice(0, newline)).trim()
    const rest = (newline === -1 ? '' : body.slice(newline + 1)).trim()
    const words = head.split(/\s+/).filter((word) => word.length > 0)
    const method = words.length > 1 ? words[0].toUpperCase() : 'GET'
    const path = words.length > 1 ? words[1] : words[0]
    if (!METHODS.has(method)) {
      throw new DbmError(ERR.invalidInput, `不支持的 HTTP 方法 ${method}。${USAGE}`)
    }
    if (!path.startsWith('/')) {
      throw new DbmError(ERR.invalidInput, USAGE)
    }
    // A one-liner (`GET /idx/_search {"query": …}`) is common enough to accept: what
    // follows the path on the first line is the beginning of the body.
    const tail = [words.slice(2).join(' '), rest].filter((part) => part.length > 0).join('\n')

    const started = process.hrtime.bigint()
    // A `_bulk` body is NDJSON rather than JSON: it goes through verbatim and needs
    // its closing newline, or ES rejects the last action in it.
    const requestBody = tail.length === 0
      ? undefined
      : (path.includes('_bulk') ? `${tail}\n` : parseJson(tail))
    const payload = await this.request(method, path, requestBody)
    const executionTime = elapsedSince(started)

    if (path.includes('_search') && payload?.hits !== undefined) {
      return searchResult(payload, executionTime)
    }
    return queryResult({
      columns: ['response'],
      rows: [[JSON.stringify(payload ?? null, null, 2)]],
      rowCount: 1,
      executionTime,
    })
  }

  /** The workbench's single-statement path. */
  async run(script, options = {}) {
    return this.executeScript(script, options)
  }

  // ------------------------------------------------------------------ grid save
  /**
   * The grid's save path, document by document.
   *
   * `refresh=wait_for` on every write is not politeness: ES is near-real-time, the
   * default refresh interval is a second, and the grid reloads immediately after
   * saving — without it the user watches their own edit fail to appear.
   */
  async saveRows({ table, changes }) {
    const index = requireIndex(table)
    const prefix = `/${encodeURIComponent(index)}`
    const added = Array.isArray(changes?.added) ? changes.added : []
    const modified = Array.isArray(changes?.modified) ? changes.modified : []
    const deleted = Array.isArray(changes?.deleted) ? changes.deleted : []

    // Validate everything before writing anything, so `validate_only` is this same
    // path with the requests skipped.
    const inserts = added.map((row) => ({ id: optionalDocumentId(row), source: sourceOf(row) }))
    const updates = modified.map((entry) => ({
      id: requireDocumentId(entry?.current ?? entry?.original),
      source: sourceOf(entry?.current),
    }))
    const removals = deleted.map((row) => requireDocumentId(row))

    if (changes?.validate_only === true) {
      return { inserted: inserts.length, updated: updates.length, deleted: removals.length }
    }

    let inserted = 0
    for (const insert of inserts) {
      // No id means "let ES generate one", which is the normal way to append.
      const path = insert.id === undefined
        ? `${prefix}/_doc?refresh=wait_for`
        : `${prefix}/_doc/${encodeURIComponent(insert.id)}?refresh=wait_for`
      await this.request(insert.id === undefined ? 'POST' : 'PUT', path, insert.source)
      inserted += 1
    }
    let updated = 0
    for (const update of updates) {
      // `_update` with `doc` MERGES, so a field the grid never displayed survives the
      // save; a `PUT /_doc/<id>` would silently drop it.
      await this.request('POST', `${prefix}/_update/${encodeURIComponent(update.id)}?refresh=wait_for`, {
        doc: update.source,
      })
      updated += 1
    }
    let removed = 0
    for (const id of removals) {
      await this.request('DELETE', `${prefix}/_doc/${encodeURIComponent(id)}?refresh=wait_for`)
      removed += 1
    }
    return { inserted, updated, deleted: removed }
  }
}

/** Factory the engine registry calls. */
export function createElasticsearchEngine(connection) {
  return new ElasticsearchEngine(connection)
}

/** A transport failure, in the code the panel localizes. */
function connectionFailure(error) {
  const kind = classifyConnectionError(error)
  const detail = String(error?.message ?? error ?? '')
  return new DbmError('elasticsearch_conn', connectionErrorMessage('elasticsearch', kind, detail), { cause: error })
}

/** A non-2xx response, with ES's own `error.reason` as the detail. */
function responseFailure(response, payload) {
  const reason = text(payload?.error?.reason)
    || text(payload?.error?.type)
    || (typeof payload === 'string' ? payload : '')
    || `HTTP ${response.status}`
  if (response.status === 401 || response.status === 403) {
    // Send it through the same classifier the SQL drivers use, so the panel shows its
    // localized "认证失败" sentence rather than a raw 403.
    return new DbmError('elasticsearch_conn', connectionErrorMessage('elasticsearch', 'AUTH', reason))
  }
  if (response.status === 404) {
    return new DbmError(ERR.notFound, `Elasticsearch 找不到目标：${reason}`)
  }
  return new DbmError(ERR.internal, `Elasticsearch 返回 ${response.status}：${reason}`)
}

/** Response body as JSON when it is JSON, as text when it is not. */
async function readPayload(response) {
  const body = await response.text().catch(() => '')
  if (body.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/** JSON.parse with a message that names the problem. */
function parseJson(body) {
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new DbmError(ERR.invalidInput, `请求体不是合法 JSON：${String(error?.message ?? error)}\n${USAGE}`)
  }
}

/**
 * A `_search` response as a QueryResult.
 *
 * `_id` leads the columns because it is the only handle `saveRows` has on a document;
 * everything after it is the union of the `_source` keys, which is what the grid needs
 * when documents in one index disagree about their fields.
 */
function searchResult(payload, executionTime) {
  const hits = asArray(payload?.hits?.hits)
  const rows = hits.map((hit) => ({ _id: text(hit?._id), ...(hit?._source ?? {}) }))
  const total = payload?.hits?.total
  const count = typeof total === 'number' ? total : number(total?.value)
  return queryResult({
    columns: columnsFromRows(rows),
    rows,
    rowCount: hits.length === 0 ? count : Math.max(count, hits.length),
    executionTime,
  })
}

/** The `_id` pseudo-column every hit carries. */
function idColumn() {
  return {
    name: '_id',
    data_type: 'keyword',
    is_nullable: false,
    default_value: null,
    is_primary_key: true,
    character_maximum_length: null,
    column_comment: '文档主键 _id',
  }
}

/**
 * Mapping properties → flat ColumnSchema rows, keyed by dotted path.
 *
 * Multi-fields (`"fields": {"keyword": …}`) are skipped: they are the same data indexed
 * a second way, and listing them would double every text column in the designer.
 */
function flattenProperties(properties, prefix) {
  const columns = []
  for (const [name, definition] of Object.entries(properties ?? {})) {
    const path = prefix.length === 0 ? name : `${prefix}.${name}`
    const nested = definition?.properties
    if (nested !== undefined && nested !== null) {
      columns.push(...flattenProperties(nested, path))
      continue
    }
    columns.push({
      name: path,
      data_type: text(definition?.type) || 'object',
      // Every ES field is optional; documents in one index need not agree.
      is_nullable: true,
      default_value: definition?.null_value ?? null,
      is_primary_key: false,
      character_maximum_length: null,
      column_comment: '',
    })
  }
  return columns
}

/**
 * The panel's `field_OPERATOR` map as an ES query.
 *
 * `=` becomes a `term`, which is exact and UNANALYZED: on a `text` field that only
 * matches when the stored value is a single token in the same case, so a filter on a
 * full-text column usually wants `field.keyword`. That is ES's semantics rather than
 * this port's choice, and the panel passes the field name through untouched.
 */
function buildQuery(filters) {
  const must = []
  const mustNot = []
  for (const [key, value] of Object.entries(filters ?? {})) {
    const operator = FILTER_OPERATORS.find((candidate) => key.endsWith(`_${candidate}`))
    if (operator === undefined) {
      continue
    }
    const field = key.slice(0, key.length - operator.length - 1)
    if (field.length === 0) {
      continue
    }
    switch (operator) {
      case 'IS_NULL':
        // "Missing" and "null" are the same thing to ES: neither is indexed.
        mustNot.push({ exists: { field } })
        break
      case 'IS_NOT_NULL':
        must.push({ exists: { field } })
        break
      case 'LIKE':
        must.push({ wildcard: { [field]: wildcardValue(value) } })
        break
      case 'NOT_LIKE':
        mustNot.push({ wildcard: { [field]: wildcardValue(value) } })
        break
      case '>':
        must.push({ range: { [field]: { gt: comparable(value) } } })
        break
      case '<':
        must.push({ range: { [field]: { lt: comparable(value) } } })
        break
      case '>=':
        must.push({ range: { [field]: { gte: comparable(value) } } })
        break
      case '<=':
        must.push({ range: { [field]: { lte: comparable(value) } } })
        break
      case '!=':
        mustNot.push({ term: { [field]: value } })
        break
      default:
        must.push({ term: { [field]: value } })
    }
  }
  if (must.length === 0 && mustNot.length === 0) {
    return { match_all: {} }
  }
  const bool = {}
  if (must.length > 0) {
    bool.must = must
  }
  if (mustNot.length > 0) {
    bool.must_not = mustNot
  }
  return { bool }
}

/**
 * A SQL `LIKE` value as an ES wildcard pattern: `%` → `*`, `_` → `?`, and a value with
 * no wildcard at all wrapped in `*…*`, mirroring `sql-engine.js` so the same filter
 * behaves the same on MySQL and here.
 */
function wildcardValue(value) {
  const raw = String(value ?? '')
  const wrapped = raw.includes('%') || raw.includes('_') ? raw : `*${raw}*`
  return wrapped.replace(/%/g, '*').replace(/_/g, '?')
}

/** A range bound: numeric text becomes a number, everything else stays text. */
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

/** An index name the panel supplied. */
function requireIndex(table) {
  const name = text(table)
  if (name.length === 0) {
    throw new DbmError(ERR.invalidInput, '索引名不能为空')
  }
  return name
}

/**
 * `_source` of a grid row: the document without the metadata the search API added.
 *
 * ES refuses a document that tries to set `_id` or any other metadata field
 * ("Field [_id] is a metadata field and cannot be added inside a document"), and the
 * grid hands them back because it displayed them. A user field named `_custom` is
 * left alone, which is why this is a fixed list rather than a `_`-prefix test.
 */
function sourceOf(row) {
  const source = {}
  for (const [key, value] of Object.entries(row ?? {})) {
    if (METADATA_FIELDS.has(key) || key.startsWith('__')) {
      continue
    }
    source[key] = value
  }
  return source
}

/** `_id` of a row, or `undefined` when ES should generate one. */
function optionalDocumentId(row) {
  const id = text(row?._id)
  return id.length === 0 ? undefined : id
}

/** `_id` of a row, or a message the user can act on. */
function requireDocumentId(row) {
  const id = optionalDocumentId(row)
  if (id === undefined) {
    throw new DbmError(ERR.invalidInput, '这一行没有 _id，Elasticsearch 无法定位文档，请刷新数据后重试')
  }
  return id
}

const asArray = (value) => (Array.isArray(value) ? value : [])

const sorted = (names) => names.filter((name) => name.length > 0).sort((a, b) => a.localeCompare(b))

const unique = (names) => Array.from(new Set(names))

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

