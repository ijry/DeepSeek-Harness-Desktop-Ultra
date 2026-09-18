/**
 * /dsh-plugin-taskboard routes on the shared DSH webserver: a JSON API for the
 * GUI's human operations plus an SSE stream mirroring every committed ledger
 * mutation. The API is the USER side of the board — every write below is
 * actor { kind: 'user' }, and the `move → done` acceptance action (which the
 * agent tools reject) IS allowed here, gated by the shared user rules.
 *
 * All domain validation runs through the shared protocol pure functions; this
 * layer only maps transport to the { ok } envelope.
 *
 * Two routes are queue-shaped rather than card-shaped:
 * - `launch` moves a todo card into the execution pipeline (`todo → queued`) and
 *   then lets the dispatcher (host/queue.js) decide whether a session may start
 *   now or the card has to wait for a free `settings.maxParallel` slot;
 * - `unqueue` takes a card that is still waiting back out to todo.
 *
 * @module dsh-plugin-taskboard/host/routes
 */
import { hostLang } from '../shared/lang.js'
import {
  HOLD_STATUSES,
  canUserReject,
  createTaskRecord,
  hasSession,
  isWaitingInQueue,
  isValidStatus,
  newCommentId,
  normalizeMaxParallel,
  normalizeOptionalText,
  normalizeSettings,
  normalizeTitle,
  normalizeWorkspaceId,
  occupiesSlot,
  userCanMove,
} from '../shared/protocol.js'
import { ERR, ToolError, liveTaskAt, versionGuard } from './tools.js'
import { LAUNCHABLE_STATUSES, queuedComment } from './launcher.js'
import { createQueuePump } from './queue.js'
import { createEventSocket } from './socket.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-taskboard'

/** SSE stream path (registered as an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-taskboard/events'

/** WebSocket upgrade path. Owned here rather than in ./socket.js: that module is
 *  shared verbatim across the panel plugins, so the route belongs to the caller. */
export const SOCKET_PATH = '/dsh-plugin-taskboard/socket'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Route shapes, compiled once at module load. */
const TASK_RE = new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)$`)
const TASK_ACTION_RE = new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)/([\\w-]+)$`)

/** Envelope writer. */
function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** { ok: true } writer. */
function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/** Map an error code to its HTTP status. */
function statusOf(code) {
  return code === 'invalid_input' || code === 'invalid_transition' ? 400
    : code === 'not_found' ? 404
      : code === 'version_conflict' ? 409
        : code === 'forbidden' ? 403
          : code === 'unavailable' ? 503
            : 500
}

/** { ok: false } writer. */
function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Read one JSON body ({ } when empty; null on parse failure). */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new ToolError(ERR.invalidInput, 'body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Optional text field (undefined when absent; invalid_input when not a string). */
function textField(body, key, label) {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ToolError(ERR.invalidInput, `${label} must be a string`)
  return value
}

/** Optional number field (undefined when absent; invalid_input when not a number). */
function numberField(body, key) {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new ToolError(ERR.invalidInput, `${key} must be a number`)
  return value
}

/** How many execution slots the board currently uses. */
function activeSlots(ledger) {
  return ledger.tasks.filter(occupiesSlot).length
}

/** The configured parallelism (settings are normalized, so this never throws). */
function maxParallelOf(ledger) {
  return normalizeSettings(ledger.settings).maxParallel
}

/** Map an execution error onto the { ok:false } envelope. */
function envelopeOfError(error) {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message, status: statusOf(error.code) }
  }
  const base = error?.message ?? String(error)
  // dsh 上游的 RemoteError 常把真正的原因放在 details.reason 里（例如
  // session/agent-busy 的 message 恒为 "prompt rejected"，内层错误只在 reason）。
  // 丢掉它会让这类故障变成一句无法追查的套话，所以这里补进 message。
  const reason = error?.details?.reason
  const message = typeof reason === 'string' && reason !== '' && !base.includes(reason)
    ? `${base}（${reason}）`
    : base
  if (/^(title|description|prompt|workspaceId|body) must/.test(message)) {
    return { code: 'invalid_input', message, status: 400 }
  }
  console.error('[dsh-plugin-taskboard] route error:', message)
  return { code: 'internal', message, status: 500 }
}

