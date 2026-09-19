/**
 * Route credentials — the accounts the pool routes between — and the pool itself.
 *
 * This is the reference's `route_credential_repository.rs` (4290 lines of sqlx) +
 * `route_credential_service.rs` + `route_pool_service.rs`, re-expressed over a JSON
 * document. The SHAPE is not negotiable: the panel is the reference's React app copied
 * verbatim, so every field name, every `validation.*` code and every default has to be
 * the one `src/lib/api/types.ts` and `AccountsScreen.tsx` already expect.
 *
 * Three things are worth knowing before editing:
 *
 * 1. `secret_payload_json`, `config_json` and `preview_json` cross the wire as JSON
 *    *strings*, not objects. The UI edits them as text in a drawer and posts them back.
 * 2. An edit that comes back carrying `{"__masked":true,...}` means the browser never
 *    saw the real secret; the stored one is kept. Detection is by MARKER KEY, not string
 *    equality, because the drawer round-trips `{"__masked":true,"api_key":""}`.
 * 3. The quota columns are a denormalized cache of `config_json`, recomputed on every
 *    write — never an independent source.
 *
 * @module dsh-plugin-ai-switch/host/accounts
 */
import { ApiError, nowIso, requireIdList, requireInt, requireText, validation } from '../shared/protocol.js'
import {
  API_DIALECTS,
  defaultApiDialect,
  parsePlatform,
  platformDisplayName,
  requireCapability,
} from './platforms.js'
import { uuid } from './sdk.js'

/** The five account statuses the UI knows how to paint. */
export const ACCOUNT_STATUSES = ['ok', 'warning', 'error', 'revoked', 'paused']

/** Page sizes the list screen offers; anything else is a bug, not a preference. */
export const PAGE_SIZES = [20, 50, 100]

/** Scopes the account list can be filtered to. */
export const POOL_SCOPES = ['in_pool', 'out_of_pool', 'archived']

/** Reference defaults. Note the column default (1) differs from the app default (5). */
export const DEFAULT_ROUTE_PRIORITY = 3
export const DEFAULT_MAX_CONCURRENCY = 5

/** The catch-all client alias Claude Code sends when it has no mapping of its own. */
export const FALLBACK_MODEL_ALIAS = 'claude-model'

/** Rejected in mappings: it is the placeholder the UI shows, not a model. */
const MODEL_PLACEHOLDER = 'upstream-model'

/** Failure-policy bounds, as `models/route_credential.rs` declares them. */
export const FAILURE_POLICY_DEFAULTS = {
  retry_count: 2,
  retry_interval_ms: 200,
  semantic_error_threshold: 10,
  cooldown_enabled: false,
  cooldown_seconds: 10,
  error_status_enabled: true,
}

const FAILURE_POLICY_BOUNDS = {
  retry_count: [0, 10],
  retry_interval_ms: [0, 60_000],
  semantic_error_threshold: [1, 1000],
  cooldown_seconds: [1, 86_400],
}

/** The masked stand-in a non-primary web client receives instead of a secret. */
export const MASKED_SECRET_PAYLOAD = '{"__masked":true}'

function parseJsonMaybe(text, fallback = null) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return fallback
  }
  try {
    const parsed = JSON.parse(text)
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed
  } catch {
    return fallback
  }
}

/** True when the browser posted back a payload it never had the plaintext of. */
export function isMaskedSecretPayload(text) {
  const parsed = parseJsonMaybe(text)
  return parsed !== null && parsed.__masked === true
}

/** The quota columns are derived from config_json on every write, never set directly. */
function quotaColumnsFromConfig(configJson) {
  const config = parseJsonMaybe(configJson, {}) ?? {}
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null)
  const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)
  const snapshot = config.relay_balance_snapshot ?? {}
  return {
    subscription_type: text(config.type ?? config.raw_type ?? snapshot.plan_name),
    quota_remaining: number(config.quota_remaining ?? snapshot.remaining),
    quota_limit: number(config.quota_limit ?? snapshot.limit),
    quota_used: number(config.quota_used ?? snapshot.used),
    primary_remain: number(config.primary_remain),
    weekly_remain: number(config.weekly_remain),
    reset_primary: text(config.reset_primary),
    reset_weekly: text(config.reset_weekly),
  }
}

/** Validate the recovery rule the reference normalizes in route_recovery_service.rs. */
export function normalizeRecoveryRule(rule) {
  const mode = String(rule?.mode ?? 'off').trim()
  if (!['off', 'scheduled', 'healthcheck'].includes(mode)) {
    throw validation('validation.recovery_mode', 'Unknown recovery mode', mode)
  }
  if (mode === 'off') {
    return { mode: 'off', times: [], probe_interval_minutes: null }
  }
  if (mode === 'scheduled') {
    const times = Array.isArray(rule?.times) ? rule.times : []
    const normalized = []
    for (const raw of times) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim())
      if (match === null) {
        throw validation('validation.recovery_times', 'Recovery times must look like HH:MM', String(raw ?? ''))
      }
      const hour = Number.parseInt(match[1], 10)
      const minute = Number.parseInt(match[2], 10)
      if (hour > 23 || minute > 59) {
        throw validation('validation.recovery_times', 'Recovery times must be a valid time of day', String(raw))
      }
      const value = `${String(hour).padStart(2, '0')}:${match[2]}`
      if (!normalized.includes(value)) {
        normalized.push(value)
      }
    }
    if (normalized.length === 0) {
      throw validation('validation.recovery_required', 'Scheduled recovery needs at least one time', 'times')
    }
    normalized.sort()
    return { mode, times: normalized, probe_interval_minutes: null }
  }
  const interval = requireInt(
    rule?.probe_interval_minutes ?? 30,
    1,
    1440,
    'validation.recovery_probe_interval',
    'probe_interval_minutes',
  )
  return { mode, times: [], probe_interval_minutes: interval }
}

