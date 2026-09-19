/**
 * Bridge tests. They assert field names and event order, not just "it did not throw":
 * a wrong key in one of these mappings is a 400 from an upstream nobody can debug from
 * the client side, so every case below names the exact shape it expects.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROTOCOLS,
  buildUpstreamRequest,
  createStreamBridge,
  detectLocalProtocol,
  isCountTokensPath,
  isModelsPath,
  translateResponse,
} from '../src/host/bridge/index.js'
import { createSseParser, encodeSseFrame } from '../src/host/bridge/sse.js'

// ------------------------------------------------------------------ test helpers

/** Every frame in one SSE text, parser flushed. */
const framesOf = (text) => {
  const parser = createSseParser()
  return [...parser.push(text), ...parser.end()]
}

/** The JSON payloads of an SSE text, `[DONE]` dropped, event name folded in as `_event`. */
const payloadsOf = (text) =>
  framesOf(text)
    .filter((frame) => frame.data !== '[DONE]')
    .map((frame) => ({ _event: frame.event, ...JSON.parse(frame.data) }))

/** Build an upstream SSE text out of `{event?, data}` pairs. */
const sse = (frames) => frames.map((frame) => encodeSseFrame(frame)).join('')

/** Run a whole upstream stream through a bridge in one push. */
const bridgeAll = (from, to, text) => {
  const bridge = createStreamBridge({ from, to })
  const out = bridge.push(text) + bridge.end()
  return { out, usage: bridge.usage(), finishReason: bridge.finishReason() }
}

/** The first payload with this `type`, or undefined. */
const byType = (payloads, type) => payloads.find((item) => item.type === type)

/** Every payload with this `type`. */
const allOfType = (payloads, type) => payloads.filter((item) => item.type === type)

// ----------------------------------------------------------------- path detection

test('local paths map to protocols with and without version prefixes', () => {
  assert.equal(detectLocalProtocol('/v1/chat/completions'), 'chat')
  assert.equal(detectLocalProtocol('/chat/completions'), 'chat')
  assert.equal(detectLocalProtocol('/v1/chat/completions/'), 'chat')
  assert.equal(detectLocalProtocol('/v1/responses'), 'responses')
  assert.equal(detectLocalProtocol('/responses'), 'responses')
  assert.equal(detectLocalProtocol('/v1/messages'), 'anthropic')
  assert.equal(detectLocalProtocol('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini')
  assert.equal(
    detectLocalProtocol('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'),
    'gemini',
  )
  // Not entry points.
  assert.equal(detectLocalProtocol('/v1/responses/compact'), null)
  assert.equal(detectLocalProtocol('/v1/messages/count_tokens'), null)
  assert.equal(detectLocalProtocol('/v1/models'), null)
  assert.equal(detectLocalProtocol(''), null)
})

test('the models and count_tokens endpoints are recognised separately', () => {
  assert.equal(isModelsPath('/models'), true)
  assert.equal(isModelsPath('/v1/models'), true)
  assert.equal(isModelsPath('/v1beta/models'), true)
  assert.equal(isModelsPath('/v1/models/gpt-4o'), false)
  assert.equal(isCountTokensPath('/v1/messages/count_tokens'), true)
  assert.equal(isCountTokensPath('/messages/count_tokens'), true)
  assert.equal(isCountTokensPath('/v1/messages'), false)
})

test('an unknown protocol id is a bridge.unsupported_protocol error', () => {
  assert.throws(
    () => buildUpstreamRequest({ from: 'chat', to: 'bedrock', body: { messages: [] } }),
    (error) => error.code === 'bridge.unsupported_protocol',
  )
})

// --------------------------------------------------------------------- sse parser

test('the sse parser handles crlf, split frames, comments and multi-line data', () => {
  const parser = createSseParser()
  // A CRLF cut in half between two chunks must not dispatch twice.
  let frames = parser.push('event: message_start\r\ndata: {"a":1}\r')
  assert.deepEqual(frames, [])
  frames = parser.push('\n\r\n')
  assert.deepEqual(frames, [{ event: 'message_start', data: '{"a":1}' }])

  // Comments are keep-alives; `data:` with no space and multi-line data both work.
  frames = parser.push(': ping\ndata:one\ndata: two\n\n')
  assert.deepEqual(frames, [{ event: null, data: 'one\ntwo' }])

  // id/retry never dispatch on their own.
  assert.deepEqual(parser.push('id: 7\nretry: 3000\n\n'), [])

  // `[DONE]` comes through as ordinary data.
  assert.deepEqual(parser.push('data: [DONE]\n\n'), [{ event: null, data: '[DONE]' }])
})

test('the sse parser flushes a stream that ends without its blank line', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.push('data: {"x":1}\n'), [])
  assert.deepEqual(parser.end(), [{ event: null, data: '{"x":1}' }])
})

test('encodeSseFrame splits embedded newlines back into data lines', () => {
  assert.equal(encodeSseFrame({ event: 'e', data: 'a\nb' }), 'event: e\ndata: a\ndata: b\n\n')
  assert.equal(encodeSseFrame({ data: '[DONE]' }), 'data: [DONE]\n\n')
})

// ------------------------------------------------------------ same-protocol passthrough

test('same-protocol hops substitute the model and touch nothing else', () => {
  const bodies = {
    chat: { model: 'local-name', messages: [{ role: 'user', content: 'hi' }], logit_bias: { 7: 1 }, seed: 4 },
    responses: { model: 'local-name', input: 'hi', include: ['reasoning.encrypted_content'], store: false },
    anthropic: {
      model: 'local-name',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    },
  }
  const expectedPaths = { chat: '/chat/completions', responses: '/responses', anthropic: '/messages' }
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const hop = buildUpstreamRequest({ from: protocol, to: protocol, body: bodies[protocol], model: 'upstream-id' })
    assert.equal(hop.path, expectedPaths[protocol])
    assert.equal(hop.body.model, 'upstream-id')
    // Provider-specific fields the canonical form has no home for must still be there.
    for (const [key, value] of Object.entries(bodies[protocol])) {
      if (key !== 'model') {
        assert.deepEqual(hop.body[key], value, `${protocol}.${key} survived`)
      }
    }
  }
})

test('a gemini passthrough rewrites the model in the url, not the body', () => {
  const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], safetySettings: [{ category: 'X' }] }
  const hop = buildUpstreamRequest({
    from: 'gemini',
    to: 'gemini',
    body,
    model: 'gemini-2.5-flash',
    path: '/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse',
  })
  assert.equal(hop.path, '/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  assert.equal(hop.stream, true)
  assert.equal(hop.body.model, undefined)
  assert.deepEqual(hop.body, body)
})

