/**
 * /dsh-plugin-repopanel routes on the shared DSH webserver: a JSON API for the
 * browser panel plus an SSE stream mirroring every committed ledger change.
 *
 * The panel's reads are proxied rather than served from a cache — a repository
 * is re-derived from the workspace's `origin` remote (behind a short TTL, since
 * that costs a `git` spawn) and issues and changes come from the forge on every
 * request. Only the panel settings and the source-key → task links are durable.
 *
 * Everything a token touches stays on this side: the browser is told WHICH
 * hosts have a credential and where it came from, never the credential itself.
 *
 * @module dsh-plugin-repopanel/host/routes
 */
import {
  ERR,
  PanelError,
  GLOBAL_SCOPE,
  MAX_ISSUE_TITLE_CHARS,
  STATE_FILTERS,
  SORTS,
  TABS,
  buildSourceKey,
  chipStateForLink,
  composePrompt,
  createLink,
  initialScenario,
  normalizeCommentBody,
  normalizeOptionalText,
  normalizePage,
  normalizePageSize,
  normalizeTitle,
  scenariosForKind,
} from '../shared/protocol.js'
import {
  CREDENTIALS_FILE,
  deleteToken,
  envTokenSources,
  loadCredentialHosts,
  resolveToken,
  saveToken,
} from './auth.js'
import { hostLang } from '../shared/lang.js'
import { forgeClient } from './forge.js'
import { resolveRemote } from './remote.js'
import { indexBoard, taskboardBaseFrom, taskboardClient } from './taskboard.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-repopanel'

/** SSE stream path (an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-repopanel/events'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * How long a resolved remote is reused. Resolving costs a `git` spawn, and the
 * panel asks on every list, count and item request; a remote changes about
 * never, so a short TTL removes almost all of that cost while still noticing a
 * `git remote set-url` within seconds.
 */
const REMOTE_TTL_MS = 15_000

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
      : code === ERR.forbidden || code === ERR.noAccount ? 403
        : code === ERR.unsupportedHost || code === ERR.noRemote ? 409
          : code === ERR.rateLimited ? 429
            : code === ERR.forgeError ? 502
              : 500
}

/** `{ ok: false }` writer. */
function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Map any thrown value onto the failure envelope. */
function envelopeOfError(error) {
  if (error instanceof PanelError) {
    return { code: error.code, message: error.message, status: statusOf(error.code) }
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-repopanel] route error:', message)
  return { code: ERR.internal, message, status: 500 }
}

/** Read one JSON body (`{}` when empty; null on parse failure). */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new PanelError(ERR.invalidInput, 'body too large')
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

/** A required enum-valued field. */
function enumField(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new PanelError(ERR.invalidInput, `${label} must be one of ${allowed.join(', ')}`)
  }
  return value
}

/** A required positive integer field (an item number). */
function numberField(value, label) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PanelError(ERR.invalidInput, `${label} must be a positive integer`)
  }
  return parsed
}

/**
 * The task board's own title cap. Mirrored rather than imported: the sibling
 * plugin's protocol module is not a dependency of this one, and a task whose
 * title is one character too long would be rejected at the very end of the
 * trigger flow, after the forge read already succeeded.
 */
const TASKBOARD_TITLE_CAP = 200

/**
 * `#12 · <issue title>`, truncated rather than rejected. A forge allows a longer
 * title than the board does, and the user is triggering an item that already
 * exists — refusing the whole action over a long title would be absurd.
 */
function taskTitle(number, title) {
  const prefix = `#${number} · `
  const room = TASKBOARD_TITLE_CAP - prefix.length
  const trimmed = String(title ?? '').trim()
  const body = trimmed.length > room ? `${trimmed.slice(0, Math.max(1, room - 1))}…` : trimmed
  return normalizeTitle(`${prefix}${body}`, TASKBOARD_TITLE_CAP)
}

