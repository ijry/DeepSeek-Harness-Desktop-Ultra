/**
 * 执行队列调度器（并行上限）。
 *
 * 看板语义：`todo` 是还没排队的积压；一旦「发起会话」，卡片就进入执行管线
 * ——`queued`（排队中）→ `preparing`/`running`（会话在干活）。`settings.maxParallel`
 * 决定同一时刻最多几张卡能占用一个「会话额度」。
 *
 * 额度占用见 `occupiesSlot`：`preparing`/`running`/`awaiting_input`/`merging`
 * （会话在干活、握在手里），以及**已经有会话**的 `queued`（会话已建好、等 agent
 * 认领）。只有「还没有会话的 queued」才是真正排队等空位——若把它也算进去，队列
 * 永远等不到空位，就卡死了。
 *
 * 调度只有一个入口 `pump()`：
 * - **串行**：同一时刻只有一轮在跑，路由/订阅者可以随便调；
 * - **可重入**：运行中再次调用不会并发，而是在本轮结束后补一轮（新的空位可能刚出现）；
 * - **FIFO**：从最久排队的卡开始，有空位就为它开会话；
 * - **不自旋**：某张卡开会话失败时记录 failure 并结束本轮（否则队头会无限重试）；
 * - **失败可追**：failures 回给调用方，launch 路由据此把真实错误告诉用户，而不是
 *   假装排队成功。
 *
 * @module dsh-plugin-taskboard/host/queue
 */
import {
  DEFAULT_MAX_PARALLEL,
  MAX_PARALLEL_LIMIT,
  isWaitingInQueue,
  newCommentId,
  occupiesSlot,
  queueOrder,
} from '../shared/protocol.js'
import { buildLaunchMessage, launchedComment, sessionIdOf } from './launcher.js'
import { ERR, ToolError } from './tools.js'

/**
 * Build the queue pump bound to one store + one launcher resolver.
 * @param options - { store, resolveLauncher, now }
 *   `resolveLauncher()` returns the `{ createSession, prompt }` surface or
 *   undefined when the composition has no sessionController.
 * @returns {{ pump: () => Promise<{started: Array, failures: Array}>, dispose: () => void }}
 */
export function createQueuePump(options) {
  const { store, resolveLauncher, now } = options
  /** The in-flight pass, or null. Non-null is also the "already running" flag. */
  let running = null
  /** A call arrived mid-pass: run exactly one more pass afterwards. */
  let rerun = false
  let disposed = false

  function maxParallelOf(ledger) {
    const raw = ledger?.settings?.maxParallel
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX_PARALLEL_LIMIT ? raw : DEFAULT_MAX_PARALLEL
  }

  /** How many slots the board currently uses. */
  function activeCount(ledger) {
    return ledger.tasks.filter(occupiesSlot).length
  }

  /**
   * Start one session for a waiting card: create + prompt, then stamp the
   * session id onto the card so the agent's upcoming claim is not a second
   * session, and so the extra slot stays accounted for.
   */
  async function startOne(task, launcher) {
    const payload = {}
    if (typeof task.workspaceId === 'string' && task.workspaceId !== '') {
      payload.workspaceId = task.workspaceId
    }
    const created = await launcher.createSession(payload)
    const sessionId = sessionIdOf(created)
    if (sessionId === undefined) {
      throw new ToolError(ERR.internal, 'dsh did not return a session id for the queued task')
    }
    await launcher.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: buildLaunchMessage(task) }],
    })
    await store.mutate('task-launched', (ledger) => {
      const live = ledger.tasks.find((t) => t.id === task.id)
      // The card left the queue while the session was being created (cancel
      // queue, delete, agent claim): keep the ledger honest and drop the
      // session from the board. Nothing is lost — that session still has the
      // launch message and can claim the card itself.
      if (live === undefined || live.status !== 'queued') return []
      live.sessionId = sessionId
      delete live.queuedAt
      live.version += 1
      live.updatedAt = now()
      live.updatedBy = { kind: 'user' }
      live.comments = live.comments ?? []
      live.comments.push({
        id: newCommentId(),
        body: launchedComment(sessionId),
        createdAt: now(),
        actor: { kind: 'user' },
      })
      return [live]
    })
    return sessionId
  }

  /** One pass: fill every free slot from the head of the queue. */
  async function pass(launcher) {
    const started = []
    for (;;) {
      const ledger = store.snapshot()
      const max = maxParallelOf(ledger)
      const active = activeCount(ledger)
      if (active >= max) {
        return { started, failures: [] }
      }
      const waiting = ledger.tasks.filter(isWaitingInQueue).sort(queueOrder)
      const next = waiting[0]
      if (next === undefined) {
        return { started, failures: [] }
      }
      try {
        started.push({ id: next.id, sessionId: await startOne(next, launcher) })
      } catch (error) {
        // Break, do not retry: a task whose session refuses to start would
        // otherwise spin forever at the head of the queue. It stays queued and
        // the user can 取消排队 it (or fix the cause and change anything on the
        // board, which triggers a fresh pass).
        console.error(
          `[dsh-plugin-taskboard] 队列发起会话失败（${next.id}）：`,
          error?.message ?? error,
        )
        return { started, failures: [{ id: next.id, message: String(error?.message ?? error) }] }
      }
    }
  }

  /** One drain: keep taking passes for as long as a caller asked for another. */
  async function runPasses() {
    const total = { started: [], failures: [] }
    do {
      rerun = false
      const launcher = resolveLauncher()
      if (launcher === undefined || launcher === null) {
        return total
      }
      const result = await pass(launcher)
      total.started.push(...result.started)
      total.failures.push(...result.failures)
      if (result.failures.length > 0) return total
      if (disposed) return total
    } while (rerun)
    return total
  }

  /**
   * Run the queue. Safe to call from anywhere, as often as you like.
   *
   * 这里刻意把 promise 与 `running` **分开赋值**。`runPasses()` 在「没有
   * launcher」时会一个 await 都不经过、同步走到 return；若写成
   * `running = runPasses()` 的等价内联形式（`running = (async () => { …  finally
   * { running = null } })()`），函数体里的清理会**先于**赋值执行——于是
   * `running` 永远停在一个「已经完成」的 promise 上，此后每次 pump() 都以为有
   * 一轮在跑（`running !== null`），队列就此彻底不动、排队中的卡永远等不到会话。
   * 用 `.finally()` 把清理推进微任务，保证赋值先发生。
   *
   * @returns {{started: Array, failures: Array}} 本轮启动的会话与失败。
   */
  function pump() {
    if (disposed) {
      return Promise.resolve({ started: [], failures: [] })
    }
    if (running !== null) {
      rerun = true
      return running
    }
    const inFlight = runPasses().finally(() => {
      // A newer pump already took over: leave its bookkeeping alone.
      if (running !== inFlight) return
      const again = rerun
      running = null
      rerun = false
      // A caller joined after this pass had already finished; honor it.
      if (again && !disposed) void pump()
    })
    running = inFlight
    return inFlight
  }

  return {
    pump,
    dispose() {
      disposed = true
    },
  }
}
