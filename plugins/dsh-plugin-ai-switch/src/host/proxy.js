/**
 * The route proxy: a local HTTP server the agent CLIs point at instead of a vendor.
 *
 * A CLI sends a request in whatever protocol it speaks; this picks an account out of the
 * platform's pool, rewrites the model name to whatever that account calls it, bridges the
 * protocol if the two differ, forwards it, and streams the answer back. On a failure it
 * cools the account down and tries the next one.
 *
 * Which platform a request belongs to is decided by the bearer token, not by the path:
 * every client config we write carries a per-platform key, so one listener serves all seven
 * without any per-platform routing table. `x-ai-switch-platform` is honoured as an override
 * because the panel's own model probe sends it.
 *
 * It listens on its OWN port (19527 by default, first free port upward), not on dsh's web
 * server. Three reasons, in order of importance: the CLIs need a stable address that does
 * not move when dsh's port does; dsh's server is behind an auth gate these CLIs cannot pass;
 * and an SSE-style upstream stream held open on the shared origin would eat one of the six
 * HTTP connections a browser gives the whole GUI.
 *
 * @module dsh-plugin-ai-switch/host/proxy
 */
import { createServer } from 'node:http'

import { ApiError } from '../shared/protocol.js'
import {
  buildUpstreamRequest,
  createStreamBridge,
  detectLocalProtocol,
  isCountTokensPath,
  isModelsPath,
  translateResponse,
} from './bridge/index.js'
import { buildCatalog, modelsListBody, splitPreciseId, upstreamModelFor } from './models.js'
import { tryParsePlatform } from './platforms.js'

/** The port the reference prefers; we walk upward from here if it is taken. */
export const DEFAULT_PORT = 19527

/** Loopback only. This is a local credential broker, not a gateway. */
export const BIND_HOST = '127.0.0.1'

/** How many ports to try before giving up. */
const PORT_SCAN = 64

/** Upstream timeouts: generous for a stream, strict for a handshake. */
const CONNECT_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 600_000

/** Live log ring buffer, shared by every platform, newest last. */
const LIVE_LOG_LIMIT = 100

/** Request bodies bigger than this are a mistake, not a prompt. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * An account's `interface_format` is not a bridge protocol id.
 *
 * The account vocabulary is the user-facing one the reference put in its dropdown
 * (`openai`, `openai-responses`, `anthropic`, `gemini`); the bridge's is what a wire format
 * is called (`chat`, `responses`, `anthropic`, `gemini`). They differ for exactly one value,
 * and translating in one place beats teaching either side the other's names.
 */
const DIALECT_TO_PROTOCOL = {
  openai: 'chat',
  'openai-responses': 'responses',
  openai_responses: 'responses',
  anthropic: 'anthropic',
  gemini: 'gemini',
}

/** The bridge protocol one account speaks upstream, or null when it is unset/unknown. */
export function upstreamProtocol(interfaceFormat) {
  const value = String(interfaceFormat ?? '').trim().toLowerCase()
  return DIALECT_TO_PROTOCOL[value] ?? null
}

export class RouteProxy {
  /**
   * @param options.accounts - the AccountService (pool order, cooldowns, failure recording).
   * @param options.keys - the ProxyKeyService (bearer token -> platform).
   * @param options.ledger - the UsageLedger.
   * @param options.activity - the in-flight counter.
   * @param options.emit - `(channel, payload) => void` for the panel socket.
   */
  constructor({ accounts, keys, ledger, activity, emit = () => {}, fetchImpl = globalThis.fetch }) {
    this.accounts = accounts
    this.keys = keys
    this.ledger = ledger
    this.activity = activity
    this.emit = emit
    this.fetchImpl = fetchImpl
    this.server = null
    this.port = null
    this.liveLog = []
    this.logSubscribers = 0
  }

