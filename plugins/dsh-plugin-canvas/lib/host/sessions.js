/**
 * The one normalized view of dsh state the canvas draws on: workspaces, sessions
 * and agent presets, flattened into the shape `shared/derive.js` consumes.
 *
 * Where each field comes from (all verified against dsh 0.1.1-rc.2):
 *   - `ctx.workspaceRegistry.list()` → `{id, path, title, createdAt, updatedAt,
 *     sessionIds}`. This is codeg-plus's "folder": the thing a region binds to.
 *   - `ctx.sessionQuery.listSessions()` → one `{header, live, persisted}` per
 *     logical session, newest-first, without loading any log.
 *   - `ctx.sessionQuery.readTitleSnapshots(ids)` → titles. This one DOES read
 *     logs, so it is bounded and cached (see TITLE_BUDGET).
 *   - `ctx.agentPresets.list()` → the installed agent presets, for the "agent
 *     region" submenu. Optional; the presets actually in use are always derivable
 *     from the sessions themselves.
 *
 * Everything is optional-service tolerant: a harness assembled without
 * `sessionQuery` still gets a board (workspace regions resolve from
 * `workspace.sessionIds`), just without titles.
 *
 * @module dsh-plugin-canvas/host/sessions
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from './sdk.js'

/** How long a snapshot is reused. Long enough to absorb a burst of route calls,
 *  short enough that a new session shows up on the board without a reload. */
const SNAPSHOT_TTL_MS = 1500

/** How long a resolved title is trusted. Titles change rarely and cost a log
 *  read, so they get their own, much longer, cache. */
const TITLE_TTL_MS = 60_000

/** Titles resolved per refresh, newest sessions first. A canvas curates the
 *  recent ones; the tail can stay unnamed until it is scrolled into use. */
const TITLE_BUDGET = 80

/** Session directories walked per refresh while collecting last-activity times. */
const MTIME_DIR_BUDGET = 400

/** Last write to a session's log, as the closest thing dsh has to codeg-plus's
 *  `updated_at`. The header carries only `createdAt`, and the alternative —
 *  folding every log — is exactly what the cheap listing avoids. Best effort by
 *  construction: an unfamiliar layout yields an empty map and every session falls
 *  back to its creation time. */
async function collectActivity() {
  const root = dshHomePath('sessions')
  const activity = new Map()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return activity
  }
  let walked = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (walked >= MTIME_DIR_BUDGET) break
    walked += 1
    let children
    try {
      children = await readdir(join(root, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith('session-')) continue
      try {
        const info = await stat(join(root, entry.name, child.name))
        activity.set(child.name, info.mtimeMs)
      } catch {
        /* a session removed mid-walk simply has no activity time */
      }
    }
  }
  return activity
}

/** Read the workspace registry, tolerating its absence. */
function readWorkspaces(registry) {
  if (registry === undefined || registry === null) return []
  try {
    return registry.list().map((ws) => ({
      id: ws.id,
      path: ws.path,
      title: ws.title,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
      sessionIds: [...ws.sessionIds],
    }))
  } catch (error) {
    console.warn('[dsh-plugin-canvas] workspace list failed:', error?.message ?? error)
    return []
  }
}

/** Read the logical session corpus, tolerating the query service's absence. */
async function readSessionRecords(query) {
  if (query === undefined || query === null || typeof query.listSessions !== 'function') {
    return undefined
  }
  try {
    return await query.listSessions()
  } catch (error) {
    console.warn('[dsh-plugin-canvas] session list failed:', error?.message ?? error)
    return undefined
  }
}

/** Read the installed agent presets, tolerating the service's absence. */
async function readPresets(presets) {
  if (presets === undefined || presets === null || typeof presets.list !== 'function') return []
  try {
    const list = await presets.list()
    return list.filter((p) => p?.id !== undefined && p.broken !== true).map((p) => ({
      id: String(p.id),
      name: typeof p.name === 'string' && p.name.length > 0 ? p.name : String(p.id),
    }))
  } catch (error) {
    console.warn('[dsh-plugin-canvas] agent preset list failed:', error?.message ?? error)
    return []
  }
}

/** The default agent label for a session whose header names no preset. */
export const DEFAULT_AGENT = 'default'

/**
 * Build the sessions view.
 *
 * @param ctx - a cordis context carrying `workspaceRegistry` (and, when the
 *   harness has them, `sessionQuery` / `agentPresets`).
 * @param options - `{ now?: () => number }`
 */
