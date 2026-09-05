/**
 * The scheduler: one tick loop over the ledger, one in-flight table, and the
 * dispatch from a due automation to its delivery (a headless agent run, or a card
 * on the sibling task board).
 *
 * Ordering discipline, because a scheduler that runs a job twice is worse than
 * one that runs it late:
 *
 * - the ledger transaction that opens a run also advances the automation's slot,
 *   so a slow run cannot be re-fired by the next tick (see store.beginRun);
 * - the in-flight table is keyed by automation id, so "run now" cannot race the
 *   tick past the overlap policy;
 * - every path that opens a run also settles it — spawn failure, timeout, cancel
 *   and host shutdown included. A `running` row is never left behind on purpose,
 *   and one left behind by a crash is settled on the next load.
 *
 * The loop is a self-rescheduling timeout rather than setInterval: a tick that
 * takes longer than the period must not stack up behind itself.
 *
 * @module dsh-plugin-automation/host/engine
 */
import { composePrompt, dueAutomations } from '../shared/protocol.js'
import { CHILD_ENV, startHeadlessRun } from './runner.js'
import { dshCliEntry, dshHomePath } from './sdk.js'
import { fileTaskCard } from './taskboard.js'

/** How often the loop looks for due automations. Cron resolution is one minute. */
export const TICK_MS = 20_000

/** The first tick waits this long, so a boot storm does not compete with startup. */
export const BOOT_DELAY_MS = 5_000

export class AutomationEngine {
  /**
   * @param options - { store, workspaces, taskboardBase, now?, cliEntry?,
   *   sessionsDir?, startRun?, fileCard?, env? }
   */
  constructor(options) {
    this.store = options.store
    this.workspaces = options.workspaces
    this.taskboardBase = options.taskboardBase
    this.now = options.now ?? (() => Date.now())
    this.env = options.env ?? process.env
    // `null` means "there is no launcher" (a test, or an embedder), which is a
    // different statement from "you did not tell me" — hence not `??`.
    this.cliEntry = options.cliEntry === undefined ? dshCliEntry() : (options.cliEntry ?? undefined)
    this.sessionsDir = options.sessionsDir ?? dshHomePath('sessions')
    // Seams for tests: both default to the real implementations.
    this.startRun = options.startRun ?? startHeadlessRun
    this.fileCard = options.fileCard ?? fileTaskCard
    /** automationId → { runId, handle, startedAt } */
    this.inFlight = new Map()
    /** Session ids already attributed to a run, so two runs cannot claim one. */
    this.claimedSessions = new Set()
    this.timer = undefined
    this.stopped = false
    this.tickCount = 0
    this.nextTickAt = undefined
  }

  /** Start the loop. Idempotent. */
  start() {
    if (this.timer !== undefined || this.stopped) return
    // A dsh that a run booted is not allowed to schedule anything: it would fork
    // the scheduler once per firing.
    if (this.env[CHILD_ENV] === '1') {
      console.warn('[dsh-plugin-automation] 本进程是自动化启动的子进程，调度器不启动')
      this.stopped = true
      return
    }
    void this.boot()
    this.schedule(BOOT_DELAY_MS)
  }

  /** Persist whatever the load repaired, so a crashed run stops looking live. */
  async boot() {
    try {
      const interrupted = await this.store.flushRepairs()
      if (interrupted > 0) {
        console.warn(`[dsh-plugin-automation] ${interrupted} 次运行因宿主重启被标记为中断`)
      }
    } catch (error) {
      console.warn('[dsh-plugin-automation] boot repair failed:', error?.message ?? error)
    }
  }

