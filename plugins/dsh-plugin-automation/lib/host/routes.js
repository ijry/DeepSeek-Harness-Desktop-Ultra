/**
 * /dsh-plugin-automation routes on the shared DSH webserver: a JSON API for the
 * browser panel plus an SSE stream mirroring every committed ledger change.
 *
 * Two decisions worth naming:
 *
 * - schedule arithmetic is answered by the HOST (`/preview`), never re-implemented
 *   in the browser. One cron implementation means the preview under the field and
 *   the time the job actually fires can never disagree.
 * - the panel's writes go through the engine and the store rather than mutating
 *   records directly, so "run now" and "cancel" obey exactly the same overlap and
 *   settlement rules as a scheduled firing.
 *
 * @module dsh-plugin-automation/host/routes
 */
import {
  AutomationError,
  ERR,
  createAutomation,
  decorateAutomation,
  describeCron,
  describeInterval,
  listAutomations,
  nextCronTimes,
  nextIntervalTime,
  normalizeDraft,
  runsFor,
} from '../shared/protocol.js'
import { AUTOMATION_TEMPLATES } from '../shared/templates.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-automation'

/** SSE stream path (an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-automation/events'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
const MAX_BODY_BYTES = 1024 * 1024

/** How many runs `/state` carries; the per-automation history is a separate read. */
const STATE_RUN_LIMIT = 100

/** Envelope writer. */
function json(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** `{ ok: true }` writer. */
function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/** Map an error code to its HTTP status. */
function statusOf(code) {
  return code === ERR.invalidInput ? 400
    : code === ERR.notFound ? 404
      : code === ERR.conflict ? 409
        : code === ERR.engineDisabled ? 409
          : code === ERR.noTaskboard ? 502
            : 500
}

/** `{ ok: false }` writer. */
function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Map any thrown value onto the failure envelope. */
function envelopeOfError(error) {
  if (error instanceof AutomationError) {
    return { code: error.code, message: error.message, status: statusOf(error.code) }
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-automation] route error:', message)
  return { code: ERR.internal, message, status: 500 }
}

/** Read one JSON body (`{}` when empty; null on parse failure). */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new AutomationError(ERR.invalidInput, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A required id field. */
function idField(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AutomationError(ERR.invalidInput, `${label} 不能为空`)
  }
  return value.trim()
}

/** An optional version guard. */
function versionField(value) {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1) throw new AutomationError(ERR.invalidInput, 'ifVersion 必须是正整数')
  return parsed
}