/**
 * Register the board routes (JSON prefix + exact SSE stream) on a webServer
 * context. Returns the disposer.
 * @param options - { store, workspaces, now, launcher }
 *   `launcher` (from ctx.sessionController) is either the `{ createSession, prompt }`
 *   surface or a getter returning it; absent when the composition has none.
 */
export function registerTaskboardRoutes(ctx, options) {
  let shared
  const stopSharedInject = ctx.inject?.(['otoolsSocket'], sharedCtx => {
    shared = sharedCtx.otoolsSocket.registerSource({
      id: 'taskboard', protocolVersion: 1, exposure: 'internal',
      catalog: { title: 'taskboard', commands: [] },
      hello: () => ({ revision: store.snapshot().revision }), onRequest: () => ({}),
    })
    return () => { shared?.dispose(); shared = undefined }
  })
  const { store, workspaces, now } = options
  const { pump, dispose: disposePump } = createQueuePump({
    store,
    // Same lazy resolution as the launch route: the composition may mount the
    // sessionController after this plugin.
    resolveLauncher: () => {
      const launcher = typeof options.launcher === 'function' ? options.launcher() : options.launcher
      return launcher === undefined ? null : launcher
    },
    now,
  })
  /**
   * The queue advances on its own: every committed change (an agent handing off
   * to review, the user accepting, the parallelism setting changing) can free a
   * slot, and the pump starts the longest-waiting task in it. The pump returns
   * early when no launcher exists, so this costs nothing without one.
   */
  const unsubscribePump = store.subscribe(() => { void pump() })
  const subscribers = new Set()
  let heartbeat

  // Same frames, two carriers: the socket is preferred by the panel because an
  // SSE would hold one of the origin's ~6 HTTP connections for its whole life
  // (see ./socket.js); SSE stays for a DSH build with no upgrade hook.
  const socket = createEventSocket(ctx, {
    path: SOCKET_PATH,
    hello: () => ({ revision: store.snapshot().revision }),
  })

  const broadcast = (change) => {
    const data = { revision: change.revision, kind: change.kind, tasks: change.tasks }
    const frame = `event: change\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of subscribers) res.write(frame)
    socket?.broadcast('change', data)
    shared?.emit('change', data)
  }
  const unsubscribeBroadcast = store.subscribe(broadcast)

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      // ----------------------------------------------------------------- GET
      if (req.method === 'GET') {
        if (pathname === `${ROUTE_PREFIX}/state`) {
          await store.load()
          // `language` is how the browser half learns the shell's UI language:
          // it runs in the DSH page and cannot read DSH_DESKTOP_LANG itself.
          ok(res, { ...store.snapshot(), language: hostLang() })
          return
        }
        if (pathname === `${ROUTE_PREFIX}/workspaces`) {
          ok(res, workspaces.list())
          return
        }
        const taskMatch = TASK_RE.exec(pathname)
        if (taskMatch !== null) {
          const task = store.get(taskMatch[1])
          if (task === undefined) {
            sendFail(res, ERR.notFound, `no task ${taskMatch[1]}`)
            return
          }
          ok(res, { ...task })
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      // ---------------------------------------------------------------- POST
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) {
          sendFail(res, ERR.invalidInput, 'request body must be valid JSON')
          return
        }
        const actor = { kind: 'user' }

        // -------------------------------------------------------------- create
        if (pathname === `${ROUTE_PREFIX}/tasks`) {
          const rawTitle = textField(body, 'title', 'title')
          if (rawTitle === undefined) throw new ToolError(ERR.invalidInput, 'title is required')
          const task = createTaskRecord({
            title: normalizeTitle(rawTitle),
            description: normalizeOptionalText(textField(body, 'description', 'description'), 'description'),
            prompt: normalizeOptionalText(textField(body, 'prompt', 'prompt'), 'prompt'),
            workspaceId: normalizeWorkspaceId(textField(body, 'workspaceId', 'workspaceId')),
            actor,
            now: now(),
          })
          await store.mutate('task-created', (ledger) => {
            ledger.tasks.push(task)
            return [task]
          })
          ok(res, { ...task }, 201)
          return
        }

        // ----------------------------------------------------------- settings
        // Board-level knobs (today only maxParallel). No ifVersion: this is not
        // a per-card document, last write wins.
        if (pathname === `${ROUTE_PREFIX}/settings`) {
          const raw = body.maxParallel
          if (raw === undefined) throw new ToolError(ERR.invalidInput, 'maxParallel is required')
          let maxParallel
          try {
            maxParallel = normalizeMaxParallel(raw)
          } catch (error) {
            throw new ToolError(ERR.invalidInput, error.message)
          }
          await store.mutateSettings((ledger) => {
            if (normalizeSettings(ledger.settings).maxParallel === maxParallel) return false
            ledger.settings = { ...normalizeSettings(ledger.settings), maxParallel }
            return true
          })
          ok(res, { settings: { ...normalizeSettings(store.snapshot().settings) } })
          // Raising the cap must let the queue drain immediately; lowering it just
          // makes the next pass stop earlier. (The store subscriber also pumps —
          // this makes the effect synchronous for the caller.)
          void pump()
          return
        }

        // ---------------------------------------------------------- per-task actions
        const actionMatch = TASK_ACTION_RE.exec(pathname)
        if (actionMatch !== null) {
          const id = actionMatch[1]
          const action = actionMatch[2]
          const preflight = store.get(id)
          if (preflight === undefined) {
            sendFail(res, ERR.notFound, `no task ${id}`)
            return
          }

          // update: title / description / prompt / workspaceId (all optional;
          // an empty update is a committed no-op, never a version bump).
          if (action === 'update') {
            const ifVersion = numberField(body, 'ifVersion')
            const title = textField(body, 'title', 'title')
            const description = textField(body, 'description', 'description')
            const prompt = textField(body, 'prompt', 'prompt')
            const workspaceId = textField(body, 'workspaceId', 'workspaceId')
            await store.mutate('task-updated', (ledger) => {
              const task = liveTaskAt(ledger, id)
              versionGuard(task, ifVersion)
              let dirty = false
              if (title !== undefined) { task.title = normalizeTitle(title); dirty = true }
              if (description !== undefined) { task.description = normalizeOptionalText(description, 'description'); dirty = true }
              if (prompt !== undefined) { task.prompt = normalizeOptionalText(prompt, 'prompt'); dirty = true }
              if (workspaceId !== undefined) { task.workspaceId = normalizeWorkspaceId(workspaceId); dirty = true }
              if (!dirty) return []
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              return [task]
            })
            ok(res, { ...store.get(id) })
            return
          }

          // move: the GUI user may move anywhere except `merging`; terminal
          // tasks may only be reopened to todo (shared userCanMove).
          if (action === 'move') {
            const ifVersion = numberField(body, 'ifVersion')
            const rawStatus = textField(body, 'status', 'status')
            if (rawStatus === undefined) throw new ToolError(ERR.invalidInput, 'status is required')
            if (!isValidStatus(rawStatus) || rawStatus === 'merging') {
              throw new ToolError(ERR.invalidInput, 'status must be a valid task status')
            }
            const before = store.snapshot()
            await store.mutate('task-moved', (ledger) => {
              const task = liveTaskAt(ledger, id)
              versionGuard(task, ifVersion)
              if (rawStatus !== task.status && !userCanMove(task.status, rawStatus)) {
                throw new ToolError(ERR.invalidTransition,
                  `cannot move task ${id} from ${task.status} to ${rawStatus}`)
              }
              if (rawStatus === task.status) return []
              task.status = rawStatus
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              if (rawStatus === 'queued') {
                // Entering the queue starts this card's FIFO clock. A move the
                // USER makes carries no session, so the card waits for a slot
                // (a move an AGENT makes stamps its own session — see tools.js).
                // Moving a card to 排队中 IS a launch here: the dispatcher will
                // start a session for it, so say so on the card instead of
                // letting a silent move look like a no-op.
                task.queuedAt = now()
                task.comments = task.comments ?? []
                task.comments.push({
                  id: newCommentId(),
                  body: queuedComment(activeSlots(before), maxParallelOf(before)),
                  createdAt: now(),
                  actor,
                })
              } else {
                delete task.queuedAt
                // Back to the backlog means out of the execution pipeline: a
                // todo card must never look like it holds a session/slot.
                if (rawStatus === 'todo') delete task.sessionId
              }
              if (!HOLD_STATUSES.includes(rawStatus)) {
                delete task.claimedBy
                delete task.claimedAt
              }
              return [task]
            })
            ok(res, { ...store.get(id) })
            return
          }

          // reject: review → todo plus an optional user comment, committed as
          // ONE mutation so a failed move never strands an orphan comment.
          if (action === 'reject') {
            const ifVersion = numberField(body, 'ifVersion')
            const commentBody = normalizeOptionalText(textField(body, 'body', 'body'), 'body', 4000)
            await store.mutate('task-rejected', (ledger) => {
              const task = liveTaskAt(ledger, id)
              versionGuard(task, ifVersion)
              if (!canUserReject(task.status)) {
                throw new ToolError(ERR.invalidTransition,
                  `only a review task may be rejected; task ${id} is ${task.status}`)
              }
              task.status = 'todo'
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              delete task.claimedBy
              delete task.claimedAt
              // Sent back = out of the pipeline: the card must look launchable
              // again (发起会话 clears/stamps its own session anyway).
              delete task.sessionId
              delete task.queuedAt
              if (commentBody.length > 0) {
                task.comments = task.comments ?? []
                task.comments.push({
                  id: newCommentId(),
                  body: commentBody,
                  createdAt: now(),
                  actor,
                })
              }
              return [task]
            })
            ok(res, { ...store.get(id) })
            return
          }

          // comment: GUI user comment (no ifVersion — the write queue is
          // serial and the composer always acts on the live task).
          if (action === 'comment') {
            const rawBody = textField(body, 'body', 'body')
            if (rawBody === undefined) throw new ToolError(ERR.invalidInput, 'body is required')
            const commentBody = normalizeOptionalText(rawBody, 'body', 4000)
            if (commentBody.length === 0) {
              throw new ToolError(ERR.invalidInput, 'comment body must not be empty')
            }
            await store.mutate('comment-added', (ledger) => {
              const task = liveTaskAt(ledger, id)
              task.comments = task.comments ?? []
              task.comments.push({
                id: newCommentId(),
                body: commentBody,
                createdAt: now(),
                actor,
              })
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              return [task]
            })
            ok(res, { ...store.get(id) })
            return
          }

          // launch: 把一张待办卡送进执行队列。卡片 todo -> queued，由队列调度器
          // 决定是否立刻开会话：有空位就 createSession + prompt（会话认领后
          // queued -> preparing），没空位就停在「排队中」，等空位出现时自动补上。
          // 没有 sessionController 的组合明确报 unavailable，而不是假装排队成功。
          //
          // 顺序是「先入队、再调度」：会话是外部副作用，队列是账本事实。反过来在
          // 两次写之间崩掉，就会留下一场没有任何卡片引用的会话。
          //
          // 路由不自己认领任务：认领绑定调用方会话且有 workspace 边界
          // （协议规则 3/7），只有被发起的那个会话能满足。
          if (action === 'launch') {
            const launcher = typeof options.launcher === 'function' ? options.launcher() : options.launcher
            if (launcher === undefined || launcher === null) {
              throw new ToolError(ERR.unavailable,
                'launch needs the dsh sessionController service, which this composition does not provide')
            }
            const ifVersion = numberField(body, 'ifVersion')
            const preflight = store.get(id)
            // Guard BEFORE anything happens: a stale board must not queue a session.
            versionGuard(preflight, ifVersion)
            if (!LAUNCHABLE_STATUSES.includes(preflight.status)) {
              throw new ToolError(ERR.invalidTransition,
                `only a todo task can launch a session; task ${id} is ${preflight.status}`)
            }
            await store.mutate('task-launched', (ledger) => {
              const task = liveTaskAt(ledger, id)
              // Tolerate a board change in the tiny window between preflight and
              // here: only an untouched task enters the queue.
              if (task.status !== 'todo') return []
              task.status = 'queued'
              task.queuedAt = now()
              delete task.sessionId
              delete task.claimedBy
              delete task.claimedAt
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              return [task]
            })
            const outcome = await pump()
            const started = store.get(id) ?? preflight
            // 备注按结果写：开上会话时调度器已经在卡上记了一笔，这里只补「还在排队」
            // 那条，免得同一件事在时间线上出现两次。
            if (!hasSession(started)) {
              const failure = outcome.failures.find((item) => item.id === id)
              if (failure !== undefined) {
                throw new ToolError(ERR.unavailable, `the DSH session could not start: ${failure.message}`)
              }
              const before = store.snapshot()
              await store.mutate('task-queued', (ledger) => {
                const task = liveTaskAt(ledger, id)
                if (!isWaitingInQueue(task)) return []
                task.comments = task.comments ?? []
                task.comments.push({
                  id: newCommentId(),
                  body: queuedComment(activeSlots(before), maxParallelOf(before)),
                  createdAt: now(),
                  actor,
                })
                task.version += 1
                task.updatedAt = now()
                task.updatedBy = actor
                return [task]
              })
            }
            const after = store.get(id) ?? started
            const ledger = store.snapshot()
            ok(res, {
              taskId: id,
              sessionId: hasSession(after) ? after.sessionId : '',
              status: after.status,
              queued: !hasSession(after),
              active: activeSlots(ledger),
              maxParallel: maxParallelOf(ledger),
            }, 201)
            return
          }

          // unqueue: 取消排队，卡片回「待办」。只对「已入队但还没有会话」的卡开放
          // ——dsh 没有终止会话的接口，放行一张已经有会话的卡只会留下一场没人管
          // 的会话在跑。
          if (action === 'unqueue') {
            const ifVersion = numberField(body, 'ifVersion')
            await store.mutate('task-unqueued', (ledger) => {
              const task = liveTaskAt(ledger, id)
              versionGuard(task, ifVersion)
              if (!isWaitingInQueue(task)) {
                throw new ToolError(ERR.invalidTransition, hasSession(task)
                  ? `task ${id} already has a DSH session; only a queued task still waiting for a slot can leave the queue`
                  : `only a queued task can leave the queue; task ${id} is ${task.status}`)
              }
              task.status = 'todo'
              delete task.queuedAt
              delete task.sessionId
              delete task.claimedBy
              delete task.claimedAt
              task.version += 1
              task.updatedAt = now()
              task.updatedBy = actor
              task.comments = task.comments ?? []
              task.comments.push({
                id: newCommentId(),
                body: hostLang() === 'en'
                  ? 'Left the execution queue; back to To do.'
                  : '已取消排队，任务回到「待办」。',
                createdAt: now(),
                actor,
              })
              return [task]
            })
            ok(res, { ...store.get(id) })
            return
          }

          // delete: physically remove a card. Active work (hold statuses) and
          // hand-offs under review are locked — delete only queued/todo/failed
          // or already finished tasks.
          if (action === 'delete') {
            const ifVersion = numberField(body, 'ifVersion')
            await store.mutate('task-deleted', (ledger) => {
              const task = liveTaskAt(ledger, id)
              if (ifVersion !== undefined) versionGuard(task, ifVersion)
              if (HOLD_STATUSES.includes(task.status) || task.status === 'review') {
                throw new ToolError(ERR.forbidden,
                  `task ${id} is ${task.status}; only queued, failed or finished tasks can be deleted`)
              }
              ledger.tasks = ledger.tasks.filter((t) => t.id !== id)
              return [task]
            })
            ok(res, { id })
            return
          }
        }

        res.writeHead(404)
        res.end()
        return
      }

      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      const failure = envelopeOfError(error)
      json(res, { ok: false, error: { code: failure.code, message: failure.message } }, failure.status)
    }
  }

  const sse = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // Baseline frame: the client reconciles by revision and refetches state
    // on a gap instead of replaying every lost frame.
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`)
    subscribers.add(res)
    // A socket that dies between 'close' detection and the next write emits
    // 'error' on the response — drop the subscriber instead of crashing.
    res.on('error', () => {
      subscribers.delete(res)
    })
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const current of subscribers) current.write(': ping\n\n')
      }, HEARTBEAT_MS)
    }
    req.on('close', () => {
      subscribers.delete(res)
      if (subscribers.size === 0 && heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
  ]
  // Resume a persisted queue: a restart (or a plugin reload) may leave cards
  // waiting for a slot that nothing would otherwise hand out.
  void pump()
  return () => {
    disposePump()
    unsubscribePump()
    stopSharedInject?.()
    shared?.dispose()
    unsubscribeBroadcast()
    socket?.dispose()
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) res.end()
    subscribers.clear()
  }
}