export function createSessionsView(ctx, options = {}) {
  const now = options.now ?? (() => Date.now())
  const titles = new Map()
  let cached
  let cachedAt = 0
  let inFlight

  /** Resolve titles for the newest ids we do not have a fresh one for. */
  async function resolveTitles(query, ids) {
    if (query === undefined || typeof query.readTitleSnapshots !== 'function') return
    const stamp = now()
    const wanted = []
    for (const id of ids) {
      const known = titles.get(id)
      if (known !== undefined && stamp - known.at < TITLE_TTL_MS) continue
      wanted.push(id)
      if (wanted.length >= TITLE_BUDGET) break
    }
    if (wanted.length === 0) return
    let results
    try {
      results = await query.readTitleSnapshots(wanted)
    } catch (error) {
      console.warn('[dsh-plugin-canvas] title read failed:', error?.message ?? error)
      return
    }
    for (const result of results ?? []) {
      // The batch reports per-session settlements: `{sessionId, status, value}`
      // where a fulfilled `value` is `{session, title?: SessionTitleSnapshot}`.
      // One unreadable log must not discard its peers, and a REJECTED entry is
      // not cached — it retries on the next refresh instead of pinning a session
      // to "untitled" for a minute.
      const id = result?.sessionId
      if (id === undefined) continue
      if (result.status === 'rejected') continue
      const title = result.value?.title?.title
      titles.set(String(id), { at: stamp, title: typeof title === 'string' ? title : null })
    }
  }

  async function build() {
    const workspaces = readWorkspaces(ctx.workspaceRegistry)
    const workspaceOf = new Map()
    for (const ws of workspaces) {
      for (const id of ws.sessionIds) workspaceOf.set(id, ws.id)
    }
    const archived = new Set(
      (() => {
        try {
          return [...(ctx.workspaceRegistry?.archivedSessionIds ?? [])]
        } catch {
          return []
        }
      })()
    )

    const records = await readSessionRecords(ctx.sessionQuery)
    const activity = await collectActivity()
    const sessions = []
    if (records !== undefined) {
      for (const record of records) {
        const header = record?.header
        if (header?.id === undefined) continue
        const id = String(header.id)
        const createdAt = Number.isFinite(header.createdAt) ? header.createdAt : 0
        sessions.push({
          id,
          title: null,
          workspace: workspaceOf.get(id) ?? null,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          agentType: typeof header.agentPreset === 'string' && header.agentPreset.length > 0
            ? header.agentPreset
            : DEFAULT_AGENT,
          createdAt,
          updatedAt: Math.max(createdAt, activity.get(id) ?? 0),
          live: record.live === true,
          // The canvas curates root-level work: a subagent child is
          // sub-structure of its parent, not a peer to arrange.
          kind: header.origin === 'subagent' ? 'delegate' : 'root',
          // `== null` on purpose: an explicit null must read as "no parent", not
          // as the string "null" — which `isCanvasEligible` would treat as a
          // parent and drop every session off the board.
          parentId: header.parentSession == null ? null : String(header.parentSession),
          archived: archived.has(id),
        })
      }
    } else {
      // No session query in this assembly: the workspace accounts are still a
      // complete list of the sessions a board can bind to.
      for (const ws of workspaces) {
        for (const id of ws.sessionIds) {
          sessions.push({
            id,
            title: null,
            workspace: ws.id,
            cwd: ws.path,
            agentType: DEFAULT_AGENT,
            createdAt: 0,
            updatedAt: activity.get(id) ?? 0,
            live: false,
            kind: 'root',
            parentId: null,
            archived: archived.has(id),
          })
        }
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
    await resolveTitles(ctx.sessionQuery, sessions.map((s) => s.id))
    for (const session of sessions) {
      session.title = titles.get(session.id)?.title ?? null
    }

    const presets = await readPresets(ctx.agentPresets)
    const agentIds = new Set(presets.map((p) => p.id))
    for (const session of sessions) agentIds.add(session.agentType)
    const agents = [...agentIds].sort().map((id) => ({
      id,
      name: presets.find((p) => p.id === id)?.name ?? id,
    }))

    return { sessions, workspaces, agents, at: now() }
  }

  return {
    /** The cached view, refreshed when older than the TTL. Concurrent callers
     *  share one in-flight refresh. */
    async snapshot(force = false) {
      if (!force && cached !== undefined && now() - cachedAt < SNAPSHOT_TTL_MS) return cached
      if (inFlight !== undefined) return inFlight
      inFlight = build()
        .then((value) => {
          cached = value
          cachedAt = now()
          inFlight = undefined
          return value
        })
        .catch((error) => {
          inFlight = undefined
          console.warn('[dsh-plugin-canvas] session view failed:', error?.message ?? error)
          // A failed refresh serves the previous view rather than an empty board:
          // the ledger is intact and its bindings still mean something.
          return cached ?? { sessions: [], workspaces: [], agents: [], at: now() }
        })
      return inFlight
    },

    /** Synchronous liveness for the board mutations. Fail-OPEN while the view has
     *  never been built: rejecting a pin because the cache is cold would make a
     *  brand-new session undroppable, and the route refreshes before it writes. */
    sessionIsLive(id) {
      if (cached === undefined) return true
      return cached.sessions.some((s) => s.id === id)
    },

    /** Synchronous workspace existence, same fail-open rule. */
    workspaceExists(id) {
      if (cached === undefined) return true
      return cached.workspaces.some((w) => w.id === id)
    },

    /** Session ids referenced by the ledger that no longer exist — the input to
     *  the opportunistic prune. Empty while the view is cold. */
    missingFrom(nodes) {
      if (cached === undefined) return []
      const live = new Set(cached.sessions.map((s) => s.id))
      const missing = new Set()
      for (const node of nodes) {
        if (node.kind === 'session' && node.sessionId && !live.has(node.sessionId)) {
          missing.add(node.sessionId)
        }
        if (node.kind === 'custom') {
          for (const id of node.memberIds) if (!live.has(id)) missing.add(id)
        }
      }
      return [...missing]
    },
  }
}
