/**
 * Anthropic Messages — `POST /v1/messages`.
 *
 * Two structural differences from the OpenAI shapes drive most of this file: the system
 * prompt lives outside `messages`, and there is no `tool` role — a tool result is a
 * `tool_result` *block* on a user message. So one canonical tool turn becomes one user
 * message here, and one Anthropic user message can fan out into several canonical ones.
 *
 * The details that are not guessable:
 *
 * - `max_tokens` is required. A request that omits it is a 400 the client cannot act on,
 *   so a Chat request without a ceiling gets `DEFAULT_MAX_TOKENS`.
 * - `thinking.budget_tokens` must be strictly below `max_tokens`, and below Anthropic's
 *   1024 floor thinking cannot be enabled at all, so the budget is clamped both ways.
 * - Content block indices are contiguous across thinking, text and tool_use, and a block
 *   must be closed before the next opens. Claude Code keys its accumulator on that index.
 * - There is no `[DONE]`: the stream ends at `message_stop`. A bridge that appends one
 *   makes the Anthropic SDK throw on an unparseable event.
 * - A tool result carrying an image cannot be forwarded to a protocol that takes only
 *   text, so it becomes a visible marker. Dropping it silently would have the model
 *   answer as though the screenshot tool had returned nothing.
 *
 * @module dsh-plugin-ai-switch/host/bridge/anthropic
 */
import { ApiError } from '../../shared/protocol.js'
import {
  argumentsToObject,
  budgetToEffort,
  collectText,
  collectThinking,
  countOf,
  effortToBudget,
  emptyRequest,
  emptyResponse,
  emptyUsage,
  imagePart,
  isEmptyMessage,
  isPlainObject,
  newId,
  numberOrNull,
  positiveIntOrNull,
  textPart,
  thinkingPart,
  toolCall,
} from './canon.js'

export const protocol = 'anthropic'

/** What a Chat request without a ceiling becomes, because Anthropic demands one. */
export const DEFAULT_MAX_TOKENS = 4096

/** Anthropic's floor; a smaller budget cannot enable thinking at all. */
const MIN_THINKING_BUDGET = 1024

/** `stop_reason` -> canonical. `refusal` is the safety stop, added with Claude 4. */
const STOP_IN = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
}

/** Canonical -> `stop_reason`. */
const STOP_OUT = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
  error: 'end_turn',
}

// ---------------------------------------------------------------------- request

/** Wire body -> CanonRequest. */
export function parseRequest(body, _context) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_request', 'anthropic request body must be a JSON object')
  }
  if (!Array.isArray(body.messages)) {
    throw new ApiError('bridge.invalid_request', 'anthropic request requires a messages array', {
      details: 'messages',
    })
  }
  const canon = emptyRequest()
  canon.model = typeof body.model === 'string' ? body.model : ''
  canon.stream = body.stream === true
  canon.system = parseSystem(body.system)
  canon.maxOutputTokens = positiveIntOrNull(body.max_tokens)
  canon.temperature = numberOrNull(body.temperature)
  canon.topP = numberOrNull(body.top_p)
  canon.stopSequences = Array.isArray(body.stop_sequences)
    ? body.stop_sequences.filter((item) => typeof item === 'string')
    : []
  if (numberOrNull(body.top_k) !== null) {
    canon.metadata.topK = body.top_k
  }
  if (body.thinking?.type === 'enabled') {
    canon.metadata.thinkingBudget = body.thinking.budget_tokens
    canon.reasoningEffort = budgetToEffort(body.thinking.budget_tokens)
  }
  if (typeof body.metadata?.user_id === 'string') {
    canon.metadata.user = body.metadata.user_id
  }
  if (body.tool_choice?.disable_parallel_tool_use === true) {
    canon.metadata.parallelToolCalls = false
  }
  canon.toolChoice = parseToolChoice(body.tool_choice)
  canon.tools = parseTools(body.tools)

  for (const message of body.messages) {
    if (!isPlainObject(message)) {
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = normalizeBlocks(message.content)
    const parts = []
    const calls = []
    const results = []
    for (const block of blocks) {
      if (!isPlainObject(block)) {
        continue
      }
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.length > 0) {
            parts.push(textPart(block.text))
          }
          break
        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking.length > 0) {
            // `signature` is Anthropic-only and cannot be reconstructed, so it is lost.
            parts.push(thinkingPart(block.thinking))
          }
          break
        case 'image': {
          const source = isPlainObject(block.source) ? block.source : {}
          if (source.type === 'base64' && typeof source.data === 'string') {
            parts.push(imagePart(source.media_type, source.data))
          }
          // A `url` source has no canonical home; this layer may not fetch it.
          break
        }
        case 'tool_use':
          calls.push(toolCall(block.id, block.name, block.input ?? {}))
          break
        case 'tool_result':
          results.push({
            id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            text: stringifyToolResult(block),
          })
          break
        default:
          // `redacted_thinking`, `document`, `server_tool_use`, and whatever Anthropic
          // adds next: skipped rather than fatal. A degraded turn beats a 502.
          break
      }
    }
    // Results come first: they answer the previous assistant turn, and the text that
    // follows them in the same Anthropic message is the user's next instruction.
    for (const result of results) {
      canon.messages.push({ role: 'tool', content: [textPart(result.text)], toolCallId: result.id })
    }
    const built = { role, content: parts, toolCalls: calls }
    if (!isEmptyMessage(built)) {
      canon.messages.push(built)
    }
  }
  return canon
}

