/**
 * OpenAI Chat Completions — `POST /v1/chat/completions`.
 *
 * The lingua franca. Every OpenAI-compatible relay speaks it, so it is both a protocol
 * in its own right and the shape most upstream accounts are configured as, which makes
 * it the most exercised module here.
 *
 * Three things about it are conventions rather than spec, and all three are load-bearing
 * for real traffic:
 *
 * - Reasoning has no official field. DeepSeek, OpenRouter and most relays settled on
 *   `reasoning_content` (message) / `delta.reasoning_content` (stream), with `reasoning`
 *   as a second spelling. Both are read; `reasoning_content` is written.
 * - `max_tokens` was deprecated in favour of `max_completion_tokens` but relays are split
 *   on which they honour, so a rendered request carries both.
 * - Streamed usage only arrives if the request asked for it via
 *   `stream_options.include_usage`, and it arrives in a trailing chunk whose `choices` is
 *   empty. A client that ignores empty-choice chunks silently loses its token counts.
 *
 * @module dsh-plugin-ai-switch/host/bridge/chat
 */
import { ApiError } from '../../shared/protocol.js'
import {
  collectText,
  collectThinking,
  countOf,
  emptyRequest,
  emptyResponse,
  emptyUsage,
  finishReasonOf,
  imagePart,
  isPlainObject,
  mergeUsage,
  newId,
  numberOrNull,
  parseDataUrl,
  positiveIntOrNull,
  reasoningEffortOf,
  stringList,
  textPart,
  thinkingPart,
  toDataUrl,
  toolCall,
  totalTokens,
} from './canon.js'
import { SSE_DONE } from './sse.js'

export const protocol = 'chat'

/** Chat's own finish reasons are already the canonical set, bar `function_call`. */
const FINISH_IN = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
  error: 'error',
}

// ---------------------------------------------------------------------- request

/**
 * Wire body -> CanonRequest.
 *
 * @param body - the parsed JSON of a `/v1/chat/completions` request.
 * @returns {import('./canon.js').CanonRequest}
 */
export function parseRequest(body, _context) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_request', 'chat request body must be a JSON object')
  }
  if (!Array.isArray(body.messages)) {
    throw new ApiError('bridge.invalid_request', 'chat request requires a messages array', {
      details: 'messages',
    })
  }
  const canon = emptyRequest()
  canon.model = typeof body.model === 'string' ? body.model : ''
  canon.stream = body.stream === true
  canon.temperature = numberOrNull(body.temperature)
  canon.topP = numberOrNull(body.top_p)
  canon.maxOutputTokens = positiveIntOrNull(body.max_completion_tokens ?? body.max_tokens)
  canon.stopSequences = stringList(body.stop)
  canon.reasoningEffort = reasoningEffortOf(body.reasoning_effort ?? body.reasoning?.effort)
  canon.toolChoice = parseToolChoice(body.tool_choice)
  canon.tools = parseTools(body.tools)

  const systems = []
  for (const message of body.messages) {
    if (!isPlainObject(message)) {
      continue
    }
    const role = typeof message.role === 'string' ? message.role : ''
    // `developer` is the Responses-era rename of `system`; relays accept both.
    if (role === 'system' || role === 'developer') {
      systems.push(collectText(parseContent(message.content)))
      continue
    }
    if (role === 'tool' || role === 'function') {
      canon.messages.push({
        role: 'tool',
        content: parseContent(message.content),
        // The legacy `function` role keyed results by name, not by call id.
        toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : String(message.name ?? ''),
      })
      continue
    }
    if (role === 'assistant') {
      const parts = parseContent(message.content)
      const thinking = message.reasoning_content ?? message.reasoning
      if (typeof thinking === 'string' && thinking.length > 0) {
        parts.unshift(thinkingPart(thinking))
      }
      const calls = []
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!isPlainObject(call)) {
          continue
        }
        calls.push(toolCall(call.id, call.function?.name, call.function?.arguments))
      }
      canon.messages.push({ role: 'assistant', content: parts, toolCalls: calls })
      continue
    }
    canon.messages.push({ role: 'user', content: parseContent(message.content) })
  }
  canon.system = systems.filter((text) => text.length > 0).join('\n\n')

  if (isPlainObject(body.response_format)) {
    canon.metadata.responseFormat = body.response_format
  }
  if (typeof body.parallel_tool_calls === 'boolean') {
    canon.metadata.parallelToolCalls = body.parallel_tool_calls
  }
  if (body.stream_options?.include_usage === true) {
    canon.metadata.includeUsage = true
  }
  if (typeof body.user === 'string' && body.user.length > 0) {
    canon.metadata.user = body.user
  }
  // Not an OpenAI field, but every relay that fronts Anthropic or Gemini forwards it.
  if (numberOrNull(body.top_k) !== null) {
    canon.metadata.topK = body.top_k
  }
  return canon
}

