/**
 * Browser entry for dsh-plugin-canvas: find a seat in the dsh web GUI, mount the
 * board, and keep it alive across the host app's re-renders.
 *
 * Export shape: `name` / `inject` / `apply` (no default export). The build wraps
 * this file — and every `src/shared` and `src/client` module — into the dsh
 * loader shape (`window.__ModuleLoader__.load`), which provides a CommonJS
 * `module`, so this file assigns `module.exports` when one is present and is
 * otherwise inert.
 *
 * Seat strategy, inherited from the taskboard plugin: dsh's GUI is a compiled
 * React app with build-hashed class names, so the entry button and the board go in
 * by DOM selector with several generations' worth of fallbacks, and a
 * MutationObserver plus a slow interval puts them back whenever the host
 * re-renders the column out from under them.
 *
 * `inject` stays EMPTY on purpose: the web shell fails the whole page boot if any
 * client entry never reaches `active`, so a service this board merely prefers must
 * be requested through a child `ctx.inject` inside apply, never here.
 *
 * @module dsh-plugin-canvas/client
 */
;(function () {
  'use strict'

  const ENTRY_SELECTOR = '[data-dshc-entry]'
  const VIEW_SELECTOR = '[data-dshc-view]'
  const SIDEBAR_SELECTOR =
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
  const CONVERSATION_SELECTOR =
    '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
  /** Sibling plugins listen for this to step aside when another panel opens. */
  const ACTIVATE_EVENT = 'dsh-panel-activate'
  const OPEN_ATTR = 'data-dshc-open'
  const OTHER_OPEN_ATTRS = ['data-dsh-cgtb-open', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']

  let entry = null
  let view = null
  let surface = null
  let boardEl = null
  let paintChrome = null
  let disposeInteractions = null
  let frame = null

  function injectStyles() {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLES
    document.head.append(style)
  }

  function sidebarRoot() {
    const column = document.querySelector(SIDEBAR_SELECTOR)
    if (column === null) return undefined
    const logoRow = column.querySelector('[class*="logoRow"]')
    // The column itself is the last resort: an empty sidebar (or a generation
    // that dropped the logo row) must still get an entry rather than none.
    return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) ?? column
  }

  function createEntry() {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshcEntry = ''
    button.className = 'dshc-entry'
    button.setAttribute('aria-label', L.title)
    button.append(
      el('span', 'dshc-entry-icon', '🗺'),
      el('span', 'dshc-entry-label', L.title),
      el('span', 'dshc-entry-stats')
    )
    button.addEventListener('click', () => setOpen(!model.open))
    return button
  }

  /** Put the entry next to the New Session family block. */
  function placeEntry() {
    if (entry === null) return
    const root = sidebarRoot()
    if (root === undefined || !root.isConnected) return
    if (entry.parentElement === root) return
    const family = [...root.children].filter(
      (child) => child instanceof HTMLElement && child.matches('[data-dsh-cgtb-entry], [data-dshc-entry]')
    )
    if (family.length > 0) root.insertBefore(entry, family[0])
    else root.append(entry)
  }

  /** Build the board view once, inside the conversation column. */
  function ensureView() {
    const column = document.querySelector(CONVERSATION_SELECTOR)
    if (column === null) return
    if (view !== null && view.parentElement === column) return
    if (view === null) {
      view = el('div', 'dshc-view')
      view.dataset.dshcView = ''
      surface = el('div', 'dshc-surface')
      boardEl = el('div', 'dshc-board')
      surface.append(boardEl)
      view.append(surface)
      paintChrome = buildChrome({ view, surface })
      disposeInteractions = installInteractions({ surface, board: boardEl })
    }
    // The overlay is positioned against the column, which the host app does not
    // guarantee is a containing block.
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative'
    column.append(view)
    view.dataset.open = String(model.open)
  }

  /** Derive the board and paint everything that depends on it. */
  function render() {
    if (view === null || surface === null || boardEl === null) return
    view.dataset.open = String(model.open)
    if (entry !== null) {
      entry.dataset.active = String(model.open)
      const stats = entry.querySelector('.dshc-entry-stats')
      if (stats !== null) stats.textContent = model.nodes.size === 0 ? '' : String(model.nodes.size)
    }
    if (!model.open) return
    model.board = deriveBoard({
      nodes: model.nodes.values(),
      sessions: model.sessions,
      workspaces: new Set(model.workspaces.map((w) => w.id)),
      expandedRegions: model.expandedRegions,
      overlay: model.overlay,
      frozenMembers: model.frozenMembers,
      sizeOverlay: model.sizeOverlay,
      detailCards: model.detailCards,
    })
    // Drop selected ids the board no longer derives — a member another client
    // removed, a pruned card. Leaving them in would keep the dock offering verbs
    // for something that is not there, and hand a group gesture a frame it cannot
    // measure. Skipped mid-gesture: a dragged member is deliberately absent from
    // its own region's grid for a frame or two.
    if (gestureIdle() && model.selected.size > 0) {
      const live = new Set(model.board.elements.map((e) => e.id))
      for (const id of [...model.selected]) if (!live.has(id)) model.selected.delete(id)
    }
    applyViewport(surface, boardEl)
    renderBoard(boardEl, model.board)
    if (paintChrome !== null) paintChrome()
  }

  /** Coalesce a burst of state changes into one paint. */
  function schedule() {
    if (frame !== null) return
    frame = window.requestAnimationFrame(() => {
      frame = null
      try {
        render()
      } catch (error) {
        console.error('[dsh-plugin-canvas] render failed:', error?.message ?? error)
      }
    })
  }

  let fitted = false

  /** Open or close the board. Data flows only while it is open: the canvas is a
   *  place you go, and an idle event stream buys nothing. */
  function setOpen(open) {
    model.open = open
    if (open) {
      document.documentElement.setAttribute(OPEN_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PLUGIN_ID }))
      ensureView()
      startStream()
      void refetchSessions(true)
      void refetchState().then(() => {
        loadOpenTranscripts()
        // Paint before measuring: fit-view reads the DERIVED element boxes, and
        // the queued frame has not run yet — fitting against the previous board
        // (empty, on a first open) would frame nothing.
        render()
        if (fitted || model.restoredViewport === true || surface === null) return
        fitted = true
        fitView(surface.getBoundingClientRect(), model.board?.elements ?? [], { padding: 0.2 })
      })
    } else {
      document.documentElement.removeAttribute(OPEN_ATTR)
      stopStream()
      closeMenus()
      flushViewportSave()
    }
    schedule()
  }

  /** dsh web-shell entry point. */
  function apply(ctx) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const state = { disposed: false }
    let observer = null
    let timer = null
    let unsubscribe = null
    let onActivate = null

    function ensureMounted() {
      if (state.disposed) return
      try {
        if (entry === null) entry = createEntry()
        placeEntry()
        ensureView()
      } catch (error) {
        console.warn('[dsh-plugin-canvas] seat mount failed:', error?.message ?? error)
      }
    }

    function dispose() {
      if (state.disposed) return
      state.disposed = true
      if (timer !== null) clearInterval(timer)
      if (observer !== null) observer.disconnect()
      if (onActivate !== null) document.removeEventListener(ACTIVATE_EVENT, onActivate)
      if (unsubscribe !== null) unsubscribe()
      if (disposeInteractions !== null) disposeInteractions()
      closeMenus()
      stopStream()
      flushViewportSave()
      resetRender()
      document.documentElement.removeAttribute(OPEN_ATTR)
      if (entry !== null) entry.remove()
      if (view !== null) view.remove()
      entry = null
      view = null
      surface = null
      boardEl = null
      paintChrome = null
      disposeInteractions = null
      model.open = false
      model.nodes = new Map()
      model.revision = 0
      model.hydrated = false
      document.getElementById(STYLE_ID)?.remove()
    }

    try {
      injectStyles()
      loadViewState()
      unsubscribe = subscribe(schedule)
      ensureMounted()
      schedule()

      // The host app re-renders its columns freely; the seats have to come back.
      observer = new MutationObserver(() => ensureMounted())
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
      timer = setInterval(() => ensureMounted(), 3000)

      onActivate = (event) => {
        if (state.disposed) return
        if (event.detail !== undefined && event.detail !== PLUGIN_ID && model.open) setOpen(false)
      }
      document.addEventListener(ACTIVATE_EVENT, onActivate)
      for (const attr of OTHER_OPEN_ATTRS) document.documentElement.removeAttribute(attr)

      // Navigation is the ONE thing the board cannot do itself: `ctx.sessions` is
      // the GUI's own session service (`open(id)` selects a session — there is no
      // URL to link to). Requested through a CHILD fiber so an assembly without it
      // leaves the board working, minus the "open in the session view" button.
      if (ctx !== undefined && ctx !== null && typeof ctx.inject === 'function') {
        ctx.inject(['sessions'], (sessionCtx) => {
          model.host = {
            openSession: (id) => sessionCtx.sessions.open(id),
          }
          return () => {
            model.host = undefined
          }
        })
      }

      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, 'dsh-plugin-canvas: client mount')
      } else {
        window.addEventListener('beforeunload', dispose, { once: true })
      }
    } catch (error) {
      console.error('[dsh-plugin-canvas] client boot failed:', error?.message ?? error)
      dispose()
    }
  }

  // The wrap step evaluates this file inside window.__ModuleLoader__.load with a
  // CommonJS `module` in scope; a plain Node require() sees the same shape.
  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = {
      name: `${PLUGIN_ID}/client`,
      inject: [],
      apply,
    }
  }
})()