/** `system` is either a string or an array of text blocks (the `cache_control` form). */
function parseSystem(system) {
  if (typeof system === 'string') {
    return system
  }
  if (!Array.isArray(system)) {
    return ''
  }
  const texts = []
  for (const block of system) {
    if (typeof block === 'string') {
      texts.push(block)
    } else if (isPlainObject(block) && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts.filter((text) => text.length > 0).join('\n')
}

function normalizeBlocks(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  return Array.isArray(content) ? content : []
}

/**
 * A `tool_result` block as one string.
 *
 * The markers matter: an empty result is rejected outright by several OpenAI-compatible
 * gateways, and `is_error` has no equivalent field on the other side, so the failure has
 * to be stated in the text or the model reads a crash as a successful empty answer.
 */
function stringifyToolResult(block) {
  const content = block.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const lines = []
    for (const part of content) {
      if (typeof part === 'string') {
        lines.push(part)
      } else if (isPlainObject(part) && typeof part.text === 'string') {
        lines.push(part.text)
      } else if (isPlainObject(part) && part.type === 'image') {
        const media = part.source?.media_type ?? 'image'
        lines.push(`[ai-switch: tool returned an image (${media}) that this upstream cannot receive in a tool result]`)
      } else if (isPlainObject(part) && part.type === 'document') {
        lines.push('[ai-switch: tool returned a document that this upstream cannot receive in a tool result]')
      }
    }
    text = lines.filter((line) => line.length > 0).join('\n')
  } else if (content !== undefined && content !== null) {
    text = JSON.stringify(content)
  }
  if (text.trim().length === 0) {
    text = '[ai-switch: tool returned no content]'
  }
  return block.is_error === true ? `[tool error] ${text}` : text
}

function parseTools(tools) {
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0) {
      continue
    }
    // Server tools (`web_search_20250305`, `bash_20250124`, …) carry no `input_schema`.
    // They become plain functions, which is wrong but harmless: the model asks, the
    // client answers, and only Anthropic's own hosted execution is lost.
    out.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: isPlainObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
    })
  }
  return out
}

function parseToolChoice(choice) {
  if (!isPlainObject(choice)) {
    return null
  }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return typeof choice.name === 'string' && choice.name.length > 0 ? { name: choice.name } : 'required'
    default:
      return null
  }
}

