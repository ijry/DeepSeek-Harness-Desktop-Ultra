/**
 * OpenAI Responses — `POST /v1/responses`.
 *
 * What Codex CLI speaks, and the fussiest of the four. Three things about it shape this
 * module:
 *
 * - The conversation is a flat `input` array of *items*, not messages. An assistant turn
 *   with a tool call is two items (`message` + `function_call`), a tool result is a
 *   third (`function_call_output`) keyed by `call_id` — not by the item's own `id`.
 * - The response envelope has ~20 required-but-inert fields (`store`, `truncation`,
 *   `text.format`, `parallel_tool_calls`, …). Strict clients read them, so they are
 *   emitted with fixed values rather than omitted; none of them reflects the request.
 * - The event stream is bracketed, not flat. Every piece of output is
 *   `output_item.added` -> its own `.delta` stream -> `.done` -> `output_item.done`, with
 *   a monotonic `sequence_number` on every frame, a shared `output_index` counter across
 *   reasoning/message/tool items, and a terminal `response.completed` that restates the
 *   whole response. There is no `[DONE]`.
 *
 * Replayed reasoning is deliberately dropped when rendering a request: a Responses
 * reasoning item is an opaque object the model itself issued, and a synthesized one is
 * rejected.
 *
 * @module dsh-plugin-ai-switch/host/bridge/responses
 */
import { ApiError } from '../../shared/protocol.js'
import {
  argumentsToString,
  collectText,
  countOf,
  emptyRequest,
  emptyResponse,
  emptyUsage,
  finishReasonOf,
  imagePart,
  isEmptyMessage,
  isPlainObject,
  newId,
  numberOrNull,
  parseDataUrl,
  positiveIntOrNull,
  reasoningEffortOf,
  textPart,
  thinkingPart,
  toDataUrl,
  toolCall,
  totalTokens,
} from './canon.js'

export const protocol = 'responses'

/** The builtin tool types that only exist server-side; they cannot cross to another protocol. */
const BUILTIN_TOOLS = new Set([
  'web_search',
  'web_search_preview',
  'file_search',
  'computer_use_preview',
  'code_interpreter',
  'image_generation',
  'local_shell',
  'shell',
  'apply_patch',
  'mcp',
])

/** Item types that are server-side calls with no canonical equivalent. */
const IGNORED_ITEMS = new Set([
  'web_search_call',
  'file_search_call',
  'computer_call',
  'computer_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'image_generation_call',
])

/** Ids inside a Responses envelope may only contain these characters. */
const sanitizeId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

// ---------------------------------------------------------------------- request

/** Wire body -> CanonRequest. */
export function parseRequest(body, _context) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_request', 'responses request body must be a JSON object')
  }
  const canon = emptyRequest()
  canon.model = typeof body.model === 'string' ? body.model : ''
  canon.stream = body.stream === true
  canon.system = flattenText(body.instructions)
  canon.maxOutputTokens = positiveIntOrNull(body.max_output_tokens)
  canon.temperature = numberOrNull(body.temperature)
  canon.topP = numberOrNull(body.top_p)
  canon.reasoningEffort = reasoningEffortOf(body.reasoning?.effort)
  canon.tools = parseTools(body.tools)
  canon.toolChoice = parseToolChoice(body.tool_choice)
  if (typeof body.parallel_tool_calls === 'boolean') {
    canon.metadata.parallelToolCalls = body.parallel_tool_calls
  }
  if (typeof body.user === 'string' && body.user.length > 0) {
    canon.metadata.user = body.user
  }
  if (typeof body.previous_response_id === 'string') {
    canon.metadata.previousResponseId = body.previous_response_id
  }
  if (typeof body.store === 'boolean') {
    canon.metadata.store = body.store
  }
  if (isPlainObject(body.reasoning) && typeof body.reasoning.summary === 'string') {
    canon.metadata.reasoningSummary = body.reasoning.summary
  }
  const format = body.text?.format
  if (isPlainObject(format) && typeof format.type === 'string' && format.type !== 'text') {
    canon.metadata.responseFormat =
      format.type === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: format.name ?? 'response', schema: format.schema ?? {} } }
        : { type: format.type }
  }
  canon.messages = parseInput(body.input)
  // Codex sends its base instructions plus a separate developer block, and strict chat
  // gateways behave better with one system message at the front, so any system-ish item
  // inside `input` is collapsed onto `instructions` rather than left mid-conversation.
  const hoisted = [canon.system]
  canon.messages = canon.messages.filter((message) => {
    if (message.role !== 'system') {
      return true
    }
    hoisted.push(collectText(message.content))
    return false
  })
  canon.system = hoisted.filter((text) => text.length > 0).join('\n\n')
  return canon
}

