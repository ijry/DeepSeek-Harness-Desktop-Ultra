/**
 * Client state: the node cache, the revision protocol that keeps it convergent,
 * the transport to the plugin's own host routes, and the device-local memory of
 * how the board was left.
 *
 * The revision rules are codeg-plus's `canvas-store.ts`, ported unchanged:
 *   - the event stream is the ONLY channel that advances `revision`;
 *   - `<= revision` is stale (drop), `== revision + 1` applies, `> revision + 1`
 *     is a gap — drop it and refetch the whole snapshot;
 *   - a mutation RESPONSE never advances the revision. Its value is applied as an
 *     optimistic confirmation only while its own revision is still ahead, so both
 *     arrival orders converge and no own-origin special case is needed.
 *
 * @module dsh-plugin-canvas/client/state
 */
export const PLUGIN_ID = 'dsh-plugin-canvas'
export const ROUTE_PREFIX = '/dsh-plugin-canvas'
export const SSE_PATH = '/dsh-plugin-canvas/events'

/** Device-local keys. Advisory, never authoritative — the ledger is the board. */
const KEY_VIEWPORT = 'dsh-plugin-canvas:viewport'
const KEY_EXPANDED_CARDS = 'dsh-plugin-canvas:expanded-cards'
const KEY_EXPANDED_REGIONS = 'dsh-plugin-canvas:expanded-regions'
const KEY_MINIMAP = 'dsh-plugin-canvas:minimap'

export const model = {
  open: false,
  revision: 0,
  hydrated: false,
  /** ledger id → node row. Replaced, never mutated, on every apply. */
  nodes: new Map(),
  sessions: [],
  workspaces: [],
  agents: [],
  /** Element ids (`node-<id>` / `member-<id>-<sessionId>`). */
  selected: new Set(),
  expandedRegions: new Set(),
  detailCards: new Set(),
  transcripts: new Map(),
  viewport: { x: 0, y: 0, zoom: 1 },
  /** A viewport came back from storage, so the first open must not re-fit. */
  restoredViewport: false,
  minimap: true,
  /** Transient interaction state — never persisted, never sent. */
  overlay: new Map(),
  sizeOverlay: new Map(),
  frozenMembers: null,
  dropHint: null,
  dropTargetRegionId: null,
  guides: [],
  marquee: null,
  renaming: null,
  editingNote: null,
  connected: false,
  toasts: [],
}

const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emit() {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (error) {
      console.warn('[dsh-plugin-canvas] listener threw:', error?.message ?? error)
    }
  }
}

export function toast(message) {
  const entry = { id: `${Date.now()}-${Math.random()}`, message: String(message) }
  model.toasts = [...model.toasts, entry]
  emit()
  setTimeout(() => {
    model.toasts = model.toasts.filter((t) => t.id !== entry.id)
    emit()
  }, 4200)
}

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota or a private-mode denial is not worth a broken board */
  }
}

/** Restore the device-local view state. Every entry degrades harmlessly: an id
 *  that no longer matches a row simply opens nothing. */
export function loadViewState() {
  const viewport = readJson(KEY_VIEWPORT)
  if (
    viewport !== null &&
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.zoom)
  ) {
    model.viewport = { x: viewport.x, y: viewport.y, zoom: clampZoom(viewport.zoom) }
    model.restoredViewport = true
  }
  for (const id of readJson(KEY_EXPANDED_CARDS) ?? []) {
    if (Number.isInteger(id)) model.detailCards.add(id)
  }
  for (const id of readJson(KEY_EXPANDED_REGIONS) ?? []) {
    if (Number.isInteger(id)) model.expandedRegions.add(id)
  }
  // Anything but a literal `false` means shown: the map is how a board bigger
  // than the window stays comprehensible, so only an explicit dismissal sticks.
  model.minimap = readJson(KEY_MINIMAP) !== false
}

export function saveViewport() {
  writeJson(KEY_VIEWPORT, model.viewport)
}

export function saveExpanded() {
  writeJson(KEY_EXPANDED_CARDS, [...model.detailCards])
  writeJson(KEY_EXPANDED_REGIONS, [...model.expandedRegions])
}

export function saveMinimap() {
  writeJson(KEY_MINIMAP, model.minimap)
}

// ── transport ──

/** One JSON call to the plugin's own host route. Throws with the server's own
 *  message so every caller can just toast it. */
export async function api(path, body) {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (payload?.ok !== true) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
  }
  return payload.value
}

/** Apply one committed change to the node cache. Every payload is full-state and
 *  idempotent, so our own mutations and everyone else's follow one path. */
