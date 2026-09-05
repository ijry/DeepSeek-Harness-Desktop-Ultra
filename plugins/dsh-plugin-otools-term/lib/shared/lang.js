/**
 * The two languages this plugin speaks, and how each half learns which one it is.
 *
 * Same contract as the sibling plugins: the shell hands the dsh process its
 * language in `DSH_DESKTOP_LANG`, so the Node half only reads the environment
 * (`hostLang`). The browser half runs inside dsh's own page and has no shell to
 * ask: it takes the language from the `language` field of `GET /state` and falls
 * back to `navigator.language`, so a plugin installed straight from npm — no
 * shell anywhere — still speaks the user's language.
 *
 * Locale spellings are matched the way the shell matches them (src-tauri
 * i18n.rs): case-insensitively, and only the part before the first `-`, `_` or
 * `.` counts, so `zh`, `zh-CN` and `zh_CN.UTF-8` are one language.
 *
 * @module dsh-plugin-otools-term/shared/lang
 */

/** Every language with a full string table. Chinese first — it is the default. */
export const LANGS = ['zh', 'en']

/**
 * What the Node half reads, in order: the shell's own variable outranks the
 * ambient locale, and the first RECOGNISED value wins (a `LANG` of `C.UTF-8`
 * names no language, so it must not shadow a `LANG` further down).
 */
const HOST_ENV_KEYS = ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

/**
 * A locale string → one of [`LANGS`], or null when it names neither of them
 * (`fr`, `C.UTF-8`) or is nullish.
 */
export function normalizeLang(value) {
  if (value === null || value === undefined) return null
  const base = String(value).trim().toLowerCase().split(/[-_.]/)[0]
  return LANGS.includes(base) ? base : null
}

/**
 * The language of the Node half, Chinese when nothing names one. Read at call
 * time rather than cached: module-level state resolved at import time is state a
 * test cannot set.
 */
export function hostLang() {
  for (const key of HOST_ENV_KEYS) {
    const found = normalizeLang(process.env[key])
    if (found !== null) return found
  }
  return 'zh'
}
