/**
 * The panel's i18n, ported from the OTools shell's module.
 *
 * The dictionaries are the reference plugin's own `i18n/*.json` (1089 keys × 8
 * languages, copied verbatim), plus `./locales/*.json` for the handful of strings
 * this port adds — the host path picker, the reveal failure, the boot errors.
 * Later globs win on key collisions, so a port string can override a reference
 * one when the wording has to change.
 *
 * Locale resolution, in order:
 *   1. `?lang=` on the iframe URL — the client entry puts DSH's own language
 *      there (`DSH_DESKTOP_LANG`, then LC_ALL/LANG, as the host resolved it).
 *   2. `navigator.language`.
 *   3. zh-CN.
 *
 * The shell can change language at runtime; it re-posts `{type:'dbm:locale'}` into
 * the frame and `applyLocaleSettings` repaints every `t()` through the reactive
 * `currentLocale` ref.
 */
import { computed, ref } from 'vue'

export type OtoolsLocale =
  | 'zh-CN'
  | 'en-US'
  | 'ja-JP'
  | 'ko-KR'
  | 'de-DE'
  | 'ru-RU'
  | 'es-ES'
  | 'ar-SA'
export type OtoolsLocaleSetting = OtoolsLocale | 'system'

type MessageDictionary = Record<string, string>
type RawLocaleModule = { default?: MessageDictionary } | MessageDictionary

export const DEFAULT_LOCALE: OtoolsLocale = 'zh-CN'
export const ENGLISH_FALLBACK_LOCALE: OtoolsLocale = 'en-US'
export const SUPPORTED_LOCALES: OtoolsLocale[] = [
  'zh-CN',
  'en-US',
  'ja-JP',
  'ko-KR',
  'de-DE',
  'ru-RU',
  'es-ES',
  'ar-SA',
]

const localeMessages = new Map<OtoolsLocale, MessageDictionary>()
const currentLocale = ref<OtoolsLocale>(DEFAULT_LOCALE)

const localeModules = import.meta.glob<RawLocaleModule>(['../../../i18n/*.json', './locales/*.json'], {
  eager: true,
})

const normalizeLocale = (value?: string | null): OtoolsLocale => {
  const normalized = String(value || '').trim()
  if (SUPPORTED_LOCALES.includes(normalized as OtoolsLocale)) {
    return normalized as OtoolsLocale
  }
  return DEFAULT_LOCALE
}

/** Map anything a browser or an env var might say to one of the eight. */
export const resolveLocaleCandidate = (value?: string | null): OtoolsLocale | null => {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return null
  }
  if (SUPPORTED_LOCALES.includes(normalized as OtoolsLocale)) {
    return normalized as OtoolsLocale
  }

  switch (normalized.replace(/_/g, '-').split('-')[0].toLowerCase()) {
    case 'zh':
      return 'zh-CN'
    case 'en':
      return 'en-US'
    case 'ja':
      return 'ja-JP'
    case 'ko':
      return 'ko-KR'
    case 'de':
      return 'de-DE'
    case 'ru':
      return 'ru-RU'
    case 'es':
      return 'es-ES'
    case 'ar':
      return 'ar-SA'
    default:
      return null
  }
}

const toMessageDictionary = (value: RawLocaleModule): MessageDictionary => {
  if (value && typeof value === 'object' && 'default' in value && value.default) {
    return value.default as MessageDictionary
  }
  return value as MessageDictionary
}

const extractLocaleFromPath = (path: string): OtoolsLocale | null => {
  const matched = path.match(/\/(zh-CN|en-US|ja-JP|ko-KR|de-DE|ru-RU|es-ES|ar-SA)\.json$/)
  return matched ? normalizeLocale(matched[1]) : null
}

const loadMessages = () => {
  // Sorted so `./locales/*` (the port's own strings) is applied after
  // `../../../i18n/*` (the reference's) and therefore wins.
  for (const path of Object.keys(localeModules).sort()) {
    const locale = extractLocaleFromPath(path)
    if (!locale) {
      continue
    }
    const bucket = localeMessages.get(locale) || {}
    Object.assign(bucket, toMessageDictionary(localeModules[path]))
    localeMessages.set(locale, bucket)
  }
}

loadMessages()

export const getCurrentLocale = () => currentLocale.value

export const currentLocaleRef = computed(() => currentLocale.value)

export const getSystemLocale = (): OtoolsLocale => {
  if (typeof navigator === 'undefined') {
    return DEFAULT_LOCALE
  }
  const candidates =
    Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language]
  for (const candidate of candidates) {
    const resolved = resolveLocaleCandidate(candidate)
    if (resolved) {
      return resolved
    }
  }
  return DEFAULT_LOCALE
}

/** Set the active locale; `system`/unknown falls back to the browser's. */
export const applyLocaleSettings = (settings: { locale?: string | null }) => {
  const requested = String(settings.locale || '').trim()
  const locale =
    !requested || requested === 'system' ? getSystemLocale() : resolveLocaleCandidate(requested) || DEFAULT_LOCALE
  currentLocale.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', locale)
    document.documentElement.setAttribute('dir', locale === 'ar-SA' ? 'rtl' : 'ltr')
  }
}

const interpolate = (template: string, params?: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params?.[key]
    return value === undefined || value === null ? '' : String(value)
  })

const lookupMessage = (locale: OtoolsLocale, key: string): string | undefined =>
  localeMessages.get(locale)?.[key]

/** Translate one key. Falls back through English, then Chinese, then the key. */
export const t = (key: string, params?: Record<string, unknown>, fallback?: string): string => {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) {
    return fallback || ''
  }

  const message =
    lookupMessage(currentLocale.value, normalizedKey)
    || lookupMessage(ENGLISH_FALLBACK_LOCALE, normalizedKey)
    || lookupMessage(DEFAULT_LOCALE, normalizedKey)
    || fallback
    || normalizedKey

  return interpolate(message, params)
}

/** A `t()` bound to a key prefix, as the components use it. */
export const useI18nScope = (scope?: string) => {
  const prefix = String(scope || '').trim()
  const scopedKey = (key: string) => (prefix ? `${prefix}.${key}` : key)
  return {
    locale: currentLocaleRef,
    t: (key: string, params?: Record<string, unknown>, fallback?: string) =>
      t(scopedKey(key), params, fallback),
  }
}
