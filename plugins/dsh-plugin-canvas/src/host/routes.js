/**
 * /dsh-plugin-canvas routes on the shared dsh webserver: a JSON API for every
 * board mutation plus an SSE stream mirroring each committed one.
 *
 * Wire contract, ported from codeg-plus's Tauri commands so the browser half can
 * keep its revision protocol unchanged:
 *
 *   GET  /state                    → { nodes, revision }
 *   GET  /sessions                 → { sessions, workspaces, agents }
 *   GET  /sessions/<id>/transcript → { turns, truncated }
 *   GET  /events                   → SSE: `hello` then one `change` per commit
 *   POST /nodes                    → create           → { value: node, revision }
 *   POST /nodes/move               → batch move       → { value: moves, revision }
 *   POST /nodes/delete             → batch delete     → { value: ids, revision }
 *   POST /nodes/<id>/update        → patch            → { value: node, revision }
 *   POST /nodes/<id>/detach        → member → pin     → { value: node, revision }
 *   POST /nodes/<id>/delete        → delete one       → { value: { id }, revision }
 *   POST /group                    → collect sessions → { value: { node, deletedIds }, revision }
 *
 * Every mutation response carries the revision of the single event it
 * broadcast. A response NEVER advances the client's `lastRevision` — the stream
 * is the only ordered channel — so both arrival orders converge (see the store).
 *
 * @module dsh-plugin-canvas/host/routes
 */
import { CanvasInputError } from '../shared/model.js'
import { readTranscript } from './transcript.js'
import {
  CanvasNotFoundError,
  createNode,
  deleteNode,
  deleteNodes,
  detachMember,
  groupIntoRegion,
  moveNodes,
  pruneForSessions,
  updateNode,
} from './board.js'

/** Route prefix on the shared dsh webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-canvas'

/** SSE stream path. Registered as an exact route; longest-prefix matching keeps
 *  it disjoint from the JSON prefix above. */
export const SSE_PATH = '/dsh-plugin-canvas/events'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const NODE_RE = new RegExp(`^${ROUTE_PREFIX}/nodes/(\\d+)/([a-z]+)$`)
const TRANSCRIPT_RE = new RegExp(`^${ROUTE_PREFIX}/sessions/([^/]+)/transcript$`)

