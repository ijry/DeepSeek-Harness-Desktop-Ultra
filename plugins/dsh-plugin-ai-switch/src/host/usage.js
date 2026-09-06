/**
 * Token usage and cost, read out of the agent CLIs' own transcript files.
 *
 * Complements the proxy ledger: the ledger only sees traffic that went through this
 * plugin's route proxy, while Claude Code and Codex also record every request they made
 * directly. Reading their transcripts is what lets one set of totals mean "my total
 * spend" instead of "the part I happened to route through here".
 *
 * Two provider formats, each with a counting rule that must not be got wrong. Both are
 * transcribed from the reference's `session_usage_service.rs`, whose module header
 * records what happened when they were:
 *
 * * **Claude Code** (`~/.claude/projects/**\/*.jsonl`) — one JSON object per line;
 *   assistant messages carry `message.usage`. Resume and compaction re-serialize the
 *   same message into several files, so rows are deduplicated by `message.id`. On a real
 *   machine that cut a 4020-row scan to 2008 unique messages — counting raw lines
 *   overstated cost by 93%. Implemented in `parseClaudeFile` (the key) and in the scan
 *   loop (the one cross-file, cross-root `seen` set).
 * * **Codex CLI** (`~/.codex/sessions/**\/*.jsonl`) — `token_count` events whose
 *   `total_token_usage` is **cumulative for the session**, not per turn, so each turn is
 *   the difference from the previous event. Summing them overstated one real file by
 *   350x (28.1B tokens against an actual 80.5M). A forked rollout also opens with the
 *   parent's history replayed, which is the parent's spend and must not be counted
 *   again. Implemented in `parseCodexFile` and `codexDelta`.
 *
 * Wire shapes are the reference's, field for field: the panel is its React front end
 * unmodified, so everything this module returns is **snake_case** (`request_count`,
 * `cost_micros`, `by_platform`, …). `sessions.js` next door is the one camelCase
 * payload in this domain.
 *
 * @module dsh-plugin-ai-switch/host/usage
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { validation } from '../shared/protocol.js'

import { userHome } from './sdk.js'
import { collectSessionFiles, envPath, parseRfc3339Millis, readLines } from './sessions.js'

/**
 * Usage scans read the full history rather than a recent window, so the cap only exists
 * to bound pathological directories. Well above the ~1.2k files a heavy user
 * accumulates; when it does trip, the truncation is reported rather than passed off as
 * a complete total.
 */
const USAGE_SCAN_FILE_LIMIT = 50000

/** Directory depth limit, matching the session list's traversal. */
const USAGE_SCAN_DEPTH = 8

/** Only the two providers that record usage write these. */
const USAGE_EXTENSIONS = ['jsonl']

/**
 * How many transcripts to parse at once.
 *
 * A cold scan reads every line of every transcript — on a real machine that is 1800 files
 * and gigabytes, and sequentially it takes ~37 seconds, which is long enough that the usage
 * screen looks broken on first open. The `(mtimeMs, size)` cache makes later scans instant;
 * this is about the first one.
 */
const PARSE_CONCURRENCY = 16

/** Run `task` over `items` with at most `limit` in flight, preserving input order. */
async function mapConcurrent(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) {
        return
      }
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Cap on cached file parses; cleared wholesale when exceeded. */
const MAX_CACHED_FILES = 8192

/** Micro-units per currency unit. 1 USD == 1_000_000 micros. */
const PRICE_MICROS_PER_UNIT = 1000000

/** CNY per USD, used to normalize an upstream price quoted in yuan. */
const CNY_PER_USD = 7.1

/** Cache writes are billed above the base input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25

/** Cache reads are billed well below the base input rate. */
const CACHE_READ_MULTIPLIER = 0.1

function rate(inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheWritePerMtok) {
  return { inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheWritePerMtok }
}

/**
 * Substring patterns matched against a normalized model id, most specific first —
 * `claude-haiku` must be tested before `claude` would be.
 *
 * Only families are listed rather than every dated snapshot, so a newly released
 * `claude-opus-6` still resolves to the Opus rate instead of silently costing nothing.
 * The odd-looking cache rates (0.30000000000000004) are the reference's literals, which
 * are `input * 0.1` in binary floating point; keeping them exact keeps a cost computed
 * here equal to the desktop app's to the micro.
 */
const STATIC_RATES = [
  ['claude-haiku', rate(1.0, 5.0, 0.1, 1.25)],
  ['claude-sonnet', rate(3.0, 15.0, 0.30000000000000004, 3.75)],
  ['claude-fable', rate(10.0, 50.0, 1.0, 12.5)],
  ['claude-mythos', rate(10.0, 50.0, 1.0, 12.5)],
  ['claude-opus', rate(5.0, 25.0, 0.5, 6.25)],
  // Legacy Anthropic ids, ordered "3-5-haiku" before "3-opus" would match.
  ['haiku', rate(1.0, 5.0, 0.1, 1.25)],
  ['sonnet', rate(3.0, 15.0, 0.30000000000000004, 3.75)],
  ['opus', rate(5.0, 25.0, 0.5, 6.25)],
  ['gpt-5', rate(1.25, 10.0, 0.125, 1.5625)],
  ['gpt-4o-mini', rate(0.15, 0.6, 0.015, 0.1875)],
  ['gpt-4o', rate(2.5, 10.0, 0.25, 3.125)],
  ['o4-mini', rate(1.1, 4.4, 0.11000000000000001, 1.375)],
  ['gemini-2.5-pro', rate(1.25, 10.0, 0.125, 1.5625)],
  ['gemini-2.5-flash', rate(0.3, 2.5, 0.03, 0.375)],
  ['gemini', rate(0.3, 2.5, 0.03, 0.375)],
  ['grok', rate(3.0, 15.0, 0.30000000000000004, 3.75)],
]

/**
 * Reduce a raw model id to a comparable key.
 *
 * Transcripts and gateways decorate ids in ways that must not defeat matching: vendor
 * prefixes (`anthropic/claude-opus-5-aws`), context suffixes (`claude-opus-4-8[1m]`),
 * and surrounding whitespace.
 *
 * `null` for an id that never corresponds to billable upstream usage — notably Claude
 * Code's `<synthetic>` marker for locally generated messages.
 */
export function normalizeModelId(model) {
  const trimmed = String(model ?? '').trim()
  if (trimmed.length === 0 || trimmed.startsWith('<')) {
    return null
  }
  const tail = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const base = tail.toLowerCase().split('[')[0].trim()
  return base.length === 0 ? null : base
}

/**
 * Normalize a `model-prices.json` object into a lookup for `priceFor`.
 *
 * A malformed entry is dropped rather than thrown, as the reference's
 * `load_overrides_from_str` does: a bad hand edit should degrade to the built-in table,
 * not blank the whole statistics page. Cache rates default to Anthropic's published
 * multipliers when the entry leaves them out.
 */