/** Adapt dsh's workspace registry to the narrow face this plugin needs. */export function workspaceFace(registry) {
  const toView = (ws) => (ws === undefined || ws === null ? undefined : { id: ws.id, path: ws.path, title: ws.title })
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
 * Register the panel routes (JSON prefix + exact SSE stream). Returns the
 * disposer.
 *
 * @param options - { store, workspaces, credentialsFile, now, fetchImpl }
 */
export function registerRepoPanelRoutes(ctx, options) {
  const { store, workspaces, credentialsFile, now } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const subscribers = new Set()
  const remoteCache = new Map()
  let heartbeat

  const broadcast = (change) => {
    const frame = `event: change\ndata: ${JSON.stringify({ revision: change.revision, kind: change.kind })}\n\n`
    for (const res of subscribers) res.write(frame)
  }
  const unsubscribeBroadcast = store.subscribe(broadcast)

  /** The workspace a request names, or a 400/404. */
  const workspaceOf = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new PanelError(ERR.invalidInput, 'workspaceId is required')
    }
    const workspace = workspaces.get(value)
    if (workspace === undefined) throw new PanelError(ERR.notFound, `no workspace ${value}`)
    return workspace
  }

  /** The workspace's remote, behind the TTL cache. */
  const remoteOf = async (workspace) => {
    const cached = remoteCache.get(workspace.id)
    if (cached !== undefined && cached.at + REMOTE_TTL_MS > now()) return cached.remote
    const remote = await resolveRemote(workspace.path)
    remoteCache.set(workspace.id, { at: now(), remote })
    return remote
  }

  /**
   * Everything a forge-touching route needs: the workspace, its remote, and a
   * client authenticated for that host. Missing pieces fail loud with the code
   * the panel knows how to explain.
   */
  const contextOf = async (workspaceId) => {
    const workspace = workspaceOf(workspaceId)
    const remote = await remoteOf(workspace)
    if (remote === undefined) {
      throw new PanelError(ERR.noRemote, `${workspace.path} has no recognizable origin remote`)
    }
    if (!remote.supported) {
      throw new PanelError(ERR.unsupportedHost, `${remote.host} is not a recognized code-hosting service`)
    }
    const auth = await resolveToken(credentialsFile, remote.host, remote.provider)
    if (auth === undefined) {
      throw new PanelError(ERR.noAccount, `no access token for ${remote.host}`)
    }
    return { workspace, remote, client: forgeClient(remote, auth.token, options.fetchImpl) }
  }

  /** Parse the list/count filter set out of a query string. */
  const queryOf = (params, withPaging) => {
    const labels = (params.get('labels') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    const query = {
      tab: TABS.includes(params.get('tab')) ? params.get('tab') : TABS[0],
      state: STATE_FILTERS.includes(params.get('state')) ? params.get('state') : 'open',
      search: (params.get('search') ?? '').trim(),
      labels,
      assignedToMe: params.get('assignedToMe') === 'true',
      sort: SORTS.includes(params.get('sort')) ? params.get('sort') : SORTS[0],
    }
    if (withPaging) {
      query.page = normalizePage(params.get('page'))
      query.perPage = normalizePageSize(params.get('perPage'))
    }
    return query
  }

  /**
   * Join a page of rows to their tasks: the durable link supplies the task id,
   * the live board supplies the status. A link whose task is gone from the board
   * (deleted by hand) is reported as no link at all, so the row offers Start
   * again instead of a chip pointing at nothing.
   */
  const linksForRows = async (req, rows, remote) => {
    const keys = rows.map((row) =>
      buildSourceKey({
        provider: remote.provider,
        host: remote.host,
        ownerRepo: remote.ownerRepo,
        kind: row.isPr ? 'pr' : 'issue',
        number: row.number,
      }),
    )
    const stored = store.linksFor(keys)
    if (Object.keys(stored).length === 0) return {}

    const base = taskboardBaseFrom(req)
    if (base === undefined) return {}
    let board
    try {
      board = await taskboardClient({ base, fetchImpl }).state()
    } catch (error) {
      // A missing or unreachable board must not fail the list — the rows are
      // still worth showing, they just all offer Start.
      console.warn('[dsh-plugin-repopanel] task board unavailable:', error?.message ?? error)
      return {}
    }
    const byId = indexBoard(board)

    const out = {}
    for (const [key, link] of Object.entries(stored)) {
      const task = byId.get(link.taskId)
      if (task === undefined) continue
      out[key] = { ...link, status: task.status, taskTitle: task.title, chip: chipStateForLink({ status: task.status }) }
    }
    return out
  }

  /** GET dispatch. */
  const handleGet = async (req, res, pathname, params) => {
    if (pathname === `${ROUTE_PREFIX}/workspaces`) {
      ok(res, workspaces.list())
      return
    }

    if (pathname === `${ROUTE_PREFIX}/settings`) {
      await store.load()
      // `language` rides along here because the browser half cannot read the
      // environment: this is the first payload the panel fetches on mount, so it
      // is also how the shell's DSH_DESKTOP_LANG reaches the UI.
      ok(res, { ...store.settings(), language: hostLang() })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/credentials`) {
      ok(res, { hosts: await loadCredentialHosts(credentialsFile), env: envTokenSources() })
      return
    }

    // Reported rather than thrown: "this folder has no forge remote" and "this
    // host is not supported" are states the panel renders, not failures.
    if (pathname === `${ROUTE_PREFIX}/remote`) {
      const workspace = workspaceOf(params.get('workspaceId'))
      ok(res, (await remoteOf(workspace)) ?? null)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/identity`) {
      const { client } = await contextOf(params.get('workspaceId'))
      ok(res, (await client.identity()) ?? null)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/labels`) {
      const { client } = await contextOf(params.get('workspaceId'))
      ok(res, await client.labels())
      return
    }

    if (pathname === `${ROUTE_PREFIX}/list`) {
      const { client, remote } = await contextOf(params.get('workspaceId'))
      const page = await client.list(queryOf(params, true))
      ok(res, { ...page, links: await linksForRows(req, page.rows, remote) })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/counts`) {
      const { client } = await contextOf(params.get('workspaceId'))
      ok(res, { count: (await client.count(queryOf(params, false))) ?? null })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/item`) {
      const { client, remote } = await contextOf(params.get('workspaceId'))
      const kind = enumField(params.get('kind'), ['issue', 'pr'], 'kind')
      const row = await client.item({ kind, number: numberField(params.get('number'), 'number') })
      ok(res, { ...row, links: await linksForRows(req, [row], remote) })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/comments`) {
      const { client } = await contextOf(params.get('workspaceId'))
      ok(res, await client.comments({
        number: numberField(params.get('number'), 'number'),
        page: normalizePage(params.get('page')),
        perPage: normalizePageSize(params.get('perPage')),
      }))
      return
    }

    res.writeHead(404)
    res.end()
  }

  /** POST dispatch. */
  const handlePost = async (req, res, pathname, body) => {
    if (pathname === `${ROUTE_PREFIX}/settings`) {
      await store.load()
      const scope = body.scope === null || body.scope === undefined || body.scope === GLOBAL_SCOPE
        ? undefined
        : String(body.scope)
      // `settings: null` on a workspace scope REMOVES its override — that is how
      // "follow the global defaults" is stored, so null is meaningful here and
      // must not be normalized away.
      const settings = body.settings === null || body.settings === undefined ? undefined : body.settings
      if (scope === undefined && settings === undefined) {
        throw new PanelError(ERR.invalidInput, 'the global settings row cannot be removed')
      }
      ok(res, await store.saveSettings(scope, settings))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/credentials`) {
      const host = normalizeOptionalText(body.host, 'host', 253)
      if (host === undefined) throw new PanelError(ERR.invalidInput, 'host is required')
      if (typeof body.token !== 'string') throw new PanelError(ERR.invalidInput, 'token must be a string')
      ok(res, { hosts: await saveToken(credentialsFile, host.toLowerCase(), body.token), env: envTokenSources() })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/credentials/delete`) {
      const host = normalizeOptionalText(body.host, 'host', 253)
      if (host === undefined) throw new PanelError(ERR.invalidInput, 'host is required')
      ok(res, { hosts: await deleteToken(credentialsFile, host.toLowerCase()), env: envTokenSources() })
      return
    }

    if (pathname === `${ROUTE_PREFIX}/comment`) {
      const { client } = await contextOf(body.workspaceId)
      ok(res, await client.addComment({
        number: numberField(body.number, 'number'),
        body: normalizeCommentBody(body.body),
      }), 201)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/state`) {
      const { client } = await contextOf(body.workspaceId)
      ok(res, await client.setState({
        kind: enumField(body.kind, ['issue', 'pr'], 'kind'),
        number: numberField(body.number, 'number'),
        action: enumField(body.action, ['close', 'reopen'], 'action'),
      }))
      return
    }

    if (pathname === `${ROUTE_PREFIX}/issues`) {
      const { client } = await contextOf(body.workspaceId)
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((name) => typeof name === 'string' && name.length > 0)
        : []
      ok(res, await client.createIssue({
        title: normalizeTitle(body.title, MAX_ISSUE_TITLE_CHARS),
        body: normalizeOptionalText(body.body, 'body'),
        labels,
      }), 201)
      return
    }

    if (pathname === `${ROUTE_PREFIX}/start`) {
      ok(res, await start(req, body), 201)
      return
    }

    res.writeHead(404)
    res.end()
  }

  /**
   * Hand one forge item to an agent as a task.
   *
   * The prompt is composed HERE, not in the browser: the scenario template, the
   * scope's standing instructions and the fenced item snapshot then always
   * arrive in the same order, and the untrusted-data fence around body text
   * cannot be dropped by a caller that forgot it.
   */
  const start = async (req, body) => {
    await store.load()
    const { workspace, remote, client } = await contextOf(body.workspaceId)
    const kind = enumField(body.kind, ['issue', 'pr'], 'kind')
    const number = numberField(body.number, 'number')

    const base = taskboardBaseFrom(req)
    if (base === undefined) {
      throw new PanelError(ERR.internal, 'cannot reach the task board from a non-loopback request')
    }
    const board = taskboardClient({ base, fetchImpl })

    const sourceKey = buildSourceKey({
      provider: remote.provider,
      host: remote.host,
      ownerRepo: remote.ownerRepo,
      kind,
      number,
    })

    // One active task per work item, advisory: the existing task is offered
    // instead, and `force` overrides. Checked against the LIVE board so a task
    // the user deleted by hand stops blocking a re-trigger.
    const existing = store.link(sourceKey)
    if (existing !== undefined && body.force !== true) {
      let known
      try {
        known = indexBoard(await board.state()).get(existing.taskId)
      } catch {
        known = undefined
      }
      if (known !== undefined) return { outcome: 'duplicate', task: known, link: existing }
    }

    const settings = store.effectiveSettings(workspace.id)
    const scenario = body.scenario === undefined || body.scenario === null
      ? initialScenario(kind, settings)
      : enumField(body.scenario, scenariosForKind(kind), 'scenario')
    const writeback = body.writeback === undefined || body.writeback === null
      ? settings.writebackDefault
      : body.writeback === true

    const item = await client.item({ kind, number })
    const prompt = composePrompt({
      scenario,
      settings,
      instruction: normalizeOptionalText(body.instruction, 'instruction'),
      item: { ...item, kind },
      remote,
      lang: hostLang(),
    })

    const task = await board.createTask({
      title: taskTitle(number, item.title),
      description: `${remote.host}/${remote.ownerRepo} — ${item.htmlUrl}`,
      prompt,
      workspaceId: workspace.id,
    })

    const link = await store.putLink(createLink({
      sourceKey,
      taskId: task.id,
      provider: remote.provider,
      host: remote.host,
      ownerRepo: remote.ownerRepo,
      kind,
      number,
      url: item.htmlUrl,
      title: item.title,
      scenario,
      writeback,
      now: now(),
    }))

    return { outcome: 'created', task, link }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET') {
        await handleGet(req, res, url.pathname, url.searchParams)
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) {
          sendFail(res, ERR.invalidInput, 'request body must be a JSON object')
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
    remoteCache.clear()
  }
}

/** Re-exported so the entry point can name the credentials file in one place. */
export { CREDENTIALS_FILE }
