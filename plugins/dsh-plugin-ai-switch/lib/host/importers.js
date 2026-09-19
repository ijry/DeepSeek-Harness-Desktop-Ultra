/**
 * Credential import/export boundaries, kept here so untrusted foreign formats are
 * normalized before they can touch the account store or leak a secret into a DTO.
 *
 * @module dsh-plugin-ai-switch/host/importers
 */
import { createHash } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

import { ApiError, nowIso, requireText, validation } from '../shared/protocol.js'
import {
  buildCredentialRow,
  convertBaseUrl,
  projectCredential,
  validateModelMappings,
} from './accounts.js'
import {
  defaultApiDialect,
  defaultImportDialect,
  parsePlatform,
  requireCapability,
  tryParsePlatform,
} from './platforms.js'
import { userHome, uuid } from './sdk.js'

const TRANSFER_FORMAT = 'ai-switch.route-credential'
const TRANSFER_SCHEMA_VERSION = 1
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ITEMS = 2000
const MAX_ITEM_BYTES = 256 * 1024
const MAX_IDS = 2000
const SOURCE_PREFIX = 'ai-switch-transfer:'
const CPA_SECTIONS = new Set([
  'claude-api-key',
  'gemini-api-key',
  'codex-api-key',
  'xai-api-key',
  'openai-compatibility',
])
const SECTION_TARGET = {
  'claude-api-key': ['claude', 'anthropic'],
  'gemini-api-key': ['gemini', 'gemini'],
  'codex-api-key': ['codex', 'openai-responses'],
  'xai-api-key': ['grok', 'openai'],
}
const APP_TYPES = {
  claude: 'claude',
  'claude-code': 'claude',
  claude_code: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  grok: 'grok',
  xai: 'grok',
  opencode: 'opencode',
  openclaw: 'openclaw',
  hermes: 'hermes',
}
const OFFICIAL_SECRET_FIELDS = [
  ['id_token', ['id_token', 'idToken']],
  ['access_token', ['access_token', 'accessToken']],
  ['refresh_token', ['refresh_token', 'refreshToken']],
  ['account_id', ['account_id', 'accountId']],
  ['workspace_id', ['workspace_id', 'workspaceId']],
  ['chatgpt_account_id', ['chatgpt_account_id', 'chatgptAccountId']],
  ['agent_runtime_id', ['agent_runtime_id', 'agentRuntimeId']],
  ['agent_private_key', ['agent_private_key', 'agentPrivateKey']],
  ['task_id', ['task_id', 'taskId']],
  ['auth_mode', ['auth_mode', 'authMode']],
  ['chatgpt_account_is_fedramp', [
    'chatgpt_account_is_fedramp',
    'chatgptAccountIsFedramp',
    'is_fedramp_account',
    'isFedrampAccount',
  ]],
  ['client_id', ['client_id', 'clientId']],
]
const OFFICIAL_CONFIG_FIELDS = [
  ['last_refresh', ['last_refresh', 'lastRefresh']],
  ['expired', ['expired']],
  ['expires_in', ['expires_in', 'expiresIn']],
  ['disabled', ['disabled']],
  ['base_url', ['base_url', 'baseUrl']],
  ['token_endpoint', ['token_endpoint', 'tokenEndpoint']],
  ['auth_kind', ['auth_kind', 'authKind']],
  ['sub', ['sub']],
  ['token_type', ['token_type', 'tokenType']],
  ['redirect_uri', ['redirect_uri', 'redirectUri']],
  ['headers', ['headers']],
]

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

/** SHA-256 over canonical JSON (object keys recursively sorted). */
export function credentialFingerprint(item) {
  return createHash('sha256').update(JSON.stringify(canonicalize(item))).digest('hex')
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function textAt(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function valueAt(source, keys) {
  for (const key of keys) {
    if (source !== null && source !== undefined && Object.hasOwn(source, key)) {
      return source[key]
    }
  }
  return undefined
}

function deepValue(source, paths) {
  for (const path of paths) {
    let current = source
    for (const segment of path) {
      current = current?.[segment]
    }
    if (current !== undefined && current !== null) {
      return current
    }
  }
  return undefined
}

function deepText(source, paths) {
  const value = deepValue(source, paths)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeSection(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[ _]/g, '-')
}

function maskName(value) {
  const chars = Array.from(String(value ?? '').trim())
  if (chars.length === 0) return 'I***1'
  if (chars.length <= 2) return `${chars[0]}*`
  return `${chars[0]}***${chars.at(-1)}`
}

function maskKey(value) {
  const chars = Array.from(String(value ?? '').trim())
  if (chars.length === 0) return '(empty)'
  if (chars.length <= 8) return `${chars.slice(0, 2).join('')}***`
  return `${chars.slice(0, 4).join('')}***${chars.slice(-4).join('')}`
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[ -]/g, '_')
    if (normalized.includes('token') || normalized.includes('secret') || normalized.includes('password') || normalized.includes('private_key') || normalized === 'api_key' || normalized === 'key') {
      continue
    }
    out[key] = scrubSecrets(child)
  }
  return out
}

function safePreview(row) {
  const projected = projectCredential(row, { maskSecret: true })
  try {
    projected.config_json = JSON.stringify(scrubSecrets(JSON.parse(projected.config_json)))
    projected.preview_json = JSON.stringify(scrubSecrets(JSON.parse(projected.preview_json)))
  } catch {
    projected.config_json = '{}'
    projected.preview_json = '{}'
  }
  return projected
}

function issue(index, displayName, code, field = null) {
  return {
    item_index: index,
    display_name: displayName === null ? null : maskName(displayName),
    code,
    field,
  }
}

function ensureSize(text, code = 'validation.transfer_text_too_large') {
  if (Buffer.byteLength(String(text ?? ''), 'utf8') > MAX_BYTES) {
    throw validation(code, 'Credential import exceeds the supported size', null)
  }
}

function parseJson(text, code = 'validation.transfer_json_invalid') {
  ensureSize(text, code === 'validation.transfer_json_invalid' ? 'validation.transfer_text_too_large' : code)
  try {
    return JSON.parse(String(text))
  } catch {
    throw validation(code, 'Credential import JSON is invalid', null)
  }
}

function nextSortOrders(document) {
  const result = {}
  for (const row of document.credentials ?? []) {
    result[row.platform] = Math.max(result[row.platform] ?? 0, Number(row.sort_order ?? -1) + 1)
  }
  return result
}

