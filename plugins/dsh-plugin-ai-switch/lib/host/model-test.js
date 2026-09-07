/**
 * Real model connectivity tests for one account or the pool.
 *
 * The Accounts screen calls this before a user trusts an imported credential. It sends a
 * tiny deterministic prompt (`Reply with exactly: ai-switch-ok`) through the same LOCAL
 * route proxy clients use, then returns both the local entry point and the selected account
 * in the reference's `RoutePoolModelTestOutcome` shape. Going through the proxy matters: a
 * direct upstream probe would prove the key works but not that model mapping, protocol
 * bridging, pool selection and proxy authentication work together.
 *
 * @module dsh-plugin-ai-switch/host/model-test
 */
import { parsePlatform, requireCapability } from './platforms.js'

const PROMPT = 'Reply with exactly: ai-switch-ok'
const TIMEOUT_MS = 45_000

export async function routePoolTestModel(request, { accounts, proxy, keys, fetchImpl = globalThis.fetch }) {
  const platform = parsePlatform(request?.platform)
  requireCapability(platform, 'model_test')
  const started = Date.now()
  const status = proxy.status()
  const running = status.running ? status : await proxy.start()
  const proxyKey = await keys.ensure(platform)

  let selected
  if (typeof request?.account_id === 'string' && request.account_id.trim()) {
    selected = await accounts.requireRow(request.account_id.trim())
    if (selected.platform !== platform) {
      throw new Error(`Account ${selected.id} belongs to ${selected.platform}, not ${platform}`)
    }
  } else {
    selected = await accounts.selectAccount(platform)
  }

  const config = parseObject(selected.config_json)
  const interfaceFormat = normalizeFormat(request?.interface_format, platform, config.interface_format)
  const model = String(request?.model ?? '').trim() || defaultModel(platform)
  const path = entryPath(interfaceFormat, model)
  const body = requestBody(interfaceFormat, model, request?.test_tool_call === true)
  const base = running.base_url.replace(/\/+$/, '')
  const url = `${base}${path}`
  const headers = { 'content-type': 'application/json' }
  if (interfaceFormat === 'anthropic') headers['x-api-key'] = proxyKey
  else if (interfaceFormat === 'gemini') headers['x-goog-api-key'] = proxyKey
  else headers.authorization = `Bearer ${proxyKey}`

  let responseStatus = null
  let responseBody = ''
  let responseText = null
  let errorMessage = null
  let success = false
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    responseStatus = response.status
    responseBody = await response.text()
    responseText = extractText(interfaceFormat, responseBody)
    success = response.ok && typeof responseText === 'string' && responseText.includes('ai-switch-ok')
    if (!success) errorMessage = response.ok ? 'Response did not contain ai-switch-ok' : `HTTP ${response.status}`
  } catch (error) {
    errorMessage = String(error?.message ?? error)
  }

  return {
    platform,
    selected_account_id: selected.id,
    selected_account_name: selected.display_name,
    via_route_proxy: true,
    route_proxy_entry_url: url,
    route_proxy_entry_path: path,
    route_proxy_trace_id: null,
    interface_format: interfaceFormat,
    request_path: path,
    base_url: base,
    target_url: config.base_url ?? null,
    request_body_json: JSON.stringify(body, null, 2),
    response_status: responseStatus,
    response_body: responseBody,
    response_text: responseText,
    error_message: errorMessage,
    success,
    duration_ms: Date.now() - started,
    stats: (await accounts.getPool(platform)).stats,
  }
}

function normalizeFormat(requested, platform, accountFormat) {
  const explicit = String(requested ?? '').trim()
  if (explicit) return explicit
  if (platform === 'codex') return 'openai-responses'
  if (platform === 'claude') return 'anthropic'
  if (platform === 'gemini') return 'gemini'
  return 'openai'
}

function defaultModel(platform) {
  if (platform === 'codex') return 'gpt-5.6-sol'
  if (platform === 'claude') return 'claude-sonnet-alias'
  if (platform === 'gemini') return 'gemini-2.5-flash'
  if (platform === 'grok') return 'grok-4.5'
  return 'default'
}

function entryPath(format, model) {
  if (format === 'openai-responses') return '/v1/responses'
  if (format === 'anthropic') return '/v1/messages'
  if (format === 'gemini') return `/v1beta/models/${encodeURIComponent(model)}:generateContent`
  return '/v1/chat/completions'
}

function requestBody(format, model, toolCall) {
  if (format === 'openai-responses') {
    return { model, input: PROMPT, temperature: 0, max_output_tokens: 16 }
  }
  if (format === 'anthropic') {
    return { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 }
  }
  if (format === 'gemini') {
    return { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { temperature: 0, maxOutputTokens: 16 } }
  }
  const body = { model, messages: [{ role: 'user', content: PROMPT }], temperature: 0, max_tokens: 16 }
  if (toolCall) {
    body.tools = [{ type: 'function', function: { name: 'ai_switch_probe', description: 'Return success', parameters: { type: 'object', properties: {} } } }]
  }
  return body
}

function extractText(format, body) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (format === 'openai-responses') {
    if (typeof value.output_text === 'string') return value.output_text
    return value.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? null
  }
  if (format === 'anthropic') return value.content?.map((part) => part.text ?? '').join('') ?? null
  if (format === 'gemini') return value.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? null
  return value.choices?.[0]?.message?.content ?? null
}

function parseObject(text) {
  try {
    const value = JSON.parse(String(text ?? '{}'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}
