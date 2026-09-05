/**
 * Host-side automation ledger: one JSON file under the DSH home holding the
 * settings, the saved automations and their run history. Mutated through a serial
 * write queue, published as immutable snapshots with a monotonic revision, and
 * broadcast to subscribers (the SSE route) on every committed change. Corruption
 * on load is quarantined, never fatal.
 *
 * The structure mirrors the sibling taskboard and repopanel ledgers deliberately,
 * so the durability reasoning is reviewed once and reused: same serial queue,
 * same temp-write + rename publish, same deep-frozen snapshots, same
 * drop-the-bad-row load.
 *
 * One rule is specific to a scheduler: a `running` run loaded from disk is
 * impossible — its child process died with the previous host — so load() settles
 * every one of them as interrupted. That is done at LOAD time rather than by a
 * boot sweep, because every reader must see a truthful ledger, including one that
 * only ever reads.
 *
 * @module dsh-plugin-automation/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  AutomationError,
  ERR,
  LEDGER_SCHEMA_VERSION,
  MAX_AUTOMATIONS,
  applyDraft,
  applyRunOutcome,
  computeNextRun,
  createRun,
  createSkippedRun,
  dropRunsOf,
  emptyLedger,
  isPlausibleAutomation,
  isPlausibleRun,
  normalizeSettings,
  pruneRuns,
  reviveInterruptedRun,
  settleRun,
} from '../shared/protocol.js'

/** One committed ledger mutation, as broadcast to subscribers. */
export class AutomationChange {
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

/** Rebuild the automations map from an untrusted parse, dropping bad rows. */
function readAutomations(raw) {
  const out = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, row] of Object.entries(raw)) {
    if (!isPlausibleAutomation(row) || row.id !== id) {
      console.warn('[dsh-plugin-automation] dropping unusable automation:', id)
      continue
    }
    out[id] = row
  }
  return out
}

/** Rebuild the runs map, dropping bad rows and settling interrupted ones. */
function readRuns(raw, automations, now) {
  const out = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, row] of Object.entries(raw)) {
    if (!isPlausibleRun(row) || row.id !== id) continue
    // An orphan run (its automation was deleted by hand) has nothing to belong
    // to; the delete path already removes them, so this is a repair.
    if (automations[row.automationId] === undefined) continue
    out[id] = row.status === 'running' ? reviveInterruptedRun(row, now) : row
  }
  return out
}

