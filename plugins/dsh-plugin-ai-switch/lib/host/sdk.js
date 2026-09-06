/**
 * The two things a host half needs from the SDK, re-implemented rather than imported.
 *
 * A published dsh plugin must never resolve `@deepseek-ai/*` at runtime: the copy the
 * package manager fetches from the npm mirror shadows the build inside the CLI, and a
 * version skew there breaks more than this panel. So the DSH home directory, an atomic
 * write and the host language live here, small enough to audit.
 *
 * @module dsh-plugin-ai-switch/host/sdk
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Package id, and the first path segment of every route this plugin owns. */
export const PLUGIN_ID = 'dsh-plugin-ai-switch'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(
    override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'),
  )
  return join(home, ...segments)
}

/**
 * This plugin's own state directory.
 *
 * Deliberately NOT `~/.ai-switch/`: the desktop app keeps a SQLite database and its own
 * settings there, and two processes with different schemas writing one directory — plus
 * two route proxies fighting over one port — is a data-loss bug waiting to happen. The
 * plugin reads other tools' configs when you ask it to import, but it owns only this.
 */
export function pluginHomePath(...segments) {
  return dshHomePath(PLUGIN_ID, ...segments)
}

/** The user's home directory, which every CLI config path is relative to. */
export function userHome() {
  return homedir()
}

/**
 * Write a file atomically, creating parent directories.
 *
 * `mode` is applied to the temporary file BEFORE the rename, so the final file is never
 * briefly world-readable — this store holds API keys and OAuth refresh tokens.
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
    const value = String(env[key] ?? '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-')
      .split(/[-.@]/)[0]
    if (value === 'zh' || value === 'en') {
      return value
    }
  }
  return 'zh'
}

/**
 * The language tag the panel understands.
 *
 * The reference app ships exactly two dictionaries (`en` and `zh-CN`), and the value is
 * seeded into `localStorage['ai-switch.language']` by the served index.html, so it has
 * to be one of those two strings and nothing else.
 */
export function panelLanguage() {
  return hostLang() === 'en' ? 'en' : 'zh-CN'
}

/** A v4 UUID from the platform CSPRNG. */
export function uuid() {
  return globalThis.crypto.randomUUID()
}

/** The per-platform proxy key format the reference mints and every adapter writes. */
export function generateProxyKey() {
  return `sk-ai-switch-${uuid().replace(/-/g, '')}`
}

