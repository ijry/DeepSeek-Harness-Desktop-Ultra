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
 * @module dsh-plugin-taskboard/host/routes
 */
import {
  HOLD_STATUSES,
  canUserReject,
  createTaskRecord,
  isValidStatus,
  newCommentId,
  normalizeOptionalText,
  normalizeTitle,
  normalizeWorkspaceId,
  userCanMove,
} from '../shared/protocol.js'
import { ERR, ToolError, liveTaskAt, versionGuard } from './tools.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-taskboard'

/** SSE stream path (registered as an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-taskboard/events'

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

/** Map an execution error onto the { ok:false } envelope. */
function envelopeOfError(error) {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message, status: statusOf(error.code) }
  }
  const message = error?.message ?? String(error)
  if (/^(title|description|prompt|workspaceId|body) must/.test(message)) {
    return { code: 'invalid_input', message, status: 400 }
  }
  console.error('[dsh-plugin-taskboard] route error:', message)
  return { code: 'internal', message, status: 500 }
}

/**
 * Register the board routes (JSON prefix + exact SSE stream) on a webServer
 * context. Returns the disposer.
 * @param options - { store, workspaces, now }
 */
export function registerTaskboardRoutes(ctx, options) {
  const { store, workspaces, now } = options
  const subscribers = new Set()
  let heartbeat

  const broadcast = (change) => {
    const frame = `event: change\ndata: ${JSON.stringify({ revision: change.revision, kind: change.kind, tasks: change.tasks })}\n\n`
    for (const res of subscribers) res.write(frame)
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
          ok(res, store.snapshot())
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
  return () => {
    unsubscribeBroadcast()
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) res.end()
    subscribers.clear()
  }
}
