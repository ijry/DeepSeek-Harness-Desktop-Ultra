/**
 * Gemini native — `POST /v1beta/models/<model>:generateContent` / `:streamGenerateContent`.
 *
 * The odd one out, and the reason `context` exists in the module interface: Gemini puts
 * the model id and the streaming flag in the *URL*, not the body. `generateContent`
 * rejects a body containing `model` or `stream`, so a request cannot be round-tripped
 * without the path travelling alongside it.
 *
 * The mappings that are not guessable, all of them lifted from the reference's
 * `chat_gemini.rs`:
 *
 * - Keys are camelCase (`systemInstruction`, not `system_instruction`), `tools` is a
 *   one-element array wrapping `functionDeclarations`, and `toolConfig` must never travel
 *   without declarations — a forced mode with nothing to call is a 400.
 * - A `Content` whose `parts` is empty is rejected, so a message that converts to nothing
 *   is dropped rather than sent.
 * - `functionCall.args` is a protobuf Struct: a JSON *string* there is a 400. Unparseable
 *   arguments become `{}`, because a rejected request strands the client with nothing.
 * - There are no tool-call ids. Correlation is by function name, so ids are synthesised
 *   on the way in (`call_<name>_<index>`) and dropped on the way out.
 * - `:streamGenerateContent?alt=sse` emits bare `data:` frames with no event names and no
 *   `[DONE]`, and each frame's text may be either an increment *or* a cumulative
 *   snapshot, which is why the reader prefix-strips what it has already forwarded.
 * - `parameters` is a restricted OpenAPI-flavoured schema that 400s on any keyword it does
 *   not know. Anything richer is routed to `parametersJsonSchema` intact rather than
 *   stripped, because guessing wrong loses the tool.
 *
 * @module dsh-plugin-ai-switch/host/bridge/gemini
 */
import { ApiError } from '../../shared/protocol.js'
import {
  argumentsToObject,
  argumentsToString,
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
  numberOrNull,
  positiveIntOrNull,
  textPart,
  thinkingPart,
  totalTokens,
} from './canon.js'

export const protocol = 'gemini'

/** The `finishReason` values that mean the safety stack stopped the turn. */
const BLOCKED_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'SPII',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
])

/** Keywords the restricted `parameters` schema accepts. Anything else escalates. */
const SCHEMA_KEEP = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'propertyOrdering',
  'default',
  'minimum',
  'maximum',
])

/** Keys that are pure JSON-Schema bookkeeping and are stripped everywhere. */
const SCHEMA_DROP = new Set(['$schema', '$id', '$comment'])

/** `/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse` -> the model id. */
export function modelFromPath(path) {
  const text = typeof path === 'string' ? path : ''
  const match = /models\/([^:?/]+)(?::([A-Za-z]+))?/.exec(text)
  return match === null ? '' : decodeURIComponent(match[1])
}

/** True when the path asks for the streaming method. */
export function isStreamPath(path) {
  return typeof path === 'string' && path.includes(':streamGenerateContent')
}

/** Guard against `/v1beta/models/models/x`: clients send the prefix, some send a slash. */
function normalizeModelId(model) {
  let text = String(model ?? '').trim()
  while (text.startsWith('/')) {
    text = text.slice(1)
  }
  return text.startsWith('models/') ? text.slice(7) : text
}

// ---------------------------------------------------------------------- request

/**
 * Wire body + path -> CanonRequest.
 *
 * @param context - `{path, model, isStream}`; the model and stream flag live in the path.
 */
