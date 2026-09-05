/**
 * Viewport math: board ↔ screen conversion, zooming about a point, fit-view, the
 * dot lattice, and the navigator map.
 *
 * The board layer is one `transform: translate(x, y) scale(z)` with a `0 0`
 * origin, so a board coordinate maps to a screen coordinate by `p * z + offset`
 * and back by `(s - offset) / z`. Every gesture converts through these two
 * functions rather than doing its own arithmetic — a drag that used a slightly
 * different formula than the renderer is exactly how a card ends up lagging the
 * pointer at zooms other than 100%.
 *
 * @module dsh-plugin-canvas/client/viewport
 */

/** Zoom step for the corner buttons, and the animation-free duration budget. */
const ZOOM_STEP = 1.2
const VIEWPORT_SAVE_DELAY_MS = 500

let saveTimer = null

/** Persist the viewport on a trailing debounce: a pan emits one frame per mouse
 *  move, and localStorage is synchronous. */
export function scheduleViewportSave() {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveViewport()
  }, VIEWPORT_SAVE_DELAY_MS)
}

export function flushViewportSave() {
  if (saveTimer === null) return
  clearTimeout(saveTimer)
  saveTimer = null
  saveViewport()
}

/** Screen point (client coords) → board point. */
export function screenToBoard(rect, clientX, clientY) {
  const { x, y, zoom } = model.viewport
  return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom }
}

/** Board point → screen point, relative to the surface's top-left. */
export function boardToScreen(point) {
  const { x, y, zoom } = model.viewport
  return { x: point.x * zoom + x, y: point.y * zoom + y }
}

/** Screen distance → board distance. */
export function toBoardDistance(px) {
  return px / model.viewport.zoom
}

/** Replace the viewport, clamping the zoom. */
export function setViewport(next) {
  model.viewport = {
    x: Number.isFinite(next.x) ? next.x : model.viewport.x,
    y: Number.isFinite(next.y) ? next.y : model.viewport.y,
    zoom: clampZoom(next.zoom ?? model.viewport.zoom),
  }
  scheduleViewportSave()
  emit()
}

/** Zoom keeping one screen point fixed — the only zoom that feels attached to
 *  the pointer. */
export function zoomAbout(rect, clientX, clientY, factor) {
  const before = model.viewport
  const zoom = clampZoom(before.zoom * factor)
  if (zoom === before.zoom) return
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  // Solve for the offset that keeps (sx, sy) over the same board point.
  setViewport({
    x: sx - ((sx - before.x) / before.zoom) * zoom,
    y: sy - ((sy - before.y) / before.zoom) * zoom,
    zoom,
  })
}