export function loadPriceTable(configs) {
  const overrides = new Map()
  if (configs === null || typeof configs !== 'object' || Array.isArray(configs)) {
    return { overrides }
  }
  for (const [model, config] of Object.entries(configs)) {
    const parsed = priceFromConfig(config)
    if (parsed === null) {
      continue
    }
    overrides.set(normalizeModelId(model) ?? String(model).toLowerCase(), parsed)
  }
  return { overrides }
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function priceFromConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return null
  }
  if (!nonNegative(config.input_per_mtok) || !nonNegative(config.output_per_mtok)) {
    return null
  }
  // Present-but-invalid drops the entry; absent falls back to the multiplier.
  for (const key of ['cache_read_per_mtok', 'cache_write_per_mtok']) {
    const value = config[key]
    if (value !== undefined && value !== null && !nonNegative(value)) {
      return null
    }
  }
  return rate(
    config.input_per_mtok,
    config.output_per_mtok,
    config.cache_read_per_mtok ?? config.input_per_mtok * CACHE_READ_MULTIPLIER,
    config.cache_write_per_mtok ?? config.input_per_mtok * CACHE_WRITE_MULTIPLIER,
  )
}

/**
 * The per-million-token rates for a model: a user override first, then the built-in
 * table. `null` when the model is unbillable or unrecognized — callers must record the
 * request as unpriced rather than as free.
 */
export function priceFor(table, model) {
  const key = normalizeModelId(model)
  if (key === null) {
    return null
  }
  const overrides = table?.overrides
  if (overrides instanceof Map && overrides.size > 0) {
    const exact = overrides.get(key)
    if (exact !== undefined) {
      return exact
    }
    // Longest matching family pattern, so an override keyed `claude-opus` still applies
    // to `claude-opus-5-aws`.
    let best = null
    let bestLength = -1
    for (const [pattern, value] of overrides) {
      if (pattern.length >= bestLength && key.includes(pattern)) {
        best = value
        bestLength = pattern.length
      }
    }
    if (best !== null) {
      return best
    }
  }
  for (const [pattern, value] of STATIC_RATES) {
    if (key.includes(pattern)) {
      return value
    }
  }
  return null
}

/**
 * The cost of `usage` at `price`, in USD micros.
 *
 * `price` must be a rate from `priceFor`; a `null` price means the model is unpriced and
 * is the caller's business, because a request that costs an unknown amount must not be
 * reported as one that costs nothing. The two-step division mirrors the reference's
 * arithmetic exactly so both sides round the same way.
 */
export function costMicros(usage, price) {
  if (price === null || price === undefined) {
    return 0
  }
  const billable = (value) => Math.max(0, Number.isFinite(value) ? value : 0)
  const dollars =
    (billable(usage?.inputTokens) * price.inputPerMtok +
      billable(usage?.cacheWriteTokens) * price.cacheWritePerMtok +
      billable(usage?.cacheReadTokens) * price.cacheReadPerMtok +
      billable(usage?.outputTokens) * price.outputPerMtok) /
    1000000
  return Math.round(dollars * PRICE_MICROS_PER_UNIT)
}

/** Convert a CNY amount in micros to USD micros. */
function cnyMicrosToUsdMicros(cnyMicros) {
  return Math.round(cnyMicros / CNY_PER_USD)
}

/**
 * The inclusive-start, exclusive-end epoch-millisecond filter `since` describes.
 *
 * An unparseable `since` is rejected rather than widened to "all time": silently
 * treating a bad timestamp as the full history would inflate the figures shown for a
 * narrow period. Blank and absent both mean the full history.
 */
export function parseWindow(since) {
  const text = String(since ?? '').trim()
  if (text.length === 0) {
    return { startMs: null, endMs: null }
  }
  const startMs = parseRfc3339Millis(text)
  if (startMs === null) {
    throw validation(
      'validation.invalid_timestamp',
      '`since` must be an RFC 3339 timestamp',
      text,
    )
  }
  return { startMs, endMs: null }
}

function windowContains(window, timestampMs) {
  if (timestampMs === null) {
    // An entry with no timestamp is only counted for an unbounded window, so a period
    // filter cannot silently absorb undated rows.
    return window.startMs === null && window.endMs === null
  }
  if (window.startMs !== null && timestampMs < window.startMs) {
    return false
  }
  return !(window.endMs !== null && timestampMs >= window.endMs)
}

/**
 * Roots to scan for Claude Code transcripts. `CLAUDE_CONFIG_DIR` is honoured because a
 * relocated install would otherwise be missed entirely.
 */
function claudeRoots() {
  const home = userHome()
  const configured = envPath('CLAUDE_CONFIG_DIR', join(home, '.claude'))
  const roots = [join(configured, 'projects')]
  const fallback = join(home, '.cache', 'claude', 'projects')
  if (!roots.includes(fallback)) {
    roots.push(fallback)
  }
  return roots
}

/** Roots to scan for Codex CLI transcripts. `CODEX_HOME` is honoured to match. */
function codexRoots() {
  return [join(envPath('CODEX_HOME', join(userHome(), '.codex')), 'sessions')]
}

/** Every transcript root paired with the provider that writes it. */
function scanRoots() {
  return [
    ...claudeRoots().map((root) => [root, 'claude']),
    ...codexRoots().map((root) => [root, 'codex']),
  ]
}

/**
 * Process-wide parse cache, keyed by path and invalidated by `(mtimeMs, size)`.
 *
 * Statistics refresh on a timer while the panel is open and the transcript corpus
 * reaches gigabytes; without this, every refresh would re-read all of it. Transcripts
 * are append-only so size alone would nearly suffice — mtime also catches a rewrite
 * (compaction) that keeps the length the same.
 *
 * Entries are stored un-filtered and un-deduplicated, so one cache entry serves every
 * time window and still takes part in cross-file dedup.
 */
const parseCache = new Map()

/** Drop every cached parse. Exists for the tests, which rewrite fixtures in place. */
export function resetUsageCache() {
  parseCache.clear()
}

async function fileVersion(path) {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

/** The parsed entries of `path`, reusing the cached parse when the file is unchanged. */
async function parsedFile(path, provider) {
  const version = await fileVersion(path)
  const cached = parseCache.get(path)
  if (
    version !== null &&
    cached !== undefined &&
    cached.version.mtimeMs === version.mtimeMs &&
    cached.version.size === version.size
  ) {
    return cached.entries
  }

  const entries =
    provider === 'claude' ? await parseClaudeFile(path) : await parseCodexFile(path)

  if (version !== null) {
    // Bound the map so a long-lived process cannot grow it without limit.
    if (parseCache.size >= MAX_CACHED_FILES) {
      parseCache.clear()
    }
    parseCache.set(path, { version, entries })
  }
  return entries
}

function usage(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) {
  return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }
}

/** A JSON number/string as a non-negative integer, the way the reference coerces it. */
function jsonInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim())
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
  }
  return 0
}

/**
 * Epoch milliseconds for a transcript line. Claude uses an RFC 3339 `timestamp`; Codex
 * uses the same field on the envelope. A bare number small enough to be seconds is
 * treated as seconds.
 */
function entryTimestampMs(entry) {
  const raw = entry.timestamp ?? entry.created_at ?? entry.createdAt
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 100000000000 ? Math.trunc(raw) * 1000 : Math.trunc(raw)
  }
  return typeof raw === 'string' ? parseRfc3339Millis(raw) : null
}

/** One field of a JSON value, `undefined` for anything that is not an object. */
function get(value, key) {
  return value !== null && typeof value === 'object' ? value[key] : undefined
}

