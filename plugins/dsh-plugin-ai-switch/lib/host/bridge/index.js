/**
 * The bridge dispatcher: which protocol a local path speaks, and one hop between any two.
 *
 * Local CLIs are hard-wired to one wire format each — Codex speaks Responses, Claude Code
 * speaks Messages, Gemini CLI speaks Gemini, everything else speaks Chat Completions —
 * while the account they end up on speaks whatever its `interface_format` says. This file
 * is the 4x4 of that, and the only place in `bridge/` that knows more than one protocol.
 *
 * The diagonal is a deliberate special case. `from === to` substitutes the upstream model
 * id and then leaves the body and the stream bytes alone, because a round trip through
 * `canon.js` would silently drop everything canon has no field for: Responses'
 * `encrypted_content` reasoning blobs, Gemini `safetyRatings`, `logprobs`, Anthropic
 * `cache_control`. The stream is still *read* on the diagonal, but only to observe usage
 * and the finish reason for the quota ledger; the bytes forwarded are the original ones.
 *
 * @module dsh-plugin-ai-switch/host/bridge/index
 */
import { ApiError } from '../../shared/protocol.js'
import * as anthropic from './anthropic.js'
import { createDeltaAccumulator, emptyUsage, isPlainObject } from './canon.js'
import * as chat from './chat.js'
import * as gemini from './gemini.js'
import * as responses from './responses.js'
import { createSseParser, encodeSseFrames } from './sse.js'

export const PROTOCOLS = ['chat', 'responses', 'anthropic', 'gemini']

const MODULES = { chat, responses, anthropic, gemini }

/** The module for a protocol id, or a thrown `bridge.unsupported_protocol`. */
export function moduleFor(protocol) {
  const module = MODULES[protocol]
  if (module === undefined) {
    throw new ApiError('bridge.unsupported_protocol', `unknown protocol: ${String(protocol)}`, {
      details: String(protocol),
    })
  }
  return module
}

/**
 * `/v1/chat/completions` -> `chat/completions`.
 *
 * Version segments are stripped repeatedly and case-insensitively (`v1`, `v1beta`, `v2`)
 * because clients disagree about how many to send and some send `/v1/v1/…`. The query
 * string and trailing slashes go too.
 */