/** Chat content: a bare string, or the multimodal part array. */
function parseContent(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [textPart(content)] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(textPart(part))
      continue
    }
    if (!isPlainObject(part)) {
      continue
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(textPart(part.text))
      continue
    }
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      const parsed = parseDataUrl(url)
      // A remote http(s) image has no canonical home: the other three protocols only
      // take inline bytes, and this layer is forbidden from fetching. It is dropped.
      if (parsed !== null) {
        parts.push(imagePart(parsed.mediaType, parsed.data))
      }
      continue
    }
    // `input_audio` and `file` parts have no equivalent anywhere else; dropped.
  }
  return parts
}

/** Chat's nested tool shape -> the flat canonical one. */
function parseTools(tools) {
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(tool)) {
      continue
    }
    const fn = isPlainObject(tool.function) ? tool.function : tool
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (name.length === 0) {
      continue
    }
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    })
  }
  return out
}

/** `auto` | `none` | `required` | `{name}` | null — the canonical tool-choice forms. */
function parseToolChoice(value) {
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none') {
      return value
    }
    if (value === 'required' || value === 'any') {
      return 'required'
    }
    return null
  }
  if (isPlainObject(value)) {
    const name = value.function?.name ?? value.name
    if (typeof name === 'string' && name.length > 0) {
      return { name }
    }
  }
  return null
}