function safeParse(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Parse one Claude Code transcript into its billable entries.
 *
 * Sidechain (subagent) messages are included: their tokens are real spend, even though
 * the session *list* hides them. Deduplication and time filtering happen in the scan, so
 * this parse can be cached once and reused for any time window.
 */
async function parseClaudeFile(path) {
  const entries = []
  for await (const line of readLines(path)) {
    // Transcripts are dominated by user turns and tool results that carry no usage. A
    // substring check is far cheaper than parsing every line, and these files run to
    // gigabytes.
    if (line.trim().length === 0 || !line.includes('"usage"')) {
      continue
    }
    const entry = safeParse(line)
    if (entry === null) {
      continue
    }
    const message = get(entry, 'message')
    if (message === undefined || message === null || get(message, 'usage') === undefined) {
      continue
    }

    // `<synthetic>` marks locally generated messages that were never billed;
    // `normalizeModelId` rejects them, and skipping here also keeps them out of the
    // request count.
    const model = get(message, 'model')
    if (typeof model !== 'string' || normalizeModelId(model) === null) {
      continue
    }

    // COUNTING RULE 1 — resume and compaction rewrite the same assistant message into
    // several files, so `message.id` is the cross-file dedup key (applied by the scan's
    // one `seen` set, not here). It is also the upstream response id, which is what
    // joins this entry to a proxy row for the same request. Rows with no id are kept
    // unconditionally: every observed id-less row was a distinct request, and
    // undercounting spend is worse.
    const messageId = typeof get(message, 'id') === 'string' ? message.id : null
    const raw = get(message, 'usage')
    entries.push({
      provider: 'claude',
      model,
      dedupKey: messageId,
      responseId: messageId,
      timestampMs: entryTimestampMs(entry),
      usage: usage(
        jsonInt(get(raw, 'input_tokens')),
        jsonInt(get(raw, 'output_tokens')),
        jsonInt(get(raw, 'cache_creation_input_tokens')),
        jsonInt(get(raw, 'cache_read_input_tokens')),
      ),
    })
  }
  return entries
}

/**
 * Parse one Codex CLI rollout into its per-turn billable entries.
 *
 * COUNTING RULE 2 — `total_token_usage` accumulates over the session, so each turn is
 * the difference from the previous event rather than the value itself. Summing the raw
 * values overstated one real file by 350x (see the module header).
 *
 * `last_token_usage` looks like it would serve directly, but on a real corpus only 12 of
 * 58 comparable files had `Σ(last)` equal the final cumulative total — forked sessions
 * re-report the parent's history. Diffing matched on 76 of 77.
 *
 * A forked rollout replays that parent history at the head of the file, which
 * `replaysParentHistory` skips past.
 */
async function parseCodexFile(path) {
  const entries = []
  let model = null
  let previous = null
  let pendingResponseId = null
  // Set from `session_meta`, cleared at the first `turn_context`.
  let replayingParent = false
  let index = 0

  for await (const line of readLines(path)) {
    if (line.trim().length === 0) {
      continue
    }
    // `session_meta` is always the first line, so the fork marker is read there rather
    // than by testing every line for it.
    if (index === 0) {
      replayingParent = replaysParentHistory(line)
    }
    index += 1
    // Cheap pre-filter: only `turn_context` (the model), `response_item` (the response
    // id) and `token_count` events matter. The fourth test finds a `turn_context` that
    // names no model, which would otherwise leave a replayed prefix open; it is only
    // paid for while one is.
    if (
      !line.includes('token_count') &&
      !line.includes('"model"') &&
      !line.includes('response_item') &&
      !(replayingParent && line.includes('turn_context'))
    ) {
      continue
    }
    const entry = safeParse(line)
    if (entry === null) {
      continue
    }
    const payload = get(entry, 'payload')

    // This thread's first turn begins here, so the replay is over. The response id left
    // pending by the last replayed item belongs to the parent's own entry — attaching it
    // to a turn recorded below would have two entries claim one proxy row.
    if (replayingParent && get(entry, 'type') === 'turn_context') {
      replayingParent = false
      pendingResponseId = null
    }

    const found = get(payload, 'model')
    if (typeof found === 'string' && found.trim().length > 0) {
      model = found
    }

    const responseId = codexAssistantResponseId(payload)
    if (responseId !== null) {
      pendingResponseId = responseId
    }

    if (get(payload, 'type') !== 'token_count') {
      continue
    }
    const total = get(get(payload, 'info'), 'total_token_usage')
    if (total === undefined) {
      continue
    }
    const current = codexCumulative(total)

    // The same cumulative value is emitted 2-3 times in a row; only the first
    // occurrence is a turn.
    if (previous !== null && sameCumulative(previous, current)) {
      continue
    }
    // A negative delta means the session counter reset (fork or resume), so the event
    // starts a fresh running total instead of being diffed.
    const turnUsage =
      previous === null
        ? cumulativeUsage(current)
        : (codexDelta(current, previous) ?? cumulativeUsage(current))
    previous = current

    // Advancing the running total is all a replayed event is good for: the parent's own
    // rollout already counts this spend, and the prefix never states which model
    // produced it.
    if (replayingParent) {
      continue
    }

    entries.push({
      provider: 'codex',
      // A rollout without a recorded model still represents real spend; attribute it to
      // a placeholder so it appears as unpriced rather than vanishing from the totals.
      model: model ?? 'unknown',
      // Codex has no cross-file message id; the response id is the merge key, not a
      // dedup key.
      dedupKey: null,
      responseId: pendingResponseId,
      timestampMs: entryTimestampMs(entry),
      usage: turnUsage,
    })
    pendingResponseId = null
  }
  return entries
}

/**
 * True when a rollout opens with its parent thread's history replayed.
 *
 * Codex writes a fresh file for every subagent spawn and every fork, and some of them
 * begin by dumping the parent's transcript verbatim at the fork instant; only the events
 * after this thread's first `turn_context` are its own work. Counting the prefix charges
 * the parent's spend twice, and because it precedes the `turn_context` that names the
 * model it all lands under `unknown` — on a real corpus that was 413M phantom tokens
 * (6.5% of all Codex tokens) from 8 of 1100 files, every one of whose replayed
 * `token_count` events was found verbatim in the parent's rollout. No unforked file had
 * any usage before its first `turn_context`, so this cannot drop a real turn from one.
 */
function replaysParentHistory(line) {
  // Substring first: the marker keys are absent from most first lines, and a
  // `session_meta` payload is large enough that parsing it is not free.
  if (!line.includes('forked_from_id') && !line.includes('parent_thread_id')) {
    return false
  }
  const entry = safeParse(line)
  if (entry === null || get(entry, 'type') !== 'session_meta') {
    return false
  }
  const payload = get(entry, 'payload')
  return ['forked_from_id', 'parent_thread_id'].some((key) => {
    const value = get(payload, key)
    return typeof value === 'string' && value.trim().length > 0
  })
}

/** Cumulative token counts as Codex reports them, before cache adjustment. */
function codexCumulative(total) {
  return {
    inputTokens: jsonInt(get(total, 'input_tokens')),
    cachedInputTokens: jsonInt(get(total, 'cached_input_tokens')),
    cacheWriteInputTokens: jsonInt(get(total, 'cache_write_input_tokens')),
    // `reasoning_output_tokens` is already part of `output_tokens`; adding it would
    // double-count reasoning.
    outputTokens: jsonInt(get(total, 'output_tokens')),
  }
}

function sameCumulative(left, right) {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens
  )
}

