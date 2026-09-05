/**
 * dsh-plugin-canvas — board units and region chrome geometry.
 *
 * Ported from codeg-plus `src/components/canvas/canvas-model.ts` (main branch),
 * numbers unchanged so a board laid out here reads exactly like the original.
 *
 * ⚠️ Board units are the canvas's whole coordinate system: every number in this
 * file, every position the browser half renders, every geometry field in the
 * ledger. They deliberately do NOT follow the host page's font size — a rem is
 * not a coordinate. Node boxes come from the board layer and their contents are
 * drawn in px, so the two can never disagree at a zoom other than 100%.
 * Zooming the board is the corner control's job.
 *
 * @module dsh-plugin-canvas/shared/units
 */

/** Fixed conversation-card footprint. */
export const CARD_WIDTH = 224
export const CARD_HEIGHT = 132

/** Region chrome: header bar, inner padding, gap between cards. The region
 *  component must render these exact values or member cards overlap the
 *  chrome. */
export const REGION_HEADER_HEIGHT = 40
export const REGION_PADDING = 12
export const CARD_GAP = 12

/** Height of a collapsed region capsule (header only). */
export const REGION_COLLAPSED_HEIGHT = 40

/** Height of the region's bottom "+N more" bar. A real row of chrome the grid
 *  reserves — not an overlay — so the last card row is never covered by it. */
export const REGION_FOOTER_HEIGHT = 36

/** Spacing of the dot lattice the board is drawn on. One constant for two
 *  consumers — the painted dots and the drag snapping that lands elements on
 *  them. Split them and the board would snap to dots it never drew. */
export const BOARD_DOT_GAP = 24

/** Footprint a pinned card takes when expanded into a live session. Used only
 *  while the stored geometry is still the SUMMARY footprint — once the user
 *  resizes a detail card, their size persists and wins. */
export const DETAIL_CARD_WIDTH = 520
export const DETAIL_CARD_HEIGHT = 560

/** Note default footprint. */
export const NOTE_WIDTH = 208
export const NOTE_HEIGHT = CARD_HEIGHT

/** The expanded card's drag handle (its title bar). Only the bar drags, so the
 *  rest of the card stays an ordinary document: selectable text, a scrollable
 *  transcript. The name lives here because the renderer and the gesture layer
 *  have to spell it identically. */
export const DRAG_HANDLE_CLASS = 'dshc-drag-handle'
export const DRAG_HANDLE_SELECTOR = `.${DRAG_HANDLE_CLASS}`

/** Cards shown in a region before the "+N" expander takes over, when the region
 *  has no pinned row count. A cap, not pagination: canvases curate, they don't
 *  list. */
export const MAX_VISIBLE_MEMBERS = 24

/** Zoom range of the board. Mirrored by the ledger's viewport clamp so a
 *  corrupted stored zoom can never strand a board the user cannot recover. */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 2

/** Alignment capture distance, in SCREEN px — divided by the live zoom before
 *  it is compared against board distances (see `computeAlignment`). */
export const ALIGN_TOLERANCE_PX = 6

/** The width a region needs to fit exactly `columns` cards per row (and the
 *  height for `rows` rows of them). Resizing snaps to these values, so a region
 *  never sits at a width that renders a ragged half-column of dead space. */
export function regionWidthForColumns(columns) {
  const n = Math.max(1, Math.round(columns))
  return REGION_PADDING * 2 + n * CARD_WIDTH + (n - 1) * CARD_GAP
}

export function regionHeightForRows(rows) {
  const n = Math.max(1, Math.round(rows))
  return (
    REGION_HEADER_HEIGHT + REGION_PADDING * 2 + n * CARD_HEIGHT + (n - 1) * CARD_GAP
  )
}

/** A fresh region's frame: three cards across, two rows down. */
export const REGION_DEFAULT_WIDTH = regionWidthForColumns(3)
export const REGION_DEFAULT_HEIGHT = regionHeightForRows(2)

/** Inverse of [`regionWidthForColumns`]: how many whole cards fit across a
 *  region of this width (at least one — a region narrower than a card still
 *  shows it, clipped, rather than rendering an empty frame). */
export function columnsForRegionWidth(width) {
  const usable = Math.max(width - REGION_PADDING * 2, CARD_WIDTH)
  return Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
}

export function rowsForRegionHeight(height) {
  const usable = Math.max(height - REGION_HEADER_HEIGHT - REGION_PADDING * 2, CARD_HEIGHT)
  return Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_HEIGHT + CARD_GAP)))
}

/** The column count a region actually lays out at: its pinned `gridColumns`
 *  when set, otherwise derived from the width. One place, because the grid, the
 *  visible-member cap and the resize snap all have to agree. */
export function effectiveColumns(node, regionWidth) {
  return node.gridColumns > 0 ? node.gridColumns : columnsForRegionWidth(regionWidth)
}

/** How many member cards a region shows before the "+N" bar takes over. A
 *  pinned row count makes the region a fixed viewport onto its members
 *  (rows × columns); without one it falls back to the flat cap. */
export function visibleMemberCap(node, columns) {
  return node.gridRows > 0 ? node.gridRows * columns : MAX_VISIBLE_MEMBERS
}

/** Clamp a zoom into the board's range. */
export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)
}