/** `instructions` and text-ish fields: a string, or an array of `{text}` parts. */
function flattenText(value) {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  const texts = []
  for (const part of value) {
    if (typeof part === 'string') {
      texts.push(part)
    } else if (isPlainObject(part) && typeof part.text === 'string') {
      texts.push(part.text)
    }
  }
  return texts.filter((text) => text.length > 0).join('\n')
}

/**
 * `input` -> canonical messages.
 *
 * Tool calls are buffered rather than emitted immediately: a Responses turn puts the
 * assistant text and each `function_call` in separate items, and the canonical form wants
 * them on one message. Buffered reasoning attaches to whichever assistant message the
 * buffer is flushed onto, which is where the model actually produced it.
 */
function parseInput(input) {
  if (typeof input === 'string') {
    return input.length > 0 ? [{ role: 'user', content: [textPart(input)], toolCalls: [] }] : []
  }
  const items = Array.isArray(input) ? input : isPlainObject(input) ? [input] : []
  const messages = []
  let pendingCalls = []
  let pendingReasoning = ''

  /** Emit the buffered assistant tool-call turn, if any. */
  const flush = () => {
    if (pendingCalls.length === 0) {
      pendingReasoning = ''
      return
    }
    const content = pendingReasoning.length > 0 ? [thinkingPart(pendingReasoning)] : []
    messages.push({ role: 'assistant', content, toolCalls: pendingCalls })
    pendingCalls = []
    pendingReasoning = ''
  }

  for (const item of items) {
    if (!isPlainObject(item)) {
      continue
    }
    const type = typeof item.type === 'string' ? item.type : (item.role !== undefined || item.content !== undefined ? 'message' : '')
    if (type === 'function_call') {
      const callId = item.call_id ?? item.id
      if (typeof callId !== 'string' || callId.length === 0) {
        throw new ApiError('bridge.invalid_request', 'responses function_call is missing call_id', {
          details: 'call_id',
        })
      }
      pendingCalls.push(toolCall(callId, item.name, argumentsToString(item.arguments ?? '{}')))
      const reasoning = reasoningTextOf(item)
      if (reasoning.length > 0 && !pendingReasoning.includes(reasoning)) {
        pendingReasoning = pendingReasoning.length > 0 ? `${pendingReasoning}\n\n${reasoning}` : reasoning
      }
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flush()
      const callId = item.call_id ?? item.id
      if (typeof callId !== 'string' || callId.length === 0) {
        throw new ApiError('bridge.invalid_request', 'responses function_call_output is missing call_id', {
          details: 'call_id',
        })
      }
      const output = item.output ?? item.result
      messages.push({
        role: 'tool',
        content: [textPart(typeof output === 'string' ? output : argumentsToString(output ?? ''))],
        toolCallId: callId,
      })
      continue
    }
    if (type === 'reasoning') {
      // Not a message: it belongs to the assistant turn that follows it.
      const reasoning = reasoningTextOf(item)
      if (reasoning.length > 0) {
        pendingReasoning = pendingReasoning.length > 0 ? `${pendingReasoning}\n\n${reasoning}` : reasoning
      }
      continue
    }
    if (type === 'custom_tool_call') {
      pendingCalls.push(
        toolCall(item.call_id ?? item.id, item.name, argumentsToString({ input: item.input ?? '' })),
      )
      continue
    }
    if (IGNORED_ITEMS.has(type)) {
      flush()
      continue
    }
    if (type === 'message' || type === 'input_text' || type === 'input_image' || type === 'output_text') {
      flush()
      const role = canonRole(item.role)
      // A bare content part hoisted to item level is its own single-part message.
      const content = type === 'message' ? parseContent(item.content) : parseContent([item])
      const built = { role, content, toolCalls: [] }
      if (!isEmptyMessage(built)) {
        messages.push(built)
      }
      continue
    }
    if (type.length === 0) {
      throw new ApiError('bridge.invalid_request', 'responses input item is missing role or type', {
        details: 'input',
      })
    }
    // Unknown item types are skipped: a degraded turn beats refusing the request.
    flush()
  }
  flush()
  return messages
}