/** This event's own usage, treating the cumulative value as the whole turn. */
function cumulativeUsage(current) {
  // Codex reports `input_tokens` inclusive of `cached_input_tokens`, so the cached
  // portion is subtracted to avoid billing it at the full input rate.
  return usage(
    Math.max(0, current.inputTokens - current.cachedInputTokens),
    current.outputTokens,
    current.cacheWriteInputTokens,
    current.cachedInputTokens,
  )
}

/**
 * Usage attributable to this turn alone, or `null` when any field went backwards (the
 * session counter reset).
 */
function codexDelta(current, previous) {
  const input = current.inputTokens - previous.inputTokens
  const cached = current.cachedInputTokens - previous.cachedInputTokens
  const cacheWrite = current.cacheWriteInputTokens - previous.cacheWriteInputTokens
  const output = current.outputTokens - previous.outputTokens
  if (input < 0 || cached < 0 || cacheWrite < 0 || output < 0) {
    return null
  }
  return usage(Math.max(0, input - cached), output, cacheWrite, cached)
}

/**
 * The upstream Responses uuid embedded in an assistant `response_item` id.
 *
 * `rs_` (reasoning) and `fc_` (function_call) only ever appear in assistant output.
 * `fco_` is the client's own function_call_output, and a `msg_` on a user or developer
 * turn is a client-side conversation id — neither joins to a proxy row, so both are
 * rejected.
 */
function codexAssistantResponseId(payload) {
  const itemType = get(payload, 'type')
  const id = get(payload, 'id')
  if (typeof itemType !== 'string' || typeof id !== 'string') {
    return null
  }
  let uuid = null
  if (itemType === 'reasoning') {
    uuid = stripPrefix(id, 'rs_')
  } else if (itemType === 'function_call') {
    const rest = stripPrefix(id, 'fc_')
    uuid = rest === null ? null : stripTrailingIndex(rest)
  } else if (itemType === 'message' && get(payload, 'role') === 'assistant') {
    uuid = stripPrefix(id, 'msg_')
  }
  return uuid !== null && uuid.trim().length > 0 ? uuid : null
}

function stripPrefix(value, prefix) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

/**
 * Drop the trailing `_<n>` a function-call id carries (`fc_<uuid>_0`) — but only when
 * that segment really is an index.
 *
 * Upstream ids embed underscores of their own (`fc_toolu_bdrk_01MY…`, `fc_call_9wU3…`),
 * so cutting at the last underscore unconditionally collapses every id from such a
 * provider onto one key. That key then matches the wrong proxy row, or none, and the
 * request gets counted on both sides.
 */
function stripTrailingIndex(id) {
  const at = id.lastIndexOf('_')
  if (at <= 0) {
    return id
  }
  const tail = id.slice(at + 1)
  return tail.length > 0 && /^\d+$/.test(tail) ? id.slice(0, at) : id
}

/**
 * Scan the local transcripts and return the deduplicated per-request entries within the
 * window, plus the files read and whether the cap was hit.
 *
 * `truncated` matters: a caller that reports a total from a truncated scan is reporting a
 * floor, not a figure, and the panel says so.
 *
 * @returns `{entries, scannedFileCount, truncated}` — internal camelCase; the wire
 *   shapes are built from these by `getSessionUsageStats` and `getUsageOverview`.
 */
export async function scanSessionUsage({ since = null } = {}) {
  const window = parseWindow(since)
  const entries = []
  let scannedFileCount = 0
  let truncated = false
  // COUNTING RULE 1, second half — one dedup set across every root and provider: the
  // same Claude message appears in both the primary projects directory and the cache
  // mirror, and in every file a resume or compaction rewrote it into.
  const seen = new Set()

  for (const [root, provider] of scanRoots()) {
    const files = await collectSessionFiles(
      root,
      USAGE_EXTENSIONS,
      USAGE_SCAN_DEPTH,
      USAGE_SCAN_FILE_LIMIT,
      [],
    )
    if (files.length >= USAGE_SCAN_FILE_LIMIT) {
      truncated = true
    }
    scannedFileCount += files.length
    // Parse concurrently, then fold in FILE ORDER. The parse is independent per file, but
    // the dedup set is not: which copy of a duplicated message survives has to depend on the
    // file order and nothing else, or two runs over the same disk could disagree.
    const parsedFiles = await mapConcurrent(files, PARSE_CONCURRENCY, (path) => parsedFile(path, provider))
    for (const parsed of parsedFiles) {
      for (const entry of parsed) {
        if (!windowContains(window, entry.timestampMs)) {
          continue
        }
        if (entry.dedupKey !== null) {
          if (seen.has(entry.dedupKey)) {
            continue
          }
          seen.add(entry.dedupKey)
        }
        entries.push(entry)
      }
    }
  }

  return { entries, scannedFileCount, truncated }
}

function emptyTotals() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    cost_micros: 0,
    unpriced_request_count: 0,
  }
}

function addTotals(target, other) {
  for (const key of Object.keys(target)) {
    target[key] += other[key]
  }
}

function totalTokens(totals) {
  return (
    totals.input_tokens +
    totals.output_tokens +
    totals.cache_write_tokens +
    totals.cache_read_tokens
  )
}

/**
 * Roll the transcript entries up per provider and per model.
 *
 * Built on the same `scanSessionUsage` walk the overview uses, so the two surfaces
 * cannot disagree about what a request is. `prices` is an optional `model-prices.json`
 * object; without it the built-in rate table applies.
 *
 * @returns SessionUsageStats
 */
export async function getSessionUsageStats({ since = null, prices = null } = {}) {
  const table = prices === null ? null : loadPriceTable(prices)
  const { entries, scannedFileCount, truncated } = await scanSessionUsage({ since })

  const byModelKey = new Map()
  for (const entry of entries) {
    // JSON, not a joined string: a delimiter a model id could contain would merge two
    // providers' rows.
    const key = JSON.stringify([entry.provider, entry.model])
    let bucket = byModelKey.get(key)
    if (bucket === undefined) {
      // The rate is resolved once per model rather than once per request: a full-history
      // scan hands this loop hundreds of thousands of entries.
      bucket = {
        provider: entry.provider,
        model: entry.model,
        price: priceFor(table, entry.model),
        totals: emptyTotals(),
      }
      byModelKey.set(key, bucket)
    }
    const totals = bucket.totals
    totals.request_count += 1
    totals.input_tokens += Math.max(0, entry.usage.inputTokens)
    totals.output_tokens += Math.max(0, entry.usage.outputTokens)
    totals.cache_write_tokens += Math.max(0, entry.usage.cacheWriteTokens)
    totals.cache_read_tokens += Math.max(0, entry.usage.cacheReadTokens)
    if (bucket.price === null) {
      totals.unpriced_request_count += 1
    } else {
      totals.cost_micros += costMicros(entry.usage, bucket.price)
    }
  }

  const totals = emptyTotals()
  const providerTotals = new Map()
  const byModel = []
  for (const bucket of byModelKey.values()) {
    addTotals(totals, bucket.totals)
    let providerTotal = providerTotals.get(bucket.provider)
    if (providerTotal === undefined) {
      providerTotal = emptyTotals()
      providerTotals.set(bucket.provider, providerTotal)
    }
    addTotals(providerTotal, bucket.totals)
    byModel.push({
      provider: bucket.provider,
      model: bucket.model,
      priced: bucket.price !== null,
      ...bucket.totals,
    })
  }

  // Highest cost first, then by tokens so unpriced rows still order sensibly.
  byModel.sort(
    (left, right) =>
      right.cost_micros - left.cost_micros ||
      totalTokens(right) - totalTokens(left) ||
      compareText(left.model, right.model),
  )

  const byProvider = [...providerTotals.entries()]
    .map(([provider, providerTotal]) => ({
      provider,
      // Empty string on a provider rollup row, as the panel's `SessionUsageRow` expects.
      model: '',
      priced: true,
      ...providerTotal,
    }))
    .sort(
      (left, right) =>
        right.cost_micros - left.cost_micros || compareText(left.provider, right.provider),
    )

  return {
    totals,
    by_provider: byProvider,
    by_model: byModel,
    scanned_file_count: scannedFileCount,
    truncated,
  }
}