export function parseRequest(body, context = {}) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_request', 'gemini request body must be a JSON object')
  }
  const canon = emptyRequest()
  canon.model = normalizeModelId(context.model || modelFromPath(context.path) || body.model || '')
  canon.stream = context.isStream === undefined ? isStreamPath(context.path) : context.isStream === true

  const instruction = body.systemInstruction ?? body.system_instruction
  if (isPlainObject(instruction)) {
    canon.system = collectText(parsePartList(instruction.parts).parts)
  } else if (typeof instruction === 'string') {
    canon.system = instruction
  }

  const config = isPlainObject(body.generationConfig) ? body.generationConfig : {}
  canon.maxOutputTokens = positiveIntOrNull(config.maxOutputTokens)
  canon.temperature = numberOrNull(config.temperature)
  canon.topP = numberOrNull(config.topP)
  canon.stopSequences = Array.isArray(config.stopSequences)
    ? config.stopSequences.filter((item) => typeof item === 'string')
    : []
  if (numberOrNull(config.topK) !== null) {
    canon.metadata.topK = config.topK
  }
  const thinking = isPlainObject(config.thinkingConfig) ? config.thinkingConfig : {}
  if (numberOrNull(thinking.thinkingBudget) !== null) {
    canon.metadata.thinkingBudget = thinking.thinkingBudget
    canon.reasoningEffort = budgetToEffort(thinking.thinkingBudget)
  } else if (typeof thinking.thinkingLevel === 'string') {
    canon.reasoningEffort = thinking.thinkingLevel === 'high' ? 'high' : 'low'
  }
  if (typeof config.responseMimeType === 'string' && config.responseMimeType.includes('json')) {
    canon.metadata.responseFormat = isPlainObject(config.responseSchema)
      ? { type: 'json_schema', json_schema: { name: 'response', schema: config.responseSchema } }
      : { type: 'json_object' }
  }
  if (Array.isArray(body.safetySettings)) {
    canon.metadata.safetySettings = body.safetySettings
  }

  // Gemini correlates tool results by function name, so ids have to be invented and
  // remembered here or the Chat/Anthropic side cannot pair a result with its call.
  const idByName = new Map()
  let callIndex = 0
  for (const content of Array.isArray(body.contents) ? body.contents : []) {
    if (!isPlainObject(content)) {
      continue
    }
    const { parts, calls, responses } = parsePartList(content.parts)
    const role = content.role === 'model' ? 'assistant' : 'user'
    for (const call of calls) {
      const id = `call_${call.name}_${callIndex}`
      callIndex += 1
      idByName.set(call.name, id)
      call.id = id
    }
    if (responses.length > 0) {
      // A functionResponse rides in a `user` content but is a tool turn everywhere else.
      for (const item of responses) {
        canon.messages.push({
          role: 'tool',
          content: [textPart(item.text)],
          toolCallId: idByName.get(item.name) ?? `call_${item.name}_0`,
        })
      }
    }
    const message = { role, content: parts, toolCalls: calls }
    if (!isEmptyMessage(message)) {
      canon.messages.push(message)
    }
  }

  const declarations = []
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isPlainObject(tool)) {
      continue
    }
    for (const fn of Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : []) {
      if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name.length === 0) {
        continue
      }
      const schema = isPlainObject(fn.parametersJsonSchema) ? fn.parametersJsonSchema : fn.parameters
      declarations.push({
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: isPlainObject(schema) ? schema : { type: 'object', properties: {} },
      })
    }
  }
  canon.tools = declarations
  canon.toolChoice = parseToolChoice(body.toolConfig)
  return canon
}

/** Split one `parts` array into content parts, function calls and function responses. */
function parsePartList(parts) {
  const out = { parts: [], calls: [], responses: [] }
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!isPlainObject(part)) {
      continue
    }
    if (isPlainObject(part.functionCall)) {
      out.calls.push({
        id: '',
        name: String(part.functionCall.name ?? ''),
        arguments: argumentsToString(part.functionCall.args ?? {}),
      })
      continue
    }
    if (isPlainObject(part.functionResponse)) {
      const response = part.functionResponse.response
      const text = typeof response?.output === 'string' ? response.output : argumentsToString(response ?? {})
      out.responses.push({ name: String(part.functionResponse.name ?? ''), text })
      continue
    }
    const inline = part.inlineData ?? part.inline_data
    if (isPlainObject(inline)) {
      out.parts.push(imagePart(inline.mimeType ?? inline.mime_type, inline.data))
      continue
    }
    if (typeof part.text === 'string') {
      // `thought: true` marks the model's private reasoning, never user-visible content.
      out.parts.push(part.thought === true ? thinkingPart(part.text) : textPart(part.text))
    }
  }
  return out
}

