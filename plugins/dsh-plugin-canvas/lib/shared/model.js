/**
 * dsh-plugin-canvas — the node record: kinds, bindings, validation, ids.
 *
 * The single shape both halves agree on, ported from codeg-plus's `canvas_node`
 * table (`src-tauri/src/db/entities/canvas_node.rs`) and the invariants its
 * write chokepoint enforces (`db/service/canvas_service.rs`). One record type for
 * every kind, because they all share geometry, lifecycle and the change feed.
 *
 * What changed on the way over, and why:
 *   - `folder` → `workspace`: dsh binds a session to a workspace directory, not
 *     to a sidebar folder row, so the region binds to that string.
 *   - `group` (codeg-plus's sidebar folder groups) has no dsh counterpart and is
 *     gone rather than faked.
 *   - `conversation` → `session`, and its id is a STRING (dsh session ids are
 *     not a database counter).
 * Node ids stay an ascending integer counter: they are the board's paint order
 * (highest wins a drop hit) and must never be reused.
 *
 * @module dsh-plugin-canvas/shared/model
 */
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  NOTE_HEIGHT,
  NOTE_WIDTH,
  REGION_DEFAULT_HEIGHT,
  REGION_DEFAULT_WIDTH,
} from './units.js'

/** Every node kind, in menu order. */
export const NODE_KINDS = ['workspace', 'agent', 'session', 'custom', 'note']

/** Kinds that render a member grid — they honour the grid shape and accept
 *  drops. A pinned card and a note are single elements, not containers. */
export const REGION_KINDS = ['workspace', 'agent', 'custom']

/** Kinds whose member list is a LIVE BINDING rather than a stored list: there
 *  is nothing to drop into and nothing to remove from. */
export const BINDING_KINDS = ['workspace', 'agent']

export function isRegionKind(kind) {
  return REGION_KINDS.includes(kind)
}

export function isBindingKind(kind) {
  return BINDING_KINDS.includes(kind)
}

/** Hard cap on a custom region's member list. The whole node is rewritten on
 *  every add, so the list has to stay small. */
export const MAX_CUSTOM_MEMBERS = 200

/** Upper bound on a pinned grid axis. Not a layout limit — a wide region derives
 *  far more columns than this — but a sanity clamp so a fat-fingered value can't
 *  make a derived width explode past MAX_NODE_SIZE and strand the region
 *  off-screen. 0 stays "auto". */
export const MAX_GRID_AXIS = 12

/** Geometry clamps: a node the user cannot see or grab again is unrecoverable
 *  short of hand-editing the ledger, so degenerate sizes and non-finite
 *  coordinates are rejected at the chokepoint rather than trusted. */
export const MIN_NODE_SIZE = 48
export const MAX_NODE_SIZE = 20000
export const MAX_COORD = 1000000

/** The colour vocabulary. Names, not CSS: the browser half resolves them
 *  against its own palette, so an arbitrary string would paint nothing at all —
 *  reject it at the write instead. Same twelve names codeg-plus stores
 *  (`THEME_COLOR_NAMES` in canvas_service.rs). */
export const THEME_COLORS = [
  'neutral',
  'zinc',
  'slate',
  'stone',
  'gray',
  'red',
  'rose',
  'orange',
  'green',
  'blue',
  'yellow',
  'violet',
]

/** A caller-facing rejection. The routes map it to 400, the tools to a tool
 *  error; either way the message is the whole explanation. */
export class CanvasInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CanvasInputError'
  }
}

function fail(message) {
  throw new CanvasInputError(message)
}

/** Trim, and map empty to null so "clear the title / colour" is expressible. */
export function normalizeText(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** Trim/clear like [`normalizeText`], then require vocabulary membership. */
export function normalizeColor(value) {
  const name = normalizeText(value)
  if (name === null) return null
  if (!THEME_COLORS.includes(name)) fail(`unknown theme color '${name}'`)
  return name
}

export function clampCoord(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) fail('coordinate is not finite')
  return Math.min(Math.max(n, -MAX_COORD), MAX_COORD)
}

