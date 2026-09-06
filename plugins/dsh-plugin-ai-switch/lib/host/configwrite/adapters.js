/**
 * One adapter per (client, platform): where its config lives, and what to write into it.
 *
 * Every adapter is a pure function of (existing file text, route input) to new file text.
 * Nothing here touches the filesystem — `index.js` owns reading, hashing, snapshotting and
 * the atomic replace, so an adapter can be tested by handing it a string.
 *
 * The rule every adapter follows: **preserve what we do not own**. These are files the
 * user configured by hand — other providers, MCP servers, approval policies, comments —
 * and the write is supposed to add one provider entry, not normalize the document. An
 * existing file that cannot be parsed is a refusal (`validation.route_config_existing_invalid`),
 * never an overwrite.
 *
 * @module dsh-plugin-ai-switch/host/configwrite/adapters
 */
import { join } from 'node:path'

import { ApiError } from '../../shared/protocol.js'
import { edit as tomlEdit, hasTable, rootString, tomlString } from './toml.js'
import { hasPath, readBlock, scalar, setBlock } from './yaml.js'

/** Provider id, and the marker the adapters recognize their own entry by. */
export const PROVIDER_ID = 'ai-switch'

/** The side file Codex reads its model catalog from. */
export const CODEX_CATALOG_FILE = 'ai-switch-model-catalog.json'

/** Every client model row carries this cap; it is a constant in the reference too. */
export const MAX_OUTPUT_TOKENS = 128_000

const invalidExisting = (path, why) =>
  new ApiError('validation.route_config_existing_invalid', 'The existing configuration file could not be parsed', {
    details: `${path}: ${why}`,
    recoverable: false,
  })

const generatedInvalid = (path, why) =>
  new ApiError('config.generated_invalid', 'The configuration we generated is not valid', {
    details: `${path}: ${why}`,
    recoverable: false,
  })

/** `https://host/path/` -> `https://host/path`. */
export function baseUrlRoot(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/** Same, plus `/v1` unless the last segment already is `v1`. */
export function baseUrlWithV1(url) {
  const root = baseUrlRoot(url)
  return /\/v1$/i.test(root) ? root : `${root}/v1`
}

/** Parse an existing JSON config, or refuse. An empty file is an empty document. */
function parseJsonConfig(path, text) {
  const body = String(text ?? '').trim()
  if (body.length === 0) {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw invalidExisting(path, String(error?.message ?? error))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidExisting(path, 'the root value is not an object')
  }
  return parsed
}

/** Serialize and re-parse, so a bug in an adapter cannot ship a broken file. */
function renderJson(path, value, { pretty = true } = {}) {
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value)
  try {
    JSON.parse(text)
  } catch (error) {
    throw generatedInvalid(path, String(error?.message ?? error))
  }
  return text
}

/** The `aiSwitch` marker an adapter stamps on its own entry. */
function marker(platform) {
  return { managed: true, platform }
}

function isOurs(entry, platform) {
  return entry?.aiSwitch?.managed === true && entry?.aiSwitch?.platform === platform
}

/** True when a hand-made entry is really ours: same endpoint, and a key we minted. */
function matchesEndpointAndKey(entry, { url, key, aliases }, urlField = 'baseURL', keyField = 'apiKey') {
  const candidate = baseUrlRoot(entry?.[urlField] ?? entry?.options?.[urlField] ?? '')
  if (candidate.length === 0 || candidate !== baseUrlRoot(url)) {
    return false
  }
  const candidateKey = String(entry?.[keyField] ?? entry?.options?.[keyField] ?? '').trim()
  return candidateKey.length > 0 && (candidateKey === key || aliases.includes(candidateKey))
}

/**
 * Codex CLI — `~/.codex/config.toml`.
 *
 * Three root-level facts and one provider table, edited in place so the rest of the file
 * (other providers, mcp_servers, approval_policy, every comment) is byte-identical
 * afterwards. `api_key` is deleted from our table on every write: it is a legacy field and
 * a stale value there outranks the bearer token.
 */