test('same-protocol streams pass bytes through verbatim while still reporting usage', () => {
  const text = sse([
    { data: JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] }) },
    { data: JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) },
    { data: JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }) },
    { data: '[DONE]' },
  ])
  const result = bridgeAll('chat', 'chat', text)
  assert.equal(result.out, text)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage.inputTokens, 11)
  assert.equal(result.usage.outputTokens, 3)
})

test('a non-streaming same-protocol response is the identical object', () => {
  const body = { id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], system_fingerprint: 'fp' }
  assert.equal(translateResponse({ from: 'chat', to: 'chat', body }).body, body)
})

test('PROTOCOLS lists exactly the four wire formats', () => {
  assert.deepEqual(PROTOCOLS, ['chat', 'responses', 'anthropic', 'gemini'])
})

// ------------------------------------------------------------- responses <-> chat

const CODEX_REQUEST = {
  model: 'gpt-5-codex',
  instructions: 'You are Codex.',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ls is enough' }] },
    { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ],
  tools: [
    { type: 'function', name: 'shell', description: 'run it', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    { type: 'web_search' },
  ],
  tool_choice: 'auto',
  max_output_tokens: 2048,
  reasoning: { effort: 'high', summary: 'auto' },
  parallel_tool_calls: false,
  stream: true,
}

test('responses -> chat: input items become messages and tools get their function wrapper', () => {
  const hop = buildUpstreamRequest({ from: 'responses', to: 'chat', body: CODEX_REQUEST, model: 'deepseek-chat' })
  assert.equal(hop.path, '/chat/completions')
  assert.equal(hop.stream, true)
  const body = hop.body
  assert.equal(body.model, 'deepseek-chat')
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Codex.' })
  assert.deepEqual(body.messages[1], { role: 'user', content: 'list files' })
  // The reasoning item attaches to the tool-call turn it preceded, not to a message.
  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: null,
    reasoning_content: 'ls is enough',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
  })
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' })
  assert.deepEqual(body.messages[4], { role: 'user', content: 'thanks' })
  assert.equal(body.messages.length, 5)
  // Flat -> nested, and the hosted `web_search` tool is dropped rather than forwarded.
  assert.equal(body.tools.length, 1)
  assert.deepEqual(body.tools[0], {
    type: 'function',
    function: { name: 'shell', description: 'run it', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
  })
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.max_tokens, 2048)
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.reasoning_effort, 'high')
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.input, undefined)
  assert.equal(body.instructions, undefined)
})

test('responses -> chat: a namespaced tool group is flattened with a __ prefix', () => {
  const hop = buildUpstreamRequest({
    from: 'responses',
    to: 'chat',
    body: { model: 'm', input: 'hi', tools: [{ type: 'namespace', name: 'git_', tools: [{ type: 'function', name: 'status', parameters: {} }] }] },
  })
  assert.equal(hop.body.tools[0].function.name, 'git__status')
})

test('responses -> chat: the token ceiling travels under exactly one name', () => {
  const ceiling = (model) => {
    const hop = buildUpstreamRequest({
      from: 'responses',
      to: 'chat',
      body: { model: 'gpt-5-codex', input: 'hi', max_output_tokens: 64 },
      model,
    })
    return [hop.body.max_tokens, hop.body.max_completion_tokens]
  }
  // The reasoning families 400 on `max_tokens`; every relay understands only that name.
  assert.deepEqual(ceiling('o3-mini'), [undefined, 64])
  assert.deepEqual(ceiling('gpt-5.1'), [undefined, 64])
  assert.deepEqual(ceiling('deepseek-chat'), [64, undefined])
  assert.deepEqual(ceiling('glm-4.6'), [64, undefined])
})

test('responses -> chat: a system item inside input is hoisted, not left mid-conversation', () => {
  const hop = buildUpstreamRequest({
    from: 'responses',
    to: 'chat',
    body: {
      model: 'm',
      instructions: 'base',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'extra rules' }] },
      ],
    },
  })
  assert.deepEqual(hop.body.messages[0], { role: 'system', content: 'base\n\nextra rules' })
  assert.deepEqual(hop.body.messages[1], { role: 'user', content: 'hi' })
  assert.equal(hop.body.messages.length, 2)
})

const CHAT_REQUEST = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'developer', content: 'and precise' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 'call_9', content: '42' },
  ],
  tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
  tool_choice: { type: 'function', function: { name: 'f' } },
  max_tokens: 100,
  temperature: 0.2,
  stop: ['STOP'],
}

test('chat -> responses: messages become input items and tools lose their wrapper', () => {
  const hop = buildUpstreamRequest({ from: 'chat', to: 'responses', body: CHAT_REQUEST, model: 'gpt-5' })
  assert.equal(hop.path, '/responses')
  const body = hop.body
  assert.equal(body.model, 'gpt-5')
  // Both system-ish roles are hoisted and joined, and they leave `input` entirely.
  assert.equal(body.instructions, 'be brief\n\nand precise')
  assert.deepEqual(body.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }],
  })
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{"x":1}' })
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_9', output: '42' })
  assert.equal(body.input.length, 3)
  assert.deepEqual(body.tools[0], { type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } })
  assert.equal(body.tools[0].function, undefined)
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'f' })
  assert.equal(body.max_output_tokens, 100)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.messages, undefined)
  assert.equal(body.max_tokens, undefined)
  // `stop` has no Responses field; forwarding it would 400 a strict upstream.
  assert.equal(body.stop, undefined)
  assert.equal(body.stop_sequences, undefined)
})

// ------------------------------------------------------------ anthropic <-> chat

const CLAUDE_REQUEST = {
  model: 'claude-sonnet-4-5',
  max_tokens: 8192,
  system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'need to read it', signature: 'sig' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] },
        { type: 'text', text: 'now summarise' },
      ],
    },
  ],
  tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  thinking: { type: 'enabled', budget_tokens: 10000 },
  top_k: 40,
  stop_sequences: ['</done>'],
  metadata: { user_id: 'u-1' },
  stream: true,
}