/** Adapt dsh's workspace registry to the narrow face this plugin needs. */
export function workspaceFace(registry) {
  const toView = (ws) => (ws === undefined || ws === null
    ? undefined
    : { id: ws.id, path: ws.path, title: ws.title })
  return {
    list() {
      try {
        const rows = registry.list()
        return (Array.isArray(rows) ? rows : []).map(toView).filter((row) => row !== undefined)
      } catch {
        return []
      }
    },
    get(id) {
      try {
        return toView(registry.get(id))
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Answer "what does this schedule mean, and when does it fire next" — the single
 * source of truth for both the editor preview and the scheduler.
 */
export function previewSchedule(params, now) {
  const kind = params.get('kind') ?? 'cron'
  const count = Math.min(10, Math.max(1, Number.parseInt(params.get('count') ?? '5', 10) || 5))
  if (kind === 'manual') return { valid: true, text: '仅手动触发', next: [] }
  if (kind === 'interval') {
    const minutes = Number.parseInt(params.get('intervalMinutes') ?? '', 10)
    if (!Number.isInteger(minutes) || minutes < 1) return { valid: false, message: '间隔必须是正整数分钟', next: [] }
    const next = []
    let cursor = now
    for (let index = 0; index < count; index += 1) {
      cursor = nextIntervalTime(now, minutes, cursor)
      next.push(cursor)
    }
    return { valid: true, text: describeInterval(minutes), next }
  }
  const cron = params.get('cron') ?? ''
  try {
    const next = nextCronTimes(cron, now, count)
    const preview = { valid: true, text: describeCron(cron), next }
    // A parseable expression that matches no date within four years is legal and
    // useless (`0 0 30 2 *`); say so rather than showing an empty strip.
    if (next.length === 0) preview.message = '这个表达式在未来四年内都不会触发'
    return preview
  } catch (error) {
    return { valid: false, message: error.message, next: [] }
  }
}

/**
 * Register the panel routes (JSON prefix + exact SSE stream). Returns the
 * disposer.
 *
 * @param options - { store, engine, workspaces, taskboardBase, now }
 */
export function registerAutomationRoutes(ctx, options) {
  const { store, engine, workspaces, taskboardBase, now } = options
  const subscribers = new Set()
  let heartbeat

  const broadcast = (change) => {
    const frame = `event: change\ndata: ${JSON.stringify({ revision: change.revision, kind: change.kind })}\n\n`
    for (const res of subscribers) res.write(frame)
  }
  const unsubscribeBroadcast = store.subscribe(broadcast)

  /** The whole panel state in one read: the list, the recent runs, the engine. */
  const state = () => {
    const ledger = store.snapshot()
    const runs = Object.values(ledger.runs)
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, STATE_RUN_LIMIT)
    return {
      revision: ledger.revision,
      settings: ledger.settings,
      automations: listAutomations(ledger),
      runs,
      engine: engine?.status() ?? { running: [], cliAvailable: false },
      workspaces: workspaces.list(),
    }
  }

  /** GET dispatch. */
  const handleGet = async (req, res, pathname, params) => {
    if (pathname === `${ROUTE_PREFIX}/state`) {
      await store.load()
      ok(res, state())
      return
    }

    if (pathname === `${ROUTE_PREFIX}/templates`) {
      ok(res, AUTOMATION_TEMPLATES)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/workspaces`) {
      ok(res, workspaces.list())
      return
    }

    if (pathname === `${ROUTE_PREFIX}/preview`) {
      ok(res, previewSchedule(params, now()))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/runs`) {
      await store.load()
      const limit = Number.parseInt(params.get('limit') ?? '50', 10)
      ok(res, runsFor(store.snapshot(), idField(params.get('automationId'), 'automationId'),
        Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50))
      return
    }

    // The single run read is the only one carrying the full captured output.
    if (pathname === `${ROUTE_PREFIX}/run`) {
      await store.load()
      const run = store.run(idField(params.get('id'), 'id'))
      if (run === undefined) throw new AutomationError(ERR.notFound, '没有这次运行')
      ok(res, run)
      return
    }

    res.writeHead(404)
    res.end()
  }

  /** POST dispatch. */
  const handlePost = async (req, res, pathname, body) => {
    await store.load()

    if (pathname === `${ROUTE_PREFIX}/automations`) {
      const draft = normalizeDraft(body.draft ?? body, store.settings())
      const record = createAutomation(draft, { now: now() })
      ok(res, decorateAutomation(await store.insertAutomation(record)), 201)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/automations/update`) {
      const id = idField(body.id, 'id')
      const draft = normalizeDraft(body.draft ?? body, store.settings())
      const updated = await store.updateAutomation(id, draft, { now: now(), ifVersion: versionField(body.ifVersion) })
      ok(res, decorateAutomation(updated))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/automations/enabled`) {
      const id = idField(body.id, 'id')
      if (typeof body.enabled !== 'boolean') throw new AutomationError(ERR.invalidInput, 'enabled 必须是布尔值')
      const updated = await store.setEnabled(id, body.enabled, {
        now: now(), ifVersion: versionField(body.ifVersion),
      })
      ok(res, decorateAutomation(updated))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/automations/delete`) {
      const id = idField(body.id, 'id')
      // Stop the child first: deleting the record would otherwise leave an
      // unsupervised agent running against a job nobody can see any more.
      const live = engine?.status().running.find((row) => row.automationId === id)
      if (live !== undefined) await engine.cancel(live.runId)
      const existed = await store.deleteAutomation(id, { ifVersion: versionField(body.ifVersion) })
      if (!existed) throw new AutomationError(ERR.notFound, `没有这条自动化：${id}`)
      ok(res, { id })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/automations/run`) {
      const id = idField(body.id, 'id')
      if (store.automation(id) === undefined) throw new AutomationError(ERR.notFound, `没有这条自动化：${id}`)
      if (engine === undefined) throw new AutomationError(ERR.engineDisabled, '调度器没有启动')
      const run = await engine.runNow(id)
      ok(res, run ?? null, 201)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/runs/cancel`) {
      const runId = idField(body.runId, 'runId')
      const run = store.run(runId)
      if (run === undefined) throw new AutomationError(ERR.notFound, '没有这次运行')
      const signalled = engine === undefined ? false : await engine.cancel(runId)
      if (!signalled && run.status === 'running') {
        // A `running` row with no live child belongs to a previous host process;
        // settling it here is the honest repair.
        await store.finishRun(runId, { status: 'canceled', now: now(), error: '已取消（没有找到对应的子进程）' })
      }
      ok(res, store.run(runId))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/settings`) {
      const patch = body.settings ?? body
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new AutomationError(ERR.invalidInput, 'settings 必须是对象')
      }
      ok(res, await store.saveSettings(patch))
      return
    }

    res.writeHead(404)
    res.end()
  }

  const handler = async (req, res) => {
    try {
      // Every request is a chance to learn the origin the sibling task board is
      // reachable at, for a firing that has no request of its own.
      taskboardBase?.observe(req)
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET') {
        await handleGet(req, res, url.pathname, url.searchParams)
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) {
          sendFail(res, ERR.invalidInput, '请求体必须是 JSON 对象')
          return
        }
        await handlePost(req, res, url.pathname, body)
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
    // Baseline frame: the client reconciles by revision and refetches on a gap
    // instead of replaying every lost frame.
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.revision })}\n\n`)
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
      heartbeat.unref?.()
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