async function createBatch(stores, batchName, source) {
  const name = requireText(batchName, 'batch_name', 200)
  const batch = {
    id: uuid(),
    name,
    source,
    notes: null,
    sort_order: (await stores.batches.read()).batches?.length ?? 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  await stores.batches.update((document) => {
    document.batches = [...(document.batches ?? []), batch]
  })
  return batch.id
}

function officialToken(source, snake, camel) {
  return textAt(source, [snake, camel]) ?? textAt(object(source.tokens), [snake, camel])
}

function grokHeaders(platform, value) {
  if (platform !== 'grok') return object(value) ?? null
  const headers = { ...(object(value) ?? {}) }
  headers['User-Agent'] = 'xai-grok-workspace/0.2.93'
  headers['X-XAI-Token-Auth'] = 'xai-grok-cli'
  headers['x-grok-client-version'] = '0.2.93'
  delete headers['X-Client-Name']
  delete headers['x-client-name']
  return headers
}

function parseOfficialObject(platform, source, { sub2api = false } = {}) {
  const sourceObject = object(source)
  if (sourceObject === null) {
    throw validation('validation.cpa_entry_object', 'CPA array entries must be objects', null)
  }
  const selected = parsePlatform(platform)
  const credentials = object(sourceObject.credentials) ?? {}
  const merged = { ...credentials, ...sourceObject }
  const rawType = textAt(merged, ['type'])
  const declared = textAt(sourceObject, ['platform', 'provider', 'app']) ?? textAt(credentials, ['platform', 'provider', 'app'])
  const inferred = declared ?? rawType
  if (inferred !== null) {
    const parsed = tryParsePlatform(inferred)
    const typeLooksLikeAuth = sub2api && parsed === null
    if (!typeLooksLikeAuth && parsed !== selected) {
      throw validation('validation.cpa_platform_mismatch', 'CPA credential type does not match the selected platform', `expected ${selected}`)
    }
  }

  const secret = {}
  for (const [canonical, aliases] of OFFICIAL_SECRET_FIELDS) {
    const value = textAt(merged, aliases) ?? textAt(object(credentials.tokens), aliases)
    if (value !== null) secret[canonical] = value
  }
  if (secret.access_token === undefined && secret.refresh_token === undefined && secret.id_token === undefined && secret.agent_private_key === undefined) {
    throw validation('validation.cpa_secret_required', 'CPA credential requires an OAuth token', null)
  }

  const email = textAt(merged, ['email']) ?? deepText(sourceObject, [['extra', 'email'], ['credentials', 'live_identity', 'email']])
  const displayName = textAt(merged, ['display_name', 'displayName', 'name', 'label']) ?? email ?? 'Official account'
  const config = {
    type: selected,
    raw_type: rawType,
    account_id: secret.account_id ?? null,
    last_refresh: valueAt(merged, ['last_refresh', 'lastRefresh']) ?? null,
    expired: valueAt(merged, ['expired']) ?? null,
    expires_in: valueAt(merged, ['expires_in', 'expiresIn']) ?? null,
    disabled: valueAt(merged, ['disabled']) ?? null,
    raw: structuredClone(sourceObject),
  }
  if (sub2api) config.import_format = 'sub2api'
  for (const [canonical, aliases] of OFFICIAL_CONFIG_FIELDS) {
    const value = valueAt(merged, aliases)
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim().length === 0)) {
      config[canonical] = value
    }
  }
  const headers = grokHeaders(selected, config.headers)
  if (headers !== null) config.headers = headers
  if (selected === 'grok' && config.headers === undefined) config.headers = grokHeaders(selected, null)
  return { platform: selected, kind: 'official', displayName, email, secret, config, previewJson: '{}' }
}

function isApiShape(item) {
  return ['api-key', 'api_key', 'api-key-entries', 'api_key_entries', 'base-url'].some((key) => item?.[key] !== undefined)
}

function reverseModels(models) {
  if (!Array.isArray(models)) return []
  return models.map((model) => {
    const mapping = {
      from: textAt(model, ['alias']) ?? textAt(model, ['name']) ?? '',
      to: textAt(model, ['name']) ?? '',
      label: textAt(model, ['display-name']),
    }
    if (Number(model?.['max-context-length']) >= 1_048_576) mapping.supports_1m = true
    return mapping
  }).filter((mapping) => mapping.from.length > 0 && mapping.to.length > 0)
}

function validateHttpUrl(value, code = 'transfer.base_url_invalid') {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw validation(code, 'Base URL must be a valid HTTP URL', null)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw validation(code, 'Base URL must be a valid HTTP URL', null)
  }
  return String(value).trim()
}

function apiTarget(item, metadata, choice, fallbackPlatform = null) {
  let section = normalizeSection(metadata?.cpa_section ?? item.type)
  if (!CPA_SECTIONS.has(section)) section = null
  let platform = metadata?.platform ? parsePlatform(metadata.platform) : null
  let dialect = typeof metadata?.interface_format === 'string' ? metadata.interface_format.trim() : null
  const fixed = section === null ? null : (SECTION_TARGET[section] ?? null)
  if (fixed !== null) {
    if (platform !== null && platform !== fixed[0]) throw validation('transfer.metadata_conflict', 'Transfer metadata conflicts with CPA section', 'platform')
    platform = fixed[0]
    dialect ??= fixed[1]
  }
  if (section === 'openai-compatibility' || section === null) {
    const selected = choice ?? (fallbackPlatform === null ? null : {
      platform: fallbackPlatform,
      interface_format: defaultImportDialect(fallbackPlatform),
    })
    if (selected === null) throw validation('transfer.choice_required', 'This API credential needs a platform choice', 'item_index')
    platform = parsePlatform(selected.platform)
    dialect = String(selected.interface_format ?? defaultImportDialect(platform)).trim()
  }
  dialect ??= defaultImportDialect(platform)
  if (platform === null || dialect === null) throw validation('transfer.choice_required', 'This API credential needs a platform choice', 'platform')
  const derived = dialect === 'anthropic'
    ? 'claude-api-key'
    : dialect === 'gemini'
      ? 'gemini-api-key'
      : dialect === 'openai-responses'
        ? 'codex-api-key'
        : platform === 'grok' && officialXaiUrl(textAt(item, ['base-url', 'base_url']))
          ? 'xai-api-key'
          : 'openai-compatibility'
  if (section !== null && section !== derived) throw validation('transfer.interface_format_conflict', 'Transfer interface format conflicts with CPA section', 'cpa_section')
  return { platform, dialect, section: derived }
}

function officialXaiUrl(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase() === 'api.x.ai'
  } catch {
    return false
  }
}

