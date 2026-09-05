/**
 * Background tasks: exports, imports, backups, restores, syncs.
 *
 * Three things differ from the reference on purpose:
 *
 * 1. **Cancel actually cancels.** The reference wrote `status = Cancelled` into a
 *    record that no worker ever read, so a cancelled export kept running and then
 *    overwrote its own status with `Completed`. Here every worker is handed an
 *    `AbortSignal` and is expected to check it between chunks.
 * 2. **Tasks live in memory only.** The reference persisted them to disk, which
 *    means a restart leaves `Running` rows that will never finish and a shutdown
 *    hook that blocks forever. A task cannot outlive the process that runs it, so
 *    neither should its record.
 * 3. **Progress is throttled.** One event per row (which is what a chunk size of 1
 *    plus an unconditional emit gave the reference) is a message storm; updates
 *    coalesce to at most one every 120 ms unless the status changed.
 *
 * @module dsh-plugin-otools-dbm/host/tasks
 */
import { randomUUID } from 'node:crypto'

import { DbmError, ERR } from '../shared/protocol.js'

/** Event name the panel listens for. */
export const TASK_EVENT = 'task-updated'

/** Minimum gap between two progress events for the same task. */
const PROGRESS_INTERVAL_MS = 120

export class TaskManager {
  /** @param options.emit - `(name, payload) => void`, the SSE broadcaster. */
  constructor({ emit } = {}) {
    this.emit = typeof emit === 'function' ? emit : () => {}
    /** id → record */
    this.tasks = new Map()
    /** id → { controller, promise } */
    this.workers = new Map()
    /** id → last emit timestamp */
    this.lastEmit = new Map()
  }

  /** Every task, newest first. */
  list() {
    return Array.from(this.tasks.values()).sort((left, right) =>
      String(right.created_at).localeCompare(String(left.created_at)),
    )
  }

  get(id) {
    return this.tasks.get(String(id ?? ''))
  }

  /** Tasks that are still going, for the shutdown hook. */
  active() {
    return this.list().filter((task) => task.status === 'Pending' || task.status === 'Running')
  }

  /**
   * Register a task and start its worker.
   *
   * @param options.name - what the panel shows.
   * @param options.type - 'Export' | 'Import' | 'Backup' | 'Restore' | 'Sync'.
   * @param options.metadata - string map; `retry_task` replays from it.
   * @param worker - `async ({ signal, progress, task }) => resultPath | void`.
   * @returns the task id, immediately.
   */
  start({ name, type, metadata = {} }, worker) {
    const now = new Date().toISOString()
    const task = {
      id: randomUUID(),
      name: String(name ?? '任务'),
      task_type: String(type ?? 'Custom'),
      status: 'Pending',
      progress: 0,
      created_at: now,
      updated_at: now,
      duration: 0,
      result_path: null,
      error_message: null,
      metadata: normalizeMetadata(metadata),
    }
    this.tasks.set(task.id, task)
    this.publish(task, true)

    const controller = new AbortController()
    const promise = this.drive(task, controller, worker)
    this.workers.set(task.id, { controller, promise })
    return task.id
  }

  /** Run the worker, translating its outcome into the task's terminal state. */
  async drive(task, controller, worker) {
    this.patch(task.id, { status: 'Running', progress: task.progress || 1 })
    try {
      const resultPath = await worker({
        signal: controller.signal,
        task,
        progress: (value, note) => {
          if (controller.signal.aborted) {
            return
          }
          this.patch(task.id, {
            progress: value,
            ...(note === undefined ? {} : { metadata: { note: String(note) } }),
          })
        },
      })
      if (controller.signal.aborted) {
        this.patch(task.id, { status: 'Cancelled', progress: 100 }, true)
        return
      }
      this.patch(
        task.id,
        {
          status: 'Completed',
          progress: 100,
          result_path: typeof resultPath === 'string' && resultPath.length > 0 ? resultPath : null,
        },
        true,
      )
    } catch (error) {
      if (controller.signal.aborted) {
        this.patch(task.id, { status: 'Cancelled', progress: 100 }, true)
        return
      }
      this.patch(
        task.id,
        { status: 'Failed', progress: 100, error_message: messageOf(error) },
        true,
      )
    } finally {
      this.workers.delete(task.id)
    }
  }

  /** Apply a partial update and broadcast it. */
  patch(id, changes, force = false) {
    const task = this.tasks.get(String(id ?? ''))
    if (task === undefined) {
      return undefined
    }
    const statusChanged = changes.status !== undefined && changes.status !== task.status

    if (changes.status !== undefined) {
      task.status = changes.status
    }
    if (changes.progress !== undefined) {
      const value = Number(changes.progress)
      task.progress = Number.isFinite(value) ? Math.min(100, Math.max(0, Number(value.toFixed(2)))) : task.progress
    }
    if (changes.result_path !== undefined) {
      task.result_path = changes.result_path
    }
    if (changes.error_message !== undefined) {
      task.error_message = changes.error_message
    }
    if (changes.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...normalizeMetadata(changes.metadata) }
    }

    task.updated_at = new Date().toISOString()
    task.duration = Math.max(0, new Date(task.updated_at).getTime() - new Date(task.created_at).getTime())
    this.publish(task, force || statusChanged)
    return task
  }

  /** Broadcast, coalescing bursts of progress into one event per interval. */
  publish(task, force) {
    const now = Date.now()
    const last = this.lastEmit.get(task.id) ?? 0
    if (!force && now - last < PROGRESS_INTERVAL_MS) {
      return
    }
    this.lastEmit.set(task.id, now)
    this.emit(TASK_EVENT, { ...task })
  }

  /** Ask a running task to stop. Returns whether there was one. */
  cancel(id) {
    const key = String(id ?? '')
    const task = this.tasks.get(key)
    if (task === undefined) {
      throw new DbmError(ERR.notFound, `任务不存在: ${key}`)
    }
    const worker = this.workers.get(key)
    if (worker === undefined) {
      // Already finished: mark it cancelled only if it never reached a terminal
      // state, so a Completed task is not rewritten by a late click.
      if (task.status === 'Pending' || task.status === 'Running') {
        this.patch(key, { status: 'Cancelled', progress: 100 }, true)
      }
      return false
    }
    worker.controller.abort()
    this.patch(key, { status: 'Cancelled', progress: 100 }, true)
    return true
  }

  /** Drop finished tasks; returns how many went. */
  clearCompleted() {
    let removed = 0
    for (const [id, task] of Array.from(this.tasks.entries())) {
      if (task.status === 'Completed' || task.status === 'Failed' || task.status === 'Cancelled') {
        this.tasks.delete(id)
        this.lastEmit.delete(id)
        removed += 1
      }
    }
    return removed
  }

  /** Abort everything, for plugin teardown. */
  disposeAll() {
    for (const { controller } of this.workers.values()) {
      controller.abort()
    }
    this.workers.clear()
  }
}

/** Task metadata is a string map on the wire; coerce whatever we were given. */
function normalizeMetadata(metadata) {
  const output = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === undefined || value === null) {
      continue
    }
    output[String(key)] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return output
}

/** Message of anything throwable. */
export function messageOf(error) {
  if (error === null || error === undefined) {
    return '未知错误'
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}

/** Throw the standard abort error when a worker's signal has fired. */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new DbmError(ERR.conflict, '任务已取消')
  }
}