test('anthropic -> chat: blocks fan out into messages and tool results become tool turns', () => {
  const hop = buildUpstreamRequest({ from: 'anthropic', to: 'chat', body: CLAUDE_REQUEST, model: 'deepseek-chat' })
  const body = hop.body
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Claude Code.' })
  assert.deepEqual(body.messages[1], { role: 'user', content: 'read a.txt' })
  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: 'Reading.',
    reasoning_content: 'need to read it',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }],
  })
  // The result leads, then the user text that followed it in the same Anthropic message.
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' })
  assert.deepEqual(body.messages[4], { role: 'user', content: 'now summarise' })
  assert.deepEqual(body.tools[0], {
    type: 'function',
    function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  })
  assert.equal(body.tools[0].function.input_schema, undefined)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.reasoning_effort, 'medium')
  assert.deepEqual(body.stop, ['</done>'])
  assert.equal(body.top_k, 40)
  assert.equal(body.user, 'u-1')
})

test('anthropic -> chat: an errored, imageful or empty tool result stays legible', () => {
  const hop = buildUpstreamRequest({
    from: 'anthropic',
    to: 'chat',
    body: {
      model: 'm',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { media_type: 'image/png' } }] }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: '' }] },
      ],
    },
  })
  assert.equal(hop.body.messages[0].content, '[tool error] boom')
  assert.match(hop.body.messages[1].content, /tool returned an image \(image\/png\)/)
  assert.equal(hop.body.messages[2].content, '[ai-switch: tool returned no content]')
})

test('chat -> anthropic: system leaves messages, max_tokens is defaulted, results merge', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'anthropic',
    body: {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
          { id: 'call_b', type: 'function', function: { name: 'g', arguments: 'not json' } },
        ] },
        { role: 'tool', tool_call_id: 'call_a', content: '1' },
        { role: 'tool', tool_call_id: 'call_b', content: '2' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      reasoning_effort: 'low',
    },
    model: 'claude-opus-4',
  })
  assert.equal(hop.path, '/messages')
  const body = hop.body
  assert.equal(body.model, 'claude-opus-4')
  // Anthropic requires a ceiling; a Chat request without one gets the documented default.
  assert.equal(body.max_tokens, 4096)
  assert.deepEqual(body.system, [{ type: 'text', text: 'sys' }])
  assert.deepEqual(body.messages[0], { role: 'user', content: [{ type: 'text', text: 'hi' }] })
  assert.deepEqual(body.messages[1].content, [
    { type: 'tool_use', id: 'call_a', name: 'f', input: { x: 1 } },
    // Unparseable arguments become `{}`: a 400 would strand the client with nothing.
    { type: 'tool_use', id: 'call_b', name: 'g', input: {} },
  ])
  // Both results share one user message, or an assistant turn would interleave them.
  assert.equal(body.messages[2].role, 'user')
  assert.deepEqual(body.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call_a', content: '1' },
    { type: 'tool_result', tool_use_id: 'call_b', content: '2' },
  ])
  assert.equal(body.messages.length, 3)
  assert.deepEqual(body.tools[0], { name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } })
  assert.equal(body.tools[0].parameters, undefined)
  assert.deepEqual(body.tool_choice, { type: 'any' })
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 })
})

test('chat -> anthropic: a thinking budget can never reach max_tokens', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'anthropic',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2000, reasoning_effort: 'high' },
  })
  assert.equal(hop.body.thinking.budget_tokens, 1999)
  // Below Anthropic's 1024 floor thinking cannot be enabled at all.
  const tiny = buildUpstreamRequest({
    from: 'chat',
    to: 'anthropic',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 500, reasoning_effort: 'high' },
  })
  assert.equal(tiny.body.thinking, undefined)
})

// --------------------------------------------------------------- gemini <-> chat

test('chat -> gemini: camelCase keys, model and stream in the url, tool results as parts', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'gemini',
    body: {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'integer' } } } } }],
      tool_choice: 'required',
      max_tokens: 512,
      temperature: 0.5,
      top_p: 0.9,
      stop: ['x'],
      stream: true,
    },
    model: 'gemini-2.5-pro',
  })
  assert.equal(hop.path, '/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
  const body = hop.body
  // `generateContent` knows neither field and rejects both.
  assert.equal(body.model, undefined)
  assert.equal(body.stream, undefined)
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] })
  assert.equal(body.system_instruction, undefined)
  assert.deepEqual(body.contents[0], { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] })
  // `model`, not `assistant`, and the call id is deliberately not forwarded.
  assert.deepEqual(body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] })
  assert.deepEqual(body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'f', response: { output: 'ok' } } }] })
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 512,
    temperature: 0.5,
    topP: 0.9,
    stopSequences: ['x'],
  })
  // One outer element wrapping the declarations, and toolConfig never travels alone.
  assert.equal(body.tools.length, 1)
  assert.deepEqual(body.tools[0].functionDeclarations[0], {
    name: 'f',
    description: 'd',
    parameters: { type: 'object', properties: { a: { type: 'integer' } } },
  })
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } })
})

test('chat -> gemini: naming one tool is ANY narrowed by allowedFunctionNames', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'gemini',
    body: {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    },
    model: 'gemini-2.5-flash',
  })
  assert.deepEqual(hop.body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } })
  assert.equal(hop.path, '/models/gemini-2.5-flash:generateContent')
})

test('chat -> gemini: a forced mode with no declarations is never sent', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'gemini',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tool_choice: 'required' },
    model: 'gemini-2.5-flash',
  })
  assert.equal(hop.body.toolConfig, undefined)
  assert.equal(hop.body.tools, undefined)
})

test('chat -> gemini: a rich schema is routed to parametersJsonSchema, not stripped', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'gemini',
    body: {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'rich', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: { n: { type: 'integer', exclusiveMinimum: 0 } } } } },
        { type: 'function', function: { name: 'plain', parameters: { type: 'object', properties: { city: { type: 'string', description: 'where' } }, required: ['city'] } } },
      ],
    },
    model: 'gemini-2.5-pro',
  })
  const [rich, plain] = hop.body.tools[0].functionDeclarations
  // Bookkeeping keys go; the constraints Gemini's proto cannot express travel intact.
  assert.equal(rich.parameters, undefined)
  assert.equal(rich.parametersJsonSchema.$schema, undefined)
  assert.equal(rich.parametersJsonSchema.additionalProperties, false)
  assert.equal(rich.parametersJsonSchema.properties.n.exclusiveMinimum, 0)
  // A schema inside the vocabulary stays on the restricted channel, type lowercase.
  assert.equal(plain.parametersJsonSchema, undefined)
  assert.equal(plain.parameters.type, 'object')
  assert.equal(plain.parameters.properties.city.type, 'string')
  assert.deepEqual(plain.parameters.required, ['city'])
})

