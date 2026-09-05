/**
 * dsh-plugin-taskboard — shared language resolution (zh / en).
 *
 * The desktop shell hands the user's UI language to the dsh process as the
 * DSH_DESKTOP_LANG environment variable; a plugin installed WITHOUT the shell
 * falls back to the POSIX locale variables and finally to Chinese (the
 * original UI language of this plugin).
 *
 * The browser half cannot import this file — it is wrapped into ONE standalone
 * bundle with no module resolution (scripts/wrap-client.mjs) — so it learns the
 * language from the `language` field of GET /dsh-plugin-taskboard/state and
 * keeps its own inline copy of normalizeLang(). Keep the two in sync.
 *
 * @module dsh-plugin-taskboard/shared/lang
 */

/** Supported UI languages. */
export const LANGS = ['zh', 'en']

/** Environment variables the Node half consults, in priority order. */
const HOST_ENV_KEYS = ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

/**
 * Normalize one raw locale value to a supported language. Accepts plain tags
 * and POSIX locales in any case (`zh`, `zh-CN`, `zh_CN.UTF-8`, `en`, `en-US`).
 * @param {unknown} value
 * @returns {string|null} 'zh' / 'en', or null when nullish or unrecognised.
 */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null
  const primary = value.trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0]
  return LANGS.includes(primary) ? primary : null
}

/**
 * The host-half language: the shell's DSH_DESKTOP_LANG, then the POSIX locale
 * variables (first recognised value wins), falling back to Chinese.
 * @returns {string} 'zh' | 'en'
 */
export function hostLang() {
  const env = typeof process !== 'undefined' && process.env !== undefined ? process.env : {}
  for (const key of HOST_ENV_KEYS) {
    const lang = normalizeLang(env[key])
    if (lang !== null) return lang
  }
  return 'zh'
}
