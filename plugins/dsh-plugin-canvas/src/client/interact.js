/**
 * Every gesture: pan, zoom, marquee, node drag with alignment, resize, and the
 * keyboard. One module because they share the same three transient stores —
 * `model.overlay` (live positions), `model.sizeOverlay` (live dimensions) and
 * `model.guides` — and the rule that a live gesture always wins over a remote
 * update, so a card can never be yanked out from under the pointer.
 *
 * Ported from codeg-plus's canvas-view.tsx plus its two gesture hooks
 * (`use-canvas-right-drag-pan`, `use-canvas-marquee-text-guard`).
 *
 * @module dsh-plugin-canvas/client/interact
 */

/** Live gesture state. Exactly one of these is non-null at a time. */
let gPan = null
let gDrag = null
let gResize = null
let gMarquee = null
/** Alt suspends snapping while held; a window blur assumes it was released. */
let gAlt = false

/** Minimum sizes per node type, mirroring codeg-plus's NodeResizer bounds. */
const MIN_SIZE = {
  region: { width: 260, height: 160 },
  note: { width: 140, height: 96 },
  sessionDetail: { width: 360, height: 320 },
}

/** Chrome that must never start a drag. */
const CHROME = '.dshc-dock, .dshc-corner, .dshc-menu, .dshc-modal, .dshc-toasts'

function gRect(surface) {
  return surface.getBoundingClientRect()
}

/** Whether no gesture is live — the renderer asks before pruning the selection. */
export function gestureIdle() {
  return gPan === null && gDrag === null && gResize === null && gMarquee === null
}

/** The element record behind a wrapper, from the last derived board. */
function elementOf(elementId) {
  return (model.board?.elements ?? []).find((e) => e.id === elementId)
}

/** Top-level element ids currently selected (member cards excluded — the grid
 *  owns those, and only the grabbed one ever re-homes). */
function selectedTopLevel() {
  const ids = []
  for (const id of model.selected) {
    if (parseNodeElementId(id) !== null) ids.push(id)
  }
  return ids
}

/** Suppress the text selection a marquee would otherwise paint.
 *
 *  Three steps, all of them load-bearing: collapse any existing selection (the
 *  suppressed default would otherwise have done it), prevent the default so no
 *  selection anchor is created at all, and blur whatever was focused inside the
 *  board so the next keystroke reaches the shortcuts rather than a text field the
 *  user has left. */
function guardTextSelection(surface, event) {
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    /* a detached selection is not worth failing a drag over */
  }
  event.preventDefault()
  const active = document.activeElement
  if (active !== null && active !== document.body && surface.contains(active)) active.blur()
  surface.dataset.marquee = 'true'
}

