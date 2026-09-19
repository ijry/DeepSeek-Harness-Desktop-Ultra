/**
 * The canonical intermediate form the four protocol modules meet in.
 *
 * The reference app converts pairwise — `responses_chat.rs`, `chat_gemini.rs`,
 * `claude_gemini.rs`, twelve directed pairs in all. This port is a hub instead: every
 * protocol parses to `CanonRequest`/`CanonResponse`/`CanonStreamDelta` and renders back
 * out of them, so adding a fifth protocol is one module rather than eight converters.
 * The price is that anything with no canonical home is dropped on a cross-protocol hop
 * (Responses' `encrypted_content` reasoning blobs, Gemini `safetyRatings`), which is why
 * `index.js` keeps a literal passthrough for the same-protocol case instead of
 * round-tripping through here.
 *
 * Everything in this file is data in, data out. No I/O, no clock apart from ids.
 *
 * @typedef {{role:'system'|'user'|'assistant'|'tool', content:CanonPart[], toolCalls?:CanonToolCall[], toolCallId?:string}} CanonMessage
 * @typedef {{type:'text', text:string}|{type:'image', mediaType:string, data:string}|{type:'thinking', text:string}} CanonPart
 * @typedef {{id:string, name:string, arguments:string}} CanonToolCall
 * @typedef {{name:string, description:string, parameters:object}} CanonTool
 * @typedef {{model:string, stream:boolean, system:string, messages:CanonMessage[], tools:CanonTool[], toolChoice:unknown, maxOutputTokens:number|null, temperature:number|null, topP:number|null, stopSequences:string[], reasoningEffort:string|null, metadata:Record<string,unknown>}} CanonRequest
 * @typedef {{id:string, model:string, text:string, thinking:string, toolCalls:CanonToolCall[], finishReason:'stop'|'length'|'tool_calls'|'content_filter'|'error', usage:CanonUsage, raw:unknown}} CanonResponse
 * @typedef {{inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number, reasoningTokens:number}} CanonUsage
 *
 * @module dsh-plugin-ai-switch/host/bridge/canon
 */
import { randomUUID } from 'node:crypto'

/** The finish reasons every protocol is normalized into. */
export const FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'error']

/**
 * The canonical `toolChoice` forms, since all four modules read and write them:
 *
 *   null          the client said nothing
 *   'auto'        the model decides
 *   'none'        the model may not call a tool
 *   'required'    the model must call some tool
 *   {name}        the model must call this one
 *
 * Typed `unknown` in `CanonRequest` because it is a tagged union of a string and an
 * object, which JSDoc cannot express without more ceremony than it is worth.
 */
export const TOOL_CHOICES = ['auto', 'none', 'required']

/** Reasoning effort levels, ordered weakest to strongest. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high']

/** @returns {CanonUsage} */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

/**
 * Fold `next` onto `base`, non-zero wins.
 *
 * Every upstream reports usage as a running absolute count, not a delta — Anthropic's
 * `message_delta.usage.output_tokens` and Gemini's `usageMetadata` both restate the
 * total on every frame. Summing them would multiply the bill by the frame count.
 */
export function mergeUsage(base, next) {
  const out = { ...emptyUsage(), ...(base ?? {}) }
  if (!next) {
    return out
  }
  for (const key of Object.keys(out)) {
    const value = next[key]
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      out[key] = value
    }
  }
  return out
}

/** `input + output`, the number the OpenAI shapes call `total_tokens`. */
export function totalTokens(usage) {
  const use = usage ?? emptyUsage()
  return (use.inputTokens ?? 0) + (use.outputTokens ?? 0)
}

/** @returns {CanonRequest} */
export function emptyRequest() {
  return {
    model: '',
    stream: false,
    system: '',
    messages: [],
    tools: [],
    toolChoice: null,
    maxOutputTokens: null,
    temperature: null,
    topP: null,
    stopSequences: [],
    reasoningEffort: null,
    metadata: {},
  }
}

/** @returns {CanonResponse} */
export function emptyResponse() {
  return {
    id: '',
    model: '',
    text: '',
    thinking: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: emptyUsage(),
    raw: null,
  }
}

/** @returns {CanonPart} */
export function textPart(text) {
  return { type: 'text', text: String(text ?? '') }
}

/** @returns {CanonPart} */
export function imagePart(mediaType, data) {
  return { type: 'image', mediaType: String(mediaType ?? 'image/png'), data: String(data ?? '') }
}

/** @returns {CanonPart} */
export function thinkingPart(text) {
  return { type: 'thinking', text: String(text ?? '') }
}

/** Every `text` part, concatenated. Thinking is deliberately excluded. */
export function collectText(parts) {
  if (!Array.isArray(parts)) {
    return ''
  }
  let out = ''
  for (const part of parts) {
    if (part?.type === 'text') {
      out += part.text
    }
  }
  return out
}

/** Every `thinking` part, concatenated. */
export function collectThinking(parts) {
  if (!Array.isArray(parts)) {
    return ''
  }
  let out = ''
  for (const part of parts) {
    if (part?.type === 'thinking') {
      out += part.text
    }
  }
  return out
}

/** True when the message carries nothing at all — such messages are dropped, not rendered. */
export function isEmptyMessage(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  const hasContent = parts.some((part) => (part?.type === 'text' ? part.text.length > 0 : true))
  return !hasContent && (message?.toolCalls ?? []).length === 0
}

/** A fresh id with the prefix the target protocol expects (`call_`, `msg_`, `resp_`, …). */
export function newId(prefix) {
  return `${prefix ?? ''}${randomUUID().replace(/-/g, '')}`
}