function canonRole(role) {
  if (role === 'assistant') {
    return 'assistant'
  }
  if (role === 'system' || role === 'developer') {
    return 'system'
  }
  return 'user'
}

/** A reasoning item's text: the explicit fields first, then the summary parts. */
function reasoningTextOf(item) {
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof item?.[key] === 'string' && item[key].trim().length > 0) {
      return item[key]
    }
  }
  const summary = Array.isArray(item?.summary) ? item.summary : []
  const texts = []
  for (const part of summary) {
    if (isPlainObject(part) && typeof part.text === 'string') {
      texts.push(part.text)
    }
  }
  if (texts.length > 0) {
    return texts.join('')
  }
  return typeof item?.content === 'string' ? item.content : ''
}

/** Responses content parts -> canonical parts. */
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
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string' && part.text.length > 0) {
        parts.push(textPart(part.text))
      }
      continue
    }
    if (part.type === 'refusal' && typeof part.refusal === 'string') {
      parts.push(textPart(part.refusal))
      continue
    }
    if (part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      const parsed = parseDataUrl(url)
      if (parsed !== null) {
        parts.push(imagePart(parsed.mediaType, parsed.data))
      }
    }
  }
  return parts
}

/** Responses' flat tool shape, with the `namespace` wrapper flattened away. */
function parseTools(tools, prefix = '') {
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(tool)) {
      continue
    }
    const type = typeof tool.type === 'string' ? tool.type : 'function'
    if (type === 'namespace') {
      const name = String(tool.name ?? tool.namespace ?? '').replace(/_+$/, '')
      out.push(...parseTools(tool.tools, name.length > 0 ? `${name}__` : ''))
      continue
    }
    if (BUILTIN_TOOLS.has(type)) {
      continue
    }
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name.length === 0) {
      continue
    }
    const parameters = isPlainObject(tool.parameters)
      ? tool.parameters
      : isPlainObject(tool.inputSchema)
        ? tool.inputSchema
        : type === 'custom'
          ? {
              type: 'object',
              properties: {
                input: { type: 'string', description: 'Raw string input for the original Responses custom tool.' },
              },
              required: ['input'],
            }
          : { type: 'object', properties: {} }
    out.push({
      name: `${prefix}${name}`,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters,
    })
  }
  return out
}

function parseToolChoice(value) {
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none') {
      return value
    }
    return value === 'required' || value === 'any' ? 'required' : null
  }
  if (isPlainObject(value)) {
    if (typeof value.name === 'string' && value.name.length > 0) {
      return { name: value.name }
    }
    // A builtin tool choice cannot be honoured elsewhere; ask for a tool, any tool.
    return typeof value.type === 'string' ? 'auto' : null
  }
  return null
}