/** Rust's byte-wise `String::cmp`, which for these ASCII/BMP keys is code-point order. */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The three row sources, and the labels the panel groups by.
 *
 * Hardcoded Chinese, as in the reference: `by_source` keys are display strings, and the
 * panel prints the key it is given rather than translating it.
 */
const SOURCE_LABELS = { matched: '匹配', session_only: '仅会话', proxy_only: '仅代理' }

/**
 * Bucket for rows with no owning account. Most merged rows are transcript-only, so this
 * needs a real label rather than an empty cell.
 */
const NO_ACCOUNT_LABEL = '未经代理'

/** Label of the folded tail series. */
export const TREND_OTHER_KEY = '其他'

/** A trimmed string, or `null` for blank and absent; a number becomes its digits. */
function optionalString(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length > 0 ? text : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

function optionalInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/**
 * One ledger event in the shape the merge works with.
 *
 * The ledger has already split out what the reference digs back out of a stored
 * `metadata_json` blob (`path`, `status`, `success`, `upstream_model`), and records cache
 * writes and cache reads separately where the reference only had one combined figure —
 * so a proxy-only row here reports the real split instead of the reference's deliberate
 * lower bound. `metadata_json` is still passed through when the caller has one, because
 * the detail panel renders it verbatim.
 */
function proxyRowFrom(event, index) {
  const responseId = optionalString(event?.upstream_response_id)
  const metadataJson = optionalString(event?.metadata_json)
  return {
    id: optionalString(event?.id) ?? responseId ?? `proxy:${index}`,
    createdAt: optionalString(event?.occurred_at),
    platform: optionalString(event?.platform) ?? 'unknown',
    // `proxy_facts` prefers the model the upstream actually served over the requested
    // one, because that is what was billed.
    model: optionalString(event?.upstream_model) ?? optionalString(event?.model),
    requestedModel: optionalString(event?.model),
    accountId: optionalString(event?.account_id),
    accountName: optionalString(event?.account_name),
    sourceLabel: optionalString(event?.source_label),
    path: optionalString(event?.path),
    status: optionalString(event?.status),
    // Absent `success` means a legacy row that only recorded successes.
    success:
      event?.success === undefined || event?.success === null ? true : event.success === true,
    usage: usage(
      jsonInt(event?.input_tokens),
      jsonInt(event?.output_tokens),
      jsonInt(event?.cache_write_tokens),
      jsonInt(event?.cache_read_tokens),
    ),
    priceUsdMicros: optionalInt(event?.price_usd_micros),
    priceCnyMicros: optionalInt(event?.price_cny_micros),
    priceCurrency: optionalString(event?.price_currency),
    priceSource: optionalString(event?.price_source),
    upstreamResponseId: responseId,
    metadataJson: metadataJson ?? synthesizedMetadata(event),
  }
}

/**
 * A metadata blob for the detail panel when the ledger passes none.
 *
 * `parseUsageMetadata` in the panel reads these keys by name, so the fields the ledger
 * does have stay visible; `null` when there is nothing worth showing, which the panel
 * renders as no metadata block at all rather than as an empty one.
 */
function synthesizedMetadata(event) {
  const fields = {
    path: optionalString(event?.path),
    status: optionalString(event?.status),
    requested_model: optionalString(event?.model),
    upstream_model: optionalString(event?.upstream_model),
  }
  const present = Object.entries(fields).filter(([, value]) => value !== null)
  if (present.length === 0) {
    return null
  }
  return JSON.stringify({ ...Object.fromEntries(present), success: event?.success !== false })
}

/**
 * The join key for a proxy row: its recorded response id, else one parsed back out of
 * the stored body preview for a row written before the column existed.
 */
function resolveProxyResponseId(row) {
  if (row.upstreamResponseId !== null) {
    return row.upstreamResponseId
  }
  const metadata = row.metadataJson === null ? null : safeParse(row.metadataJson)
  const body = get(metadata, 'response_body')
  return typeof body === 'string' ? extractUpstreamResponseId(body) : null
}

/**
 * The upstream response id inside a JSON or SSE response body.
 *
 * Nested paths win over the top-level `id`: an Anthropic `message_start` frame and an
 * OpenAI `response.created` frame both wrap the real id one level down, and when a
 * provider sends both, the response's own id is the authoritative one.
 */
export function extractUpstreamResponseId(body) {
  const whole = safeParse(body)
  if (whole !== null) {
    return responseIdFromValue(whole)
  }
  for (const line of String(body ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      continue
    }
    const frame = safeParse(trimmed.slice(5).trim())
    const found = frame === null ? null : responseIdFromValue(frame)
    if (found !== null) {
      return found
    }
  }
  return null
}

function responseIdFromValue(value) {
  for (const candidate of [
    get(get(value, 'message'), 'id'),
    get(get(value, 'response'), 'id'),
    get(value, 'id'),
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

/**
 * The upstream's own price in USD micros, when it reported one.
 *
 * A missing `price_currency` reads as USD, where the reference requires the column: this
 * ledger records `price_usd_micros` and nothing else, so demanding the currency would
 * throw away every real upstream price and silently fall back to an estimate.
 */
function upstreamCostMicros(row) {
  if (row.priceSource !== 'upstream') {
    return null
  }
  const currency = row.priceCurrency === null ? 'usd' : row.priceCurrency.toLowerCase()
  if (currency === 'usd') {
    return row.priceUsdMicros
  }
  if (currency === 'cny') {
    return row.priceCnyMicros === null ? null : cnyMicrosToUsdMicros(row.priceCnyMicros)
  }
  return null
}

/** Price from the local table; a `null` source means the model has no known rate. */
function estimatedCost(table, model, entryUsage) {
  const price = priceFor(table, model)
  return price === null ? [0, null] : [costMicros(entryUsage, price), 'estimated']
}

/** chrono's `to_rfc3339` for a UTC instant: `+00:00`, and no `.000`. */
function rfc3339FromMillis(millis) {
  if (millis === null || !Number.isFinite(millis)) {
    return null
  }
  const iso = new Date(millis).toISOString()
  const fraction = iso.slice(19, 23)
  return `${iso.slice(0, 19)}${fraction === '.000' ? '' : fraction}+00:00`
}

/** A transcript entry paired with the proxy row for the same request. */
function mergedRow(entry, proxy, table) {
  // An upstream price is real billing data; a local estimate is a guess.
  const upstream = upstreamCostMicros(proxy)
  const [cost, priceSource] =
    upstream === null ? estimatedCost(table, entry.model, entry.usage) : [upstream, 'upstream']
  return {
    id: proxy.id,
    source: 'matched',
    occurred_at: proxy.createdAt,
    provider: entry.provider,
    // The transcript records what the CLI itself used, and its cache split is finer than
    // the proxy's.
    model: entry.model,
    account_id: proxy.accountId,
    account_name: proxy.accountName,
    source_label: proxy.sourceLabel,
    path: proxy.path,
    status: proxy.status,
    success: proxy.success,
    input_tokens: Math.max(0, entry.usage.inputTokens),
    output_tokens: Math.max(0, entry.usage.outputTokens),
    cache_write_tokens: Math.max(0, entry.usage.cacheWriteTokens),
    cache_read_tokens: Math.max(0, entry.usage.cacheReadTokens),
    cost_micros: cost,
    price_source: priceSource,
    upstream_response_id: entry.responseId,
    metadata_json: proxy.metadataJson,
  }
}

/** A transcript entry the proxy never saw: the CLI reached the upstream directly. */
function sessionOnlyRow(entry, index, table) {
  const [cost, priceSource] = estimatedCost(table, entry.model, entry.usage)
  return {
    id: entry.responseId ?? `session:${index}`,
    source: 'session_only',
    occurred_at: rfc3339FromMillis(entry.timestampMs),
    provider: entry.provider,
    model: entry.model,
    account_id: null,
    account_name: null,
    source_label: null,
    path: null,
    // A transcript has no HTTP status; an entry exists only for a request that returned
    // usage, so it succeeded.
    status: null,
    success: true,
    input_tokens: Math.max(0, entry.usage.inputTokens),
    output_tokens: Math.max(0, entry.usage.outputTokens),
    cache_write_tokens: Math.max(0, entry.usage.cacheWriteTokens),
    cache_read_tokens: Math.max(0, entry.usage.cacheReadTokens),
    cost_micros: cost,
    price_source: priceSource,
    upstream_response_id: entry.responseId,
    metadata_json: null,
  }
}

/**
 * A proxy row no transcript claimed: a model test, or a tool other than the two scanned
 * CLIs pointed at this proxy.
 */
function proxyOnlyRow(row, table) {
  const model = row.model ?? 'unknown'
  const upstream = upstreamCostMicros(row)
  const [cost, priceSource] =
    upstream === null ? estimatedCost(table, model, row.usage) : [upstream, 'upstream']
  return {
    id: row.id,
    source: 'proxy_only',
    occurred_at: row.createdAt,
    provider: row.platform,
    model,
    account_id: row.accountId,
    account_name: row.accountName,
    source_label: row.sourceLabel,
    path: row.path,
    status: row.status,
    success: row.success,
    input_tokens: row.usage.inputTokens,
    output_tokens: row.usage.outputTokens,
    cache_write_tokens: row.usage.cacheWriteTokens,
    cache_read_tokens: row.usage.cacheReadTokens,
    cost_micros: cost,
    price_source: priceSource,
    upstream_response_id: row.upstreamResponseId,
    metadata_json: row.metadataJson,
  }
}

/**
 * Merge the two sides on the upstream response id.
 *
 * A row with no id on either side stays unmerged: a missing key is not evidence of a
 * shared request, and treating it as one would collapse unrelated requests into a single
 * row. Ids are not unique either — a protocol bridge that has to synthesize one uses a
 * constant — so each id holds a **queue** and a session entry consumes one row, rather
 * than the last writer silently winning and the rest vanishing from every total.
 *
 * @returns UsageOverviewRow[], newest first.
 */
export function mergeEntries(sessionEntries, proxyRows, table = null) {
  const byId = new Map()
  const unkeyed = []
  for (const row of proxyRows) {
    const id = resolveProxyResponseId(row)
    if (id === null) {
      unkeyed.push(row)
      continue
    }
    const queue = byId.get(id)
    if (queue === undefined) {
      byId.set(id, [row])
    } else {
      queue.push(row)
    }
  }

  const rows = []
  let index = 0
  for (const entry of sessionEntries) {
    // Blank is filtered on both sides: a present-but-empty id is not a key, and letting
    // it act as one would merge every id-less row into a single request.
    const id = optionalString(entry.responseId)
    const paired = id === null ? null : takeProxyRow(byId, id)
    rows.push(
      paired === null ? sessionOnlyRow(entry, index, table) : mergedRow(entry, paired, table),
    )
    index += 1
  }

  for (const leftover of [...byId.values()].flat()) {
    rows.push(proxyOnlyRow(leftover, table))
  }
  for (const leftover of unkeyed) {
    rows.push(proxyOnlyRow(leftover, table))
  }

  // `id` breaks ties: pagination re-runs this merge per page, so without a total order a
  // row could show up on two pages or on none.
  rows.sort(
    (left, right) =>
      compareOptionalText(right.occurred_at, left.occurred_at) || compareText(left.id, right.id),
  )
  return rows
}

/** Take one proxy row recorded under `id`, dropping the id once its queue is empty. */
function takeProxyRow(byId, id) {
  const queue = byId.get(id)
  if (queue === undefined) {
    return null
  }
  const row = queue.shift() ?? null
  if (queue.length === 0) {
    byId.delete(id)
  }
  return row
}

/** Rust's `Option<String>` ordering, where `None` sorts before every `Some`. */
function compareOptionalText(left, right) {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1
  }
  if (right === null || right === undefined) {
    return 1
  }
  return compareText(left, right)
}

function emptyOverviewTotals() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    cost_micros: 0,
  }
}

function absorb(totals, row) {
  totals.request_count += 1
  totals.input_tokens += row.input_tokens
  totals.output_tokens += row.output_tokens
  totals.cache_write_tokens += row.cache_write_tokens
  totals.cache_read_tokens += row.cache_read_tokens
  totals.cost_micros += row.cost_micros
}

/**
 * Totals over every row in the window — never over one page, or the summary cards would
 * change as the user pages through the list.
 */
export function summarize(rows) {
  const totals = emptyOverviewTotals()
  for (const row of rows) {
    absorb(totals, row)
  }
  return totals
}

/** The four grouping dimensions, as the panel's segmented control names them. */
const GROUP_KEYS = {
  by_model: (row) => row.model,
  by_platform: (row) => row.provider,
  by_account: (row) => row.account_name ?? row.account_id ?? NO_ACCOUNT_LABEL,
  by_source: (row) => SOURCE_LABELS[row.source] ?? row.source,
}

function groupBy(rows, key) {
  const buckets = new Map()
  for (const row of rows) {
    const bucketKey = key(row)
    let totals = buckets.get(bucketKey)
    if (totals === undefined) {
      totals = emptyOverviewTotals()
      buckets.set(bucketKey, totals)
    }
    absorb(totals, row)
  }
  // Highest spend first, then by request count so unpriced groups still order sensibly,
  // then by key for a stable result.
  return [...buckets.entries()]
    .map(([key_, totals]) => ({ key: key_, ...totals }))
    .sort(
      (left, right) =>
        right.cost_micros - left.cost_micros ||
        right.request_count - left.request_count ||
        compareText(left.key, right.key),
    )
}

/**
 * All four dimensions at once: their cardinality is small (single to double digits), so
 * computing them together avoids a refetch when the user flips the segmented control.
 */
export function groupAll(rows) {
  return {
    by_model: groupBy(rows, GROUP_KEYS.by_model),
    by_platform: groupBy(rows, GROUP_KEYS.by_platform),
    by_account: groupBy(rows, GROUP_KEYS.by_account),
    by_source: groupBy(rows, GROUP_KEYS.by_source),
  }
}

/**
 * The widest a trend series gets before the next coarser unit takes over. Sized for a
 * chart in a side panel: 48 bars still read at a glance, and it keeps a month of days
 * (31) and a day of hours (25) at their natural unit.
 */
const MAX_TREND_BUCKETS = 48

/** Hard stop on bucket generation, only reachable with a corpus spanning decades. */
const TREND_BUCKET_CEILING = 400

/** Series a chart can colour apart before hues repeat; the tail folds into one row. */
const TREND_SERIES_LIMIT = 8

const UNIT_SPAN_MS = {
  hour: 3600000,
  day: 86400000,
  week: 604800000,
  // Only used to rule the unit out, so a nominal 30 days is close enough.
  month: 2592000000,
}

/** Finest unit that keeps the bar count readable. */
function chooseUnit(spanMs) {
  const span = Math.max(0, spanMs)
  for (const unit of ['hour', 'day', 'week']) {
    if (Math.trunc(span / UNIT_SPAN_MS[unit]) + 1 <= MAX_TREND_BUCKETS) {
      return unit
    }
  }
  return 'month'
}

/**
 * The calendar fields of an instant in a fixed offset east of UTC.
 *
 * A fixed offset has no DST gaps, so shifting the instant and reading UTC fields is the
 * whole of the conversion. It is also why one offset is used for the entire window: a
 * DST region is off by an hour on the far side of a transition and the transition day
 * itself is 23h or 25h. Correcting that needs a real timezone database — the caller
 * reports an offset, not a zone name.
 */
function calendarAt(millis, offsetMinutes) {
  const shifted = new Date(millis + offsetMinutes * 60000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    // Days since Monday, matching chrono's `num_days_from_monday`.
    weekday: (shifted.getUTCDay() + 6) % 7,
  }
}

/** Truncate an instant down to the start of its bucket. */
function bucketStartMs(unit, millis, offsetMinutes) {
  const at = calendarAt(millis, offsetMinutes)
  const shift = offsetMinutes * 60000
  switch (unit) {
    case 'hour':
      return Date.UTC(at.year, at.month, at.day, at.hour) - shift
    case 'week':
      return Date.UTC(at.year, at.month, at.day - at.weekday) - shift
    case 'month':
      return Date.UTC(at.year, at.month, 1) - shift
    default:
      return Date.UTC(at.year, at.month, at.day) - shift
  }
}

/**
 * The next bucket boundary. Months step by the calendar, not by a fixed span, so February
 * and March start where the reader expects.
 */
function nextBucketMs(unit, startMs, offsetMinutes) {
  if (unit === 'month') {
    const at = calendarAt(startMs, offsetMinutes)
    return Date.UTC(at.year, at.month + 1, 1) - offsetMinutes * 60000
  }
  return startMs + UNIT_SPAN_MS[unit]
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** RFC 3339 in the offset the bucketing used, as chrono prints it. */
function rfc3339AtOffset(millis, offsetMinutes) {
  const at = calendarAt(millis, offsetMinutes)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const date = `${at.year}-${pad2(at.month + 1)}-${pad2(at.day)}`
  const clock = `${pad2(at.hour)}:${pad2(at.minute)}:00`
  const zone = `${sign}${pad2(Math.trunc(absolute / 60))}:${pad2(absolute % 60)}`
  return `${date}T${clock}${zone}`
}

/** Short axis label: `14:00`, `09-03`, `2026-09`. */
function bucketLabel(unit, millis, offsetMinutes) {
  const at = calendarAt(millis, offsetMinutes)
  if (unit === 'hour') {
    return `${pad2(at.hour)}:00`
  }
  if (unit === 'month') {
    return `${at.year}-${pad2(at.month + 1)}`
  }
  return `${pad2(at.month + 1)}-${pad2(at.day)}`
}

/**
 * The slice spelled out, for a tooltip heading: the axis label alone is ambiguous once
 * the window crosses a month or a year.
 */
function bucketTitle(unit, millis, nextMillis, offsetMinutes) {
  const at = calendarAt(millis, offsetMinutes)
  const date = `${at.year}-${pad2(at.month + 1)}-${pad2(at.day)}`
  if (unit === 'hour') {
    const next = calendarAt(nextMillis, offsetMinutes)
    return `${date} ${pad2(at.hour)}:00–${pad2(next.hour)}:00`
  }
  if (unit === 'week') {
    const end = calendarAt(nextMillis - UNIT_SPAN_MS.day, offsetMinutes)
    return `${date} – ${pad2(end.month + 1)}-${pad2(end.day)}`
  }
  if (unit === 'month') {
    return `${at.year}-${pad2(at.month + 1)}`
  }
  return date
}

/**
 * Slice the window into buckets and stack every dimension over them.
 *
 * Empty buckets are kept: a day with no requests is information, and dropping it would
 * make an idle week look like a busy one with fewer bars. The series covers every row in
 * the window, not one page, so the bars sum to the summary cards apart from the undated
 * rows it reports separately.
 *
 * @returns UsageTrendSeries
 */
export function buildTrendSeries(rows, frame) {
  const offsetMinutes = frame.offsetMinutes
  const dated = []
  let undatedRequestCount = 0
  for (const row of rows) {
    const millis = parseRfc3339Millis(row.occurred_at)
    if (millis === null) {
      undatedRequestCount += 1
    } else {
      dated.push([row, millis])
    }
  }

  let earliest = null
  let latest = null
  for (const [, millis] of dated) {
    earliest = earliest === null || millis < earliest ? millis : earliest
    latest = latest === null || millis > latest ? millis : latest
  }

  const startMs = frame.startMs ?? earliest
  if (startMs === null) {
    // No window start and nothing to derive one from: an empty chart, not a chart of an
    // arbitrary range.
    return {
      unit: 'day',
      buckets: [],
      by_model: [],
      by_platform: [],
      by_account: [],
      by_source: [],
      undated_request_count: undatedRequestCount,
    }
  }
  // A row can post-date `endMs` when a clock disagrees with the ledger, and a bar it does
  // not fit in is a bar the user silently loses.
  const endMs = Math.max(frame.endMs, latest ?? startMs, startMs)

  const unit = chooseUnit(endMs - startMs)
  const buckets = []
  const indexOf = new Map()
  let cursor = bucketStartMs(unit, startMs, offsetMinutes)
  while (cursor <= endMs && buckets.length < TREND_BUCKET_CEILING) {
    const next = nextBucketMs(unit, cursor, offsetMinutes)
    indexOf.set(cursor, buckets.length)
    buckets.push({
      start: rfc3339AtOffset(cursor, offsetMinutes),
      label: bucketLabel(unit, cursor, offsetMinutes),
      title: bucketTitle(unit, cursor, next, offsetMinutes),
      ...emptyOverviewTotals(),
    })
    cursor = next
  }

  // Clamping rather than skipping keeps every row on the chart: an unmapped timestamp — a
  // leftover from the ceiling above, or a boundary the offset rounded differently — would
  // otherwise vanish from the bars while still counting in the cards above them.
  const last = Math.max(0, buckets.length - 1)
  const placed = dated.map(([row, millis]) => {
    const found = indexOf.get(bucketStartMs(unit, millis, offsetMinutes))
    return [row, found ?? (millis <= startMs ? 0 : last)]
  })

  for (const [row, index] of placed) {
    if (buckets[index] !== undefined) {
      absorb(buckets[index], row)
    }
  }

  return {
    unit,
    buckets,
    by_model: stackSeries(placed, buckets.length, GROUP_KEYS.by_model),
    by_platform: stackSeries(placed, buckets.length, GROUP_KEYS.by_platform),
    by_account: stackSeries(placed, buckets.length, GROUP_KEYS.by_account),
    by_source: stackSeries(placed, buckets.length, GROUP_KEYS.by_source),
    undated_request_count: undatedRequestCount,
  }
}

/**
 * One stacked series per group key.
 *
 * Cache tokens are left out on purpose: on a real Claude corpus cache reads outnumber
 * real input by an order of magnitude, so including them would draw a chart about caching
 * rather than about work done. The per-bucket totals still carry them for the tooltip.
 */
function stackSeries(placed, bucketCount, key) {
  const stacks = new Map()
  for (const [row, index] of placed) {
    const stackKey = key(row)
    let stack = stacks.get(stackKey)
    if (stack === undefined) {
      stack = new Array(bucketCount).fill(0)
      stacks.set(stackKey, stack)
    }
    if (index < stack.length) {
      stack[index] += row.input_tokens + row.output_tokens
    }
  }
  return foldTail(stacks)
}

/**
 * Biggest series first, with everything past the colour budget folded into one row.
 * Ordering is by the plotted metric — tokens — so the tallest stack segments are the
 * named ones.
 */
function foldTail(stacks) {
  const ranked = [...stacks.entries()]
    .map(([key, tokens]) => ({ key, tokens, total: tokens.reduce((sum, value) => sum + value, 0) }))
    .sort((left, right) => right.total - left.total || compareText(left.key, right.key))

  const rows = ranked.map(({ key, tokens }) => ({ key, tokens }))
  if (rows.length <= TREND_SERIES_LIMIT) {
    return rows
  }
  const tail = rows.splice(TREND_SERIES_LIMIT)
  const other = new Array(tail[0]?.tokens.length ?? 0).fill(0)
  for (const row of tail) {
    row.tokens.forEach((value, index) => {
      other[index] += value
    })
  }
  rows.push({ key: TREND_OTHER_KEY, tokens: other })
  return rows
}

/**
 * One page of rows. A page past the end is empty rather than an error: the list shrinks
 * between refreshes as rows age out of the window.
 */
export function paginate(rows, page, pageSize) {
  const size = Math.max(1, pageSize)
  const offset = Math.max(0, page - 1) * size
  return rows.slice(offset, offset + size)
}

/** Clamp paging rather than rejecting it: a stale page number shows an empty page. */
function normalizePagination(page, pageSize) {
  const normalizedPage = Math.max(1, Math.trunc(Number(page ?? 1)) || 1)
  const requestedSize = Math.trunc(Number(pageSize ?? 20)) || 20
  return [normalizedPage, Math.min(100, Math.max(1, requestedSize))]
}

/**
 * Reject an offset no real timezone uses rather than trusting the wire: the value comes
 * from a browser. Real offsets run from -12:00 to +14:00.
 */
function normalizeUtcOffset(minutes) {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.trunc(minutes) : null
  if (value === null || value < -12 * 60 || value > 14 * 60) {
    return null
  }
  return value
}

/** Facts the UI needs to state how complete the totals are. */
function integrityOf(rows, scannedFileCount, truncated, unmatchableProxyRowCount) {
  let unpriced = 0
  let estimated = 0
  for (const row of rows) {
    if (row.price_source === null) {
      unpriced += 1
    } else if (row.price_source === 'estimated') {
      estimated += 1
    }
  }
  return {
    scanned_file_count: scannedFileCount,
    truncated,
    unpriced_request_count: unpriced,
    estimated_price_request_count: estimated,
    unmatchable_proxy_row_count: unmatchableProxyRowCount,
  }
}

/**
 * Local CLI transcript usage merged with this plugin's proxied requests: one page of the
 * combined list, plus window-wide totals, groups and a trend series.
 *
 * The two sources overlap — a CLI request routed through the proxy is recorded on both
 * sides — and the upstream response id joins them. On the reference's real corpus 2905 of
 * 2933 proxy rows (99.0%) matched a transcript entry. Merging on that key is what lets a
 * single set of totals mean "my total spend" instead of double counting the overlap.
 *
 * `utcOffsetMinutes` is the *caller's* offset east of UTC and slices the chart's buckets.
 * The caller has to supply it: `since` is computed from the client's own calendar (its
 * midnight, its start-of-week), so bucketing with the server's offset instead cuts the
 * first and last bucket at a different instant and shifts every hour label. That is
 * invisible on a desktop, where both clocks are one machine, and wrong for every browser
 * and paired phone in another timezone. Absent falls back to this host's offset, which is
 * right for a caller that has no clock of its own to report.
 *
 * @param proxyEvents - the plugin's own ledger rows; `[]` when the proxy never ran.
 * @param prices - a `model-prices.json` object, or `null` for the built-in rates.
 * @returns UsageOverview
 */
export async function getUsageOverview({
  since = null,
  page = null,
  pageSize = null,
  utcOffsetMinutes = null,
  proxyEvents = [],
  prices = null,
} = {}) {
  // Validate before the scan: a bad `since` must not cost a multi-gigabyte read.
  const window = parseWindow(since)
  const [normalizedPage, normalizedPageSize] = normalizePagination(page, pageSize)
  const table = prices === null ? null : loadPriceTable(prices)

  const { entries, scannedFileCount, truncated } = await scanSessionUsage({ since })
  const proxyRows = (Array.isArray(proxyEvents) ? proxyEvents : []).map((event, index) =>
    proxyRowFrom(event, index),
  )

  // Only successes can double count: a failed request never produced an assistant
  // message, so the transcripts hold nothing to pair it with. On the reference's corpus
  // 707 of 709 id-less rows were failures — counting them would have put an alarming
  // figure in front of the user for a risk that does not exist.
  const unmatchableProxyRowCount = proxyRows.filter(
    (row) => resolveProxyResponseId(row) === null && row.success,
  ).length

  const rows = mergeEntries(entries, proxyRows, table)
  const series = buildTrendSeries(rows, {
    startMs: window.startMs,
    endMs: window.endMs ?? Date.now(),
    offsetMinutes: normalizeUtcOffset(utcOffsetMinutes) ?? -new Date().getTimezoneOffset(),
  })

  return {
    totals: summarize(rows),
    rows: paginate(rows, normalizedPage, normalizedPageSize),
    groups: groupAll(rows),
    series,
    row_count: rows.length,
    page: normalizedPage,
    page_size: normalizedPageSize,
    integrity: integrityOf(rows, scannedFileCount, truncated, unmatchableProxyRowCount),
  }
}
