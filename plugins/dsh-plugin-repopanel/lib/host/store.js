/**
 * Host-side panel ledger: one JSON file under the DSH home holding the panel
 * settings (global row plus per-workspace overrides) and the source-key → task
 * links. Mutated through a serial write queue, published as immutable snapshots
 * with a monotonic revision, and broadcast to subscribers (the SSE route) on
 * every committed change. Corruption on load is quarantined, never fatal.
 *
 * What is deliberately NOT here: repositories and forge items. A repository is
 * derived from a workspace's `origin` remote on every read, and issues and
 * changes are read from the forge on demand — the same stance codeg-plus's
 * 仓库面板 takes. Caching either one would only buy a staleness bug.
 *
 * The structure mirrors the sibling taskboard plugin's ledger deliberately, so
 * the durability reasoning is reviewed once and reused: same serial queue, same
 * temp-write + rename publish, same deep-frozen snapshots.
 *
 * @module dsh-plugin-repopanel/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  LEDGER_SCHEMA_VERSION,
  applyPanelSettings,
  defaultPanelSettings,
  effectivePanelSettings,
  emptyLedger,
  isPlausibleLink,
  normalizePanelSettings,
  ownPanelSettings,
} from '../shared/protocol.js'

/** One committed ledger mutation, as broadcast to subscribers. */
export class PanelChange {
  constructor(revision, kind) {
    this.revision = revision
    this.kind = kind
  }
}

/**
 * Persist atomically: write a temp file in the same directory, then rename over
 * the target (atomic on POSIX and on Windows NTFS).
 */
async function persistAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** Deep-freeze a clone so handed-out snapshots can never mutate internal state. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Read one settings row defensively. A row the user hand-edited into an invalid
 * shape is dropped rather than failing the load — losing one override is
 * recoverable, refusing to boot the panel is not.
 */
function readSettingsRow(raw, label) {
  try {
    return normalizePanelSettings(raw)
  } catch (error) {
    console.warn(`[dsh-plugin-repopanel] dropping unusable settings row ${label}:`, error.message)
    return undefined
  }
}

export class PanelStore {
  /** @param options - { file: string } */
  constructor(options) {
    this.file = options.file
    this.ledger = emptyLedger()
    this.subscribers = new Set()
    this.queue = Promise.resolve()
    this.loaded = false
  }

  /** Load (once) from disk; missing file starts empty; corrupt file quarantined. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return
      console.warn('[dsh-plugin-repopanel] ledger unreadable:', error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[dsh-plugin-repopanel] quarantining corrupt ledger')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return
    }
    this.ledger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      settings: readSettings(parsed.settings),
      links: readLinks(parsed.links),
    }
  }

  /** The current snapshot — a deep-frozen clone. */
  snapshot() {
    return deepFreeze(structuredClone(this.ledger))
  }

  /** The settings store (global + overrides), deep-frozen. */
  settings() {
    return deepFreeze(structuredClone(this.ledger.settings))
  }

  /** The settings a workspace behaves by, deep-frozen. */
  effectiveSettings(scope) {
    return deepFreeze(structuredClone(effectivePanelSettings(this.ledger.settings, scope)))
  }

  /** A workspace's own settings row, or undefined when it follows the global one. */
  ownSettings(scope) {
    const row = ownPanelSettings(this.ledger.settings, scope)
    return row === undefined ? undefined : deepFreeze(structuredClone(row))
  }

  /** One link by source key, deep-frozen. */
  link(sourceKey) {
    const row = this.ledger.links[sourceKey]
    return row === undefined ? undefined : deepFreeze(structuredClone(row))
  }

  /** The links for a set of source keys, as a plain object keyed by source key. */
  linksFor(sourceKeys) {
    const out = {}
    for (const key of sourceKeys) {
      const row = this.ledger.links[key]
      if (row !== undefined) out[key] = structuredClone(row)
    }
    return deepFreeze(out)
  }

  /** Subscribe to committed changes; returns the unsubscribe function. */
  subscribe(fn) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * Run one mutation inside the serial queue. The mutator receives a structured
   * clone of the ledger; returning `true` commits, returning `false` aborts with
   * no write and no revision bump.
   *
   * Ordering matches the sibling plugin: the durable write is awaited BEFORE
   * in-memory state is replaced, so a rejected write leaves readers seeing
   * exactly what is on disk.
   *
   * @param kind - change kind for subscribers.
   * @param mutator - (ledger) => boolean
   */
  async mutate(kind, mutator) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      const committed = mutator(draft)
      if (committed !== true) return { committed: false, revision: this.ledger.revision }
      draft.revision += 1
      draft.schemaVersion = LEDGER_SCHEMA_VERSION
      await persistAtomic(this.file, `${JSON.stringify(draft, null, 2)}\n`)
      this.ledger = draft
      for (const fn of [...this.subscribers]) {
        try {
          fn(new PanelChange(draft.revision, kind))
        } catch (error) {
          console.warn('[dsh-plugin-repopanel] subscriber threw:', error?.message ?? error)
        }
      }
      return { committed: true, revision: draft.revision }
    }
    const result = this.queue.then(run, run)
    // Both handlers: a rejected mutation must not stall every later write.
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Write one settings scope. `scope: undefined` (or the global sentinel) writes
   * the global row; `settings: undefined` for a workspace REMOVES its override,
   * which is how "follow the global defaults" is stored.
   */
  async saveSettings(scope, settings) {
    await this.mutate('settings-changed', (draft) => {
      applyPanelSettings(draft.settings, scope, settings)
      return true
    })
    return this.settings()
  }

  /** Record a source-key → task link. */
  async putLink(link) {
    await this.mutate('links-changed', (draft) => {
      draft.links[link.sourceKey] = link
      return true
    })
    return this.link(link.sourceKey)
  }

  /** Forget a link. Returns whether it existed. */
  async removeLink(sourceKey) {
    let existed = false
    await this.mutate('links-changed', (draft) => {
      existed = draft.links[sourceKey] !== undefined
      if (!existed) return false
      delete draft.links[sourceKey]
      return true
    })
    return existed
  }

  get revision() {
    return this.ledger.revision
  }
}

/** Rebuild the settings section from an untrusted parse. */
function readSettings(raw) {
  const settings = { global: defaultPanelSettings(), folders: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return settings
  const global = readSettingsRow(raw.global, 'global')
  if (global !== undefined) settings.global = global
  if (typeof raw.folders === 'object' && raw.folders !== null && !Array.isArray(raw.folders)) {
    for (const [scope, row] of Object.entries(raw.folders)) {
      const parsed = readSettingsRow(row, scope)
      if (parsed !== undefined) settings.folders[scope] = parsed
    }
  }
  return settings
}

/** Rebuild the links section, dropping implausible rows one by one. */
function readLinks(raw) {
  const links = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return links
  for (const [key, row] of Object.entries(raw)) {
    if (!isPlausibleLink(row)) {
      console.warn('[dsh-plugin-repopanel] dropping implausible link:', key)
      continue
    }
    links[key] = row
  }
  return links
}