const codexAdapter = {
  targetKey: 'codex',
  clientKey: 'codex',
  clientDisplayName: 'Codex',
  platform: 'codex',
  native: true,
  restartRequired: false,
  requiresClientModels: false,
  resolvePath: (home) => join(home, '.codex', 'config.toml'),
  render(path, existing, input) {
    return tomlEdit(existing ?? '', {
      root: {
        model_provider: tomlString(PROVIDER_ID),
        model_catalog_json: tomlString(CODEX_CATALOG_FILE),
      },
      table: {
        name: `model_providers.${PROVIDER_ID}`,
        entries: {
          name: tomlString('AI Switch Route Proxy'),
          base_url: tomlString(baseUrlWithV1(input.baseUrl)),
          wire_api: tomlString('responses'),
          experimental_bearer_token: tomlString(input.proxyKey),
          api_key: null,
        },
      },
    })
  },
  inspect(path, existing) {
    return status(path, existing, (text) =>
      rootString(text, 'model_provider') === PROVIDER_ID && hasTable(text, `model_providers.${PROVIDER_ID}`),
    )
  },
}

/** The env keys and directory each vendor CLI reads, keyed by client. */
const JSON_AGENTS = {
  claude_code: {
    platform: 'claude',
    dir: '.claude',
    displayName: 'Claude Code',
    baseUrlKeys: ['ANTHROPIC_BASE_URL'],
    authKeys: ['ANTHROPIC_AUTH_TOKEN'],
    claudeModelEnv: true,
  },
  gemini_cli: {
    platform: 'gemini',
    dir: '.gemini',
    displayName: 'Gemini CLI',
    baseUrlKeys: ['GEMINI_API_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
    // Deliberately no credential: the env var name Gemini CLI reads for a custom endpoint
    // has never been verified, and writing a guess would leak the key into a file for
    // nothing. The pool accepts the request without one from loopback.
    authKeys: [],
    claudeModelEnv: false,
  },
  grok: {
    platform: 'grok',
    dir: '.grok',
    displayName: 'Grok',
    baseUrlKeys: ['XAI_API_BASE_URL', 'GROK_API_BASE_URL'],
    authKeys: [],
    claudeModelEnv: false,
  },
}

/** The four Claude model slots, in the fixed order the reference writes them. */
export const CLAUDE_MODEL_SLOTS = [
  { model: 'ANTHROPIC_DEFAULT_SONNET_MODEL', name: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' },
  { model: 'ANTHROPIC_DEFAULT_OPUS_MODEL', name: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME' },
  { model: 'ANTHROPIC_DEFAULT_FABLE_MODEL', name: 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME' },
  { model: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME' },
]

/** Legacy keys the reference removes from `env` on every write. */
const LEGACY_ENV_KEYS = ['AI_SWITCH_ROUTE_PROXY', 'AI_SWITCH_ROUTE_PROXY_API_KEY']

/**
 * Claude Code / Gemini CLI / Grok — `~/<dir>/settings.json`.
 *
 * One `aiSwitch.routeProxy` block the panel reads back, plus the vendor's own base-url and
 * auth env vars. Every other root key is preserved.
 *
 * The Claude half also mirrors the model slots into `env` and merges the pool-wide client
 * config into the root. That merge is authoritative and tracks what it wrote in
 * `aiSwitch.managedClientKeys`, so a key removed from the config is removed from the file —
 * but a key we never recorded is never touched.
 */
function makeJsonAgentAdapter(clientKey) {
  const spec = JSON_AGENTS[clientKey]
  return {
    targetKey: clientKey,
    clientKey,
    clientDisplayName: spec.displayName,
    platform: spec.platform,
    native: true,
    restartRequired: false,
    requiresClientModels: false,
    resolvePath: (home) => join(home, spec.dir, 'settings.json'),
    render(path, existing, input) {
      const root = parseJsonConfig(path, existing)
      const hadContent = String(existing ?? '').trim().length > 0
      const env = root.env !== null && typeof root.env === 'object' && !Array.isArray(root.env) ? root.env : {}
      for (const key of spec.baseUrlKeys) {
        env[key] = baseUrlRoot(input.baseUrl)
      }
      for (const key of spec.authKeys) {
        env[key] = input.proxyKey
      }
      for (const key of LEGACY_ENV_KEYS) {
        delete env[key]
      }
      if (spec.claudeModelEnv) {
        applyClaudeModelEnv(env, input.claudeEnv ?? {})
      }
      const previouslyManaged = Array.isArray(root.aiSwitch?.managedClientKeys)
        ? root.aiSwitch.managedClientKeys.map((value) => String(value))
        : []
      root.aiSwitch = {
        routeProxy: {
          enabled: true,
          baseUrl: baseUrlRoot(input.baseUrl),
          platform: spec.platform,
          apiKey: input.proxyKey,
        },
      }
      root.env = env
      if (spec.claudeModelEnv) {
        applyClaudeClientConfig(root, previouslyManaged, input.claudeEnv?.clientConfig ?? {})
      }
      // Pretty only when the file already had content — matching the reference, whose
      // serializer is compact for a file it creates from nothing.
      return renderJson(path, root, { pretty: hadContent })
    },
    inspect(path, existing) {
      return status(path, existing, (text) => parseJsonConfig(path, text)?.aiSwitch?.routeProxy?.enabled === true)
    },
  }
}

/** Set-or-delete: an empty value removes the key rather than writing an empty string. */
function setOrDelete(env, key, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    delete env[key]
    return
  }
  env[key] = text
}

function applyClaudeModelEnv(env, claudeEnv) {
  setOrDelete(env, 'CLAUDE_CODE_SUBAGENT_MODEL', claudeEnv.subagentModel)
  setOrDelete(env, 'ANTHROPIC_MODEL', claudeEnv.fallbackModel)
  const slots = Array.isArray(claudeEnv.slots) ? claudeEnv.slots : []
  CLAUDE_MODEL_SLOTS.forEach((slot, index) => {
    setOrDelete(env, slot.model, slots[index]?.model)
    setOrDelete(env, slot.name, slots[index]?.displayName)
  })
}

function applyClaudeClientConfig(root, previouslyManaged, clientConfig) {
  const keys = Object.keys(clientConfig ?? {})
  for (const key of previouslyManaged) {
    if (!keys.includes(key)) {
      delete root[key]
    }
  }
  for (const [key, value] of Object.entries(clientConfig ?? {})) {
    root[key] = value
  }
  if (keys.length === 0) {
    delete root.aiSwitch.managedClientKeys
    return
  }
  root.aiSwitch.managedClientKeys = keys.slice().sort()
}

/**
 * OpenCode — `~/.config/opencode/opencode.json` (that literal path on every OS).
 *
 * `$schema` is written only when absent so an existing pin is respected, and the root
 * `model` is only set when the pool actually advertises something.
 */
const openCodeAdapter = {
  targetKey: 'opencode',
  clientKey: 'opencode',
  clientDisplayName: 'OpenCode',
  platform: 'opencode',
  native: true,
  restartRequired: false,
  requiresClientModels: true,
  resolvePath: (home) => join(home, '.config', 'opencode', 'opencode.json'),
  render(path, existing, input) {
    const root = parseJsonConfig(path, existing)
    if (typeof root.$schema !== 'string' || root.$schema.trim().length === 0) {
      root.$schema = 'https://opencode.ai/config.json'
    }
    const providers = root.provider !== null && typeof root.provider === 'object' ? root.provider : {}
    const previous = providers[PROVIDER_ID] ?? {}
    const options = previous.options !== null && typeof previous.options === 'object' ? { ...previous.options } : {}
    options.baseURL = baseUrlWithV1(input.baseUrl)
    options.apiKey = input.proxyKey
    providers[PROVIDER_ID] = {
      ...previous,
      npm: '@ai-sdk/openai-compatible',
      name: typeof previous.name === 'string' && previous.name.trim().length > 0 ? previous.name : 'AI Switch',
      options,
      models: Object.fromEntries(
        (input.clientModels ?? []).map((model) => [
          model.id,
          { limit: { context: model.context_window, output: MAX_OUTPUT_TOKENS } },
        ]),
      ),
    }
    root.provider = providers
    const first = (input.clientModels ?? [])[0]
    if (first !== undefined) {
      root.model = `${PROVIDER_ID}/${first.id}`
    }
    return renderJson(path, root)
  },
  inspect(path, existing) {
    return status(path, existing, (text) => {
      const entry = parseJsonConfig(path, text)?.provider?.[PROVIDER_ID]
      return entry !== null && typeof entry === 'object'
    })
  },
}

/**
 * OpenClaw — `~/.openclaw/openclaw.json`.
 *
 * Documented as JSON5 but parsed here as strict JSON: a file with comments is refused
 * rather than silently rewritten without them. `models.mode` is only written when absent,
 * so a deliberate `replace` is never downgraded to `merge`.
 */
const openClawAdapter = {
  targetKey: 'openclaw',
  clientKey: 'openclaw',
  clientDisplayName: 'OpenClaw',
  platform: 'openclaw',
  native: true,
  restartRequired: false,
  requiresClientModels: true,
  resolvePath: (home) => join(home, '.openclaw', 'openclaw.json'),
  render(path, existing, input) {
    const root = parseJsonConfig(path, existing)
    const models = requireObject(path, root.models, 'models') ?? {}
    if (typeof models.mode !== 'string' || models.mode.trim().length === 0) {
      models.mode = 'merge'
    }
    const providers = requireObject(path, models.providers, 'models.providers') ?? {}
    const previous = requireObject(path, providers[PROVIDER_ID], `models.providers.${PROVIDER_ID}`) ?? {}
    providers[PROVIDER_ID] = {
      ...previous,
      baseUrl: baseUrlWithV1(input.baseUrl),
      apiKey: input.proxyKey,
      api: 'openai-completions',
      models: (input.clientModels ?? []).map((model) => ({
        id: model.id,
        contextWindow: model.context_window,
        maxTokens: MAX_OUTPUT_TOKENS,
      })),
    }
    models.providers = providers
    root.models = models
    const first = (input.clientModels ?? [])[0]
    if (first !== undefined) {
      const agents = requireObject(path, root.agents, 'agents') ?? {}
      const defaults = requireObject(path, agents.defaults, 'agents.defaults') ?? {}
      const model = requireObject(path, defaults.model, 'agents.defaults.model') ?? {}
      model.primary = `${PROVIDER_ID}/${first.id}`
      defaults.model = model
      agents.defaults = defaults
      root.agents = agents
    }
    return renderJson(path, root)
  },
  inspect(path, existing) {
    return status(path, existing, (text) => {
      const entry = parseJsonConfig(path, text)?.models?.providers?.[PROVIDER_ID]
      return entry !== null && typeof entry === 'object'
    })
  },
}

/** A value that must be an object if it exists at all; anything else refuses the write. */
function requireObject(path, value, label) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidExisting(path, `${label} is not an object`)
  }
  return value
}

/**
 * Hermes — `$HERMES_HOME/config.yaml`, else `~/.hermes/config.yaml`.
 *
 * Two top-level sections are replaced (`custom_providers:` and `model:`); everything else
 * in the file, comments included, is carried through untouched.
 *
 * `api_key` is written inline on purpose: Hermes otherwise derives an env var name from
 * the endpoint HOST, and a loopback host matches nothing. Per-model metadata is
 * `context_length` only — Hermes warns on every start about fields it does not know.
 */
const hermesAdapter = {
  targetKey: 'hermes',
  clientKey: 'hermes',
  clientDisplayName: 'Hermes',
  platform: 'hermes',
  native: true,
  restartRequired: false,
  requiresClientModels: true,
  resolvePath: (home, env = process.env) => {
    const override = String(env.HERMES_HOME ?? '').trim()
    // A relative override is ignored deliberately: the rollback guard re-resolves this
    // path and compares it to the recorded one, which only works for absolute paths.
    const base = override.length > 0 && isAbsolutePath(override) ? override : join(home, '.hermes')
    return join(base, 'config.yaml')
  },
  render(path, existing, input) {
    const url = baseUrlWithV1(input.baseUrl)
    const models = input.clientModels ?? []
    const provider = [
      `- name: ${scalar(PROVIDER_ID)}`,
      `  base_url: ${scalar(url)}`,
      `  api_key: ${scalar(input.proxyKey)}`,
      '  api_mode: chat_completions',
    ]
    if (models.length > 0) {
      provider.push(`  model: ${scalar(models[0].id)}`)
      provider.push('  models:')
      for (const model of models) {
        provider.push(`    ${scalar(model.id)}:`)
        provider.push(`      context_length: ${model.context_window}`)
      }
    }
    const modelSection = [
      `provider: ${scalar(PROVIDER_ID)}`,
      `base_url: ${scalar(url)}`,
      'api_mode: chat_completions',
    ]
    if (models.length > 0) {
      modelSection.push(`default: ${scalar(models[0].id)}`)
    }
    let text = setBlock(existing ?? '', ['custom_providers'], provider)
    text = setBlock(text, ['model'], modelSection)
    if (!hasPath(text, ['custom_providers']) || !hasPath(text, ['model'])) {
      throw generatedInvalid(path, 'the generated file is missing a section we just wrote')
    }
    return text
  },
  inspect(path, existing) {
    return status(path, existing, (text) => {
      const block = readBlock(text, ['custom_providers'])
      return block !== null && block.some((line) => new RegExp(`^\\s*-\\s*name:\\s*'?${PROVIDER_ID}'?\\s*$`).test(line))
    })
  },
}

/** `path.isAbsolute` without importing the whole module twice. */
function isAbsolutePath(value) {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(String(value ?? ''))
}

/**
 * DeepSeek Harness — dsh's own `settings.yaml`, one provider under `llm-pi-ai.providers`.
 *
 * This is the adapter that points the shell this plugin lives in at the pool, which makes
 * it the most interesting target of the seventeen: after a write, dsh's own agent can run
 * on whichever account the pool picks.
 *
 * Auth rides an `Authorization: Bearer …` header rather than `apiKeyEnv`, because a
 * dangling credential reference fails the harness with MISSING_CREDENTIAL. No per-model
 * `maxTokens` either — the harness reads that as a hard cap on the response.
 *
 * The block is replaced wholesale (it is ours, and the marker says so); every other
 * provider, and every comment in the file, is left exactly as it was.
 */
function makeHarnessAdapter(platform) {
  const id = `${PROVIDER_ID}-${platform}`
  const label = platform === 'codex' ? 'AI Switch (Codex)' : 'AI Switch (Claude)'
  return {
    targetKey: `deepseek_harness_${platform}`,
    clientKey: `deepseek_harness_${platform}`,
    clientDisplayName: platform === 'codex' ? 'DeepSeek Harness (Codex)' : 'DeepSeek Harness (Claude)',
    platform,
    native: false,
    restartRequired: true,
    requiresClientModels: true,
    resolvePath: (home, env = process.env) => {
      const override = String(env.DSH_HOME ?? '').trim()
      const base = override.length > 0 && isAbsolutePath(override) ? override : join(home, '.dsh')
      return join(base, 'settings.yaml')
    },
    render(path, existing, input) {
      const body = [
        `displayName: ${scalar(label)}`,
        'headers:',
        `  Authorization: ${scalar(`Bearer ${input.proxyKey}`)}`,
        'api: openai-completions',
        `baseURL: ${scalar(baseUrlWithV1(input.baseUrl))}`,
      ]
      const models = input.clientModels ?? []
      if (models.length > 0) {
        body.push('models:')
        for (const model of models) {
          body.push(`  - id: ${scalar(model.id)}`)
          body.push(`    contextWindow: ${model.context_window}`)
        }
      }
      body.push('aiSwitch:', '  managed: true', `  platform: ${scalar(platform)}`)
      return setBlock(existing ?? '', ['llm-pi-ai', 'providers', id], body)
    },
    inspect(path, existing) {
      return status(path, existing, (text) => {
        const block = readBlock(text, ['llm-pi-ai', 'providers', id])
        return block !== null && block.some((line) => /^\s*platform:\s*'?[a-z]+'?\s*$/.test(line))
      })
    },
  }
}

/**
 * ZCode — `~/.zcode/v2/config.json`, one record under `provider`.
 *
 * Codex routes as `openai` against `…/v1`; Claude routes as `anthropic` against the bare
 * root. An existing display name is kept; everything else in our record is replaced.
 */
function makeZCodeAdapter(platform) {
  const id = `${PROVIDER_ID}-${platform}`
  const codex = platform === 'codex'
  const label = codex ? 'AI Switch (Codex)' : 'AI Switch (Claude)'
  return {
    targetKey: `zcode_${platform}`,
    clientKey: `zcode_${platform}`,
    clientDisplayName: codex ? 'ZCode (Codex)' : 'ZCode (Claude)',
    platform,
    native: false,
    restartRequired: true,
    requiresClientModels: true,
    resolvePath: (home) => join(home, '.zcode', 'v2', 'config.json'),
    render(path, existing, input) {
      const root = parseJsonConfig(path, existing)
      const providers = requireObject(path, root.provider, 'provider') ?? {}
      const url = codex ? baseUrlWithV1(input.baseUrl) : baseUrlRoot(input.baseUrl)
      const recordKey =
        Object.keys(providers).find((key) => isOurs(providers[key], platform)) ??
        Object.keys(providers).find((key) =>
          matchesEndpointAndKey(providers[key], { url, key: input.proxyKey, aliases: input.keyAliases ?? [] }),
        ) ??
        id
      const previous = providers[recordKey] ?? {}
      const options = previous.options !== null && typeof previous.options === 'object' ? { ...previous.options } : {}
      options.apiKey = input.proxyKey
      options.baseURL = url
      options.apiKeyRequired = true
      providers[recordKey] = {
        ...previous,
        name: typeof previous.name === 'string' && previous.name.trim().length > 0 ? previous.name : label,
        kind: codex ? 'openai' : 'anthropic',
        source: 'custom',
        options,
        models: Object.fromEntries(
          (input.clientModels ?? []).map((model) => [
            model.id,
            {
              limit: { context: model.context_window, output: MAX_OUTPUT_TOKENS },
              modalities: { input: ['text'], output: ['text'] },
            },
          ]),
        ),
        aiSwitch: marker(platform),
      }
      root.provider = providers
      return renderJson(path, root)
    },
    inspect(path, existing) {
      return status(path, existing, (text) => {
        const providers = parseJsonConfig(path, text)?.provider ?? {}
        return Object.values(providers).some((entry) => isOurs(entry, platform))
      })
    },
  }
}

/**
 * WorkBuddy / CodeBuddy CLI — `~/.workbuddy/models.json`, `~/.codebuddy/models.json`.
 *
 * A flat list of model records, each carrying its own URL and key. Both platforms speak
 * OpenAI Chat Completions here, whatever the local CLI thinks it is talking to.
 *
 * A bare array root is accepted and normalized to `{models: []}`; sibling keys survive.
 * Our old records are dropped and rewritten; a record marked for the OTHER platform is
 * never touched.
 */
function makeModelListAdapter({ clientKey, dir, displayName, platform }) {
  return {
    targetKey: clientKey,
    clientKey,
    clientDisplayName: displayName,
    platform,
    native: false,
    restartRequired: true,
    requiresClientModels: true,
    resolvePath: (home) => join(home, dir, 'models.json'),
    render(path, existing, input) {
      const body = String(existing ?? '').trim()
      let root = {}
      if (body.startsWith('[')) {
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch (error) {
          throw invalidExisting(path, String(error?.message ?? error))
        }
        root = { models: parsed }
      } else {
        root = parseJsonConfig(path, existing)
      }
      if (root.models !== undefined && root.models !== null && !Array.isArray(root.models)) {
        throw invalidExisting(path, 'models is not an array')
      }
      const url = `${baseUrlWithV1(input.baseUrl)}/chat/completions`
      const kept = (root.models ?? []).filter(
        (record) =>
          !isOurs(record, platform) &&
          !(
            record?.aiSwitch === undefined &&
            matchesEndpointAndKey(record, { url, key: input.proxyKey, aliases: input.keyAliases ?? [] }, 'url')
          ),
      )
      const prefix = platform === 'codex' ? 'AI Switch Codex' : 'AI Switch Claude'
      root.models = [
        ...kept,
        ...(input.clientModels ?? []).map((model) => ({
          id: model.id,
          name: `${prefix} ${model.id}`,
          vendor: 'Custom',
          url,
          apiKey: input.proxyKey,
          maxInputTokens: model.context_window,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          supportsToolCall: true,
          supportsImages: true,
          aiSwitch: marker(platform),
        })),
      ]
      return renderJson(path, root)
    },
    inspect(path, existing) {
      return status(path, existing, (text) => {
        const body = String(text ?? '').trim()
        const root = body.startsWith('[') ? { models: JSON.parse(body) } : parseJsonConfig(path, text)
        if (root.models !== undefined && root.models !== null && !Array.isArray(root.models)) {
          throw invalidExisting(path, 'models is not an array')
        }
        return (root.models ?? []).some((record) => isOurs(record, platform))
      })
    },
  }
}

/** Provider-level keys Qoder's validator rejects; an adopted entry loses them. */
const QODER_FORBIDDEN = [
  'contextWindow',
  'maxOutputTokens',
  'temperature',
  'top_p',
  'topP',
  'top_k',
  'topK',
  'thinking',
  'reasoning',
  'preserve_thinking',
  'preserveThinking',
  'generation',
]

/**
 * Qoder CLI — `~/.qoder/settings.json`.
 *
 * The record KEY is the only marker: Qoder drops any provider carrying a field it does not
 * recognize, so there is nowhere to stamp an `aiSwitch` object. Its base URL also must not
 * carry `/chat/completions`, credentials, a query or a fragment.
 */
function makeQoderAdapter(platform) {
  const id = `${PROVIDER_ID}-${platform}`
  const label = platform === 'codex' ? 'AI Switch (Codex)' : 'AI Switch (Claude)'
  return {
    targetKey: `qoder_cli_${platform}`,
    clientKey: `qoder_cli_${platform}`,
    clientDisplayName: platform === 'codex' ? 'Qoder CLI (Codex)' : 'Qoder CLI (Claude)',
    platform,
    native: false,
    restartRequired: true,
    requiresClientModels: true,
    resolvePath: (home) => join(home, '.qoder', 'settings.json'),
    render(path, existing, input) {
      const root = parseJsonConfig(path, existing)
      const providers = requireObject(path, root.providers, 'providers') ?? {}
      const url = baseUrlWithV1(baseUrlRoot(input.baseUrl).replace(/\/chat\/completions$/i, ''))
      const recordKey =
        (providers[id] !== undefined ? id : undefined) ??
        Object.keys(providers).find((key) =>
          matchesEndpointAndKey(providers[key], { url, key: input.proxyKey, aliases: input.keyAliases ?? [] }, 'baseUrl'),
        ) ??
        id
      const previous = { ...(providers[recordKey] ?? {}) }
      for (const key of QODER_FORBIDDEN) {
        delete previous[key]
      }
      const models = input.clientModels ?? []
      const entry = {
        ...previous,
        type: 'openai-compatible',
        displayName:
          typeof previous.displayName === 'string' && previous.displayName.trim().length > 0
            ? previous.displayName
            : label,
        baseUrl: url,
        apiKey: input.proxyKey,
        models: models.map((model) => ({
          model: model.id,
          displayName: `${label} ${model.id}`,
          contextWindow: model.context_window,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          capabilities: { tools: true, vision: true },
        })),
      }
      if (models.length > 0) {
        entry.model = models[0].id
      } else {
        delete entry.model
      }
      providers[recordKey] = entry
      root.providers = providers
      return renderJson(path, root)
    },
    inspect(path, existing) {
      return status(path, existing, (text) => parseJsonConfig(path, text)?.providers?.[id] !== undefined)
    },
  }
}

/**
 * The registry, in the order the reference's adapter registry returns it — which is also
 * the order the config-write dialog paints its rows in.
 *
 * `claude_desktop` is deliberately absent, here as there: its config file only wires MCP
 * servers, so there is no base URL to redirect.
 */
export const ADAPTERS = [
  codexAdapter,
  makeJsonAgentAdapter('claude_code'),
  makeJsonAgentAdapter('gemini_cli'),
  makeJsonAgentAdapter('grok'),
  makeZCodeAdapter('codex'),
  makeZCodeAdapter('claude'),
  makeHarnessAdapter('codex'),
  makeHarnessAdapter('claude'),
  makeModelListAdapter({
    clientKey: 'workbuddy_codex',
    dir: '.workbuddy',
    displayName: 'WorkBuddy (Codex)',
    platform: 'codex',
  }),
  makeModelListAdapter({
    clientKey: 'workbuddy_claude',
    dir: '.workbuddy',
    displayName: 'WorkBuddy (Claude)',
    platform: 'claude',
  }),
  makeModelListAdapter({
    clientKey: 'codebuddy_cli_codex',
    dir: '.codebuddy',
    displayName: 'CodeBuddy CLI (Codex)',
    platform: 'codex',
  }),
  makeModelListAdapter({
    clientKey: 'codebuddy_cli_claude',
    dir: '.codebuddy',
    displayName: 'CodeBuddy CLI (Claude)',
    platform: 'claude',
  }),
  makeQoderAdapter('codex'),
  makeQoderAdapter('claude'),
  openCodeAdapter,
  openClawAdapter,
  hermesAdapter,
]

/** One adapter by target key, or undefined. */
export function adapterByTargetKey(key) {
  return ADAPTERS.find((adapter) => adapter.targetKey === key)
}

/** Every adapter for one platform, registry order preserved. */
export function adaptersForPlatform(platform) {
  return ADAPTERS.filter((adapter) => adapter.platform === platform)
}










/** The `{file_status, managed, error_code}` triple every adapter's inspect returns. */
function status(path, text, isManaged) {
  if (text === null) {
    return { file_status: 'missing', managed: false, error_code: null }
  }
  try {
    return {
      file_status: isManaged(text) ? 'managed' : 'unmanaged',
      managed: isManaged(text),
      error_code: null,
    }
  } catch (error) {
    return {
      file_status: 'invalid',
      managed: false,
      error_code: error instanceof ApiError ? error.code : 'validation.route_config_existing_invalid',
    }
  }
}

