/**
 * The proxied-request ledger and the in-flight counter.
 *
 * The reference records one `usage_events` row per proxied request and computes the
 * per-account statistics the accounts list shows (`request_count`, `success_rate`,
 * `avg_recent_duration_ms`) with SQL over `metadata_json`. Here the rows live in one
 * capped JSON file and the aggregation is a fold — same numbers, no query planner.
 *
 * Two things are deliberate:
 *
 * 1. Writes are DEBOUNCED. A ledger write per proxied request would put an fsync in the
 *    request path; a burst of 200 streaming requests would spend more time in the
 *    filesystem than in the upstream. Losing the last second of statistics to a crash is
 *    an acceptable trade for that, and nothing else depends on the file.
 * 2. `Activity` is memory-only, like the reference's `Arc<Mutex<HashMap>>`: after a
 *    restart nothing is in flight, and persisting a count would strand accounts at their
 *    concurrency ceiling forever.
 *
 * @module dsh-plugin-ai-switch/host/ledger
 */
import { nowIso } from '../shared/protocol.js'
import { uuid } from './sdk.js'

/** How many request rows the ledger keeps. Older ones fall off the front. */
export const LEDGER_LIMIT = 5000

/** Successes whose durations feed `avg_recent_duration_ms`. */
const RECENT_DURATION_WINDOW = 10

/** Rows the pool panel shows without paging. */
const RECENT_LOG_LIMIT = 20

/** In-flight request counts per account, plus the event the UI animates on. */
export class Activity {
  /** @param emit - `(channel, payload) => void`, the panel socket broadcaster. */
  constructor(emit = () => {}) {
    this.counts = new Map()
    this.emit = emit
  }

  count(accountId) {
    return this.counts.get(accountId) ?? 0
  }

  begin(accountId, { platform, maxConcurrency }) {
    const next = this.count(accountId) + 1
    this.counts.set(accountId, next)
    this.#announce(accountId, platform, maxConcurrency, next)
    return () => this.end(accountId, { platform, maxConcurrency })
  }

  end(accountId, { platform, maxConcurrency } = {}) {
    const next = Math.max(0, this.count(accountId) - 1)
    if (next === 0) {
      this.counts.delete(accountId)
    } else {
      this.counts.set(accountId, next)
    }
    this.#announce(accountId, platform, maxConcurrency, next)
  }

  #announce(accountId, platform, maxConcurrency, active) {
    this.emit('route-credential-activity', {
      platform: platform ?? null,
      credential_id: accountId,
      active_request_count: active,
      max_concurrency: maxConcurrency ?? null,
    })
  }
}

/** One row per proxied request, plus every aggregation the panel asks for. */
export class UsageLedger {
  constructor({ store, limit = LEDGER_LIMIT, flushMs = 2000 }) {
    this.store = store
    this.limit = limit
    this.flushMs = flushMs
    this.events = []
    this.dirty = false
    this.timer = null
    this.loaded = false
  }

  /** Read the file once, at host start. */
  async load() {
    if (this.loaded) {
      return
    }
    const document = await this.store.read()
    this.events = Array.isArray(document.events) ? document.events : []
    this.loaded = true
  }