/** CanonRequest -> `{path, body}`. */
export function renderRequest(canon, context = {}) {
  const body = {
    model: typeof context.model === 'string' && context.model.length > 0 ? context.model : canon.model,
    input: renderInput(canon.messages),
  }
  if (canon.system.length > 0) {
    body.instructions = canon.system
  }
  if (context.isStream !== undefined ? context.isStream === true : canon.stream === true) {
    body.stream = true
  }
  if (canon.maxOutputTokens !== null) {
    body.max_output_tokens = canon.maxOutputTokens
  }
  if (canon.temperature !== null) {
    body.temperature = canon.temperature
  }
  if (canon.topP !== null) {
    body.top_p = canon.topP
  }
  if (canon.reasoningEffort !== null) {
    body.reasoning = { effort: canon.reasoningEffort }
    if (typeof canon.metadata.reasoningSummary === 'string') {
      body.reasoning.summary = canon.metadata.reasoningSummary
    }
  }
  if (typeof canon.metadata.parallelToolCalls === 'boolean') {
    body.parallel_tool_calls = canon.metadata.parallelToolCalls
  }
  if (typeof canon.metadata.store === 'boolean') {
    body.store = canon.metadata.store
  }
  if (typeof canon.metadata.previousResponseId === 'string' && canon.metadata.previousResponseId.length > 0) {
    body.previous_response_id = canon.metadata.previousResponseId
  }
  const format = canon.metadata.responseFormat
  if (isPlainObject(format) && typeof format.type === 'string') {
    body.text =
      format.type === 'json_schema'
        ? {
            format: {
              type: 'json_schema',
              name: format.json_schema?.name ?? 'response',
              schema: format.json_schema?.schema ?? {},
            },
          }
        : { format: { type: format.type } }
  }
  if (canon.tools.length > 0) {
    body.tools = canon.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    const choice = renderToolChoice(canon.toolChoice)
    if (choice !== undefined) {
      body.tool_choice = choice
    }
  }
  // `stop`, `n`, `seed` and the penalties are deliberately not forwarded: a strict
  // upstream rejects an unknown body field outright, turning a serviceable request
  // into a 400. Streamed usage needs no opt-in either — it rides on `response.completed`.
  return { path: '/responses', body }
}

function renderToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    return choice
  }
  if (isPlainObject(choice) && typeof choice.name === 'string') {
    return { type: 'function', name: choice.name }
  }
  return undefined
}

/** Canonical messages -> `input` items. */
function renderInput(messages) {
  const items = []
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: collectText(message.content),
      })
      continue
    }
    if (message.role === 'assistant') {
      const text = collectText(message.content)
      if (text.length > 0) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const call of message.toolCalls ?? []) {
        items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
      }
      continue
    }
    const content = []
    for (const part of message.content) {
      if (part.type === 'text' && part.text.length > 0) {
        content.push({ type: 'input_text', text: part.text })
      } else if (part.type === 'image') {
        content.push({ type: 'input_image', image_url: toDataUrl(part) })
      }
    }
    if (content.length === 0) {
      continue
    }
    items.push({ type: 'message', role: message.role === 'system' ? 'system' : 'user', content })
  }
  return items
}

// --------------------------------------------------------------------- response

/** Upstream Responses JSON -> CanonResponse. */
export function parseResponse(body, canon) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_response', 'responses response body must be a JSON object')
  }
  const out = emptyResponse()
  out.raw = body
  out.id = typeof body.id === 'string' ? body.id : ''
  out.model = typeof body.model === 'string' ? body.model : (canon?.model ?? '')
  if (body.status === 'failed' || isPlainObject(body.error)) {
    // A failed turn must not be dressed up as assistant text: credential failover keys
    // on the error, and a clean `stop` would keep a dead upstream in the pool.
    out.text = String(body.error?.message ?? 'responses upstream reported a failed response')
    out.finishReason = 'error'
    out.usage = parseUsage(body.usage)
    return out
  }
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isPlainObject(item)) {
      continue
    }
    if (item.type === 'message') {
      out.text += collectText(parseContent(item.content))
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      // Some relays hoist the text part to the top of `output`.
      out.text += item.text
    } else if (item.type === 'reasoning') {
      out.thinking += reasoningTextOf(item)
    } else if (item.type === 'function_call') {
      out.toolCalls.push(toolCall(item.call_id ?? item.id, item.name, argumentsToString(item.arguments ?? '{}')))
    }
  }
  if (out.text.length === 0 && typeof body.output_text === 'string') {
    // The flattened convenience field is the only content some relays report.
    out.text = body.output_text
  }
  out.finishReason = finishReasonIn(body.status, body.incomplete_details?.reason, out.toolCalls.length > 0)
  out.usage = parseUsage(body.usage)
  return out
}