function json(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

function statusOf(code) {
  return code === 'invalid_input' ? 400 : code === 'not_found' ? 404 : 500
}

function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Read one JSON body ({} when empty; null on parse failure). */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new CanvasInputError('body too large')
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

/** Map a thrown error onto the failure envelope. */
function envelopeOfError(error) {
  if (error instanceof CanvasInputError) {
    return { code: 'invalid_input', message: error.message }
  }
  if (error instanceof CanvasNotFoundError) {
    return { code: 'not_found', message: error.message }
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-canvas] route error:', message)
  return { code: 'internal', message }
}

/**
 * Register the canvas routes (JSON prefix + exact SSE stream). Returns the
 * disposer.
 *
 * @param ctx - a context carrying `webServer`.
 * @param options - `{ store, view, now }`
 */
export function registerCanvasRoutes(ctx, options) {
  const { store, view, now } = options
  const subscribers = new Set()
  let heartbeat

  const broadcast = (change) => {
    const frame = `event: change\ndata: ${JSON.stringify(change)}\n\n`
    for (const res of subscribers) {
      try {
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }
  const unsubscribe = store.subscribe(broadcast)

  /** The mutation context the board functions run against. */
  const boardCtx = {
    now: () => new Date(now()).toISOString(),
    sessionIsLive: (id) => view.sessionIsLive(id),
    workspaceExists: (id) => view.workspaceExists(id),
  }

  /** Commit one mutation and answer with `{ value, revision }`. */
  async function commit(res, mutator, valueOf, status = 200) {
    const result = await store.mutate(mutator)
    ok(res, { value: valueOf(result.change), revision: result.revision }, status)
  }

  /**
   * Drop references to sessions that are gone. codeg-plus runs this from its
   * conversation-deletion funnel; dsh exposes no such hook, so it runs here —
   * after a fresh view, before a write that would trip over a stale member.
   */
  async function prune() {
    const missing = view.missingFrom(store.snapshot().nodes)
    if (missing.length === 0) return
    await store.mutate((draft) => pruneForSessions(draft, missing, boardCtx))
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      if (req.method === 'GET') {
        if (pathname === `${ROUTE_PREFIX}/state`) {
          await store.load()
          ok(res, store.snapshot())
          return
        }
        if (pathname === `${ROUTE_PREFIX}/sessions`) {
          const snapshot = await view.snapshot(url.searchParams.get('refresh') === '1')
          await store.load()
          await prune()
          ok(res, snapshot)
          return
        }
        const transcript = TRANSCRIPT_RE.exec(pathname)
        if (transcript !== null) {
          ok(res, await readTranscript(options.sessionQuery, decodeURIComponent(transcript[1])))
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }

      const body = await readBody(req)
      if (body === null) {
        sendFail(res, 'invalid_input', 'request body must be valid JSON')
        return
      }
      await store.load()

      // ── create ──
      if (pathname === `${ROUTE_PREFIX}/nodes`) {
        // A create names a session or a workspace, so the view has to be current
        // before liveness is judged: a session created seconds ago must be
        // droppable onto the board.
        await view.snapshot()
        await commit(res, (draft) => createNode(draft, body, boardCtx), (c) => c.node, 201)
        return
      }

      // ── batch move ──
      if (pathname === `${ROUTE_PREFIX}/nodes/move`) {
        await commit(res, (draft) => moveNodes(draft, body.moves, boardCtx), (c) => c?.moves ?? [])
        return
      }

      // ── batch delete ──
      if (pathname === `${ROUTE_PREFIX}/nodes/delete`) {
        await commit(res, (draft) => deleteNodes(draft, body.nodeIds), (c) => c?.deletedIds ?? [])
        return
      }

      // ── collect sessions into a region ──
      if (pathname === `${ROUTE_PREFIX}/group`) {
        await view.snapshot()
        await commit(
          res,
          (draft) => groupIntoRegion(draft, body, boardCtx),
          (c) => ({ node: c.node, deletedIds: c.deletedIds })
        )
        return
      }

      // ── per-node actions ──
      const match = NODE_RE.exec(pathname)
      if (match !== null) {
        const id = Number(match[1])
        const action = match[2]

        if (action === 'update') {
          await commit(res, (draft) => updateNode(draft, id, body, boardCtx), (c) =>
            c === undefined ? store.get(id) : c.node
          )
          return
        }
        if (action === 'detach') {
          await view.snapshot()
          await commit(
            res,
            (draft) => detachMember(draft, id, body.sessionId, body.x, body.y, boardCtx),
            (c) => ({ node: c.node, removedFrom: c.removedFrom })
          )
          return
        }
        if (action === 'delete') {
          await commit(res, (draft) => deleteNode(draft, id), () => ({ id }))
          return
        }
      }

      res.writeHead(404)
      res.end()
    } catch (error) {
      const failure = envelopeOfError(error)
      sendFail(res, failure.code, failure.message)
    }
  }

  const sse = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // Baseline frame: the client reconciles by revision and refetches state on a
    // gap instead of replaying every lost frame.
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.revision })}\n\n`)
    subscribers.add(res)
    // A socket that dies between 'close' detection and the next write emits
    // 'error' on the response — drop the subscriber instead of crashing.
    res.on('error', () => subscribers.delete(res))
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const current of subscribers) {
          try {
            current.write(': ping\n\n')
          } catch {
            subscribers.delete(current)
          }
        }
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
    unsubscribe()
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) res.end()
    subscribers.clear()
  }
}