  /** Arm the next tick. */
  schedule(delay = TICK_MS) {
    if (this.stopped) return
    this.nextTickAt = this.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().finally(() => this.schedule())
    }, delay)
    // A pending tick must never be the reason the process stays alive.
    this.timer.unref?.()
  }

  /**
   * One pass over the ledger. Never throws: a scheduler that dies on one bad
   * automation stops every other one too.
   */
  async tick() {
    if (this.stopped) return
    this.tickCount += 1
    let due
    try {
      await this.store.load()
      due = dueAutomations(this.store.snapshot(), { now: this.now() })
    } catch (error) {
      console.warn('[dsh-plugin-automation] tick failed to read the ledger:', error?.message ?? error)
      return
    }
    for (const entry of due) {
      if (this.stopped) return
      try {
        await this.fireDue(entry)
      } catch (error) {
        console.warn(`[dsh-plugin-automation] ${entry.id} 触发失败:`, error?.message ?? error)
      }
    }
  }

  /**
   * One due slot. A slot that came due while the host was down is a different
   * event from one that just arrived: unless the automation asks for catch-up it
   * is dropped, and recorded once so the history says so instead of staying
   * silent.
   */
  async fireDue(entry) {
    const record = this.store.automation(entry.id)
    if (record === undefined) return
    if (entry.missed && record.catchUp !== true) {
      await this.store.skipSlot(entry.id, { now: this.now(), scheduledFor: entry.scheduledFor, record: true })
      return
    }
    await this.fire(entry.id, {
      trigger: entry.missed ? 'catchup' : 'schedule',
      scheduledFor: entry.scheduledFor,
    })
  }

  /**
   * Fire one automation. Returns the opened run, or the skipped row that explains
   * why nothing was opened.
   *
   * @param id - automation id.
   * @param options - { trigger, scheduledFor? }
   */
  async fire(id, options) {
    const record = this.store.automation(id)
    if (record === undefined) return undefined
    const live = this.inFlight.get(id)
    if (live !== undefined && record.overlap === 'cancel') {
      // Policy says the newest firing wins: stop the old one and wait for it to
      // settle, so beginRun does not see two running rows.
      live.handle?.kill('cancel')
      await live.settled?.catch(() => undefined)
    }
    const cwd = this.cwdFor(record)
    const opened = await this.store.beginRun(id, {
      now: this.now(),
      trigger: options.trigger,
      scheduledFor: options.scheduledFor,
      cwd,
    })
    if (opened.run === undefined) return opened.skipped
    if (record.action.kind === 'taskboard') {
      await this.deliverToBoard(record, opened.run)
      return this.store.run(opened.run.id)
    }
    await this.launch(record, opened.run, cwd)
    return this.store.run(opened.run.id)
  }

  /**
   * The directory a run happens in: the project's own path, or the host's working
   * directory for an automation with no project. A workspace that has been removed
   * from the registry falls back to the host cwd rather than failing the run —
   * but the run records which directory it actually used.
   */
  cwdFor(record) {
    if (record.workspaceId === undefined) return process.cwd()
    const workspace = this.workspaces?.get(record.workspaceId)
    return workspace?.path ?? process.cwd()
  }

  /** Spawn the headless child and settle the run when it finishes. */
  async launch(record, run, cwd) {
    if (this.cliEntry === undefined) {
      await this.store.finishRun(run.id, {
        status: 'failed',
        now: this.now(),
        error: '找不到 dsh 启动器：无法确定本进程的启动脚本，请设置 DSH_PLUGIN_AUTOMATION_DSH_ENTRY 指向 dsh 的 bin.js',
      })
      return
    }
    const settings = this.store.settings()
    const timeoutMinutes = record.action.timeoutMinutes ?? settings.defaultTimeoutMinutes
    let handle
    try {
      handle = await this.startRun({
        entry: this.cliEntry,
        cwd,
        prompt: composePrompt(record, settings),
        timeoutMs: timeoutMinutes * 60_000,
        sessionsDir: this.sessionsDir,
        claimed: this.claimedSessions,
      })
    } catch (error) {
      await this.store.finishRun(run.id, {
        status: 'failed', now: this.now(), error: `无法启动运行：${error?.message ?? error}`,
      })
      return
    }
    const settled = handle.done.then(async (outcome) => {
      this.inFlight.delete(record.id)
      await this.store.finishRun(run.id, { ...outcome, now: this.now() })
    }).catch((error) => {
      this.inFlight.delete(record.id)
      console.warn('[dsh-plugin-automation] 结算失败:', error?.message ?? error)
    })
    this.inFlight.set(record.id, { runId: run.id, handle, startedAt: run.startedAt, pid: handle.pid, settled })
  }

  /**
   * File one card on the sibling task board. This delivery executes nothing, so
   * the run settles immediately — succeeded when the card exists, failed with the
   * board's own reason when it does not.
   */
  async deliverToBoard(record, run) {
    const settings = this.store.settings()
    try {
      const task = await this.fileCard({
        base: this.taskboardBase(),
        automation: record,
        prompt: composePrompt(record, settings),
        now: this.now(),
      })
      await this.store.finishRun(run.id, {
        status: 'succeeded',
        now: this.now(),
        taskId: task.id,
        output: `已在任务看板建卡：${task.title}`,
      })
    } catch (error) {
      await this.store.finishRun(run.id, {
        status: 'failed', now: this.now(), error: `投递到任务看板失败：${error?.message ?? error}`,
      })
    }
  }

  /**
   * Run one automation now, whatever its schedule says. Deliberately ignores the
   * master switch: pausing the scheduler is how a user stops the CLOCK, and an
   * explicit click is not the clock.
   */
  async runNow(id) {
    return this.fire(id, { trigger: 'manual' })
  }

  /**
   * Cancel one in-flight run. Returns whether a live child was signalled — a run
   * that already settled answers false rather than pretending.
   */
  async cancel(runId) {
    for (const [automationId, live] of this.inFlight) {
      if (live.runId !== runId) continue
      live.handle?.kill('cancel')
      await live.settled?.catch(() => undefined)
      this.inFlight.delete(automationId)
      return true
    }
    return false
  }

  /** What the panel shows about the engine itself. */
  status() {
    return {
      tickCount: this.tickCount,
      nextTickAt: this.nextTickAt,
      cliAvailable: this.cliEntry !== undefined,
      running: [...this.inFlight.entries()].map(([automationId, live]) => ({
        automationId, runId: live.runId, startedAt: live.startedAt, pid: live.pid,
      })),
    }
  }

  /**
   * Stop the loop and every child it started. Leaving an unsupervised agent alive
   * in a repository after its supervisor is gone is the one outcome this plugin
   * must never produce, so shutdown kills rather than detaches — the runs settle
   * as canceled.
   */
  async dispose() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const pending = [...this.inFlight.values()]
    this.inFlight.clear()
    for (const live of pending) live.handle?.kill('cancel')
    await Promise.allSettled(pending.map((live) => live.settled))
  }
}
