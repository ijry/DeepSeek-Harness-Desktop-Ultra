/**
 * dsh-plugin-canvas — the derivation layer: ledger rows + live session list in,
 * the board's element list out.
 *
 * Ported from codeg-plus `canvas-model.ts` (`computeRegionMembers`,
 * `isUnresolvedBinding`, `deriveFlowGraph`). Everything here is a plain function
 * of its inputs, so it is unit-testable without a DOM: interaction state —
 * transient drag positions, expanded regions, member freezes — enters as
 * explicit parameters, never as module state.
 *
 * The session shape it consumes is the ONE normalized view the host hands the
 * browser (see host/sessions.js):
 *   { id, title, workspace, cwd, agentType, createdAt, updatedAt, live, kind,
 *     parentId, archived }
 *
 * @module dsh-plugin-canvas/shared/derive
 */
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  REGION_COLLAPSED_HEIGHT,
  REGION_FOOTER_HEIGHT,
  columnsForRegionWidth,
  effectiveColumns,
  regionHeightForRows,
  regionWidthForColumns,
  visibleMemberCap,
} from './units.js'
import { layoutRegionGrid } from './layout.js'
import { isRegionKind, memberElementId, nodeElementId } from './model.js'

/** Canvas scope: root-level work only. Delegation children and loop rows are
 *  sub-structure of a session, not peers to curate on a board. */
export function isCanvasEligible(session) {
  if (!session) return false
  if (session.kind === 'delegate' || session.kind === 'loop') return false
  if (session.parentId !== undefined && session.parentId !== null) return false
  return true
}

/** Two-key order (updatedAt desc, id desc): recency first, and a total order
 *  even when timestamps collide (a bulk import shares one clock tick). */
export function compareByRecency(a, b) {
  const ua = a.updatedAt ?? 0
  const ub = b.updatedAt ?? 0
  const na = Number(ua)
  const nb = Number(ub)
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    // The host reports epoch milliseconds, so compare numerically — as strings,
    // "900" would sort above "1000".
    if (na !== nb) return nb - na
  } else {
    // An ISO instant (or anything else) still has a correct lexical order.
    const sa = String(ua)
    const sb = String(ub)
    if (sa !== sb) return sa < sb ? 1 : -1
  }
  const ia = String(a.id)
  const ib = String(b.id)
  if (ia === ib) return 0
  return ia < ib ? 1 : -1
}

/**
 * The sessions a region shows, sorted. A workspace region matches by workspace
 * directory, an agent region by agent type across the whole harness, and a
 * custom region resolves its stored ids (a stale id — deleted before the prune
 * landed — silently drops out).
 */
export function computeRegionMembers(node, sessions) {
  switch (node.kind) {
    case 'workspace': {
      if (!node.workspace) return []
      return sessions
        .filter((s) => s.workspace === node.workspace && isCanvasEligible(s))
        .sort(compareByRecency)
    }
    case 'agent': {
      if (!node.agentType) return []
      return sessions
        .filter((s) => s.agentType === node.agentType && isCanvasEligible(s))
        .sort(compareByRecency)
    }
    case 'custom': {
      const byId = new Map(sessions.map((s) => [s.id, s]))
      return node.memberIds
        .map((id) => byId.get(id))
        // Eligibility re-checked on read: the ledger validates liveness, not
        // scope, so a row that later became sub-structure must drop out rather
        // than violate the canvas scope.
        .filter((s) => s != null && isCanvasEligible(s))
        .sort(compareByRecency)
    }
    default:
      return []
  }
}

/**
 * Whether a binding's target is gone. An unresolved node renders a greyed hint
 * instead of members — and comes back to life if the workspace is used again,
 * which is why nothing here ever prunes a region.
 *
 * An AGENT region is never unresolved: an agent with no sessions right now is an
 * empty region, not a broken one, exactly as in codeg-plus.
 */
export function isUnresolvedBinding(node, sessionsById, workspaces) {
  if (node.kind === 'session') {
    return !node.sessionId || !sessionsById.has(node.sessionId)
  }
  if (node.kind === 'workspace') {
    if (!node.workspace) return true
    return workspaces ? !workspaces.has(node.workspace) : false
  }
  return false
}

/**
 * Ledger rows + live sessions → the full element list.
 *
 * Output order is regions / notes / pins by ascending id, then member cards: a
 * parent has to exist before its children, and ascending id doubles as the paint
 * order `computeDropHint` mirrors (highest id wins a hit).
 *
 * @param {object} input
 * @param {Iterable<object>} input.nodes ledger rows
 * @param {object[]} input.sessions normalized session list
 * @param {Set<string>} [input.workspaces] workspaces that still exist
 * @param {Set<number>} input.expandedRegions regions whose "+N" expander is open
 * @param {Map<string, {x: number, y: number}>} input.overlay live drag positions by element id
 * @param {Map<number, string[]>} [input.frozenMembers] member snapshot taken at drag start
 * @param {Map<string, {width: number, height: number}>} [input.sizeOverlay] live resize dimensions
 * @param {Set<number>} [input.detailCards] pins rendered as a live session
 */
