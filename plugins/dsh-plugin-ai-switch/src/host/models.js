/**
 * The model catalog: which model ids the pool advertises, and what they map to upstream.
 *
 * Two questions, one answer set:
 *
 * 1. What the local CLI is told exists — `GET /v1/models` on the proxy, and the model rows
 *    written into every client config that wants them.
 * 2. What an incoming request's model name resolves to — which account serves it and what
 *    to call the model upstream.
 *
 * The client-facing name and the upstream name are NOT the same thing. An account declares
 * mappings (`claude-sonnet-alias` -> `glm-5.3`); the alias is what Claude Code asks for and
 * the target is what the relay is asked for. `aggregate` mode merges the pool into one word
 * list; `precise` mode prefixes every id with the account so a request can name the account
 * it wants.
 *
 * @module dsh-plugin-ai-switch/host/models
 */
import { CLIENT_ALIASES, FALLBACK_MODEL_ALIAS } from './accounts.js'

/** Reference constants: what Codex is told when a mapping declares no window. */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 128_000
export const CODEX_ONE_M_CONTEXT_WINDOW = 1_000_000

/** Upstream families that really serve 1M, matched on the start of the mapped-to name. */
const ONE_M_PREFIXES = ['deepseek-v4', 'glm-5.2', 'glm-5.3', 'qwen-3.8', 'kimi-k3']

/** Every non-Codex client model row gets this window when nothing declares one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** The response cap written into every client model row. */
export const MAX_OUTPUT_TOKENS = 128_000

