/**
 * The eight board mutations, as pure functions over a ledger draft.
 *
 * Ported from codeg-plus `db/service/canvas_service.rs`: same invariants, same
 * one-gesture-one-event shape. Each returns the change payload the store
 * broadcasts (minus its revision, which the store stamps), or `undefined` when
 * nothing actually changed — a no-op must not consume a revision, or every
 * client burns a snapshot refetch on a phantom gap.
 *
 * `ctx` supplies the outside world: `now()` (ISO string), `sessionIsLive(id)`
 * and `workspaceExists(id)`. Liveness is checked HERE, inside the mutation, so a
 * reference to something that has since vanished can never be minted.
 *
 * @module dsh-plugin-canvas/host/board
 */
import {
  CanvasInputError,
  MAX_CUSTOM_MEMBERS,
  applyPatch,
  clampCoord,
  createNodeRecord,
  isBindingKind,
  isRegionKind,
  normalizeColor,
  normalizeSessionId,
  normalizeText,
} from '../shared/model.js'
import { CARD_HEIGHT, CARD_WIDTH } from '../shared/units.js'

/** A named target that does not exist. Routes map it to 404. */
export class CanvasNotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CanvasNotFoundError'
  }
}

function requireNode(draft, id) {
  const node = draft.nodes.find((n) => n.id === id)
  if (node === undefined) throw new CanvasNotFoundError(`canvas node ${id} not found`)
  return node
}

function requireLiveSession(ctx, sessionId) {
  if (ctx.sessionIsLive && !ctx.sessionIsLive(sessionId)) {
    throw new CanvasInputError(`session ${sessionId} does not exist`)
  }
}

/** Everything but `updatedAt` — the field a bump would always change. */
function sameNode(a, b) {
  const strip = (n) => JSON.stringify({ ...n, updatedAt: '' })
  return strip(a) === strip(b)
}

/** Create one node. Binding targets are checked for existence, so a region can
 *  never be born pointing at nothing. */
export function createNode(draft, input, ctx) {
  const now = ctx.now()
  const record = createNodeRecord(input, { id: draft.nextId, now })
  if (record.kind === 'session') requireLiveSession(ctx, record.sessionId)
  if (record.kind === 'workspace' && ctx.workspaceExists && !ctx.workspaceExists(record.workspace)) {
    throw new CanvasNotFoundError(`workspace ${record.workspace} not found`)
  }
  draft.nextId += 1
  draft.nodes.push(record)
  return { kind: 'upsert', node: record }
}

/** Patch one node. An empty or idempotent patch commits nothing. */
export function updateNode(draft, id, patch, ctx) {
  const existing = requireNode(draft, id)
  const next = applyPatch(existing, patch, {
    now: ctx.now(),
    memberIsLive: ctx.sessionIsLive,
  })
  if (sameNode(existing, next)) return undefined
  draft.nodes = draft.nodes.map((n) => (n.id === id ? next : n))
  return { kind: 'upsert', node: next }
}

/**
 * Batch position write (a drop, an auto-arrange, a multi-select drag): one bump,
 * one event, however many nodes moved. Ids that no longer exist are skipped — a
 * move is cosmetic and racing a delete must not fail the whole batch.
 *
 * Returns the moves as ACTUALLY WRITTEN (clamped, ghosts dropped), because that
 * is what the broadcast must carry: echoing the caller's raw values would leave
 * every client holding positions the ledger never stored.
 */
export function moveNodes(draft, moves, ctx) {
  if (!Array.isArray(moves) || moves.length === 0) return undefined
  const now = ctx.now()
  const applied = []
  const byId = new Map(draft.nodes.map((n) => [n.id, n]))
  for (const move of moves) {
    const id = Number(move?.id)
    const node = byId.get(id)
    if (node === undefined) continue
    const x = clampCoord(move.x)
    const y = clampCoord(move.y)
    node.x = x
    node.y = y
    node.updatedAt = now
    applied.push({ id, x, y })
  }
  if (applied.length === 0) return undefined
  return { kind: 'moved', moves: applied }
}

/**
 * Drag a member card out of a region onto open canvas, as ONE change — the
 * removal and the new pin can never be torn apart.
 *
 * A CUSTOM region moves (membership is removed, and it must be there, so a stale
 * retry surfaces as not-found instead of minting a duplicate pin); a workspace or
 * agent region COPIES — their member list is a live binding with no single member
 * to remove.
 */
export function detachMember(draft, regionId, rawSessionId, x, y, ctx) {
  const sessionId = normalizeSessionId(rawSessionId)
  const region = requireNode(draft, regionId)
  if (!isRegionKind(region.kind)) {
    throw new CanvasInputError(`canvas node ${regionId} is not a region`)
  }
  const now = ctx.now()
  let removedFrom = null
  if (region.kind === 'custom') {
    if (!region.memberIds.includes(sessionId)) {
      throw new CanvasNotFoundError(
        `session ${sessionId} is not a member of region ${regionId}`
      )
    }
    region.memberIds = region.memberIds.filter((m) => m !== sessionId)
    region.updatedAt = now
    removedFrom = regionId
  }
  requireLiveSession(ctx, sessionId)
  const node = createNodeRecord(
    { kind: 'session', sessionId, x, y, width: CARD_WIDTH, height: CARD_HEIGHT },
    { id: draft.nextId, now }
  )
  draft.nextId += 1
  draft.nodes.push(node)
  return { kind: 'detached', removedFrom, node }
}

/**
 * "Collect these sessions into a region", as ONE change: the region is created
 * (or extended) with its member list already validated, and the loose pinned
 * cards it absorbed are deleted alongside.
 *
 * Three gestures share it — box-select → collect, a card dragged into a custom
 * region, and two cards dropped onto each other. All three mean the same thing:
 * "this region now holds these sessions, and these loose cards are gone".
 */
