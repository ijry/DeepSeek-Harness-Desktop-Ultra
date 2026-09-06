/**
 * Persistence: one JSON file per concern, atomic writes, serialized updates.
 *
 * The reference keeps all of this in SQLite (28 migrations, sqlx checksums, a repair
 * path). A panel plugin does not need that: the whole dataset is a few hundred account
 * rows and a pool order, it is read on panel open and written on user action, and a
 * single-process host means the only concurrency to defend against is two overlapping
 * requests — which `update()` serializes. What DOES carry over from the Rust side is
 * the discipline: atomic replace so a crash cannot truncate the ledger, 0600 because
 * these files hold API keys and refresh tokens, and a corrupt file moved aside rather
 * than deleted.
 *
 * @module dsh-plugin-ai-switch/host/store
 */
import { readFile, rename } from 'node:fs/promises'

import { pluginHomePath, writeFileAtomic } from './sdk.js'

/** A JSON file with an in-memory copy, atomic writes, and a quarantine path. */
export class JsonStore {
  /**
   * @param options.file - absolute path.
   * @param options.fallback - value (or factory) used when the file is missing.
   * @param options.mode - file mode; 0600 for anything holding a secret.
   */
  constructor({ file, fallback, mode = 0o600 }) {
    this.file = file
    this.mode = mode
    this.makeFallback = typeof fallback === 'function' ? fallback : () => structuredClone(fallback)
    this.value = undefined
    this.queue = Promise.resolve()
  }

  /** Load once. Never throws: an unreadable file becomes the fallback. */
  async read() {
    if (this.value !== undefined) {
      return this.value
    }
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      this.value = parsed !== null && typeof parsed === 'object' ? parsed : this.makeFallback()
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep the bytes: they may be the only copy of someone's account list.
        await rename(this.file, `${this.file}.corrupt.${Date.now()}`).catch(() => {})
        console.warn(`[dsh-plugin-ai-switch] ${this.file} was unreadable and has been moved aside`)
      }
      this.value = this.makeFallback()
    }
    return this.value
  }

  /**
   * Read-modify-write, serialized against every other update of this file.
   *
   * The mutator may return a value, which becomes the result; the (possibly mutated)
   * document is written unless the mutator returns the symbol `SKIP_WRITE`.
   */
  async update(mutate) {
    const run = this.queue.then(async () => {
      const document = await this.read()
      const result = await mutate(document)
      if (result !== SKIP_WRITE) {
        await this.flush()
      }
      return result
    })
    // Keep the chain alive after a failed update, otherwise one rejection poisons every
    // later write on this file.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Write the in-memory document out. */
  async flush() {
    await writeFileAtomic(this.file, `${JSON.stringify(this.value, null, 2)}\n`, this.mode)
  }

  /** Drop the cache; the next read comes from disk. Used by the tests. */
  reset() {
    this.value = undefined
  }
}

/** Return this from an `update` mutator to skip the write. */
export const SKIP_WRITE = Symbol('skip-write')

/** Every file this plugin owns, in one place. */
export function createStores(home = pluginHomePath()) {
  const at = (name) => `${home}/${name}`
  return {
    /** Route credentials (accounts). HOLDS API KEYS AND OAUTH TOKENS. */
    accounts: new JsonStore({ file: at('accounts.json'), fallback: { credentials: [], models: [] } }),
    /** Pool membership, rotation cursor and per-platform model mode. */
    pool: new JsonStore({ file: at('pool.json'), fallback: { members: [], cursors: {}, modes: {} } }),
    /** The reference's `~/.ai-switch/settings.json`, minus the desktop-only fields. */
    settings: new JsonStore({ file: at('settings.json'), fallback: null, mode: 0o600 }),
    /** Per-platform proxy keys plus retired aliases still accepted by the proxy. */
    keys: new JsonStore({ file: at('proxy-keys.json'), fallback: { keys: {}, aliases: [] } }),
    /** Config-write snapshot ledger; the backups themselves live in backups/. */
    snapshots: new JsonStore({ file: at('config-snapshots.json'), fallback: { snapshots: [] }, mode: 0o600 }),
    /** Model price overrides, same shape as the reference's model-prices.json. */
    prices: new JsonStore({ file: at('model-prices.json'), fallback: {}, mode: 0o600 }),
    /** Batches (account groups) and the import job log. */
    batches: new JsonStore({ file: at('batches.json'), fallback: { batches: [], jobs: [] } }),
    /** Proxied request ledger, newest last, capped by usage.js. */
    usage: new JsonStore({ file: at('usage.json'), fallback: { events: [] } }),
    /** Where a rolled-back config file's original bytes are kept. */
    backupDir: `${home}/backups/config-snapshots`,
    home,
  }
}