/** Reasoning levels per Codex model, and the default the catalog advertises. */
const CODEX_REASONING = {
  'gpt-5.6-sol': { levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'low' },
  'gpt-5.6-terra': { levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'medium' },
  'gpt-5.6-luna': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
  'gpt-5.5': { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
}

const DEFAULT_REASONING = { levels: ['low', 'medium', 'high'], default: 'medium' }

/** The window Codex is told about for one upstream model name. */
export function codexDefaultContextWindow(upstreamModel) {
  const name = String(upstreamModel ?? '').trim().toLowerCase()
  const bare = name.split('/').pop() ?? name
  return ONE_M_PREFIXES.some((prefix) => name.startsWith(prefix) || bare.startsWith(prefix))
    ? CODEX_ONE_M_CONTEXT_WINDOW
    : CODEX_DEFAULT_CONTEXT_WINDOW
}

function parseConfig(row) {
  try {
    const parsed = JSON.parse(String(row?.config_json ?? '{}'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** A short, stable prefix for one account in `precise` mode. */
export function accountPrefix(row) {
  const name = String(row?.display_name ?? '').trim()
  const slug = name
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\w一-鿿.-]/g, '')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : row.id.slice(0, 8)
}

/**
 * One account's contributions: `{alias, upstreamModel, contextWindow, reasoningLevels}`.
 *
 * An account with no mappings still contributes: the per-platform client aliases map
 * straight through to the same name upstream, which is what an official account or a relay
 * that already speaks the vendor's own names needs.
 */
export function contributionsFor(row, platform) {
  const config = parseConfig(row)
  const mappings = Array.isArray(config.model_mappings) ? config.model_mappings : []
  const out = []
  for (const mapping of mappings) {
    const alias = String(mapping?.from ?? '').trim()
    const upstream = String(mapping?.to ?? '').trim()
    if (alias.length === 0 || upstream.length === 0) {
      continue
    }
    // The catch-all alias is a routing fallback, never a catalog entry: advertising it
    // would put `claude-model` in front of the user as if it were a model.
    const declared = Number.isFinite(mapping?.context_window) && mapping.context_window > 0 ? Math.trunc(mapping.context_window) : null
    out.push({
      alias,
      upstreamModel: upstream,
      contextWindow: declared,
      reasoningLevels: Array.isArray(mapping?.reasoning_levels) ? mapping.reasoning_levels : null,
      supports1m: mapping?.supports_1m === true,
      label: typeof mapping?.label === 'string' && mapping.label.trim().length > 0 ? mapping.label.trim() : null,
      advertised: alias !== FALLBACK_MODEL_ALIAS,
    })
  }
  if (out.length > 0) {
    return out
  }
  return (CLIENT_ALIASES[platform] ?? []).map((alias) => ({
    alias,
    upstreamModel: alias,
    contextWindow: null,
    reasoningLevels: null,
    supports1m: false,
    label: null,
    advertised: true,
  }))
}

/** The window one entry claims: declared first, then the platform's own rule. */
export function contextWindowFor(platform, contribution) {
  if (contribution.contextWindow !== null) {
    return contribution.contextWindow
  }
  if (platform === 'codex') {
    return codexDefaultContextWindow(contribution.upstreamModel)
  }
  if (contribution.supports1m || /\[1m\]$/i.test(contribution.alias)) {
    return CODEX_ONE_M_CONTEXT_WINDOW
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * The catalog for one pool: what `/v1/models` returns and what client configs are written
 * with, in pool order, deduplicated by id.
 *
 * @param members - account rows, already filtered to the pool and in its order.
 */
export function buildCatalog({ platform, members, mode = 'aggregate' }) {
  const byId = new Map()
  for (const row of members) {
    const prefix = accountPrefix(row)
    for (const contribution of contributionsFor(row, platform)) {
      if (!contribution.advertised) {
        continue
      }
      const id = mode === 'precise' ? `${prefix}/${contribution.alias}` : contribution.alias
      if (byId.has(id)) {
        continue
      }
      // Keyed by the bare ALIAS, never by the upstream name or the precise-mode id: the
      // table knows `gpt-5.6-sol`, and a relay serving it as `glm-5.3` still offers the
      // efforts the Codex client will ask for.
      const profile = CODEX_REASONING[contribution.alias.toLowerCase()] ?? DEFAULT_REASONING
      const reasoning = contribution.reasoningLevels ?? (platform === 'codex' ? profile.levels : null)
      const defaultLevel = platform === 'codex' ? profile.default : null
      byId.set(id, {
        id,
        owned_by: PROVIDER_OWNER,
        description: contribution.label ?? `${row.display_name} · ${contribution.upstreamModel}`,
        context_window: contextWindowFor(platform, contribution),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        supported_reasoning_levels: reasoning === null ? [] : reasoning.map((effort) => ({ effort })),
        default_reasoning_level: defaultLevel,
        upstream_model: contribution.upstreamModel,
        account_id: row.id,
      })
    }
  }
  return Array.from(byId.values())
}

/** `owned_by` on every advertised model — the pool, not the upstream vendor. */
export const PROVIDER_OWNER = 'ai-switch'

/** The `{id, context_window, max_output_tokens}` rows a client config wants. */
export function clientModelRows(catalog) {
  return catalog.map((model) => ({
    id: model.id,
    context_window: model.context_window,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  }))
}

/** The `/v1/models` body: OpenAI's list shape, with the extras Codex reads. */
export function modelsListBody(catalog) {
  return {
    object: 'list',
    data: catalog.map((model) => ({
      id: model.id,
      object: 'model',
      owned_by: model.owned_by,
      created: 0,
      description: model.description,
      context_window: model.context_window,
      max_context_window: model.context_window,
      max_output_tokens: model.max_output_tokens,
      ...(model.supported_reasoning_levels.length > 0
        ? { supported_reasoning_levels: model.supported_reasoning_levels }
        : {}),
      ...(model.default_reasoning_level === null ? {} : { default_reasoning_level: model.default_reasoning_level }),
    })),
  }
}

/**
 * `~/.codex/ai-switch-model-catalog.json`.
 *
 * Codex reads this file for the model picker, and it is written OUTSIDE the snapshot
 * machinery — the reference does the same, and a rollback deliberately leaves it behind,
 * because a `config.toml` that no longer names it cannot be affected by it.
 */
export function codexCatalogBody(catalog) {
  return {
    models: catalog.map((model, index) => ({
      additional_speed_tiers: [],
      availability_nux: null,
      base_instructions:
        "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
      context_window: model.context_window,
      default_reasoning_level: model.default_reasoning_level ?? 'medium',
      default_reasoning_summary: 'none',
      description: model.description,
      display_name: model.id,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text', 'image'],
      max_context_window: model.context_window,
      priority: index + 1,
      service_tiers: [],
      shell_type: 'shell_command',
      slug: model.id,
      support_verbosity: false,
      supported_in_api: true,
      supported_reasoning_levels: model.supported_reasoning_levels.map((level) => level.effort),
      supports_image_detail_original: false,
      supports_parallel_tool_calls: false,
      supports_reasoning_summaries: true,
      supports_search_tool: false,
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      upgrade: null,
      visibility: 'list',
    })),
  }
}

/**
 * What one account should be asked for, given the model the client requested.
 *
 * Resolution order, and the reason for each step:
 *   1. exact alias in this account's mappings — the normal case
 *   2. `precise` mode's `prefix/alias` form, once the prefix has been stripped by the caller
 *   3. a `[1m]`-suffixed alias falls back to the bare one, because the suffix is a tier
 *      marker the pool adds, not something the upstream knows
 *   4. the catch-all `claude-model` mapping, which exists precisely so a client asking for a
 *      model nobody declared still gets served
 *   5. the requested name itself, unchanged — correct for a relay that already speaks the
 *      vendor's own model names
 */
export function upstreamModelFor(row, platform, requested) {
  const asked = String(requested ?? '').trim()
  const contributions = contributionsFor(row, platform)
  const exact = contributions.find((entry) => entry.alias === asked)
  if (exact !== undefined) {
    return exact.upstreamModel
  }
  const bare = asked.replace(/\[1m\]$/i, '')
  const stripped = contributions.find((entry) => entry.alias === bare)
  if (stripped !== undefined) {
    return stripped.upstreamModel
  }
  const fallback = contributions.find((entry) => entry.alias === FALLBACK_MODEL_ALIAS)
  if (fallback !== undefined) {
    return fallback.upstreamModel
  }
  return asked
}

/** Strip a `precise`-mode prefix, returning `{prefix, alias}`. */
export function splitPreciseId(id) {
  const text = String(id ?? '')
  const at = text.indexOf('/')
  if (at <= 0) {
    return { prefix: null, alias: text }
  }
  return { prefix: text.slice(0, at), alias: text.slice(at + 1) }
}



