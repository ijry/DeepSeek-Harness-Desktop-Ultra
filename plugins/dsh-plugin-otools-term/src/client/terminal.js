/**
 * One xterm instance per terminal tab, and the splice that makes a re-attach exact.
 *
 * The host owns the session; this file owns the widget. Because a session outlives
 * the page, attaching is not "start a shell" but "catch up with one":
 *
 *   1. open (or re-open) the session — the host returns the existing record when the
 *      id is already live, so a reload costs nothing;
 *   2. subscribe, and QUEUE live frames instead of writing them;
 *   3. read the replay, which says at which byte offset it ends;
 *   4. write the replay, then write the queued frames with the overlap trimmed.
 *
 * Step 4 is why every frame carries an offset. Without it a re-attach either
 * double-prints the last screenful (write both) or loses whatever arrived during the
 * round trip (write only the replay).
 */

/** tabId → the live widget. */
const terminals = new Map()

/** The font stack, verbatim from the reference's xterm options. */
const TERM_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"

/** Build the xterm options from the current preferences. */
function termOptions() {
  return {
    allowTransparency: true,
    cursorBlink: pref('cursorBlink', true) === true,
    fontFamily: TERM_FONT,
    fontSize: pref('fontSize', 13),
    scrollback: pref('scrollback', 2000),
    theme: getTheme(pref('themeName', 'default')),
    // A terminal that reports its own size wrongly wraps every line; xterm measures
    // the cell itself, so the only thing to get right is telling the host.
    convertEol: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
  }
}

/** The widget for one tab, or undefined. */
function terminalOf(tabId) {
  return terminals.get(tabId)
}

/** The widget showing one session, or undefined. */
function terminalOfSession(sessionId) {
  for (const entry of terminals.values()) {
    if (entry.sessionId === sessionId) return entry
  }
  return undefined
}

/**
 * Create the DOM for one terminal pane. Called once per tab; the returned element is
 * kept across repaints.
 */
function buildTerminalPane(tab) {
  const host = el('div', { class: 'dsh-ot-term' })
  const overlay = el('div', { class: 'dsh-ot-term-overlay' }, el('div', {}, t('term.starting')))
  const pane = el('div', { class: 'dsh-ot-pane', 'data-tab': tab.id }, host, overlay)
  const entry = {
    tabId: tab.id,
    sessionId: tab.sessionId,
    pane,
    host,
    overlay,
    term: undefined,
    fit: undefined,
    search: undefined,
    observer: undefined,
    queue: [],
    attaching: true,
    nextOffset: 0,
    text: '',
    disposed: false,
  }
  terminals.set(tab.id, entry)
  void attachTerminal(entry, tab)
  return pane
}

/** Show or hide the pane overlay. */
function setOverlay(entry, ...children) {
  if (children.length === 0 || children[0] === undefined) {
    setData(entry.overlay, 'hidden', true)
    return
  }
  delete entry.overlay.dataset.hidden
  fill(entry.overlay, ...children)
}

/** Bring one terminal up: mount xterm, open the session, splice the replay. */
async function attachTerminal(entry, tab) {
  let vendor
  try {
    vendor = await ensureXterm()
  } catch (error) {
    setOverlay(entry, el('div', {}, t('term.vendorMissing')), el('div', { class: 'dsh-ot-mono' }, messageOf(error)))
    return
  }
  if (entry.disposed) return

  const term = new vendor.Terminal(termOptions())
  entry.term = term
  if (vendor.FitAddon !== undefined) {
    entry.fit = new vendor.FitAddon()
    term.loadAddon(entry.fit)
  }
  if (vendor.SearchAddon !== undefined) {
    entry.search = new vendor.SearchAddon()
    term.loadAddon(entry.search)
  }
  if (vendor.WebLinksAddon !== undefined) {
    term.loadAddon(new vendor.WebLinksAddon((event, uri) => {
      // Open in a new tab, and never in this one: navigating the DSH page away would
      // kill every terminal in it.
      window.open(uri, '_blank', 'noopener,noreferrer')
    }))
  }
  term.open(entry.host)
  fitTerminal(entry)

  term.onData((data) => {
    if (entry.sessionId === undefined) return
    sendInput(entry.sessionId, data)
  })
  term.onBinary((data) => {
    if (entry.sessionId === undefined) return
    sendInput(entry.sessionId, data)
  })
  term.onSelectionChange(() => {
    if (pref('copyOnSelect', false) !== true) return
    const selection = term.getSelection()
    if (typeof selection === 'string' && selection.length > 0) void copyText(selection)
  })
  // The right-click menu is the panel's own, so the browser's must not also appear.
  entry.host.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openTerminalMenu(entry, event.clientX, event.clientY)
  })

  if (typeof ResizeObserver === 'function') {
    entry.observer = new ResizeObserver(() => fitTerminal(entry))
    entry.observer.observe(entry.host)
  }

  await openSessionFor(entry, tab)
}

