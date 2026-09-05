/**
 * Bridge to the sibling dsh-plugin-taskboard, over its own HTTP API.
 *
 * Why HTTP and not a direct call: cordis plugins meet through injected
 * services, and the taskboard deliberately registers none — its ledger is a
 * closure-local `const` inside `apply`. Its JSON routes are the only public
 * face it has, and using them means this plugin needs no change to the
 * taskboard and no shared build. If the taskboard is not installed the routes
 * 404 and the panel simply reports that no task board is available.
 *
 * Why the base URL comes from the request: both plugins mount on the SAME
 * webserver, so the browser that reached us can reach the taskboard at the same
 * origin. The `Host` header is the only handle a plugin has on that origin
 * (the webServer face exposes no bound address), so it is used — and it is
 * validated as loopback before any request is made, because an attacker-chosen
 * Host header would otherwise turn this into a request forgery primitive. dsh
 * itself only ever binds 127.0.0.1, so nothing legitimate is lost.
 *
 * @module dsh-plugin-repopanel/host/taskboard
 */
import { ERR, PanelError } from '../shared/protocol.js'

/** The sibling plugin's route prefix. */
export const TASKBOARD_PREFIX = '/dsh-plugin-taskboard'

/** Escape hatch for deployments where the Host header is not usable. */
export const BASE_ENV = 'DSH_PLUGIN_REPOPANEL_TASKBOARD_BASE'

/** Patience for a same-origin call to a plugin in this very process. */
const TIMEOUT_MS = 10_000

/** Loopback hosts, with or without a port. */
const LOOPBACK_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i

/**
 * The base URL to reach the taskboard on, or undefined when the request did not
 * come from loopback. Never trust this value beyond the regexp: it is a client
 * header.
 */
export function taskboardBaseFrom(req) {
  const override = process.env[BASE_ENV]
  if (typeof override === 'string' && override.trim().length > 0) return override.trim().replace(/\/+$/, '')
  const host = req?.headers?.host
  if (typeof host !== 'string' || !LOOPBACK_RE.test(host)) return undefined
  return `http://${host}`
}

/** Read the `{ ok }` envelope the taskboard answers with. */
async function envelope(response, what) {
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new PanelError(ERR.internal, `task board returned a non-JSON response to ${what}`)
  }
  if (payload?.ok === true) return payload.value
  const detail = payload?.error?.message ?? `HTTP ${response.status}`
  throw new PanelError(ERR.internal, `task board rejected ${what}: ${detail}`)
}

/**
 * A narrow client over the taskboard's routes. `fetchImpl` exists only so tests
 * can inject a stub.
 */
export function taskboardClient({ base, fetchImpl = fetch }) {
  const call = async (path, init, what) => {
    let response
    try {
      response = await fetchImpl(`${base}${TASKBOARD_PREFIX}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new PanelError(ERR.internal, `task board unreachable (${what}): ${error?.message ?? error}`)
    }
    if (response.status === 404) {
      throw new PanelError(ERR.notFound, 'no task board is installed (dsh-plugin-taskboard)')
    }
    return envelope(response, what)
  }

  return {
    /** The whole board, used to resolve a link's current status. */
    async state() {
      return call('/state', { method: 'GET' }, 'GET /state')
    },

    /** Create one task and return the created record (its `id` is the link target). */
    async createTask({ title, description, prompt, workspaceId }) {
      const body = { title }
      if (description !== undefined) body.description = description
      if (prompt !== undefined) body.prompt = prompt
      if (workspaceId !== undefined) body.workspaceId = workspaceId
      return call(
        '/tasks',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        'POST /tasks',
      )
    },
  }
}

/**
 * Index a board snapshot by task id so links can be joined to live statuses in
 * one pass. Returns a Map; a link whose task is missing from the board (deleted
 * by hand) resolves to undefined and the row falls back to offering Start.
 */
export function indexBoard(board) {
  const byId = new Map()
  for (const task of Array.isArray(board?.tasks) ? board.tasks : []) {
    if (task !== null && typeof task === 'object' && typeof task.id === 'string') byId.set(task.id, task)
  }
  return byId
}
