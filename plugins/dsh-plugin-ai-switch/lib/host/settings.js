/**
 * Settings: the reference's `~/.ai-switch/settings.json`, kept under the DSH home.
 *
 * The panel reads and writes this object whole (`get_settings` / `save_settings`), so
 * every field has to survive a round trip even when nothing in the plugin acts on it —
 * `close_to_tray` has no tray to close to here, but dropping the key would make the
 * settings screen's checkbox forget itself on every save.
 *
 * Two fields ARE load-bearing for the config writer:
 *   `config_write_clients_json`  — `{"<platform>": ["<client_key>", …]}`, the per-platform
 *                                  client selection the write dialog remembers.
 *   `claude_client_config_json`  — a JSON object merged into Claude Code's settings root.
 *
 * @module dsh-plugin-ai-switch/host/settings
 */
import { ApiError } from '../shared/protocol.js'

/** Defaults, with the reference's values wherever the field still means something. */
export function defaultSettings(dataDir) {
  return {
    language: 'zh-CN',
    theme: 'system',
    copy_import_sources: false,
    logging_enabled: true,
    // The reference offers an OS keyring; a dsh plugin has no such service, and every
    // sibling plugin stores its secrets in a 0600 file under the DSH home. Saying `file`
    // is the honest answer, and the panel only round-trips this value.
    secret_storage: 'file',
    data_dir: dataDir,
    ccswitch_deeplink_compat_enabled: false,
    close_to_tray: true,
    claude_client_config_json: null,
    config_write_clients_json: null,
  }
}

const KNOWN_KEYS = Object.keys(defaultSettings(''))

/** Read, filling in anything the file predates. */
export async function getSettings(store, dataDir) {
  const stored = await store.read()
  const settings = { ...defaultSettings(dataDir), ...(stored ?? {}) }
  if (typeof settings.data_dir !== 'string' || settings.data_dir.trim().length === 0) {
    settings.data_dir = dataDir
  }
  return view(settings)
}

/** Write. Unknown keys are dropped rather than persisted forever. */
export async function saveSettings(store, dataDir, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('validation.settings', 'Settings must be an object', { details: 'settings' })
  }
  const next = { ...defaultSettings(dataDir) }
  for (const key of KNOWN_KEYS) {
    if (input[key] !== undefined) {
      next[key] = input[key]
    }
  }
  next.data_dir = dataDir
  for (const key of ['claude_client_config_json', 'config_write_clients_json']) {
    if (typeof next[key] === 'string' && next[key].trim().length === 0) {
      next[key] = null
    }
    if (typeof next[key] === 'string') {
      try {
        JSON.parse(next[key])
      } catch (error) {
        throw new ApiError('validation.json', `${key} is not valid JSON`, {
          details: String(error?.message ?? error),
        })
      }
    }
  }
  await store.update((document) => {
    for (const key of Object.keys(document ?? {})) {
      delete document[key]
    }
    Object.assign(document, next)
  })
  return view(next)
}

/**
 * The `AppSettingsView` the panel expects: the stored object plus one computed flag.
 *
 * `ccswitch_deeplink_compat_supported` is false and cannot be otherwise: registering the
 * `ccswitch://` URL scheme is an OS-level association owned by an installed application,
 * and a plugin inside dsh is not one.
 */
function view(settings) {
  return { ...settings, ccswitch_deeplink_compat_supported: false }
}

/** The client keys the user last picked for one platform, or `null` if never. */
export function selectedClientKeys(settings, platform) {
  const raw = settings?.config_write_clients_json
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    const list = parsed?.[platform]
    if (!Array.isArray(list)) {
      return null
    }
    const keys = list.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0)
    return keys.length > 0 ? keys : null
  } catch {
    // A corrupt selection is ignored, exactly as in the reference: the caller then falls
    // back to the platform's single native client rather than failing the write.
    return null
  }
}

/** The extra root keys to merge into Claude Code's settings.json, or `{}`. */
export function claudeClientConfig(settings) {
  const raw = settings?.claude_client_config_json
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
