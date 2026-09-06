/**
 * The browser half: a sidebar entry, and a full-page panel that hosts the app.
 *
 * Like the 鲨鱼数据库 plugin in this repo, and unlike the hand-drawn panels, the UI here is
 * NOT painted by this bundle. The reference app's interface is 33k lines of React and the
 * brief was to reproduce it — so that app is copied verbatim, built by Vite into
 * `lib/webview/`, served by the host half at `/dsh-plugin-ai-switch/app/`, and shown in a
 * same-origin iframe. This file is the ~350 lines that get it on screen and keep it in step
 * with the shell: language, light/dark, and "another panel just opened, stand down".
 *
 * The iframe is created on FIRST OPEN, never at boot. The app is several megabytes of JS
 * (React, three.js for the Vibe cockpit, xterm); someone who never clicks the icon should
 * not pay for it.
 *
 * Failure policy matches the sibling plugins: DOM problems are logged, never thrown — the
 * web shell fails its whole boot if a client entry does not activate.
 */
(function () {
  'use strict'

  const PLUGIN_ID = 'dsh-plugin-ai-switch'
  const ROUTE_PREFIX = '/' + PLUGIN_ID
  const APP_PATH = ROUTE_PREFIX + '/app/'
  const STYLE_ID = PLUGIN_ID + '-style'
  const PANEL_NAME = PLUGIN_ID
  const ACTIVATE_EVENT = 'dsh-panel-activate'
  const OPEN_ATTR = 'data-dsh-ai-switch-open'
  const ENTRY_ATTR = 'data-dsh-ai-switch-entry'
  const VIEW_ATTR = 'data-dsh-ai-switch-view'
  const LOG = '[' + PLUGIN_ID + ']'

  /** Seats in the DSH shell, across the layout generations it has shipped. */
  const CONVERSATION_SELECTOR =
    '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
  const SIDEBAR_SELECTOR =
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
  /** Sibling panel plugins: entries stay grouped and only one panel is open at a time. */
  const SIBLING_ENTRIES =
    '[data-dsh-cgtb-entry], [data-dsh-taskboard-entry], [data-dsh-repopanel-entry],'
    + ' [data-dsh-ssh-entry], [data-dsh-otools-git-entry], [data-dsh-automation-entry],'
    + ' [data-dsh-otools-dbm-entry]'

  const LABELS = {
    zh: { entry: 'AI 切换', title: 'AI Switch 账号与路由', failed: '面板加载失败，请刷新页面重试。' },
    en: { entry: 'AI Switch', title: 'AI Switch accounts and routing', failed: 'The panel failed to load. Reload the page to try again.' },
  }

  const STYLES = `
.dsh-ais-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-text-secondary, #7f8fa4));
  font: inherit; font-size: 13px; cursor: pointer; text-align: left; box-sizing: border-box;
}
.dsh-ais-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-hover, rgba(128, 128, 128, .12)));
  color: var(--dsw-alias-label-primary, var(--dsw-text-primary, inherit));
}
.dsh-ais-entry[data-active="true"] {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-active, rgba(128, 128, 128, .18)));
  color: var(--dsw-alias-label-primary, var(--dsw-text-primary, inherit)); font-weight: 500;
}
.dsh-ais-entry-icon { display: inline-flex; flex: none; color: #2f6feb; }
.dsh-ais-entry-label { flex: none; }
[data-sidebar-collapsed] [${ENTRY_ATTR}],
[class*="_collapsed"] [${ENTRY_ATTR}] {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0;
  justify-content: center; gap: 0; text-align: center;
}
[data-sidebar-collapsed] [${ENTRY_ATTR}] .dsh-ais-entry-label,
[class*="_collapsed"] [${ENTRY_ATTR}] .dsh-ais-entry-label { display: none; }

html[${OPEN_ATTR}] [data-pane="conversation"] > *:not([${VIEW_ATTR}]),
html[${OPEN_ATTR}] [class*="centerCol"] > *:not([${VIEW_ATTR}]),
html[${OPEN_ATTR}] .dshDesktopConversationSurface > *:not([${VIEW_ATTR}]) { display: none !important; }
.dsh-ais-view { display: none; }
html[${OPEN_ATTR}] .dsh-ais-view {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
}
.dsh-ais-frame { flex: 1; width: 100%; min-height: 0; border: 0; display: block; background: transparent; }
.dsh-ais-fallback {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; height: 100%; padding: 24px; text-align: center; font-size: 13px;
  color: var(--dsw-alias-label-secondary, #7f8fa4);
}
`

  /** A switch/route glyph, drawn rather than imported so the bundle stays one file. */
  const ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 7h9a4 4 0 0 1 4 4v0a4 4 0 0 0 4 4h-1"/>'
    + '<path d="M18 4l3 3-3 3"/><path d="M20 18H11a4 4 0 0 1-4-4v0a4 4 0 0 0-4-4"/>'
    + '<path d="M6 21l-3-3 3-3"/></svg>'

  const state = {
    open: false,
    disposed: false,
    entry: null,
    view: null,
    frame: null,
    lang: '',
    theme: '',
  }

  function log(message, error) {
    if (error === undefined) {
      console.warn(LOG + ' ' + message)
      return
    }
    console.warn(LOG + ' ' + message, error && error.message ? error.message : error)
  }

  function labels() {
    return LABELS[state.lang === 'en' ? 'en' : 'zh']
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID) !== null) {
      return
    }
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  // ------------------------------------------------------------------- theme
  /**
   * Which theme the shell is in.
   *
   * DSH does not expose that as anything a bundle can read directly, so this walks the three
   * places it shows up, in order of reliability, and falls back to the luminance of the
   * shell's own background token — correct by construction whatever the shell calls its
   * themes.
   */
  function detectTheme() {
    const root = document.documentElement
    const explicit = String(root.dataset.theme || root.getAttribute('data-dsw-theme') || '')
    if (/dark/i.test(explicit)) {
      return 'dark'
    }
    if (/light/i.test(explicit)) {
      return 'light'
    }
    if (root.classList.contains('dark') || document.body?.classList.contains('dark')) {
      return 'dark'
    }
    try {
      const token = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim()
      const match = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(token)
      if (match !== null) {
        const luminance = (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000
        return luminance < 128 ? 'dark' : 'light'
      }
      const hex = /^#([0-9a-f]{6})$/i.exec(token)
      if (hex !== null) {
        const value = Number.parseInt(hex[1], 16)
        const luminance =
          (((value >> 16) & 255) * 299 + ((value >> 8) & 255) * 587 + (value & 255) * 114) / 1000
        return luminance < 128 ? 'dark' : 'light'
      }
    } catch (error) {
      /* getComputedStyle is unavailable in the test DOM stub */
    }
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }

  /**
   * Tell the app which theme to be in.
   *
   * The reference app has no dark mode of its own — it is a light UI, and inventing one by
   * inverting its colours in CSS from out here would look worse than leaving it light. So
   * what actually crosses is the token: the panel document picks up `data-dsh-theme` and can
   * use it, and today that only drives the iframe's own background so a dark shell does not
   * flash white while the app boots.
   */
  function pushTheme() {
    const theme = detectTheme()
    if (theme === state.theme || state.frame === null) {
      return
    }
    state.theme = theme
    try {
      state.frame.contentWindow?.postMessage({ source: PLUGIN_ID, kind: 'theme', theme: theme }, window.location.origin)
    } catch (error) {
      log('theme postMessage failed', error)
    }
  }

  // -------------------------------------------------------------------- seats
  function conversationColumn() {
    return document.querySelector(CONVERSATION_SELECTOR)
  }

  function createEntry() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-ais-entry'
    button.setAttribute(ENTRY_ATTR, '')
    button.setAttribute('aria-label', labels().entry)
    button.title = labels().title
    const icon = document.createElement('span')
    icon.className = 'dsh-ais-entry-icon'
    icon.innerHTML = ICON
    const label = document.createElement('span')
    label.className = 'dsh-ais-entry-label'
    label.textContent = labels().entry
    button.appendChild(icon)
    button.appendChild(label)
    button.addEventListener('click', function () {
      setOpen(!state.open)
    })
    return button
  }

  /** Put the entry next to whichever sibling panel entries are already mounted. */
  function placeEntry() {
    if (state.entry === null || state.entry.isConnected) {
      return
    }
    const siblings = document.querySelectorAll(SIBLING_ENTRIES)
    if (siblings.length > 0) {
      const last = siblings[siblings.length - 1]
      last.parentNode?.insertBefore(state.entry, last.nextSibling)
      return
    }
    const sidebar = document.querySelector(SIDEBAR_SELECTOR)
    if (sidebar !== null) {
      sidebar.appendChild(state.entry)
    }
  }

  function ensureView() {
    const column = conversationColumn()
    if (column === null) {
      return
    }
    if (state.view !== null && state.view.isConnected && state.view.parentNode === column) {
      return
    }
    const view = document.createElement('div')
    view.className = 'dsh-ais-view'
    view.setAttribute(VIEW_ATTR, '')
    column.appendChild(view)
    // A replaced view means a shell repaint threw the old one away; the frame goes with it.
    state.view = view
    state.frame = null
  }

  /**
   * Build the iframe.
   *
   * The language comes from the HOST (`/health`), not from `navigator.language`: dsh knows
   * what the user picked in its own settings, and the panel's index.html seeds the app's
   * language key from the query string before React boots. A failed probe is not fatal — the
   * app then falls back to its own default.
   */
  async function ensureFrame() {
    ensureView()
    if (state.view === null || state.frame !== null) {
      return
    }

    if (state.lang.length === 0) {
      try {
        const response = await fetch(ROUTE_PREFIX + '/health', { headers: { accept: 'application/json' } })
        const payload = await response.json()
        state.lang = typeof payload?.language === 'string' ? payload.language : ''
      } catch (error) {
        log('language probe failed, letting the panel choose', error)
        state.lang = ''
      }
    }

    state.theme = detectTheme()
    const query = new URLSearchParams()
    if (state.lang.length > 0) {
      query.set('lang', state.lang)
    }
    query.set('theme', state.theme)

    const frame = document.createElement('iframe')
    frame.className = 'dsh-ais-frame'
    frame.setAttribute('title', labels().title)
    frame.setAttribute('allow', 'clipboard-read; clipboard-write')
    frame.src = APP_PATH + '?' + query.toString()
    frame.addEventListener('error', function () {
      showFallback(labels().failed)
    })

    state.view.replaceChildren(frame)
    state.frame = frame
  }

  function showFallback(message) {
    if (state.view === null) {
      return
    }
    const box = document.createElement('div')
    box.className = 'dsh-ais-fallback'
    const title = document.createElement('div')
    title.textContent = message
    box.appendChild(title)
    state.view.replaceChildren(box)
    state.frame = null
  }

  function renderEntry() {
    if (state.entry === null) {
      return
    }
    state.entry.setAttribute('data-active', state.open ? 'true' : 'false')
  }

  function ensureMounted() {
    if (state.disposed) {
      return
    }
    try {
      if (state.entry === null || !state.entry.isConnected) {
        state.entry = createEntry()
      }
      placeEntry()
      if (conversationColumn() !== null) {
        ensureView()
        // Re-parenting an iframe reloads it, so the frame is only rebuilt when the view
        // itself was replaced by a shell repaint.
        if (state.open && state.frame === null) {
          void ensureFrame()
        }
      }
      renderEntry()
    } catch (error) {
      log('seat mount failed', error)
    }
  }

  function setOpen(open) {
    state.open = open
    if (open) {
      document.documentElement.setAttribute(OPEN_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      void ensureFrame()
    } else {
      document.documentElement.removeAttribute(OPEN_ATTR)
    }
    renderEntry()
  }

  // --------------------------------------------------------------------- boot
  const booted = { running: false }

  function apply(ctx) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }
    if (booted.running) {
      return
    }
    booted.running = true

    let observer = null
    let timer = null
    let onActivate = null
    let onKeyDown = null
    let media = null
    let onMedia = null

    function dispose() {
      if (state.disposed) {
        return
      }
      state.disposed = true
      if (timer !== null) {
        clearInterval(timer)
      }
      if (observer !== null) {
        try {
          observer.disconnect()
        } catch (error) {
          /* already gone */
        }
      }
      if (onActivate !== null) {
        document.removeEventListener(ACTIVATE_EVENT, onActivate)
      }
      if (onKeyDown !== null) {
        document.removeEventListener('keydown', onKeyDown)
      }
      if (media !== null && onMedia !== null && typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', onMedia)
      }
      document.documentElement.removeAttribute(OPEN_ATTR)
      if (state.entry !== null) {
        try {
          state.entry.remove()
        } catch (error) {
          /* already gone */
        }
        state.entry = null
      }
      if (state.view !== null) {
        try {
          state.view.remove()
        } catch (error) {
          /* already gone */
        }
        state.view = null
      }
      state.frame = null
      state.open = false
      const style = document.getElementById(STYLE_ID)
      if (style !== null) {
        style.remove()
      }
      booted.running = false
    }

    try {
      injectStyles()
      ensureMounted()

      // The DSH shell re-renders its own tree; an observer plus a slow interval keep the
      // seats attached across those repaints.
      observer = new MutationObserver(function () {
        ensureMounted()
        pushTheme()
      })
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-dsw-theme'],
      })
      timer = setInterval(ensureMounted, 3000)

      onActivate = function (event) {
        if (state.disposed) {
          return
        }
        if (event.detail !== undefined && event.detail !== PANEL_NAME && state.open) {
          setOpen(false)
        }
      }
      document.addEventListener(ACTIVATE_EVENT, onActivate)

      onKeyDown = function (event) {
        if (state.disposed || !state.open) {
          return
        }
        // Escape closes the panel only when the app itself did not use it — the app is full
        // of dialogs that own Escape, so the iframe gets it first and this only sees the key
        // when focus is outside the frame.
        if (event.key === 'Escape' && document.activeElement !== state.frame) {
          setOpen(false)
        }
      }
      document.addEventListener('keydown', onKeyDown)

      if (typeof window.matchMedia === 'function') {
        media = window.matchMedia('(prefers-color-scheme: dark)')
        onMedia = function () {
          pushTheme()
        }
        if (typeof media.addEventListener === 'function') {
          media.addEventListener('change', onMedia)
        }
      }

      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        // cordis: effect(fn) runs fn and keeps its return value as the disposer.
        ctx.effect(function () {
          return dispose
        }, PLUGIN_ID + ': client mount')
      } else {
        window.addEventListener('beforeunload', dispose, { once: true })
      }
    } catch (error) {
      console.error(LOG + ' client boot failed', error)
      dispose()
    }
  }

  // The wrap step evaluates this file inside window.__ModuleLoader__.load with a CommonJS
  // `module` in scope; a plain Node require() gets the same shape.
  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = {
      name: PLUGIN_ID + '/client',
      inject: [],
      apply: apply,
    }
  }
})()