/**
 * Open the host session for one tab and splice its replay.
 *
 * Also used by the reconnect button, so it tolerates being called again on a tab
 * whose session has ended.
 */
async function openSessionFor(entry, tab) {
  const term = entry.term
  if (term === undefined) return
  entry.attaching = true
  entry.queue = []
  setOverlay(entry, el('div', {}, t('term.starting')))
  try {
    const record = await apiPost('/terminal/open', {
      sessionId: entry.sessionId,
      serverId: tab.serverId,
      cols: term.cols,
      rows: term.rows,
      cwd: tab.cwd,
      initialCommand: tab.initialCommand,
    })
    mergeSession(record)
    // Subscribe before the replay so nothing printed in between is lost; the frames
    // land in `entry.queue` while `attaching` is true.
    await pushSubscriptions()
    const replay = await apiGet('/session/replay', { sessionId: entry.sessionId })
    if (entry.disposed) return
    entry.nextOffset = typeof replay.offset === 'number' ? replay.offset : 0
    if (typeof replay.data === 'string' && replay.data.length > 0) {
      term.write(bytesOfBase64(replay.data))
    }
    entry.attaching = false
    const queued = entry.queue
    entry.queue = []
    for (const frame of queued) writeFrame(entry, frame)
    setOverlay(entry)
    term.focus()
    fitTerminal(entry)
    // A tab restored from the workspace snapshot has no initial command to run a
    // second time.
    if (tab.initialCommand !== undefined) delete tab.initialCommand
  } catch (error) {
    entry.attaching = false
    setOverlay(entry,
      el('div', {}, friendlyError(error)),
      hostKeyPromptFor(error, tab.serverId) ??
        button({ label: t('term.reconnect'), variant: 'primary', onClick: () => void openSessionFor(entry, tab) }))
  }
}

/** The "review the fingerprint" button an unknown host key deserves. */
function hostKeyPromptFor(error, serverId) {
  if (codeOf(error) !== 'host_key') return undefined
  const detail = { ...error, serverId }
  return button({
    label: t('hostkey.title'),
    variant: 'primary',
    onClick: () => openHostKeyDialog(detail),
  })
}

/** Write one output frame, trimming whatever the replay already showed. */
function writeFrame(entry, frame) {
  const term = entry.term
  if (term === undefined) return
  const bytes = bytesOfBase64(frame.data)
  const offset = typeof frame.offset === 'number' ? frame.offset : entry.nextOffset
  const end = offset + bytes.length
  if (end <= entry.nextOffset) return
  const slice = offset < entry.nextOffset ? bytes.subarray(entry.nextOffset - offset) : bytes
  entry.nextOffset = end
  term.write(slice)
  rememberText(entry, slice)
}

/**
 * Keep a plain-text tail of the session for the AI bar.
 *
 * The host has its own copy and the AI routes use THAT; this one exists so the bar
 * can show what it is about to send without a round trip.
 */
function rememberText(entry, bytes) {
  try {
    entry.text += new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return
  }
  if (entry.text.length > CLIENT_SCROLLBACK_CHARS) {
    entry.text = entry.text.slice(-CLIENT_SCROLLBACK_CHARS)
  }
}

/** Deliver one live output frame to whichever terminal owns it. */
function handleOutput(sessionId, data, frame) {
  const entry = terminalOfSession(sessionId)
  if (entry === undefined) return
  const record = frame ?? { data, offset: undefined }
  if (entry.attaching) {
    // Bounded: a session that floods while a panel is attaching must not grow the
    // queue without limit. Past the cap the oldest frames go, which the offset
    // splice then reports as a gap rather than silently mis-rendering.
    if (entry.queue.length > 400) entry.queue.shift()
    entry.queue.push(record)
    return
  }
  writeFrame(entry, record)
}

/** Re-measure and tell the host the new size. */
function fitTerminal(entry) {
  const term = entry.term
  if (term === undefined || entry.disposed) return
  if (entry.host.clientWidth <= 0 || entry.host.clientHeight <= 0) return
  if (entry.fit !== undefined) {
    try {
      entry.fit.fit()
    } catch { /* a hidden pane */ }
  }
  const cols = Math.max(2, term.cols || 80)
  const rows = Math.max(1, term.rows || 24)
  if (entry.lastCols === cols && entry.lastRows === rows) return
  entry.lastCols = cols
  entry.lastRows = rows
  if (entry.sessionId === undefined) return
  // The reference never reported a resize at all — its PTY stayed at the 80×24 it was
  // created with, so every resized window wrapped at the wrong column.
  sendResize(entry.sessionId, cols, rows)
}