/** Zoom about the surface centre (the corner buttons). */
export function zoomByStep(rect, direction) {
  zoomAbout(rect, rect.left + rect.width / 2, rect.top + rect.height / 2, direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
}

/** Jump to exactly 100%, about the centre. */
export function resetZoom(rect) {
  const before = model.viewport
  if (before.zoom === 1) return
  const sx = rect.width / 2
  const sy = rect.height / 2
  setViewport({
    x: sx - ((sx - before.x) / before.zoom) * 1,
    y: sy - ((sy - before.y) / before.zoom) * 1,
    zoom: 1,
  })
}

/** Union of every rendered element's box, in board units. */
export function boardBounds(elements) {
  if (elements.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.position.x)
    minY = Math.min(minY, el.position.y)
    maxX = Math.max(maxX, el.position.x + el.width)
    maxY = Math.max(maxY, el.position.y + el.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Fit every element into view. `padding` is a fraction of the viewport (0.2 like
 * codeg-plus), and `maxZoom` caps the scale so a board holding one note doesn't
 * blow it up to fill the window.
 */
export function fitView(rect, elements, options = {}) {
  const bounds = boardBounds(elements)
  if (bounds === null || rect.width === 0 || rect.height === 0) return
  const padding = options.padding ?? 0.2
  const maxZoom = options.maxZoom ?? 1
  const usableW = rect.width * (1 - padding)
  const usableH = rect.height * (1 - padding)
  const zoom = clampZoom(
    Math.min(maxZoom, Math.min(usableW / Math.max(bounds.width, 1), usableH / Math.max(bounds.height, 1)))
  )
  setViewport({
    x: rect.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: rect.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  })
}

/** Push the viewport onto the DOM: the board transform and the dot lattice the
 *  drag snapping lands on. */
export function applyViewport(surfaceEl, boardEl) {
  const { x, y, zoom } = model.viewport
  boardEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
  const gap = BOARD_DOT_GAP * zoom
  surfaceEl.style.backgroundImage =
    'radial-gradient(circle, var(--dshc-dot) 1px, transparent 1px)'
  surfaceEl.style.backgroundSize = `${gap}px ${gap}px`
  // The gradient centres its dot in each tile, so the tile origin has to sit half
  // a gap BEFORE the board coordinate the dot belongs to. Without the shift the
  // painted dots land halfway between the lattice positions drags snap to — the
  // one invariant board units exist to keep (see units.js).
  surfaceEl.style.backgroundPosition = `${(x % gap) - gap / 2}px ${(y % gap) - gap / 2}px`
}

/** Map size, and how much board it pads around the content. */
const MAP_WIDTH = 168
const MAP_HEIGHT = 126

/**
 * Paint the navigator map: every element as a block, plus the current viewport
 * frame. Clicking or dragging inside it re-centres the board — the map is how a
 * board bigger than the window stays navigable.
 */
export function renderMinimap(mapEl, elements, rect) {
  mapEl.style.width = `${MAP_WIDTH}px`
  mapEl.style.height = `${MAP_HEIGHT}px`
  const { x, y, zoom } = model.viewport
  const view = { x: -x / zoom, y: -y / zoom, width: rect.width / zoom, height: rect.height / zoom }
  const content = boardBounds(elements) ?? { x: 0, y: 0, width: 1, height: 1 }
  // The map must show both the content and where you are, or panning off the
  // content would leave the frame stuck against an edge with no way to read it.
  const minX = Math.min(content.x, view.x)
  const minY = Math.min(content.y, view.y)
  const maxX = Math.max(content.x + content.width, view.x + view.width)
  const maxY = Math.max(content.y + content.height, view.y + view.height)
  const span = { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) }
  const scale = Math.min(MAP_WIDTH / span.width, MAP_HEIGHT / span.height)
  const offsetX = (MAP_WIDTH - span.width * scale) / 2
  const offsetY = (MAP_HEIGHT - span.height * scale) / 2
  const place = (el, box, kind) => {
    el.style.left = `${offsetX + (box.x - span.x) * scale}px`
    el.style.top = `${offsetY + (box.y - span.y) * scale}px`
    el.style.width = `${Math.max(box.width * scale, 2)}px`
    el.style.height = `${Math.max(box.height * scale, 2)}px`
    if (kind !== undefined) el.dataset.kind = kind
  }
  mapEl.textContent = ''
  for (const element of elements) {
    if (element.type === 'sessionCard' && element.regionId !== undefined) continue
    const block = document.createElement('div')
    block.className = 'dshc-map-node'
    place(block, { ...element.position, width: element.width, height: element.height }, element.type)
    mapEl.append(block)
  }
  const frame = document.createElement('div')
  frame.className = 'dshc-map-view'
  place(frame, view)
  mapEl.append(frame)
  mapEl._span = span
  mapEl._scale = scale
  mapEl._offset = { x: offsetX, y: offsetY }
}

/** Board point under a click on the map, or null when it has not been painted. */
export function minimapToBoard(mapEl, clientX, clientY) {
  if (mapEl._span === undefined) return null
  const box = mapEl.getBoundingClientRect()
  return {
    x: mapEl._span.x + (clientX - box.left - mapEl._offset.x) / mapEl._scale,
    y: mapEl._span.y + (clientY - box.top - mapEl._offset.y) / mapEl._scale,
  }
}

/** Centre the viewport on one board point. */
export function centerOn(rect, point) {
  const { zoom } = model.viewport
  setViewport({ x: rect.width / 2 - point.x * zoom, y: rect.height / 2 - point.y * zoom, zoom })
}