function parseApiObject(item, metadata = null, choice = null, fallbackPlatform = null) {
  const compatibility = metadata?.cpa_section === 'openai-compatibility'
    || item['api-key-entries'] !== undefined
    || item.api_key_entries !== undefined
  const entries = item['api-key-entries'] ?? item.api_key_entries
  let apiKey
  if (compatibility && Array.isArray(entries)) {
    if (entries.length !== 1 || object(entries[0]) === null) {
      throw validation('transfer.api_key_entries_count', 'API key entries must contain one object', 'api-key-entries')
    }
    apiKey = textAt(entries[0], ['api-key', 'api_key'])
  } else {
    apiKey = textAt(item, ['api-key', 'api_key'])
  }
  if (apiKey === null) throw validation('transfer.api_key_required', 'API credential requires an API key', 'api-key')
  const baseUrl = validateHttpUrl(textAt(item, ['base-url', 'base_url']) ?? '', 'transfer.base_url_invalid')
  const target = apiTarget(item, metadata, choice, fallbackPlatform)
  let mappings = metadata?.model_mappings ?? reverseModels(item.models)
  mappings = validateModelMappings(JSON.stringify(Array.isArray(mappings) ? mappings : []))
  const config = {
    base_url: baseUrl,
    interface_format: target.dialect,
    model_mappings: mappings,
    fetched_models: [],
    responses_custom_tool_compat: metadata?.responses_custom_tool_compat === true,
  }
  if (object(item.headers) !== null && Object.keys(item.headers).length > 0) config.headers = structuredClone(item.headers)
  if (typeof metadata?.api_key_field === 'string' && metadata.api_key_field.trim().length > 0) {
    if (target.dialect !== 'anthropic') throw validation('transfer.api_key_field_conflict', 'API key field requires Anthropic', 'api_key_field')
    config.api_key_field = metadata.api_key_field.trim()
  }
  return {
    platform: target.platform,
    kind: 'api',
    displayName: textAt(metadata, ['display_name']) ?? textAt(item, ['display_name', 'displayName', 'name', 'label']) ?? 'API account',
    email: null,
    secret: { api_key: apiKey },
    config,
    previewJson: '{}',
    cpaSection: target.section,
  }
}

function looksSub2Api(item) {
  return ['credentials', 'tokens', 'platform', 'provider', 'priority', 'concurrency', 'rate_multiplier', 'auto_pause_on_expired'].some((key) => item?.[key] !== undefined)
}

function unwrapOfficialItems(value) {
  if (Array.isArray(value)) return value
  if (object(value)?.accounts !== undefined) {
    if (!Array.isArray(value.accounts)) throw validation('validation.cpa_accounts_array', 'CPA accounts must be an array', null)
    return value.accounts
  }
  return [value]
}

function parseBatchText(platform, text) {
  const value = parseJson(text, 'validation.cpa_json_invalid')
  const items = unwrapOfficialItems(value)
  if (items.length > MAX_ITEMS) throw validation('validation.cpa_item_limit', 'Too many credentials', null)
  return items.map((raw) => {
    const item = object(raw)
    if (item === null) throw validation('validation.cpa_entry_object', 'CPA entries must be objects', null)
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) throw validation('validation.cpa_item_too_large', 'CPA entry is too large', null)
    if (isApiShape(item)) return parseApiObject(item, null, null, platform)
    return parseOfficialObject(platform, item, { sub2api: looksSub2Api(item) })
  })
}

async function persistParsed(parsed, batchId, deps) {
  const document = await deps.stores.accounts.read()
  const orders = nextSortOrders(document)
  const rows = parsed.map((item) => {
    const sortOrder = orders[item.platform] ?? 0
    orders[item.platform] = sortOrder + 1
    return buildCredentialRow({
      platform: item.platform,
      kind: item.kind,
      displayName: item.displayName,
      email: item.email,
      secret: item.secret,
      config: item.config,
      previewJson: item.previewJson,
      batchId,
      sortOrder,
      externalSourceClient: item.externalSourceClient ?? null,
      externalSourceId: item.externalSourceId ?? null,
    })
  })
  await deps.stores.accounts.update((mutable) => {
    mutable.credentials = [...(mutable.credentials ?? []), ...rows]
  })
  return rows
}

/** Import pasted CPA, Sub2API, API-key, or mixed-array credentials. */
export async function importOfficialFromText({ platform, text, batchName }, deps) {
  const id = parsePlatform(platform)
  requireCapability(id, 'official_import')
  const source = requireText(text, 'text', MAX_BYTES)
  const parsed = parseBatchText(id, source)
  const batchId = await createBatch(deps.stores, batchName, 'route_credential_import')
  const rows = await persistParsed(parsed, batchId, deps)
  // Deliberate hardening over the desktop path: imported rows in a result are masked,
  // because this plugin's DTO may be logged by the browser transport.
  return { imported: rows.map(safePreview), failed: [] }
}

/** Import multiple CPA files; file read/parse failures are isolated per file. */
export async function importOfficialFromFiles({ platform, filePaths, batchName }, deps) {
  const id = parsePlatform(platform)
  requireCapability(id, 'official_import')
  const paths = Array.isArray(filePaths) ? filePaths.slice(0, MAX_ITEMS) : []
  if (paths.length === 0) throw validation('validation.required', 'file_paths must not be empty', 'file_paths')
  const batchId = await createBatch(deps.stores, batchName, 'route_credential_import')
  const imported = []
  const failed = []
  let totalBytes = 0
  for (const rawPath of paths) {
    const path = String(rawPath ?? '')
    try {
      const info = await stat(path)
      totalBytes += info.size
      if (totalBytes > MAX_BYTES) throw validation('validation.cpa_text_too_large', 'Files exceed the total import limit', null)
      const parsed = parseBatchText(id, await readFile(path, 'utf8'))
      const rows = await persistParsed(parsed, batchId, deps)
      imported.push(...rows.map(safePreview))
    } catch (error) {
      failed.push({ label: path, error: String(error?.message ?? error) })
    }
  }
  return { imported, failed }
}

function expandHome(path) {
  const raw = String(path ?? '').trim()
  if (raw === '~') return userHome()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(userHome(), raw.slice(2))
  return resolve(raw)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveCcSwitchPath(sourcePath) {
  if (typeof sourcePath === 'string' && sourcePath.trim().length > 0) {
    const path = expandHome(sourcePath)
    if (!(await exists(path))) throw validation('external_import.source_missing', 'The selected cc-switch config does not exist', path)
    return path
  }
  const configured = process.env.CC_SWITCH_HOME?.trim()
  const home = configured ? expandHome(configured) : join(homedir(), '.cc-switch')
  for (const path of [join(home, 'cc-switch.db'), join(home, 'config.json')]) {
    if (await exists(path)) return path
  }
  throw validation('external_import.source_not_found', 'Could not find a cc-switch configuration', home)
}

async function readCcSwitchDatabase(path) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    throw new ApiError('external_import.node_sqlite_unavailable', 'Node built-in SQLite support is unavailable', {
      details: String(error?.message ?? error),
      recoverable: true,
    })
  }
  let database
  try {
    // readOnly prevents SQLite from creating a journal or WAL beside a live client's DB.
    database = new DatabaseSync(path, { readOnly: true })
    let rows
    try {
      rows = database.prepare('SELECT id, app_type, name, category, sort_index, settings_config, meta FROM providers').all()
    } catch {
      rows = database.prepare('SELECT id, app_type, name, category, sort_index, settings_config FROM providers').all()
    }
    return rows.map((row) => ({
      sourceId: `${String(row.app_type).trim()}:${String(row.id).trim()}`,
      appType: String(row.app_type ?? ''),
      displayName: String(row.name ?? row.id ?? ''),
      category: typeof row.category === 'string' ? row.category.trim() : null,
      sortIndex: Number(row.sort_index ?? 0),
      settings: parseLooseObject(row.settings_config),
      meta: parseLooseObject(row.meta),
    }))
  } catch (error) {
    throw new ApiError('external_import.source_read_failed', 'Could not read cc-switch providers', {
      details: String(error?.message ?? error),
      recoverable: true,
    })
  } finally {
    database?.close()
  }
}

