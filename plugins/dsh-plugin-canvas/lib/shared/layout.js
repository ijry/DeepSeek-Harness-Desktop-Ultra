/**
 * dsh-plugin-canvas — grid placement, shelf packing and the empty-board seed.
 *
 * Ported from codeg-plus `canvas-model.ts` (`layoutRegionGrid`, `packLayout`,
 * `seedRegionsFromFolders`). Pure functions of their inputs.
 *
 * @module dsh-plugin-canvas/shared/layout
 */
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  REGION_COLLAPSED_HEIGHT,
  REGION_HEADER_HEIGHT,
  REGION_PADDING,
  columnsForRegionWidth,
  regionHeightForRows,
  regionWidthForColumns,
} from './units.js'

/**
 * Grid-managed member placement inside a region. Members are never freely
 * positioned — the grid owns them; a drop inside the same region snaps back.
 * `pinnedColumns > 0` overrides the width-derived column count.
 *
 * @param {number} count
 * @param {number} regionWidth
 * @param {number} [pinnedColumns]
 * @returns {{positions: {x: number, y: number}[], contentHeight: number, columns: number}}
 */
export function layoutRegionGrid(count, regionWidth, pinnedColumns = 0) {
  const columns =
    pinnedColumns > 0 ? Math.round(pinnedColumns) : columnsForRegionWidth(regionWidth)
  const positions = []
  for (let i = 0; i < count; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    positions.push({
      x: REGION_PADDING + col * (CARD_WIDTH + CARD_GAP),
      y: REGION_HEADER_HEIGHT + REGION_PADDING + row * (CARD_HEIGHT + CARD_GAP),
    })
  }
  const rows = Math.ceil(count / columns)
  const contentHeight =
    rows === 0
      ? REGION_COLLAPSED_HEIGHT + REGION_PADDING * 2
      : REGION_HEADER_HEIGHT +
        REGION_PADDING * 2 +
        rows * CARD_HEIGHT +
        (rows - 1) * CARD_GAP
  return { positions, contentHeight, columns }
}

/**
 * Shelf-packing auto-arrange: sort by height (tallest first), fill
 * left-to-right shelves up to a target row width, top-align each shelf.
 * Returns only the nodes that actually move.
 *
 * Both axes come from `renderedSizes`, never from the stored row. The stored
 * geometry is regularly NOT what is on screen: an expanded card renders 520
 * wide while its row still holds the 224 summary footprint, and a region with a
 * pinned grid shape derives its width from that shape. Packing against the row
 * reserved the smaller box and the bigger one then overlapped its neighbour —
 * which is what "auto-arrange overlaps" was.
 *
 * @param {{id: number, x: number, y: number, width: number, height: number}[]} nodes
 * @param {Map<number, {width: number, height: number}>} renderedSizes
 * @param {{gap?: number, rowWidth?: number}} [opts]
 * @returns {{id: number, x: number, y: number}[]}
 */
export function packLayout(nodes, renderedSizes, opts = {}) {
  const gap = opts.gap ?? 48
  const rowWidth = opts.rowWidth ?? 2400
  const sizeOf = (node) =>
    renderedSizes.get(node.id) ?? { width: node.width, height: node.height }
  const sorted = [...nodes].sort((a, b) => {
    const ha = sizeOf(a).height
    const hb = sizeOf(b).height
    if (ha !== hb) return hb - ha
    return a.id - b.id
  })
  const moves = []
  let shelfX = 0
  let shelfY = 0
  let shelfHeight = 0
  for (const node of sorted) {
    const { width, height } = sizeOf(node)
    if (shelfX > 0 && shelfX + width > rowWidth) {
      shelfY += shelfHeight + gap
      shelfX = 0
      shelfHeight = 0
    }
    if (node.x !== shelfX || node.y !== shelfY) {
      moves.push({ id: node.id, x: shelfX, y: shelfY })
    }
    shelfX += width + gap
    shelfHeight = Math.max(shelfHeight, height)
  }
  return moves
}

/**
 * Seed layout for the empty-canvas CTA: one workspace region per workspace,
 * shelf-packed with a uniform 3 × 2 footprint, two per row.
 *
 * @param {{id: string}[]} workspaces
 * @returns {{workspace: string, x: number, y: number, width: number, height: number}[]}
 */
export function seedRegionsFromWorkspaces(workspaces) {
  const width = regionWidthForColumns(3)
  const height = regionHeightForRows(2)
  const perRow = 2
  return workspaces.map((w, i) => ({
    workspace: w.id,
    x: (i % perRow) * (width + 48),
    y: Math.floor(i / perRow) * (height + 48),
    width,
    height,
  }))
}