/**
 * `status` + `incomplete_details.reason` -> canonical.
 *
 * Truncation outranks the tool calls on purpose: arguments cut off at the token cap are
 * not parseable JSON, and a client told `tool_calls` will try to run them anyway.
 */
function finishReasonIn(status, reason, hasToolCalls) {
  if (reason === 'max_output_tokens') {
    return 'length'
  }
  if (reason === 'content_filter') {
    return 'content_filter'
  }
  if (status === 'incomplete') {
    return 'length'
  }
  if (status === 'failed') {
    return 'error'
  }
  return hasToolCalls ? 'tool_calls' : 'stop'
}

/** Responses' usage object -> CanonUsage. */
export function parseUsage(usage) {
  const out = emptyUsage()
  if (!isPlainObject(usage)) {
    return out
  }
  out.inputTokens = countOf(usage.input_tokens)
  out.outputTokens = countOf(usage.output_tokens)
  out.cacheReadTokens = countOf(usage.input_tokens_details?.cached_tokens)
  out.reasoningTokens = countOf(usage.output_tokens_details?.reasoning_tokens)
  return out
}

/**
 * CanonUsage -> Responses' usage object.
 *
 * The details objects are always present: the proxy reads token usage off the translated
 * body rather than the upstream one, so a missing counter reads as a lost count.
 */
export function renderUsage(usage) {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: totalTokens(usage),
  }
}

/** Canonical -> the `status` / `incomplete_details` pair. */
function statusOf(reason) {
  if (reason === 'length') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
  }
  if (reason === 'content_filter') {
    return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
  }
  if (reason === 'error') {
    return { status: 'failed', incomplete_details: null }
  }
  return { status: 'completed', incomplete_details: null }
}

/**
 * The response envelope, including the inert fields strict clients still read.
 *
 * None of `store`, `truncation`, `text`, `tool_choice`, `tools` or `parallel_tool_calls`
 * here reflects the request: they are padding, and the reference emits them for the same
 * reason — Codex reads the envelope before it reads the output.
 */
function responseEnvelope({ id, model, status, output, usage, incompleteDetails, error }) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: error ?? null,
    incomplete_details: incompleteDetails ?? null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: usage === null ? null : renderUsage(usage),
    metadata: {},
  }
}

/** A message output item. */
function messageItem(itemId, status, text) {
  return {
    id: itemId,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  }
}

/** A function_call output item. */
function functionCallItem(itemId, status, call) {
  return {
    id: itemId,
    type: 'function_call',
    status,
    call_id: call.callId ?? call.id,
    name: call.name,
    arguments: call.arguments,
  }
}

/** A reasoning output item. `summary` is the only channel a bridge can fill. */
function reasoningItem(itemId, text) {
  return {
    id: itemId,
    type: 'reasoning',
    summary: text.length > 0 ? [{ type: 'summary_text', text }] : [],
  }
}

/** CanonResponse -> a `response` body. */
export function renderResponse(response, canon) {
  const id = response.id.length > 0 ? response.id : newId('resp_')
  const seed = sanitizeId(id)
  const output = []
  if (response.thinking.length > 0) {
    output.push(reasoningItem(`rs_${seed}`, response.thinking))
  }
  if (response.text.length > 0 || response.toolCalls.length === 0) {
    output.push(messageItem(`msg_${seed}`, 'completed', response.text))
  }
  response.toolCalls.forEach((call, index) => {
    output.push(functionCallItem(`fc_${seed}_${index}`, 'completed', { callId: call.id, name: call.name, arguments: call.arguments }))
  })
  const { status, incomplete_details: incompleteDetails } = statusOf(response.finishReason)
  const body = responseEnvelope({
    id,
    model: response.model.length > 0 ? response.model : (canon?.model ?? ''),
    status,
    output,
    usage: response.usage,
    incompleteDetails,
    error:
      response.finishReason === 'error'
        ? { code: 'upstream_error', message: response.text.length > 0 ? response.text : 'upstream error' }
        : null,
  })
  // The flattened convenience field; several clients read only this.
  body.output_text = response.text
  return body
}