/** CanonRequest -> `{path, body}`. */
export function renderRequest(canon, context = {}) {
  const maxTokens = canon.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  const body = {
    model: typeof context.model === 'string' && context.model.length > 0 ? context.model : canon.model,
    max_tokens: maxTokens,
    messages: renderMessages(canon.messages),
  }
  if (canon.system.length > 0) {
    // The block form, always: it is the only one that can carry `cache_control` later.
    body.system = [{ type: 'text', text: canon.system }]
  }
  if (context.isStream !== undefined ? context.isStream === true : canon.stream === true) {
    body.stream = true
  }
  if (canon.temperature !== null) {
    body.temperature = canon.temperature
  }
  if (canon.topP !== null) {
    body.top_p = canon.topP
  }
  if (numberOrNull(canon.metadata.topK) !== null) {
    body.top_k = canon.metadata.topK
  }
  if (canon.stopSequences.length > 0) {
    body.stop_sequences = canon.stopSequences
  }
  const budget = positiveIntOrNull(canon.metadata.thinkingBudget) ?? effortToBudget(canon.reasoningEffort)
  if (budget !== null) {
    // Must stay strictly under max_tokens, and under the floor it cannot be enabled.
    const clamped = Math.min(budget, maxTokens - 1)
    if (clamped >= MIN_THINKING_BUDGET) {
      body.thinking = { type: 'enabled', budget_tokens: clamped }
    }
  }
  if (typeof canon.metadata.user === 'string' && canon.metadata.user.length > 0) {
    body.metadata = { user_id: canon.metadata.user }
  }
  if (canon.tools.length > 0) {
    body.tools = canon.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
    const choice = renderToolChoice(canon.toolChoice, canon.metadata.parallelToolCalls)
    if (choice !== null) {
      body.tool_choice = choice
    }
  }
  return { path: '/messages', body }
}

function renderToolChoice(choice, parallel) {
  const base =
    choice === 'auto'
      ? { type: 'auto' }
      : choice === 'required'
        ? { type: 'any' }
        : choice === 'none'
          ? { type: 'none' }
          : isPlainObject(choice) && typeof choice.name === 'string'
            ? { type: 'tool', name: choice.name }
            : null
  if (base === null) {
    return parallel === false ? { type: 'auto', disable_parallel_tool_use: true } : null
  }
  if (parallel === false && base.type !== 'none') {
    base.disable_parallel_tool_use = true
  }
  return base
}

/**
 * Canonical messages -> Anthropic messages.
 *
 * Consecutive tool results are merged into one user message: Anthropic requires every
 * `tool_use` from one assistant turn to be answered before the next assistant turn, and
 * one message per result would interleave user turns between them.
 */
function renderMessages(messages) {
  const out = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: collectText(message.content),
      }
      const last = out[out.length - 1]
      if (last?.role === 'user' && last.content.every((item) => item.type === 'tool_result')) {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    const blocks = []
    if (message.role === 'assistant') {
      // Thinking has to lead the block list, and only within the turn that produced it.
      const thinking = collectThinking(message.content)
      if (thinking.length > 0) {
        blocks.push({ type: 'thinking', thinking, signature: '' })
      }
    }
    for (const part of message.content) {
      if (part.type === 'text' && part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
        })
      }
    }
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: argumentsToObject(call.arguments) })
    }
    if (blocks.length === 0) {
      // Anthropic rejects a message whose content array is empty.
      continue
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  return out
}

// --------------------------------------------------------------------- response

/** Upstream Anthropic JSON -> CanonResponse. */
export function parseResponse(body, canon) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_response', 'anthropic response body must be a JSON object')
  }
  const out = emptyResponse()
  out.raw = body
  out.id = typeof body.id === 'string' ? body.id : ''
  out.model = typeof body.model === 'string' ? body.model : (canon?.model ?? '')
  for (const block of Array.isArray(body.content) ? body.content : []) {
    if (!isPlainObject(block)) {
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      out.text += block.text
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      out.thinking += block.thinking
    } else if (block.type === 'tool_use') {
      out.toolCalls.push(toolCall(block.id, block.name, block.input ?? {}))
    }
  }
  out.finishReason = STOP_IN[body.stop_reason] ?? (out.toolCalls.length > 0 ? 'tool_calls' : 'stop')
  // Anthropic reports `end_turn` alongside tool use often enough that the blocks win:
  // a client seeing `stop` next to tool calls never runs them.
  if (out.toolCalls.length > 0 && out.finishReason === 'stop') {
    out.finishReason = 'tool_calls'
  }
  out.usage = parseUsage(body.usage)
  return out
}

/** Anthropic's usage object -> CanonUsage. */
export function parseUsage(usage) {
  const out = emptyUsage()
  if (!isPlainObject(usage)) {
    return out
  }
  out.inputTokens = countOf(usage.input_tokens)
  out.outputTokens = countOf(usage.output_tokens)
  out.cacheReadTokens = countOf(usage.cache_read_input_tokens)
  out.cacheWriteTokens = countOf(usage.cache_creation_input_tokens)
  return out
}

/** CanonUsage -> Anthropic's usage object. */
export function renderUsage(usage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
  }
}

