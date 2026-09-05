/**
 * The dock, the corner controls, the menus and the one confirmation dialog.
 *
 * Every verb the board has lives here, driven by the selection — the same
 * consolidation codeg-plus settled on after trying per-node hover menus, region
 * header dropdowns and note corner buttons: one place to look, and nothing that
 * covers the board while you work.
 *
 * @module dsh-plugin-canvas/client/dock
 */

/** The open floating menu, if any, and the outside-press listener that closes it. */
let gMenu = null
let gDismiss = null

function closeMenu() {
  if (gDismiss !== null) {
    document.removeEventListener('mousedown', gDismiss, true)
    gDismiss = null
  }
  if (gMenu === null) return
  gMenu.remove()
  gMenu = null
}

/**
 * Open a floating menu anchored above an element.
 *
 * The anchor's box is measured BEFORE anything closes: a submenu is opened from
 * inside a menu item, and `menuItem` closes its own menu first — measuring a
 * detached anchor would report all zeros and park every submenu in the window's
 * top-left corner.
 */
function openMenu(anchor, build) {
  const box = anchor.getBoundingClientRect()
  closeMenu()
  const menu = el('div', 'dshc-menu')
  build(menu, closeMenu)
  document.body.append(menu)
  const size = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - size.width - 8))}px`
  menu.style.top = `${Math.max(8, box.top - size.height - 6)}px`
  gMenu = menu
  // The listener belongs to THIS menu: leaking it would let a closed menu's
  // handler dismiss its successor on mousedown, and the click that followed
  // would land on a detached node and do nothing at all.
  gDismiss = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return
    closeMenu()
  }
  document.addEventListener('mousedown', gDismiss, true)
  return menu
}

function menuItem(menu, label, onClick, options = {}) {
  const item = el('button', 'dshc-mitem')
  item.type = 'button'
  item.append(el('span', undefined, options.glyph ?? ''), el('span', undefined, label))
  if (options.sub !== undefined) item.append(el('span', 'dshc-msub', options.sub))
  if (options.danger === true) item.dataset.danger = 'true'
  item.addEventListener('click', () => {
    closeMenu()
    onClick()
  })
  menu.append(item)
  return item
}

/** The twelve-swatch palette. Re-picking the active colour clears it — there is
 *  no separate "none" swatch, exactly as in codeg-plus. */
function buildPalette(menu, current, onPick) {
  const grid = el('div', 'dshc-swatches')
  for (const name of THEME_COLORS) {
    const swatch = el('button', 'dshc-swatch')
    swatch.type = 'button'
    swatch.title = name
    swatch.setAttribute('aria-label', name)
    swatch.style.backgroundColor = colorOf(name)
    if (current === name) swatch.dataset.active = 'true'
    swatch.addEventListener('click', () => {
      closeMenu()
      onPick(current === name ? '' : name)
    })
    grid.append(swatch)
  }
  menu.append(grid)
}

/** The grid picker: auto plus one through six, on both axes. Each choice writes
 *  the shape AND the matching frame size in one patch, so stored geometry can
 *  never drift from the shape. */
function buildGridMenu(menu, row) {
  const axis = (label, key) => {
    menu.append(el('div', 'dshc-mlabel', label))
    const cells = el('div', 'dshc-cells')
    const values = [0, 1, 2, 3, 4, 5, 6]
    for (const value of values) {
      const cell = el('button', 'dshc-cell')
      cell.type = 'button'
      cell.textContent = value === 0 ? L.gridAuto : String(value)
      if ((key === 'gridColumns' ? row.gridColumns : row.gridRows) === value) {
        cell.dataset.active = 'true'
      }
      cell.addEventListener('click', () => {
        closeMenu()
        const patch = { [key]: value }
        if (value > 0) {
          patch[key === 'gridColumns' ? 'width' : 'height'] =
            key === 'gridColumns' ? regionWidthForColumns(value) : regionHeightForRows(value)
        }
        void patchNode(row.id, patch)
      })
      cells.append(cell)
    }
    menu.append(cells)
  }
  axis(L.gridColumns, 'gridColumns')
  axis(L.gridRows, 'gridRows')
}

/** Where a menu-created node lands: the middle of the view, minus half its own
 *  footprint, plus a little jitter so two adds in a row don't stack. */
function dropPoint(rect, width, height) {
  const centre = screenToBoard(rect, rect.left + rect.width / 2, rect.top + rect.height / 2)
  return {
    x: Math.round(centre.x - width / 2 + (Math.random() * 64 - 32)),
    y: Math.round(centre.y - height / 2 + (Math.random() * 64 - 32)),
  }
}

/** The "+" menu: one entry per node kind, with a submenu where a binding has to
 *  be chosen. */
function buildAddMenu(menu, rect) {
  const addRegion = (kind, extra) => {
    const at = dropPoint(rect, REGION_DEFAULT_WIDTH, REGION_DEFAULT_HEIGHT)
    void createNode({
      kind,
      ...extra,
      ...at,
      width: REGION_DEFAULT_WIDTH,
      height: REGION_DEFAULT_HEIGHT,
      gridColumns: 3,
      gridRows: 2,
    })
  }
  menuItem(menu, L.newSession, () => {
    openMenu(menu, (sub) => {
      if (model.workspaces.length === 0) {
        sub.append(el('div', 'dshc-mlabel', L.noWorkspaces))
        return
      }
      sub.append(el('div', 'dshc-mlabel', L.newSessionIn))
      for (const workspace of model.workspaces) {
        menuItem(sub, workspace.title, () => {
          void createSession({
            workspaceId: workspace.id,
            at: dropPoint(rect, CARD_WIDTH, CARD_HEIGHT),
          })
        }, { glyph: '📁' })
      }
    })
  }, { glyph: '✚' })
  menuItem(menu, L.addWorkspaceRegion, () => {
    openMenu(menu, (sub) => {
      if (model.workspaces.length === 0) {
        sub.append(el('div', 'dshc-mlabel', L.noWorkspaces))
        return
      }
      for (const workspace of model.workspaces) {
        menuItem(sub, workspace.title, () => addRegion('workspace', { workspace: workspace.id }), {
          glyph: '📁',
          sub: String(workspace.sessionIds.length),
        })
      }
    })
  }, { glyph: '📁' })
  menuItem(menu, L.addAgentRegion, () => {
    openMenu(menu, (sub) => {
      if (model.agents.length === 0) {
        sub.append(el('div', 'dshc-mlabel', L.noAgents))
        return
      }
      for (const agent of model.agents) {
        menuItem(sub, agent.name, () => addRegion('agent', { agentType: agent.id }), { glyph: '🤖' })
      }
    })
  }, { glyph: '🤖' })
  menuItem(menu, L.addSessionCard, () => {
    openMenu(menu, (sub) => {
      const search = el('input', 'dshc-msearch')
      search.placeholder = L.searchSessions
      // The menu must not treat typing as navigation.
      search.addEventListener('keydown', (event) => event.stopPropagation())
      const list = el('div')
      const paint = () => {
        list.textContent = ''
        const needle = search.value.trim().toLowerCase()
        const rows = model.sessions
          .filter((s) => isCanvasEligible(s))
          .filter((s) => needle === '' || sessionTitle(s).toLowerCase().includes(needle))
          .slice(0, 15)
        if (rows.length === 0) {
          list.append(el('div', 'dshc-mlabel', L.noSessions))
          return
        }
        for (const session of rows) {
          menuItem(
            list,
            sessionTitle(session),
            () => {
              const at = dropPoint(rect, CARD_WIDTH, CARD_HEIGHT)
              void createNode({ kind: 'session', sessionId: session.id, ...at })
            },
            { glyph: '💬', sub: workspaceLabel(session) }
          )
        }
      }
      search.addEventListener('input', paint)
      sub.append(search, list)
      paint()
      setTimeout(() => search.focus(), 0)
    })
  }, { glyph: '💬' })
  menuItem(menu, L.addCustomRegion, () => addRegion('custom'), { glyph: '✨' })
  menuItem(
    menu,
    L.addNote,
    () => {
      const at = dropPoint(rect, NOTE_WIDTH, NOTE_HEIGHT)
      void createNode({ kind: 'note', ...at, width: NOTE_WIDTH, height: NOTE_HEIGHT })
    },
    { glyph: '📝' }
  )
}

/** The view root, so the dialog and the toasts have somewhere to live. */
let gViewRoot = null

/**
 * Delete the selection, stopping to ask only when that would take prose the user
 * typed by hand.
 *
 * The board has no undo, so this is the one confirmation — and it is scoped to
 * notes on purpose: every other node is an ARRANGEMENT of something that lives
 * elsewhere. The closure is captured when asked, so the prompt and the deletion
 * can never describe different node sets.
 */
export function requestDelete() {
  const facts = selectionFacts()
  if (facts.count === 0) return
  const risky = notesAtRisk(facts.nodeIds)
  if (risky === 0 || gViewRoot === null) {
    void deleteSelection()
    return
  }
  const run = () => deleteSelection()
  const backdrop = el('div', 'dshc-modal')
  const dialog = el('div', 'dshc-dialog')
  dialog.append(
    el('h3', undefined, L.confirmDeleteTitle),
    el('p', undefined, L.confirmDeleteNotes(risky))
  )
  const row = el('div', 'dshc-dialog-row')
  const cancel = el('button', 'dshc-tbtn', L.confirmDeleteCancel)
  cancel.type = 'button'
  const confirm = el('button', 'dshc-tbtn', L.confirmDeleteConfirm)
  confirm.type = 'button'
  confirm.dataset.danger = 'true'
  cancel.addEventListener('click', () => backdrop.remove())
  confirm.addEventListener('click', () => {
    backdrop.remove()
    void run()
  })
  row.append(cancel, confirm)
  dialog.append(row)
  backdrop.append(dialog)
  gViewRoot.append(backdrop)
  confirm.focus()
}

/** One dock button. */
function dockButton(label, glyph, onClick, options = {}) {
  const button = el('button', 'dshc-btn', glyph)
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  if (options.danger === true) button.dataset.danger = 'true'
  if (options.pressed === true) button.dataset.pressed = 'true'
  if (options.disabled === true) button.disabled = true
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick(button)
  })
  return button
}

/** The selection's verbs — the right half of the dock. */
function selectionButtons(dock, rect) {
  const facts = selectionFacts()
  if (facts.count === 0) return
  dock.append(el('div', 'dshc-sep'))
  if (facts.count > 1) {
    dock.append(el('span', 'dshc-count', L.selectedCount(facts.count)))
    dock.append(
      dockButton(L.createRegionFromSelection, '✨', () => void groupSelection(), {
        disabled: facts.sessionIds.length === 0,
      })
    )
    dock.append(dockButton(L.deleteSelected, '🗑', () => requestDelete(), { danger: true }))
    return
  }
  const member = facts.members[0]
  const row = facts.rows[0]
  if (member !== undefined) {
    const region = model.nodes.get(member.regionId)
    dock.append(
      dockButton(L.expandSession, '⤢', () => {
        const size = model.board?.renderedSizes.get(member.regionId)
        void detachMemberCmd(
          member.regionId,
          member.sessionId,
          (region?.x ?? 0) + (size?.width ?? 0) + 32,
          region?.y ?? 0,
          { expand: true }
        )
      })
    )
    dock.append(dockButton(L.openInGui, '↗', () => openInGui(member.sessionId)))
    dock.append(
      dockButton(L.detachToCanvas, '⇱', () => {
        const size = model.board?.renderedSizes.get(member.regionId)
        void detachMemberCmd(
          member.regionId,
          member.sessionId,
          (region?.x ?? 0) + (size?.width ?? 0) + 32,
          region?.y ?? 0
        )
      })
    )
    // Only a custom region has a member list to remove from.
    if (region?.kind === 'custom') {
      dock.append(
        dockButton(
          L.removeFromRegion,
          '🗑',
          () => void patchNode(member.regionId, { memberRemove: member.sessionId }),
          { danger: true }
        )
      )
    }
    return
  }
  if (row === undefined) return
  buildRowButtons(dock, row, rect)
}

/** Verbs for one selected ledger row. */
function buildRowButtons(dock, row, rect) {
  const paletteButton = () =>
    dockButton(L.color, '🎨', (button) => {
      openMenu(button, (menu) => buildPalette(menu, row.color, (name) => patchNode(row.id, { color: name })))
    })
  if (isRegionKind(row.kind)) {
    const element = (model.board?.elements ?? []).find((e) => e.nodeId === row.id)
    dock.append(
      dockButton(L.rename, '✏', () => {
        model.renaming = row.id
        emit()
      })
    )
    dock.append(
      dockButton(row.collapsed ? L.expand : L.collapse, row.collapsed ? '⌄' : '⌃', () =>
        void patchNode(row.id, { collapsed: !row.collapsed })
      )
    )
    const expanded = model.expandedRegions.has(row.id)
    if (element !== undefined && (element.hiddenCount > 0 || expanded)) {
      dock.append(
        dockButton(expanded ? L.showFewerMembers : L.showAllMembers, expanded ? '⤡' : '⤢', () =>
          setRegionExpanded(row.id, !expanded)
        )
      )
    }
    dock.append(
      dockButton(L.grid, '▦', (button) => openMenu(button, (menu) => buildGridMenu(menu, row)))
    )
    dock.append(paletteButton())
    dock.append(dockButton(L.removeRegion, '🗑', () => requestDelete(), { danger: true }))
    return
  }
  if (row.kind === 'note') {
    dock.append(paletteButton())
    dock.append(dockButton(L.removeNote, '🗑', () => requestDelete(), { danger: true }))
    return
  }
  // A pinned session card, collapsed or expanded.
  const expanded = model.detailCards.has(row.id)
  const unresolved = !model.sessions.some((s) => s.id === row.sessionId)
  if (!unresolved) {
    dock.append(
      dockButton(expanded ? L.collapseSession : L.expandSession, expanded ? '⤡' : '⤢', () =>
        setCardDetail(row.id, !expanded)
      )
    )
    dock.append(dockButton(L.openInGui, '↗', () => openInGui(row.sessionId)))
    dock.append(paletteButton())
  }
  dock.append(dockButton(L.removeCard, '🗑', () => requestDelete(), { danger: true }))
}

/**
 * Build the chrome once and return the function that repaints it.
 *
 * The dock is rebuilt on every state change rather than diffed: it holds at most
 * a dozen buttons, and a stale verb on a changed selection is a worse bug than a
 * few DOM writes.
 */
export function buildChrome(refs) {
  const { view, surface } = refs
  gViewRoot = view
  const dock = el('div', 'dshc-dock')
  dock.setAttribute('role', 'toolbar')
  dock.setAttribute('aria-label', L.canvasActions)
  const corner = el('div', 'dshc-corner')
  const map = el('div', 'dshc-map')
  const zoom = el('div', 'dshc-zoom')
  zoom.setAttribute('role', 'toolbar')
  zoom.setAttribute('aria-label', L.viewportControls)
  corner.append(map, zoom)
  const empty = el('div', 'dshc-empty')
  const toasts = el('div', 'dshc-toasts')
  view.append(empty, dock, corner, toasts)

  map.addEventListener('mousedown', (event) => {
    // The map is a navigator: pressing anywhere in it centres the board there.
    event.stopPropagation()
    const point = minimapToBoard(map, event.clientX, event.clientY)
    if (point !== null) centerOn(surface.getBoundingClientRect(), point)
  })

  let seeding = false

  const paintEmpty = () => {
    const isEmpty = model.hydrated && model.nodes.size === 0
    empty.style.display = isEmpty ? '' : 'none'
    if (!isEmpty) return
    if (empty.dataset.built !== 'true') {
      empty.dataset.built = 'true'
      const button = el('button', 'dshc-cta')
      button.type = 'button'
      button.textContent = `✨ ${L.seedFromWorkspaces}`
      button.addEventListener('click', async () => {
        if (seeding) return
        seeding = true
        button.disabled = true
        try {
          await seedFromWorkspaces()
          fitView(surface.getBoundingClientRect(), model.board?.elements ?? [], { padding: 0.2 })
        } finally {
          seeding = false
        }
      })
      empty.append(
        el('div', undefined, '🗺'),
        el('h3', undefined, L.empty),
        el('p', undefined, L.emptyHint),
        button
      )
    }
    // Re-applied on every paint, never once at build time: /state is an in-memory
    // snapshot and lands well before the workspace view, so a one-shot assignment
    // would leave the CTA disabled for the rest of the visit.
    const cta = empty.querySelector('[class*="dshc-cta"]')
    if (cta !== null) cta.disabled = seeding || model.workspaces.length === 0
  }

  const paintDock = () => {
    const rect = surface.getBoundingClientRect()
    dock.textContent = ''
    dock.append(
      dockButton(L.addNode, '＋', (button) => openMenu(button, (menu) => buildAddMenu(menu, rect)))
    )
    dock.append(
      dockButton(L.fitView, '⛶', () => fitView(rect, model.board?.elements ?? [], { padding: 0.2 }))
    )
    dock.append(
      dockButton(L.autoArrange, '▤', () => void autoArrange(), { disabled: model.nodes.size === 0 })
    )
    selectionButtons(dock, rect)
    // Reserve the corner stack so the dock wraps instead of sliding under it.
    dock.style.maxWidth = `${Math.max(144, rect.width - 220)}px`
  }

  const paintZoom = () => {
    const percent = Math.round(model.viewport.zoom * 100)
    zoom.textContent = ''
    zoom.append(
      dockButton(model.minimap ? L.hideMinimap : L.showMinimap, '🗺', () => {
        model.minimap = !model.minimap
        saveMinimap()
        emit()
      }, { pressed: model.minimap })
    )
    zoom.append(el('div', 'dshc-sep'))
    const rect = surface.getBoundingClientRect()
    zoom.append(
      dockButton(L.zoomOut, '－', () => zoomByStep(rect, -1), {
        disabled: model.viewport.zoom <= MIN_ZOOM + 0.001,
      })
    )
    const pct = dockButton(L.resetZoom, `${percent}%`, () => resetZoom(rect))
    pct.classList.add('dshc-pct')
    zoom.append(pct)
    zoom.append(
      dockButton(L.zoomIn, '＋', () => zoomByStep(rect, 1), {
        disabled: model.viewport.zoom >= MAX_ZOOM - 0.001,
      })
    )
    map.style.display = model.minimap ? '' : 'none'
  }

  const paintToasts = () => {
    toasts.textContent = ''
    for (const entry of model.toasts) toasts.append(el('div', 'dshc-toast', entry.message))
  }

  /** The marquee rectangle, in screen space over the surface. */
  const paintMarquee = () => {
    let box = surface.querySelector(':scope > .dshc-marquee')
    if (model.marquee === null) {
      if (box !== null) box.remove()
      return
    }
    if (box === null) {
      box = el('div', 'dshc-marquee')
      surface.append(box)
    }
    const topLeft = boardToScreen(model.marquee)
    box.style.left = `${topLeft.x}px`
    box.style.top = `${topLeft.y}px`
    box.style.width = `${model.marquee.width * model.viewport.zoom}px`
    box.style.height = `${model.marquee.height * model.viewport.zoom}px`
  }

  return function paintChrome() {
    paintEmpty()
    paintDock()
    paintZoom()
    paintToasts()
    paintMarquee()
    if (model.minimap) {
      renderMinimap(map, model.board?.elements ?? [], surface.getBoundingClientRect())
    }
  }
}

/** Close whatever menu is open (a teardown, or a click elsewhere). */
export function closeMenus() {
  closeMenu()
}