test('chat -> gemini: an empty message is dropped rather than sent with empty parts', () => {
  const hop = buildUpstreamRequest({
    from: 'chat',
    to: 'gemini',
    body: { model: 'm', messages: [{ role: 'assistant', content: '' }, { role: 'user', content: 'hi' }] },
    model: 'g',
  })
  assert.equal(hop.body.contents.length, 1)
  assert.equal(hop.body.contents[0].role, 'user')
})

test('gemini -> chat: contents become messages and function results regain their call id', () => {
  const hop = buildUpstreamRequest({
    from: 'gemini',
    to: 'chat',
    path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    body: {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ text: 'checking' }, { functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: 'sunny' } } }] },
      ],
      generationConfig: { maxOutputTokens: 256, temperature: 0.1, topK: 32, thinkingConfig: { thinkingBudget: 8192 } },
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: {} } }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    },
    model: 'deepseek-chat',
  })
  const body = hop.body
  assert.equal(hop.stream, true)
  assert.equal(body.model, 'deepseek-chat')
  assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' })
  assert.deepEqual(body.messages[1], { role: 'user', content: 'weather?' })
  const assistant = body.messages[2]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content, 'checking')
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"SF"}')
  // Gemini carries no ids, so one is invented on the call and reused on the result.
  const callId = assistant.tool_calls[0].id
  assert.equal(callId, 'call_get_weather_0')
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: callId, content: 'sunny' })
  assert.equal(body.max_tokens, 256)
  assert.equal(body.temperature, 0.1)
  assert.equal(body.top_k, 32)
  assert.equal(body.reasoning_effort, 'medium')
  assert.equal(body.tool_choice, 'auto')
})

// ------------------------------------------------------- non-streaming responses

const CHAT_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'done',
        reasoning_content: 'thought',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
}

test('chat -> responses response: output items, usage rename and the inert envelope', () => {
  const { body } = translateResponse({ from: 'chat', to: 'responses', body: CHAT_RESPONSE })
  assert.equal(body.object, 'response')
  assert.equal(body.status, 'completed')
  assert.equal(body.model, 'deepseek-chat')
  assert.deepEqual(body.output[0], { id: body.output[0].id, type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] })
  assert.match(body.output[0].id, /^rs_/)
  assert.deepEqual(body.output[1].content, [{ type: 'output_text', text: 'done', annotations: [], logprobs: [] }])
  assert.equal(body.output[1].type, 'message')
  assert.equal(body.output[1].status, 'completed')
  assert.equal(body.output[1].role, 'assistant')
  assert.deepEqual(body.output[2], {
    id: body.output[2].id,
    type: 'function_call',
    status: 'completed',
    call_id: 'call_1',
    name: 'shell',
    arguments: '{"cmd":"ls"}',
  })
  assert.deepEqual(body.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 15,
  })
  assert.equal(body.output_text, 'done')
  // Required-but-inert padding a strict Responses client reads before the output.
  assert.equal(body.store, false)
  assert.equal(body.truncation, 'disabled')
  assert.equal(body.parallel_tool_calls, true)
  assert.deepEqual(body.text, { format: { type: 'text' } })
  assert.equal(body.incomplete_details, null)
  assert.equal(body.error, null)
})

test('responses -> chat response: truncation outranks tool calls', () => {
  const { body } = translateResponse({
    from: 'responses',
    to: 'chat',
    body: {
      id: 'resp_1',
      object: 'response',
      status: 'incomplete',
      model: 'gpt-5',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'hmm' }] },
        { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
        { id: 'fc_1', type: 'function_call', call_id: 'call_x', name: 'f', arguments: '{"a' },
      ],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        total_tokens: 9,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  })
  assert.equal(body.object, 'chat.completion')
  // Arguments cut off at the cap are not parseable, so `length` wins over `tool_calls`.
  assert.equal(body.choices[0].finish_reason, 'length')
  assert.equal(body.choices[0].message.content, 'partial')
  assert.equal(body.choices[0].message.reasoning_content, 'hmm')
  assert.equal(body.choices[0].message.tool_calls[0].id, 'call_x')
  assert.deepEqual(body.usage, {
    prompt_tokens: 7,
    completion_tokens: 2,
    total_tokens: 9,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 1 },
  })
})

test('responses -> chat response: a failed status becomes an error finish, not clean text', () => {
  const { body } = translateResponse({
    from: 'responses',
    to: 'chat',
    body: { id: 'resp_2', status: 'failed', error: { code: 'server_error', message: 'upstream died' }, output: [] },
  })
  assert.equal(body.choices[0].finish_reason, 'error')
  assert.match(body.choices[0].message.content, /upstream died/)
})

test('anthropic -> chat response: stop_reason and the four cache counters', () => {
  const { body } = translateResponse({
    from: 'anthropic',
    to: 'chat',
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', thinking: 't' },
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 3, cache_read_input_tokens: 9 },
    },
  })
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.content, 'ok')
  assert.equal(body.choices[0].message.reasoning_content, 't')
  assert.deepEqual(body.choices[0].message.tool_calls[0], {
    id: 'toolu_1',
    type: 'function',
    function: { name: 'Read', arguments: '{"path":"a"}' },
  })
  assert.equal(body.usage.prompt_tokens, 12)
  assert.equal(body.usage.completion_tokens, 6)
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 9)
  assert.equal(body.usage.prompt_tokens_details.cache_creation_tokens, 3)
})

test('chat -> anthropic response: block order, stop_reason and usage names', () => {
  const { body } = translateResponse({
    from: 'chat',
    to: 'anthropic',
    body: { ...CHAT_RESPONSE, choices: [{ ...CHAT_RESPONSE.choices[0], finish_reason: 'length' }] },
  })
  assert.equal(body.type, 'message')
  assert.equal(body.role, 'assistant')
  assert.equal(body.stop_reason, 'max_tokens')
  assert.equal(body.stop_sequence, null)
  assert.equal(body.content[0].type, 'thinking')
  assert.equal(body.content[1].type, 'text')
  assert.equal(body.content[1].text, 'done')
  assert.deepEqual(body.content[2], { type: 'tool_use', id: 'call_1', name: 'shell', input: { cmd: 'ls' } })
  assert.deepEqual(body.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
  })
})

test('gemini -> chat response: thought parts, synthesised ids and the usage arithmetic', () => {
  const { body } = translateResponse({
    from: 'gemini',
    to: 'chat',
    body: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'thought', thought: true }, { text: 'hi' }, { functionCall: { name: 'f', args: { a: 1 } } }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 10, cachedContentTokenCount: 1 },
      modelVersion: 'gemini-2.5-pro',
      responseId: 'r1',
    },
  })
  // Gemini says STOP even when it asked for a tool; a client seeing `stop` never runs it.
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.content, 'hi')
  assert.equal(body.choices[0].message.reasoning_content, 'thought')
  assert.equal(body.choices[0].message.tool_calls[0].id, 'call_f_0')
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(body.model, 'gemini-2.5-pro')
  // candidatesTokenCount omits thinking, so the output side is derived from the total.
  assert.equal(body.usage.prompt_tokens, 5)
  assert.equal(body.usage.completion_tokens, 5)
  assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 2)
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 1)
})

