/**
 * dsh-plugin-canvas — drag classification and Figma-style alignment.
 *
 * Ported from codeg-plus `canvas-model.ts` (`computeDropHint`,
 * `computeAlignment`). Both are called on every drag frame to paint the hint
 * and again at drop to commit it, so the preview and the committed action can
 * never disagree.
 *
 * @module dsh-plugin-canvas/shared/snap
 */
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  REGION_HEADER_HEIGHT,
  REGION_PADDING,
  regionHeightForRows,
  regionWidthForColumns,
} from './units.js'

/**
 * Classify where a dragged session card currently is. `pos` is the card's
 * absolute board position (its top-left); the hit point is the CARD CENTER,
 * which is what the drag reads as "where the user is pointing".
 *
 * Regions are tested first and the topmost (= highest id) wins. A hit on the
 * source region is `same`; a hit on a BINDING region (workspace / agent) is
 * `canvas` rather than a rejection — their member list is computed, so there is
 * nothing to drop INTO, and snapping the card back would read as a broken drag.
 * Only when no region is hit do loose cards get tested, so a card sitting
 * inside a region's frame can never be a merge target.
 *
 * @param {{kind: 'member', regionId: number, sessionId: string}
 *        |{kind: 'pin', pinId: number, sessionId: string}} source
 * @param {{x: number, y: number}} pos
 * @param {{id: number, kind: string, x: number, y: number, width: number, height: number}[]} regions
 * @param {{id: number, sessionId: string, x: number, y: number, width: number, height: number}[]} pins
 * @param {{width: number, height: number}} [size] the dragged box, when it is not
 *   a summary card — an expanded card is 520×560, and classifying it from the
 *   summary footprint would read its centre 112×66 units off its real one.
 * @returns {{type: 'canvas', x: number, y: number}
 *          |{type: 'region', regionId: number}
 *          |{type: 'merge', targetPinId: number, targetSessionId: string, rect: {x: number, y: number, width: number, height: number}}
 *          |{type: 'same'}}
 */
