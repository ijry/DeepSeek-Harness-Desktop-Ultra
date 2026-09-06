/**
 * The platform catalog: ids, aliases, capabilities, client targets, launchers.
 *
 * Straight transcription of the reference's `models/platform.rs` and
 * `services/platform_capability_service.rs`, because the panel renders this data
 * verbatim — `src/lib/platformCapabilities.ts` switches on the `reason_code` strings and
 * `PlatformSupportBadge` on `support_level`, so a renamed code silently blanks a UI hint.
 *
 * The seven platforms are two different kinds of thing: Codex / Claude / Gemini / Grok
 * are vendors with their own login, OpenCode / OpenClaw / Hermes are agent harnesses
 * with none. That is the whole meaning of `support_level: "partial"` — no official
 * account import, no official routing, no deeplink, no quota.
 *
 * @module dsh-plugin-ai-switch/host/platforms
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { ApiError, validation } from '../shared/protocol.js'

/** Canonical order — every list this module returns follows it. */
export const PLATFORM_IDS = ['codex', 'claude', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes']

/** Reference display names (short vendor names, not the client names). */
const DISPLAY_NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
}

/** Every spelling the importers and deeplinks are allowed to send. */
const ALIASES = {
  openai: 'codex',
  chatgpt: 'codex',
  anthropic: 'claude',
  claude_code: 'claude',
  claude_desktop: 'claude',
  google: 'gemini',
  gemini_cli: 'gemini',
  xai: 'grok',
  x_ai: 'grok',
  'x.ai': 'grok',
  open_code: 'opencode',
  open_claw: 'openclaw',
}

/** The four upstream protocols an API account can speak. */
export const API_DIALECTS = ['openai', 'openai-responses', 'anthropic', 'gemini']

/** Normalize and validate a platform id; throws `platform.unknown`. */
export function parsePlatform(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/-/g, '_')
  const id = PLATFORM_IDS.includes(raw) ? raw : ALIASES[raw]
  if (id === undefined) {
    throw validation('platform.unknown', 'Unknown platform', String(value ?? ''))
  }
  return id
}

/** The same normalization without the throw; `null` when unrecognized. */
export function tryParsePlatform(value) {
  try {
    return parsePlatform(value)
  } catch {
    return null
  }
}

export function platformDisplayName(platform) {
  return DISPLAY_NAMES[platform] ?? platform
}

/** The upstream protocol an API account defaults to, or `null` for the harnesses. */
export function defaultApiDialect(platform) {
  switch (platform) {
    case 'codex':
    case 'grok':
      return 'openai'
    case 'claude':
      return 'anthropic'
    case 'gemini':
      return 'gemini'
    default:
      return null
  }
}

/** What the official-account importer assumes; Codex differs from the API default. */
export function defaultImportDialect(platform) {
  return platform === 'codex' ? 'openai-responses' : defaultApiDialect(platform)
}

const OPERATIONS = [
  'route_credentials',
  'generic_api_routing',
  'config_write',
  'official_import',
  'official_account_routing',
  'deeplink_import',
  'official_quota',
  'model_test',
  'terminal_launch',
  'session_resume',
]

/** Harnesses: no vendor login, and API accounts must declare base URL + dialect. */
const PARTIAL = new Set(['opencode', 'openclaw', 'hermes'])

const SUPPORTED = {
  availability: 'supported',
  reason_code: null,
  credential_kinds: [],
  requires_base_url: false,
  requires_api_dialect: false,
}

const API_ONLY = {
  availability: 'partial',
  reason_code: 'capability.api_credentials_only',
  credential_kinds: ['api'],
  requires_base_url: true,
  requires_api_dialect: true,
}

const unavailable = (reason) => ({
  availability: 'unavailable',
  reason_code: reason,
  credential_kinds: [],
  requires_base_url: false,
  requires_api_dialect: false,
})

/** One operation's rule for one platform. */
export function capabilityFor(platform, operation) {
  const partial = PARTIAL.has(platform)
  switch (operation) {
    case 'route_credentials':
    case 'config_write':
    case 'terminal_launch':
    case 'session_resume':
      return SUPPORTED
    case 'generic_api_routing':
    case 'model_test':
      return partial ? API_ONLY : SUPPORTED
    case 'official_import':
    case 'official_account_routing':
      return partial ? unavailable('capability.official_account_unavailable') : SUPPORTED
    case 'deeplink_import':
      return partial ? unavailable('capability.deeplink_unavailable') : SUPPORTED
    case 'official_quota':
      // Gemini has an official login but no quota endpoint worth claiming support for.
      return partial || platform === 'gemini' ? unavailable('capability.quota_unavailable') : SUPPORTED
    default:
      return SUPPORTED
  }
}