function parseToolChoice(toolConfig) {
  const config = isPlainObject(toolConfig?.functionCallingConfig) ? toolConfig.functionCallingConfig : null
  if (config === null) {
    return null
  }
  const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames : []
  switch (config.mode) {
    case 'AUTO':
      return 'auto'
    case 'NONE':
      return 'none'
    case 'ANY':
      // Gemini has no single-tool mode: one allowed name is how it is spelled.
      return allowed.length === 1 ? { name: String(allowed[0]) } : 'required'
    default:
      return null
  }
}

/** CanonRequest -> `{path, body}`. */
export function renderRequest(canon, context = {}) {
  const model = normalizeModelId(
    typeof context.model === 'string' && context.model.length > 0 ? context.model : canon.model,
  )
  if (model.length === 0) {
    throw new ApiError('bridge.invalid_request', 'gemini requests need a model in the URL', { details: 'model' })
  }
  const stream = context.isStream === undefined ? canon.stream === true : context.isStream === true
  const method = stream ? 'streamGenerateContent' : 'generateContent'
  const body = {}

  if (canon.system.length > 0) {
    body.systemInstruction = { parts: [{ text: canon.system }] }
  }
  body.contents = renderContents(canon.messages)

  const config = {}
  if (canon.maxOutputTokens !== null) {
    config.maxOutputTokens = canon.maxOutputTokens
  }
  if (canon.temperature !== null) {
    config.temperature = canon.temperature
  }
  if (canon.topP !== null) {
    config.topP = canon.topP
  }
  if (canon.stopSequences.length > 0) {
    config.stopSequences = canon.stopSequences
  }
  if (numberOrNull(canon.metadata.topK) !== null) {
    config.topK = canon.metadata.topK
  }
  const budget = positiveIntOrNull(canon.metadata.thinkingBudget) ?? effortToBudget(canon.reasoningEffort)
  if (budget !== null) {
    // gemini-3 renamed the knob to a coarse level; older models still take a budget.
    config.thinkingConfig = model.startsWith('gemini-3')
      ? { thinkingLevel: canon.reasoningEffort === 'high' ? 'high' : 'low' }
      : { thinkingBudget: budget, includeThoughts: true }
  }
  const format = canon.metadata.responseFormat
  if (isPlainObject(format) && typeof format.type === 'string' && format.type.startsWith('json')) {
    config.responseMimeType = 'application/json'
    const schema = format.json_schema?.schema
    if (isPlainObject(schema)) {
      config.responseSchema = normalizeSchema(schema)
    }
  }
  if (Object.keys(config).length > 0) {
    body.generationConfig = config
  }
  if (Array.isArray(canon.metadata.safetySettings)) {
    body.safetySettings = canon.metadata.safetySettings
  }

  if (canon.tools.length > 0) {
    body.tools = [{ functionDeclarations: canon.tools.map(renderFunctionDeclaration) }]
    // `toolConfig` never travels without declarations: a forced mode with nothing to
    // call is a 400 on Gemini's side.
    const calling = renderToolChoice(canon.toolChoice)
    if (calling !== null) {
      body.toolConfig = { functionCallingConfig: calling }
    }
  }
  return { path: `/models/${model}:${method}${stream ? '?alt=sse' : ''}`, body }
}