  /** Append one request. Returns the stored row so a caller can log its id. */
  record(input) {
    const row = {
      id: input.id ?? uuid(),
      occurred_at: input.occurredAt ?? nowIso(),
      platform: input.platform ?? null,
      account_id: input.accountId ?? null,
      account_name: input.accountName ?? null,
      source_label: input.sourceLabel ?? 'route_proxy',
      model: input.model ?? null,
      upstream_model: input.upstreamModel ?? null,
      path: input.path ?? null,
      status: input.status ?? null,
      success: input.success !== false,
      duration_ms: Number.isFinite(input.durationMs) ? Math.trunc(input.durationMs) : null,
      input_tokens: toCount(input.inputTokens),
      output_tokens: toCount(input.outputTokens),
      cache_read_tokens: toCount(input.cacheReadTokens),
      cache_write_tokens: toCount(input.cacheWriteTokens),
      price_usd_micros: Number.isFinite(input.priceUsdMicros) ? Math.trunc(input.priceUsdMicros) : null,
      price_source: input.priceSource ?? null,
      upstream_response_id: input.upstreamResponseId ?? null,
      metadata_json: typeof input.metadataJson === 'string' ? input.metadataJson : '{}',
      error_message: typeof input.errorMessage === 'string' ? input.errorMessage.slice(0, 500) : null,
    }
    this.events.push(row)
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit)
    }
    this.#schedule()
    return row
  }

  #schedule() {
    this.dirty = true
    if (this.timer !== null) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushMs)
    this.timer.unref?.()
  }

  /** Write the ledger out now. Called on dispose and by the debounce. */
  async flush() {
    if (!this.dirty) {
      return
    }
    this.dirty = false
    await this.store.update((document) => {
      document.events = this.events
    })
  }

  async dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  /** Every row, newest last — what the usage overview merges against. */
  all() {
    return this.events
  }

  /** The six per-account statistics columns on the accounts list. */
  statsFor(accountId) {
    const rows = this.events.filter((row) => row.account_id === accountId)
    if (rows.length === 0) {
      return null
    }
    const success = rows.filter((row) => row.success).length
    const durations = rows
      .filter((row) => row.success && Number.isFinite(row.duration_ms))
      .slice(-RECENT_DURATION_WINDOW)
      .map((row) => row.duration_ms)
    const last = rows[rows.length - 1]
    return {
      request_count: rows.length,
      success_count: success,
      failure_count: rows.length - success,
      success_rate: rows.length === 0 ? null : Math.round((success / rows.length) * 10_000) / 100,
      last_duration_ms: Number.isFinite(last.duration_ms) ? last.duration_ms : null,
      avg_recent_duration_ms:
        durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    }
  }

  /** The counters and the paged request log under one platform's pool. */
  poolStats(platform, { memberCount = 0, since = null, requestPage = null, requestPageSize = null } = {}) {
    const cutoff = since === null ? null : Date.parse(since)
    const rows = this.events
      .filter((row) => row.platform === platform)
      .filter((row) => cutoff === null || Number.isNaN(cutoff) || Date.parse(row.occurred_at) >= cutoff)
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(String(requestPageSize ?? 20), 10) || 20))
    const rowCount = rows.length
    const pageCount = Math.max(1, Math.ceil(rowCount / pageSize))
    const page = Math.min(Math.max(1, Number.parseInt(String(requestPage ?? 1), 10) || 1), pageCount)
    const newestFirst = rows.slice().reverse()
    const totals = rows.reduce(
      (sum, row) => ({
        input: sum.input + (row.input_tokens ?? 0),
        output: sum.output + (row.output_tokens ?? 0),
        cache: sum.cache + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0),
        cost: sum.cost + (row.price_usd_micros ?? 0),
      }),
      { input: 0, output: 0, cache: 0, cost: 0 },
    )
    return {
      member_count: memberCount,
      request_count: rowCount,
      token_count: totals.input + totals.output,
      input_token_count: totals.input,
      output_token_count: totals.output,
      cache_token_count: totals.cache,
      cost_micros: totals.cost,
      recent_logs: newestFirst.slice(0, RECENT_LOG_LIMIT).map(toUsageLog),
      requests: newestFirst.slice((page - 1) * pageSize, page * pageSize).map(toUsageLog),
      request_row_count: rowCount,
      request_page: page,
      request_page_size: pageSize,
    }
  }
}

function toCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
}

/** One ledger row in the `RoutePoolUsageLog` shape the panel renders. */
function toUsageLog(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    source_label: row.source_label,
    metric_type: 'request',
    amount: 1,
    unit: 'request',
    metadata_json: JSON.stringify({
      ...safeParse(row.metadata_json),
      success: row.success,
      duration_ms: row.duration_ms,
      path: row.path,
      status: row.status,
      upstream_model: row.upstream_model,
      model: row.model,
      ...(row.error_message === null ? {} : { error: row.error_message }),
    }),
    created_at: row.occurred_at,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_tokens: (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0),
    price_usd_micros: row.price_usd_micros,
    price_cny_micros: null,
    price_currency: row.price_usd_micros === null ? null : 'usd',
    price_source: row.price_source,
  }
}

function safeParse(text) {
  try {
    const parsed = JSON.parse(String(text ?? '{}'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}