/** The canonical tool choice -> chat's `tool_choice`, or undefined when unspecified. */
export function renderToolChoice(choice) {
  if (choice === 'auto' || choice === 'none') {
    return choice
  }
  if (choice === 'required') {
    return 'required'
  }
  if (isPlainObject(choice) && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

/**
 * True when this model rejects `max_tokens` outright.
 *
 * OpenAI deprecated `max_tokens` and then made it a hard 400 on the reasoning families,
 * so the ceiling has to travel under exactly one of the two names. Everything else —
 * every relay, every open-weights gateway — understands `max_tokens` and many do not
 * know the new name at all, so that stays the default.
 */
function requiresMaxCompletionTokens(model) {
  const text = typeof model === 'string' ? model.trim().toLowerCase() : ''
  return /^o\d/.test(text) || /^gpt-5/.test(text)
}

/**
 * CanonRequest -> `{path, body}`.
 *
 * @param context - `{model, isStream}`; `model` is the upstream id that replaces the
 *   client's, which is the whole point of the route layer.
 */
export function renderRequest(canon, context = {}) {
  const stream = context.isStream === undefined ? canon.stream === true : context.isStream === true
  const messages = []
  if (canon.system.length > 0) {
    messages.push({ role: 'system', content: canon.system })
  }
  for (const message of canon.messages) {
    messages.push(...renderMessage(message))
  }
  const model = typeof context.model === 'string' && context.model.length > 0 ? context.model : canon.model
  const body = { model, messages, stream }
  if (canon.maxOutputTokens !== null) {
    if (requiresMaxCompletionTokens(model)) {
      body.max_completion_tokens = canon.maxOutputTokens
    } else {
      body.max_tokens = canon.maxOutputTokens
    }
  }
  if (canon.temperature !== null) {
    body.temperature = canon.temperature
  }
  if (canon.topP !== null) {
    body.top_p = canon.topP
  }
  if (canon.stopSequences.length > 0) {
    body.stop = canon.stopSequences
  }
  if (canon.reasoningEffort !== null) {
    body.reasoning_effort = canon.reasoningEffort
  }
  if (canon.tools.length > 0) {
    body.tools = canon.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    const choice = renderToolChoice(canon.toolChoice)
    if (choice !== undefined) {
      body.tool_choice = choice
    }
    if (typeof canon.metadata.parallelToolCalls === 'boolean') {
      body.parallel_tool_calls = canon.metadata.parallelToolCalls
    }
  }
  if (isPlainObject(canon.metadata.responseFormat)) {
    body.response_format = canon.metadata.responseFormat
  }
  if (typeof canon.metadata.user === 'string') {
    body.user = canon.metadata.user
  }
  // Not an OpenAI field, but relays fronting Anthropic or Gemini honour it and dropping
  // it silently changes the sampling the client asked for.
  if (numberOrNull(canon.metadata.topK) !== null) {
    body.top_k = canon.metadata.topK
  }
  if (stream) {
    // Ask for usage unconditionally: the ledger needs it even when the client did not.
    body.stream_options = { include_usage: true }
  }
  return { path: '/chat/completions', body }
}

/** One canonical message -> one or more chat messages (a tool turn can fan out). */
function renderMessage(message) {
  if (message.role === 'tool') {
    return [
      {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: collectText(message.content),
      },
    ]
  }
  if (message.role === 'assistant') {
    const out = { role: 'assistant' }
    const text = collectText(message.content)
    const thinking = collectThinking(message.content)
    const calls = message.toolCalls ?? []
    // `content: null` is how the API spells "this turn was only a tool call".
    out.content = text.length > 0 ? text : calls.length > 0 ? null : ''
    if (thinking.length > 0) {
      out.reasoning_content = thinking
    }
    if (calls.length > 0) {
      out.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
    }
    return [out]
  }
  if (message.role === 'system') {
    return [{ role: 'system', content: collectText(message.content) }]
  }
  const hasImage = message.content.some((part) => part.type === 'image')
  if (!hasImage) {
    return [{ role: 'user', content: collectText(message.content) }]
  }
  const content = []
  for (const part of message.content) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: toDataUrl(part) } })
    }
  }
  return [{ role: 'user', content }]
}

// --------------------------------------------------------------------- response

/**
 * Upstream chat JSON -> CanonResponse.
 *
 * @returns {import('./canon.js').CanonResponse}
 */
export function parseResponse(body, canon) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_response', 'chat response body must be a JSON object')
  }
  const out = emptyResponse()
  out.raw = body
  out.id = typeof body.id === 'string' ? body.id : ''
  out.model = typeof body.model === 'string' ? body.model : (canon?.model ?? '')
  const choice = Array.isArray(body.choices) ? body.choices[0] : null
  if (!isPlainObject(choice)) {
    throw new ApiError('bridge.invalid_response', 'chat response has no choices', { details: 'choices' })
  }
  const message = isPlainObject(choice.message) ? choice.message : {}
  out.text = typeof message.content === 'string' ? message.content : collectText(parseContent(message.content))
  const thinking = message.reasoning_content ?? message.reasoning
  out.thinking = typeof thinking === 'string' ? thinking : ''
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (isPlainObject(call)) {
      out.toolCalls.push(toolCall(call.id, call.function?.name, call.function?.arguments))
    }
  }
  out.finishReason = FINISH_IN[choice.finish_reason] ?? (out.toolCalls.length > 0 ? 'tool_calls' : 'stop')
  out.usage = parseUsage(body.usage)
  return out
}