export function computeDropHint(source, pos, regions, pins, size) {
  const cx = pos.x + (size?.width ?? CARD_WIDTH) / 2
  const cy = pos.y + (size?.height ?? CARD_HEIGHT) / 2
  const hits = (r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height

  let region = null
  for (const r of regions) {
    if (!hits(r)) continue
    if (!region || r.id > region.id) region = r
  }
  if (region) {
    if (source.kind === 'member' && region.id === source.regionId) return { type: 'same' }
    if (region.kind === 'custom') return { type: 'region', regionId: region.id }
    return { type: 'canvas', x: pos.x, y: pos.y }
  }

  let pin = null
  for (const p of pins) {
    if (source.kind === 'pin' && p.id === source.pinId) continue
    if (p.sessionId === source.sessionId) continue
    if (!hits(p)) continue
    if (!pin || p.id > pin.id) pin = p
  }
  if (pin) {
    return {
      type: 'merge',
      targetPinId: pin.id,
      targetSessionId: pin.sessionId,
      // The frame grows AROUND the stationary card, the way an iPhone folder
      // opens around the icon you dropped onto — and it is exactly the region
      // the drop will create, so the preview is the commitment.
      rect: {
        x: pin.x - REGION_PADDING,
        y: pin.y - REGION_HEADER_HEIGHT - REGION_PADDING,
        width: regionWidthForColumns(2),
        height: regionHeightForRows(1),
      },
    }
  }
  return { type: 'canvas', x: pos.x, y: pos.y }
}

const NO_ALIGNMENT = { dx: 0, dy: 0, guides: [] }

/** The three lines an edge can align to, per axis. */
function edgesX(r) {
  return [r.x, r.x + r.width / 2, r.x + r.width]
}

function edgesY(r) {
  return [r.y, r.y + r.height / 2, r.y + r.height]
}

/** Nudge onto the nearest multiple of `gap`, or 0 if the nearest one is further
 *  than `tolerance` away. */
function snapToLattice(value, gap, tolerance) {
  if (!(tolerance > 0)) return 0
  const delta = Math.round(value / gap) * gap - value
  return Math.abs(delta) <= tolerance ? delta : 0
}

/**
 * Figma-style alignment for a dragged element: find the nearest edge or centre
 * line within `tolerance` on each axis, return the nudge that lands on it plus
 * the guides to draw.
 *
 * Each axis is decided independently — a card can snap its left edge to one
 * neighbour while its top lines up with another, which is the whole point of
 * guides over a grid. Ties go to the smallest correction.
 *
 * `tolerance` is in BOARD units and the caller divides the screen distance it
 * wants by the current zoom: a fixed board tolerance feels sticky zoomed in and
 * unreachable zoomed out, because the same 6px of pointer travel covers a
 * different amount of board.
 *
 * `gridGap` adds the dot lattice as a per-axis FALLBACK: an axis that found
 * nothing to align to lands its leading edge on the nearest dot instead of
 * nowhere in particular. Elements win over dots because the user put the
 * elements there.
 *
 * @param {{x: number, y: number, width: number, height: number}} moving
 * @param {{x: number, y: number, width: number, height: number}[]} others
 * @param {number} tolerance
 * @param {number} [gridGap]
 * @returns {{dx: number, dy: number, guides: {axis: 'x'|'y', at: number, from: number, to: number}[]}}
 */
export function computeAlignment(moving, others, tolerance, gridGap) {
  // `!(> 0)` rather than `<= 0`: a NaN tolerance (a zoom that hasn't been read
  // yet divides into one) would pass every comparison below and snap the
  // element to the first candidate it saw.
  if (!(tolerance > 0)) return NO_ALIGNMENT
  if (others.length === 0 && !(gridGap && gridGap > 0)) return NO_ALIGNMENT

  let bestX = null
  let bestY = null
  for (const other of others) {
    for (const from of edgesX(moving)) {
      for (const to of edgesX(other)) {
        const delta = to - from
        if (Math.abs(delta) > tolerance) continue
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) bestX = { delta, at: to, other }
      }
    }
    for (const from of edgesY(moving)) {
      for (const to of edgesY(other)) {
        const delta = to - from
        if (Math.abs(delta) > tolerance) continue
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) bestY = { delta, at: to, other }
      }
    }
  }

  // The lattice, on whichever axis is still free. Its own tolerance is capped
  // at a quarter of the gap: the caller's is a screen distance divided by the
  // zoom, so a board at 50% would hand over half a gap — a capture zone
  // covering the entire lattice, with no way left to put anything BETWEEN two
  // dots. A quarter caps the zone at half, which still feels magnetic.
  const gridDx =
    gridGap && gridGap > 0 && !bestX
      ? snapToLattice(moving.x, gridGap, Math.min(tolerance, gridGap / 4))
      : 0
  const gridDy =
    gridGap && gridGap > 0 && !bestY
      ? snapToLattice(moving.y, gridGap, Math.min(tolerance, gridGap / 4))
      : 0

  const dx = bestX ? bestX.delta : gridDx
  const dy = bestY ? bestY.delta : gridDy

  // Both guides span the box as it will FINALLY sit — with both corrections
  // applied, not just their own axis's. A half-snapped box makes a guide stop
  // short of the element it claims to touch by the other axis's delta, which is
  // exactly the case where the user is watching closely.
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides = []
  if (bestX) {
    guides.push({
      axis: 'x',
      at: bestX.at,
      from: Math.min(snapped.y, bestX.other.y),
      to: Math.max(snapped.y + snapped.height, bestX.other.y + bestX.other.height),
    })
  }
  if (bestY) {
    guides.push({
      axis: 'y',
      at: bestY.at,
      from: Math.min(snapped.x, bestY.other.x),
      to: Math.max(snapped.x + snapped.width, bestY.other.x + bestY.other.width),
    })
  }
  // No guide for a lattice snap: the dots are already drawn, and a hairline to
  // one of them would be a line the user cannot act on.
  return { dx, dy, guides }
}
