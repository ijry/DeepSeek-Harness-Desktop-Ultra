/**
 * The operation registry behind the progress dialog.
 *
 * A fetch, pull, push, clone or submodule update takes seconds to minutes and has
 * to survive the browser closing the request, so those are NOT served inline:
 * POST starts an operation and answers with its id, progress and log lines are
 * broadcast over SSE, and the dialog reads the record. That is the same
 * contract as the reference's OperationDialog (a bar, the command, a growing
 * output pane), just with the operation living on the host instead of in the
 * renderer.
 *
 * @module dsh-plugin-otools-git/host/ops
 */
import { randomUUID } from 'node:crypto'
import { ERR, GitError } from '../shared/protocol.js'

/** How many finished operations are kept for the dialog to read back. */
const KEEP_FINISHED = 40

/** How long a finished operation stays readable. */
const FINISHED_TTL_MS = 30 * 60_000

/** Cap on log lines per operation, so a chatty clone cannot grow unbounded. */
const MAX_LOG_LINES = 4_000

/** Operation kinds the panel starts. */
export const OP_KINDS = [
  'fetch', 'pull', 'push', 'submodule-update', 'submodule-add',
  'prune', 'ai-commit-message', 'delete-remote-branch', 'delete-remote-tag',
]

/** Create the registry. `onChange` is called with every mutated record. */
export function createOperations(options = {}) {
  const { onChange, now = () => Date.now() } = options
  const records = new Map()

  const emit = (record) => {
    if (onChange === undefined) return
    try {
      onChange(publicView(record))
    } catch (error) {
      console.warn('[dsh-plugin-otools-git] operation listener threw:', error?.message ?? error)
    }
  }

  /** Forget finished records that are old or beyond the keep-count. */
  const sweep = () => {
    const finished = [...records.values()]
      .filter((record) => record.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    const stale = finished.filter((record) => (record.finishedAt ?? 0) + FINISHED_TTL_MS < now())
    const excess = finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))
    for (const record of [...stale, ...excess]) records.delete(record.id)
  }

  return {
    /**
     * Start one operation. `run(reporter)` does the work; whatever it resolves to
     * becomes the record's `result`.
     */
    start(input, run) {
      const record = {
        id: randomUUID(),
        kind: input.kind,
        title: input.title,
        command: input.command ?? '',
        root: input.root,
        status: 'running',
        percent: 0,
        phase: '',
        log: [],
        partial: undefined,
        startedAt: now(),
        finishedAt: undefined,
        result: undefined,
        error: undefined,
        cancelable: input.cancelable !== false,
      }
      const controller = new AbortController()
      record.controller = controller
      records.set(record.id, record)
      emit(record)

      const reporter = {
        signal: controller.signal,
        progress(update) {
          if (record.status !== 'running') return
          const percent = Number.isFinite(update?.percent) ? Math.max(0, Math.min(100, Math.round(update.percent))) : undefined
          // Monotonic: a phase change never rewinds the bar, which is what makes
          // the dialog feel truthful instead of jumpy.
          if (percent !== undefined) record.percent = Math.max(record.percent, percent)
          if (typeof update?.label === 'string' && update.label.length > 0) record.phase = update.label
          emit(record)
        },
        log(line) {
          if (record.status !== 'running') return
          const text = String(line ?? '').replace(/\s+$/, '')
          if (text.length === 0) return
          record.log.push(text)
          if (record.log.length > MAX_LOG_LINES) {
            record.log.splice(0, record.log.length - MAX_LOG_LINES)
            record.truncated = true
          }
          emit(record)
        },
        /**
         * Streamed CONTENT, as opposed to a log line: appended verbatim, so
         * newlines and trailing spaces survive. The AI writer needs this — its
         * output is a commit message, and `log()` strips exactly the whitespace
         * that carries the message's shape.
         */
        partial(text) {
          if (record.status !== 'running') return
          const chunk = String(text ?? '')
          if (chunk.length === 0) return
          record.partial = (record.partial ?? '') + chunk
          if (record.partial.length > 64_000) record.partial = record.partial.slice(-64_000)
          emit(record)
        },
      }

      // Detached on purpose: the POST answers with the id immediately and the
      // browser follows the SSE stream from there.
      void (async () => {
        try {
          const result = await run(reporter)
          record.status = 'done'
          record.percent = 100
          record.result = result
        } catch (error) {
          record.status = controller.signal.aborted ? 'canceled' : 'failed'
          record.error = {
            code: error instanceof GitError ? error.code : ERR.internal,
            message: error?.message ?? String(error),
            // Carried through so the progress dialog can offer the safe.directory
            // repair rather than only showing git's refusal.
            dubious: error?.dubious,
          }
          if (typeof error?.stderr === 'string' && error.stderr.length > 0) {
            for (const line of error.stderr.split(/\r?\n/)) {
              if (line.trim().length > 0) record.log.push(line)
            }
          }
        } finally {
          record.finishedAt = now()
          record.controller = undefined
          emit(record)
          sweep()
        }
      })()

      return publicView(record)
    },

    /** One record, or undefined. */
    get(id) {
      const record = records.get(id)
      return record === undefined ? undefined : publicView(record)
    },

    /** Every record, newest first. */
    list() {
      return [...records.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((record) => publicView(record))
    },

    /** Ask a running operation to stop. */
    cancel(id) {
      const record = records.get(id)
      if (record === undefined) throw new GitError(ERR.notFound, `没有编号为 ${id} 的操作`)
      if (record.status !== 'running') return publicView(record)
      if (!record.cancelable) throw new GitError(ERR.invalidInput, '该操作不支持取消')
      record.controller?.abort()
      return publicView(record)
    },

    /** Is anything running for this repository? (Guards concurrent mutations.) */
    busy(root) {
      for (const record of records.values()) {
        // The AI writer only READS the repository, so it must not block a commit:
        // holding the panel hostage for the length of a model call would be a
        // worse bug than the race it was meant to prevent.
        if (record.kind === 'ai-commit-message') continue
        if (record.status === 'running' && record.root === root) return publicView(record)
      }
      return undefined
    },

    /** Stop everything (plugin teardown). */
    dispose() {
      for (const record of records.values()) record.controller?.abort()
      records.clear()
    },
  }
}

/** The record shape the browser sees — no AbortController, no internals. */
function publicView(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    command: record.command,
    root: record.root,
    status: record.status,
    percent: record.percent,
    phase: record.phase,
    log: record.log,
    partial: record.partial,
    truncated: record.truncated === true,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    result: record.result,
    error: record.error,
    cancelable: record.cancelable,
  }
}