/** `list_platform_capabilities`: one row per platform, canonical order. */
export function listPlatformCapabilities() {
  return PLATFORM_IDS.map((platform) => ({
    platform,
    display_name: platformDisplayName(platform),
    support_level: PARTIAL.has(platform) ? 'partial' : 'supported',
    operations: Object.fromEntries(
      OPERATIONS.map((operation) => [operation, capabilityFor(platform, operation)]),
    ),
  }))
}

/**
 * Gate one operation. Only `unavailable` throws — `partial` is callable, it just means
 * the caller has to supply a base URL and a dialect itself.
 */
export function requireCapability(platform, operation) {
  const rule = capabilityFor(platform, operation)
  if (rule.availability === 'unavailable') {
    throw new ApiError('capability.unavailable', `${platformDisplayName(platform)} does not support ${operation}`, {
      details: rule.reason_code,
      recoverable: true,
    })
  }
  return rule
}

/**
 * The 17 client targets, in the order the reference's adapter registry returns them —
 * which is also the order the config-write dialog paints its rows in.
 */
export const TARGET_APPS = [
  { key: 'claude_code', platform: 'claude', display_name: 'Claude Code' },
  { key: 'codex', platform: 'codex', display_name: 'Codex' },
  { key: 'gemini_cli', platform: 'gemini', display_name: 'Gemini CLI' },
  { key: 'grok', platform: 'grok', display_name: 'Grok' },
  { key: 'zcode_codex', platform: 'codex', display_name: 'ZCode (Codex)' },
  { key: 'zcode_claude', platform: 'claude', display_name: 'ZCode (Claude)' },
  { key: 'deepseek_harness_codex', platform: 'codex', display_name: 'DeepSeek Harness (Codex)' },
  { key: 'deepseek_harness_claude', platform: 'claude', display_name: 'DeepSeek Harness (Claude)' },
  { key: 'workbuddy_codex', platform: 'codex', display_name: 'WorkBuddy (Codex)' },
  { key: 'workbuddy_claude', platform: 'claude', display_name: 'WorkBuddy (Claude)' },
  { key: 'codebuddy_cli_codex', platform: 'codex', display_name: 'CodeBuddy CLI (Codex)' },
  { key: 'codebuddy_cli_claude', platform: 'claude', display_name: 'CodeBuddy CLI (Claude)' },
  { key: 'qoder_cli_codex', platform: 'codex', display_name: 'Qoder CLI (Codex)' },
  { key: 'qoder_cli_claude', platform: 'claude', display_name: 'Qoder CLI (Claude)' },
  { key: 'opencode', platform: 'opencode', display_name: 'OpenCode' },
  { key: 'openclaw', platform: 'openclaw', display_name: 'OpenClaw' },
  { key: 'hermes', platform: 'hermes', display_name: 'Hermes' },
]

/** The agent CLIs the terminal can launch, in the reference's descriptor order. */
export const AGENT_LAUNCHERS = [
  { platform: 'codex', program: 'codex', npm_package: '@openai/codex' },
  { platform: 'claude', program: 'claude', npm_package: '@anthropic-ai/claude-code' },
  { platform: 'grok', program: 'grok', npm_package: '@vibe-kit/grok-cli' },
  { platform: 'gemini', program: 'gemini', npm_package: '@google/gemini-cli' },
  { platform: 'opencode', program: 'opencode', npm_package: 'opencode-ai' },
  { platform: 'openclaw', program: 'openclaw', npm_package: 'openclaw' },
  { platform: 'hermes', program: 'hermes', npm_package: 'hermes-agent' },
]

/** Only these CLIs have a verified `--model` flag. */
export function agentSupportsModelFlag(platform) {
  return ['codex', 'claude', 'grok', 'gemini'].includes(platform)
}

/** Only Codex takes `-c model_reasoning_effort="..."`. */
export function agentSupportsReasoning(platform) {
  return platform === 'codex'
}

/**
 * Resolve `program` against PATH, honoring PATHEXT — on Windows every one of these CLIs
 * is a `.cmd`/`.ps1` shim rather than a bare executable, so a plain `existsSync` on the
 * bare name finds nothing and the panel would report all seven as missing.
 */
export function findProgramInPath(program, env = process.env) {
  const name = String(program ?? '').trim()
  if (name.length === 0) {
    return null
  }
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir.length > 0)
  const extensions = String(env.PATHEXT ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  for (const dir of dirs) {
    const base = join(dir, name)
    if (existsSync(base)) {
      return base
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}