test('gemini -> chat response: MAX_TOKENS is length even when a tool was requested', () => {
  const { body } = translateResponse({
    from: 'gemini',
    to: 'chat',
    body: { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] }, finishReason: 'MAX_TOKENS' }] },
  })
  assert.equal(body.choices[0].finish_reason, 'length')
})

test('gemini -> chat response: a blocked prompt is reported, not returned blank', () => {
  const { body } = translateResponse({
    from: 'gemini',
    to: 'chat',
    body: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
  })
  assert.equal(body.choices[0].finish_reason, 'content_filter')
  assert.match(body.choices[0].message.content, /blocked by Gemini safety filters: SAFETY/)
})

test('chat -> gemini response: parts, finishReason and usageMetadata', () => {
  const { body } = translateResponse({ from: 'chat', to: 'gemini', body: CHAT_RESPONSE })
  const parts = body.candidates[0].content.parts
  assert.equal(body.candidates[0].content.role, 'model')
  assert.deepEqual(parts[0], { text: 'thought', thought: true })
  assert.deepEqual(parts[1], { text: 'done' })
  assert.deepEqual(parts[2], { functionCall: { name: 'shell', args: { cmd: 'ls' } } })
  // Gemini has no tool-call reason of its own.
  assert.equal(body.candidates[0].finishReason, 'STOP')
  assert.deepEqual(body.usageMetadata, {
    promptTokenCount: 10,
    candidatesTokenCount: 3,
    totalTokenCount: 15,
    thoughtsTokenCount: 2,
    cachedContentTokenCount: 4,
  })
})

// -------------------------------------------------------------- streaming: -> chat

const RESPONSES_STREAM = sse([
  { event: 'response.created', data: JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'gpt-5', output: [], usage: null } }) },
  { event: 'response.in_progress', data: JSON.stringify({ type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1', status: 'in_progress', model: 'gpt-5', output: [] } }) },
  { event: 'response.output_item.added', data: JSON.stringify({ type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }) },
  { event: 'response.reasoning_summary_text.delta', data: JSON.stringify({ type: 'response.reasoning_summary_text.delta', sequence_number: 3, item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'think' }) },
  { event: 'response.output_item.added', data: JSON.stringify({ type: 'response.output_item.added', sequence_number: 4, output_index: 1, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) },
  { event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', sequence_number: 5, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hel' }) },
  { event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', sequence_number: 6, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'lo' }) },
  { event: 'response.output_item.added', data: JSON.stringify({ type: 'response.output_item.added', sequence_number: 7, output_index: 2, item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_1', name: 'shell', arguments: '' } }) },
  { event: 'response.function_call_arguments.delta', data: JSON.stringify({ type: 'response.function_call_arguments.delta', sequence_number: 8, item_id: 'fc_1', output_index: 2, delta: '{"cmd"' }) },
  { event: 'response.function_call_arguments.delta', data: JSON.stringify({ type: 'response.function_call_arguments.delta', sequence_number: 9, item_id: 'fc_1', output_index: 2, delta: ':"ls"}' }) },
  { event: 'response.function_call_arguments.done', data: JSON.stringify({ type: 'response.function_call_arguments.done', sequence_number: 10, item_id: 'fc_1', output_index: 2, arguments: '{"cmd":"ls"}' }) },
  { event: 'response.output_item.done', data: JSON.stringify({ type: 'response.output_item.done', sequence_number: 11, output_index: 2, item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' } }) },
  { event: 'response.completed', data: JSON.stringify({ type: 'response.completed', sequence_number: 12, response: { id: 'resp_1', status: 'completed', model: 'gpt-5', output: [], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } }) },
])

test('responses -> chat stream: text, reasoning, one tool call and a usage chunk', () => {
  const { out, usage, finishReason } = bridgeAll('responses', 'chat', RESPONSES_STREAM)
  const frames = framesOf(out)
  const chunks = payloadsOf(out)
  assert.equal(frames[frames.length - 1].data, '[DONE]')
  assert.equal(finishReason, 'tool_calls')

  // The first chunk announces the role, as an OpenAI stream always does.
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' })
  assert.equal(chunks[0].object, 'chat.completion.chunk')
  assert.equal(chunks[0].id, 'resp_1')
  assert.equal(chunks[0].model, 'gpt-5')

  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('')
  assert.equal(text, 'Hello')
  const reasoning = chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? '').join('')
  assert.equal(reasoning, 'think')

  // Exactly one opening frame, and the cumulative `.done` must not double the arguments.
  const toolFrames = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls !== undefined)
  const openings = toolFrames.filter((chunk) => chunk.choices[0].delta.tool_calls[0].id !== undefined)
  assert.equal(openings.length, 1)
  assert.deepEqual(openings[0].choices[0].delta.tool_calls[0], {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'shell', arguments: '' },
  })
  const args = toolFrames.map((chunk) => chunk.choices[0].delta.tool_calls[0].function?.arguments ?? '').join('')
  assert.equal(args, '{"cmd":"ls"}')

  const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason !== null && chunk.choices?.length === 1)
  assert.equal(finish.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(finish.choices[0].delta, {})

  // `stream_options.include_usage` shape: a trailing chunk with no choices.
  const usageChunk = chunks.find((chunk) => chunk.usage !== undefined)
  assert.deepEqual(usageChunk.choices, [])
  assert.equal(usageChunk.usage.prompt_tokens, 9)
  assert.equal(usageChunk.usage.completion_tokens, 4)
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 2)
  assert.equal(usageChunk.usage.completion_tokens_details.reasoning_tokens, 1)
  assert.equal(usage.inputTokens, 9)
  assert.equal(usage.reasoningTokens, 1)
})

test('responses -> chat stream: a relay that only sends the terminal arguments still works', () => {
  const stream = sse([
    { event: 'response.created', data: JSON.stringify({ type: 'response.created', response: { id: 'r', model: 'm', usage: null } }) },
    { event: 'response.output_item.done', data: JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_z', name: 'f', arguments: '{"a":1}' } }) },
    { event: 'response.completed', data: JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', model: 'm' } }) },
  ])
  const chunks = payloadsOf(bridgeAll('responses', 'chat', stream).out)
  const toolFrames = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls !== undefined)
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].id, 'call_z')
  const args = toolFrames.map((chunk) => chunk.choices[0].delta.tool_calls[0].function?.arguments ?? '').join('')
  assert.equal(args, '{"a":1}')
})

test('responses -> chat stream: a mid-stream response.failed becomes an error frame', () => {
  const stream = sse([
    { event: 'response.created', data: JSON.stringify({ type: 'response.created', response: { id: 'r', model: 'm' } }) },
    { event: 'response.failed', data: JSON.stringify({ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'x', message: 'upstream died' } } }) },
  ])
  const result = bridgeAll('responses', 'chat', stream)
  assert.equal(result.finishReason, 'error')
  const chunks = payloadsOf(result.out)
  assert.match(chunks[chunks.length - 1].error.message, /upstream died/)
  assert.equal(framesOf(result.out).pop().data, '[DONE]')
})