/** Canonical messages -> `contents`. Tool turns fold into a `user` functionResponse. */
function renderContents(messages) {
  const contents = []
  const nameById = new Map()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      nameById.set(call.id, call.name)
    }
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      const name = nameById.get(message.toolCallId ?? '') ?? message.toolCallId ?? 'tool'
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { output: collectText(message.content) } } }],
      })
      continue
    }
    const parts = []
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text.length > 0) {
          parts.push({ text: part.text })
        }
      } else if (part.type === 'image') {
        parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } })
      }
      // Thinking is never replayed: the signature Gemini needs cannot be reconstructed.
    }
    for (const call of message.toolCalls ?? []) {
      // The id is deliberately not forwarded — a functionCall.id with no matching id on
      // the result leaves the pair uncorrelated.
      parts.push({ functionCall: { name: call.name, args: argumentsToObject(call.arguments) } })
    }
    if (parts.length === 0) {
      // Gemini rejects a Content whose `parts` array is empty.
      continue
    }
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  return contents
}

function renderToolChoice(choice) {
  if (choice === 'auto') {
    return { mode: 'AUTO' }
  }
  if (choice === 'none') {
    return { mode: 'NONE' }
  }
  if (choice === 'required') {
    return { mode: 'ANY' }
  }
  if (isPlainObject(choice) && typeof choice.name === 'string') {
    return { mode: 'ANY', allowedFunctionNames: [choice.name] }
  }
  return null
}

/**
 * One `functionDeclarations` entry, on the channel its schema can survive.
 *
 * Route, do not strip: `parameters` is a restricted proto that 400s on an unknown field,
 * while `parametersJsonSchema` takes arbitrary JSON Schema. Over-routing is free;
 * guessing wrong on `$ref`, `oneOf` or `additionalProperties` loses the whole request.
 */
export function renderFunctionDeclaration(tool) {
  const schema = ensureObjectSchema(normalizeSchema(tool.parameters))
  const out = { name: tool.name }
  if (typeof tool.description === 'string' && tool.description.length > 0) {
    out.description = tool.description
  }
  if (needsJsonSchemaChannel(schema)) {
    out.parametersJsonSchema = schema
  } else {
    out.parameters = restrictSchema(schema)
  }
  return out
}

/** Recursively drop the three keys that are bookkeeping rather than constraints. */
function normalizeSchema(schema, depth = 0) {
  if (Array.isArray(schema)) {
    return depth > 32 ? [] : schema.map((item) => normalizeSchema(item, depth + 1))
  }
  if (!isPlainObject(schema)) {
    return schema
  }
  if (depth > 32) {
    return {}
  }
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_DROP.has(key)) {
      continue
    }
    out[key] = normalizeSchema(value, depth + 1)
  }
  return out
}

/** Vertex rejects a declaration whose parameters are not an OBJECT with `properties`. */
function ensureObjectSchema(schema) {
  if (!isPlainObject(schema)) {
    return { type: 'object', properties: {} }
  }
  const out = { ...schema }
  if (out.type === undefined) {
    out.type = 'object'
  }
  if (out.type === 'object' && !isPlainObject(out.properties)) {
    out.properties = {}
  }
  return out
}

/** True when any keyword in the tree is outside the restricted schema's vocabulary. */
function needsJsonSchemaChannel(schema) {
  if (Array.isArray(schema)) {
    return schema.some((item) => needsJsonSchemaChannel(item))
  }
  if (!isPlainObject(schema)) {
    return false
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') {
      // A union type (`['string','null']`) is inexpressible in the proto.
      if (Array.isArray(value)) {
        return true
      }
      continue
    }
    if (key === 'properties') {
      if (!isPlainObject(value) || Object.values(value).some((item) => needsJsonSchemaChannel(item))) {
        return true
      }
      continue
    }
    if (key === 'items') {
      if (!isPlainObject(value) || needsJsonSchemaChannel(value)) {
        return true
      }
      continue
    }
    if (key === 'anyOf') {
      if (!Array.isArray(value) || value.some((item) => needsJsonSchemaChannel(item))) {
        return true
      }
      continue
    }
    if (!SCHEMA_KEEP.has(key)) {
      // $ref, $defs, oneOf, allOf, const, additionalProperties, exclusiveMinimum, and
      // anything added to JSON Schema after this was written.
      return true
    }
  }
  return false
}

