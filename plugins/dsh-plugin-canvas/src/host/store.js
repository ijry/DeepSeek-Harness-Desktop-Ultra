/**
 * Host-side canvas ledger: one JSON file under the DSH home, mutated through a
 * serial write queue and published as immutable snapshots with a dense
 * monotonic revision. Change subscribers (the SSE route) observe every committed
 * mutation. Corruption on load is quarantined, never fatal.
 *
 * The revision protocol is codeg-plus's, ported whole (`canvas_service.rs`):
 * every committed mutation bumps the counter by exactly one and maps to exactly
 * ONE broadcast carrying that revision. Clients apply an event at
 * `lastRevision + 1`, drop anything at or below, and treat anything above as a
 * gap → refetch the snapshot. A mutation that turns out to be a no-op consumes
 * no revision, so the sequence never has holes a client would read as a gap.
 *
 * @module dsh-plugin-canvas/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NODE_KINDS } from '../shared/model.js'

/** Ledger schema version, bumped only for a breaking on-disk change. */
export const LEDGER_SCHEMA_VERSION = 1

/** A fresh, empty board. */
export function emptyLedger() {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, nextId: 1, nodes: [] }
}

/** Whether a parsed entry is shaped enough to keep. A row that fails this would
 *  render as an invisible or unmovable element, so dropping it is kinder than
 *  keeping it. */
export function isPlausibleNode(entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (!Number.isInteger(entry.id) || entry.id <= 0) return false
  if (!NODE_KINDS.includes(entry.kind)) return false
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof entry[key] !== 'number' || !Number.isFinite(entry[key])) return false
  }
  if (!Array.isArray(entry.memberIds)) return false
  return true
}

/** Persist atomically: write a temp file in the same directory, then rename over
 *  the target (atomic on POSIX and on Windows NTFS). */
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

export class CanvasStore {
  /** @param options - { file: string } */
  constructor(options) {
    this.file = options.file
    this.ledger = emptyLedger()
    this.subscribers = new Set()
    this.queue = Promise.resolve()
    this.loaded = false
  }

  /** Load (once) from disk; a missing file starts empty, a corrupt one is
   *  quarantined next to itself so the board comes up rather than wedging. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return
      console.warn('[dsh-plugin-canvas] ledger unreadable:', error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.nodes)) {
      console.warn('[dsh-plugin-canvas] quarantining corrupt ledger')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* best effort */
      }
      return
    }
    const nodes = []
    let maxId = 0
    for (const entry of parsed.nodes) {
      if (!isPlausibleNode(entry)) {
        console.warn('[dsh-plugin-canvas] dropping implausible ledger entry:', entry?.id)
        continue
      }
      nodes.push(entry)
      if (entry.id > maxId) maxId = entry.id
    }
    // Never hand out an id a surviving row already holds, whatever the stored
    // counter says: a reused id would silently retarget another client's drag.
    const storedNext = Number.isInteger(parsed.nextId) ? parsed.nextId : 1
    this.ledger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      nextId: Math.max(storedNext, maxId + 1),
      nodes,
    }
  }

  /** The current snapshot — a deep-frozen clone. */
  snapshot() {
    return deepFreeze(structuredClone({ nodes: this.ledger.nodes, revision: this.ledger.revision }))
  }

  /** One node by id (deep-frozen clone). */
  get(id) {
    const node = this.ledger.nodes.find((n) => n.id === id)
    return node === undefined ? undefined : deepFreeze(structuredClone(node))
  }

  /** Subscribe to committed changes; returns the unsubscribe function. */
  subscribe(fn) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * Run one mutation inside the serial queue. The mutator receives a structured
   * clone of the ledger and returns the change payload to broadcast, or
   * `undefined` to abort with no write and no revision bump.
   *
   * @param mutator - (draft) => object | undefined
   */
  async mutate(mutator) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      const change = mutator(draft)
      if (change === undefined) {
        return { committed: false, change: undefined, revision: this.ledger.revision }
      }
      draft.revision += 1
      draft.schemaVersion = LEDGER_SCHEMA_VERSION
      this.ledger = draft
      const payload = deepFreeze({ ...change, revision: draft.revision })
      try {
        await persistAtomic(this.file, JSON.stringify(this.ledger, null, 2))
      } catch (error) {
        console.warn('[dsh-plugin-canvas] ledger write failed:', error.message)
      }
      for (const fn of [...this.subscribers]) {
        try {
          fn(payload)
        } catch (error) {
          console.warn('[dsh-plugin-canvas] subscriber threw:', error?.message ?? error)
        }
      }
      return { committed: true, change: payload, revision: draft.revision }
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  get revision() {
    return this.ledger.revision
  }
}
