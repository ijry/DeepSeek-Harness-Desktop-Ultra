/**
 * Host-side task ledger: one JSON file under the DSH home, mutated through a
 * serial write queue and published as immutable snapshots with a global
 * monotonic revision. Change subscribers (the SSE route) observe every
 * committed mutation. Corruption on load is quarantined, never fatal.
 *
 * @module dsh-plugin-taskboard/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  LEDGER_SCHEMA_VERSION,
  emptyLedger,
  isPlausibleTaskRecord,
  normalizeSettings,
  summarizeTask,
} from '../shared/protocol.js'

/** One committed ledger mutation, as broadcast to subscribers. */
export class LedgerChange {
  constructor(revision, kind, tasks, ledger) {
    this.revision = revision
    this.kind = kind
    this.tasks = tasks
    this.ledger = ledger
  }
}

/**
 * Persist atomically: write a temp file in the same directory, then rename
 * over the target (atomic on POSIX and Windows NTFS).
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

/** Options for the store. */
export class TaskStore {
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
      console.warn('[dsh-plugin-taskboard] ledger unreadable:', error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tasks)) {
      console.warn('[dsh-plugin-taskboard] quarantining corrupt ledger')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return
    }
    const tasks = []
    for (const entry of parsed.tasks) {
      if (!isPlausibleTaskRecord(entry)) {
        console.warn('[dsh-plugin-taskboard] dropping implausible ledger entry:', entry?.id)
        continue
      }
      tasks.push(entry)
    }
    this.ledger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      // A ledger written before settings existed simply gets the defaults.
      settings: normalizeSettings(parsed.settings),
      tasks,
    }
  }

  /** The current snapshot — a deep-frozen clone. */
  snapshot() {
    return deepFreeze(structuredClone(this.ledger))
  }

  /** Find a task by id (deep-frozen clone). */
  get(id) {
    const task = this.ledger.tasks.find((t) => t.id === id)
    return task === undefined ? undefined : deepFreeze(structuredClone(task))
  }

  /** Subscribe to committed changes; returns the unsubscribe function. */
  subscribe(fn) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * Run one mutation inside the serial queue. The mutator receives a
   * structured clone; returning an array of touched task records commits the
   * mutation, returning `undefined` aborts with no write.
   * @param kind - change kind for subscribers.
   * @param mutator - (ledger) => TaskRecord[] | undefined
   */
  async mutate(kind, mutator) {
    return this.#run(kind, (draft) => {
      const changed = mutator(draft)
      if (changed === undefined || changed.length === 0) return null
      return { summaries: changed.map((task) => summarizeTask(task)) }
    })
  }

  /**
   * Commit a board-level (non-task) change — today the settings. The mutator
   * returns `true` to commit and `false`/`undefined` to abort; subscribers get
   * an EMPTY task list, which is their signal to refetch state rather than
   * patch a card.
   * @param mutator - (ledger) => boolean
   */
  async mutateSettings(mutator) {
    return this.#run('settings-updated', (draft) => {
      if (mutator(draft) !== true) return null
      return { summaries: [] }
    })
  }

  /**
   * The shared write path: clone, let `commit` decide, persist atomically,
   * bump the revision and broadcast. `commit` returns null to abort.
   */
  async #run(kind, commit) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      const outcome = commit(draft)
      if (outcome === null) {
        return { committed: false, ledger: this.snapshot(), changed: [] }
      }
      draft.revision += 1
      draft.schemaVersion = LEDGER_SCHEMA_VERSION
      draft.settings = normalizeSettings(draft.settings)
      this.ledger = draft
      try {
        await persistAtomic(this.file, JSON.stringify(this.ledger, null, 2))
      } catch (error) {
        console.warn('[dsh-plugin-taskboard] ledger write failed:', error.message)
      }
      const frozen = this.snapshot()
      for (const fn of [...this.subscribers]) {
        try {
          fn(new LedgerChange(draft.revision, kind, outcome.summaries, frozen))
        } catch (error) {
          console.warn('[dsh-plugin-taskboard] subscriber threw:', error?.message ?? error)
        }
      }
      return { committed: true, ledger: frozen, changed: outcome.summaries }
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Total live task count (for diagnostics). */
  get revision() {
    return this.ledger.revision
  }
}