// ----------------------------------------------------------------------- stream

/**
 * One Responses SSE frame -> deltas.
 *
 * `response.created` carries `usage: null`, which must not clear counts a later event
 * reported, so usage is only latched when it is an object. Tool calls are renumbered:
 * Responses' `output_index` counts reasoning and message items too, while a chat client
 * keys its accumulator on a contiguous tool-only index and never fills a gap.
 */
export function parseStreamEvent(event, state) {
  const data = typeof event?.data === 'string' ? event.data.trim() : ''
  if (data.length === 0 || data === '[DONE]') {
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
  const type = typeof payload.type === 'string' ? payload.type : (event?.event ?? '')
  const out = []
  state.tools = state.tools ?? new Map()

  if (isPlainObject(payload.response)) {
    const response = payload.response
    if (typeof response.id === 'string' && response.id.length > 0) {
      state.id = response.id
    }
    if (typeof response.model === 'string' && response.model.length > 0) {
      state.model = response.model
    }
    if (typeof response.status === 'string') {
      state.status = response.status
    }
    if (typeof response.incomplete_details?.reason === 'string') {
      state.incompleteReason = response.incomplete_details.reason
    }
    if (isPlainObject(response.usage)) {
      state.usage = parseUsage(response.usage)
    }
  }
  if (state.started !== true) {
    state.started = true
    out.push({ kind: 'start', id: state.id ?? '', model: state.model ?? '' })
  }

  /** Open (or find) the chat-side index for one Responses output item. */
  const toolEntry = (outputIndex, itemId, callId, name) => {
    const key = countOf(outputIndex)
    let entry = state.tools.get(key)
    if (entry === undefined) {
      entry = { index: state.tools.size, streamed: '' }
      state.tools.set(key, entry)
      out.push({
        kind: 'tool-call-start',
        index: entry.index,
        // A relay that streams arguments without ever announcing the item leaves only
        // `item_id` to identify the call, and a call with no id is unanswerable.
        id: callId ?? itemId ?? newId('call_'),
        name: name ?? '',
      })
    }
    return entry
  }

  /** Feed arguments, prefix-stripping when the source restates the whole string. */
  const feed = (entry, text, cumulative) => {
    if (typeof text !== 'string' || text.length === 0) {
      return
    }
    let fragment = text
    if (cumulative) {
      if (!text.startsWith(entry.streamed)) {
        // The relay re-chunked what it already sent; forwarding again would double it.
        return
      }
      fragment = text.slice(entry.streamed.length)
    }
    if (fragment.length === 0) {
      return
    }
    entry.streamed += fragment
    out.push({ kind: 'tool-call-delta', index: entry.index, argumentsDelta: fragment })
  }

  switch (type) {
    case 'response.output_text.delta':
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        out.push({ kind: 'text', text: payload.delta })
      }
      break
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        out.push({ kind: 'thinking', text: payload.delta })
      }
      break
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = isPlainObject(payload.item) ? payload.item : {}
      if (item.type === 'function_call') {
        const entry = toolEntry(payload.output_index, item.id, item.call_id, item.name)
        if (typeof item.arguments === 'string') {
          feed(entry, item.arguments, true)
        }
        if (type === 'response.output_item.done') {
          out.push({ kind: 'tool-call-end', index: entry.index })
        }
      }
      break
    }
    case 'response.function_call_arguments.delta': {
      const entry = toolEntry(payload.output_index, payload.item_id, undefined, undefined)
      feed(entry, payload.delta, false)
      break
    }
    case 'response.function_call_arguments.done': {
      const entry = toolEntry(payload.output_index, payload.item_id, undefined, undefined)
      feed(entry, payload.arguments, true)
      break
    }
    case 'response.failed':
    case 'error':
      out.push({
        kind: 'error',
        message: String(payload.response?.error?.message ?? payload.error?.message ?? 'upstream error'),
      })
      state.finished = true
      state.terminal = true
      break
    case 'response.completed':
    case 'response.incomplete':
      if (state.usage !== undefined) {
        out.push({ kind: 'usage', usage: state.usage })
      }
      out.push({
        kind: 'finish',
        finishReason: finishReasonIn(
          state.status ?? (type === 'response.incomplete' ? 'incomplete' : 'completed'),
          state.incompleteReason,
          state.tools.size > 0,
        ),
      })
      state.finished = true
      state.terminal = true
      break
    default:
      // response.in_progress, response.content_part.*, response.output_text.done and the
      // reasoning bracket events add nothing a delta stream needs.
      break
  }
  if (isPlainObject(payload.error) && type !== 'error' && type !== 'response.failed') {
    // A bare error frame with no event type.
    out.push({ kind: 'error', message: String(payload.error.message ?? 'upstream error') })
    state.finished = true
  }
  return out
}