/** CanonResponse -> a `message` body. */
export function renderResponse(response, canon) {
  const content = []
  if (response.thinking.length > 0) {
    content.push({ type: 'thinking', thinking: response.thinking, signature: '' })
  }
  if (response.text.length > 0) {
    content.push({ type: 'text', text: response.text })
  }
  for (const call of response.toolCalls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: argumentsToObject(call.arguments) })
  }
  return {
    id: response.id.length > 0 ? response.id : newId('msg_'),
    type: 'message',
    role: 'assistant',
    model: response.model.length > 0 ? response.model : (canon?.model ?? ''),
    content,
    stop_reason: STOP_OUT[response.finishReason] ?? 'end_turn',
    stop_sequence: null,
    usage: renderUsage(response.usage),
  }
}

// ----------------------------------------------------------------------- stream

/**
 * One Anthropic SSE frame -> deltas.
 *
 * Dispatch is on the payload's `type`, not the `event:` line, because the two always
 * agree and a relay that drops event names still works. `ping` carries nothing.
 */
export function parseStreamEvent(event, state) {
  const data = typeof event?.data === 'string' ? event.data.trim() : ''
  if (data.length === 0) {
    return []
  }
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    return []
  }
  if (!isPlainObject(payload)) {
    return []
  }
  const type = typeof payload.type === 'string' ? payload.type : event?.event
  const out = []
  switch (type) {
    case 'message_start': {
      const message = isPlainObject(payload.message) ? payload.message : {}
      state.blocks = new Map()
      state.toolIndex = 0
      out.push({
        kind: 'start',
        id: typeof message.id === 'string' ? message.id : '',
        model: typeof message.model === 'string' ? message.model : '',
      })
      if (isPlainObject(message.usage)) {
        out.push({ kind: 'usage', usage: parseUsage(message.usage) })
      }
      break
    }
    case 'content_block_start': {
      const block = isPlainObject(payload.content_block) ? payload.content_block : {}
      const index = countOf(payload.index)
      state.blocks = state.blocks ?? new Map()
      if (block.type === 'tool_use') {
        // Anthropic block indices count text and thinking too; a chat client wants a
        // contiguous, tool-only index, so the two numberings are kept apart here.
        const toolIndex = state.toolIndex ?? 0
        state.toolIndex = toolIndex + 1
        state.blocks.set(index, { kind: 'tool', toolIndex })
        out.push({
          kind: 'tool-call-start',
          index: toolIndex,
          id: typeof block.id === 'string' ? block.id : newId('call_'),
          name: typeof block.name === 'string' ? block.name : '',
        })
      } else {
        state.blocks.set(index, { kind: block.type === 'thinking' ? 'thinking' : 'text' })
        // A non-empty opening block happens when a relay batches; forward it.
        const seed = block.type === 'thinking' ? block.thinking : block.text
        if (typeof seed === 'string' && seed.length > 0) {
          out.push({ kind: block.type === 'thinking' ? 'thinking' : 'text', text: seed })
        }
      }
      break
    }
    case 'content_block_delta': {
      const delta = isPlainObject(payload.delta) ? payload.delta : {}
      const block = state.blocks?.get(countOf(payload.index))
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        out.push({ kind: 'text', text: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        out.push({ kind: 'thinking', text: delta.thinking })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        out.push({ kind: 'tool-call-delta', index: block?.toolIndex ?? 0, argumentsDelta: delta.partial_json })
      }
      // `signature_delta` is the thinking attestation; it cannot cross a protocol edge.
      break
    }
    case 'content_block_stop': {
      const block = state.blocks?.get(countOf(payload.index))
      if (block?.kind === 'tool') {
        out.push({ kind: 'tool-call-end', index: block.toolIndex })
      }
      break
    }
    case 'message_delta': {
      if (isPlainObject(payload.usage)) {
        out.push({ kind: 'usage', usage: parseUsage(payload.usage) })
      }
      const stop = payload.delta?.stop_reason
      if (typeof stop === 'string') {
        state.finishReason = STOP_IN[stop] ?? ((state.toolIndex ?? 0) > 0 ? 'tool_calls' : 'stop')
      }
      break
    }
    case 'message_stop':
      state.terminal = true
      out.push({ kind: 'finish', finishReason: state.finishReason ?? 'stop' })
      break
    case 'error':
      state.terminal = true
      out.push({ kind: 'error', message: String(payload.error?.message ?? 'upstream error') })
      break
    default:
      // `ping` and anything newer.
      break
  }
  return out
}

