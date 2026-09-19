/**
 * Upstream model discovery (`fetch_route_models`).
 *
 * The account form can ask a relay which model ids it serves before the account exists, so
 * this cannot go through the local pool. It is a direct, bounded GET using the same endpoint
 * and credential conventions as the reference: OpenAI/Responses uses `<base>/models`,
 * Anthropic probes `/v1/models` then `/models`, and Gemini probes `/v1beta/models` then
 * `/v1/models` with the key in the query string.
 *
 * Every response is untrusted: a nested `data`/`models`/`items` array is walked, malformed
 * entries are skipped, ids are normalized and deduplicated, and no fetched value is ever
 * evaluated or used as a path.
 *
 * @module dsh-plugin-ai-switch/host/model-fetch
 */
import { requireText, validation } from '../shared/protocol.js'

const TIMEOUT_MS = 15_000
const ERROR_BODY_LIMIT = 512

export async function fetchRouteModels(request, fetchImpl = globalThis.fetch) {
  const baseUrl = requireText(request?.base_url, 'base_url', 2048).replace(/\/+$/, '')
  const apiKey = requireText(request?.api_key, 'api_key', 8192)
  const format = String(request?.interface_format ?? 'openai').trim() || 'openai'
  const candidates = modelListCandidates(baseUrl, format)
  let lastError = null

  for (const rawUrl of candidates) {
    const url = format === 'gemini' ? appendQuery(rawUrl, 'key', apiKey) : rawUrl
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: modelFetchHeaders(apiKey, format, request?.api_key_field),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      lastError = `${rawUrl}: ${String(error?.message ?? error)}`
      continue
    }
    const text = await response.text()
    if (response.ok) {
      let payload
      try {
        payload = JSON.parse(text)
      } catch (error) {
        throw validation(
          'validation.route_models_parse',
          'Could not parse model list response',
          `${String(error?.message ?? error)}; response: ${text.slice(0, ERROR_BODY_LIMIT)}`,
        )
      }
      return normalizeModelsResponse(payload)
    }
    const message = `${rawUrl}: HTTP ${response.status}: ${text.slice(0, ERROR_BODY_LIMIT)}`
    if (response.status === 404 || response.status === 405) {
      lastError = message
      continue
    }
    throw validation('validation.route_models_http', 'Model list request failed', message)
  }

  throw validation('validation.route_models_all_failed', 'All model list endpoints failed', lastError)
}

export function modelListCandidates(baseUrl, format) {
  if (format === 'anthropic') {
    const root = baseUrl.replace(/\/v1$/i, '')
    return Array.from(new Set([`${root}/v1/models`, `${root}/models`]))
  }
  if (format === 'gemini') {
    return /\/v1(?:beta)?$/i.test(baseUrl)
      ? [`${baseUrl}/models`]
      : [`${baseUrl}/v1beta/models`, `${baseUrl}/v1/models`]
  }
  return [`${baseUrl}/models`]
}

export function modelFetchHeaders(apiKey, format, apiKeyField) {
  const headers = { accept: 'application/json', 'accept-encoding': 'identity' }
  if (format === 'gemini') {
    headers['user-agent'] = 'ai-switch/0.1'
    return headers
  }
  if (format === 'anthropic') {
    if (apiKeyField === 'ANTHROPIC_AUTH_TOKEN') {
      headers.authorization = `Bearer ${apiKey}`
    } else if (apiKeyField === undefined || apiKeyField === null || apiKeyField === '' || apiKeyField === 'ANTHROPIC_API_KEY') {
      headers['x-api-key'] = apiKey
    } else {
      throw validation('validation.route_models_headers', 'Unsupported Anthropic API key field', String(apiKeyField))
    }
    headers['anthropic-version'] = '2023-06-01'
    return headers
  }
  headers.authorization = `Bearer ${apiKey}`
  return headers
}

export function normalizeModelsResponse(payload) {
  const rows = []
  appendModels(payload, rows)
  rows.sort((left, right) => left.id.localeCompare(right.id))
  return rows.filter((row, index) => index === 0 || rows[index - 1].id !== row.id)
}

function appendModels(value, rows) {
  if (Array.isArray(value)) {
    for (const item of value) appendModels(item, rows)
    return
  }
  if (typeof value === 'string') {
    const id = normalizeModelId(value)
    if (id) rows.push({ id, owned_by: null, supports_1m: null })
    return
  }
  if (value === null || typeof value !== 'object') return

  let nested = false
  for (const key of ['data', 'models', 'items']) {
    if (value[key] !== undefined) {
      nested = true
      appendModels(value[key], rows)
    }
  }
  if (nested) return

  const idRaw = ['id', 'name', 'model', 'slug'].map((key) => value[key]).find((item) => typeof item === 'string')
  const id = normalizeModelId(idRaw ?? '')
  if (!id) return
  const owned = ['owned_by', 'ownedBy', 'provider', 'display_name', 'displayName']
    .map((key) => value[key])
    .find((item) => typeof item === 'string')
  const oneMillion = value.supports_1m === true || value.supports1m === true ? true : null
  rows.push({ id, owned_by: owned ?? null, supports_1m: oneMillion })
}

function normalizeModelId(value) {
  const text = String(value ?? '').trim()
  return text.startsWith('models/') ? text.slice('models/'.length) : text
}

function appendQuery(url, key, value) {
  const parsed = new URL(url)
  parsed.searchParams.set(key, value)
  return parsed.toString()
}