const ANTHROPIC_STREAM = sse([
  { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 14, output_tokens: 0, cache_read_input_tokens: 6 } } }) },
  { event: 'ping', data: JSON.stringify({ type: 'ping' }) },
  { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) },
  { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
  { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } }) },
  { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 1 }) },
  { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } }) },
  { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"a"}' } }) },
  { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 2 }) },
  { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }) },
  { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
])

test('anthropic -> chat stream: block indices are renumbered to a tool-only sequence', () => {
  const { out, usage, finishReason } = bridgeAll('anthropic', 'chat', ANTHROPIC_STREAM)
  const chunks = payloadsOf(out)
  assert.equal(finishReason, 'tool_calls')
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' })
  assert.equal(chunks[0].id, 'msg_1')
  assert.equal(chunks[0].model, 'claude-sonnet-4-5')
  assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join(''), 'Hi')
  assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? '').join(''), 'hmm')

  const toolFrames = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls !== undefined)
  // The Anthropic block index was 2 because thinking and text came first; chat wants 0.
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].index, 0)
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].id, 'toolu_1')
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].function.name, 'Read')
  assert.equal(
    toolFrames.map((chunk) => chunk.choices[0].delta.tool_calls[0].function?.arguments ?? '').join(''),
    '{"path":"a"}',
  )

  const usageChunk = chunks.find((chunk) => chunk.usage !== undefined)
  assert.equal(usageChunk.usage.prompt_tokens, 14)
  assert.equal(usageChunk.usage.completion_tokens, 7)
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 6)
  assert.equal(usage.outputTokens, 7)
  assert.equal(framesOf(out).pop().data, '[DONE]')
})

test('gemini -> chat stream: a cumulative snapshot is not forwarded twice', () => {
  const stream = sse([
    { data: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hel' }] }, index: 0 }], modelVersion: 'gemini-2.5-pro', responseId: 'r1' }) },
    // A snapshot restating everything so far, which must contribute only 'lo'.
    { data: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, index: 0 }] }) },
    { data: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } }) },
  ])
  const { out, usage, finishReason } = bridgeAll('gemini', 'chat', stream)
  const chunks = payloadsOf(out)
  assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join(''), 'hello')
  assert.equal(finishReason, 'tool_calls')
  const toolFrames = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls !== undefined)
  assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].id, 'call_f_0')
  assert.equal(
    toolFrames.map((chunk) => chunk.choices[0].delta.tool_calls[0].function?.arguments ?? '').join(''),
    '{"a":1}',
  )
  assert.equal(usage.inputTokens, 4)
  assert.equal(framesOf(out).pop().data, '[DONE]')
})

// ------------------------------------------------------------ streaming: chat -> *

const chunk = (payload) => ({ data: JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', ...payload }) })

const CHAT_STREAM = sse([
  chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'He' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
  { data: '[DONE]' },
])

test('chat -> responses stream: the full bracketed event order with one shared output_index', () => {
  const { out, usage, finishReason } = bridgeAll('chat', 'responses', CHAT_STREAM)
  const events = payloadsOf(out)
  assert.equal(finishReason, 'tool_calls')
  // Responses streams never carry the OpenAI sentinel; the terminal event is the end.
  assert.equal(out.includes('[DONE]'), false)

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ],
  )
  // The `event:` line always repeats the payload's `type`.
  for (const event of events) {
    assert.equal(event._event, event.type)
  }
  // `sequence_number` is one monotonic counter over the whole stream, starting at 0.
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))

  // One `output_index` counter shared by the reasoning, message and call items.
  assert.equal(events[2].item.type, 'reasoning')
  assert.equal(events[2].output_index, 0)
  assert.equal(events[8].item.type, 'message')
  assert.equal(events[8].output_index, 1)
  assert.equal(events[15].item.type, 'function_call')
  assert.equal(events[15].output_index, 2)
  assert.equal(events[15].item.call_id, 'call_1')
  assert.equal(events[15].item.name, 'shell')
  assert.equal(events[15].item.status, 'in_progress')

  assert.equal(byType(events, 'response.reasoning_summary_text.done').text, 'thinking')
  assert.equal(byType(events, 'response.output_text.done').text, 'Hello')
  assert.equal(byType(events, 'response.function_call_arguments.done').arguments, '{"cmd":"ls"}')
  assert.deepEqual(
    allOfType(events, 'response.output_text.delta').map((event) => event.delta),
    ['He', 'llo'],
  )
  // The reasoning bracket is summary-indexed, and its item_id is stable across it.
  const summaryPart = byType(events, 'response.reasoning_summary_part.added')
  assert.equal(summaryPart.summary_index, 0)
  assert.deepEqual(summaryPart.part, { type: 'summary_text', text: '' })
  assert.equal(summaryPart.item_id, events[2].item.id)
  assert.match(summaryPart.item_id, /^rs_/)
  for (const name of ['response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']) {
    assert.equal(byType(events, name).summary_index, 0, name)
    assert.equal(byType(events, name).item_id, summaryPart.item_id, name)
  }
  assert.deepEqual(byType(events, 'response.reasoning_summary_part.done').part, { type: 'summary_text', text: 'thinking' })
  assert.deepEqual(events[7].item.summary, [{ type: 'summary_text', text: 'thinking' }])
  // Item ids stay stable across a bracket, and only content_part carries content_index.
  const message = byType(events, 'response.content_part.added')
  assert.equal(message.content_index, 0)
  assert.deepEqual(message.part, { type: 'output_text', text: '', annotations: [], logprobs: [] })
  assert.equal(byType(events, 'response.output_text.delta').item_id, message.item_id)
  assert.equal(byType(events, 'response.function_call_arguments.delta').content_index, undefined)

  // The terminal event restates the whole response, and usage arrived after the chat
  // finish chunk — it still has to land inside it or Codex reports a free turn.
  const done = byType(events, 'response.completed')
  assert.equal(done.response.status, 'completed')
  assert.equal(done.response.usage.input_tokens, 9)
  assert.equal(done.response.usage.output_tokens, 4)
  assert.equal(done.response.usage.total_tokens, 13)
  assert.deepEqual(done.response.output.map((item) => item.type), ['reasoning', 'message', 'function_call'])
  assert.equal(done.response.output[1].content[0].text, 'Hello')
  assert.equal(done.response.output[2].arguments, '{"cmd":"ls"}')
  assert.equal(done.response.output[2].status, 'completed')
  assert.equal(usage.inputTokens, 9)
})