function canonicalPath(path) {
  let text = typeof path === 'string' ? path.trim() : ''
  const cut = text.search(/[?#]/)
  if (cut !== -1) {
    text = text.slice(0, cut)
  }
  text = text.replace(/^\/+/, '').replace(/\/+$/, '')
  let segments = text.split('/')
  while (segments.length > 1 && /^v\d/i.test(segments[0])) {
    segments = segments.slice(1)
  }
  return segments.join('/')
}

/**
 * Which protocol a local request path speaks; null when the path is not a chat entry point.
 *
 * Note that the platform is *not* derived from the path — a Codex CLI pointed at this
 * proxy still posts to `/v1/responses`, and an OpenAI-compatible harness posts to
 * `/v1/chat/completions` whatever platform its credential belongs to.
 */
export function detectLocalProtocol(path) {
  const text = canonicalPath(path)
  if (text === 'chat/completions') {
    return 'chat'
  }
  if (text === 'responses') {
    return 'responses'
  }
  if (text === 'messages') {
    return 'anthropic'
  }
  if (/^models\/[^/]+:(?:stream)?[Gg]enerateContent$/.test(text)) {
    return 'gemini'
  }
  return null
}

/** `/models`, `/v1/models` and Gemini's `/v1beta/models` all list models. */
export function isModelsPath(path) {
  return canonicalPath(path) === 'models'
}

/** Anthropic's token estimator endpoint, which never reaches an upstream. */
export function isCountTokensPath(path) {
  return canonicalPath(path) === 'messages/count_tokens'
}

/** True when this request wants an SSE response, whichever protocol asked. */
function wantsStream({ protocol, body, path, isStream }) {
  if (typeof isStream === 'boolean') {
    return isStream
  }
  if (protocol === 'gemini') {
    return gemini.isStreamPath(path)
  }
  return isPlainObject(body) && body.stream === true
}

/**
 * The upstream path a same-protocol hop keeps.
 *
 * Deliberately version-less: the caller joins it onto the account's base URL, and base
 * URLs disagree about whether they already end in `/v1`.
 */
function diagonalPath(protocol, model, stream) {
  switch (protocol) {
    case 'chat':
      return '/chat/completions'
    case 'responses':
      return '/responses'
    case 'anthropic':
      return '/messages'
    default:
      return `/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  }
}

/**
 * Upstream URL path + body for one hop.
 *
 * @param options.from - the protocol the client spoke.
 * @param options.to - the account's `interface_format`.
 * @param options.body - the parsed client body.
 * @param options.model - the upstream model id, which replaces whatever the client asked for.
 * @param options.isStream - overrides the flag in the body/path when given.
 * @param options.path - the client's path; the only place Gemini keeps its model and method.
 * @returns `{path, body, stream}`
 */
export function buildUpstreamRequest({ from, to, body, model, isStream, path } = {}) {
  const source = moduleFor(from)
  const target = moduleFor(to)
  const stream = wantsStream({ protocol: from, body, path, isStream })

  if (from === to) {
    const upstreamModel = typeof model === 'string' && model.length > 0 ? model : modelOf(from, body, path)
    return {
      path: diagonalPath(from, upstreamModel, stream),
      // Untouched apart from the model: see the note at the top of this file.
      body: from === 'gemini' ? body : { ...(isPlainObject(body) ? body : {}), model: upstreamModel },
      stream,
    }
  }

  const canon = source.parseRequest(body, { model, path, isStream: stream })
  const rendered = target.renderRequest(canon, { model, isStream: stream })
  return { path: rendered.path, body: rendered.body, stream, canon }
}

/** Where each protocol keeps the model id. Gemini's is in the URL, not the body. */
function modelOf(protocol, body, path) {
  if (protocol === 'gemini') {
    return gemini.modelFromPath(path)
  }
  return isPlainObject(body) && typeof body.model === 'string' ? body.model : ''
}

/** The key each protocol puts its actual output under. */
const SUCCESS_KEYS = ['choices', 'output', 'content', 'candidates']

/**
 * True when this body is only an error envelope.
 *
 * Every protocol's error shape is different and none of them is translatable, so an
 * error body is forwarded as it came. That is deliberate: the proxy's credential
 * failover reads `error` off the body it sends on, and rewriting it into a clean
 * assistant turn would keep a dead account in the rotation.
 */
function isErrorBody(body) {
  return isPlainObject(body) && isPlainObject(body.error) && !SUCCESS_KEYS.some((key) => body[key] !== undefined)
}

/**
 * Non-streaming response translation.
 *
 * @param options.canon - the `CanonRequest` from `buildUpstreamRequest`, used only as a
 *   fallback for the model name when the upstream does not echo one.
 * @returns `{body}`
 */
export function translateResponse({ from, to, body, canon } = {}) {
  const source = moduleFor(from)
  const target = moduleFor(to)
  if (from === to || isErrorBody(body)) {
    return { body }
  }
  return { body: target.renderResponse(source.parseResponse(body, canon), canon) }
}

/**
 * Streaming translation: feed upstream SSE text, get local SSE text out.
 *
 * `from` is the *upstream* protocol here and `to` the local one, the opposite way round
 * from `buildUpstreamRequest`, because a response travels back the other way.
 *
 * `push()` returns text that is ready to write to the client socket, so the proxy never
 * has to know what a frame looks like. It may legitimately return `''`: one upstream frame
 * is often not one local frame, and Responses in particular emits three bracket events
 * before the first character of text.
 */
export function createStreamBridge({ from, to, canon } = {}) {
  const source = moduleFor(from)
  const target = moduleFor(to)
  const parser = createSseParser()
  const accumulator = createDeltaAccumulator()
  const parseState = {}
  // Seeded from the request so a local frame still names a model when the upstream — as
  // Gemini's per-frame shape and several relays do — never repeats one.
  const renderState = { model: typeof canon?.model === 'string' ? canon.model : '' }
  const passthrough = from === to
  let finishReason = null
  /**
   * The terminal delta, held back until the upstream says nothing more is coming.
   *
   * Chat reports usage in a chunk *after* `finish_reason`, while both Responses and
   * Anthropic must carry the final counts inside their terminal event. Rendering the
   * finish the moment it is parsed would therefore report every chat-upstream turn to
   * Codex and Claude Code as zero tokens. Nothing is lost by waiting: an upstream always
   * closes the body right after its own sentinel, and `parseStreamEvent` sets
   * `state.terminal` as soon as it sees one.
   */
  let pendingFinish = null

  /** Observe every delta, holding the terminal one back. */
  const consume = (frames) => {
    const deltas = []
    for (const frame of frames) {
      for (const delta of source.parseStreamEvent(frame, parseState)) {
        accumulator.apply(delta)
        if (delta.kind === 'finish' || delta.kind === 'error') {
          finishReason = delta.kind === 'error' ? 'error' : (delta.finishReason ?? 'stop')
          pendingFinish = pendingFinish ?? delta
          continue
        }
        deltas.push(delta)
      }
    }
    return deltas
  }

  /** Move the held terminal delta into the render list. */
  const release = (deltas) => {
    if (pendingFinish === null) {
      return deltas
    }
    const terminal = pendingFinish
    pendingFinish = null
    return deltas.concat([terminal])
  }

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      let deltas = consume(parser.push(text))
      if (parseState.terminal === true) {
        deltas = release(deltas)
      }
      // On the diagonal the observed deltas are thrown away and the original bytes win.
      return passthrough ? text : encodeSseFrames(target.renderStreamEvents(deltas, renderState))
    },

    end() {
      let deltas = release(consume(parser.end()))
      if (passthrough) {
        return ''
      }
      // An upstream that closes without a terminal event still owes the client one:
      // without it an Anthropic reader waits forever for `message_stop`, and a Chat
      // reader for `[DONE]`.
      if (finishReason === null) {
        const synthetic = { kind: 'finish', finishReason: 'stop' }
        accumulator.apply(synthetic)
        finishReason = 'stop'
        deltas = deltas.concat([synthetic])
      }
      return encodeSseFrames(target.renderStreamEvents(deltas, renderState))
    },

    /** @returns {import('./canon.js').CanonUsage} */
    usage() {
      return accumulator.snapshot().usage ?? emptyUsage()
    },

    /** The finish reason the upstream reported, or null while the turn is still open. */
    finishReason() {
      return finishReason
    },

    /** The whole turn so far, for callers that log or cache the assistant message. */
    snapshot() {
      return accumulator.snapshot()
    },
  }
}