/** Rect of two board points, normalized. */
function rectOf(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function intersects(a, b) {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}

/** Start a node drag. Returns false when this target must not drag. */
function beginDrag(surface, wrapper, event) {
  const elementId = wrapper.dataset.id
  const element = elementOf(elementId)
  if (element === undefined) return false
  // An expanded card only drags by its title bar: the body has to stay an
  // ordinary document you can select text in and scroll.
  if (element.type === 'sessionDetail' && event.target.closest(DRAG_HANDLE_SELECTOR) === null) {
    return false
  }
  const additive = event.metaKey || event.ctrlKey || event.shiftKey
  if (additive) {
    if (model.selected.has(elementId)) model.selected.delete(elementId)
    else model.selected.add(elementId)
    emit()
    return false
  }
  if (!model.selected.has(elementId)) selectOnly(elementId)

  const member = parseMemberElementId(elementId)
  const ids = member !== null ? [elementId] : [...new Set([elementId, ...selectedTopLevel()])]
  const origin = new Map()
  for (const id of ids) {
    const record = elementOf(id)
    if (record !== undefined) origin.set(id, { ...record.position })
  }
  const source =
    element.type === 'sessionCard' || element.type === 'sessionDetail'
      ? member !== null
        ? { kind: 'member', regionId: member.regionId, sessionId: member.sessionId }
        : { kind: 'pin', pinId: parseNodeElementId(elementId), sessionId: element.sessionId }
      : null
  // Candidates snapshotted once: a remote change mid-drag must not move the lines
  // the user is aiming at. Member cards are excluded — their coordinates belong to
  // a grid, not to the board.
  const candidates = []
  for (const record of model.board?.elements ?? []) {
    if (origin.has(record.id) || record.regionId !== undefined) continue
    candidates.push({ ...record.position, width: record.width, height: record.height })
  }
  if (member !== null) {
    const region = model.nodes.get(member.regionId)
    // Freeze the RESOLVED list, not the stored one: a workspace or agent region
    // has no stored members at all (its list is a live binding), so freezing
    // `memberIds` would hand the grid an empty array — every card in the region,
    // including the one under the pointer, would vanish the moment it is pressed.
    if (region !== undefined) {
      model.frozenMembers = new Map([
        [region.id, computeRegionMembers(region, model.sessions).map((s) => s.id)],
      ])
    }
  }
  gDrag = {
    ids,
    origin,
    primary: elementId,
    element,
    source,
    // No snapping inside a grid: a member's position is the grid's to decide.
    alignable: member === null,
    candidates,
    start: screenToBoard(gRect(surface), event.clientX, event.clientY),
    moved: false,
    lastHint: null,
  }
  return true
}

/** One drag frame: overlay positions, guides, drop hint. */
function moveDrag(surface, event) {
  const point = screenToBoard(gRect(surface), event.clientX, event.clientY)
  let dx = point.x - gDrag.start.x
  let dy = point.y - gDrag.start.y
  if (!gDrag.moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  gDrag.moved = true

  const primaryOrigin = gDrag.origin.get(gDrag.primary)
  if (gDrag.alignable && !gAlt && primaryOrigin !== undefined) {
    const moving = {
      x: primaryOrigin.x + dx,
      y: primaryOrigin.y + dy,
      width: gDrag.element.width,
      height: gDrag.element.height,
    }
    const align = computeAlignment(
      moving,
      gDrag.candidates,
      ALIGN_TOLERANCE_PX / model.viewport.zoom,
      BOARD_DOT_GAP
    )
    dx += align.dx
    dy += align.dy
    model.guides = align.guides
  } else {
    model.guides = []
  }

  for (const [id, start] of gDrag.origin) {
    model.overlay.set(id, { x: start.x + dx, y: start.y + dy })
  }

  if (gDrag.source !== null) {
    const pos = model.overlay.get(gDrag.primary)
    const hint = computeDropHint(gDrag.source, pos, model.board.regionRects, model.board.pinRects, {
      width: gDrag.element.width,
      height: gDrag.element.height,
    })
    model.dropHint = hint
    model.dropTargetRegionId = hint.type === 'region' ? hint.regionId : null
    gDrag.lastHint = hint
  }
  emit()
}

/**
 * Commit a finished drag. The hint REPLAYED here is the last one painted, never a
 * fresh computation: tapping Alt after the final mouse move would otherwise make
 * the card jump on release and be classified from a position the user never saw.
 */
async function endDrag() {
  const drag = gDrag
  gDrag = null
  const clear = () => {
    for (const id of drag.ids) model.overlay.delete(id)
    model.guides = []
    model.dropHint = null
    model.dropTargetRegionId = null
    model.frozenMembers = null
    emit()
  }
  if (!drag.moved) {
    clear()
    return
  }
  const hint = drag.lastHint
  const source = drag.source
  const position = model.overlay.get(drag.primary) ?? drag.origin.get(drag.primary)
  /** Ids the drop is about to destroy — they must stay out of the move batch. */
  const swallowed = new Set()
  let followUp

  if (hint !== null && source !== null && hint.type === 'same') {
    // Back over its own region: the grid owns the slot, so nothing is written.
    clear()
    return
  }
  if (hint !== null && source !== null && hint.type === 'region') {
    if (source.kind === 'pin') swallowed.add(source.pinId)
    followUp = () =>
      groupCmd({
        targetRegionId: hint.regionId,
        memberIds: [source.sessionId],
        consumeNodeIds: source.kind === 'pin' ? [source.pinId] : [],
      })
  } else if (hint !== null && source !== null && hint.type === 'merge') {
    swallowed.add(hint.targetPinId)
    if (source.kind === 'pin') swallowed.add(source.pinId)
    followUp = () =>
      groupCmd({
        memberIds: [hint.targetSessionId, source.sessionId],
        consumeNodeIds:
          source.kind === 'pin' ? [hint.targetPinId, source.pinId] : [hint.targetPinId],
        gridColumns: 2,
        x: hint.rect.x,
        y: hint.rect.y,
        width: hint.rect.width,
        height: hint.rect.height,
      })
  } else if (source !== null && source.kind === 'member') {
    // Out of a region onto open board: a detach, positioned where the ghost was.
    followUp = () =>
      detachMemberCmd(source.regionId, source.sessionId, position.x, position.y)
  }

  // Whatever else moved in this gesture is a plain batched geometry write.
  const moves = []
  for (const id of drag.ids) {
    const nodeId = parseNodeElementId(id)
    if (nodeId === null || swallowed.has(nodeId)) continue
    const pos = model.overlay.get(id)
    if (pos === undefined) continue
    moves.push({ id: nodeId, x: pos.x, y: pos.y })
  }
  clear()
  if (moves.length > 0) await moveNodesCmd(moves)
  if (followUp !== undefined) await followUp()
}

/** Start a resize from one handle. */
function beginResize(surface, wrapper, handle, event) {
  const element = elementOf(wrapper.dataset.id)
  if (element === undefined) return false
  gResize = {
    elementId: element.id,
    nodeId: parseNodeElementId(element.id),
    type: element.type,
    dir: handle.dataset.dir,
    start: screenToBoard(gRect(surface), event.clientX, event.clientY),
    width: element.width,
    height: element.height,
    size: element.width,
  }
  return true
}

/** One resize frame. A region steps by whole cards; everything else is free. */
function moveResize(surface, event) {
  const point = screenToBoard(gRect(surface), event.clientX, event.clientY)
  const min = MIN_SIZE[gResize.type] ?? { width: MIN_NODE_SIZE, height: MIN_NODE_SIZE }
  let width = gResize.width
  let height = gResize.height
  if (gResize.dir !== 's') width = Math.max(min.width, gResize.width + (point.x - gResize.start.x))
  if (gResize.dir !== 'e') height = Math.max(min.height, gResize.height + (point.y - gResize.start.y))
  if (gResize.type === 'region') {
    // Quantize on the way IN, so the frame visibly steps one column / row at a
    // time and the committed grid shape can never disagree with the frame.
    width = regionWidthForColumns(columnsForRegionWidth(width))
    height = regionHeightForRows(rowsForRegionHeight(height))
  }
  model.sizeOverlay.set(gResize.elementId, { width, height })
  emit()
}

/** Commit a finished resize. */
async function endResize() {
  const resize = gResize
  gResize = null
  const live = model.sizeOverlay.get(resize.elementId)
  model.sizeOverlay.delete(resize.elementId)
  emit()
  if (live === undefined || resize.nodeId === null) return
  const patch = { width: live.width, height: live.height }
  if (resize.type === 'region') {
    // The resize IS a grid-shape change: without this the next render would
    // re-derive the columns from the width and the shape would drift.
    patch.gridColumns = columnsForRegionWidth(live.width)
    patch.gridRows = rowsForRegionHeight(live.height)
  }
  await patchNode(resize.nodeId, patch)
}

/** Commit a note's text, or a region's new name, and leave edit mode. */
function commitEditor(input) {
  const wrapper = input.closest('.dshc-node')
  const nodeId = wrapper === null ? null : parseNodeElementId(wrapper.dataset.id)
  if (nodeId === null) return
  const row = model.nodes.get(nodeId)
  if (row === undefined) return
  if (input.dataset.act === 'note-input') {
    model.editingNote = null
    if (input.value !== (row.content ?? '')) void patchNode(nodeId, { content: input.value })
    else emit()
    return
  }
  model.renaming = null
  const next = input.value.trim()
  if (next !== (row.title ?? '')) void patchNode(nodeId, { title: next })
  else emit()
}

/** Double-click: expand a card, rename a region, edit a note. */
function onDoubleClick(event) {
  const wrapper = event.target.closest('.dshc-node')
  if (wrapper === null) return
  const element = elementOf(wrapper.dataset.id)
  if (element === undefined) return
  if (element.type === 'note') {
    model.editingNote = element.nodeId
    emit()
    return
  }
  if (element.type === 'region') {
    if (event.target.closest('.dshc-rtitle') === null) return
    model.renaming = element.nodeId
    emit()
    return
  }
  if (element.type !== 'sessionCard' || element.unresolved) return
  if (element.regionId !== undefined) {
    // A member cannot expand in place, so it is detached first and parked beside
    // the region it came from.
    const region = model.nodes.get(element.regionId)
    const size = model.board?.renderedSizes.get(element.regionId)
    void detachMemberCmd(
      element.regionId,
      element.sessionId,
      (region?.x ?? 0) + (size?.width ?? 0) + 32,
      region?.y ?? 0,
      { expand: true }
    )
    return
  }
  setCardDetail(element.nodeId, true)
}

/** Delegated clicks on node chrome. */
function onBoardClick(event) {
  const act = event.target.closest('[data-act]')
  if (act === null) return
  const wrapper = act.closest('.dshc-node')
  const element = wrapper === null ? undefined : elementOf(wrapper.dataset.id)
  if (element === undefined) return
  if (act.dataset.act === 'more') {
    setRegionExpanded(element.nodeId, true)
    return
  }
  if (act.dataset.act === 'collapse-card') {
    setCardDetail(element.nodeId, false)
    return
  }
  if (act.dataset.act === 'open') openInGui(element.sessionId)
}

/** Select every element on the board. */
function selectAll() {
  model.selected.clear()
  for (const element of model.board?.elements ?? []) model.selected.add(element.id)
  emit()
}

/** Rename the one selected region, if that is what the selection is. */
function renameSelected() {
  const ids = selectedTopLevel()
  if (ids.length !== 1 || model.selected.size !== 1) return
  const nodeId = parseNodeElementId(ids[0])
  const row = model.nodes.get(nodeId)
  if (row === undefined || !isRegionKind(row.kind)) return
  model.renaming = nodeId
  emit()
}

/**
 * Wire every gesture to one surface. Returns the disposer.
 *
 * Pointer bookkeeping is on `window` in the capture phase for the same reason
 * codeg-plus does it: a release outside the window, or over a node that stops
 * propagation, must still end the gesture.
 */
export function installInteractions(refs) {
  const { surface, board } = refs
  const off = []
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    off.push(() => target.removeEventListener(type, handler, options))
  }

  // ── pan: right-drag and middle-drag ──
  on(
    surface,
    'mousedown',
    (event) => {
      if (event.button !== 1 && event.button !== 2) return
      if (event.target.closest(CHROME) !== null) return
      event.preventDefault()
      event.stopPropagation()
      gPan = {
        x: event.clientX,
        y: event.clientY,
        vx: model.viewport.x,
        vy: model.viewport.y,
      }
      surface.dataset.panning = 'true'
    },
    true
  )
  // Right-DOWN opens the OS menu on some platforms and would race the pan, so the
  // menu is suppressed in the capture phase — nothing below can open one either.
  on(surface, 'contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
  }, true)

  // ── wheel: pan, or zoom about the pointer with a modifier / pinch ──
  on(
    surface,
    'wheel',
    (event) => {
      if (event.target.closest(CHROME) !== null) return
      // A card's own transcript scrolls itself; the board must not eat it.
      if (event.target.closest('.dshc-dbody, .dshc-nedit') !== null) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomAbout(gRect(surface), event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 1 / 1.1)
        return
      }
      setViewport({
        x: model.viewport.x - event.deltaX,
        y: model.viewport.y - event.deltaY,
      })
    },
    { passive: false }
  )

  // ── left press: node drag, resize, or marquee ──
  on(surface, 'mousedown', (event) => {
    if (event.button !== 0) return
    if (event.target.closest(CHROME) !== null) return
    if (event.target.matches('.dshc-nedit, .dshc-rname-input')) return
    const handle = event.target.closest('.dshc-handle')
    const wrapper = event.target.closest('.dshc-node')
    if (handle !== null && wrapper !== null) {
      event.preventDefault()
      beginResize(surface, wrapper, handle, event)
      return
    }
    if (wrapper !== null) {
      if (event.target.closest('[data-act]') !== null) return
      if (beginDrag(surface, wrapper, event)) event.preventDefault()
      return
    }
    // Blank board: a marquee, and the text guard that keeps it from painting a
    // selection across every label it sweeps.
    guardTextSelection(surface, event)
    const start = screenToBoard(gRect(surface), event.clientX, event.clientY)
    // Any of the three multi-select modifiers adds to what is already selected,
    // matching codeg-plus's `multiSelectionKeyCode`.
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    gMarquee = { start, base: additive ? new Set(model.selected) : new Set() }
    model.marquee = { ...start, width: 0, height: 0 }
    model.selected = new Set(gMarquee.base)
    emit()
  })

  // ── the shared move / release loop ──
  on(
    window,
    'mousemove',
    (event) => {
      if (gPan !== null) {
        // A release that happened outside the window leaves no button down.
        if ((event.buttons & 6) === 0) {
          endPan()
          return
        }
        setViewport({
          x: gPan.vx + (event.clientX - gPan.x),
          y: gPan.vy + (event.clientY - gPan.y),
        })
        return
      }
      if (gResize !== null) {
        // Same reason the other gestures check: a release outside the window
        // delivers no mouseup, and a resize that cannot be ended keeps growing
        // the node with no button held.
        if ((event.buttons & 1) === 0) {
          void endResize()
          return
        }
        moveResize(surface, event)
        return
      }
      if (gDrag !== null) {
        if ((event.buttons & 1) === 0) {
          void endDrag()
          return
        }
        moveDrag(surface, event)
        return
      }
      if (gMarquee !== null) {
        if ((event.buttons & 1) === 0) {
          endMarquee(surface)
          return
        }
        const point = screenToBoard(gRect(surface), event.clientX, event.clientY)
        const box = rectOf(gMarquee.start, point)
        model.marquee = box
        // Partial intersection, like codeg-plus: touching counts.
        const selected = new Set(gMarquee.base)
        for (const element of model.board?.elements ?? []) {
          const rect = { ...element.position, width: element.width, height: element.height }
          if (intersects(box, rect)) selected.add(element.id)
        }
        model.selected = selected
        emit()
      }
    },
    true
  )

  const endPan = () => {
    if (gPan === null) return
    gPan = null
    delete surface.dataset.panning
    flushViewportSave()
  }
  const endMarquee = () => {
    if (gMarquee === null) return
    gMarquee = null
    model.marquee = null
    delete surface.dataset.marquee
    emit()
  }

  on(
    window,
    'mouseup',
    (event) => {
      endPan()
      if (gResize !== null) void endResize()
      if (gDrag !== null) void endDrag()
      // Only the left button's release disarms the marquee: a chorded right-click
      // release must not re-enable text selection mid-sweep.
      if (event.button === 0) endMarquee()
    },
    true
  )
  on(window, 'blur', () => {
    endPan()
    endMarquee()
    gAlt = false
    if (gDrag !== null) void endDrag()
    if (gResize !== null) void endResize()
  })

  // ── clicks, double clicks, editors ──
  on(board, 'click', onBoardClick)
  on(board, 'dblclick', onDoubleClick)
  on(board, 'focusout', (event) => {
    if (event.target.matches('.dshc-nedit, .dshc-rname-input')) commitEditor(event.target)
  })
  on(board, 'keydown', (event) => {
    const input = event.target
    if (input.matches('.dshc-nedit')) {
      // Every key stays inside the note: Delete must edit the text, not delete the
      // node it is typed into.
      event.stopPropagation()
      if (event.key === 'Escape') input.blur()
      return
    }
    if (!input.matches('.dshc-rname-input')) return
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEditor(input)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      model.renaming = null
      emit()
    }
  })

  // ── keyboard ──
  //
  // Capture phase on window: dsh's own shortcuts listen further down, and the
  // board has to be able to claim a chord (Cmd+A, Delete) while it is open.
  on(
    window,
    'keydown',
    (event) => {
      if (!model.open) return
      if (event.key === 'Alt' || event.altKey) gAlt = event.altKey
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      }
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        event.stopPropagation()
        selectAll()
        return
      }
      if (meta && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        event.stopPropagation()
        void groupSelection()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (model.selected.size === 0) return
        event.preventDefault()
        event.stopPropagation()
        requestDelete()
        return
      }
      if (event.key === 'F2' || (event.key === 'Enter' && !meta)) {
        if (event.key === 'Enter' && target instanceof HTMLElement && target.closest('button, a, [role="button"]') !== null) {
          return
        }
        if (model.selected.size !== 1) return
        event.preventDefault()
        renameSelected()
        return
      }
      if (event.key === 'Escape') {
        if (model.renaming !== null || model.editingNote !== null) {
          model.renaming = null
          model.editingNote = null
          emit()
          return
        }
        if (model.selected.size > 0) {
          event.stopPropagation()
          selectOnly(undefined)
        }
      }
    },
    true
  )
  on(window, 'keyup', (event) => {
    if (event.key === 'Alt') gAlt = false
  })

  return () => {
    for (const dispose of off.splice(0)) dispose()
    gPan = null
    gDrag = null
    gResize = null
    gMarquee = null
    gAlt = false
    model.overlay.clear()
    model.sizeOverlay.clear()
    model.guides = []
    model.marquee = null
    model.dropHint = null
    model.dropTargetRegionId = null
    model.frozenMembers = null
  }
}