function applyTo(nodes, change) {
  switch (change.kind) {
    case 'upsert':
      nodes.set(change.node.id, change.node)
      break
    case 'moved':
      for (const move of change.moves) {
        const existing = nodes.get(move.id)
        if (existing !== undefined) nodes.set(move.id, { ...existing, x: move.x, y: move.y })
      }
      break
    case 'deleted':
      nodes.delete(change.id)
      break
    case 'detached': {
      // One transaction on the host: the membership removal plus the new pin. The
      // region's new member list is not in the payload, so scrub it here — a
      // filter is idempotent, matching the event contract.
      const sessionId = change.node.sessionId
      if (change.removedFrom !== null && sessionId != null) {
        const region = nodes.get(change.removedFrom)
        if (region !== undefined) {
          nodes.set(change.removedFrom, {
            ...region,
            memberIds: region.memberIds.filter((m) => m !== sessionId),
          })
        }
      }
      nodes.set(change.node.id, change.node)
      break
    }
    case 'grouped':
      // Delete before insert: the absorbed pins and the region that swallowed
      // them committed together. Both halves are idempotent.
      for (const id of change.deletedIds) nodes.delete(id)
      nodes.set(change.node.id, change.node)
      break
    case 'pruned':
      for (const id of change.deletedIds) nodes.delete(id)
      for (const node of change.updated) nodes.set(node.id, node)
      break
  }
}

let gapHighWater = 0
let refetchInFlight = null

/** Handle one streamed change. */
export function handleChange(change) {
  if (!Number.isFinite(change?.revision)) return
  if (change.revision <= model.revision) return
  if (change.revision > model.revision + 1) {
    // A gap: some event was lost. The change is NOT applied — a payload is only
    // coherent against its exact predecessor state — and the snapshot repairs
    // everything at once.
    gapHighWater = Math.max(gapHighWater, change.revision)
    void refetchState()
    return
  }
  const nodes = new Map(model.nodes)
  applyTo(nodes, change)
  model.nodes = nodes
  model.revision = change.revision
  pruneViewState()
  emit()
}

/** Apply a mutation response, but only while its own event is still on its way. */
export function applyResponse(revision, mutate) {
  if (!Number.isFinite(revision) || revision <= model.revision) return
  const nodes = new Map(model.nodes)
  mutate(nodes)
  model.nodes = nodes
  pruneViewState()
  emit()
}

/** Drop view state pointing at rows the board no longer has. */
function pruneViewState() {
  let dirty = false
  for (const id of [...model.detailCards]) {
    if (!model.nodes.has(id)) {
      model.detailCards.delete(id)
      dirty = true
    }
  }
  for (const id of [...model.expandedRegions]) {
    if (!model.nodes.has(id)) {
      model.expandedRegions.delete(id)
      dirty = true
    }
  }
  if (dirty) saveExpanded()
}

/** Fetch a fresh snapshot (initial hydrate, gap repair, stream reconnect).
 *  Coalesces: at most one in flight, callers share its outcome. */
export function refetchState() {
  if (refetchInFlight !== null) return refetchInFlight
  refetchInFlight = api('/state')
    .then((snapshot) => {
      refetchInFlight = null
      // The ledger response is also where the language comes from — the browser
      // half cannot see the shell's environment. Adopted before the emit below, so
      // nothing has painted in the wrong language yet.
      setLanguage(snapshot?.language)
      if (!Number.isFinite(snapshot?.revision)) return
      const before = model.revision
      // A snapshot read BEFORE a mutation we already applied has not repaired
      // anything — accept nothing.
      if (snapshot.revision >= before) {
        model.nodes = new Map(snapshot.nodes.map((n) => [n.id, n]))
        model.revision = snapshot.revision
        model.hydrated = true
        pruneViewState()
        emit()
      }
      // Still behind a gap we saw, but only worth another round if THIS one made
      // progress. Chaining on a snapshot that reported the same revision would
      // spin until the host happens to commit something — the missing mutation
      // arrives as an event anyway, and its own gap check re-triggers this.
      if (gapHighWater > model.revision && model.revision > before) void refetchState()
    })
    .catch((error) => {
      refetchInFlight = null
      console.warn('[dsh-plugin-canvas] snapshot fetch failed:', error?.message ?? error)
      setTimeout(() => {
        // Quiet-board self-heal: no later event may ever re-trigger this.
        if (model.open) void refetchState()
      }, 3000)
    })
  return refetchInFlight
}

/** Refresh the workspace / session / agent view. */
export async function refetchSessions(force = false) {
  try {
    const value = await api(`/sessions${force ? '?refresh=1' : ''}`)
    model.sessions = value.sessions ?? []
    model.workspaces = value.workspaces ?? []
    model.agents = value.agents ?? []
    emit()
  } catch (error) {
    console.warn('[dsh-plugin-canvas] session view failed:', error?.message ?? error)
  }
}

let stream = null

export function startStream() {
  if (stream !== null || typeof window.EventSource !== 'function') return
  const source = new window.EventSource(SSE_PATH)
  stream = source
  source.addEventListener('open', () => {
    model.connected = true
    emit()
  })
  source.addEventListener('hello', () => {
    model.connected = true
    // The baseline frame only reports where the host is; the snapshot is what
    // reconciles, and a reconnect may have missed events either way.
    void refetchState()
    emit()
  })
  source.addEventListener('change', (event) => {
    try {
      handleChange(JSON.parse(event.data))
    } catch (error) {
      console.warn('[dsh-plugin-canvas] bad change frame:', error?.message ?? error)
    }
  })
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; only the badge changes.
    model.connected = false
    emit()
  })
}

export function stopStream() {
  if (stream === null) return
  try {
    stream.close()
  } catch {
    /* already closed */
  }
  stream = null
  model.connected = false
}