/** Stats the list screen shows per account; zeros when the caller did not compute them. */
const ZERO_STATS = {
  request_count: 0,
  success_count: 0,
  failure_count: 0,
  success_rate: null,
  last_duration_ms: null,
  avg_recent_duration_ms: null,
}

/**
 * One stored row as the browser sees it.
 *
 * Which of the computed groups are filled depends on the command, exactly as in the
 * reference: the list commands carry stats and model states, the mutating ones return
 * the row with zeros. The UI refetches the list after a mutation, so nothing shows the
 * zeros for long — and pretending otherwise would mean recomputing usage on every save.
 */
export function projectCredential(row, options = {}) {
  const { batchName = null, stats = null, modelStates = [], activeRequestCount = 0, maskSecret = false } = options
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    display_name: row.display_name,
    email: row.email ?? null,
    status: row.status,
    sort_order: row.sort_order,
    route_priority: row.route_priority,
    max_concurrency: row.max_concurrency,
    batch_id: row.batch_id ?? null,
    batch_name: batchName,
    secret_payload_json: maskSecret ? MASKED_SECRET_PAYLOAD : (row.secret_payload_json ?? '{}'),
    config_json: row.config_json ?? '{}',
    preview_json: row.preview_json ?? '{}',
    subscription_type: row.subscription_type ?? null,
    primary_remain: row.primary_remain ?? null,
    weekly_remain: row.weekly_remain ?? null,
    reset_primary: row.reset_primary ?? null,
    reset_weekly: row.reset_weekly ?? null,
    quota_remaining: row.quota_remaining ?? null,
    quota_limit: row.quota_limit ?? null,
    quota_used: row.quota_used ?? null,
    quota_updated_at: row.quota_updated_at ?? null,
    archived_at: row.archived_at ?? null,
    transient_failure_count: row.transient_failure_count ?? 0,
    next_retry_at: row.next_retry_at ?? null,
    cooldown_until: row.cooldown_until ?? null,
    last_failure_kind: row.last_failure_kind ?? null,
    last_failure_message: row.last_failure_message ?? null,
    last_failure_response_json: row.last_failure_response_json ?? null,
    active_request_count: activeRequestCount,
    model_states: modelStates,
    ...(stats ?? ZERO_STATS),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * The model ids an account is known to serve.
 *
 * API accounts declare them as the `to` side of their mappings; official accounts and
 * mapping-less API accounts fall back to the per-platform client aliases, which is what
 * the local CLIs will actually ask for.
 */
export function knownModelKeys(row, clientAliases) {
  const config = parseJsonMaybe(row.config_json, {}) ?? {}
  const mappings = Array.isArray(config.model_mappings) ? config.model_mappings : []
  const keys = []
  for (const mapping of mappings) {
    const to = String(mapping?.to ?? '').trim()
    if (to.length > 0 && to !== MODEL_PLACEHOLDER && !keys.includes(to)) {
      keys.push(to)
    }
  }
  if (keys.length > 0) {
    return keys
  }
  return clientAliases.slice()
}

/** Which client-facing aliases point at one upstream model key. */
export function aliasesForModelKey(row, modelKey) {
  const config = parseJsonMaybe(row.config_json, {}) ?? {}
  const mappings = Array.isArray(config.model_mappings) ? config.model_mappings : []
  return mappings
    .filter((mapping) => String(mapping?.to ?? '').trim() === modelKey)
    .map((mapping) => String(mapping.from).trim())
    .filter((alias) => alias.length > 0)
}

/** Aliases the pool advertises per platform when an account declares no mappings. */
export const CLIENT_ALIASES = {
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  claude: ['claude-sonnet-alias', 'claude-opus-alias', 'claude-fable-alias', 'claude-haiku-alias'],
  gemini: ['gemini-2.5-flash'],
  grok: ['grok-4.5'],
  opencode: [],
  openclaw: [],
  hermes: [],
}

/**
 * The account domain. One instance per host, constructed by host/routes.js.
 *
 * `activity` is a process-local map of in-flight requests per account, the same thing
 * the reference keeps in an `Arc<Mutex<HashMap>>` — it is deliberately NOT persisted:
 * a restart means nothing is in flight.
 */
export class AccountService {
  constructor({ stores, activity, ledger }) {
    this.stores = stores
    this.activity = activity
    this.ledger = ledger
  }

  async #document() {
    return this.stores.accounts.read()
  }

  async #rows() {
    const document = await this.#document()
    if (!Array.isArray(document.credentials)) {
      document.credentials = []
    }
    return document.credentials
  }

  async #batchName(batchId) {
    if (batchId === null || batchId === undefined) {
      return null
    }
    const document = await this.stores.batches.read()
    const batch = (document.batches ?? []).find((item) => item.id === batchId)
    return batch?.name ?? null
  }

  /** The per-model health rows, stored ones plus a synthesized `ok` for the rest. */
  async #modelStates(row) {
    const document = await this.#document()
    const stored = (document.models ?? []).filter((item) => item.route_credential_id === row.id)
    const aliases = CLIENT_ALIASES[row.platform] ?? []
    const keys = new Set([...knownModelKeys(row, aliases), ...stored.map((item) => item.model_key)])
    return Array.from(keys)
      .sort()
      .map((modelKey) => {
        const found = stored.find((item) => item.model_key === modelKey)
        return {
          route_credential_id: row.id,
          model_key: modelKey,
          status: found?.status ?? 'ok',
          transient_failure_count: found?.transient_failure_count ?? 0,
          cooldown_until: found?.cooldown_until ?? null,
          semantic_failure_streak_count: found?.semantic_failure_streak_count ?? 0,
          semantic_failure_streak_fingerprint: found?.semantic_failure_streak_fingerprint ?? null,
          last_failure_kind: found?.last_failure_kind ?? null,
          last_failure_message: found?.last_failure_message ?? null,
          last_failure_response_json: found?.last_failure_response_json ?? null,
          aliases: aliasesForModelKey(row, modelKey),
          created_at: found?.created_at ?? row.created_at,
          updated_at: found?.updated_at ?? row.updated_at,
        }
      })
  }

  /** Project one row with everything the list screen wants filled in. */
  async #full(row, { stats = true } = {}) {
    return projectCredential(row, {
      batchName: await this.#batchName(row.batch_id),
      stats: stats ? this.ledger?.statsFor(row.id) ?? null : null,
      modelStates: await this.#modelStates(row),
      activeRequestCount: this.activity?.count(row.id) ?? 0,
    })
  }

  /** `list_route_credentials`: every non-archived account on one platform, in order. */
  async list(platform) {
    const id = parsePlatform(platform)
    const rows = (await this.#rows())
      .filter((row) => row.platform === id && row.archived_at === null)
      .sort((left, right) => left.sort_order - right.sort_order)
    return Promise.all(rows.map((row) => this.#full(row)))
  }

  async get(id) {
    const row = await this.requireRow(requireText(id, 'id'))
    return this.#full(row, { stats: false })
  }

  /** The row itself; throws the not-found code the UI knows. */
  async requireRow(id) {
    const row = (await this.#rows()).find((item) => item.id === id)
    if (row === undefined) {
      throw validation('validation.route_credential_not_found', 'Account not found', id)
    }
    return row
  }

  /** `list_route_credentials_page`: filtered, scoped and paginated. */
  async page(input) {
    const platform = parsePlatform(input?.platform)
    const pageSize = PAGE_SIZES.includes(Number(input?.page_size)) ? Number(input.page_size) : null
    if (pageSize === null) {
      throw validation('validation.route_credential_page_size', 'Unsupported page size', String(input?.page_size ?? ''))
    }
    const scope = POOL_SCOPES.includes(input?.pool_scope) ? input.pool_scope : 'out_of_pool'
    const filters = Array.isArray(input?.filters) ? input.filters.map((value) => String(value)) : []
    const members = await this.#poolMemberIds(platform)
    const all = (await this.#rows())
      .filter((row) => row.platform === platform)
      .sort((left, right) => left.sort_order - right.sort_order)

    const scoped = all.filter((row) => {
      if (scope === 'archived') {
        return row.archived_at !== null
      }
      if (row.archived_at !== null) {
        return false
      }
      return scope === 'in_pool' ? members.has(row.id) : !members.has(row.id)
    })
    const filtered = filters.length === 0 ? scoped : scoped.filter((row) => matchesFilters(row, filters))

    const total = filtered.length
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(Math.max(1, Number.parseInt(String(input?.page ?? 1), 10) || 1), pageCount)
    const start = (page - 1) * pageSize
    const items = await Promise.all(filtered.slice(start, start + pageSize).map((row) => this.#full(row)))
    return {
      items,
      total,
      page,
      page_count: pageCount,
      page_size: pageSize,
      previous_page_account_id: start > 0 ? (filtered[start - 1]?.id ?? null) : null,
      next_page_account_id: filtered[start + pageSize]?.id ?? null,
      filter_options: await this.#filterOptions(platform),
      official_account_count: all.filter((row) => row.kind === 'official' && row.archived_at === null).length,
    }
  }

  /** Batch ids that have accounts on this platform, plus the unbatched sentinel. */
  async #filterOptions(platform) {
    const rows = (await this.#rows()).filter((row) => row.platform === platform && row.archived_at === null)
    const document = await this.stores.batches.read()
    const options = []
    for (const batch of document.batches ?? []) {
      if (rows.some((row) => row.batch_id === batch.id)) {
        options.push({ key: batch.id, label: batch.name })
      }
    }
    if (rows.some((row) => row.batch_id === null || row.batch_id === undefined)) {
      options.push({ key: '__single__', label: '未分组' })
    }
    return options
  }

  async #poolMemberIds(platform) {
    const document = await this.stores.pool.read()
    return new Set(
      (document.members ?? [])
        .filter((member) => member.platform === platform && member.enabled !== 0 && member.enabled !== false)
        .map((member) => member.route_credential_id),
    )
  }

  /** Next free sort order on one platform. */
  async #nextSortOrder(platform) {
    const rows = (await this.#rows()).filter((row) => row.platform === platform)
    return rows.reduce((max, row) => Math.max(max, row.sort_order + 1), 0)
  }

  /** `create_api_route_credential`. Validation order matches the reference exactly. */
  async createApi(input) {
    const platform = parsePlatform(input?.platform)
    requireCapability(platform, 'route_credentials')
    const displayName = requireText(input?.display_name, 'display_name', 200)
    const apiKey = requireText(input?.api_key, 'api_key', 8192)
    const baseUrl = requireText(input?.base_url, 'base_url', 2048)
    const interfaceFormat = String(input?.interface_format ?? '').trim()
    if (!API_DIALECTS.includes(interfaceFormat)) {
      throw validation('validation.interface_format', 'Unsupported upstream protocol', interfaceFormat)
    }
    const mappings = validateModelMappings(input?.model_mappings_json)
    const fetched = validateFetchedModels(input?.fetched_models_json)
    const apiKeyField = normalizeApiKeyField(input?.api_key_field, interfaceFormat)
    const relayProvider = normalizeRelayProvider(input?.relay_balance_provider)

    const config = {
      base_url: baseUrl,
      interface_format: interfaceFormat,
      model_mappings: mappings,
      fetched_models: fetched,
      responses_custom_tool_compat: input?.responses_custom_tool_compat === true,
    }
    if (apiKeyField !== null) {
      config.api_key_field = apiKeyField
    }
    const userAgent = typeof input?.user_agent === 'string' ? input.user_agent.trim() : ''
    if (userAgent.length > 0) {
      config.headers = { 'User-Agent': userAgent }
    }
    if (relayProvider !== null) {
      config.relay_balance = { provider: relayProvider }
    }
    const secret = { api_key: apiKey }
    const relayToken = typeof input?.relay_balance_access_token === 'string' ? input.relay_balance_access_token.trim() : ''
    if (relayToken.length > 0) {
      secret.relay_balance_access_token = relayToken
    }
    const relayUserId =
      typeof input?.relay_balance_access_token_user_id === 'string' ? input.relay_balance_access_token_user_id.trim() : ''
    if (relayUserId.length > 0) {
      secret.relay_balance_access_token_user_id = relayUserId
    }

    const now = nowIso()
    const row = {
      id: uuid(),
      platform,
      kind: 'api',
      display_name: displayName,
      email: null,
      status: 'ok',
      sort_order: await this.#nextSortOrder(platform),
      route_priority: DEFAULT_ROUTE_PRIORITY,
      max_concurrency: DEFAULT_MAX_CONCURRENCY,
      batch_id: typeof input?.batch_id === 'string' && input.batch_id.trim() ? input.batch_id.trim() : null,
      secret_payload_json: JSON.stringify(secret),
      config_json: JSON.stringify(config),
      preview_json: typeof input?.preview_json === 'string' && input.preview_json.trim() ? input.preview_json : '{}',
      ...quotaColumnsFromConfig(JSON.stringify(config)),
      quota_updated_at: null,
      archived_at: null,
      transient_failure_count: 0,
      next_retry_at: null,
      cooldown_until: null,
      last_failure_kind: null,
      last_failure_message: null,
      last_failure_response_json: null,
      semantic_failure_streak_count: 0,
      semantic_failure_streak_fingerprint: null,
      external_source_client: null,
      external_source_id: null,
      created_at: now,
      updated_at: now,
    }
    await this.stores.accounts.update((document) => {
      document.credentials = [...(document.credentials ?? []), row]
    })
    return projectCredential(row, { batchName: await this.#batchName(row.batch_id) })
  }

  /** `update_route_credential`: a full replace of the eight editable fields. */
  async update(id, input) {
    const row = await this.requireRow(requireText(id, 'id'))
    if (row.status === 'revoked') {
      // Same behaviour as the reference's `AND status != 'revoked'`: a revoked row is
      // reported as missing rather than as a distinct refusal.
      throw validation('validation.route_credential_not_found', 'Account not found', id)
    }
    const displayName = requireText(input?.display_name, 'display_name', 200)
    const status = String(input?.status ?? '').trim()
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw validation('validation.route_credential_status', 'Unknown account status', status)
    }
    const priority = requireInt(input?.route_priority, 1, 5, 'validation.route_credential_priority', 'route_priority')
    const concurrency = requireInt(
      input?.max_concurrency,
      1,
      256,
      'validation.route_credential_concurrency',
      'max_concurrency',
    )
    const configJson = typeof input?.config_json === 'string' && input.config_json.trim() ? input.config_json : '{}'
    const config = parseJsonMaybe(configJson, null)
    if (config === null) {
      throw validation('validation.json', 'config_json must be a JSON object', 'config_json')
    }
    if (config.failure_policy !== undefined) {
      config.failure_policy = normalizeFailurePolicy(config.failure_policy)
    }
    const secretJson = isMaskedSecretPayload(input?.secret_payload_json)
      ? row.secret_payload_json
      : typeof input?.secret_payload_json === 'string' && input.secret_payload_json.trim()
        ? input.secret_payload_json
        : row.secret_payload_json

    await this.stores.accounts.update(() => {
      row.display_name = displayName
      row.email = typeof input?.email === 'string' && input.email.trim() ? input.email.trim() : null
      row.status = status
      row.route_priority = priority
      row.max_concurrency = concurrency
      row.secret_payload_json = secretJson
      row.config_json = JSON.stringify(config)
      row.preview_json =
        typeof input?.preview_json === 'string' && input.preview_json.trim() ? input.preview_json : row.preview_json
      Object.assign(row, quotaColumnsFromConfig(row.config_json))
      if (status === 'ok') {
        // Clearing the streak is part of the same statement in the reference.
        row.semantic_failure_streak_count = 0
        row.semantic_failure_streak_fingerprint = null
      }
      row.updated_at = nowIso()
    })
    return projectCredential(row, { batchName: await this.#batchName(row.batch_id) })
  }

  /** `copy_route_credential`. Cross-platform copies keep only what transfers. */
  async copy(id, input = {}) {
    const source = await this.requireRow(requireText(id, 'id'))
    const target = input?.target_platform ? parsePlatform(input.target_platform) : source.platform
    const apiKeyOverride = typeof input?.api_key === 'string' ? input.api_key.trim() : ''
    if (source.kind === 'official' && target !== source.platform) {
      throw validation('validation.official_cross_platform_copy', 'An official account cannot be copied to another platform', target)
    }
    if (source.kind === 'official' && apiKeyOverride.length > 0) {
      throw validation('validation.copy_api_key_unsupported', 'An official account has no API key to replace', id)
    }
    const sourceConfig = parseJsonMaybe(source.config_json, {}) ?? {}
    const sourceSecret = parseJsonMaybe(source.secret_payload_json, {}) ?? {}
    const samePlatform = target === source.platform
    const config = samePlatform
      ? structuredClone(sourceConfig)
      : convertConfigForPlatform(sourceConfig, target)
    const secret = structuredClone(sourceSecret)
    if (apiKeyOverride.length > 0) {
      secret.api_key = apiKeyOverride
    }
    const now = nowIso()
    const row = {
      ...structuredClone(source),
      id: uuid(),
      platform: target,
      display_name: `${source.display_name} ${now.slice(0, 10)}`,
      email: samePlatform ? source.email : null,
      batch_id: samePlatform ? source.batch_id : null,
      sort_order: await this.#nextSortOrder(target),
      secret_payload_json: JSON.stringify(secret),
      config_json: JSON.stringify(config),
      external_source_client: null,
      external_source_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    }
    Object.assign(row, quotaColumnsFromConfig(row.config_json))
    await this.stores.accounts.update((document) => {
      document.credentials = [...(document.credentials ?? []), row]
    })
    // Pool membership is inherited: a copy made to spread load is useless outside it.
    const members = await this.#poolMemberIds(source.platform)
    if (members.has(source.id)) {
      await this.addPoolMember(target, row.id)
    }
    return projectCredential(row, { batchName: await this.#batchName(row.batch_id) })
  }

  /** Hard delete, plus the pool row and the model health rows that pointed at it. */
  async remove(id) {
    const target = requireText(id, 'id')
    await this.requireRow(target)
    await this.stores.accounts.update((document) => {
      document.credentials = (document.credentials ?? []).filter((row) => row.id !== target)
      document.models = (document.models ?? []).filter((row) => row.route_credential_id !== target)
    })
    await this.stores.pool.update((document) => {
      document.members = (document.members ?? []).filter((member) => member.route_credential_id !== target)
    })
    return null
  }

  /** Soft delete: the account leaves every list but keeps its history. */
  async archive(ids) {
    const targets = new Set(requireIdList(ids, 'ids'))
    const stamp = nowIso()
    await this.stores.accounts.update((document) => {
      for (const row of document.credentials ?? []) {
        if (targets.has(row.id)) {
          row.archived_at = stamp
          row.updated_at = stamp
        }
      }
    })
    await this.stores.pool.update((document) => {
      document.members = (document.members ?? []).filter((member) => !targets.has(member.route_credential_id))
    })
    return null
  }

  async restore(ids) {
    const targets = new Set(requireIdList(ids, 'ids'))
    await this.stores.accounts.update((document) => {
      for (const row of document.credentials ?? []) {
        if (targets.has(row.id)) {
          row.archived_at = null
          row.updated_at = nowIso()
        }
      }
    })
    return null
  }

  async setStatuses(ids, status) {
    const targets = new Set(requireIdList(ids, 'ids'))
    if (!ACCOUNT_STATUSES.includes(String(status ?? '').trim())) {
      throw validation('validation.route_credential_status', 'Unknown account status', String(status ?? ''))
    }
    const next = String(status).trim()
    let touched = 0
    await this.stores.accounts.update((document) => {
      for (const row of document.credentials ?? []) {
        if (!targets.has(row.id)) {
          continue
        }
        touched += 1
        row.status = next
        if (next === 'ok') {
          row.semantic_failure_streak_count = 0
          row.semantic_failure_streak_fingerprint = null
        }
        row.updated_at = nowIso()
      }
    })
    if (touched === 0) {
      throw validation('validation.route_credential_selection_empty', 'No account in the selection', 'ids')
    }
    return null
  }

  /**
   * `reorder_route_credentials`: splice the moved row between its two neighbours and
   * rewrite `sort_order` for the whole platform, then answer with the page the moved
   * account ended up on — not the page the caller asked for.
   */
  async reorder(input) {
    const platform = parsePlatform(input?.platform)
    const movedId = requireText(input?.moved_account_id, 'moved_account_id')
    const pageSize = PAGE_SIZES.includes(Number(input?.page_size)) ? Number(input.page_size) : null
    if (pageSize === null) {
      throw validation('validation.route_credential_page_size', 'Unsupported page size', String(input?.page_size ?? ''))
    }
    const rows = (await this.#rows())
      .filter((row) => row.platform === platform)
      .sort((left, right) => left.sort_order - right.sort_order)
    const moved = rows.find((row) => row.id === movedId)
    if (moved === undefined) {
      throw validation('validation.route_credential_reorder', 'The moved account is not on this platform', movedId)
    }
    const rest = rows.filter((row) => row.id !== movedId)
    const previousId = typeof input?.previous_account_id === 'string' ? input.previous_account_id : null
    const nextId = typeof input?.next_account_id === 'string' ? input.next_account_id : null
    let index = rest.length
    if (previousId !== null) {
      const at = rest.findIndex((row) => row.id === previousId)
      if (at === -1) {
        throw validation('validation.route_credential_reorder', 'The neighbour is stale; reload the list', previousId)
      }
      index = at + 1
    } else if (nextId !== null) {
      const at = rest.findIndex((row) => row.id === nextId)
      if (at === -1) {
        throw validation('validation.route_credential_reorder', 'The neighbour is stale; reload the list', nextId)
      }
      index = at
    } else {
      index = 0
    }
    rest.splice(index, 0, moved)
    await this.stores.accounts.update(() => {
      rest.forEach((row, position) => {
        row.sort_order = position
        row.updated_at = nowIso()
      })
    })
    const page = Math.floor(index / pageSize) + 1
    return this.page({ ...input, platform, page, page_size: pageSize })
  }

  /** `set_route_credential_cooldown`. 0 lifts the wait but keeps the failure count. */
  async setCooldown(id, seconds) {
    const row = await this.requireRow(requireText(id, 'id'))
    const value = requireInt(seconds, 0, 86_400, 'validation.route_credential_cooldown_seconds', 'seconds')
    await this.stores.accounts.update(() => {
      row.cooldown_until = value === 0 ? null : new Date(Date.now() + value * 1000).toISOString()
      row.updated_at = nowIso()
    })
    return this.#full(row, { stats: false })
  }

  /** Reset the account-level failure state. Per-model rows are deliberately kept. */
  async clearFailureState(id) {
    const row = await this.requireRow(requireText(id, 'id'))
    await this.stores.accounts.update(() => {
      row.cooldown_until = null
      row.next_retry_at = null
      row.transient_failure_count = 0
      row.semantic_failure_streak_count = 0
      row.semantic_failure_streak_fingerprint = null
      row.last_failure_kind = null
      row.last_failure_message = null
      row.last_failure_response_json = null
      row.updated_at = nowIso()
    })
    return this.#full(row, { stats: false })
  }

  /** `set_route_credential_model_status`: only ok and paused; ok drops the row. */
  async setModelStatus(id, modelKey, status) {
    const row = await this.requireRow(requireText(id, 'id'))
    const key = requireText(modelKey, 'model_key', 512)
    const next = String(status ?? '').trim()
    if (!['ok', 'paused'].includes(next)) {
      throw validation('validation.route_credential_model_status', 'A model can only be set to ok or paused', next)
    }
    await this.stores.accounts.update((document) => {
      const models = document.models ?? []
      const existing = models.find((item) => item.route_credential_id === row.id && item.model_key === key)
      if (next === 'ok') {
        document.models = models.filter((item) => item !== existing)
        return
      }
      const now = nowIso()
      if (existing === undefined) {
        models.push({
          route_credential_id: row.id,
          model_key: key,
          status: 'paused',
          transient_failure_count: 0,
          cooldown_until: null,
          semantic_failure_streak_count: 0,
          semantic_failure_streak_fingerprint: null,
          last_failure_kind: null,
          last_failure_message: null,
          last_failure_response_json: null,
          created_at: now,
          updated_at: now,
        })
        document.models = models
        return
      }
      existing.status = 'paused'
      existing.updated_at = now
    })
    return this.#full(row, { stats: false })
  }

  /** Forget one model's failure state entirely. */
  async clearModelState(id, modelKey) {
    const row = await this.requireRow(requireText(id, 'id'))
    const key = requireText(modelKey, 'model_key', 512)
    await this.stores.accounts.update((document) => {
      document.models = (document.models ?? []).filter(
        (item) => !(item.route_credential_id === row.id && item.model_key === key),
      )
    })
    return this.#full(row, { stats: false })
  }

  /** `set_route_credential_recovery`: an `off` rule removes the key from config_json. */
  async setRecovery(id, rule) {
    const row = await this.requireRow(requireText(id, 'id'))
    const normalized = normalizeRecoveryRule(rule)
    await this.stores.accounts.update(() => {
      const config = parseJsonMaybe(row.config_json, {}) ?? {}
      if (normalized.mode === 'off') {
        delete config.recovery
      } else {
        config.recovery = normalized
      }
      row.config_json = JSON.stringify(config)
      row.updated_at = nowIso()
    })
    return this.#full(row, { stats: false })
  }

  /** Record a failure seen by the proxy: cooldown, status and last-failure details. */
  async recordFailure(id, { kind, message, responseJson = null, cooldownSeconds = 0, semanticFingerprint = null }) {
    const row = (await this.#rows()).find((item) => item.id === id)
    if (row === undefined) {
      return
    }
    await this.stores.accounts.update(() => {
      row.transient_failure_count = (row.transient_failure_count ?? 0) + 1
      row.last_failure_kind = kind ?? null
      row.last_failure_message = typeof message === 'string' ? message.slice(0, 2000) : null
      row.last_failure_response_json =
        typeof responseJson === 'string' ? responseJson.slice(0, 8192) : null
      if (cooldownSeconds > 0) {
        row.cooldown_until = new Date(Date.now() + cooldownSeconds * 1000).toISOString()
      }
      if (semanticFingerprint !== null) {
        row.semantic_failure_streak_count =
          row.semantic_failure_streak_fingerprint === semanticFingerprint
            ? (row.semantic_failure_streak_count ?? 0) + 1
            : 1
        row.semantic_failure_streak_fingerprint = semanticFingerprint
      }
      row.updated_at = nowIso()
    })
  }

  /** Record a success: the failure counters go back to zero. */
  async recordSuccess(id) {
    const row = (await this.#rows()).find((item) => item.id === id)
    if (row === undefined || (row.transient_failure_count ?? 0) === 0) {
      return
    }
    await this.stores.accounts.update(() => {
      row.transient_failure_count = 0
      row.next_retry_at = null
      row.updated_at = nowIso()
    })
  }

  /** `get_route_pool`: membership, model mode and the usage counters below the list. */
  async getPool(platform, options = {}) {
    const id = parsePlatform(platform)
    const document = await this.stores.pool.read()
    const members = (document.members ?? [])
      .filter((member) => member.platform === id)
      .sort((left, right) => left.sort_order - right.sort_order)
    return {
      platform: id,
      account_ids: members.map((member) => member.route_credential_id),
      model_mode: document.modes?.[id] === 'precise' ? 'precise' : 'aggregate',
      stats: this.ledger?.poolStats(id, { memberCount: members.length, ...options }) ?? emptyPoolStats(members.length),
    }
  }

  /** `set_route_pool_members`: the array IS the order, and it replaces the old one. */
  async setMembers(platform, accountIds) {
    const id = parsePlatform(platform)
    const ids = Array.isArray(accountIds) ? accountIds.map((value) => String(value ?? '').trim()).filter(Boolean) : []
    const rows = await this.#rows()
    for (const accountId of ids) {
      const row = rows.find((item) => item.id === accountId)
      if (row === undefined) {
        throw validation('validation.route_credential_not_found', 'Account not found', accountId)
      }
      if (row.platform !== id) {
        throw validation('validation.route_pool_platform_mismatch', 'That account belongs to another platform', accountId)
      }
    }
    const now = nowIso()
    await this.stores.pool.update((document) => {
      const others = (document.members ?? []).filter((member) => member.platform !== id)
      document.members = [
        ...others,
        ...ids.map((accountId, index) => ({
          id: uuid(),
          platform: id,
          route_credential_id: accountId,
          enabled: 1,
          sort_order: index,
          created_at: now,
          updated_at: now,
        })),
      ]
    })
    return this.getPool(id)
  }

  /** Append one account to a pool, keeping the existing order. */
  async addPoolMember(platform, accountId) {
    const current = await this.getPool(platform)
    if (current.account_ids.includes(accountId)) {
      return current
    }
    return this.setMembers(platform, [...current.account_ids, accountId])
  }

  async setModelMode(platform, mode) {
    const id = parsePlatform(platform)
    const value = mode === 'precise' ? 'precise' : 'aggregate'
    await this.stores.pool.update((document) => {
      document.modes = { ...(document.modes ?? {}), [id]: value }
    })
    return this.getPool(id)
  }

  /**
   * Pick the next account for one platform.
   *
   * Order of business, matching the reference's documented behaviour:
   *   1. pool members only, in the order the user dragged them into
   *   2. drop archived, paused, revoked, errored and cooling-down accounts
   *   3. drop accounts whose row for THIS model is paused, errored or cooling
   *   4. keep only the best `route_priority` band present (1 is the most preferred)
   *   5. rotate inside that band with a persisted cursor, skipping anyone already at
   *      `max_concurrency`
   *
   * `route_pool.concurrency_exhausted` and `validation.route_pool_empty` are different
   * answers on purpose: the first means "come back in a moment", the second means
   * "there is nothing configured".
   */
  async selectAccount(platform, { modelKey = null, exclude = [] } = {}) {
    const id = parsePlatform(platform)
    const pool = await this.getPool(id)
    const rows = await this.#rows()
    const document = await this.#document()
    const now = Date.now()
    const skipped = new Set(exclude)

    const eligible = pool.account_ids
      .map((accountId) => rows.find((row) => row.id === accountId))
      .filter((row) => row !== undefined && !skipped.has(row.id))
      .filter((row) => row.archived_at === null)
      .filter((row) => !['paused', 'revoked', 'error'].includes(row.status))
      .filter((row) => row.cooldown_until === null || Date.parse(row.cooldown_until) <= now)
      .filter((row) => {
        if (modelKey === null) {
          return true
        }
        const state = (document.models ?? []).find(
          (item) => item.route_credential_id === row.id && item.model_key === modelKey,
        )
        if (state === undefined) {
          return true
        }
        if (state.status === 'paused' || state.status === 'error') {
          return false
        }
        return state.cooldown_until === null || Date.parse(state.cooldown_until) <= now
      })

    if (eligible.length === 0) {
      throw validation('validation.route_pool_empty', 'No usable account in this pool', id)
    }
    const bestPriority = eligible.reduce((best, row) => Math.min(best, row.route_priority ?? 3), 5)
    const band = eligible.filter((row) => (row.route_priority ?? 3) === bestPriority)
    const cursor = (await this.stores.pool.read()).cursors?.[id] ?? 0
    for (let step = 0; step < band.length; step += 1) {
      const row = band[(cursor + step) % band.length]
      if ((this.activity?.count(row.id) ?? 0) < (row.max_concurrency ?? DEFAULT_MAX_CONCURRENCY)) {
        await this.stores.pool.update((pooldoc) => {
          pooldoc.cursors = { ...(pooldoc.cursors ?? {}), [id]: (cursor + step + 1) % band.length }
        })
        return row
      }
    }
    throw new ApiError('route_pool.concurrency_exhausted', 'Every account in this pool is at its concurrency limit', {
      details: id,
      recoverable: true,
    })
  }

  /** `route_pool_route_once`: pick an account and record one synthetic request. */
  async routeOnce(request) {
    const platform = parsePlatform(request?.platform)
    requireCapability(platform, 'generic_api_routing')
    const row = await this.selectAccount(platform)
    this.ledger?.record({
      platform,
      accountId: row.id,
      accountName: row.display_name,
      sourceLabel: 'route_pool',
      success: true,
      tokens: Number(request?.token_count ?? 0) || 0,
      costMicros: Number(request?.cost_micros ?? 0) || 0,
      metadataJson: typeof request?.metadata_json === 'string' ? request.metadata_json : '{}',
    })
    return {
      platform,
      selected_account_id: row.id,
      selected_account_name: row.display_name,
      stats: (await this.getPool(platform)).stats,
    }
  }
}


/** Model mappings: `[{from, to, label, supports_1m?, context_window?, reasoning_levels?}]`. */
export function validateModelMappings(json) {
  const list = json === undefined || json === null || String(json).trim().length === 0 ? [] : parseJsonMaybe(String(json), null)
  if (!Array.isArray(list)) {
    throw validation('validation.json', 'Model mappings must be a JSON array', 'model_mappings_json')
  }
  return list.map((entry) => {
    const from = String(entry?.from ?? '').trim()
    const to = String(entry?.to ?? '').trim()
    if (from.length === 0 || to.length === 0) {
      throw validation('validation.model_mapping', 'Every model mapping needs a from and a to', 'model_mappings')
    }
    if (from === MODEL_PLACEHOLDER || to === MODEL_PLACEHOLDER) {
      throw validation(
        'validation.model_mapping',
        `Model mapping still uses the ${MODEL_PLACEHOLDER} placeholder`,
        'model_mappings',
      )
    }
    const mapping = { from, to, label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : null }
    if (entry?.supports_1m === true) {
      mapping.supports_1m = true
    }
    if (typeof entry?.context_window === 'number' && Number.isFinite(entry.context_window) && entry.context_window > 0) {
      mapping.context_window = Math.trunc(entry.context_window)
    }
    if (Array.isArray(entry?.reasoning_levels)) {
      const levels = entry.reasoning_levels
        .map((level) => String(level ?? '').trim().toLowerCase())
        .filter((level) => level.length > 0)
      if (levels.length > 0) {
        mapping.reasoning_levels = Array.from(new Set(levels))
      }
    }
    return mapping
  })
}

/** Validate `config_json.failure_policy` if present; absent keys keep their default. */
export function normalizeFailurePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return null
  }
  const out = { ...FAILURE_POLICY_DEFAULTS }
  for (const [key, [min, max]] of Object.entries(FAILURE_POLICY_BOUNDS)) {
    if (policy[key] === undefined) {
      continue
    }
    out[key] = requireInt(
      policy[key],
      min,
      max,
      'validation.route_credential_failure_policy',
      `failure_policy.${key}`,
    )
  }
  for (const key of ['cooldown_enabled', 'error_status_enabled']) {
    if (typeof policy[key] === 'boolean') {
      out[key] = policy[key]
    }
  }
  return out
}


/** Batch filter: a batch id, or the `__single__` sentinel for unbatched rows. */
function matchesFilters(row, filters) {
  for (const filter of filters) {
    if (filter === '__single__' && (row.batch_id === null || row.batch_id === undefined)) {
      return true
    }
    if (row.batch_id === filter) {
      return true
    }
  }
  return false
}

/** `fetched_models_json`: `[{id, owned_by?, supports_1m?}]` with non-blank ids. */
export function validateFetchedModels(json) {
  if (json === undefined || json === null || String(json).trim().length === 0) {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(String(json))
  } catch {
    throw validation('validation.fetched_models', 'Fetched models must be a JSON array', 'fetched_models_json')
  }
  if (!Array.isArray(parsed)) {
    throw validation('validation.fetched_models', 'Fetched models must be a JSON array', 'fetched_models_json')
  }
  return parsed.map((entry) => {
    const id = String(entry?.id ?? '').trim()
    if (id.length === 0) {
      throw validation('validation.fetched_models', 'Every fetched model needs an id', 'fetched_models_json')
    }
    const model = { id }
    if (typeof entry?.owned_by === 'string' && entry.owned_by.trim().length > 0) {
      model.owned_by = entry.owned_by.trim()
    }
    if (entry?.supports_1m === true) {
      model.supports_1m = true
    }
    return model
  })
}

/** `api_key_field` only exists for Anthropic upstreams, and only takes two values. */
export function normalizeApiKeyField(value, interfaceFormat) {
  const field = typeof value === 'string' ? value.trim() : ''
  if (field.length === 0) {
    return null
  }
  if (interfaceFormat !== 'anthropic') {
    throw validation('validation.api_key_field', 'Only an Anthropic upstream chooses its key header', field)
  }
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(field)) {
    throw validation('validation.api_key_field', 'Unsupported Anthropic key header', field)
  }
  return field
}

/**
 * Relay balance provider at creation time.
 *
 * `custom` is refused here on purpose: it needs an endpoint and JSON paths, and the
 * creation form has nowhere to type them. Editing the account afterwards can set it.
 */
export function normalizeRelayProvider(value) {
  const provider = typeof value === 'string' ? value.trim() : ''
  if (provider.length === 0 || provider === 'none') {
    return null
  }
  if (!['new_api', 'sub2api'].includes(provider)) {
    throw validation('validation.relay_balance_provider', 'Unsupported relay balance provider', provider)
  }
  return provider
}

/**
 * What survives a cross-platform copy.
 *
 * Model mappings, fetched models and the Anthropic key header are all platform-specific,
 * so they are dropped rather than carried into a config where they would be wrong. The
 * base URL is rewritten for the target dialect, because the same relay is reached at
 * `…/v1` for the OpenAI protocols and at the bare root for Anthropic.
 */
export function convertConfigForPlatform(config, target) {
  const dialect = defaultApiDialect(target) ?? String(config.interface_format ?? 'openai')
  const baseUrl = convertBaseUrl(String(config.base_url ?? ''), dialect)
  if (baseUrl === null) {
    throw validation('validation.copy_base_url', 'That base URL cannot be converted for the target platform', String(config.base_url ?? ''))
  }
  const next = { base_url: baseUrl, interface_format: dialect, model_mappings: [], fetched_models: [] }
  for (const key of ['headers', 'failure_policy', 'recovery']) {
    if (config[key] !== undefined) {
      next[key] = structuredClone(config[key])
    }
  }
  return next
}

/** `/v1` for the OpenAI protocols, bare for Anthropic, untouched for Gemini. */
export function convertBaseUrl(baseUrl, dialect) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (trimmed.length === 0) {
    return null
  }
  if (dialect === 'gemini') {
    return trimmed
  }
  if (dialect === 'anthropic') {
    return trimmed.replace(/\/v1$/i, '')
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/**
 * A stored row for an imported account, official or api.
 *
 * Shared by every importer (pasted text, CPA files, cc-switch) so they cannot drift on
 * defaults. `sortOrder` and the id are the caller's business.
 */
export function buildCredentialRow({
  id,
  platform,
  kind,
  displayName,
  email = null,
  secret,
  config,
  previewJson = '{}',
  batchId = null,
  sortOrder = 0,
  externalSourceClient = null,
  externalSourceId = null,
}) {
  const now = nowIso()
  const configJson = typeof config === 'string' ? config : JSON.stringify(config ?? {})
  return {
    id: id ?? uuid(),
    platform,
    kind,
    display_name: displayName,
    email,
    status: 'ok',
    sort_order: sortOrder,
    route_priority: DEFAULT_ROUTE_PRIORITY,
    max_concurrency: DEFAULT_MAX_CONCURRENCY,
    batch_id: batchId,
    secret_payload_json: typeof secret === 'string' ? secret : JSON.stringify(secret ?? {}),
    config_json: configJson,
    preview_json: previewJson,
    ...quotaColumnsFromConfig(configJson),
    quota_updated_at: null,
    archived_at: null,
    transient_failure_count: 0,
    next_retry_at: null,
    cooldown_until: null,
    last_failure_kind: null,
    last_failure_message: null,
    last_failure_response_json: null,
    semantic_failure_streak_count: 0,
    semantic_failure_streak_fingerprint: null,
    external_source_client: externalSourceClient,
    external_source_id: externalSourceId,
    created_at: now,
    updated_at: now,
  }
}

/** Pool counters before any request has been proxied. */
export function emptyPoolStats(memberCount) {
  return {
    member_count: memberCount,
    request_count: 0,
    token_count: 0,
    input_token_count: 0,
    output_token_count: 0,
    cache_token_count: 0,
    cost_micros: 0,
    recent_logs: [],
    requests: [],
    request_row_count: 0,
    request_page: 1,
    request_page_size: 20,
  }
}
