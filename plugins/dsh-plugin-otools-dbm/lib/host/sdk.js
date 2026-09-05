/**
 * The one @deepseek-ai/* import this plugin refuses to take.
 *
 * A published dsh plugin must never resolve `@deepseek-ai/*` at runtime: the copy
 * pnpm would fetch from the npm mirror shadows the build inside the CLI, and a
 * version skew there can break the agent loop rather than just this panel. So the
 * two things a host half genuinely needs from the SDK — the DSH home directory and
 * an atomic file write — are re-implemented here, small enough to audit.
 *
 * @module dsh-plugin-otools-dbm/host/sdk
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(
    override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'),
  )
  return join(home, ...segments)
}

/** This plugin's own directory under the DSH home. */
export function pluginHomePath(...segments) {
  return dshHomePath('dsh-plugin-otools-dbm', ...segments)
}

/**
 * Write a file atomically, creating parent directories.
 *
 * `mode` is applied to the temporary file BEFORE the rename, so the final file is
 * never briefly world-readable — which matters because the connection ledger holds
 * database passwords.
 */
export async function writeFileAtomic(file, contents, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, contents, { mode })
  try {
    await chmod(temporary, mode)
  } catch {
    // Windows ignores POSIX modes; the rename below is still the important part.
  }
  await rename(temporary, file)
}

/** The language DSH resolved for its UI: `zh` or `en`. */
export function hostLang() {
  const env = typeof process !== 'undefined' && process.env !== undefined ? process.env : {}
  for (const key of ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = String(env[key] ?? '').trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0]
    if (value === 'zh' || value === 'en') {
      return value
    }
  }
  return 'zh'
}

/**
 * The full locale tag the panel wants (`zh-CN` / `en-US`).
 *
 * DSH only distinguishes zh from en, but the panel ships the reference's eight
 * dictionaries, so a user who set a more specific `LANG` (say `ja_JP.UTF-8`) gets
 * their own language even though the shell around the panel is in English.
 */
export function hostLocale() {
  const env = typeof process !== 'undefined' && process.env !== undefined ? process.env : {}
  const supported = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'ru-RU', 'es-ES', 'ar-SA']
  const byLanguage = {
    zh: 'zh-CN',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    de: 'de-DE',
    ru: 'ru-RU',
    es: 'es-ES',
    ar: 'ar-SA',
  }

  for (const key of ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = String(env[key] ?? '').trim().replace(/_/g, '-').split('.')[0]
    if (raw.length === 0) {
      continue
    }
    if (supported.includes(raw)) {
      return raw
    }
    const mapped = byLanguage[raw.split('-')[0].toLowerCase()]
    if (mapped !== undefined) {
      return mapped
    }
  }
  return 'zh-CN'
}