/** Keep only the restricted vocabulary. `type` stays lowercase — Gemini accepts both. */
function restrictSchema(schema) {
  if (!isPlainObject(schema)) {
    return schema
  }
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEEP.has(key) && key !== 'properties' && key !== 'items' && key !== 'anyOf') {
      continue
    }
    if (key === 'properties' && isPlainObject(value)) {
      out.properties = {}
      for (const [name, child] of Object.entries(value)) {
        out.properties[name] = restrictSchema(child)
      }
      continue
    }
    if (key === 'items' && isPlainObject(value)) {
      out.items = restrictSchema(value)
      continue
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map((item) => restrictSchema(item))
      continue
    }
    out[key] = value
  }
  return out
}

// --------------------------------------------------------------------- response

/** Upstream Gemini JSON -> CanonResponse. */
export function parseResponse(body, canon) {
  if (!isPlainObject(body)) {
    throw new ApiError('bridge.invalid_response', 'gemini response body must be a JSON object')
  }
  const out = emptyResponse()
  out.raw = body
  out.id = typeof body.responseId === 'string' ? body.responseId : ''
  out.model = typeof body.modelVersion === 'string' ? body.modelVersion : (canon?.model ?? '')
  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : null
  // A candidate with no content at all is legitimate: MAX_TOKENS spent entirely on
  // thinking, SAFETY, RECITATION. It is not a transform failure.
  const { parts, calls } = parsePartList(candidate?.content?.parts)
  out.text = collectText(parts)
  out.thinking = collectThinking(parts)
  out.toolCalls = calls.map((call, index) => ({
    id: `call_${call.name}_${index}`,
    name: call.name,
    arguments: call.arguments,
  }))
  out.finishReason = finishReasonIn(candidate?.finishReason, out.toolCalls.length > 0)
  out.usage = parseUsage(body.usageMetadata)

  const blocked = typeof body.promptFeedback?.blockReason === 'string' ? body.promptFeedback.blockReason.trim() : ''
  if (blocked.length > 0) {
    // The prompt never reached the model; say so instead of returning a blank turn.
    out.text = `Request blocked by Gemini safety filters: ${blocked}`
    out.finishReason = 'content_filter'
  }
  return out
}

/**
 * Gemini `finishReason` -> canonical.
 *
 * `MAX_TOKENS` is checked before the tool calls on purpose: a truncated call reported as
 * a complete one makes the client execute a partial argument set. Otherwise tool calls
 * win, because Gemini says `STOP` even when it asked for a tool and a client that sees
 * `stop` next to `tool_calls` never runs the tool.
 */
function finishReasonIn(reason, hasToolCalls) {
  const text = typeof reason === 'string' ? reason : ''
  if (text === 'MAX_TOKENS') {
    return 'length'
  }
  if (hasToolCalls) {
    return 'tool_calls'
  }
  if (BLOCKED_REASONS.has(text)) {
    return 'content_filter'
  }
  return 'stop'
}

/** Canonical -> Gemini `finishReason`. Gemini has no tool-call reason of its own. */
function finishReasonOut(reason) {
  switch (reason) {
    case 'length':
      return 'MAX_TOKENS'
    case 'content_filter':
      return 'SAFETY'
    case 'error':
      return 'OTHER'
    default:
      return 'STOP'
  }
}

/**
 * `usageMetadata` -> CanonUsage.
 *
 * `candidatesTokenCount` omits thinking tokens while every other protocol's output count
 * includes them, so take the larger of `candidates + thoughts` and `total - prompt`:
 * deriving from the total captures thinking even when `thoughtsTokenCount` is absent.
 */
export function parseUsage(metadata) {
  const out = emptyUsage()
  if (!isPlainObject(metadata)) {
    return out
  }
  const prompt = countOf(metadata.promptTokenCount)
  const total = countOf(metadata.totalTokenCount)
  const thoughts = countOf(metadata.thoughtsTokenCount)
  out.inputTokens = prompt
  out.reasoningTokens = thoughts
  out.cacheReadTokens = countOf(metadata.cachedContentTokenCount)
  out.outputTokens = Math.max(countOf(metadata.candidatesTokenCount) + thoughts, Math.max(0, total - prompt))
  return out
}

