/**
 * Projection from dsh's event-sourced session log onto the chat shapes a phone
 * renders. This is the whole reason the bridge exists as a plugin rather than as
 * a reverse proxy in front of `/api`.
 *
 * dsh's own client rebuilds its surface by folding `SessionEvent`s — chunks,
 * step boundaries, surface replace operations from compaction, tool presenters
 * evaluated at pagination time. Reimplementing that fold on a phone would couple
 * the app to dsh's internal vocabulary and break on every upstream change. So
 * the bridge folds once, here, in the host process that already has the types,
 * and hands the phone finished messages and text deltas.
 *
 * Everything in this module is pure: no `ctx`, no I/O, no clock. That is what
 * makes it the testable core — see test/projection.test.mjs.
 *
 * @module dsh-plugin-mobile-bridge/host/projection
 */

import { FRAME } from '../shared/protocol.js'

/** Concatenated text of every `text` block in a content array. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

/** Concatenated text of every `reasoning` block; empty when the model exposed none. */
export function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'reasoning')
    .map((block) => String(block.text ?? ''))
    .join('')
}

/** The `tool-call` blocks of a content array, as `{ callId, name, arguments }`. */
export function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
    .map((block) => ({
      callId: String(block.id ?? block.callId ?? ''),
      name: String(block.name ?? ''),
      // The raw JSON string the model produced; the bridge never parses it,
      // because a malformed argument string is information the phone should see.
      arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
    }))
}

/** How many images a content array carries; the phone shows a count, not bytes. */
export function imageCountOf(content) {
  if (!Array.isArray(content)) return 0
  return content.filter((block) => block !== null && typeof block === 'object' && block.type === 'image').length
}

/**
 * One finished message in the phone-facing shape.
 *
 * @typedef {object} BridgeMessage
 * @property {string} messageId - dsh's own message id, stable across representations.
 * @property {'user'|'assistant'|'tool'} role - who produced it.
 * @property {number} seq - the source event's session seq; the paging cursor.
 * @property {number} at - the source event's timestamp, epoch milliseconds.
 * @property {string} text - model-facing text, concatenated.
 * @property {string} [reasoning] - reasoning text when the model exposed some.
 * @property {number} [images] - image block count, when non-zero.
 * @property {Array<{callId: string, name: string, arguments: string}>} [toolCalls]
 * @property {{callId: string, ok: boolean, name?: string}} [toolResult]
 * @property {'user'|'plugin'|'model'|'tool'|string} [origin] - `source.kind`, so
 *   the phone can tell a human prompt from an injected context message.
 * @property {string} [plugin] - contributing plugin, for `origin: 'plugin'`.
 * @property {true} [interrupted] - the turn was cancelled mid-stream.
 */

/**
 * Project one surface-bearing session event onto a {@link BridgeMessage}.
 *
 * @param {object} event - a `user/message`, `assistant/message`, or `tool/result` event.
 * @returns {BridgeMessage|null} the message, or null for an event with no surface.
 */
export function messageOf(event) {
  const seq = Number(event?.seq ?? -1)
  const at = Number(event?.time ?? 0)

  if (event?.type === 'user/message') {
    const message = event.data ?? {}
    const source = message.source ?? {}
    const out = {
      messageId: String(message.id ?? ''),
      role: 'user',
      seq,
      at,
      text: textOf(message.content),
      origin: String(source.kind ?? 'user'),
    }
    const reasoning = reasoningOf(message.content)
    if (reasoning !== '') out.reasoning = reasoning
    const images = imageCountOf(message.content)
    if (images > 0) out.images = images
    if (source.kind === 'plugin') out.plugin = String(source.plugin ?? '')
    if (typeof source.summary === 'string') out.summary = source.summary
    return out
  }

  if (event?.type === 'assistant/message') {
    const message = event.data?.message ?? {}
    const out = {
      messageId: String(message.id ?? ''),
      role: 'assistant',
      seq,
      at,
      text: textOf(message.content),
      origin: 'model',
    }
    const reasoning = reasoningOf(message.content)
    if (reasoning !== '') out.reasoning = reasoning
    const calls = toolCallsOf(message.content)
    if (calls.length > 0) out.toolCalls = calls
    if (event.data?.interrupted === true) out.interrupted = true
    return out
  }

  if (event?.type === 'tool/result') {
    const message = event.data?.message ?? {}
    const block = (Array.isArray(message.content) ? message.content : []).find(
      (part) => part !== null && typeof part === 'object' && part.type === 'tool-result',
    )
    return {
      messageId: String(message.id ?? ''),
      role: 'tool',
      seq,
      at,
      text: textOf(message.content) || toolResultText(block),
      origin: 'tool',
      toolResult: {
        callId: String(message.source?.callId ?? block?.callId ?? ''),
        ok: event.data?.error === undefined,
        ...(event.data?.error === undefined ? {} : { error: String(event.data.error.code ?? 'error') }),
      },
    }
  }

  return null
}

