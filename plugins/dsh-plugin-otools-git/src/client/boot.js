/**
 * Boot: mount the seats, wire the listeners, and export the plugin shape.
 *
 * Failure policy mirrors the sibling plugins: DOM and panel problems are logged,
 * never thrown — the web shell must not fail its boot because a panel seat is
 * missing on some DSH layout.
 */
const bootState = { running: false }

/** DSH web-shell entry: mount the sidebar entry + panel view, then listen. */
function apply(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (bootState.running) return
  bootState.running = true
  const state = { disposed: false }
  let observer = null
  let timer = null
  let unbindModel = null
  let onActivate = null
  let onDocClick = null
  let onKeyDown = null

  function ensureMounted() {
    if (state.disposed) return
    try {
      if (entryEl === null || !entryEl.isConnected) entryEl = createEntry()
      placeEntry()
      if (conversationColumn() !== undefined) ensureView()
    } catch (error) {
      console.warn(LOG + ' seat mount failed:', messageOf(error))
    }
  }

  function dispose() {
    if (state.disposed) return
    state.disposed = true
    if (timer !== null) clearInterval(timer)
    if (observer !== null) {
      try {
        observer.disconnect()
      } catch { /* already gone */ }
    }
    if (onActivate !== null) document.removeEventListener(ACTIVATE_EVENT, onActivate)
    if (onDocClick !== null) document.removeEventListener('click', onDocClick, true)
    if (onKeyDown !== null) document.removeEventListener('keydown', onKeyDown)
    if (unbindModel !== null) unbindModel()
    closeAllOverlays()
    closeMenu()
    stopSse()
    document.documentElement.removeAttribute(OPEN_ATTR)
    model.open = false
    model.connected = false
    dataBooted = false
    resetRepoState()
    if (entryEl !== null) {
      try {
        entryEl.remove()
      } catch { /* already gone */ }
      entryEl = null
    }
    if (viewEl !== null) {
      try {
        viewEl.remove()
      } catch { /* already gone */ }
      viewEl = null
    }
    panelEl = null
    sideEl = null
    toolbarEl = null
    bodyEl = null
    statusbarEl = null
    const style = document.getElementById(STYLE_ID)
    if (style !== null) style.remove()
    bootState.running = false
  }

  try {
    injectStyles()
    unbindModel = onModel(() => {
      try {
        renderPanel()
      } catch (error) {
        console.error(LOG + ' render failed:', messageOf(error))
      }
    })
    ensureMounted()
    renderEntry()
    startSse(applyOperationToUi)
    // The DSH shell re-renders its own tree; both a mutation observer and a slow
    // interval keep the seats attached across those repaints.
    observer = new MutationObserver(() => ensureMounted())
    observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
    timer = setInterval(() => ensureMounted(), 3000)

    onActivate = (event) => {
      if (state.disposed) return
      if (event.detail !== undefined && event.detail !== PANEL_NAME && model.open) setOpen(false)
    }
    onDocClick = (event) => {
      if (state.disposed) return
      const target = event.target
      if (!(target instanceof Element)) return
      // A click anywhere outside an open menu closes it, but must not reach the
      // menu's own item handler.
      if (target.closest('.dsh-og-menu') === null) closeMenu()
    }
    onKeyDown = (event) => {
      if (state.disposed) return
      if (event.key === 'Escape') {
        if (closeTopOverlay()) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (!model.open) return
      // Ctrl/Cmd+R refreshes the panel rather than the page, which is what a
      // user pressing it while looking at a git panel means.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r' && overlays.length === 0) {
        event.preventDefault()
        void refreshTab()
      }
    }
    document.addEventListener(ACTIVATE_EVENT, onActivate)
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKeyDown)

    if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, PLUGIN_ID + ': client mount')
    } else {
      window.addEventListener('beforeunload', dispose, { once: true })
    }
  } catch (error) {
    console.error(LOG + ' client boot failed:', messageOf(error))
    dispose()
  }
}

/** Close the topmost overlay (menu first, then dialog). Returns whether it did. */
function closeTopOverlay() {
  if (openMenu !== null) {
    closeMenu()
    return true
  }
  if (overlays.length > 0) {
    overlays[overlays.length - 1].close()
    return true
  }
  return false
}

// ---------------------------------------------------------------- export
// The wrap step evaluates this file inside window.__ModuleLoader__.load with
// a CommonJS `module` in scope; a plain Node require() gets the same shape.
if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
  module.exports = {
    name: PLUGIN_ID + '/client',
    inject: [],
    apply,
  }
}