function parseLooseObject(value) {
  if (object(value) !== null) return value
  try {
    return object(JSON.parse(String(value ?? '{}'))) ?? {}
  } catch {
    return {}
  }
}

async function readCcSwitchJson(path) {
  let value
  try {
    const text = await readFile(path, 'utf8')
    ensureSize(text, 'external_import.source_too_large')
    value = JSON.parse(text)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw validation('external_import.source_invalid_json', 'The cc-switch config is not valid JSON', String(error?.message ?? error))
  }
  if (object(value) === null) throw validation('external_import.source_unexpected_shape', 'The cc-switch config has an unexpected shape', null)
  const providers = []
  for (const [appType, app] of Object.entries(value)) {
    const entries = object(app)?.providers
    if (object(entries) === null) continue
    for (const [id, raw] of Object.entries(entries)) {
      const entry = object(raw) ?? {}
      providers.push({
        sourceId: `${appType.trim()}:${id.trim()}`,
        appType,
        displayName: textAt(entry, ['name']) ?? id,
        category: textAt(entry, ['category']),
        sortIndex: Number(entry.sortIndex ?? entry.sort_index ?? 0),
        settings: entry.settingsConfig ?? entry.settings_config ?? {},
        meta: entry.meta ?? {},
      })
    }
  }
  return providers
}

async function readExternalProviders(path) {
  const providers = extname(path).toLowerCase() === '.db'
    ? await readCcSwitchDatabase(path)
    : await readCcSwitchJson(path)
  if (providers.length > MAX_ITEMS) throw validation('external_import.too_many_items', 'The cc-switch config has too many providers', null)
  return providers
}

function tomlStringValue(source, key) {
  for (const line of String(source ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/.exec(line)
    if (match?.[1] === key) return match[2].trim() || null
  }
  return null
}

function activeTomlTable(text) {
  const selected = tomlStringValue(text, 'model_provider')
  const tables = [...String(text ?? '').matchAll(/^\s*\[model_providers\.([^\]]+)\]\s*$([\s\S]*?)(?=^\s*\[|\z)/gm)]
  let found = selected === null ? null : tables.find((entry) => entry[1].trim() === selected)
  if (found === undefined || found === null) found = tables.length === 1 ? tables[0] : null
  return found?.[2] ?? ''
}

function providerPlatform(appType) {
  return APP_TYPES[String(appType ?? '').trim().toLowerCase()] ?? null
}

function extractedProvider(provider) {
  const platform = providerPlatform(provider.appType)
  if (platform === null) return { error: 'external_import.platform_unsupported', platform: null }
  if (String(provider.category ?? '').toLowerCase() === 'official') {
    return { error: 'external_import.official_login_unsupported', platform }
  }
  const settings = object(provider.settings) ?? {}
  const env = object(settings.env) ?? {}
  let apiKey = null
  let apiKeyField = null
  if (platform === 'claude') {
    apiKey = textAt(env, ['ANTHROPIC_AUTH_TOKEN'])
    if (apiKey !== null) apiKeyField = 'ANTHROPIC_AUTH_TOKEN'
    if (apiKey === null) {
      apiKey = textAt(env, ['ANTHROPIC_API_KEY'])
      if (apiKey !== null) apiKeyField = 'ANTHROPIC_API_KEY'
    }
  } else if (platform === 'codex') {
    const auth = object(settings.auth) ?? {}
    apiKey = textAt(auth, ['OPENAI_API_KEY'])
    if (apiKey === null) apiKey = Object.values(auth).find((value) => typeof value === 'string' && value.trim())?.trim() ?? null
  }
  apiKey ??= textAt(env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'API_KEY'])
  if (apiKey === null) return { error: 'external_import.api_key_missing', platform }

  const toml = typeof settings.config === 'string' ? settings.config : ''
  const table = activeTomlTable(toml)
  let baseUrl = platform === 'claude'
    ? textAt(env, ['ANTHROPIC_BASE_URL'])
    : platform === 'codex'
      ? tomlStringValue(table, 'base_url') ?? textAt(env, ['OPENAI_BASE_URL', 'BASE_URL'])
      : textAt(env, ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL', 'GOOGLE_BASE_URL', 'XAI_BASE_URL', 'GROK_BASE_URL', 'OPENAI_BASE_URL', 'BASE_URL'])
  if (baseUrl === null) return { error: 'external_import.base_url_missing', platform }
  try {
    baseUrl = validateHttpUrl(baseUrl, 'external_import.base_url_invalid')
  } catch {
    return { error: 'external_import.base_url_invalid', platform }
  }
  let dialect = defaultApiDialect(platform) ?? 'openai'
  if (platform === 'codex') {
    const format = String(provider.meta?.apiFormat ?? '').trim().toLowerCase()
    if (['openai_chat', 'openai-chat', 'chat', 'openai'].includes(format)) dialect = 'openai'
    else if (['openai_responses', 'openai-responses', 'responses'].includes(format)) dialect = 'openai-responses'
    else if (format === 'anthropic' || format === 'gemini') dialect = format
    else dialect = tomlStringValue(table, 'wire_api') === 'chat' ? 'openai' : 'openai-responses'
  }
  const modelMappings = platform === 'claude'
    ? claudeExternalMappings(env)
    : platform === 'codex'
      ? codexExternalMappings(settings, toml)
      : []
  const config = {
    base_url: baseUrl,
    interface_format: dialect,
    model_mappings: modelMappings,
    fetched_models: [],
    responses_custom_tool_compat: false,
  }
  if (apiKeyField !== null) config.api_key_field = apiKeyField
  const userAgent = textAt(provider.meta, ['customUserAgent'])
  if (userAgent !== null) config.headers = { 'User-Agent': userAgent }
  return {
    platform,
    displayName: provider.displayName.trim() || provider.sourceId,
    apiKey,
    apiKeyField,
    baseUrl,
    dialect,
    modelMappings,
    config,
  }
}

function splitOneM(value) {
  const text = String(value ?? '').trim()
  return /\[1m\]$/i.test(text) ? [text.replace(/\[1m\]$/i, '').trimEnd(), true] : [text, false]
}

function claudeExternalMappings(env) {
  const result = []
  const slots = [
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-sonnet-alias', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'Sonnet'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-alias', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'Opus'],
    ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'claude-fable-alias', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', 'Fable'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'claude-haiku-alias', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'Haiku'],
  ]
  for (const [key, from, nameKey, role] of slots) {
    const raw = textAt(env, [key])
    if (raw === null) continue
    const [to, oneM] = splitOneM(raw)
    const mapping = { from, to, label: textAt(env, [nameKey]) ?? role }
    if (oneM && from !== 'claude-haiku-alias') mapping.supports_1m = true
    result.push(mapping)
  }
  for (const [key, from] of [['CLAUDE_CODE_SUBAGENT_MODEL', 'claude-subagent'], ['ANTHROPIC_MODEL', 'claude-model']]) {
    const raw = textAt(env, [key])
    if (raw === null) continue
    const [to, oneM] = splitOneM(raw)
    const mapping = { from, to, label: null }
    if (oneM) mapping.supports_1m = true
    result.push(mapping)
  }
  return result
}