export function deriveBoard(input) {
  const {
    nodes,
    sessions,
    workspaces,
    expandedRegions,
    overlay,
    frozenMembers,
    sizeOverlay,
    detailCards,
  } = input
  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const sorted = [...nodes].sort((a, b) => a.id - b.id)
  const top = []
  const members = []
  const regionRects = []
  const pinRects = []
  const renderedSizes = new Map()

  for (const row of sorted) {
    const elementId = nodeElementId(row.id)
    const position = overlay.get(elementId) ?? { x: row.x, y: row.y }
    const liveSize = sizeOverlay ? sizeOverlay.get(elementId) : undefined

    if (row.kind === 'note') {
      const width = liveSize?.width ?? row.width
      const height = liveSize?.height ?? row.height
      renderedSizes.set(row.id, { width, height })
      top.push({ id: elementId, type: 'note', nodeId: row.id, row, position, width, height })
      continue
    }

    if (row.kind === 'session') {
      const session = row.sessionId ? (sessionsById.get(row.sessionId) ?? null) : null
      const unresolved = isUnresolvedBinding(row, sessionsById, workspaces)
      // A card with no session left to show has nothing to expand INTO — it
      // renders the "removed" shell either way, at the summary footprint.
      const detail = !unresolved && (detailCards ? detailCards.has(row.id) : false)
      // Detail cards keep the user's own size once they've resized one; until
      // then the stored geometry is still the summary footprint, which would
      // render the session in a 224×132 slot.
      const width = detail
        ? (liveSize?.width ?? (row.width > CARD_WIDTH ? row.width : DETAIL_CARD_WIDTH))
        : CARD_WIDTH
      const height = detail
        ? (liveSize?.height ?? (row.height > CARD_HEIGHT ? row.height : DETAIL_CARD_HEIGHT))
        : CARD_HEIGHT
      renderedSizes.set(row.id, { width, height })
      top.push({
        id: elementId,
        type: detail ? 'sessionDetail' : 'sessionCard',
        nodeId: row.id,
        row,
        session,
        sessionId: row.sessionId,
        color: row.color,
        unresolved,
        position,
        width,
        height,
      })
      if (!detail && session) {
        pinRects.push({
          id: row.id,
          sessionId: session.id,
          x: position.x,
          y: position.y,
          width,
          height,
        })
      }
      continue
    }

    if (!isRegionKind(row.kind)) continue

    const unresolved = isUnresolvedBinding(row, sessionsById, workspaces)
    const frozen = frozenMembers ? frozenMembers.get(row.id) : undefined
    // An unresolved binding shows the hint state, never cards — stale rows would
    // paint right over it.
    const resolved = unresolved
      ? []
      : frozen
        ? frozen.map((id) => sessionsById.get(id)).filter((s) => s != null)
        : computeRegionMembers(row, sessions)
    const expanded = expandedRegions.has(row.id)
    // A pinned column count OWNS the frame width: a stored width that drifted
    // from it (menu change, older row, another client) would lay out N columns
    // inside a frame sized for something else — which is exactly how cards end
    // up spilling past the border. A live resize still wins, because the view
    // quantizes it to whole columns before it gets here.
    const regionWidth =
      liveSize?.width ??
      (row.gridColumns > 0 ? regionWidthForColumns(row.gridColumns) : row.width)
    // Mid-resize the drag is the truth (quantized upstream); at rest the pinned
    // count is.
    const columns = liveSize
      ? columnsForRegionWidth(regionWidth)
      : effectiveColumns(row, regionWidth)
    const cap = visibleMemberCap(row, columns)
    const visible = expanded || row.collapsed ? resolved : resolved.slice(0, cap)
    const shown = row.collapsed ? [] : visible
    const grid = layoutRegionGrid(shown.length, regionWidth, columns)
    // The "+N" bar is a real row of chrome at the bottom, not an overlay —
    // reserve its height so it can never sit on top of the last card row.
    const footerPad =
      !row.collapsed && !expanded && resolved.length > cap ? REGION_FOOTER_HEIGHT : 0
    // With rows pinned the frame keeps its declared shape even while
    // under-filled — a "3 × 2 region" holding one session still reads as one.
    const declaredHeight = row.gridRows > 0 ? regionHeightForRows(row.gridRows) + footerPad : 0
    const renderedHeight = row.collapsed
      ? REGION_COLLAPSED_HEIGHT
      : Math.max(liveSize?.height ?? row.height, grid.contentHeight + footerPad, declaredHeight)
    renderedSizes.set(row.id, { width: regionWidth, height: renderedHeight })

    let runningCount = 0
    // "Running" is the only activity signal the harness gives a lightweight
    // listing: a session present in `ctx.sessions` is loaded and working.
    for (const s of resolved) if (s.live === true) runningCount++

    top.push({
      id: elementId,
      type: 'region',
      nodeId: row.id,
      row,
      position,
      width: regionWidth,
      height: renderedHeight,
      memberTotal: resolved.length,
      visibleCount: shown.length,
      hiddenCount: expanded ? 0 : Math.max(0, resolved.length - shown.length),
      runningCount,
      unresolved,
      expanded,
    })
    regionRects.push({
      id: row.id,
      kind: row.kind,
      x: position.x,
      y: position.y,
      width: regionWidth,
      height: renderedHeight,
    })

    for (let i = 0; i < shown.length; i++) {
      const session = shown[i]
      const id = memberElementId(row.id, session.id)
      const dragged = overlay.get(id)
      const slot = grid.positions[i]
      members.push({
        id,
        type: 'sessionCard',
        session,
        sessionId: session.id,
        regionId: row.id,
        // Only a custom region has a member LIST to remove from — every other
        // kind computes its members from a live binding, so offering "remove
        // from region" there is offering a button that can only fail.
        regionOwnsMembers: row.kind === 'custom',
        // A member has no row of its own to colour, so it wears the region's.
        color: row.color,
        unresolved: false,
        // Absolute board position: the grid slot offset from the region's
        // corner, or wherever the drag has taken it.
        position: dragged ?? { x: position.x + slot.x, y: position.y + slot.y },
        slot,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      })
    }
  }

  return { elements: [...top, ...members], regionRects, pinRects, renderedSizes }
}