export function clampSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) fail('size is not finite')
  return Math.min(Math.max(n, MIN_NODE_SIZE), MAX_NODE_SIZE)
}

/** Trim a pinned grid axis to 0..=MAX_GRID_AXIS. Absent / negative reads as
 *  auto rather than an error: the axis is a display preference, and rejecting
 *  the whole write over one would lose a legitimate geometry change with it. */
export function clampGridAxis(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(Math.trunc(n), 0), MAX_GRID_AXIS)
}

/** A session id as stored: a non-empty string, trimmed. */
export function normalizeSessionId(value) {
  const id = normalizeText(value)
  if (id === null) fail('session id must not be empty')
  return id
}

/** Default footprint for a fresh node of this kind. */
export function defaultFootprint(kind) {
  if (kind === 'note') return { width: NOTE_WIDTH, height: NOTE_HEIGHT }
  if (kind === 'session') return { width: CARD_WIDTH, height: CARD_HEIGHT }
  return { width: REGION_DEFAULT_WIDTH, height: REGION_DEFAULT_HEIGHT }
}

/**
 * Build a validated node record. Binding columns are resolved kind-specifically
 * and the unrelated ones are forced to null rather than trusted from the caller,
 * so a row can never carry a stale cross-kind reference.
 *
 * @param {object} input
 * @param {{id: number, now: string}} ctx
 */