/**
 * Deltas -> Responses SSE frames.
 *
 * Every frame is `event: <type>` + a payload whose `type` repeats it and whose
 * `sequence_number` is a single monotonic counter. `output_index` is one counter shared
 * by the reasoning, message and tool items in first-appearance order — the same numbering
 * `parseStreamEvent` above has to undo.
 */
export function renderStreamEvents(deltas, state) {
  const frames = []
  const push = (name, payload) => {
    state.seq = state.seq ?? 0
    frames.push({ event: name, data: JSON.stringify({ type: name, sequence_number: state.seq, ...payload }) })
    state.seq += 1
  }
  const ids = () => {
    if (state.responseId === undefined) {
      state.responseId = state.id ?? newId('resp_')
      state.seed = sanitizeId(state.responseId)
    }
    return state.seed
  }
  const envelope = (status, output, usage, incompleteDetails, error) =>
    responseEnvelope({
      id: state.responseId ?? newId('resp_'),
      model: state.model ?? '',
      status,
      output,
      usage: usage ?? null,
      incompleteDetails,
      error,
    })
  const begin = () => {
    if (state.createdSent === true) {
      return
    }
    state.createdSent = true
    ids()
    state.outputIndex = 0
    state.tools = new Map()
    push('response.created', { response: envelope('in_progress', [], null, null, null) })
    push('response.in_progress', { response: envelope('in_progress', [], null, null, null) })
  }

  /** Open the reasoning item and its summary part on first use. */
  const openReasoning = () => {
    if (state.reasoning !== undefined) {
      return state.reasoning
    }
    const item = { index: state.outputIndex, itemId: `rs_${ids()}`, text: '' }
    state.outputIndex += 1
    state.reasoning = item
    push('response.output_item.added', { output_index: item.index, item: reasoningItem(item.itemId, '') })
    push('response.reasoning_summary_part.added', {
      item_id: item.itemId,
      output_index: item.index,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    })
    return item
  }

  /** Open the message item and its content part on first use. */
  const openMessage = () => {
    if (state.message !== undefined) {
      return state.message
    }
    const item = { index: state.outputIndex, itemId: `msg_${ids()}`, text: '' }
    state.outputIndex += 1
    state.message = item
    push('response.output_item.added', { output_index: item.index, item: messageItem(item.itemId, 'in_progress', '') })
    push('response.content_part.added', {
      item_id: item.itemId,
      output_index: item.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    })
    return item
  }

  const closeReasoning = () => {
    const item = state.reasoning
    if (item === undefined || item.closed === true) {
      return
    }
    item.closed = true
    push('response.reasoning_summary_text.done', {
      item_id: item.itemId,
      output_index: item.index,
      summary_index: 0,
      text: item.text,
    })
    push('response.reasoning_summary_part.done', {
      item_id: item.itemId,
      output_index: item.index,
      summary_index: 0,
      part: { type: 'summary_text', text: item.text },
    })
    push('response.output_item.done', { output_index: item.index, item: reasoningItem(item.itemId, item.text) })
  }

  const closeMessage = () => {
    const item = state.message
    if (item === undefined || item.closed === true) {
      return
    }
    item.closed = true
    push('response.output_text.done', {
      item_id: item.itemId,
      output_index: item.index,
      content_index: 0,
      text: item.text,
      logprobs: [],
    })
    push('response.content_part.done', {
      item_id: item.itemId,
      output_index: item.index,
      content_index: 0,
      part: { type: 'output_text', text: item.text, annotations: [], logprobs: [] },
    })
    push('response.output_item.done', { output_index: item.index, item: messageItem(item.itemId, 'completed', item.text) })
  }

  const closeTool = (entry) => {
    if (entry === undefined || entry.closed === true) {
      return
    }
    entry.closed = true
    push('response.function_call_arguments.done', {
      item_id: entry.itemId,
      output_index: entry.index,
      arguments: entry.arguments,
    })
    push('response.output_item.done', { output_index: entry.index, item: functionCallItem(entry.itemId, 'completed', entry) })
  }

  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (state.terminated === true) {
      break
    }
    switch (delta.kind) {
      case 'start':
        if (typeof delta.id === 'string' && delta.id.length > 0) {
          state.id = delta.id
        }
        if (typeof delta.model === 'string' && delta.model.length > 0) {
          state.model = delta.model
        }
        break
      case 'thinking': {
        begin()
        const item = openReasoning()
        item.text += delta.text
        push('response.reasoning_summary_text.delta', {
          item_id: item.itemId,
          output_index: item.index,
          summary_index: 0,
          delta: delta.text,
        })
        break
      }
      case 'text': {
        begin()
        closeReasoning()
        const item = openMessage()
        item.text += delta.text
        push('response.output_text.delta', {
          item_id: item.itemId,
          output_index: item.index,
          content_index: 0,
          delta: delta.text,
          logprobs: [],
        })
        break
      }
      case 'tool-call-start': {
        begin()
        closeReasoning()
        closeMessage()
        const entry = {
          index: state.outputIndex,
          itemId: `fc_${ids()}_${delta.index ?? 0}`,
          callId: delta.id ?? newId('call_'),
          name: delta.name ?? '',
          arguments: '',
        }
        state.outputIndex += 1
        state.tools.set(delta.index ?? 0, entry)
        push('response.output_item.added', {
          output_index: entry.index,
          item: functionCallItem(entry.itemId, 'in_progress', entry),
        })
        break
      }
      case 'tool-call-delta': {
        const entry = state.tools?.get(delta.index ?? 0)
        if (entry !== undefined && String(delta.argumentsDelta ?? '').length > 0) {
          entry.arguments += delta.argumentsDelta
          push('response.function_call_arguments.delta', {
            item_id: entry.itemId,
            output_index: entry.index,
            delta: delta.argumentsDelta,
          })
        }
        break
      }
      case 'tool-call-end':
        closeTool(state.tools?.get(delta.index ?? 0))
        break
      case 'usage':
        state.usage = delta.usage
        break
      case 'finish': {
        begin()
        closeReasoning()
        closeMessage()
        for (const [, entry] of state.tools ?? []) {
          closeTool(entry)
        }
        const output = []
        if (state.reasoning !== undefined) {
          output.push(reasoningItem(state.reasoning.itemId, state.reasoning.text))
        }
        if (state.message !== undefined) {
          output.push(messageItem(state.message.itemId, 'completed', state.message.text))
        }
        for (const [, entry] of state.tools ?? []) {
          output.push(functionCallItem(entry.itemId, 'completed', entry))
        }
        if (output.length === 0) {
          output.push(messageItem(`msg_${ids()}`, 'completed', ''))
        }
        const { status, incomplete_details: incompleteDetails } = statusOf(finishReasonOf(delta.finishReason))
        const name = status === 'incomplete' ? 'response.incomplete' : status === 'failed' ? 'response.failed' : 'response.completed'
        push(name, { response: envelope(status, output, state.usage ?? emptyUsage(), incompleteDetails, null) })
        state.terminated = true
        break
      }
      case 'error':
        begin()
        push('response.failed', {
          response: envelope('failed', [], null, null, {
            code: 'upstream_error',
            message: delta.message ?? 'upstream error',
          }),
        })
        state.terminated = true
        break
      default:
        break
    }
  }
  return frames
}