/** Apply changed preferences (font, theme, scrollback) to every live terminal. */
function restyleTerminals() {
  const options = termOptions()
  for (const entry of terminals.values()) {
    const term = entry.term
    if (term === undefined) continue
    term.options.theme = options.theme
    term.options.fontSize = options.fontSize
    term.options.cursorBlink = options.cursorBlink
    term.options.scrollback = options.scrollback
    entry.host.style.background = options.theme.background ?? ''
    fitTerminal(entry)
  }
}

/** Focus the terminal of the active tab, if it has one. */
function focusTerminal(tabId) {
  const entry = terminals.get(tabId)
  if (entry === undefined || entry.term === undefined) return
  fitTerminal(entry)
  try {
    entry.term.focus()
  } catch { /* not attached yet */ }
}

/** Paste text into a session as if typed (used by the command list and the AI bar). */
function typeIntoTerminal(tabId, text) {
  const entry = terminals.get(tabId)
  if (entry === undefined || entry.sessionId === undefined) return false
  sendInput(entry.sessionId, text)
  if (entry.term !== undefined) {
    try {
      entry.term.focus()
    } catch { /* not attached */ }
  }
  return true
}

/** The plain-text tail one tab has on screen. */
function terminalText(tabId) {
  const entry = terminals.get(tabId)
  return entry === undefined ? '' : entry.text
}

/**
 * Find text in the scrollback.
 *
 * A prompt rather than an always-visible find bar: `Ctrl+F` belongs to the shell
 * running inside the terminal (it is forward-char in emacs mode, and a search in
 * less), so the panel must not take it. Enter in the prompt jumps to the first hit and
 * the menu item can be used again for the next one.
 */
async function findInTerminal(entry) {
  if (entry.search === undefined) {
    toast(t('term.searchPlaceholder'), 'warning')
    return
  }
  const term = await promptDialog({
    title: t('term.searchPlaceholder'),
    label: t('term.searchPlaceholder'),
    value: entry.lastSearch ?? '',
  })
  if (term === undefined) return
  entry.lastSearch = term
  try {
    const found = entry.search.findNext(term, { incremental: false, caseSensitive: false })
    if (found === false) toast(t('sftp.searchEmpty'), 'warning')
  } catch (error) {
    toastError(error)
  }
}

/** Tear one terminal down (its tab was closed). */
function disposeTerminal(tabId) {
  const entry = terminals.get(tabId)
  if (entry === undefined) return
  entry.disposed = true
  terminals.delete(tabId)
  if (entry.observer !== undefined) {
    try {
      entry.observer.disconnect()
    } catch { /* already gone */ }
  }
  if (entry.term !== undefined) {
    try {
      entry.term.dispose()
    } catch { /* already disposed */ }
  }
  if (entry.sessionId !== undefined) dropInputQueue(entry.sessionId)
  try {
    entry.pane.remove()
  } catch { /* already detached */ }
}

/** Note a dropped-output episode on the screen. */
function noteOverflow(sessionId) {
  const entry = terminalOfSession(sessionId)
  if (entry === undefined || entry.term === undefined) return
  entry.term.write('\r\n\u001b[33m' + t('term.overflow') + '\u001b[0m\r\n')
}

/** Reflect a session record change in the pane (exit code, error, reconnect). */
function refreshTerminalStatus(record) {
  const entry = terminalOfSession(record.sessionId)
  if (entry === undefined) return
  const tab = model.tabs.find((row) => row.sessionId === record.sessionId)
  if (record.status === 'running') {
    if (!entry.attaching) setOverlay(entry)
    return
  }
  if (record.status === 'closed') {
    setOverlay(entry,
      el('div', {}, record.exitCode === null || record.exitCode === undefined
        ? t('term.closedNoCode')
        : t('term.closed', { code: record.exitCode })),
      button({
        label: t('term.reconnect'),
        variant: 'primary',
        onClick: () => {
          if (tab === undefined) return
          // A finished session id cannot be revived, so the tab gets a new one.
          const next = newId('sess')
          tab.sessionId = next
          entry.sessionId = next
          entry.nextOffset = 0
          if (entry.term !== undefined) entry.term.reset()
          void openSessionFor(entry, tab)
        },
      }))
    return
  }
  if (record.status === 'error') {
    setOverlay(entry, el('div', {}, t('term.error', { message: record.error ?? '' })))
  }
}