/** @returns {CanonToolCall} */
export function toolCall(id, name, args) {
  return {
    id: typeof id === 'string' && id.length > 0 ? id : newId('call_'),
    name: String(name ?? ''),
    arguments: argumentsToString(args),
  }
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tool arguments as the JSON *string* the OpenAI shapes use.
 *
 * Anthropic and Gemini carry them as an object (`input`, `args`), the two OpenAI
 * protocols as a string, and a model streaming a half-written string is normal. So the
 * canonical form is the string and the object protocols convert at their edge.
 */
export function argumentsToString(value) {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Tool arguments as an object. A truncated or absent string becomes `{}`, never a throw. */
export function argumentsToObject(value) {
  if (isPlainObject(value)) {
    return value
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** A finite number, or null. Zero is a legitimate temperature, so it must survive. */
export function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A positive integer, or null. */
export function positiveIntOrNull(value) {
  const number = numberOrNull(value)
  if (number === null) {
    return null
  }
  const truncated = Math.trunc(number)
  return truncated > 0 ? truncated : null
}

/** A non-negative integer; anything else is 0, which is what "not reported" means for usage. */
export function countOf(value) {
  const number = numberOrNull(value)
  return number === null || number < 0 ? 0 : Math.trunc(number)
}

/** A list of non-empty strings. Accepts the bare string every protocol also allows. */
export function stringList(value) {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      out.push(item)
    }
  }
  return out
}

/** Coerce to one of `FINISH_REASONS`; unknown values mean the turn simply ended. */
export function finishReasonOf(value) {
  return FINISH_REASONS.includes(value) ? value : 'stop'
}

/** Coerce to one of `REASONING_EFFORTS`; unknown values mean "leave it to the upstream". */
export function reasoningEffortOf(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REASONING_EFFORTS.includes(text) ? text : null
}

/**
 * Effort -> a thinking token budget, for the two protocols that only speak budgets.
 *
 * The numbers are Anthropic's documented floor (1024) and the tiers the reference uses;
 * they are a policy choice, not a spec, and the caller clamps against `max_tokens`
 * because Anthropic rejects a budget that is not strictly below it.
 */
export function effortToBudget(effort) {
  switch (reasoningEffortOf(effort)) {
    case 'minimal':
      return 1024
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 24576
    default:
      return null
  }
}

/** The inverse, bucketed. A zero or negative budget means thinking is off, not minimal. */
export function budgetToEffort(budget) {
  const number = numberOrNull(budget)
  if (number === null || number <= 0) {
    return null
  }
  if (number <= 1024) {
    return 'minimal'
  }
  if (number <= 4096) {
    return 'low'
  }
  if (number <= 16384) {
    return 'medium'
  }
  return 'high'
}

/** `data:image/png;base64,AAA` -> `{mediaType, data}`; a plain URL yields null. */
export function parseDataUrl(url) {
  const text = typeof url === 'string' ? url : ''
  if (!text.startsWith('data:')) {
    return null
  }
  const comma = text.indexOf(',')
  if (comma === -1) {
    return null
  }
  const meta = text.slice(5, comma)
  const base64 = meta.endsWith(';base64')
  const mediaType = (base64 ? meta.slice(0, -7) : meta) || 'image/png'
  return { mediaType, data: text.slice(comma + 1), base64 }
}

/** The inverse; what the Chat protocol's `image_url` wants. */
export function toDataUrl(part) {
  return `data:${part?.mediaType ?? 'image/png'};base64,${part?.data ?? ''}`
}

/**
 * Fold `CanonStreamDelta`s back into a `CanonResponse`.
 *
 * Two callers need this. `index.js` needs the running usage and finish reason for the
 * quota ledger whatever the hop is, and the Responses renderer needs the finished
 * object because its terminal `response.completed` event restates the whole response —
 * a purely incremental renderer cannot produce it.
 */
export function createDeltaAccumulator() {
  const response = emptyResponse()
  /** @type {Map<number, CanonToolCall>} */
  const calls = new Map()
  let finished = false

  return {
    apply(delta) {
      switch (delta?.kind) {
        case 'start':
          if (typeof delta.id === 'string' && delta.id.length > 0) {
            response.id = delta.id
          }
          if (typeof delta.model === 'string' && delta.model.length > 0) {
            response.model = delta.model
          }
          break
        case 'text':
          response.text += String(delta.text ?? '')
          break
        case 'thinking':
          response.thinking += String(delta.text ?? '')
          break
        case 'tool-call-start':
          calls.set(delta.index ?? calls.size, {
            id: typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : newId('call_'),
            name: String(delta.name ?? ''),
            arguments: '',
          })
          break
        case 'tool-call-delta': {
          const index = delta.index ?? 0
          const call = calls.get(index) ?? { id: newId('call_'), name: '', arguments: '' }
          call.arguments += String(delta.argumentsDelta ?? '')
          calls.set(index, call)
          break
        }
        case 'usage':
          response.usage = mergeUsage(response.usage, delta.usage)
          break
        case 'finish':
          response.finishReason = finishReasonOf(delta.finishReason)
          finished = true
          break
        case 'error':
          response.finishReason = 'error'
          finished = true
          break
        default:
          break
      }
      response.toolCalls = [...calls.keys()].sort((a, b) => a - b).map((key) => calls.get(key))
      return this
    },

    /** @returns {CanonResponse} */
    snapshot() {
      return { ...response, toolCalls: response.toolCalls.map((call) => ({ ...call })) }
    },

    get finished() {
      return finished
    },
  }
}