  /** `get_route_proxy_status`. */
  status() {
    const running = this.server !== null && this.port !== null
    return {
      running,
      bind_host: BIND_HOST,
      port: running ? this.port : null,
      base_url: running ? `http://${BIND_HOST}:${this.port}` : null,
      // HTTPS needs a certificate in the OS trust store, which a plugin cannot install.
      // Reported as off rather than as broken, and the settings panel says why.
      https_port: null,
      https_base_url: null,
      https_error: null,
    }
  }

  /** Bind the first free port from `DEFAULT_PORT` upward. Idempotent. */
  async start() {
    if (this.server !== null) {
      return this.status()
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        this.#fail(response, 502, 'proxy.internal', String(error?.message ?? error))
      })
    })
    server.keepAliveTimeout = IDLE_TIMEOUT_MS
    server.headersTimeout = IDLE_TIMEOUT_MS + 5_000
    server.requestTimeout = 0

    let lastError = null
    for (let offset = 0; offset < PORT_SCAN; offset += 1) {
      const port = DEFAULT_PORT + offset
      try {
        await new Promise((resolveBind, rejectBind) => {
          const onError = (error) => {
            server.removeListener('listening', onListening)
            rejectBind(error)
          }
          const onListening = () => {
            server.removeListener('error', onError)
            resolveBind()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, BIND_HOST)
        })
        this.server = server
        this.port = port
        return this.status()
      } catch (error) {
        lastError = error
        if (error?.code !== 'EADDRINUSE') {
          break
        }
      }
    }
    server.close()
    throw new ApiError('filesystem.route_proxy_bind', 'Could not open a local port for the route proxy', {
      details: String(lastError?.message ?? lastError ?? 'no free port'),
      recoverable: true,
    })
  }

  async stop() {
    const server = this.server
    this.server = null
    this.port = null
    if (server !== null) {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
    return this.status()
  }

  /** Append to the live log and, if anyone is watching, push it. */
  #log(entry) {
    const row = { id: `${Date.now()}-${this.liveLog.length}`, at: new Date().toISOString(), ...entry }
    this.liveLog.push(row)
    if (this.liveLog.length > LIVE_LOG_LIMIT) {
      this.liveLog.splice(0, this.liveLog.length - LIVE_LOG_LIMIT)
    }
    if (this.logSubscribers > 0) {
      this.emit('route-proxy-live-log', row)
    }
    return row
  }

  /** `subscribe_route_proxy_live_log`: the buffer for one platform, oldest first. */
  subscribeLiveLog(platform) {
    this.logSubscribers += 1
    return this.liveLog.filter((row) => row.platform === platform)
  }

  unsubscribeLiveLog() {
    this.logSubscribers = Math.max(0, this.logSubscribers - 1)
    return null
  }

  #fail(response, status, code, message) {
    if (response.headersSent) {
      response.end()
      return
    }
    const body = JSON.stringify({ error: { type: code, message } })
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  /** The bearer token a client presented, from whichever header its vendor uses. */
  static presentedKey(headers) {
    const bearer = String(headers.authorization ?? '')
    if (/^bearer\s+/i.test(bearer)) {
      return bearer.replace(/^bearer\s+/i, '').trim()
    }
    // Anthropic clients send `x-api-key`; Gemini clients send `x-goog-api-key` or `?key=`.
    for (const header of ['x-api-key', 'x-goog-api-key']) {
      const value = String(headers[header] ?? '').trim()
      if (value.length > 0) {
        return value
      }
    }
    return ''
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${BIND_HOST}`)
    const path = url.pathname

    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      const body = JSON.stringify({ ok: true, ...this.status() })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }

    // The presented key decides the platform, never the header. This is a credential
    // broker: a request it serves spends the user's stored upstream key, so authentication
    // cannot rest on `x-ai-switch-platform`, which any local caller can forge. The header is
    // only a hint the reference front end sends beside the key; it may agree with the key's
    // platform but never stand in for it. (Each platform has its own key, so the key alone
    // is unambiguous.)
    const presented = RouteProxy.presentedKey(request.headers) || String(url.searchParams.get('key') ?? '').trim()
    const platform = await this.keys.platformForKey(presented)
    if (platform === null || platform === undefined || platform.length === 0) {
      this.#fail(response, 401, 'proxy.unauthorized', 'Unknown or missing AI Switch proxy key')
      return
    }
    const override = String(request.headers['x-ai-switch-platform'] ?? '').trim()
    if (override.length > 0 && tryParsePlatform(override) !== platform) {
      this.#fail(response, 403, 'proxy.platform_mismatch', 'The platform hint does not match the presented key')
      return
    }

    if (request.method === 'GET' && isModelsPath(path)) {
      await this.#serveModels(response, platform)
      return
    }

    if (request.method !== 'POST') {
      this.#fail(response, 405, 'proxy.method_not_allowed', `${request.method} is not allowed here`)
      return
    }

    const body = await readBody(request)
    if (body === null) {
      this.#fail(response, 413, 'proxy.body_too_large', 'The request body is too large')
      return
    }

    if (isCountTokensPath(path)) {
      // Anthropic clients call this before a turn. Answering with a local estimate keeps
      // Claude Code moving; forwarding it would spend an upstream request on arithmetic.
      const estimate = estimateTokens(body)
      const payload = JSON.stringify({ input_tokens: estimate })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(payload)
      return
    }

    const local = detectLocalProtocol(path)
    if (local === null) {
      this.#fail(response, 404, 'proxy.unknown_path', `No AI Switch route for ${path}`)
      return
    }
    await this.#proxy({ request, response, platform, local, path, body, url })
  }

  async #serveModels(response, platform) {
    const pool = await this.accounts.getPool(platform)
    const members = []
    for (const accountId of pool.account_ids) {
      const row = await this.accounts.requireRow(accountId).catch(() => null)
      if (row !== null && row.archived_at === null) {
        members.push(row)
      }
    }
    const body = JSON.stringify(modelsListBody(buildCatalog({ platform, members, mode: pool.model_mode })))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  }

  /**
   * One request, with retries across accounts.
   *
   * The retry budget comes from the first candidate's failure policy (`retry_count`, default
   * 2), and each retry excludes every account already tried, so a pool of three bad accounts
   * is exhausted rather than hammered. A request whose stream has already started is NEVER
   * retried: the client has bytes, and replacing them mid-answer would corrupt the turn.
   */
  async #proxy({ request, response, platform, local, path, body, url }) {
    const requested = requestedModel(body, path)
    const tried = []
    let attempt = 0
    let policy = null

    for (;;) {
      let row
      try {
        row = await this.accounts.selectAccount(platform, { modelKey: null, exclude: tried })
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'route_pool.unavailable'
        this.#log({ platform, level: 'error', message: error?.message ?? String(error), code, model: requested })
        const status = code === 'route_pool.concurrency_exhausted' ? 429 : 503
        this.#fail(response, status, code, error?.message ?? 'No account available')
        return
      }
      tried.push(row.id)
      policy ??= failurePolicy(row)

      const started = Date.now()
      const done = this.activity.begin(row.id, { platform, maxConcurrency: row.max_concurrency })
      let outcome
      try {
        outcome = await this.#forward({ request, response, platform, local, path, body, url, row, requested })
      } finally {
        done()
      }

      if (outcome.ok) {
        await this.accounts.recordSuccess(row.id)
        this.ledger.record({
          platform,
          accountId: row.id,
          accountName: row.display_name,
          sourceLabel: 'route_proxy',
          model: requested,
          upstreamModel: outcome.upstreamModel,
          path,
          status: outcome.status,
          success: true,
          durationMs: Date.now() - started,
          inputTokens: outcome.usage?.inputTokens,
          outputTokens: outcome.usage?.outputTokens,
          cacheReadTokens: outcome.usage?.cacheReadTokens,
          cacheWriteTokens: outcome.usage?.cacheWriteTokens,
          upstreamResponseId: outcome.responseId,
        })
        this.#log({
          platform,
          level: 'info',
          message: `${outcome.status} ${requested ?? ''} via ${row.display_name}`,
          account_id: row.id,
          account_name: row.display_name,
          model: requested,
          upstream_model: outcome.upstreamModel,
          status: outcome.status,
          duration_ms: Date.now() - started,
        })
        return
      }

      await this.accounts.recordFailure(row.id, {
        kind: outcome.kind,
        message: outcome.message,
        responseJson: outcome.bodyText,
        cooldownSeconds: policy.cooldown_enabled ? policy.cooldown_seconds : 0,
        semanticFingerprint: outcome.retryable ? null : `${outcome.status ?? 0}:${outcome.kind}`,
      })
      this.ledger.record({
        platform,
        accountId: row.id,
        accountName: row.display_name,
        sourceLabel: 'route_proxy',
        model: requested,
        upstreamModel: outcome.upstreamModel,
        path,
        status: outcome.status,
        success: false,
        durationMs: Date.now() - started,
        errorMessage: outcome.message,
      })
      this.#log({
        platform,
        level: 'error',
        message: outcome.message,
        account_id: row.id,
        account_name: row.display_name,
        model: requested,
        status: outcome.status,
        duration_ms: Date.now() - started,
      })

      if (outcome.committed) {
        // Bytes already went to the client; there is nothing honest left to do but stop.
        response.end()
        return
      }
      attempt += 1
      if (!outcome.retryable || attempt > policy.retry_count) {
        this.#fail(response, outcome.status ?? 502, outcome.kind, outcome.message)
        return
      }
      if (policy.retry_interval_ms > 0) {
        await sleep(policy.retry_interval_ms)
      }
    }
  }

  /**
   * One attempt against one account.
   *
   * Returns `{ok:false, retryable, committed, …}` rather than throwing, so the caller above
   * can decide about the next account without a try/catch per failure mode. `committed`
   * means bytes reached the client.
   */
  async #forward({ request, response, platform, local, path, body, url, row, requested }) {
    const config = parseConfig(row)
    const upstream = upstreamProtocol(config.interface_format)
    const baseUrl = String(config.base_url ?? '').trim().replace(/\/+$/, '')
    if (upstream === null || baseUrl.length === 0) {
      return {
        ok: false,
        retryable: false,
        committed: false,
        status: 502,
        kind: 'account.misconfigured',
        message: `${row.display_name} has no base URL or a usable upstream protocol`,
      }
    }

    const { alias } = splitPreciseId(requested ?? '')
    const upstreamModel = upstreamModelFor(row, platform, alias)
    const isStream = wantsStream(body, path)
    let hop
    try {
      hop = buildUpstreamRequest({ from: local, to: upstream, body, model: upstreamModel, isStream, path })
    } catch (error) {
      return {
        ok: false,
        retryable: false,
        committed: false,
        status: 400,
        kind: error instanceof ApiError ? error.code : 'bridge.invalid_request',
        message: String(error?.message ?? error),
        upstreamModel,
      }
    }

    const target = joinUpstream(baseUrl, hop.path, url.search, upstream)
    const headers = upstreamHeaders({ config, row, upstream, request, isStream })
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
    // If the client hangs up, stop paying for the upstream turn.
    const onClientClose = () => controller.abort()
    request.on('close', onClientClose)

    let upstreamResponse
    try {
      upstreamResponse = await this.fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(hop.body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(connectTimer)
      request.off('close', onClientClose)
      return {
        ok: false,
        retryable: true,
        committed: false,
        status: 502,
        kind: 'upstream.unreachable',
        message: `${row.display_name}: ${String(error?.message ?? error)}`,
        upstreamModel,
      }
    }
    clearTimeout(connectTimer)

    if (!upstreamResponse.ok) {
      const text = await upstreamResponse.text().catch(() => '')
      request.off('close', onClientClose)
      return {
        ok: false,
        // 4xx is this account's own problem (bad key, no quota, model not served) and worth
        // another account; 429 and 5xx are transient. A 400 is the exception: it is almost
        // always the REQUEST, and retrying it elsewhere just fails again more slowly.
        retryable: upstreamResponse.status !== 400,
        committed: false,
        status: upstreamResponse.status,
        kind: `upstream.http_${upstreamResponse.status}`,
        message: `${row.display_name}: HTTP ${upstreamResponse.status} ${firstLine(text)}`,
        bodyText: text.slice(0, 8192),
        upstreamModel,
      }
    }

    if (!isStream) {
      const text = await upstreamResponse.text()
      request.off('close', onClientClose)
      let payload
      try {
        payload = JSON.parse(text)
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          committed: false,
          status: 502,
          kind: 'upstream.invalid_json',
          message: `${row.display_name}: ${String(error?.message ?? error)}`,
          bodyText: text.slice(0, 8192),
          upstreamModel,
        }
      }
      const translated = translateResponse({ from: upstream, to: local, body: payload })
      const out = JSON.stringify(translated.body)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) })
      response.end(out)
      // Usage is read off the UPSTREAM body, not the translated one: the local protocol may
      // have no field for a count the upstream did report (Gemini's `cachedContentTokenCount`
      // has no home in a Chat response), and the ledger should still see it.
      return {
        ok: true,
        status: upstreamResponse.status,
        upstreamModel,
        usage: usageFromBody(upstream, payload),
        responseId: responseIdFromBody(payload),
      }
    }

    return this.#stream({ response, upstreamResponse, from: upstream, to: local, row, upstreamModel, onClientClose, request })
  }

  /**
   * Pump an SSE body through the bridge to the client.
   *
   * Headers go out before the first frame is read, because a client that has not seen
   * `content-type: text/event-stream` will not start rendering. That is also the moment the
   * attempt becomes `committed` — from here on a failure can only be reported by ending the
   * stream, never by choosing another account.
   */
  async #stream({ response, upstreamResponse, from, to, row, upstreamModel, onClientClose, request }) {
    const bridge = createStreamBridge({ from, to })
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const decoder = new TextDecoder()
    try {
      for await (const chunk of upstreamResponse.body) {
        const out = bridge.push(decoder.decode(chunk, { stream: true }))
        if (out.length > 0) {
          response.write(out)
        }
      }
      const tail = bridge.end()
      if (tail.length > 0) {
        response.write(tail)
      }
      response.end()
      request.off('close', onClientClose)
      return {
        ok: true,
        status: upstreamResponse.status,
        upstreamModel,
        usage: bridge.usage(),
        responseId: null,
      }
    } catch (error) {
      request.off('close', onClientClose)
      return {
        ok: false,
        retryable: false,
        committed: true,
        status: 502,
        kind: 'upstream.stream_failed',
        message: `${row.display_name}: ${String(error?.message ?? error)}`,
        upstreamModel,
        usage: bridge.usage(),
      }
    }
  }
}

/** Read a JSON body, or null when it is over the cap. */
async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      return null
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed === null || typeof parsed !== 'object' ? {} : parsed
  } catch {
    return {}
  }
}

function parseConfig(row) {
  try {
    const parsed = JSON.parse(String(row?.config_json ?? '{}'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function parseSecret(row) {
  try {
    const parsed = JSON.parse(String(row?.secret_payload_json ?? '{}'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The failure policy for one account, defaults filled in. */
function failurePolicy(row) {
  const config = parseConfig(row)
  const policy = config.failure_policy ?? {}
  return {
    retry_count: clampInt(policy.retry_count, 0, 10, 2),
    retry_interval_ms: clampInt(policy.retry_interval_ms, 0, 60_000, 200),
    cooldown_enabled: policy.cooldown_enabled === true,
    cooldown_seconds: clampInt(policy.cooldown_seconds, 1, 86_400, 10),
  }
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Which model the client asked for.
 *
 * Gemini clients put it in the PATH (`/v1beta/models/<model>:generateContent`) rather than
 * the body, so the path is consulted when the body has nothing.
 */
export function requestedModel(body, path) {
  const fromBody = typeof body?.model === 'string' ? body.model.trim() : ''
  if (fromBody.length > 0) {
    return fromBody
  }
  const match = /\/models\/([^/:]+):/.exec(String(path ?? ''))
  return match === null ? null : decodeURIComponent(match[1])
}

/** Does this request want a stream? */
export function wantsStream(body, path) {
  if (body?.stream === true) {
    return true
  }
  return String(path ?? '').includes(':streamGenerateContent')
}

/** Join the account's base URL with the hop's path, keeping the client's query string. */
export function joinUpstream(baseUrl, hopPath, search, upstream) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '')
  const suffix = String(hopPath ?? '').replace(/^\/+/, '')
  // A Gemini base already carries `/v1beta` and the hop path repeats it; drop one.
  const bare =
    upstream === 'gemini' && /\/v1beta$/i.test(root) && /^v1beta\//i.test(suffix)
      ? suffix.replace(/^v1beta\//i, '')
      : suffix
  const query = typeof search === 'string' && search.length > 1 ? search : ''
  return `${root}/${bare}${query}`
}

/**
 * The headers one upstream wants.
 *
 * The credential header differs per protocol, and for Anthropic it differs per ACCOUNT: a
 * relay fronting Claude may want `x-api-key` or `Authorization`, which is what the account's
 * `api_key_field` records. Client headers are NOT forwarded wholesale — the client's own
 * `authorization` is our proxy key and must never reach the upstream.
 */
export function upstreamHeaders({ config, row, upstream, request, isStream }) {
  const secret = parseSecret(row)
  const apiKey = String(secret.api_key ?? '').trim()
  const headers = {
    'content-type': 'application/json',
    accept: isStream ? 'text/event-stream' : 'application/json',
  }
  if (upstream === 'anthropic') {
    const field = String(config.api_key_field ?? 'ANTHROPIC_API_KEY')
    if (field === 'ANTHROPIC_AUTH_TOKEN') {
      headers.authorization = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }
    // Required by the Messages API; a relay that does not care ignores it.
    headers['anthropic-version'] = String(config.anthropic_version ?? '2023-06-01')
  } else if (upstream === 'gemini') {
    headers['x-goog-api-key'] = apiKey
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value
    }
  }
  // One client header is worth passing through: it identifies the CLI to relays that meter
  // per client, and it carries no credential.
  const agent = request?.headers?.['user-agent']
  if (typeof agent === 'string' && headers['user-agent'] === undefined) {
    headers['user-agent'] = agent
  }
  return headers
}

/** Usage counts out of a non-streaming upstream body, per protocol. */
export function usageFromBody(protocol, body) {
  const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
  if (protocol === 'gemini') {
    const meta = body?.usageMetadata ?? {}
    return {
      inputTokens: count(meta.promptTokenCount),
      outputTokens: count(meta.candidatesTokenCount),
      cacheReadTokens: count(meta.cachedContentTokenCount),
      cacheWriteTokens: 0,
      reasoningTokens: count(meta.thoughtsTokenCount),
    }
  }
  if (protocol === 'anthropic') {
    const usage = body?.usage ?? {}
    return {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
    }
  }
  const usage = body?.usage ?? {}
  return {
    inputTokens: count(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
    cacheReadTokens: count(
      usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens,
    ),
    cacheWriteTokens: 0,
    reasoningTokens: count(
      usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
    ),
  }
}

/** The upstream's own id for this response, for joining against a transcript. */
export function responseIdFromBody(body) {
  for (const key of ['id', 'response_id', 'responseId']) {
    const value = body?.[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

/**
 * A local token estimate for Anthropic's `count_tokens`.
 *
 * Four characters per token is the rule of thumb the vendors' own docs use for English, and
 * this number only ever helps a client decide whether to compact — a wrong answer costs a
 * slightly early or late compaction, not a failed turn. Forwarding the call instead would
 * spend a real upstream request on arithmetic.
 */
export function estimateTokens(body) {
  let characters = 0
  const walk = (value) => {
    if (typeof value === 'string') {
      characters += value.length
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item)
      }
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) {
        walk(item)
      }
    }
  }
  walk(body?.system)
  walk(body?.messages)
  walk(body?.tools)
  return Math.max(1, Math.ceil(characters / 4))
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 300)
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms)
    timer.unref?.()
  })
}