test('chat -> responses stream: a length finish becomes response.incomplete', () => {
  const stream = sse([
    chunk({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
    { data: '[DONE]' },
  ])
  const events = payloadsOf(bridgeAll('chat', 'responses', stream).out)
  const done = events[events.length - 1]
  assert.equal(done.type, 'response.incomplete')
  assert.equal(done.response.status, 'incomplete')
  assert.deepEqual(done.response.incomplete_details, { reason: 'max_output_tokens' })
})

test('chat -> anthropic stream: message_start, one block per kind, and no [DONE]', () => {
  const { out, finishReason } = bridgeAll('chat', 'anthropic', CHAT_STREAM)
  const events = payloadsOf(out)
  assert.equal(finishReason, 'tool_calls')
  // The Anthropic SDK throws on an unparseable event, so the sentinel must not appear.
  assert.equal(out.includes('[DONE]'), false)

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  for (const event of events) {
    assert.equal(event._event, event.type)
  }
  const startMessage = events[0].message
  assert.equal(startMessage.id, 'chatcmpl-1')
  assert.equal(startMessage.model, 'deepseek-chat')
  assert.deepEqual(startMessage.content, [])
  assert.equal(startMessage.stop_reason, null)

  // Contiguous block indices across thinking, text and tool_use, closed before reopening.
  assert.deepEqual(events.filter((event) => event.type === 'content_block_start').map((event) => event.index), [0, 1, 2])
  assert.equal(events[1].content_block.type, 'thinking')
  assert.equal(events[2].delta.type, 'thinking_delta')
  assert.equal(events[2].delta.thinking, 'thinking')
  assert.equal(events[4].content_block.type, 'text')
  assert.deepEqual(events.slice(5, 7).map((event) => event.delta.text), ['He', 'llo'])
  assert.deepEqual(events[8].content_block, { type: 'tool_use', id: 'call_1', name: 'shell', input: {} })
  assert.deepEqual(events.slice(9, 11).map((event) => event.delta.partial_json), ['{"cmd":', '"ls"}'])
  assert.equal(events[9].delta.type, 'input_json_delta')

  const messageDelta = events[12]
  assert.deepEqual(messageDelta.delta, { stop_reason: 'tool_use', stop_sequence: null })
  // Usage arrived after the chat finish chunk and still reaches message_delta.
  assert.equal(messageDelta.usage.input_tokens, 9)
  assert.equal(messageDelta.usage.output_tokens, 4)
})

test('chat -> gemini stream: bare data frames, whole function calls, usage on the last one', () => {
  const { out, finishReason } = bridgeAll('chat', 'gemini', CHAT_STREAM)
  const frames = framesOf(out)
  assert.equal(finishReason, 'tool_calls')
  // Gemini names no events and sends no sentinel.
  assert.equal(frames.every((item) => item.event === null), true)
  assert.equal(out.includes('[DONE]'), false)

  const payloads = frames.map((item) => JSON.parse(item.data))
  const parts = payloads.flatMap((item) => item.candidates?.[0]?.content?.parts ?? [])
  assert.deepEqual(parts.filter((part) => part.thought === true).map((part) => part.text), ['thinking'])
  assert.equal(parts.filter((part) => part.text !== undefined && part.thought === undefined).map((part) => part.text).join(''), 'Hello')
  // Gemini has no partial-arguments frame, so the call is held until it is complete.
  const calls = parts.filter((part) => part.functionCall !== undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].functionCall, { name: 'shell', args: { cmd: 'ls' } })

  const last = payloads[payloads.length - 1]
  assert.equal(last.candidates[0].finishReason, 'STOP')
  assert.equal(last.usageMetadata.promptTokenCount, 9)
  assert.equal(last.usageMetadata.totalTokenCount, 13)
})

test('a stream that dies without a terminal event is still closed off for the client', () => {
  const truncated = sse([chunk({ choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] })])
  const chatOut = bridgeAll('chat', 'anthropic', truncated).out
  assert.equal(payloadsOf(chatOut).pop().type, 'message_stop')
  const responsesOut = bridgeAll('chat', 'responses', truncated).out
  assert.equal(payloadsOf(responsesOut).pop().type, 'response.completed')
  const geminiToChat = bridgeAll('gemini', 'chat', sse([{ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) }])).out
  assert.equal(framesOf(geminiToChat).pop().data, '[DONE]')
})

test('an upstream error body is forwarded untranslated so failover can still read it', () => {
  const body = { error: { message: 'no credit', type: 'insufficient_quota', code: 'billing' } }
  assert.equal(translateResponse({ from: 'chat', to: 'anthropic', body }).body, body)
  assert.equal(translateResponse({ from: 'anthropic', to: 'responses', body }).body, body)
  // A real turn that merely has a null `error` slot is still translated.
  const ok = { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], error: null }
  assert.equal(translateResponse({ from: 'chat', to: 'anthropic', body: ok }).body.type, 'message')
})

test('a malformed body is a bridge.invalid_response, not a crash', () => {
  for (const from of PROTOCOLS) {
    assert.throws(
      () => translateResponse({ from, to: from === 'chat' ? 'anthropic' : 'chat', body: 'not json at all' }),
      (error) => error.code === 'bridge.invalid_response',
      `${from} rejects a non-object body`,
    )
  }
  // A chat body with no choices cannot be rendered as anything.
  assert.throws(
    () => translateResponse({ from: 'chat', to: 'anthropic', body: { id: 'x' } }),
    (error) => error.code === 'bridge.invalid_response' && error.details === 'choices',
  )
})