export function createNodeRecord(input, ctx) {
  const kind = String(input.kind ?? '')
  if (!NODE_KINDS.includes(kind)) fail(`unknown node kind '${kind}'`)

  let workspace = null
  let agentType = null
  let sessionId = null
  if (kind === 'workspace') {
    workspace = normalizeText(input.workspace)
    if (workspace === null) fail('workspace region needs a workspace')
  } else if (kind === 'agent') {
    agentType = normalizeText(input.agentType)
    if (agentType === null) fail('agent region needs an agentType')
  } else if (kind === 'session') {
    sessionId = normalizeSessionId(input.sessionId)
  }

  // `content` is the note body — any other kind carrying one is a caller bug
  // that would smuggle invisible state into the row.
  let content = null
  if (kind === 'note') {
    content = input.content === undefined || input.content === null ? null : String(input.content)
    if (content === '') content = null
  } else if (normalizeText(input.content) !== null) {
    fail('content only applies to notes')
  }

  const footprint = defaultFootprint(kind)
  return {
    id: ctx.id,
    kind,
    workspace,
    agentType,
    sessionId,
    // A custom region starts empty; members arrive through the group/detach
    // paths so every entry passes its liveness check.
    memberIds: kind === 'custom' ? [] : [],
    title: normalizeText(input.title),
    content,
    color: normalizeColor(input.color),
    collapsed: false,
    // Grid shape is meaningless for a pinned card or a note; forcing 0 keeps
    // those rows from carrying state nothing reads.
    gridColumns: isRegionKind(kind) ? clampGridAxis(input.gridColumns) : 0,
    gridRows: isRegionKind(kind) ? clampGridAxis(input.gridRows) : 0,
    x: clampCoord(input.x ?? 0),
    y: clampCoord(input.y ?? 0),
    width: clampSize(input.width ?? footprint.width),
    height: clampSize(input.height ?? footprint.height),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
}

/**
 * Field-by-field patch. Absent = untouched; an empty string clears a nullable
 * text field. `memberAdd` / `memberRemove` are atomic list operations rather
 * than a whole-list replace, so two concurrent adds cannot lose each other.
 *
 * Returns a NEW record; the caller decides whether anything changed.
 *
 * @param {object} node
 * @param {object} patch
 * @param {{now: string, memberIsLive?: (sessionId: string) => boolean}} ctx
 */
export function applyPatch(node, patch, ctx) {
  const next = { ...node, memberIds: [...node.memberIds] }

  if (patch.memberAdd !== undefined || patch.memberRemove !== undefined) {
    if (node.kind !== 'custom') fail('member operations only apply to custom regions')
    if (patch.memberAdd !== undefined && patch.memberAdd !== null) {
      const id = normalizeSessionId(patch.memberAdd)
      if (ctx.memberIsLive && !ctx.memberIsLive(id)) {
        fail(`session ${id} does not exist`)
      }
      if (!next.memberIds.includes(id)) {
        if (next.memberIds.length >= MAX_CUSTOM_MEMBERS) {
          fail(`a region holds at most ${MAX_CUSTOM_MEMBERS} sessions`)
        }
        next.memberIds.push(id)
      }
    }
    if (patch.memberRemove !== undefined && patch.memberRemove !== null) {
      const id = String(patch.memberRemove)
      next.memberIds = next.memberIds.filter((m) => m !== id)
    }
  }

  if (patch.title !== undefined) next.title = normalizeText(patch.title)
  if (patch.content !== undefined) {
    if (node.kind !== 'note') fail('content only applies to notes')
    // Notes keep interior whitespace; only a fully-empty note clears.
    const text = patch.content === null ? '' : String(patch.content)
    next.content = text === '' ? null : text
  }
  if (patch.color !== undefined) next.color = normalizeColor(patch.color)
  if (patch.collapsed !== undefined) next.collapsed = Boolean(patch.collapsed)
  if (patch.gridColumns !== undefined || patch.gridRows !== undefined) {
    if (!isRegionKind(node.kind)) fail('grid shape only applies to regions')
    if (patch.gridColumns !== undefined) next.gridColumns = clampGridAxis(patch.gridColumns)
    if (patch.gridRows !== undefined) next.gridRows = clampGridAxis(patch.gridRows)
  }
  if (patch.x !== undefined) next.x = clampCoord(patch.x)
  if (patch.y !== undefined) next.y = clampCoord(patch.y)
  if (patch.width !== undefined) next.width = clampSize(patch.width)
  if (patch.height !== undefined) next.height = clampSize(patch.height)
  next.updatedAt = ctx.now
  return next
}

/**
 * Whether deleting this row would destroy prose the user typed by hand.
 *
 * The board has no undo, so every delete path stops to ask when it would take
 * one of these — and only then. Everything else on the canvas is an ARRANGEMENT
 * of something that lives elsewhere: removing a card unpins a session, removing
 * a region unframes it, and the session itself is untouched either way. A note
 * is the one node whose content exists nowhere but the note. An empty one is a
 * blank sheet and carries nothing to lose.
 */
export function noteHoldsProse(node) {
  if (!node || node.kind !== 'note') return false
  return String(node.content ?? '').trim() !== ''
}

// ── DOM ids ──
//
// Regions / notes / pins are ledger rows (`node-<id>`); member cards are
// DERIVED (`member-<regionId>-<sessionId>`) and never stored.

export function nodeElementId(id) {
  return `node-${id}`
}

export function memberElementId(regionId, sessionId) {
  return `member-${regionId}-${sessionId}`
}

export function parseNodeElementId(id) {
  if (typeof id !== 'string' || !id.startsWith('node-')) return null
  const parsed = Number(id.slice('node-'.length))
  return Number.isInteger(parsed) ? parsed : null
}

/** The member id carries a session id that may itself contain dashes, so only
 *  the FIRST separator after the region id is structural. */
export function parseMemberElementId(id) {
  if (typeof id !== 'string' || !id.startsWith('member-')) return null
  const rest = id.slice('member-'.length)
  const cut = rest.indexOf('-')
  if (cut <= 0) return null
  const regionId = Number(rest.slice(0, cut))
  const sessionId = rest.slice(cut + 1)
  if (!Number.isInteger(regionId) || sessionId === '') return null
  return { regionId, sessionId }
}
