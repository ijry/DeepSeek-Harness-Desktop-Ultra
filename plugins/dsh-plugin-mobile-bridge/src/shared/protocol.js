/**
 * The wire contract between a desktop dsh and the MCode phone app: route
 * prefix, protocol version, capability names, error codes, and the pairing
 * config code. Pure data and pure functions only — no `node:` builtins, no DOM —
 * because the host half, the browser panel, and the app-side client all read it.
 *
 * Two deliberate compatibility choices:
 *
 * - `targetAgent` is `'dsh'`, a new value in MCode's connection vocabulary
 *   (alongside `codeg` / `opencode` / `mcode-desktop`). It is not `mcode-desktop`
 *   with a capability flag: this bridge is a different host process with a
 *   different protocol, and MCode's own architecture notes forbid modelling a
 *   separate server as a capability of an existing target.
 * - The pairing QR carries a base64url-encoded MCode **config code v2** rather
 *   than raw JSON, so MCode's existing scan path (`decodeConnectionConfigCode`)
 *   reads it with no new format. The one field combination that is new is
 *   `routeMode: 'direct'` together with `pairCode`/`pairSecret`: a LAN base URL
 *   plus a one-shot pairing exchange, because a bearer token must never sit in a
 *   QR that anyone in the room can photograph.
 *
 * @module dsh-plugin-mobile-bridge/shared/protocol
 */

import { base64UrlDecode, base64UrlEncode } from './codec.js'

/** Bridge protocol version. Bump on any breaking change to a route or frame. */
export const PROTOCOL_VERSION = '1'

/** Route prefix, identical on every carrier so one pairing URL works on all of them. */
export const ROUTE_PREFIX = '/dsh-mobile-bridge'

/** SSE path (registered as an exact route; longest-prefix keeps it disjoint). */
export const EVENTS_PATH = `${ROUTE_PREFIX}/events`

/**
 * WebSocket path for the same stream.
 *
 * Two carriers for one stream is not redundancy for its own sake: SSE is what a
 * browser and `curl` want, and a WebSocket is what MCode's uni-app runtime can
 * actually open on every platform it builds for. The frames are identical; only
 * the envelope differs (`id:` field versus an `eventId` property).
 */
export const EVENTS_WS_PATH = `${ROUTE_PREFIX}/ws`


/** MCode connection vocabulary: which host process the phone is talking to. */
export const TARGET_AGENT = 'dsh'

/** Where a user without the app goes. The panel renders this as a QR code. */
export const APP_DOWNLOAD_URL = 'https://getmcode.lingyun.net'

/**
 * Capability keys the bridge advertises in `/hello` and in the pair response.
 * A client must treat an unknown key as "ignore" and an absent key as "the
 * feature is not available", never as "assume it works".
 */
export const CAPABILITY = {
  /** Session list, history, prompt, cancel — the remote-control core. */
  sessions: 'dsh.bridge.sessions',
  /** Server-sent event stream projected from dsh's mux/host streams. */
  events: 'dsh.bridge.events',
  /** Approval and question answering from the phone. */
  answers: 'dsh.bridge.answers',
  /** Workspace listing, so the phone can start a session in a project. */
  workspaces: 'dsh.bridge.workspaces',
  /** Model directory read plus per-session model selection. */
  models: 'dsh.bridge.models',
  /** Image parts accepted on a prompt. */
  images: 'dsh.bridge.images',
}

/**
 * Closed error-code set. Shared with the app so it can branch without matching
 * on message text; `dsh_error` wraps an upstream RpcError whose own code is
 * carried in `error.dshCode`.
 */
export const ERR = {
  invalidInput: 'invalid_input',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not_found',
  pairingFailed: 'pairing_failed',
  rateLimited: 'rate_limited',
  unavailable: 'unavailable',
  dshError: 'dsh_error',
  internal: 'internal',
}

/** HTTP status for one {@link ERR} value; the carrier says nothing else. */
export function statusOf(code) {
  switch (code) {
    case ERR.invalidInput:
      return 400
    case ERR.unauthorized:
      return 401
    case ERR.forbidden:
      return 403
    case ERR.notFound:
      return 404
    case ERR.pairingFailed:
      return 401
    case ERR.rateLimited:
      return 429
    case ERR.unavailable:
      return 503
    default:
      return 500
  }
}

/**
 * An error carrying a wire code. Route handlers throw it; the carrier folds it
 * into the `{ ok: false, error }` envelope and the {@link statusOf} status.
 */
export class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    Object.assign(this, extra)
  }
}

/* ------------------------------------------------------------------ pairing */


/**
 * Pairing-code alphabet: no `I`/`O`/`0`/`1`. The code is read off a screen and
 * typed on a phone when the camera is not an option, so the pairs a human
 * confuses are simply absent rather than corrected after the fact.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** `XXXX-XXXX` over {@link CODE_ALPHABET}. */
export const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/

/**
 * Normalize a hand-typed pairing code: trim, upcase, strip separators, re-hyphenate.
 * @param {unknown} value - whatever the user typed or a client sent.
 * @returns {string} the canonical `XXXX-XXXX` form, or `''` when it cannot be one.
 */
export function normalizeCode(value) {
  const raw = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (raw.length !== 8) return ''
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  return CODE_PATTERN.test(code) ? code : ''
}