/** CanonUsage -> `usageMetadata`. */
export function renderUsage(usage) {
  const out = {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: Math.max(0, usage.outputTokens - usage.reasoningTokens),
    totalTokenCount: totalTokens(usage),
  }
  if (usage.reasoningTokens > 0) {
    out.thoughtsTokenCount = usage.reasoningTokens
  }
  if (usage.cacheReadTokens > 0) {
    out.cachedContentTokenCount = usage.cacheReadTokens
  }
  return out
}

/** CanonResponse -> a `GenerateContentResponse` body. */
export function renderResponse(response, canon) {
  const parts = []
  if (response.thinking.length > 0) {
    parts.push({ text: response.thinking, thought: true })
  }
  if (response.text.length > 0) {
    parts.push({ text: response.text })
  }
  for (const call of response.toolCalls) {
    parts.push({ functionCall: { name: call.name, args: argumentsToObject(call.arguments) } })
  }
  const body = {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: finishReasonOut(response.finishReason),
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: renderUsage(response.usage),
    modelVersion: response.model.length > 0 ? response.model : (canon?.model ?? ''),
  }
  if (response.id.length > 0) {
    body.responseId = response.id
  }
  return body
}

// ----------------------------------------------------------------------- stream

/**
 * One Gemini SSE frame -> deltas.
 *
 * Frames carry no event name. `usageMetadata` is restated in full on every frame, so the
 * last one seen is the whole turn. Text may be an increment or a cumulative snapshot, so
 * whatever has already been forwarded is prefix-stripped: forwarding a snapshot verbatim
 * turns `'hel' + 'hello'` into `'helhello'`.
 */
export function parseStreamEvent(event, state) {
  const data = typeof event?.data === 'string' ? event.data.trim() : ''
  if (data.length === 0 || data === '[DONE]') {
    return []
  }
  let chunk
  try {
    chunk = JSON.parse(data)
  } catch {
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
    state.text = ''
    state.thinking = ''
    state.calls = []
    out.push({
      kind: 'start',
      id: typeof chunk.responseId === 'string' ? chunk.responseId : '',
      model: typeof chunk.modelVersion === 'string' ? chunk.modelVersion : '',
    })
  }
  const blocked = typeof chunk.promptFeedback?.blockReason === 'string' ? chunk.promptFeedback.blockReason.trim() : ''
  if (blocked.length > 0) {
    out.push({ kind: 'text', text: `Request blocked by Gemini safety filters: ${blocked}` })
    state.blocked = true
  }
  const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null
  if (isPlainObject(candidate)) {
    for (const part of Array.isArray(candidate.content?.parts) ? candidate.content.parts : []) {
      if (!isPlainObject(part)) {
        continue
      }
      if (isPlainObject(part.functionCall)) {
        const name = String(part.functionCall.name ?? '')
        const args = argumentsToString(part.functionCall.args ?? {})
        const id = typeof part.functionCall.id === 'string' ? part.functionCall.id : ''
        // A resent snapshot re-announces the call; two genuine parallel calls to the
        // same tool differ in their arguments, so both survive this test.
        const seen = state.calls.some((call) =>
          id.length > 0 && call.id.length > 0 ? call.id === id : call.name === name && call.arguments === args,
        )
        if (seen) {
          continue
        }
        // Gemini part indices count text parts too, so tool calls get their own
        // contiguous numbering: a client keys its accumulator on it and never fills a gap.
        const index = state.calls.length
        state.calls.push({ id: id.length > 0 ? id : `call_${name}_${index}`, name, arguments: args })
        out.push({ kind: 'tool-call-start', index, id: state.calls[index].id, name })
        if (args.length > 0) {
          out.push({ kind: 'tool-call-delta', index, argumentsDelta: args })
        }
        out.push({ kind: 'tool-call-end', index })
        continue
      }
      if (typeof part.text !== 'string' || part.text.length === 0) {
        continue
      }
      if (part.thought === true) {
        const delta = part.text.startsWith(state.thinking) ? part.text.slice(state.thinking.length) : part.text
        if (delta.length > 0) {
          state.thinking += delta
          out.push({ kind: 'thinking', text: delta })
        }
        continue
      }
      const delta = part.text.startsWith(state.text) ? part.text.slice(state.text.length) : part.text
      if (delta.length > 0) {
        state.text += delta
        out.push({ kind: 'text', text: delta })
      }
    }
    if (typeof candidate.finishReason === 'string' && candidate.finishReason.length > 0) {
      state.finishReason = candidate.finishReason
    }
  }
  if (isPlainObject(chunk.usageMetadata)) {
    out.push({ kind: 'usage', usage: parseUsage(chunk.usageMetadata) })
  }
  if (state.finishReason !== undefined && state.finishSent !== true) {
    state.finishSent = true
    state.terminal = true
    out.push({
      kind: 'finish',
      finishReason: state.blocked === true
        ? 'content_filter'
        : finishReasonIn(state.finishReason, state.calls.length > 0),
    })
  }
  return out
}