/**
 * Readable text for a `tool-result` block whose payload is not a text block.
 * Tool results carry tool-owned shapes; a phone gets a compact JSON rendering
 * rather than nothing, and never the raw `meta` presentation payload.
 */
function toolResultText(block) {
  if (block === undefined || block === null) return ''
  const content = block.content ?? block.result ?? block.output
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = textOf(content)
    if (text !== '') return text
  }
  if (content === undefined) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return ''
  }
}

/**
 * Fold a history page onto the message list a phone renders.
 *
 * Compaction can replace a span of earlier surface nodes with one summary node
 * (`surfaceOp: {op:'replace', start, end}`). Honouring that is what keeps a
 * compacted session from showing the same work twice: the replaced range is
 * dropped and the replacement takes its place.
 *
 * @param {Array<{event: object}>} entries - `HistoryEntry[]` from `session.history`.
 * @returns {BridgeMessage[]} messages in seq order.
 */
export function messagesOf(entries) {
  const rows = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = entry?.event ?? entry
    const message = messageOf(event)
    if (message === null) continue

    const op = event?.surfaceOp
    if (op !== null && typeof op === 'object' && op.op === 'replace') {
      const start = Number(op.start)
      const end = Number(op.end)
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].seq >= start && rows[i].seq <= end) rows.splice(i, 1)
      }
    }
    rows.push(message)
  }
  return rows.sort((a, b) => a.seq - b.seq)
}

/**
 * Project one dsh mux stream item onto zero or more bridge frames.
 *
 * Returning an array rather than one frame is the point: a single
 * `assistant/chunk` may open a message *and* carry a delta, and most dsh events
 * (step boundaries, request headers, retries, todo snapshots) project onto
 * nothing at all. A phone gets what it can render and never sees the rest.
 *
 * @param {{ rpcId: string, payload: object }} item - one stream item from
 *   `apiProxy.events.mux()`. The `rpcId` lives on the envelope, not the frame:
 *   an answerable interaction is correlated by it, so the projection must read
 *   it from here and put it on the frame as `requestId`.
 * @param {{ open?: Set<string> }} [memo] - per-stream memory of which message
 *   ids have already had a `message/start`, so a resumed stream does not repeat one.
 * @returns {object[]} bridge frames, in order.
 */
export function framesOf(item, memo = {}) {
  const frame = item?.payload ?? {}
  const rpcId = String(item?.rpcId ?? '')
  const sessionId = String(frame.sessionId ?? '')
  const open = memo.open instanceof Set ? memo.open : (memo.open = new Set())

  switch (frame.type) {
    case 'session/subscribed':
      return []

    case 'session/projection':
      // The title projection is the only unit a chat list needs; the rest
      // (list metadata, image limits) are host bookkeeping.
      if (frame.key !== 'title') return []
      return [
        {
          type: FRAME.sessionTitle,
          sessionId,
          title: typeof frame.value === 'string' ? frame.value : null,
        },
      ]

    case 'approval/requested':
      return [
        {
          type: FRAME.approvalRequested,
          sessionId,
          requestId: rpcId,
          approvalId: String(frame.approvalId ?? ''),
          toolName: String(frame.toolName ?? ''),
          ...(frame.callId === undefined ? {} : { callId: String(frame.callId) }),
          ...(frame.reason === undefined ? {} : { reason: String(frame.reason) }),
        },
      ]

    case 'approval/resolved':
      return [
        {
          type: FRAME.approvalResolved,
          sessionId,
          approvalId: String(frame.approvalId ?? ''),
          outcome: String(frame.outcome ?? ''),
        },
      ]

    case 'question/requested':
      return [
        {
          type: FRAME.questionRequested,
          sessionId,
          requestId: rpcId,
          questions: Array.isArray(frame.questions) ? frame.questions : [],
        },
      ]

    case 'question/resolved':
      return [
        {
          type: FRAME.questionResolved,
          sessionId,
          requestId: String(frame.questionRpcId ?? ''),
          outcome: String(frame.outcome ?? ''),
        },
      ]

    case 'stream/error':
      return [
        {
          type: FRAME.error,
          code: String(frame.error?.code ?? 'internal'),
          message: String(frame.error?.message ?? '流已断开'),
        },
      ]

    case 'session/event':
      return sessionEventFrames(sessionId, frame.event, open)

    default:
      return []
  }
}


/**
 * Project one raw session event. The chunk stream is where the streaming feel
 * comes from, so it is handled first and cheaply.
 *
 * `assistant/chunk` carries no message id — dsh mints that only when the step's
 * message is assembled — so the bridge keys a streaming message by
 * `turn:step`, which is exactly what identifies one model call. `message/end`
 * then carries the real id, and a client replaces its provisional bubble.
 */
