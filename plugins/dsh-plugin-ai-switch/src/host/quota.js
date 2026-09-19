/**
 * Vendor quota and relay-balance probes live here so one unreachable account is
 * represented as an outcome, never allowed to abort a platform-wide refresh.
 *
 * @module dsh-plugin-ai-switch/host/quota
 */
import { createPrivateKey, sign } from 'node:crypto'

import { nowIso } from '../shared/protocol.js'
import { capabilityFor, tryParsePlatform } from './platforms.js'

const QUOTA_TIMEOUT_MS = 20_000
const BALANCE_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MS = 6_000
const DEFAULT_NEW_API_DIVISOR = 500_000
const XAI_CLIENT_ID = 'xai-grok-cli'

/** Labels emitted by the six official vendor endpoint candidates. */
export const QUOTA_SOURCES = [
  'codex.config_usage',
  'claude.oauth_usage',
  'claude.web_oauth_usage',
  'grok.usage',
  'grok.me',
  'grok.api_usage',
]

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseObject(text, label) {
  try {
    const parsed = JSON.parse(String(text ?? '{}'))
    if (object(parsed) !== null) return parsed
  } catch {
    // Uniform message below avoids reflecting plaintext secrets from malformed JSON.
  }
  throw new Error(`${label} JSON must be an object`)
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numeric(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isFinite(number) ? number : null
}

function integer(value) {
  const number = numeric(value)
  return number === null ? null : Math.round(number)
}

/** Walk `data.plans.0.remaining`; prototype-bearing path segments are refused. */
export function pickJsonPath(value, path) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw.length === 0) return undefined
  let current = value
  for (const segment of raw.split('.').map((part) => part.trim())) {
    if (segment.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(segment)) return undefined
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
    } else if (object(current) !== null && Object.hasOwn(current, segment)) {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

/** Normalize the persisted relay query block, or null when querying is off. */
export function normalizeRelayConfig(config) {
  const root = object(config) ?? {}
  const raw = object(root.relay_balance) ?? (root.provider !== undefined ? root : null)
  if (raw === null) return null
  const aliases = { newapi: 'new_api', 'new-api': 'new_api', sub_2_api: 'sub2api' }
  const providerRaw = String(raw.provider ?? '').trim().toLowerCase()
  const provider = aliases[providerRaw] ?? providerRaw
  if (provider.length === 0 || provider === 'none') return null
  if (!['new_api', 'sub2api', 'custom'].includes(provider)) throw new Error('relay_balance.provider is not supported')
  const divisor = raw.divisor === undefined || raw.divisor === null || raw.divisor === '' ? null : numeric(raw.divisor)
  if (divisor !== null && divisor <= 0) throw new Error('relay_balance.divisor must be a positive number')
  const normalized = {
    provider,
    endpoint: text(raw.endpoint) ?? '',
    remaining_path: text(raw.remaining_path) ?? '',
    used_path: text(raw.used_path) ?? '',
    limit_path: text(raw.limit_path) ?? '',
    plan_path: text(raw.plan_path) ?? '',
    unit: text(raw.unit) ?? '',
    divisor,
  }
  if (provider === 'custom') {
    if (!/^https?:\/\//i.test(normalized.endpoint)) throw new Error('custom relay balance needs an HTTP endpoint')
    if (normalized.remaining_path.length === 0) throw new Error('custom relay balance needs remaining_path')
    for (const path of [normalized.remaining_path, normalized.used_path, normalized.limit_path, normalized.plan_path]) {
      if (path.length > 256) throw new Error('relay balance JSON path is too long')
    }
  }
  return normalized
}

function fetchFor(deps) {
  return typeof deps?.fetch === 'function' ? deps.fetch : globalThis.fetch
}

function timeoutSignal(milliseconds) {
  return AbortSignal.timeout(milliseconds)
}

async function requestJson(url, init, deps, timeout = QUOTA_TIMEOUT_MS) {
  const response = await fetchFor(deps)(url, { ...init, signal: init?.signal ?? timeoutSignal(timeout) })
  const body = await response.text()
  if (!response.ok) {
    const snippet = body.replace(/\s+/g, ' ').slice(0, 240) || '<empty body>'
    const error = new Error(`HTTP ${response.status}: ${snippet}`)
    error.status = response.status
    throw error
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('Response was not JSON')
  }
}

function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1]
    if (!part) return null
    return object(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function tokenExpired(config, secret) {
  const raw = config.expired ?? config.expires_at ?? config.expiry
  if (typeof raw === 'number') {
    const millis = raw > 10_000_000_000 ? raw : raw * 1000
    return millis <= Date.now() + 60_000
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed <= Date.now() + 60_000
  }
  const exp = numeric(jwtPayload(secret.access_token)?.exp)
  return exp !== null && exp * 1000 <= Date.now() + 60_000
}

function oauthClientId(platform, config, secret) {
  return text(config.client_id)
    ?? text(secret.client_id)
    ?? text(jwtPayload(secret.access_token)?.client_id)
    ?? text(jwtPayload(secret.access_token)?.azp)
    ?? (platform === 'grok' || String(config.token_endpoint ?? '').toLowerCase().includes('x.ai') ? XAI_CLIENT_ID : null)
}

async function maybeRefreshOauth(platform, secret, config, deps) {
  if (text(secret.access_token) !== null && !tokenExpired(config, secret)) return false
  const refreshToken = text(secret.refresh_token)
  const endpoint = text(config.token_endpoint)
  if (refreshToken === null || endpoint === null) return false
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  const clientId = oauthClientId(platform, config, secret)
  if (clientId !== null) form.set('client_id', clientId)
  const value = await requestJson(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }, deps)
  const accessToken = text(value.access_token)
  if (accessToken === null) throw new Error('OAuth refresh response is missing access_token')
  secret.access_token = accessToken
  if (text(value.refresh_token) !== null) secret.refresh_token = value.refresh_token.trim()
  if (text(value.id_token) !== null) secret.id_token = value.id_token.trim()
  if (text(value.token_type) !== null) config.token_type = value.token_type.trim()
  const expiresIn = integer(value.expires_in)
  if (expiresIn !== null) {
    config.expires_in = expiresIn
    config.expired = new Date(Date.now() + expiresIn * 1000).toISOString()
  } else {
    const exp = integer(jwtPayload(accessToken)?.exp)
    if (exp !== null) config.expired = new Date(exp * 1000).toISOString()
  }
  config.last_refresh = nowIso()
  return true
}

function endpointCandidates(platform, config) {
  if (platform === 'codex') {
    const raw = text(config.base_url)
    if (raw === null) {
      return [{ url: 'https://chatgpt.com/backend-api/wham/usage', source: 'codex.config_usage', style: 'codex' }]
    }
    const base = raw.replace(/\/+$/, '')
    const lower = base.toLowerCase()
    let url
    const at = lower.indexOf('/backend-api')
    if (at >= 0) url = `${base.slice(0, at + '/backend-api'.length)}/wham/usage`
    else if (lower.startsWith('https://chatgpt.com') || lower.startsWith('https://chat.openai.com')) url = `${base}/backend-api/wham/usage`
    else url = `${base}/api/codex/usage`
    return [{ url, source: 'codex.config_usage', style: 'codex' }]
  }
  if (platform === 'claude') {
    return [
      { url: 'https://api.anthropic.com/api/oauth/usage', source: 'claude.oauth_usage', style: 'claude' },
      { url: 'https://claude.ai/api/oauth/usage', source: 'claude.web_oauth_usage', style: 'claude' },
    ]
  }
  if (platform === 'grok') {
    const base = (text(config.base_url) ?? 'https://cli-chat-proxy.grok.com/v1').replace(/\/+$/, '')
    const candidates = [
      { url: `${base}/usage`, source: 'grok.usage', style: 'grok' },
      { url: `${base}/me`, source: 'grok.me', style: 'grok' },
    ]
    if (!base.includes('api.x.ai')) candidates.push({ url: 'https://api.x.ai/v1/usage', source: 'grok.api_usage', style: 'grok' })
    return candidates
  }
  return []
}

function agentIdentityAuth(secret, config) {
  const mode = String(secret.auth_mode ?? config.auth_mode ?? config.auth_kind ?? config.raw_type ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
  const privateMaterial = text(secret.agent_private_key)
  if (mode !== 'agentidentity' && privateMaterial === null) return null
  const runtime = text(secret.agent_runtime_id)
  const task = text(secret.task_id)
  const account = text(secret.account_id) ?? text(secret.chatgpt_account_id) ?? text(secret.workspace_id)
  if (privateMaterial === null || runtime === null || task === null || account === null) {
    throw new Error('Agent identity credential is missing a required field')
  }
  let key
  try {
    key = createPrivateKey({ key: Buffer.from(privateMaterial, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    throw new Error('Agent identity private key is invalid')
  }
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const signature = sign(null, Buffer.from(`${runtime}:${task}:${timestamp}`), key).toString('base64')
  const assertion = Buffer.from(JSON.stringify({
    agent_runtime_id: runtime,
    signature,
    task_id: task,
    timestamp,
  })).toString('base64url')
  return {
    authorization: `AgentAssertion ${assertion}`,
    account,
    fedramp: secret.chatgpt_account_is_fedramp === true || secret.is_fedramp_account === true,
  }
}

function quotaHeaders(platform, secret, config, candidate) {
  const identity = platform === 'codex' ? agentIdentityAuth(secret, config) : null
  const headers = { accept: 'application/json', authorization: identity?.authorization ?? `Bearer ${secret.access_token}` }
  if (candidate.style === 'codex') {
    Object.assign(headers, {
      'openai-beta': 'codex-1',
      'oai-language': 'zh-CN',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'empty',
      priority: 'u=4, i',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.1.0',
    })
    const account = identity?.account ?? text(secret.account_id) ?? text(secret.chatgpt_account_id) ?? text(secret.workspace_id)
    if (account !== null) headers['chatgpt-account-id'] = account
    if (identity !== null) {
      headers.originator = 'Codex Desktop'
      headers['user-agent'] = 'Codex Desktop/0.1.0'
      if (identity.fedramp) headers['x-openai-fedramp'] = 'true'
    }
  } else if (candidate.style === 'claude') {
    headers['anthropic-beta'] = 'oauth-2025-04-20'
    headers['user-agent'] = 'ai-switch/0.1'
  } else if (candidate.style === 'grok') {
    Object.assign(headers, {
      'user-agent': 'grok-cli',
      'x-client-name': 'grok-cli',
      'x-app-version': '0.2.93',
      'x-token-auth': 'xai-grok-cli',
    })
  }
  return headers
}

function field(value, keys) {
  for (const key of keys) {
    if (object(value) !== null && Object.hasOwn(value, key)) return value[key]
  }
  return undefined
}

function timeValue(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  const number = numeric(value)
  if (number === null) return null
  return new Date((number > 10_000_000_000 ? number : number * 1000)).toISOString()
}

function windowRemain(value) {
  if (object(value) === null) return null
  const limit = integer(field(value, ['limit', 'allowed', 'quota', 'max', 'total']))
  const used = integer(field(value, ['used', 'usage', 'consumed']))
  let remain = integer(field(value, ['remaining', 'remain', 'left', 'remaining_percent', 'remainingPercent', 'tokens_remaining', 'remaining_tokens']))
  if (remain === null && limit !== null && used !== null) remain = Math.max(limit - used, 0)
  if (remain === null) {
    const utilization = numeric(field(value, ['used_percent', 'usedPercent', 'utilization', 'utilized', 'percent_used']))
    if (utilization !== null) remain = Math.round(Math.max(0, Math.min(100, 100 - (utilization <= 1 ? utilization * 100 : utilization))))
  }
  const resetAt = timeValue(field(value, ['reset_at', 'resetAt', 'resets_at', 'resetsAt', 'reset_time', 'resetTime', 'expires_at', 'expiresAt']))
  return remain === null && limit === null && used === null && resetAt === null ? null : { remain, limit, used, resetAt }
}

function subscription(value) {
  return text(field(value, ['subscription_type', 'subscriptionType', 'plan', 'plan_type', 'planType', 'tier']))
    ?? text(value?.subscription?.type)
    ?? text(value?.account?.plan)
}

function mergeWindows(primary, weekly, subscriptionType) {
  return {
    subscription_type: subscriptionType,
    primary_remain: primary?.remain ?? null,
    weekly_remain: weekly?.remain ?? null,
    reset_primary: primary?.resetAt ?? null,
    reset_weekly: weekly?.resetAt ?? null,
    quota_remaining: primary?.remain ?? null,
    quota_limit: primary?.limit ?? null,
    quota_used: primary?.used ?? null,
  }
}

function parseCodex(value) {
  if (object(value?.rate_limits) !== null) return parseCodex(value.rate_limits)
  if (object(value?.rateLimits) !== null) return parseCodex(value.rateLimits)
  const type = subscription(value)
  const rate = object(value?.rate_limit) ?? object(value?.rateLimit)
  if (rate !== null) {
    const primary = windowRemain(rate.primary_window ?? rate.primaryWindow ?? rate.five_hour ?? rate.fiveHour)
    const weekly = windowRemain(rate.secondary_window ?? rate.secondaryWindow ?? rate.weekly ?? rate.seven_day ?? rate.sevenDay)
    if (primary || weekly) return mergeWindows(primary, weekly, type)
    if (rate.limit_reached === true || rate.limitReached === true || rate.allowed === false || value.rate_limit_reached_type != null) {
      return mergeWindows({ remain: 0, limit: null, used: null, resetAt: null }, null, type)
    }
  }
  for (const entry of value?.additional_rate_limits ?? value?.additionalRateLimits ?? []) {
    const nested = object(entry?.rate_limit) ?? object(entry?.rateLimit)
    if (nested === null) continue
    const primary = windowRemain(nested.primary_window ?? nested.primaryWindow)
    const weekly = windowRemain(nested.secondary_window ?? nested.secondaryWindow)
    if (primary || weekly) return mergeWindows(primary, weekly, type)
  }
  const primary = windowRemain(value?.five_hour ?? value?.fiveHour ?? value?.primary_window ?? value?.primaryWindow)
  const weekly = windowRemain(value?.weekly ?? value?.seven_day ?? value?.sevenDay ?? value?.secondary_window ?? value?.secondaryWindow)
  if (primary || weekly) return mergeWindows(primary, weekly, type)
  if (value?.spend_control?.reached === true || value?.spendControl?.reached === true) return mergeWindows({ remain: 0 }, null, type)
  return null
}

function parseClaude(value) {
  const primary = windowRemain(value?.five_hour ?? value?.fiveHour ?? value?.rate_limit?.five_hour ?? value?.rateLimit?.fiveHour)
  const weekly = windowRemain(value?.seven_day ?? value?.sevenDay ?? value?.weekly ?? value?.rate_limit?.seven_day ?? value?.rateLimit?.sevenDay)
  if (primary || weekly) return mergeWindows(primary, weekly, subscription(value))
  return object(value?.usage) === null ? null : parseClaude(value.usage)
}

function parseGrok(value) {
  const codex = parseCodex(value)
  if (codex !== null) return codex
  const type = subscription(value)
  const firstInt = (keys) => {
    for (const key of keys) {
      const found = integer(value?.[key])
      if (found !== null) return found
    }
    return null
  }
  let remaining = firstInt(['primary_remain', 'quota_remaining', 'remaining', 'remaining_tokens', 'tokens_remaining'])
  const used = firstInt(['quota_used', 'used', 'tokens_used', 'actual'])
  const limit = firstInt(['quota_limit', 'limit', 'tokens_limit'])
  if (remaining === null && used !== null && limit !== null) remaining = Math.max(limit - used, 0)
  const weekly = firstInt(['weekly_remain', 'weekly_remaining'])
  if (remaining === null && weekly === null && type === null) return null
  return {
    subscription_type: type,
    primary_remain: remaining,
    weekly_remain: weekly,
    reset_primary: timeValue(field(value, ['reset_primary', 'resets_at', 'reset_at', 'resetAt', 'expires_at'])),
    reset_weekly: timeValue(field(value, ['reset_weekly', 'weekly_reset_at', 'weeklyResetAt'])),
    quota_remaining: remaining,
    quota_limit: limit,
    quota_used: used,
  }
}

function applyQuota(config, snapshot) {
  const keys = ['subscription_type', 'primary_remain', 'weekly_remain', 'reset_primary', 'reset_weekly', 'quota_remaining', 'quota_limit', 'quota_used']
  for (const key of keys) {
    if (snapshot[key] !== null && snapshot[key] !== undefined) config[key] = snapshot[key]
  }
  if (snapshot.primary_remain !== null && snapshot.primary_remain !== undefined) config.quota_remaining = snapshot.primary_remain
  else if (snapshot.quota_remaining !== null && snapshot.quota_remaining !== undefined) config.primary_remain = snapshot.quota_remaining
  config.quota_updated_at = nowIso()
  if (!config.reset_primary && snapshot.primary_remain !== null) config.reset_primary = config.quota_updated_at
}

async function persistRow(row, secret, config, deps) {
  if (typeof deps?.accounts?.update !== 'function') throw new Error('Account service update path is unavailable')
  return deps.accounts.update(row.id, {
    display_name: row.display_name,
    email: row.email ?? null,
    status: row.status,
    route_priority: row.route_priority,
    max_concurrency: row.max_concurrency,
    secret_payload_json: JSON.stringify(secret),
    config_json: JSON.stringify(config),
    preview_json: row.preview_json ?? '{}',
  })
}

/** Refresh one official account; all per-account failures become source `error`. */
export async function refreshQuota(row, deps) {
  try {
    if (row?.kind !== 'official') return { credential: row, updated: false, source: 'skipped', message: 'Only official accounts support quota refresh' }
    const platform = tryParsePlatform(row.platform)
    if (platform === null || capabilityFor(platform, 'official_quota').availability === 'unavailable') {
      return { credential: row, updated: false, source: 'skipped', message: 'Official quota is unavailable for this platform' }
    }
    const secret = parseObject(row.secret_payload_json, 'Credential secret')
    const config = parseObject(row.config_json, 'Credential config')
    const refreshed = await maybeRefreshOauth(platform, secret, config, deps)
    const identity = platform === 'codex' ? agentIdentityAuth(secret, config) : null
    const accessToken = text(secret.access_token)
    if (accessToken === null && identity === null) throw new Error('Official account is missing quota authentication')
    const diagnostics = []
    for (const candidate of endpointCandidates(platform, config)) {
      try {
        const value = await requestJson(candidate.url, { headers: quotaHeaders(platform, secret, config, candidate) }, deps)
        const snapshot = candidate.style === 'codex' ? parseCodex(value) : candidate.style === 'claude' ? parseClaude(value) : parseGrok(value)
        if (snapshot === null) throw new Error('Response contained no supported quota fields')
        const before = JSON.stringify(config)
        applyQuota(config, snapshot)
        const credential = await persistRow(row, secret, config, deps)
        return { credential, updated: refreshed || before !== JSON.stringify(config), source: candidate.source, message: null }
      } catch (error) {
        if ([404, 405].includes(error?.status)) continue
        diagnostics.push(`${candidate.source}: ${String(error?.message ?? error)}`)
      }
    }
    if (refreshed) {
      const credential = await persistRow(row, secret, config, deps)
      return { credential, updated: true, source: 'none', message: diagnostics.join(' | ') || 'No quota endpoint returned usable data' }
    }
    return { credential: row, updated: false, source: 'none', message: diagnostics.join(' | ') || 'No quota endpoint returned usable data' }
  } catch (error) {
    return { credential: row, updated: false, source: 'error', message: String(error?.message ?? error) }
  }
}

function panelRoots(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (base.length === 0) return []
  const lower = base.toLowerCase()
  const roots = []
  for (const suffix of ['/openai/v1', '/v1beta', '/v1']) {
    if (lower.endsWith(suffix)) {
      roots.push(base.slice(0, -suffix.length))
      break
    }
  }
  roots.push(base)
  return [...new Set(roots.filter(Boolean))]
}

function relayHeaders(apiKey, interfaceFormat, userAgent) {
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    authorization: `Bearer ${apiKey}`,
    'user-agent': userAgent ?? 'ai-switch/0.1',
  }
  if (interfaceFormat === 'anthropic') headers['x-api-key'] = apiKey
  return headers
}

async function candidateJson(urls, headers, deps) {
  const failures = []
  for (const url of urls) {
    try {
      return { url, body: await requestJson(url, { headers }, deps, BALANCE_TIMEOUT_MS) }
    } catch (error) {
      failures.push(`${url}: ${String(error?.message ?? error)}`)
      if (![404, 405].includes(error?.status) && error?.status !== undefined) throw error
    }
  }
  throw new Error(failures.join(' | ') || 'No balance endpoint could be derived')
}

function checkedAt() {
  return nowIso()
}

async function newApiDivisor(config, root, deps) {
  if (config.divisor !== null) return config.divisor
  try {
    const body = await requestJson(`${root}/api/status`, { headers: { accept: 'application/json' } }, deps, STATUS_TIMEOUT_MS)
    const value = numeric(body?.data?.quota_per_unit)
    if (value !== null && value > 0) return value
  } catch {
    // Status is optional; the panel's documented default remains usable.
  }
  return DEFAULT_NEW_API_DIVISOR
}

async function fetchNewApi(config, request, deps) {
  const suffix = '/api/usage/token/'
  const urls = panelRoots(request.baseUrl).map((root) => `${root}${suffix}`)
  const { url, body } = await candidateJson(urls, request.headers, deps)
  const ok = typeof body.code === 'boolean' ? body.code : typeof body.success === 'boolean' ? body.success : true
  if (!ok) throw new Error(`Panel rejected balance query: ${text(body.message) ?? 'unknown error'}`)
  const data = object(body.data)
  if (data === null) throw new Error('Panel response has no data object')
  const unlimited = data.unlimited_quota === true
  const available = numeric(data.total_available)
  const used = numeric(data.total_used)
  const granted = numeric(data.total_granted)
  if (!unlimited && available === null && used === null) throw new Error('Panel response has no usable quota fields')
  const root = url.slice(0, -suffix.length)
  const divisor = await newApiDivisor(config, root, deps)
  return {
    provider: 'new_api',
    plan_name: null,
    remaining: unlimited ? null : available === null ? null : available / divisor,
    used: used === null ? null : used / divisor,
    limit: unlimited ? null : granted === null ? null : granted / divisor,
    unit: 'USD',
    unlimited,
    account_level: false,
    expires_at: numeric(data.expires_at) > 0 ? new Date(Number(data.expires_at) * 1000).toISOString() : null,
    source_url: url,
    checked_at: checkedAt(),
    notes: text(data.name) === null ? [] : [`令牌 ${data.name.trim()}`],
  }
}

function sub2Notes(body, unit) {
  const notes = []
  for (const window of Array.isArray(body.rate_limits) ? body.rate_limits : []) {
    const remaining = numeric(window?.remaining)
    const limit = numeric(window?.limit)
    if (remaining !== null) notes.push(`${text(window.window) ?? '窗口'} 窗口剩余 ${remaining}${limit === null ? '' : `/${limit}`}`)
  }
  const subscription = object(body.subscription)
  if (subscription !== null) {
    for (const [label, usedKey, limitKey] of [['日', 'daily_usage_usd', 'daily_limit_usd'], ['周', 'weekly_usage_usd', 'weekly_limit_usd'], ['月', 'monthly_usage_usd', 'monthly_limit_usd']]) {
      const limit = numeric(subscription[limitKey])
      if (limit !== null && limit > 0) notes.push(`${label}用量 ${(numeric(subscription[usedKey]) ?? 0).toFixed(2)}/${limit.toFixed(2)} ${unit}`)
    }
  }
  return notes
}

async function fetchSub2Api(request, deps) {
  const roots = panelRoots(request.baseUrl)
  const urls = [...roots.map((root) => `${root}/v1/usage`), `${request.baseUrl.replace(/\/+$/, '')}/usage`]
  const { url, body } = await candidateJson([...new Set(urls)], request.headers, deps)
  if (body.isValid === false) throw new Error(`Panel rejected balance query: ${text(body.invalidMessage) ?? text(body.message) ?? 'invalid key'}`)
  const quota = object(body.quota)
  const remaining = numeric(body.remaining) ?? numeric(quota?.remaining) ?? numeric(body.balance)
  const used = numeric(quota?.used)
  const limit = numeric(quota?.limit)
  const mode = text(body.mode) ?? ''
  const unlimited = mode === 'unrestricted' && remaining === null && limit === null
  if (remaining === null && used === null && !unlimited) throw new Error('Response contains no usable balance fields')
  const unit = text(body.unit) ?? text(quota?.unit) ?? 'USD'
  return {
    provider: 'sub2api',
    plan_name: text(body.planName),
    remaining,
    used,
    limit,
    unit,
    unlimited,
    account_level: false,
    expires_at: text(body.expires_at),
    source_url: url,
    checked_at: checkedAt(),
    notes: sub2Notes(body, unit),
  }
}

async function fetchCustom(config, request, deps) {
  const { url, body } = await candidateJson([config.endpoint], request.headers, deps)
  const remaining = numeric(pickJsonPath(body, config.remaining_path))
  if (remaining === null) throw new Error(`Response path ${config.remaining_path} is not numeric`)
  const divisor = config.divisor ?? 1
  const plan = pickJsonPath(body, config.plan_path)
  return {
    provider: 'custom',
    plan_name: typeof plan === 'string' || typeof plan === 'number' ? String(plan).trim() || null : null,
    remaining: remaining / divisor,
    used: numeric(pickJsonPath(body, config.used_path)) === null ? null : numeric(pickJsonPath(body, config.used_path)) / divisor,
    limit: numeric(pickJsonPath(body, config.limit_path)) === null ? null : numeric(pickJsonPath(body, config.limit_path)) / divisor,
    unit: config.unit || 'USD',
    unlimited: false,
    account_level: false,
    expires_at: null,
    source_url: url,
    checked_at: checkedAt(),
    notes: divisor === 1 ? [] : [`额度换算 手填 ${divisor}`],
  }
}

function snapshotChanged(previous, next) {
  return ['remaining', 'used', 'limit', 'unlimited', 'account_level'].some((key) => previous?.[key] !== next?.[key])
}

/** Refresh one API relay balance; all per-account failures become source `error`. */
export async function refreshRelayBalance(row, deps) {
  try {
    if (row?.kind !== 'api') return { credential: row, updated: false, source: 'skipped', message: 'Only relay API accounts support balance refresh' }
    const configRoot = parseObject(row.config_json, 'Credential config')
    const config = normalizeRelayConfig(configRoot)
    if (config === null) return { credential: row, updated: false, source: 'skipped', message: 'Balance querying is not enabled' }
    const secret = parseObject(row.secret_payload_json, 'Credential secret')
    const apiKey = text(secret.api_key)
    const baseUrl = text(configRoot.base_url)
    if (apiKey === null) throw new Error('Account has no API key for balance query')
    if (baseUrl === null) throw new Error('Account has no Base URL for balance query')
    const request = {
      baseUrl,
      headers: relayHeaders(apiKey, text(configRoot.interface_format) ?? 'openai', text(configRoot.headers?.['User-Agent'])),
    }
    let snapshot
    if (config.provider === 'new_api') snapshot = await fetchNewApi(config, request, deps)
    else if (config.provider === 'sub2api') snapshot = await fetchSub2Api(request, deps)
    else snapshot = await fetchCustom(config, request, deps)
    const changed = snapshotChanged(configRoot.relay_balance_snapshot, snapshot)
    configRoot.relay_balance_snapshot = snapshot
    const credential = await persistRow(row, secret, configRoot, deps)
    return { credential, updated: changed, source: snapshot.provider, message: null }
  } catch (error) {
    return { credential: row, updated: false, source: 'error', message: String(error?.message ?? error) }
  }
}