const frame = (name, payload) => ({ event: name, data: JSON.stringify({ type: name, ...payload }) })

/** Close whichever block is open; Anthropic forbids interleaving. */
function closeBlock(state, frames) {
  if (state.openIndex === undefined) {
    return
  }
  frames.push(frame('content_block_stop', { index: state.openIndex }))
  state.openIndex = undefined
  state.openKind = undefined
}

/** Open a block of `kind`, closing the previous one, and return its index. */
function openBlock(state, frames, kind, block) {
  if (state.openKind === kind && kind !== 'tool_use') {
    return state.openIndex
  }
  closeBlock(state, frames)
  const index = state.nextIndex ?? 0
  state.nextIndex = index + 1
  state.openIndex = index
  state.openKind = kind
  frames.push(frame('content_block_start', { index, content_block: block }))
  return index
}

/**
 * Deltas -> Anthropic SSE frames.
 *
 * `message_start` has to carry a full message skeleton before any block, so it is emitted
 * lazily on the first delta with whatever id, model and input usage are known by then.
 * Nothing follows `message_stop` — no `[DONE]`.
 */
export function renderStreamEvents(deltas, state) {
  const frames = []
  const start = () => {
    if (state.startSent === true) {
      return
    }
    state.startSent = true
    state.nextIndex = 0
    frames.push(
      frame('message_start', {
        message: {
          id: state.id ?? newId('msg_'),
          type: 'message',
          role: 'assistant',
          model: state.model ?? '',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: renderUsage({ ...emptyUsage(), ...(state.usage ?? {}) }),
        },
      }),
    )
  }

  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (state.stopped === true) {
      break
    }
    if (delta.kind === 'start') {
      if (typeof delta.id === 'string' && delta.id.length > 0) {
        state.id = delta.id
      }
      if (typeof delta.model === 'string' && delta.model.length > 0) {
        state.model = delta.model
      }
      continue
    }
    if (delta.kind === 'usage') {
      // Folded into whichever event goes out next: `message_start` if the skeleton has
      // not left yet, `message_delta` otherwise. Anthropic has no usage-only event.
      state.usage = { ...emptyUsage(), ...(state.usage ?? {}), ...delta.usage }
      continue
    }
    switch (delta.kind) {
      case 'text':
        start()
        openBlock(state, frames, 'text', { type: 'text', text: '' })
        frames.push(frame('content_block_delta', {
          index: state.openIndex,
          delta: { type: 'text_delta', text: delta.text },
        }))
        break
      case 'thinking':
        start()
        openBlock(state, frames, 'thinking', { type: 'thinking', thinking: '' })
        frames.push(frame('content_block_delta', {
          index: state.openIndex,
          delta: { type: 'thinking_delta', thinking: delta.text },
        }))
        break
      case 'tool-call-start': {
        start()
        const index = openBlock(state, frames, 'tool_use', {
          type: 'tool_use',
          id: delta.id ?? newId('call_'),
          name: delta.name ?? '',
          input: {},
        })
        state.toolBlocks = state.toolBlocks ?? new Map()
        state.toolBlocks.set(delta.index ?? 0, index)
        break
      }
      case 'tool-call-delta': {
        const index = state.toolBlocks?.get(delta.index ?? 0)
        if (index !== undefined && String(delta.argumentsDelta ?? '').length > 0) {
          frames.push(frame('content_block_delta', {
            index,
            delta: { type: 'input_json_delta', partial_json: delta.argumentsDelta },
          }))
        }
        break
      }
      case 'tool-call-end':
        if (state.toolBlocks?.get(delta.index ?? 0) === state.openIndex) {
          closeBlock(state, frames)
        }
        break
      case 'finish':
        start()
        closeBlock(state, frames)
        frames.push(frame('message_delta', {
          delta: { stop_reason: STOP_OUT[delta.finishReason] ?? 'end_turn', stop_sequence: null },
          usage: renderUsage({ ...emptyUsage(), ...(state.usage ?? {}) }),
        }))
        frames.push(frame('message_stop', {}))
        state.stopped = true
        break
      case 'error':
        start()
        closeBlock(state, frames)
        frames.push({
          event: 'error',
          data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: delta.message ?? 'upstream error' } }),
        })
        state.stopped = true
        break
      default:
        break
    }
  }
  return frames
}