/** Chat's usage object -> CanonUsage. Exported: the Responses module reuses the details shapes. */
export function parseUsage(usage) {
  const out = emptyUsage()
  if (!isPlainObject(usage)) {
    return out
  }
  out.inputTokens = countOf(usage.prompt_tokens ?? usage.input_tokens)
  out.outputTokens = countOf(usage.completion_tokens ?? usage.output_tokens)
  out.cacheReadTokens = countOf(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens)
  // Chat has no write-cache counter of its own; relays fronting Anthropic add this one.
  out.cacheWriteTokens = countOf(usage.prompt_tokens_details?.cache_creation_tokens ?? usage.cache_creation_input_tokens)
  out.reasoningTokens = countOf(usage.completion_tokens_details?.reasoning_tokens)
  // A relay that only reports the total still tells us the input side.
  if (out.inputTokens === 0 && countOf(usage.total_tokens) > out.outputTokens) {
    out.inputTokens = countOf(usage.total_tokens) - out.outputTokens
  }
  return out
}

/** CanonUsage -> chat's usage object. */
export function renderUsage(usage) {
  const out = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: totalTokens(usage),
  }
  if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) {
    out.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
    if (usage.cacheWriteTokens > 0) {
      out.prompt_tokens_details.cache_creation_tokens = usage.cacheWriteTokens
    }
  }
  if (usage.reasoningTokens > 0) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  }
  return out
}

/** CanonResponse -> a `chat.completion` body. */
export function renderResponse(response, canon) {
  const message = { role: 'assistant', content: response.text.length > 0 ? response.text : null }
  if (response.thinking.length > 0) {
    message.reasoning_content = response.thinking
  }
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  if (message.content === null && message.tool_calls === undefined) {
    message.content = ''
  }
  return {
    id: response.id.length > 0 ? response.id : newId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model.length > 0 ? response.model : (canon?.model ?? ''),
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReasonOf(response.finishReason),
      },
    ],
    usage: renderUsage(response.usage),
  }
}

// ----------------------------------------------------------------------- stream

/**
 * One chat SSE frame -> deltas.
 *
 * `[DONE]` yields nothing: it is framing, and `index.js` is what guarantees a `finish`
 * delta exists by synthesising one at stream end if the upstream never sent
 * `finish_reason`. Some relays genuinely do not.
 */
export function parseStreamEvent(event, state) {
  const data = typeof event?.data === 'string' ? event.data.trim() : ''
  if (data === SSE_DONE) {
    // The sentinel is the upstream saying "nothing follows", which is what lets the
    // dispatcher flush a held-back terminal event without waiting for the socket.
    state.terminal = true
    return []
  }
  if (data.length === 0) {
    return []
  }
  let chunk
  try {
    chunk = JSON.parse(data)
  } catch {
    // A non-JSON frame in a chat stream is a broken upstream, not a fatal bridge error.
    return []
  }
  if (!isPlainObject(chunk)) {
    return []
  }
  const out = []
  if (isPlainObject(chunk.error)) {
    return [{ kind: 'error', message: String(chunk.error.message ?? 'upstream error') }]
  }
  if (state.started !== true) {
    state.started = true
    out.push({ kind: 'start', id: typeof chunk.id === 'string' ? chunk.id : '', model: typeof chunk.model === 'string' ? chunk.model : '' })
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null
  if (isPlainObject(choice)) {
    const delta = isPlainObject(choice.delta) ? choice.delta : {}
    const thinking = delta.reasoning_content ?? delta.reasoning
    if (typeof thinking === 'string' && thinking.length > 0) {
      out.push({ kind: 'thinking', text: thinking })
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out.push({ kind: 'text', text: delta.content })
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isPlainObject(call)) {
        continue
      }
      const index = typeof call.index === 'number' ? call.index : 0
      state.toolCalls = state.toolCalls ?? new Set()
      if (!state.toolCalls.has(index)) {
        state.toolCalls.add(index)
        out.push({
          kind: 'tool-call-start',
          index,
          id: typeof call.id === 'string' && call.id.length > 0 ? call.id : newId('call_'),
          name: typeof call.function?.name === 'string' ? call.function.name : '',
        })
      }
      const args = call.function?.arguments
      if (typeof args === 'string' && args.length > 0) {
        out.push({ kind: 'tool-call-delta', index, argumentsDelta: args })
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== null) {
      for (const index of state.toolCalls ?? []) {
        out.push({ kind: 'tool-call-end', index })
      }
      out.push({ kind: 'finish', finishReason: FINISH_IN[choice.finish_reason] ?? 'stop' })
    }
  }
  if (isPlainObject(chunk.usage)) {
    out.push({ kind: 'usage', usage: parseUsage(chunk.usage) })
  }
  return out
}

/** The `id`/`created`/`model` triple every chunk of one stream must repeat. */
function chunkBase(state) {
  if (state.id === undefined) {
    state.id = newId('chatcmpl-')
    state.created = Math.floor(Date.now() / 1000)
  }
  // `model` may have been seeded from the request before any frame arrived.
  state.model = state.model ?? ''
  return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model }
}