function codexExternalMappings(settings, toml) {
  const result = []
  const push = (model, label = null) => {
    const value = String(model ?? '').trim()
    if (!value || result.some((entry) => entry.from === value)) return
    result.push({ from: value, to: value, label: label === value ? null : label })
  }
  for (const item of settings.modelCatalog?.models ?? []) push(item?.model, textAt(item, ['displayName']))
  push(tomlStringValue(toml, 'model'))
  return result
}

function existingSourceMap(document, client) {
  return new Map((document.credentials ?? [])
    .filter((row) => row.external_source_client === client)
    .map((row) => [row.external_source_id, row]))
}

/** Preview cc-switch providers without returning an API key. */
export async function previewExternalClientImport({ client, platform, sourcePath }, deps) {
  if (String(client ?? '').trim().toLowerCase() !== 'cc-switch') throw validation('external_import.client_unsupported', 'This client is not supported', String(client ?? ''))
  const selected = parsePlatform(platform)
  const path = await resolveCcSwitchPath(sourcePath)
  const providers = await readExternalProviders(path)
  const existing = existingSourceMap(await deps.stores.accounts.read(), 'cc-switch')
  const counts = { total: 0, importable: 0, create: 0, overwrite: 0, errors: 0, other_platform: 0, other_platform_counts: {} }
  const items = []
  for (const provider of providers.sort((left, right) => left.sortIndex - right.sortIndex)) {
    const extracted = extractedProvider(provider)
    if (extracted.platform !== selected) {
      counts.other_platform += 1
      const label = extracted.platform ?? provider.appType.trim()
      counts.other_platform_counts[label] = (counts.other_platform_counts[label] ?? 0) + 1
      continue
    }
    counts.total += 1
    const matched = existing.get(provider.sourceId)
    let disposition = extracted.error ? 'error' : matched ? 'overwrite' : 'create'
    let issues = extracted.error ? [extracted.error] : []
    if (matched && (matched.platform !== selected || matched.kind !== 'api')) {
      disposition = 'error'
      issues = ['external_import.conflicting_local_account']
    }
    if (disposition === 'error') counts.errors += 1
    else {
      counts.importable += 1
      counts[disposition] += 1
    }
    items.push({
      source_id: provider.sourceId,
      display_name: extracted.displayName ?? provider.displayName.trim(),
      platform: extracted.platform ?? provider.appType.trim(),
      interface_format: extracted.error ? null : extracted.dialect,
      base_url: extracted.error ? null : extracted.baseUrl,
      api_key_masked: extracted.error ? null : maskKey(extracted.apiKey),
      model_mapping_count: extracted.error ? 0 : extracted.modelMappings.length,
      disposition,
      existing_credential_id: matched?.id ?? null,
      existing_display_name: matched?.display_name ?? null,
      issue_codes: issues,
    })
  }
  return { client: 'cc-switch', source_path: path, counts, items }
}

/** Import selected cc-switch records, overwriting only their own previous rows. */
export async function importExternalClientAccounts({ client, platform, sourcePath, sourceIds }, deps) {
  if (String(client ?? '').trim().toLowerCase() !== 'cc-switch') throw validation('external_import.client_unsupported', 'This client is not supported', String(client ?? ''))
  const selected = parsePlatform(platform)
  const ids = new Set((Array.isArray(sourceIds) ? sourceIds : []).map((id) => String(id).trim()).filter(Boolean).slice(0, MAX_IDS))
  if (ids.size === 0) throw validation('external_import.selection_empty', 'Select at least one account to import', null)
  const path = await resolveCcSwitchPath(sourcePath)
  const providers = await readExternalProviders(path)
  const document = await deps.stores.accounts.read()
  const existing = existingSourceMap(document, 'cc-switch')
  const orders = nextSortOrders(document)
  const imported = []
  const createdIds = []
  const matchedIds = new Set()
  let created = 0
  let overwritten = 0
  let failed = 0
  for (const provider of providers) {
    if (!ids.has(provider.sourceId)) continue
    matchedIds.add(provider.sourceId)
    const extracted = extractedProvider(provider)
    const previous = existing.get(provider.sourceId)
    if (extracted.error || extracted.platform !== selected || (previous && (previous.platform !== selected || previous.kind !== 'api'))) {
      failed += 1
      continue
    }
    if (previous) {
      const updated = await deps.accounts.update(previous.id, {
        display_name: extracted.displayName,
        email: null,
        status: previous.status,
        route_priority: previous.route_priority,
        max_concurrency: previous.max_concurrency,
        secret_payload_json: JSON.stringify({ api_key: extracted.apiKey }),
        config_json: JSON.stringify(extracted.config),
        preview_json: previous.preview_json ?? '{}',
      })
      imported.push(safePreview(updated))
      overwritten += 1
      continue
    }
    const sortOrder = orders[selected] ?? 0
    orders[selected] = sortOrder + 1
    const row = buildCredentialRow({
      platform: selected,
      kind: 'api',
      displayName: extracted.displayName,
      secret: { api_key: extracted.apiKey },
      config: extracted.config,
      sortOrder,
      externalSourceClient: 'cc-switch',
      externalSourceId: provider.sourceId,
    })
    await deps.stores.accounts.update((mutable) => {
      mutable.credentials = [...(mutable.credentials ?? []), row]
    })
    imported.push(safePreview(row))
    createdIds.push(row.id)
    created += 1
  }
  return { created, overwritten, skipped: ids.size - matchedIds.size, failed, imported, created_ids: createdIds }
}

function validateTransferText(text) {
  ensureSize(text)
  const value = parseJson(text)
  if (!Array.isArray(value)) throw validation('validation.transfer_array_required', 'Credential transfer JSON must be a bare array', null)
  if (value.length > MAX_ITEMS) throw validation('validation.transfer_item_limit', 'Credential transfer JSON contains too many items', null)
  for (const item of value) {
    if (object(item) === null) throw validation('validation.transfer_item_object_required', 'Credential transfer entries must be objects', null)
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) throw validation('validation.transfer_item_too_large', 'Credential transfer entry is too large', null)
  }
  return value
}

function choiceMap(items, choices) {
  const map = new Map()
  for (const choice of Array.isArray(choices) ? choices : []) {
    const index = Number(choice?.item_index)
    if (!Number.isInteger(index) || index < 0 || index >= items.length) throw validation('validation.transfer_choice_target_missing', 'A platform choice targets a missing item', null)
    if (map.has(index)) throw validation('validation.transfer_choice_duplicate', 'Each item may have one platform choice', null)
    map.set(index, choice)
  }
  return map
}