export function groupIntoRegion(draft, input, ctx) {
  const now = ctx.now()
  // Dedupe preserving the caller's order: the same session can be selected
  // twice (a member card and its mirror in another region), and members are a set.
  const members = []
  for (const raw of input.memberIds ?? []) {
    const id = normalizeSessionId(raw)
    if (members.includes(id)) continue
    if (members.length >= MAX_CUSTOM_MEMBERS) {
      throw new CanvasInputError(`a region holds at most ${MAX_CUSTOM_MEMBERS} sessions`)
    }
    requireLiveSession(ctx, id)
    members.push(id)
  }

  // Resolve the destination BEFORE anything is deleted: a consumed card may only
  // be destroyed once the session it was showing is guaranteed a seat.
  let target
  if (input.targetRegionId !== undefined && input.targetRegionId !== null) {
    target = requireNode(draft, Number(input.targetRegionId))
    if (target.kind !== 'custom') {
      throw new CanvasInputError('only custom regions can absorb sessions')
    }
  }

  const finalMembers = target === undefined ? members : [...target.memberIds]
  if (target !== undefined) {
    for (const id of members) {
      if (finalMembers.includes(id)) continue
      if (finalMembers.length >= MAX_CUSTOM_MEMBERS) {
        throw new CanvasInputError(`a region holds at most ${MAX_CUSTOM_MEMBERS} sessions`)
      }
      finalMembers.push(id)
    }
  }

  // Only pinned cards are consumable. A region or a note named by the caller
  // keeps living where it is — collecting a session is a membership change, not a
  // licence to delete arbitrary nodes.
  const doomed = []
  for (const raw of input.consumeNodeIds ?? []) {
    const id = Number(raw)
    const node = draft.nodes.find((n) => n.id === id && n.kind === 'session')
    if (node === undefined) continue
    // Consuming a card means "the region took it over", so the takeover has to be
    // real: deleting a card whose session ends up in no member list would destroy
    // the user's only handle on it, inside the very event claiming it was collected.
    if (!finalMembers.includes(node.sessionId)) {
      throw new CanvasInputError("a consumed card's session must be a member of the region")
    }
    doomed.push(id)
  }

  if (doomed.length > 0) {
    draft.nodes = draft.nodes.filter((n) => !doomed.includes(n.id))
  }

  let node
  if (target !== undefined) {
    target.memberIds = finalMembers
    target.updatedAt = now
    node = target
  } else {
    const geometry = ['x', 'y', 'width', 'height'].map((k) => input[k])
    if (geometry.some((v) => v === undefined || v === null)) {
      throw new CanvasInputError('a new region needs x, y, width and height together')
    }
    node = createNodeRecord(
      {
        kind: 'custom',
        title: normalizeText(input.title),
        color: normalizeColor(input.color),
        gridColumns: input.gridColumns,
        gridRows: input.gridRows,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      },
      { id: draft.nextId, now }
    )
    node.memberIds = finalMembers
    draft.nextId += 1
    draft.nodes.push(node)
  }
  return { kind: 'grouped', node, deletedIds: doomed }
}

/** Delete one node. `undefined` when it was already gone — nothing changed, so
 *  the caller must not broadcast a phantom event. */
export function deleteNode(draft, id) {
  const before = draft.nodes.length
  draft.nodes = draft.nodes.filter((n) => n.id !== id)
  if (draft.nodes.length === before) return undefined
  return { kind: 'deleted', id }
}

/**
 * Delete several nodes at once (a multi-selection): one bump, one event — going
 * one by one would spray a revision per node and let every client watch the
 * selection disappear in pieces. Ids that no longer exist are skipped, and the
 * ids ACTUALLY deleted come back so the broadcast describes what happened rather
 * than what was asked. Reuses the `pruned` payload: "these ids are gone, these
 * nodes changed" is exactly what it means.
 */
export function deleteNodes(draft, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return undefined
  const wanted = new Set(ids.map((id) => Number(id)))
  const deletedIds = draft.nodes.filter((n) => wanted.has(n.id)).map((n) => n.id)
  if (deletedIds.length === 0) return undefined
  draft.nodes = draft.nodes.filter((n) => !wanted.has(n.id))
  return { kind: 'pruned', deletedIds, updated: [] }
}

/**
 * Scrub every canvas reference to sessions that no longer exist: drop their
 * pinned cards and remove them from every custom region's member list.
 *
 * codeg-plus hooks this into its conversation-deletion funnel. dsh has no such
 * hook a plugin can join, so it runs opportunistically instead — whenever the
 * host observes the live session set (see host/sessions.js). Nothing is lost by
 * the delay: an unresolved card is exactly what the board shows in the meantime,
 * and the liveness barrier above means no NEW reference can be minted.
 */
export function pruneForSessions(draft, sessionIds, ctx) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return undefined
  const gone = new Set(sessionIds.map(String))
  const now = ctx.now()
  const deletedIds = draft.nodes
    .filter((n) => n.kind === 'session' && gone.has(n.sessionId))
    .map((n) => n.id)
  if (deletedIds.length > 0) {
    draft.nodes = draft.nodes.filter((n) => !deletedIds.includes(n.id))
  }
  const updated = []
  for (const node of draft.nodes) {
    if (node.kind !== 'custom') continue
    const next = node.memberIds.filter((m) => !gone.has(m))
    if (next.length === node.memberIds.length) continue
    node.memberIds = next
    node.updatedAt = now
    updated.push(node)
  }
  if (deletedIds.length === 0 && updated.length === 0) return undefined
  return { kind: 'pruned', deletedIds, updated }
}

/** Whether this kind's members are a live binding (no drops, no removals). */
export { isBindingKind }
