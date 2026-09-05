/**
 * Which language the host half speaks, and how a locale string becomes one.
 *
 * The dsh process this plugin lives in is normally started by the DSH Desktop
 * Ultra shell, which writes the user's choice into `DSH_DESKTOP_LANG`. A
 * standalone deployment (the official CLI, a container, a systemd unit) has no
 * shell, so the POSIX locale variables are read next, and anything unrecognised
 * falls back to Chinese — the default audience of this package.
 *
 * The browser half cannot see any of this: a page has no environment. It learns
 * the language from `GET /admin/state` instead, which is why nothing here is
 * imported by src/client/index.js — that bundle has no module resolution and
 * carries its own two-line normalizer.
 *
 * @module dsh-plugin-mobile-bridge/shared/lang
 */

/** The languages this plugin ships strings for. */
export const LANGS = ['zh', 'en']

/**
 * Where the language comes from, in order of authority: the shell's own variable
 * first, then the POSIX chain. An unrecognised value does not shadow the next
 * candidate — `LC_ALL=C` on a container must not stop `LANG=zh_CN.UTF-8` from
 * being read.
 */
const ENV_KEYS = ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

/**
 * Parse a language tag or POSIX locale onto one of {@link LANGS}.
 *
 * Deliberately loose: `zh`, `zh-CN`, `zh_CN.UTF-8` and `en_US.UTF-8` all name a
 * language this plugin has strings for, and the region and codeset carry nothing
 * the strings vary by.
 *
 * @param {unknown} value - a tag, a locale, or nothing.
 * @returns {'zh'|'en'|null} the language, or null when it is neither.
 */
export function normalizeLang(value) {
  if (value === undefined || value === null) return null
  const base = String(value).trim().toLowerCase().split(/[-_.]/)[0]
  return LANGS.includes(base) ? base : null
}

/**
 * The language the host half answers in.
 *
 * Read per call rather than memoized: it costs four property lookups, and a
 * cached value would freeze whatever the first import happened to observe —
 * which in a test process is whoever imported this module first.
 *
 * @returns {'zh'|'en'} the language, Chinese when nothing recognisable is set.
 */
export function hostLang() {
  const env = typeof process === 'undefined' ? {} : (process.env ?? {})
  for (const key of ENV_KEYS) {
    const lang = normalizeLang(env[key])
    if (lang !== null) return lang
  }
  return 'zh'
}

/**
 * Pick the spelling that matches {@link hostLang}.
 *
 * Both spellings are written in place rather than kept in a key table: every
 * message in the host half is one line long and most interpolate something, so a
 * table would replace template literals with positional placeholders and put the
 * two languages in different files. Side by side, a missing translation is
 * visible where the message is thrown.
 *
 * @param {string} zh - the Chinese spelling.
 * @param {string} en - the English spelling.
 * @returns {string} one of the two.
 */
export function pick(zh, en) {
  return hostLang() === 'en' ? en : zh
}