export class AutomationStore {
  /** @param options - { file: string, now?: () => number } */
  constructor(options) {
    this.file = options.file
    this.now = options.now ?? (() => Date.now())
    this.ledger = emptyLedger()
    this.subscribers = new Set()
    this.queue = Promise.resolve()
    this.loaded = false
    /** Set when load() had to settle interrupted runs, so boot can persist them. */
    this.interrupted = 0
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
      console.warn('[dsh-plugin-automation] ledger unreadable:', error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[dsh-plugin-automation] quarantining corrupt ledger')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return
    }
    const automations = readAutomations(parsed.automations)
    const runs = readRuns(parsed.runs, automations, this.now())
    this.interrupted = Object.values(runs).filter((run) => run.error === '宿主进程重启，这次运行被中断').length
    this.ledger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      settings: normalizeSettings(parsed.settings),
      automations,
      runs,
    }
  }

  /** The current snapshot — a deep-frozen clone. */
  snapshot() {
    return deepFreeze(structuredClone(this.ledger))
  }

  /** The settings the scheduler behaves by, deep-frozen. */
  settings() {
    return deepFreeze(structuredClone(this.ledger.settings))
  }

  /** One automation by id, deep-frozen, or undefined. */
  automation(id) {
    const row = this.ledger.automations[id]
    return row === undefined ? undefined : deepFreeze(structuredClone(row))
  }

  /** One run by id, deep-frozen, or undefined. */
  run(id) {
    const row = this.ledger.runs[id]
    return row === undefined ? undefined : deepFreeze(structuredClone(row))
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
   * Ordering matches the sibling plugins: the durable write is awaited BEFORE
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
          fn(new AutomationChange(draft.revision, kind))
        } catch (error) {
          console.warn('[dsh-plugin-automation] subscriber threw:', error?.message ?? error)
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
   * Persist whatever load() repaired (interrupted runs, dropped rows). Called
   * once at boot so the first reader after a crash does not have to re-derive it.
   */
  async flushRepairs() {
    await this.load()
    if (this.interrupted === 0) return 0
    const count = this.interrupted
    this.interrupted = 0
    await this.mutate('runs-changed', () => true)
    return count
  }

  get revision() {
    return this.ledger.revision
  }

  // ------------------------------------------------------ ledger transactions
  // Every write the routes and the engine perform is one of these, so the
  // read-modify-write reasoning lives in one place and inside one queue.

  /** Merge a settings patch. Unknown keys are dropped by the normalizer. */
  async saveSettings(patch) {
    await this.mutate('settings-changed', (draft) => {
      draft.settings = normalizeSettings({ ...draft.settings, ...patch })
      return true
    })
    return this.settings()
  }

  /** Insert a fresh automation, refusing past the cap. */
  async insertAutomation(record) {
    let failure
    await this.mutate('automations-changed', (draft) => {
      if (Object.keys(draft.automations).length >= MAX_AUTOMATIONS) {
        failure = new AutomationError(ERR.invalidInput, `最多只能有 ${MAX_AUTOMATIONS} 条自动化`)
        return false
      }
      draft.automations[record.id] = record
      return true
    })
    if (failure !== undefined) throw failure
    return this.automation(record.id)
  }

  /** The version guard shared by every update path. */
  assertVersion(row, ifVersion) {
    if (ifVersion === undefined) return
    if (row.version !== ifVersion) {
      throw new AutomationError(ERR.conflict, `这条自动化已被改动（当前版本 ${row.version}），请刷新后重试`)
    }
  }

  /** Overwrite an automation from a validated draft. */
  async updateAutomation(id, draft, options) {
    let failure
    let updated
    await this.mutate('automations-changed', (ledger) => {
      const row = ledger.automations[id]
      if (row === undefined) {
        failure = new AutomationError(ERR.notFound, `没有这条自动化：${id}`)
        return false
      }
      try {
        this.assertVersion(row, options.ifVersion)
      } catch (error) {
        failure = error
        return false
      }
      updated = applyDraft(row, draft, options.now)
      ledger.automations[id] = updated
      return true
    })
    if (failure !== undefined) throw failure
    return this.automation(id)
  }

  /** Arm or disarm one automation, re-computing its next slot. */
  async setEnabled(id, enabled, options) {
    let failure
    await this.mutate('automations-changed', (ledger) => {
      const row = ledger.automations[id]
      if (row === undefined) {
        failure = new AutomationError(ERR.notFound, `没有这条自动化：${id}`)
        return false
      }
      try {
        this.assertVersion(row, options.ifVersion)
      } catch (error) {
        failure = error
        return false
      }
      const next = { ...row, enabled, version: row.version + 1, updatedAt: options.now }
      // Turning it back on forgives the streak that parked it; otherwise the
      // guard would park it again on the very next failure.
      if (enabled) {
        next.consecutiveFailures = 0
        delete next.pausedReason
      }
      next.nextRunAt = computeNextRun(next, { now: options.now })
      ledger.automations[id] = next
      return true
    })
    if (failure !== undefined) throw failure
    return this.automation(id)
  }

  /** Delete an automation and its run history. Returns whether it existed. */
  async deleteAutomation(id, options) {
    let failure
    let existed = false
    await this.mutate('automations-changed', (ledger) => {
      const row = ledger.automations[id]
      if (row === undefined) return false
      try {
        this.assertVersion(row, options?.ifVersion)
      } catch (error) {
        failure = error
        return false
      }
      existed = true
      delete ledger.automations[id]
      dropRunsOf(ledger, id)
      return true
    })
    if (failure !== undefined) throw failure
    return existed
  }

  /**
   * Open one run, or record why it was skipped — in a single transaction, so two
   * ticks (or a tick racing a "run now") cannot both open one.
   *
   * The automation's slot is advanced HERE rather than at settle time: leaving
   * `nextRunAt` in the past for the length of the run would make every tick in
   * between try again and get skipped.
   *
   * Engine writes deliberately do NOT bump `version` — that token belongs to the
   * user's editor, and a run happening while a form is open must not turn the
   * user's save into a conflict.
   *
   * @returns { run, skipped } — exactly one is set.
   */
  async beginRun(automationId, options) {
    let failure
    let started
    let skipped
    await this.mutate('runs-changed', (ledger) => {
      const row = ledger.automations[automationId]
      if (row === undefined) {
        failure = new AutomationError(ERR.notFound, `没有这条自动化：${automationId}`)
        return false
      }
      const shared = { now: options.now, trigger: options.trigger, scheduledFor: options.scheduledFor, cwd: options.cwd }
      const running = Object.values(ledger.runs).filter((run) => run.status === 'running')
      if (running.some((run) => run.automationId === automationId)) {
        skipped = createSkippedRun(row, { ...shared, reason: '上一次运行还没结束，这次跳过' })
      } else if (running.length >= ledger.settings.maxConcurrentRuns) {
        skipped = createSkippedRun(row, {
          ...shared,
          reason: `同时运行的自动化已达上限（${ledger.settings.maxConcurrentRuns}），这次跳过`,
        })
      } else {
        started = createRun(row, shared)
      }
      const opened = started ?? skipped
      ledger.runs[opened.id] = opened
      const fired = { ...row, lastRunAt: options.now, lastStatus: opened.status }
      fired.nextRunAt = computeNextRun(fired, { now: options.now })
      ledger.automations[automationId] = fired
      pruneRuns(ledger, ledger.settings.keepRunsPerAutomation)
      return true
    })
    if (failure !== undefined) throw failure
    return { run: started === undefined ? undefined : this.run(started.id), skipped: skipped === undefined ? undefined : this.run(skipped.id) }
  }

  /**
   * Attach mid-run findings (the session the run created, the card it filed).
   * Silently does nothing for a run that has already settled.
   */
  async attachRun(runId, patch) {
    await this.mutate('runs-changed', (ledger) => {
      const row = ledger.runs[runId]
      if (row === undefined || row.status !== 'running') return false
      let touched = false
      for (const key of ['sessionId', 'taskId', 'cwd']) {
        const value = patch[key]
        if (typeof value === 'string' && value.length > 0 && row[key] !== value) {
          row[key] = value
          touched = true
        }
      }
      return touched
    })
    return this.run(runId)
  }

  /**
   * Settle one run and fold the outcome onto its automation. Idempotent: the
   * child's exit and the timeout race by design, and the loser must be a no-op.
   *
   * @returns the settled run, or undefined when it was already terminal.
   */
  async finishRun(runId, outcome) {
    let settled
    await this.mutate('runs-changed', (ledger) => {
      const row = ledger.runs[runId]
      settled = settleRun(row, outcome)
      if (settled === undefined) return false
      ledger.runs[runId] = settled
      const automation = ledger.automations[settled.automationId]
      if (automation !== undefined) {
        ledger.automations[automation.id] = applyRunOutcome(automation, settled, {
          now: outcome.now,
          autoDisableAfterFailures: ledger.settings.autoDisableAfterFailures,
        })
      }
      pruneRuns(ledger, ledger.settings.keepRunsPerAutomation)
      return true
    })
    return settled === undefined ? undefined : this.run(runId)
  }

  /**
   * Move one automation's slot forward without running it. This is what happens
   * to a slot that came due while the host was down and whose automation does not
   * ask for catch-up: dropped, and recorded once so the user can see it was.
   */
  async skipSlot(automationId, options) {
    let recorded
    await this.mutate('runs-changed', (ledger) => {
      const row = ledger.automations[automationId]
      if (row === undefined) return false
      if (options.record === true) {
        recorded = createSkippedRun(row, {
          now: options.now,
          trigger: 'schedule',
          scheduledFor: options.scheduledFor,
          reason: '这个时间点错过了（宿主未运行），已跳过',
        })
        ledger.runs[recorded.id] = recorded
      }
      const fired = { ...row, lastStatus: 'skipped' }
      fired.nextRunAt = computeNextRun(fired, { now: options.now })
      ledger.automations[automationId] = fired
      pruneRuns(ledger, ledger.settings.keepRunsPerAutomation)
      return true
    })
    return recorded === undefined ? undefined : this.run(recorded.id)
  }
}