test('a malformed request is a bridge.invalid_request naming the field', () => {
  assert.throws(
    () => buildUpstreamRequest({ from: 'chat', to: 'anthropic', body: { model: 'm' } }),
    (error) => error.code === 'bridge.invalid_request' && error.details === 'messages',
  )
  assert.throws(
    () => buildUpstreamRequest({ from: 'anthropic', to: 'chat', body: { model: 'm', max_tokens: 1 } }),
    (error) => error.code === 'bridge.invalid_request' && error.details === 'messages',
  )
  // A Responses function_call with no call_id can never be paired with its result.
  assert.throws(
    () => buildUpstreamRequest({ from: 'responses', to: 'chat', body: { model: 'm', input: [{ type: 'function_call', name: 'f' }] } }),
    (error) => error.code === 'bridge.invalid_request' && error.details === 'call_id',
  )
  // Gemini keeps its model in the URL, so a hop with neither is unroutable.
  assert.throws(
    () => buildUpstreamRequest({ from: 'chat', to: 'gemini', body: { model: '', messages: [] } }),
    (error) => error.code === 'bridge.invalid_request' && error.details === 'model',
  )
})

test('a bridge push may legitimately return nothing yet', () => {
  const bridge = createStreamBridge({ from: 'chat', to: 'responses' })
  // Half a frame is not a frame.
  assert.equal(bridge.push('data: {"id":"x","choices":[{"delta":'), '')
  assert.equal(bridge.finishReason(), null)
})

// -------------------------------------------------------------------- the full 4x4

const TOOL_BY_PROTOCOL = {
  chat: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
  responses: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }],
  anthropic: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
  gemini: [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }] }],
}

const REQUEST_BY_PROTOCOL = {
  chat: { model: 'local', messages: [{ role: 'user', content: 'hi' }], tools: TOOL_BY_PROTOCOL.chat, stream: true },
  responses: { model: 'local', input: 'hi', tools: TOOL_BY_PROTOCOL.responses, stream: true },
  anthropic: { model: 'local', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: TOOL_BY_PROTOCOL.anthropic, stream: true },
  gemini: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: TOOL_BY_PROTOCOL.gemini },
}

const RESPONSE_BY_PROTOCOL = {
  chat: CHAT_RESPONSE,
  responses: {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'up',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  },
  anthropic: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'up',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  },
  gemini: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    modelVersion: 'up',
  },
}

const GEMINI_STREAM = sse([
  { data: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 }], modelVersion: 'up', responseId: 'r1' }) },
  { data: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }) },
])

const STREAM_BY_PROTOCOL = {
  chat: CHAT_STREAM,
  responses: RESPONSES_STREAM,
  anthropic: ANTHROPIC_STREAM,
  gemini: GEMINI_STREAM,
}

/** What a rendered request must look like to be that protocol at all. */
const REQUEST_SHAPE = {
  chat: (hop) => {
    assert.equal(hop.path, '/chat/completions')
    assert.ok(Array.isArray(hop.body.messages) && hop.body.messages.length > 0)
    assert.equal(hop.body.tools[0].function.name, 'f')
  },
  responses: (hop) => {
    assert.equal(hop.path, '/responses')
    assert.ok(Array.isArray(hop.body.input) && hop.body.input.length > 0)
    assert.equal(hop.body.tools[0].name, 'f')
    assert.equal(hop.body.messages, undefined)
  },
  anthropic: (hop) => {
    assert.equal(hop.path, '/messages')
    assert.equal(typeof hop.body.max_tokens, 'number')
    assert.ok(Array.isArray(hop.body.messages) && hop.body.messages.length > 0)
    assert.equal(hop.body.tools[0].input_schema.type, 'object')
  },
  gemini: (hop) => {
    assert.match(hop.path, /^\/models\/up:(stream)?[Gg]enerateContent/)
    assert.ok(Array.isArray(hop.body.contents) && hop.body.contents.length > 0)
    assert.equal(hop.body.tools[0].functionDeclarations[0].name, 'f')
    assert.equal(hop.body.model, undefined)
  },
}

/** What a rendered non-streaming response must look like. */
const RESPONSE_SHAPE = {
  chat: (body) => {
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.role, 'assistant')
  },
  responses: (body) => {
    assert.equal(body.object, 'response')
    assert.ok(Array.isArray(body.output))
  },
  anthropic: (body) => {
    assert.equal(body.type, 'message')
    assert.ok(Array.isArray(body.content))
    assert.equal(typeof body.stop_reason, 'string')
  },
  gemini: (body) => {
    assert.ok(Array.isArray(body.candidates))
    assert.equal(body.candidates[0].content.role, 'model')
  },
}

/** What the last frame of a rendered stream must be. */
const STREAM_TAIL = {
  chat: (out) => assert.equal(framesOf(out).pop().data, '[DONE]'),
  responses: (out) => assert.match(payloadsOf(out).pop().type, /^response\.(completed|incomplete|failed)$/),
  anthropic: (out) => assert.equal(payloadsOf(out).pop().type, 'message_stop'),
  gemini: (out) => {
    const frames = framesOf(out)
    assert.equal(frames.every((frame) => frame.event === null), true)
    assert.equal(typeof JSON.parse(frames.pop().data).candidates[0].finishReason, 'string')
  },
}

for (const from of PROTOCOLS) {
  for (const to of PROTOCOLS) {
    test(`${from} -> ${to}: request, response and stream all render as ${to}`, () => {
      const hop = buildUpstreamRequest({
        from,
        to,
        body: REQUEST_BY_PROTOCOL[from],
        model: 'up',
        path: from === 'gemini' ? '/v1beta/models/local:streamGenerateContent?alt=sse' : undefined,
      })
      if (from === to) {
        // The diagonal is a passthrough, so only the model and the path are checked.
        assert.equal(typeof hop.path, 'string')
      } else {
        REQUEST_SHAPE[to](hop)
      }

      // The response travels the other way: `to` is now the upstream, `from` the client.
      const translated = translateResponse({ from: to, to: from, body: RESPONSE_BY_PROTOCOL[to], canon: hop.canon })
      if (from === to) {
        assert.equal(translated.body, RESPONSE_BY_PROTOCOL[to])
      } else {
        RESPONSE_SHAPE[from](translated.body)
      }

      const streamed = bridgeAll(to, from, STREAM_BY_PROTOCOL[to])
      if (from === to) {
        assert.equal(streamed.out, STREAM_BY_PROTOCOL[to])
      } else {
        STREAM_TAIL[from](streamed.out)
        assert.equal(typeof streamed.finishReason, 'string')
        assert.ok(streamed.usage.inputTokens >= 0)
      }
    })
  }
}