function parseMetadata(item) {
  if (item['x-ai-switch'] === undefined) return null
  const metadata = object(item['x-ai-switch'])
  if (metadata === null) throw validation('transfer.metadata_invalid', 'Transfer metadata must be an object', 'x-ai-switch')
  if (metadata.format !== TRANSFER_FORMAT) throw validation('transfer.metadata_format_unsupported', 'Transfer format is unsupported', 'format')
  if (metadata.schema_version !== TRANSFER_SCHEMA_VERSION) throw validation('transfer.schema_version_unsupported', 'Transfer schema version is unsupported', 'schema_version')
  if (!['official', 'api'].includes(String(metadata.kind ?? '').trim().toLowerCase())) throw validation('transfer.metadata_invalid', 'Transfer kind is invalid', 'kind')
  return { ...metadata, kind: String(metadata.kind).trim().toLowerCase() }
}

function strippedPayload(item) {
  const out = structuredClone(item)
  delete out['x-ai-switch']
  return out
}

function fingerprintPayload(item) {
  const payload = structuredClone(item)
  const metadata = object(payload['x-ai-switch'])
  if (metadata !== null) {
    for (const key of ['display_name', 'batch_name', 'source_batch_id', 'in_pool', 'origin_format']) {
      delete metadata[key]
    }
  }
  return payload
}

function normalizeTransferItem(index, item, choice) {
  const display = textAt(item['x-ai-switch'], ['display_name']) ?? textAt(item, ['display_name', 'displayName', 'name', 'label', 'email']) ?? `Item ${index + 1}`
  let metadata
  try {
    metadata = parseMetadata(item)
    let parsed
    if (metadata?.kind === 'api' || (metadata === null && isApiShape(item))) {
      parsed = parseApiObject(item, metadata, choice)
    } else if (metadata?.kind === 'official' || tryParsePlatform(item.type) !== null) {
      const selected = metadata?.platform ?? item.type
      parsed = parseOfficialObject(selected, strippedPayload(item), { sub2api: false })
    } else {
      throw validation('transfer.credential_kind_unrecognized', 'Credential kind cannot be recognized', 'type')
    }
    parsed.displayName = textAt(metadata, ['display_name']) ?? parsed.displayName ?? display
    parsed.cpaSection ??= metadata?.cpa_section ?? null
    parsed.inPool = metadata?.in_pool === true
    parsed.batchName = textAt(metadata, ['batch_name'])
    parsed.sourceBatchId = textAt(metadata, ['source_batch_id'])
    parsed.sourceInstanceId = textAt(metadata, ['source_instance_id'])
    parsed.sourceCredentialId = textAt(metadata, ['source_credential_id'])
    parsed.sourceIdentity = parsed.sourceInstanceId !== null && parsed.sourceCredentialId !== null
      ? `${parsed.sourceInstanceId}\u0000${parsed.sourceCredentialId}\u0000${parsed.platform}\u0000${parsed.kind}`
      : null
    parsed.fingerprint = credentialFingerprint(fingerprintPayload(item))
    parsed.rawFingerprintInput = item
    parsed.issueCodes = []
    parsed.index = index
    return { parsed, error: null }
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'transfer.item_invalid'
    return { parsed: null, error: issue(index, display, code, error?.details ?? null) }
  }
}

async function normalizedTransfer(input) {
  const items = validateTransferText(input.text)
  const choices = choiceMap(items, input.ambiguousPlatformChoices)
  return items.map((item, index) => normalizeTransferItem(index, item, choices.get(index) ?? null))
}

function storedOrigin(row) {
  if (typeof row.external_source_client === 'string' && row.external_source_client.startsWith(SOURCE_PREFIX)) {
    return {
      instance: row.external_source_client.slice(SOURCE_PREFIX.length),
      credential: row.external_source_id,
      fingerprint: row.source_fingerprint ?? null,
    }
  }
  return null
}

/** Preview a transfer array; every per-item parse problem becomes an error row. */
export async function previewTransferImport({ text, ambiguousPlatformChoices }, deps) {
  const normalized = await normalizedTransfer({ text, ambiguousPlatformChoices })
  const document = await deps.stores.accounts.read()
  const existingOrigins = new Map()
  for (const row of document.credentials ?? []) {
    const origin = storedOrigin(row)
    if (origin !== null) existingOrigins.set(`${origin.instance}\u0000${origin.credential}\u0000${row.platform}\u0000${row.kind}`, origin)
  }
  const counts = {
    total: normalized.length,
    official: 0,
    api: 0,
    importable: 0,
    duplicates: 0,
    conflicts: 0,
    errors: 0,
    restorable_pool_count: 0,
    batch_count: 0,
    platform_counts: {},
    cpa_section_counts: {},
    legacy_type_counts: {},
    restorable_pool_counts: {},
  }
  const seen = new Set()
  const batchGroups = new Set()
  const items = []
  for (const result of normalized) {
    if (result.error !== null) {
      counts.errors += 1
      items.push({
        item_index: result.error.item_index,
        display_name_masked: result.error.display_name ?? maskName(`Item ${items.length + 1}`),
        platform: null,
        kind: null,
        cpa_section: null,
        disposition: 'error',
        issue_codes: [result.error.code],
      })
      continue
    }
    const item = result.parsed
    counts[item.kind] += 1
    counts.platform_counts[item.platform] = (counts.platform_counts[item.platform] ?? 0) + 1
    if (item.cpaSection) counts.cpa_section_counts[item.cpaSection] = (counts.cpa_section_counts[item.cpaSection] ?? 0) + 1
    let disposition = 'importable'
    if (seen.has(item.fingerprint)) {
      disposition = 'input_duplicate'
      counts.duplicates += 1
    } else if (item.sourceIdentity !== null && existingOrigins.has(item.sourceIdentity)) {
      const origin = existingOrigins.get(item.sourceIdentity)
      if (origin.fingerprint === item.fingerprint) {
        disposition = 'source_duplicate'
        counts.duplicates += 1
      } else {
        disposition = 'conflict'
        counts.conflicts += 1
      }
    } else {
      counts.importable += 1
      if (item.inPool) {
        counts.restorable_pool_count += 1
        counts.restorable_pool_counts[item.platform] = (counts.restorable_pool_counts[item.platform] ?? 0) + 1
      }
      if (item.batchName) batchGroups.add(`${item.sourceInstanceId ?? ''}\u0000${item.sourceBatchId ?? ''}\u0000${item.batchName}`)
    }
    seen.add(item.fingerprint)
    items.push({
      item_index: item.index,
      display_name_masked: maskName(item.displayName),
      platform: item.platform,
      kind: item.kind,
      cpa_section: item.cpaSection,
      disposition,
      issue_codes: item.issueCodes,
    })
  }
  counts.batch_count = batchGroups.size
  return { counts, items }
}