const frame = (chunk) => ({ data: JSON.stringify(chunk) })

/** Deltas -> chat SSE frames. */
export function renderStreamEvents(deltas, state) {
  const frames = []
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (state.done === true) {
      break
    }
    if (delta.kind === 'start') {
      chunkBase(state)
      if (typeof delta.id === 'string' && delta.id.length > 0) {
        state.id = delta.id
      }
      if (typeof delta.model === 'string' && delta.model.length > 0) {
        state.model = delta.model
      }
      continue
    }
    if (state.roleSent !== true && delta.kind !== 'usage') {
      state.roleSent = true
      frames.push(frame({
        ...chunkBase(state),
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }],
      }))
    }
    switch (delta.kind) {
      case 'text':
        frames.push(frame({
          ...chunkBase(state),
          choices: [{ index: 0, delta: { content: delta.text }, logprobs: null, finish_reason: null }],
        }))
        break
      case 'thinking':
        frames.push(frame({
          ...chunkBase(state),
          choices: [{ index: 0, delta: { reasoning_content: delta.text }, logprobs: null, finish_reason: null }],
        }))
        break
      case 'tool-call-start':
        frames.push(frame({
          ...chunkBase(state),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: delta.index ?? 0,
                    id: delta.id ?? newId('call_'),
                    type: 'function',
                    function: { name: delta.name ?? '', arguments: '' },
                  },
                ],
              },
              logprobs: null,
              finish_reason: null,
            },
          ],
        }))
        break
      case 'tool-call-delta':
        frames.push(frame({
          ...chunkBase(state),
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: delta.index ?? 0, function: { arguments: delta.argumentsDelta ?? '' } }] },
              logprobs: null,
              finish_reason: null,
            },
          ],
        }))
        break
      case 'usage':
        state.usage = mergeUsage(state.usage, delta.usage)
        // After `finish_reason` the client is only still reading for this chunk.
        if (state.finished === true) {
          frames.push(frame({ ...chunkBase(state), choices: [], usage: renderUsage(state.usage) }))
          state.usageSent = true
        }
        break
      case 'finish':
        state.finished = true
        frames.push(frame({
          ...chunkBase(state),
          choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReasonOf(delta.finishReason) }],
        }))
        if (state.usage !== undefined && state.usageSent !== true) {
          frames.push(frame({ ...chunkBase(state), choices: [], usage: renderUsage(state.usage) }))
          state.usageSent = true
        }
        frames.push({ data: SSE_DONE })
        state.done = true
        break
      case 'error':
        frames.push(frame({ error: { message: delta.message ?? 'upstream error', type: 'upstream_error' } }))
        frames.push({ data: SSE_DONE })
        state.done = true
        break
      default:
        break
    }
  }
  return frames
}