/**
 * Strip a base URL down to its canonical form: no trailing slash, no query, no
 * fragment. The route prefix is kept when present because the pairing URL points
 * at the bridge, not at the server root.
 * @param {unknown} value - a URL as configured, scanned, or typed.
 * @returns {string} the normalized URL, or `''` when it is unusable.
 */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  if (!/^https?:\/\//i.test(raw)) return ''
  return raw.replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/**
 * Build the MCode config-code payload for one reachable bridge.
 *
 * Only the fields MCode's own v2 normalizer reads are included. `targetId`,
 * `protocolVersion`, and the capability list are deliberately absent even though
 * the bridge knows them: the client learns all three from `/hello` on its first
 * request, and every byte here pushes the QR to a denser version — which is paid
 * for by the person squinting at a laptop screen, not by the protocol.
 *
 * @param {{ name: string, baseUrl: string, code: string, secret: string,
 *   candidates?: string[] }} offer - the pairing offer.
 * @returns {object} the v2 payload, ready for {@link encodeConfigCode}.
 */
export function pairingPayload(offer) {
  const payload = {
    version: 2,
    name: String(offer.name || 'dsh').slice(0, 32),
    targetAgent: TARGET_AGENT,
    routeMode: 'direct',
    directBaseUrl: normalizeBaseUrl(offer.baseUrl),
    pairCode: normalizeCode(offer.code),
    pairSecret: String(offer.secret || ''),
  }
  // At most two fallback addresses. A machine with six virtual interfaces would
  // otherwise put five useless URLs in the QR, and a phone tries them in order
  // anyway — the third one has never been the answer.
  const extra = (offer.candidates ?? [])
    .map(normalizeBaseUrl)
    .filter((url) => url !== '' && url !== payload.directBaseUrl)
    .slice(0, 2)
  if (extra.length > 0) payload.candidates = extra
  return payload
}


/** base64url-encode a config-code payload. */
export function encodeConfigCode(payload) {
  return base64UrlEncode(JSON.stringify(payload))
}

/**
 * Decode and shallow-validate a config code.
 * @param {string} code - base64url of a v2 payload.
 * @returns {object} the payload.
 * @throws {BridgeError} `invalid_input` when it is not a v2 dsh bridge payload.
 */
export function decodeConfigCode(code) {
  let payload
  try {
    payload = JSON.parse(base64UrlDecode(code))
  } catch (error) {
    throw new BridgeError(ERR.invalidInput, `配置码无法解析：${error.message}`)
  }
  if (payload === null || typeof payload !== 'object') {
    throw new BridgeError(ERR.invalidInput, '配置码不是一个对象')
  }
  if (payload.version !== 2) {
    throw new BridgeError(ERR.invalidInput, `不支持的配置码版本 ${payload.version}`)
  }
  if (payload.targetAgent !== TARGET_AGENT) {
    throw new BridgeError(ERR.invalidInput, `配置码属于 ${payload.targetAgent}，不是 ${TARGET_AGENT}`)
  }
  if (normalizeBaseUrl(payload.directBaseUrl) === '') {
    throw new BridgeError(ERR.invalidInput, '配置码缺少可用的 directBaseUrl')
  }
  return payload
}

/* ------------------------------------------------------------------- frames */

/**
 * SSE frame vocabulary. Every frame is one JSON object with a `type` and a
 * `sessionId` (except `hello`), delivered as `event: frame` with the monotonic
 * bridge event id in the SSE `id:` field so a reconnect can resume with
 * `Last-Event-ID`.
 *
 * These are a *projection* of dsh's own `MuxFrame`/`HostFrame`, not a
 * passthrough: dsh's stream carries raw event-sourced session events whose
 * replay semantics a phone client has no business reimplementing. What crosses
 * this boundary is what a chat surface needs — message starts, text deltas,
 * finished messages, tool activity, and the two answerable interactions.
 */
export const FRAME = {
  /** Stream opened: `{ protocolVersion, lastEventId, sessions }`. */
  hello: 'hello',
  /** A session appeared: `{ sessionId, blank, cwd?, title? }`. */
  sessionAdded: 'session/added',
  /** A session went away: `{ sessionId }`. */
  sessionRemoved: 'session/removed',
  /** Turn activity flipped: `{ sessionId, running }`. */
  sessionStatus: 'session/status',
  /** Title projection changed: `{ sessionId, title }`. */
  sessionTitle: 'session/title',
  /** A message began: `{ sessionId, messageId, role, turn, step }`. */
  messageStart: 'message/start',
  /** Streaming text: `{ sessionId, messageId, kind: 'text'|'reasoning', text }`. */
  messageDelta: 'message/delta',
  /** A message finalized: `{ sessionId, message }`. */
  messageEnd: 'message/end',
  /** The model asked for a tool: `{ sessionId, callId, name, arguments }`. */
  toolCall: 'tool/call',
  /** A tool answered: `{ sessionId, callId, ok, text }`. */
  toolResult: 'tool/result',
  /** Answerable: `{ sessionId, requestId, approvalId, toolName, callId?, reason? }`. */
  approvalRequested: 'approval/requested',
  /** `{ sessionId, approvalId, outcome }`. */
  approvalResolved: 'approval/resolved',
  /** Answerable: `{ sessionId, requestId, questions }`. */
  questionRequested: 'question/requested',
  /** `{ sessionId, requestId, outcome }`. */
  questionResolved: 'question/resolved',
  /** A turn finished: `{ sessionId, turn }`. */
  turnEnd: 'turn/end',
  /** Anything the bridge could not carry: `{ sessionId?, code, message }`. */
  error: 'error',
}

/** Answer kinds accepted by `POST /answers`. */
export const ANSWER_KIND = { approval: 'approval', question: 'question' }

/**
 * The only two approval outcomes a client may send. `cancelled` and
 * `unavailable` also exist in dsh's `ApprovalOutcome`, but they are host-side
 * results: a phone cannot claim them, and accepting them here would let a
 * client fabricate an outcome the host never reached.
 */
export const APPROVAL_OUTCOME = { allow: 'allowed-once', deny: 'rejected' }