/**
 * Deltas -> Gemini SSE frames.
 *
 * Every frame is a whole partial `GenerateContentResponse` with no event name, and there
 * is no `[DONE]`: the stream simply ends. Usage rides on the final frame because Gemini
 * restates it there and clients read it off the last one.
 */
export function renderStreamEvents(deltas, state) {
  const frames = []
  const emit = (candidate, extra = {}) => {
    const chunk = { candidates: candidate === null ? [] : [candidate], ...extra }
    if (state.model !== undefined && state.model.length > 0) {
      chunk.modelVersion = state.model
    }
    if (state.id !== undefined && state.id.length > 0) {
      chunk.responseId = state.id
    }
    frames.push({ data: JSON.stringify(chunk) })
  }
  const content = (parts) => ({ content: { role: 'model', parts }, index: 0 })

  for (const delta of Array.isArray(deltas) ? deltas : []) {
    switch (delta.kind) {
      case 'start':
        state.id = typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : ''
        state.model = typeof delta.model === 'string' ? delta.model : ''
        break
      case 'text':
        emit(content([{ text: delta.text }]))
        break
      case 'thinking':
        emit(content([{ text: delta.text, thought: true }]))
        break
      case 'tool-call-start':
        state.pending = state.pending ?? new Map()
        state.pending.set(delta.index ?? 0, { name: delta.name ?? '', arguments: '' })
        break
      case 'tool-call-delta': {
        const pending = state.pending?.get(delta.index ?? 0)
        if (pending !== undefined) {
          pending.arguments += String(delta.argumentsDelta ?? '')
        }
        break
      }
      case 'tool-call-end': {
        // Gemini has no partial-arguments frame, so the call is held until it is complete.
        const pending = state.pending?.get(delta.index ?? 0)
        if (pending !== undefined) {
          state.pending.delete(delta.index ?? 0)
          emit(content([{ functionCall: { name: pending.name, args: argumentsToObject(pending.arguments) } }]))
        }
        break
      }
      case 'usage':
        state.usage = delta.usage
        break
      case 'finish': {
        // Flush any call whose end never arrived rather than silently dropping it.
        for (const [, pending] of state.pending ?? []) {
          emit(content([{ functionCall: { name: pending.name, args: argumentsToObject(pending.arguments) } }]))
        }
        state.pending?.clear()
        const extra = {}
        if (state.usage !== undefined) {
          extra.usageMetadata = renderUsage(state.usage)
        }
        emit({ content: { role: 'model', parts: [] }, finishReason: finishReasonOut(delta.finishReason), index: 0 }, extra)
        break
      }
      case 'error':
        emit(null, { error: { code: 500, message: delta.message ?? 'upstream error', status: 'INTERNAL' } })
        break
      default:
        break
    }
  }
  return frames
}