async function transferBatch(stores, item, cache) {
  if (!item.batchName) return null
  const key = `${item.sourceInstanceId ?? ''}\u0000${item.sourceBatchId ?? ''}\u0000${item.batchName}`
  if (cache.has(key)) return cache.get(key)
  const id = await createBatch(stores, item.batchName, 'route_credential_transfer')
  cache.set(key, id)
  return id
}

/** Commit importable transfer items and preserve source identity for deterministic dedupe. */
export async function importTransferCredentials({ text, ambiguousPlatformChoices, restorePoolMembership }, deps) {
  const normalized = await normalizedTransfer({ text, ambiguousPlatformChoices })
  const document = await deps.stores.accounts.read()
  const origins = new Map()
  for (const row of document.credentials ?? []) {
    const origin = storedOrigin(row)
    if (origin) origins.set(`${origin.instance}\u0000${origin.credential}\u0000${row.platform}\u0000${row.kind}`, origin)
  }
  const seen = new Set()
  const orders = nextSortOrders(document)
  const batchCache = new Map()
  const outcome = { imported: 0, skipped_duplicates: 0, conflicts: 0, failed: 0, restored_pool_members: 0 }
  for (const result of normalized) {
    if (result.error !== null) {
      outcome.failed += 1
      continue
    }
    const item = result.parsed
    if (seen.has(item.fingerprint)) {
      outcome.skipped_duplicates += 1
      continue
    }
    seen.add(item.fingerprint)
    if (item.sourceIdentity !== null && origins.has(item.sourceIdentity)) {
      if (origins.get(item.sourceIdentity).fingerprint === item.fingerprint) outcome.skipped_duplicates += 1
      else outcome.conflicts += 1
      continue
    }
    const sortOrder = orders[item.platform] ?? 0
    orders[item.platform] = sortOrder + 1
    const row = buildCredentialRow({
      platform: item.platform,
      kind: item.kind,
      displayName: item.displayName,
      email: item.email,
      secret: item.secret,
      config: item.config,
      previewJson: item.previewJson,
      batchId: await transferBatch(deps.stores, item, batchCache),
      sortOrder,
      externalSourceClient: item.sourceInstanceId ? `${SOURCE_PREFIX}${item.sourceInstanceId}` : null,
      externalSourceId: item.sourceCredentialId,
    })
    row.source_fingerprint = item.fingerprint
    await deps.stores.accounts.update((mutable) => {
      mutable.credentials = [...(mutable.credentials ?? []), row]
    })
    if (restorePoolMembership === true && item.inPool) {
      await deps.accounts.addPoolMember(item.platform, row.id)
      outcome.restored_pool_members += 1
    }
    outcome.imported += 1
  }
  return outcome
}

function installationId(settings) {
  if (typeof settings?.installation_id === 'string' && settings.installation_id.trim()) return settings.installation_id.trim()
  return 'dsh-plugin-ai-switch'
}

function exportIssue(row, code, field = null) {
  return { item_index: null, display_name: row?.display_name ?? null, code, field }
}

function projectExport(row, instanceId, inPool, enhanced) {
  let secret
  let config
  try {
    secret = object(JSON.parse(row.secret_payload_json))
    config = object(JSON.parse(row.config_json))
  } catch {
    throw exportIssue(row, 'transfer.payload_json_invalid')
  }
  if (secret === null || config === null) throw exportIssue(row, 'transfer.payload_json_invalid')
  const metadata = {
    format: TRANSFER_FORMAT,
    schema_version: TRANSFER_SCHEMA_VERSION,
    source_instance_id: instanceId,
    source_credential_id: row.id,
    platform: row.platform,
    kind: row.kind,
  }
  if (enhanced) {
    metadata.display_name = row.display_name
    metadata.in_pool = inPool
    metadata.origin_format = textAt(config, ['import_format', 'origin_format'])?.replace(/_/g, '-') ?? (object(config.raw) ? 'cpa' : 'ai-switch')
    if (row.batch_id) {
      metadata.source_batch_id = row.batch_id
      const batchName = textAt(row, ['batch_name'])
      if (batchName !== null) metadata.batch_name = batchName
    }
  }
  if (row.kind === 'official') {
    if (!secret.access_token && !secret.refresh_token && !secret.agent_private_key) throw exportIssue(row, 'transfer.oauth_token_required', 'access_token')
    const payload = object(config.raw) ? structuredClone(config.raw) : {}
    for (const [canonical] of OFFICIAL_SECRET_FIELDS) {
      if (secret[canonical] !== undefined && secret[canonical] !== null && secret[canonical] !== '') payload[canonical] = secret[canonical]
    }
    for (const [canonical] of OFFICIAL_CONFIG_FIELDS) {
      if (config[canonical] !== undefined && config[canonical] !== null && config[canonical] !== '') payload[canonical] = config[canonical]
    }
    payload.type = row.platform === 'grok' ? 'xai' : row.platform
    if (row.email) payload.email = row.email
    payload['x-ai-switch'] = metadata
    return { payload, section: null, warnings: [] }
  }
  if (row.kind !== 'api') throw exportIssue(row, 'transfer.credential_kind_unsupported', 'kind')
  const apiKey = textAt(secret, ['api_key'])
  const baseUrl = textAt(config, ['base_url'])
  const dialect = textAt(config, ['interface_format'])
  if (!apiKey) throw exportIssue(row, 'transfer.api_key_required', 'api_key')
  if (!baseUrl) throw exportIssue(row, 'transfer.base_url_required', 'base_url')
  const section = dialect === 'anthropic'
    ? 'claude-api-key'
    : dialect === 'gemini'
      ? 'gemini-api-key'
      : dialect === 'openai-responses'
        ? 'codex-api-key'
        : row.platform === 'grok' && officialXaiUrl(baseUrl)
          ? 'xai-api-key'
          : 'openai-compatibility'
  metadata.cpa_section = section
  if (enhanced) {
    metadata.interface_format = dialect
    if (config.responses_custom_tool_compat === true) metadata.responses_custom_tool_compat = true
    if (config.api_key_field) metadata.api_key_field = config.api_key_field
    if (Array.isArray(config.model_mappings) && config.model_mappings.length > 0) metadata.model_mappings = config.model_mappings
  }
  const models = (config.model_mappings ?? []).map((mapping) => ({
    name: mapping.to,
    alias: mapping.from,
    ...(mapping.label ? { 'display-name': mapping.label } : {}),
    ...(mapping.supports_1m ? { 'max-context-length': 1_048_576 } : {}),
  }))
  const payload = section === 'openai-compatibility'
    ? { name: row.display_name, 'base-url': baseUrl, headers: object(config.headers) ?? {}, 'api-key-entries': [{ 'api-key': apiKey }] }
    : { 'api-key': apiKey, 'base-url': baseUrl }
  if (object(config.headers) && Object.keys(config.headers).length > 0) payload.headers = config.headers
  if (models.length > 0) payload.models = models
  payload['x-ai-switch'] = metadata
  const warnings = []
  if (secret.relay_balance_access_token) warnings.push(exportIssue(row, 'transfer.relay_balance_secret_dropped', 'relay_balance_access_token'))
  return { payload, section, warnings }
}

