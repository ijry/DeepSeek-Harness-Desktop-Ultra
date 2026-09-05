/**
 * The panel's durable preferences: one JSON file under the DSH home holding the
 * settings the reference kept in its plugin-state blob — the active tab, the
 * splitter positions, the per-repository view choices, and the AI writer's style.
 *
 * Deliberately NOT here: the repository list (that is DSH's workspace registry,
 * see host/workspaces.js) and any credential material (see host/auth.js).
 *
 * Every write is atomic (temp file + rename in the same directory) and serialized
 * through one chain, so two concurrent saves cannot drop each other's keys. A
 * corrupt file is quarantined and treated as defaults rather than taking the
 * routes down.
 *
 * @module dsh-plugin-otools-git/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Ledger file name; the caller joins it onto the DSH home. */
export const PREFS_FILE = 'dsh-plugin-otools-git.json'

/** Stored-file schema version (bump on breaking record changes). */
const SCHEMA_VERSION = 1

/** The settings a brand-new install behaves by. */
export function defaultPrefs() {
  return {
    // Shell
    activeTab: 'status',
    sidebarWidth: 230,
    filesPanelWidth: 0,
    stagedSectionHeight: 0,
    diffHeight: 0,
    // Status panel
    statusViewMode: 'list',
    untrackedMode: 'all',
    // Diff viewer
    diffContext: 3,
    ignoreWhitespace: false,
    wordDiff: false,
    diffSplit: false,
    // History
    historyPageSize: 100,
    historyBranch: 'current',
    historyIncludeRemote: true,
    // Commit box
    amend: false,
    signoff: false,
    autoPushAfterCommit: false,
    // AI commit message
    aiStyle: 'conventional',
    aiLanguage: 'zh',
    // Push/pull dialogs
    pushForceMode: 'none',
    pushFollowTags: false,
    pullMode: 'merge',
    pullAutostash: false,
    fetchPrune: true,
    autoCloseOnSuccess: true,
    // Per-workspace overrides, keyed by workspace id
    perRepo: {},
  }
}

/** Keys whose value must be one of a fixed set, and what that set is. */
const ENUMS = {
  activeTab: ['status', 'history', 'branches', 'tags', 'remotes', 'stashes', 'submodules', 'worktrees'],
  statusViewMode: ['list', 'tree'],
  untrackedMode: ['all', 'normal', 'no'],
  aiStyle: ['conventional', 'plain'],
  aiLanguage: ['zh', 'en'],
  pushForceMode: ['none', 'lease', 'force'],
  pullMode: ['merge', 'rebase', 'ff-only'],
  historyBranch: undefined,
}

/** Numeric keys and their bounds. */
const NUMBERS = {
  sidebarWidth: [180, 640],
  filesPanelWidth: [0, 2_000],
  stagedSectionHeight: [0, 2_000],
  diffHeight: [0, 2_000],
  diffContext: [0, 100],
  historyPageSize: [10, 1_000],
}

/**
 * Coerce one incoming value onto the shape the defaults declare, or return
 * `undefined` to mean "not a usable value, leave whatever is stored alone".
 *
 * Returning undefined rather than the default matters: a browser that sends a
 * value this version does not know must not silently RESET a setting the user
 * chose. Out-of-range numbers are clamped (the intent is clear), unknown enum
 * members are dropped (the intent is not).
 */
function sanitize(key, value, fallback) {
  if (typeof fallback === 'boolean') {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    return undefined
  }
  if (typeof fallback === 'number') {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(parsed)) return undefined
    const bounds = NUMBERS[key]
    if (bounds === undefined) return Math.round(parsed)
    return Math.max(bounds[0], Math.min(bounds[1], Math.round(parsed)))
  }
  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return undefined
    const allowed = ENUMS[key]
    if (allowed === undefined) return value.slice(0, 200)
    return allowed.includes(value) ? value : undefined
  }
  return undefined
}

/** The preference store. */
export class PrefsStore {
  constructor(options) {
    this.file = options.file
    this.state = defaultPrefs()
    this.revision = 0
    this.loaded = false
    this.writes = Promise.resolve()
    this.listeners = new Set()
  }

  /** Subscribe to committed changes; returns the unsubscriber. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Announce a committed change. A throwing listener must not break a write. */
  broadcast(kind) {
    for (const listener of [...this.listeners]) {
      try {
        listener({ revision: this.revision, kind })
      } catch (error) {
        console.warn('[dsh-plugin-otools-git] prefs listener threw:', error?.message ?? error)
      }
    }
  }

  /** Load once. Never throws — a broken file degrades to defaults. */
  async load() {
    if (this.loaded) return this.state
    this.loaded = true
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[dsh-plugin-otools-git] prefs unreadable:', error.message)
      }
      return this.state
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[dsh-plugin-otools-git] quarantining corrupt prefs file')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return this.state
    }
    const defaults = defaultPrefs()
    const next = defaultPrefs()
    for (const key of Object.keys(defaults)) {
      if (key === 'perRepo') continue
      if (!Object.hasOwn(parsed, key)) continue
      const clean = sanitize(key, parsed[key], defaults[key])
      if (clean !== undefined) next[key] = clean
    }
    // Null prototype: workspace ids come out of a file, and a hand-edited
    // `__proto__` key must become a row rather than touch a prototype.
    next.perRepo = Object.create(null)
    const rows = parsed.perRepo
    if (typeof rows === 'object' && rows !== null && !Array.isArray(rows)) {
      for (const [id, row] of Object.entries(rows)) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
        const clean = Object.create(null)
        for (const key of Object.keys(defaults)) {
          if (key === 'perRepo') continue
          if (!Object.hasOwn(row, key)) continue
          const value = sanitize(key, row[key], defaults[key])
          if (value !== undefined) clean[key] = value
        }
        if (Object.keys(clean).length > 0) next.perRepo[String(id).slice(0, 200)] = clean
      }
    }
    this.state = next
    return this.state
  }

  /** The whole preference set. */
  snapshot() {
    return { ...this.state, perRepo: { ...this.state.perRepo } }
  }

  /** Merge a patch into the global row, or into one workspace's overrides. */
  async save(patch, workspaceId) {
    await this.load()
    const defaults = defaultPrefs()
    const clean = {}
    if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
      for (const key of Object.keys(defaults)) {
        if (key === 'perRepo') continue
        if (!Object.hasOwn(patch, key)) continue
        const value = sanitize(key, patch[key], defaults[key])
        if (value !== undefined) clean[key] = value
      }
    }
    if (Object.keys(clean).length === 0) return this.snapshot()

    if (workspaceId === undefined) {
      this.state = { ...this.state, ...clean }
    } else {
      const rows = { ...this.state.perRepo }
      rows[workspaceId] = { ...(rows[workspaceId] ?? {}), ...clean }
      this.state = { ...this.state, perRepo: rows }
    }
    this.revision += 1
    await this.persist()
    this.broadcast('prefs-changed')
    return this.snapshot()
  }

  /** Atomic write inside the serial chain. */
  persist() {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...this.state }, null, 2)
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, this.file)
    }
    const result = this.writes.then(run, run)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
}