function sessionEventFrames(sessionId, event, open) {
  const type = event?.type
  const data = event?.data ?? {}

  if (type === 'assistant/chunk') {
    const key = `${data.turn}:${data.step}`
    const frames = []
    if (!open.has(key)) {
      open.add(key)
      frames.push({
        type: FRAME.messageStart,
        sessionId,
        messageId: key,
        role: 'assistant',
        turn: Number(data.turn ?? 0),
        step: Number(data.step ?? 0),
      })
    }
    const chunk = data.chunk ?? {}
    if (chunk.type === 'text-delta' && String(chunk.text ?? '') !== '') {
      frames.push({ type: FRAME.messageDelta, sessionId, messageId: key, kind: 'text', text: String(chunk.text) })
    } else if (chunk.type === 'reasoning-delta' && String(chunk.text ?? '') !== '') {
      frames.push({
        type: FRAME.messageDelta,
        sessionId,
        messageId: key,
        kind: 'reasoning',
        text: String(chunk.text),
      })
    }
    return frames
  }

  if (type === 'assistant/message') {
    open.delete(`${data.turn}:${data.step}`)
    const message = messageOf(event)
    return message === null ? [] : [{ type: FRAME.messageEnd, sessionId, message, streamId: `${data.turn}:${data.step}` }]
  }

  if (type === 'user/message' || type === 'tool/result') {
    const message = messageOf(event)
    if (message === null) return []
    const frames = [{ type: FRAME.messageEnd, sessionId, message }]
    if (type === 'tool/result') {
      frames.unshift({
        type: FRAME.toolResult,
        sessionId,
        callId: message.toolResult.callId,
        ok: message.toolResult.ok,
        text: message.text,
      })
    }
    return frames
  }

  if (type === 'tool/call') {
    return [
      {
        type: FRAME.toolCall,
        sessionId,
        callId: String(data.callId ?? ''),
        name: String(data.name ?? ''),
        arguments: typeof data.arguments === 'string' ? data.arguments : '',
      },
    ]
  }

  if (type === 'session/title') {
    return [{ type: FRAME.sessionTitle, sessionId, title: String(data.title ?? '') }]
  }

  if (type === 'turn/end') {
    return [
      {
        type: FRAME.turnEnd,
        sessionId,
        turn: Number(data.turn ?? 0),
        ...(data.reason === undefined ? {} : { reason: describeReason(data.reason) }),
      },
    ]
  }

  return []
}

/** A `TurnEndReason` as a short string; the phone shows it beside the turn. */
function describeReason(reason) {
  if (typeof reason === 'string') return reason
  if (reason !== null && typeof reason === 'object') return String(reason.kind ?? 'unknown')
  return 'unknown'
}

/**
 * Project one dsh host stream item onto zero or more bridge frames.
 * @param {{ rpcId: string, payload: object }} item - one item from `apiProxy.events.host()`.
 * @returns {object[]} bridge frames.
 */
export function hostFramesOf(item) {
  const frame = item?.payload ?? {}
  const sessionId = String(frame.sessionId ?? '')
  switch (frame.type) {
    case 'host/session-added':
      return [
        {
          type: FRAME.sessionAdded,
          sessionId,
          blank: frame.blank === true,
          ...(frame.cwd === undefined ? {} : { cwd: String(frame.cwd) }),
        },
      ]
    case 'host/session-removed':
      return [{ type: FRAME.sessionRemoved, sessionId }]
    case 'host/session-status':
      return [{ type: FRAME.sessionStatus, sessionId, running: frame.running === true }]
    case 'host/agent-error':
      return [{ type: FRAME.error, sessionId, code: 'dsh_error', message: String(frame.message ?? '') }]
    case 'stream/error':
      return [
        {
          type: FRAME.error,
          code: String(frame.error?.code ?? 'internal'),
          message: String(frame.error?.message ?? '流已断开'),
        },
      ]
    default:
      // Workspace and archive churn is list bookkeeping the phone re-reads on
      // demand; forwarding it would be a second source of truth.
      return []
  }
}

/**
 * Project one dsh `SessionSummary` onto the list row a phone shows.
 * @param {object} summary - one item from `session.list`.
 * @returns {object} the row.
 */
export function summaryOf(summary) {
  const title = summary?.projections?.values?.title
  return {
    sessionId: String(summary?.sessionId ?? ''),
    title: typeof title === 'string' && title !== '' ? title : null,
    updatedAt: Number(summary?.updatedAt ?? 0),
    running: summary?.running === true,
    blank: summary?.blank === true,
    ...(summary?.cwd === undefined ? {} : { cwd: String(summary.cwd) }),
    ...(summary?.parentSessionId === undefined ? {} : { parentSessionId: String(summary.parentSessionId) }),
    ...(summary?.origin === undefined ? {} : { origin: String(summary.origin) }),
  }
}