function suggestedName(platform) {
  const compact = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `ai-switch-${tryParsePlatform(platform) ?? 'unknown'}-route-credentials-${compact}.json`
}

/** Export selected rows in CPA-compatible transfer format. */
export async function exportCredentials({ selectionContext, credentialIds, includeEnhancedMetadata }, deps) {
  const result = {
    json_text: null,
    suggested_file_name: suggestedName(selectionContext?.platform),
    counts: { total: 0, official: 0, api: 0 },
    scheme_links: [],
    warnings: [],
    errors: [],
  }
  const platform = tryParsePlatform(selectionContext?.platform)
  if (platform === null) {
    result.errors.push({ item_index: null, display_name: null, code: 'transfer.platform_unknown', field: null })
    return result
  }
  const ids = Array.isArray(credentialIds) ? credentialIds : []
  if (ids.length === 0) {
    result.errors.push({ item_index: null, display_name: null, code: 'transfer.selection_empty', field: null })
    return result
  }
  if (ids.length > MAX_IDS) {
    result.errors.push({ item_index: null, display_name: null, code: 'transfer.selection_too_large', field: null })
    return result
  }
  const unique = [...new Set(ids.map((id) => String(id)))]
  const document = await deps.stores.accounts.read()
  const rows = unique.map((id) => document.credentials?.find((row) => row.id === id)).filter(Boolean)
  const scope = selectionContext?.pool_scope
  const pool = await deps.stores.pool.read()
  const memberIds = new Set((pool.members ?? []).filter((member) => member.platform === platform).map((member) => member.route_credential_id))
  const eligible = rows.filter((row) => row.platform === platform
    && (scope === 'archived' ? row.archived_at !== null : row.archived_at === null)
    && (scope === 'in_pool' ? memberIds.has(row.id) : scope === 'out_of_pool' ? !memberIds.has(row.id) : true))
  if (eligible.length !== unique.length) {
    result.errors.push({ item_index: null, display_name: null, code: 'transfer.credential_not_found_or_out_of_context', field: null })
    return result
  }
  const settings = await deps.stores.settings.read()
  const batches = await deps.stores.batches.read()
  const payloads = []
  for (const row of eligible) {
    const batchName = row.batch_id === null || row.batch_id === undefined
      ? null
      : textAt((batches.batches ?? []).find((batch) => batch.id === row.batch_id), ['name'])
    const exportRow = batchName === null ? row : { ...row, batch_name: batchName }
    result.counts[row.kind] = (result.counts[row.kind] ?? 0) + 1
    try {
      const projected = projectExport(exportRow, installationId(settings), memberIds.has(row.id), includeEnhancedMetadata === true)
      payloads.push(projected.payload)
      result.warnings.push(...projected.warnings)
      if (row.kind === 'api') result.scheme_links.push(buildSchemeLink(row))
    } catch (error) {
      result.errors.push(error?.code ? error : exportIssue(row, 'transfer.payload_unsupported'))
    }
  }
  result.counts.total = eligible.length
  if (result.errors.length > 0) return result
  const json = `${JSON.stringify(payloads, null, 2)}\n`
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    result.errors.push({ item_index: null, display_name: null, code: 'transfer.export_too_large', field: null })
    result.scheme_links = []
    return result
  }
  result.json_text = json
  return result
}

function buildSchemeLink(row) {
  const result = { credential_id: row.id, display_name: row.display_name, url: null, issue_code: null }
  try {
    const secret = JSON.parse(row.secret_payload_json)
    const config = JSON.parse(row.config_json)
    const params = new URLSearchParams({
      resource: 'provider',
      app: row.platform,
      name: row.display_name,
      endpoint: config.base_url,
      apiKey: secret.api_key,
    })
    result.url = `aiswitch://v1/import?${params}`
  } catch {
    result.issue_code = 'deeplink_export.payload_unsupported'
  }
  return result
}

/** Parse, validate, and sanitize an aiswitch/ccswitch provider-import deep link. */
export function parseDeeplink(url) {
  let parsed
  try {
    parsed = new URL(requireText(url, 'url', 32_768))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw validation('deeplink.invalid_url', 'Invalid deep link URL', null)
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  if (!['aiswitch', 'ccswitch'].includes(scheme)) throw validation('deeplink.scheme_unsupported', 'Unsupported deep link scheme', scheme)
  const version = parsed.hostname
  if (version !== 'v1') throw validation('deeplink.version_unsupported', 'Unsupported deep link version', version)
  if (parsed.pathname !== '/import') throw validation('deeplink.path_unsupported', 'Unsupported deep link path', parsed.pathname)
  const resource = parsed.searchParams.get('resource')?.trim()
  if (resource !== 'provider') throw validation('deeplink.resource_unsupported', 'Unsupported deep link resource', resource)
  const app = requireText(parsed.searchParams.get('app'), 'app', 100)
  const platform = parsePlatform(app)
  requireCapability(platform, 'deeplink_import')
  const displayName = requireText(parsed.searchParams.get('name'), 'name', 200)
  const endpoints = String(parsed.searchParams.get('endpoint') ?? '').split(',')
  let baseUrl = null
  for (const endpoint of endpoints) {
    try {
      baseUrl = validateHttpUrl(endpoint.trim(), 'deeplink.endpoint_invalid')
      break
    } catch {
      // Multiple endpoints are a legacy ccswitch convention; first valid HTTP URL wins.
    }
  }
  if (baseUrl === null) throw validation('deeplink.endpoint_invalid', 'No valid HTTP endpoint', 'endpoint')
  const apiKey = requireText(parsed.searchParams.get('apiKey'), 'apiKey', 8192)
  const mappings = []
  if (platform === 'claude') {
    for (const [param, from, label] of [
      ['haikuModel', 'claude-haiku-alias', 'Haiku'],
      ['sonnetModel', 'claude-sonnet-alias', 'Sonnet'],
      ['opusModel', 'claude-opus-alias', 'Opus'],
    ]) {
      const to = parsed.searchParams.get(param)?.trim()
      if (to) mappings.push({ from, to, label })
    }
  } else {
    const to = parsed.searchParams.get('model')?.trim()
    const from = { codex: 'gpt-5', gemini: 'gemini-2.5-flash', grok: 'grok-3' }[platform]
    if (to && from) mappings.push({ from, to, label: null })
  }
  const sanitized = new URL(parsed)
  sanitized.searchParams.set('apiKey', maskKey(apiKey))
  return {
    scheme,
    version,
    resource,
    app,
    platform,
    display_name: displayName,
    base_url: baseUrl,
    api_key_masked: maskKey(apiKey),
    api_key: apiKey,
    interface_format: defaultImportDialect(platform),
    model_mappings_json: JSON.stringify(mappings),
    homepage: parsed.searchParams.get('homepage')?.trim() || null,
    notes: parsed.searchParams.get('notes')?.trim() || null,
    source_url_sanitized: sanitized.toString(),
  }
}
