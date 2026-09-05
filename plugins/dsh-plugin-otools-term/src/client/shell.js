/**
 * The shell: sidebar, toolbar, tab strip, panes, drawer and AI bar — the layout of
 * the reference's Term.vue.
 *
 * The one structural difference from the sibling plugins: this panel cannot repaint
 * everything. A live xterm and an editor caret do not survive being rebuilt, so the
 * PANES are reconciled (`syncPanes`: create the missing, drop the closed, toggle
 * visibility) while the chrome around them — sidebar, toolbar, tab strip, drawer — is
 * rebuilt wholesale on every change, which keeps the state handling simple where it
 * can be.
 */

let panelEl = null
let sideEl = null
let serversEl = null
let sftpEl = null
let toolbarEl = null
let tabsEl = null
let panesEl = null
let drawerEl = null
let aiEl = null
let entryEl = null
let viewEl = null

/** Build the panel shell once. */
function buildPanel(view) {
  sideEl = el('div', { class: 'dsh-ot-side' })
  serversEl = el('div', { class: 'dsh-ot-servers' })
  sftpEl = el('div', { class: 'dsh-ot-sftp' })
  toolbarEl = el('div', { class: 'dsh-ot-toolbar' })
  tabsEl = el('div', { class: 'dsh-ot-tabs' })
  panesEl = el('div', { class: 'dsh-ot-panes' })
  drawerEl = el('div', { class: 'dsh-ot-drawer', 'data-hidden': 'true' })
  aiEl = el('div', { class: 'dsh-ot-ai', 'data-hidden': 'true' })

  const splitter = resizeHandle({
    axis: 'y',
    min: SERVER_LIST_MIN_HEIGHT,
    max: () => Math.max(SERVER_LIST_MIN_HEIGHT, (sideEl?.clientHeight ?? 600) - SFTP_PANEL_MIN_HEIGHT),
    value: () => serversEl.getBoundingClientRect().height,
    onMove: (value) => {
      serversEl.style.height = value + 'px'
      serversEl.style.flex = '0 0 auto'
    },
    onCommit: (value) => void savePrefs({ serverListHeight: Math.round(value) }),
  })
  const body = el('div', { class: 'dsh-ot-side-body' }, serversEl, splitter, sftpEl)
  sideEl.append(el('div', { class: 'dsh-ot-side-head' }), body)

  const sideSplitter = resizeHandle({
    axis: 'x',
    min: SIDEBAR_MIN_WIDTH,
    max: () => SIDEBAR_MAX_WIDTH,
    value: () => sideEl.getBoundingClientRect().width,
    onMove: (value) => {
      sideEl.style.width = value + 'px'
    },
    onCommit: (value) => void savePrefs({ sidebarWidth: Math.round(value) }),
    onReset: () => {
      sideEl.style.width = SIDEBAR_DEFAULT_WIDTH + 'px'
      void savePrefs({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
    },
  })
  const main = el('div', { class: 'dsh-ot-main' }, toolbarEl, tabsEl,
    el('div', { class: 'dsh-ot-body' }, panesEl, drawerEl), aiEl)
  panelEl = el('div', { class: 'dsh-ot-panel', 'data-dsh-ot-panel': '' }, sideEl, sideSplitter, main)
  view.append(panelEl)
}

/** Repaint the chrome and reconcile the panes. */
function renderPanel() {
  if (panelEl === null || !panelEl.isConnected) return
  sideEl.style.width = pref('sidebarWidth', SIDEBAR_DEFAULT_WIDTH) + 'px'
  setData(sideEl, 'hidden', pref('sidebarVisible', true) !== true)
  renderSideHead()
  renderServerList()
  renderSftpSection()
  renderToolbar()
  renderTabs()
  syncPanes()
  renderDrawer(drawerEl)
  renderAiBar(aiEl)
  renderEntry()
}

/** The sidebar heading: title, subtitle, settings and add. */
function renderSideHead() {
  fill(sideEl.querySelector('.dsh-ot-side-head'),
    el('div', { class: 'dsh-ot-side-copy' },
      el('h2', { class: 'dsh-ot-side-title' }, t('main.title')),
      el('div', { class: 'dsh-ot-side-sub' }, t('main.subtitle'))),
    el('div', { class: 'dsh-ot-side-actions' },
      iconButton('settings', { title: t('main.settings'), onClick: () => openSettingsDialog() }),
      iconButton('plus', { variant: 'primary', title: t('main.newConnection'), onClick: () => openServerDialog(undefined) })))
}

/** The server rows. */
function renderServerList() {
  const rows = allServers()
  const height = pref('serverListHeight', 220)
  if (sftpVisible()) {
    serversEl.style.height = height + 'px'
    serversEl.style.flex = '0 0 auto'
  } else {
    serversEl.style.height = ''
    serversEl.style.flex = '1 1 0%'
  }
  const filter = el('div', { style: { padding: '6px 8px' } }, input({
    value: model.serverFilter,
    placeholder: t('main.searchServers'),
    onInput: (event) => {
      model.serverFilter = event.target.value
      renderServerList()
    },
  }))
  fill(serversEl, filter, ...rows.map((server) => renderServerRow(server)))
  if (rows.length === 0) serversEl.append(el('div', { class: 'dsh-ot-side-empty' }, t('main.emptySelectServer')))
}

/** One server row. */
function renderServerRow(server) {
  const state = connectionState(server.id)
  const meta = server.id === LOCAL_SERVER_ID
    ? (model.local.shell ?? '') + (model.local.pty === true ? '' : ' · ' + t('term.compatibility'))
    : protocolLabel(server.protocol) + ' · ' + (server.username.length > 0 ? server.username + '@' : '') + server.host + ':' + server.port
  return el('div', {
    class: 'dsh-ot-server',
    'data-active': model.selectedServerId === server.id ? 'true' : undefined,
    onClick: () => selectServer(server.id),
    onContextmenu: (event) => {
      event.preventDefault()
      openServerMenu(server, event.clientX, event.clientY)
    },
  },
  el('div', { class: 'dsh-ot-server-main' },
    el('div', { class: 'dsh-ot-server-row' },
      el('span', { class: 'dsh-ot-dot', 'data-state': state }),
      el('span', { class: 'dsh-ot-server-name', title: server.name }, server.name)),
    el('div', { class: 'dsh-ot-server-meta', title: meta }, meta)),
  el('div', { class: 'dsh-ot-server-badges' },
    hasTunnels(server.id) ? tag('', 'primary', { title: t('main.menu.forwarding') }) : undefined,
    el('span', {
      class: 'dsh-ot-menu-btn',
      title: t('main.menu.editConnection'),
      onClick: (event) => {
        event.stopPropagation()
        const box = event.currentTarget.getBoundingClientRect()
        openServerMenu(server, box.left, box.bottom + 4)
      },
    }, icon('more', 16))))
}

/** The protocol label, with the reference's wording. */
function protocolLabel(protocol) {
  if (protocol === 'rdp') return t('main.serverDialog.protocolRdp')
  if (protocol === 'vnc') return t('main.serverDialog.protocolVnc')
  return t('main.serverDialog.protocolSsh')
}

/** Whether the SFTP half of the sidebar is showing. */
function sftpVisible() {
  return sftpState().serverId.length > 0
}

/** The SFTP section (hidden when no server has it open). */
function renderSftpSection() {
  if (!sftpVisible()) {
    fill(sftpEl)
    sftpEl.style.display = 'none'
    return
  }
  sftpEl.style.display = 'flex'
  renderSftpPane(sftpEl)
}
/** The toolbar: collapse, title, the three popover buttons, the theme picker. */
function renderToolbar() {
  const server = selectedServer()
  const sidebarOn = pref('sidebarVisible', true) === true
  const subtitle = server === undefined
    ? t('main.toolbarSubtitleDefault')
    : (server.id === LOCAL_SERVER_ID
      ? (model.local.shell ?? '')
      : protocolLabel(server.protocol) + ' · ' + (server.username.length > 0 ? server.username + '@' : '') + server.host + ':' + server.port)
  fill(toolbarEl,
    el('div', { class: 'dsh-ot-toolbar-left' },
      iconButton(sidebarOn ? 'sidebar-collapse' : 'sidebar-expand', {
        title: sidebarOn ? t('main.collapseSidebar') : t('main.expandSidebar'),
        onClick: () => void savePrefs({ sidebarVisible: !sidebarOn }),
      }),
      el('div', { style: { 'min-width': '0' } },
        el('div', { class: 'dsh-ot-toolbar-title' }, server === undefined ? t('main.toolbarDefaultTitle') : server.name),
        el('div', { class: 'dsh-ot-toolbar-sub', title: subtitle }, subtitle))),
    el('div', { class: 'dsh-ot-toolbar-group' },
      button({
        icon: 'commands',
        iconOnly: true,
        title: t('main.favoriteCommands'),
        onClick: (event) => openCommandsMenu(event),
      }),
      button({
        icon: 'folder-star',
        iconOnly: true,
        title: t('main.favoriteDirectories'),
        disabled: !canUseSftp(server),
        onClick: (event) => openFavoriteDirsMenu(event),
      }),
      button({
        icon: 'sparkles',
        iconOnly: true,
        title: t('ai.title'),
        active: model.aiOpen,
        onClick: () => toggleAiBar(),
      }),
      button({
        icon: 'upload',
        label: t('main.transferTasks'),
        badge: runningTaskCount(),
        active: model.drawerOpen,
        onClick: () => {
          model.drawerOpen = !model.drawerOpen
          emit()
        },
      })),
    el('div', { class: 'dsh-ot-toolbar-group' },
      model.busy > 0 ? el('span', { class: 'dsh-ot-field-hint' }, t('main.connecting')) : undefined,
      select(themeOptions().map((name) => ({ id: name, label: name })), pref('themeName', 'default'), (value) => {
        void savePrefs({ themeName: value }).then(restyleTerminals)
      })))
}

/** The tab strip: terminals, editors, the desktop card, and the add button. */
function renderTabs() {
  const server = selectedServer()
  const rows = model.tabs.filter((tab) => server === undefined || tab.serverId === server.id)
  fill(tabsEl, ...rows.map((tab) => renderTab(tab)),
    canOpenTerminal(server)
      ? el('button', {
        type: 'button',
        class: 'dsh-ot-tab dsh-ot-tab-add',
        title: t('term.newTab'),
        onClick: () => addTerminalTab(server.id),
      }, '+')
      : undefined)
}

/** One tab button. */
function renderTab(tab) {
  const session = tab.kind === 'terminal' ? sessionById(tab.sessionId) : undefined
  const label = (tab.kind === 'editor' && tab.dirty === true ? '* ' : '') + tab.name
  return el('button', {
    type: 'button',
    class: 'dsh-ot-tab',
    'data-active': model.activeTabId === tab.id ? 'true' : undefined,
    title: tab.kind === 'editor' ? tab.filePath : tab.name,
    onClick: () => activateTab(tab.id),
    onContextmenu: (event) => {
      event.preventDefault()
      openContextMenu(event.clientX, event.clientY, [
        { label: t('term.closeTab'), icon: 'close', onClick: () => void closeTab(tab.id) },
      ], tab.name)
    },
  },
  tab.kind === 'terminal'
    ? el('span', { class: 'dsh-ot-tab-dot', 'data-state': session === undefined ? 'closed' : session.status })
    : icon(tab.kind === 'editor' ? 'file' : 'monitor', 13),
  el('span', { class: 'dsh-ot-tab-label' }, label),
  el('span', {
    class: 'dsh-ot-tab-close',
    title: t('term.closeTab'),
    onClick: (event) => {
      event.stopPropagation()
      void closeTab(tab.id)
    },
  }, '×'))
}

/**
 * Reconcile the panes.
 *
 * Every tab owns one pane element, created on first sight and kept until the tab
 * closes. Only the `data-active` flag moves, so switching tabs never re-creates an
 * xterm (which would clear the screen) or a textarea (which would lose the caret).
 */
function syncPanes() {
  const server = selectedServer()
  const wanted = model.tabs.filter((tab) => server === undefined || tab.serverId === server.id)
  const seen = new Set()
  for (const tab of wanted) {
    seen.add(tab.id)
    let pane = panesEl.querySelector('[data-tab="' + cssEscape(tab.id) + '"]')
    if (pane === null) {
      pane = tab.kind === 'terminal'
        ? buildTerminalPane(tab)
        : (tab.kind === 'editor' ? buildEditorPane(tab) : buildDesktopPane(tab))
      panesEl.append(pane)
    }
    const active = model.activeTabId === tab.id
    setData(pane, 'active', active)
    if (tab.kind === 'editor') renderEditorChrome(tab)
    if (tab.kind === 'desktop') renderDesktopPane(pane, tab)
    if (active && tab.kind === 'terminal') focusTerminal(tab.id)
  }
  // Panes whose tab is gone (or belongs to another server) are dropped; the terminal
  // ones keep their host session, so re-selecting the server re-attaches.
  for (const pane of [...panesEl.children]) {
    const id = pane.dataset.tab
    if (id !== undefined && !seen.has(id)) {
      if (terminalOf(id) !== undefined) disposeTerminal(id)
      else if (editors.has(id)) disposeEditor(id)
      else pane.remove()
    }
  }
  if (wanted.length === 0) {
    const empty = el('div', { class: 'dsh-ot-pane', 'data-active': 'true', 'data-tab': '__empty__' },
      el('div', { class: 'dsh-ot-empty' },
        el('span', {}, server === undefined ? t('main.emptySelectServer') : t('main.emptyNoTab')),
        model.vendor.ready === false ? el('span', {}, t('term.vendorMissing')) : undefined))
    fill(panesEl, empty)
  }
}

/** Minimal CSS.escape for the ids this panel mints. */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}
// -------------------------------------------------------------- selection
/**
 * Select one server row. Selecting a row that can hold a terminal and has none opens
 * one, which is what the reference did (and is why clicking a server feels like
 * connecting to it).
 */
function selectServer(serverId) {
  model.selectedServerId = serverId
  storeSet(STORE_KEYS.selectedServer, serverId)
  const server = serverById(serverId)
  const own = model.tabs.filter((tab) => tab.serverId === serverId)
  if (own.length === 0) {
    if (canLaunchDesktop(server)) addDesktopTab(serverId)
    else if (canOpenTerminal(server)) addTerminalTab(serverId)
  } else if (own.every((tab) => tab.id !== model.activeTabId)) {
    model.activeTabId = own[0].id
  }
  if (canUseSftp(server) && sftpState().serverId !== serverId && pref('sftpVisible', true) === true) {
    openSftpFor(serverId)
  }
  emit()
  scheduleWorkspaceSave()
}

/** Open a new terminal tab on one server. */
function addTerminalTab(serverId, options) {
  const server = serverById(serverId)
  if (!canOpenTerminal(server)) return undefined
  const count = model.tabs.filter((tab) => tab.serverId === serverId && tab.kind === 'terminal').length
  const tab = {
    id: newId('tab'),
    kind: 'terminal',
    serverId,
    sessionId: newId('sess'),
    name: count > 0 ? server.name + ' (' + (count + 1) + ')' : server.name,
    cwd: options?.cwd,
    initialCommand: options?.initialCommand,
  }
  model.tabs = [...model.tabs, tab]
  model.activeTabId = tab.id
  model.selectedServerId = serverId
  emit()
  scheduleWorkspaceSave()
  return tab
}

/** Open (or focus) an editor tab for one remote file. */
function openRemoteFile(serverId, path) {
  const existing = model.tabs.find((tab) => tab.kind === 'editor' && tab.serverId === serverId && tab.filePath === path)
  if (existing !== undefined) {
    model.activeTabId = existing.id
    model.selectedServerId = serverId
    emit()
    return existing
  }
  const tab = {
    id: newId('tab'),
    kind: 'editor',
    serverId,
    filePath: path,
    name: baseName(path),
    content: '',
    original: '',
    dirty: false,
    loading: true,
  }
  model.tabs = [...model.tabs, tab]
  model.activeTabId = tab.id
  model.selectedServerId = serverId
  emit()
  scheduleWorkspaceSave()
  return tab
}

/** Open a terminal already `cd`-ed into one directory. */
function openTerminalAt(serverId, path) {
  const server = serverById(serverId)
  if (server === undefined) return
  // The path is single-quoted for the remote shell: a directory called `it's here`
  // must not end the argument early.
  const quoted = "'" + String(path).replace(/'/g, "'\\''") + "'"
  const tab = addTerminalTab(serverId, { cwd: path, initialCommand: 'cd ' + quoted })
  if (tab !== undefined) tab.name = server.name + ' (' + baseName(path) + ')'
  emit()
}

/** Open the desktop card for an RDP/VNC row. */
function addDesktopTab(serverId) {
  const server = serverById(serverId)
  if (!canLaunchDesktop(server)) return undefined
  const existing = model.tabs.find((tab) => tab.kind === 'desktop' && tab.serverId === serverId)
  if (existing !== undefined) {
    model.activeTabId = existing.id
    emit()
    return existing
  }
  const tab = { id: newId('tab'), kind: 'desktop', serverId, name: server.name }
  model.tabs = [...model.tabs, tab]
  model.activeTabId = tab.id
  emit()
  return tab
}

/** Switch tabs. */
function activateTab(tabId) {
  const tab = tabById(tabId)
  if (tab === undefined) return
  model.activeTabId = tabId
  model.selectedServerId = tab.serverId
  emit()
  scheduleWorkspaceSave()
}

/**
 * Close one tab.
 *
 * A terminal tab closes its HOST session too: leaving it running would be a shell
 * nobody can reach. An editor with unsaved changes asks first.
 */
async function closeTab(tabId) {
  const tab = tabById(tabId)
  if (tab === undefined) return
  if (tab.kind === 'editor' && tab.dirty === true) {
    const go = await confirmDialog({
      title: t('term.closeTab'),
      message: t('editor.discardConfirm', { name: tab.name }),
      danger: true,
    })
    if (!go) return
  }
  if (tab.kind === 'terminal') {
    try {
      await apiPost('/terminal/close', { sessionId: tab.sessionId })
    } catch { /* a session that already ended is fine */ }
    disposeTerminal(tabId)
  }
  if (tab.kind === 'editor') disposeEditor(tabId)
  model.tabs = model.tabs.filter((row) => row.id !== tabId)
  if (model.activeTabId === tabId) {
    const sibling = model.tabs.find((row) => row.serverId === tab.serverId) ?? model.tabs[0]
    model.activeTabId = sibling === undefined ? null : sibling.id
  }
  emit()
  await pushSubscriptions()
  scheduleWorkspaceSave()
}

/** Rewrite the tabs after a rename (the reference did this for its editor tabs). */
function renamePathInTabs(from, to, isDirectory) {
  for (const tab of model.tabs) {
    if (tab.kind !== 'editor') continue
    if (tab.filePath === from) {
      tab.filePath = to
      tab.name = baseName(to)
      continue
    }
    if (isDirectory && tab.filePath.startsWith(from + '/')) {
      tab.filePath = to + tab.filePath.slice(from.length)
      tab.name = baseName(tab.filePath)
    }
  }
  emit()
}

/** Close the editor tabs under a deleted path. */
function closeTabsUnder(path, isDirectory) {
  const doomed = model.tabs.filter((tab) => tab.kind === 'editor' &&
    (tab.filePath === path || (isDirectory && tab.filePath.startsWith(path + '/'))))
  for (const tab of doomed) {
    disposeEditor(tab.id)
    model.tabs = model.tabs.filter((row) => row.id !== tab.id)
    if (model.activeTabId === tab.id) model.activeTabId = model.tabs[0]?.id ?? null
  }
  if (doomed.length > 0) emit()
}
// ------------------------------------------------------------------ menus
/** The per-server menu: the reference's dropdown, by protocol. */
function openServerMenu(server, x, y) {
  const items = []
  if (server.id === LOCAL_SERVER_ID) {
    items.push({ label: t('main.menu.newTerminal'), icon: 'plus', onClick: () => addTerminalTab(server.id) })
    openContextMenu(x, y, items, server.name)
    return
  }
  if (server.protocol === 'ssh') {
    const sftpOpen = sftpState().serverId === server.id
    items.push({ label: t('main.menu.newTerminal'), icon: 'plus', onClick: () => addTerminalTab(server.id) })
    items.push({ label: t('main.menu.openSftp'), icon: 'folder', onClick: () => openSftpFor(server.id) })
    items.push({ label: t('main.menu.closeSftp'), icon: 'close', disabled: !sftpOpen, onClick: () => closeSftp() })
    items.push({ label: t('main.menu.forwarding'), icon: 'tunnel', onClick: () => openForwardingDialog(server.id) })
    items.push({ separator: true })
    items.push({ label: t('main.menu.reconnect'), icon: 'refresh', onClick: () => void connectServer(server.id) })
    items.push({
      label: t('main.menu.disconnect'),
      icon: 'close',
      disabled: connectionState(server.id) === 'disconnected' && !hasTunnels(server.id),
      onClick: () => void disconnectServer(server.id),
    })
  } else {
    items.push({ label: t('main.menu.openDesktop'), icon: 'monitor', onClick: () => addDesktopTab(server.id) })
  }
  items.push({ separator: true })
  items.push({ label: t('main.menu.editConnection'), icon: 'edit', onClick: () => openServerDialog(server) })
  items.push({ label: t('main.menu.duplicate'), icon: 'copy', onClick: () => openServerDialog({ ...server, id: '', name: server.name + ' copy' }) })
  items.push({ label: t('main.menu.deleteConnection'), icon: 'trash', tone: 'danger', onClick: () => void deleteServer(server) })
  openContextMenu(x, y, items, server.name)
}

/** The saved-command list, as a menu anchored under the toolbar button. */
function openCommandsMenu(event) {
  const box = event.currentTarget.getBoundingClientRect()
  const items = model.favoriteCommands.map((row, index) => ({
    label: row.name.length > 0 ? row.name + ' — ' + row.command : row.command,
    icon: 'play',
    onClick: () => void runFavoriteCommand(row.command),
    // A right-click on the row removes it; the menu has no room for a second button.
    onContext: index,
  }))
  if (items.length === 0) items.push({ label: t('main.noFavoriteCommands'), disabled: true, onClick: () => {} })
  items.push({ separator: true })
  items.push({ label: t('main.addFavoriteCommandTitle'), icon: 'plus', onClick: () => openAddCommandDialog() })
  if (model.favoriteCommands.length > 0) {
    items.push({ label: t('main.delete') + '…', icon: 'trash', tone: 'danger', onClick: () => openManageCommandsDialog() })
  }
  openContextMenu(box.left, box.bottom + 4, items, t('main.favoriteCommands'))
}

/** Send one saved command to the active terminal. */
async function runFavoriteCommand(command) {
  const tab = activeTab()
  if (tab === undefined || tab.kind !== 'terminal') {
    toast(t('main.switchToTerminalFirst'), 'warning')
    return
  }
  if (!typeIntoTerminal(tab.id, command)) toast(t('main.terminalNotReady'), 'warning')
}

/** Add one saved command. */
function openAddCommandDialog() {
  let name = ''
  let command = ''
  openDialog({
    title: t('main.addFavoriteCommandTitle'),
    size: 'small',
    build: () => [
      field(t('main.name'), input({
        placeholder: t('main.favoriteCommandNamePlaceholder'),
        onInput: (event) => {
          name = event.target.value
        },
      })),
      field(t('main.command'), input({
        placeholder: t('main.favoriteCommandPlaceholder'),
        onInput: (event) => {
          command = event.target.value
        },
      })),
    ],
    footer: (close) => [
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      button({
        label: t('main.add'),
        variant: 'primary',
        onClick: async () => {
          if (command.trim().length === 0) return
          try {
            await apiPost('/commands', { commands: [...model.favoriteCommands, { name: name.trim(), command: command.trim() }] })
            await loadState()
            close(undefined)
          } catch (error) {
            toastError(error)
          }
        },
      }),
    ],
  })
}

/** Remove saved commands. */
function openManageCommandsDialog() {
  const keep = new Set(model.favoriteCommands.map((row, index) => index))
  openDialog({
    title: t('main.favoriteCommands'),
    build: () => model.favoriteCommands.map((row, index) => el('div', { class: 'dsh-ot-section', style: { gap: '4px' } },
      checkbox(row.name.length > 0 ? row.name : row.command, true, (on) => {
        if (on) keep.add(index)
        else keep.delete(index)
      }),
      el('div', { class: 'dsh-ot-mono' }, row.command))),
    footer: (close) => [
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      button({
        label: t('main.save'),
        variant: 'primary',
        onClick: async () => {
          try {
            await apiPost('/commands', { commands: model.favoriteCommands.filter((row, index) => keep.has(index)) })
            await loadState()
            close(undefined)
          } catch (error) {
            toastError(error)
          }
        },
      }),
    ],
  })
}

/** The saved-directory list. */
function openFavoriteDirsMenu(event) {
  const box = event.currentTarget.getBoundingClientRect()
  const server = selectedServer()
  if (!canUseSftp(server)) return
  const rows = favoriteDirsOf(server.id)
  const items = rows.map((path) => ({
    label: path,
    icon: 'folder',
    onClick: () => {
      openSftpFor(server.id)
      void expandThenEmit(path)
    },
  }))
  if (items.length === 0) items.push({ label: t('main.noFavoriteDirectories'), disabled: true, onClick: () => {} })
  items.push({ separator: true })
  items.push({
    label: t('main.favoriteCurrentDirectory'),
    icon: 'plus',
    disabled: sftpState().serverId !== server.id || sftpState().path.length === 0,
    onClick: () => void favoriteDirectory(sftpState().path),
  })
  for (const path of rows) {
    items.push({ label: t('main.delete') + ' ' + path, icon: 'trash', tone: 'danger', onClick: () => void unfavoriteDirectory(server.id, path) })
  }
  openContextMenu(box.left, box.bottom + 4, items, t('main.favoriteDirectories'))
}
// ------------------------------------------------------------ connections
/** Connect (or reconnect) one server, showing the host-key dialog when asked. */
async function connectServer(serverId) {
  try {
    await withBusy(() => apiPost('/connection/connect', { serverId }))
    toast(t('main.connected'), 'success')
    await loadState()
  } catch (error) {
    if (codeOf(error) === 'host_key') {
      openHostKeyDialog({ ...error, serverId })
      return
    }
    toastError(error)
  }
}

/**
 * Disconnect one server: its terminals, tunnels and SFTP channel.
 *
 * The confirmation is the reference's, including the three warning fragments it
 * assembled, and it only appears under the `close-tabs` behaviour — under
 * `keep-tabs` nothing is lost by disconnecting.
 */
async function disconnectServer(serverId) {
  const closeTabs = pref('closeBehavior', 'close-tabs') === 'close-tabs'
  if (closeTabs) {
    const warnings = []
    if (hasDirtyEditors(serverId)) warnings.push(t('main.disconnect.unsavedFiles'))
    if (model.tabs.some((tab) => tab.kind === 'terminal' && tab.serverId === serverId)) {
      warnings.push(t('main.disconnect.openTerminals'))
    }
    if (runningTaskCount() > 0) warnings.push(t('main.disconnect.runningTransfers'))
    if (warnings.length > 0) {
      const go = await confirmDialog({
        title: t('main.disconnect.confirmTitle'),
        message: t('main.disconnect.confirmMessage', { warnings: warnings.join('、'), action: t('main.menu.disconnect') }),
        confirmLabel: t('main.disconnect.continue'),
        danger: true,
      })
      if (!go) return
    }
  }
  try {
    await withBusy(() => apiPost('/connection/disconnect', { serverId }))
  } catch (error) {
    toastError(error)
  }
  if (closeTabs) {
    for (const tab of model.tabs.filter((row) => row.serverId === serverId)) {
      if (tab.kind === 'terminal') disposeTerminal(tab.id)
      if (tab.kind === 'editor') disposeEditor(tab.id)
    }
    model.tabs = model.tabs.filter((row) => row.serverId !== serverId)
    if (sftpState().serverId === serverId) closeSftp()
    model.activeTabId = model.tabs[0]?.id ?? null
  }
  toast(t('main.disconnected'), 'success')
  await loadState()
  await pushSubscriptions()
  scheduleWorkspaceSave()
}

/** Delete one stored connection, after the reference's confirmation. */
async function deleteServer(server) {
  const go = await confirmDialog({
    title: t('main.deleteServerTitle'),
    message: t('main.deleteServerConfirm', { name: server.name }),
    danger: true,
    confirmLabel: t('main.delete'),
  })
  if (!go) return
  try {
    await apiPost('/servers/delete', { serverId: server.id })
    for (const tab of model.tabs.filter((row) => row.serverId === server.id)) {
      if (tab.kind === 'terminal') disposeTerminal(tab.id)
      if (tab.kind === 'editor') disposeEditor(tab.id)
    }
    model.tabs = model.tabs.filter((row) => row.serverId !== server.id)
    if (sftpState().serverId === server.id) closeSftp()
    if (model.selectedServerId === server.id) model.selectedServerId = ''
    model.activeTabId = model.tabs[0]?.id ?? null
    await loadState()
    scheduleWorkspaceSave()
  } catch (error) {
    toastError(error)
  }
}

/** The right-click menu inside a terminal. */
function openTerminalMenu(entry, x, y) {
  const term = entry.term
  const selection = term === undefined ? '' : term.getSelection()
  openContextMenu(x, y, [
    {
      label: t('term.copySelection'),
      icon: 'copy',
      disabled: selection.length === 0,
      onClick: () => void copyText(selection, t('main.copied')),
    },
    {
      label: t('term.paste'),
      icon: 'file',
      onClick: async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (typeof text === 'string' && text.length > 0) sendInput(entry.sessionId, text)
        } catch (error) {
          toastError(error)
        }
      },
    },
    { separator: true },
    { label: t('term.clear'), icon: 'trash', onClick: () => term?.clear() },
    { label: t('term.searchPlaceholder'), icon: 'search', onClick: () => void findInTerminal(entry) },
    { label: t('ai.explain'), icon: 'sparkles', onClick: () => {
      toggleAiBar(true)
      void startAiJob('explain')
    } },
  ], t('main.title'))
}

// ------------------------------------------------------- workspace snapshot
let workspaceTimer = null

/**
 * Remember the layout, host-side.
 *
 * Only what a fresh panel needs to look the same: which server was selected, which
 * tabs existed (and their session ids, so a reload re-attaches to the same shells
 * rather than starting new ones), and the SFTP path.
 */
function workspaceSnapshot() {
  return {
    version: 1,
    selectedServerId: model.selectedServerId,
    activeTabId: model.activeTabId,
    tabs: model.tabs.slice(0, 24).map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      serverId: tab.serverId,
      sessionId: tab.sessionId,
      name: tab.name,
      filePath: tab.filePath,
      cwd: tab.cwd,
    })),
    sftp: { serverId: sftpState().serverId, path: sftpState().path },
  }
}

/** Debounced save. */
function scheduleWorkspaceSave() {
  if (!model.booted) return
  if (workspaceTimer !== null) clearTimeout(workspaceTimer)
  workspaceTimer = setTimeout(() => {
    workspaceTimer = null
    void apiPost('/workspace', { workspace: workspaceSnapshot() }).catch(() => {})
  }, 400)
}

/** Restore one snapshot. Sessions that no longer exist are dropped. */
function restoreWorkspace(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return
  const live = new Set(model.sessions.map((row) => row.sessionId))
  const tabs = []
  for (const row of Array.isArray(snapshot.tabs) ? snapshot.tabs : []) {
    if (typeof row !== 'object' || row === null) continue
    const server = serverById(row.serverId)
    if (server === undefined) continue
    if (row.kind === 'terminal') {
      // A terminal tab is only worth restoring when its session is still running:
      // otherwise the user gets a tab that has to be reconnected by hand.
      if (typeof row.sessionId !== 'string' || !live.has(row.sessionId)) continue
      tabs.push({ id: row.id ?? newId('tab'), kind: 'terminal', serverId: row.serverId, sessionId: row.sessionId, name: row.name ?? server.name, cwd: row.cwd })
      continue
    }
    if (row.kind === 'editor' && typeof row.filePath === 'string') {
      tabs.push({
        id: row.id ?? newId('tab'),
        kind: 'editor',
        serverId: row.serverId,
        filePath: row.filePath,
        name: row.name ?? baseName(row.filePath),
        content: '',
        original: '',
        dirty: false,
        loading: true,
      })
      continue
    }
    if (row.kind === 'desktop') tabs.push({ id: row.id ?? newId('tab'), kind: 'desktop', serverId: row.serverId, name: row.name ?? server.name })
  }
  model.tabs = tabs
  model.activeTabId = tabs.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : (tabs[0]?.id ?? null)
  if (typeof snapshot.selectedServerId === 'string' && serverById(snapshot.selectedServerId) !== undefined) {
    model.selectedServerId = snapshot.selectedServerId
  }
  const sftp = snapshot.sftp
  if (sftp !== null && typeof sftp === 'object' && typeof sftp.serverId === 'string' && sftp.serverId.length > 0) {
    if (canUseSftp(serverById(sftp.serverId))) openSftpFor(sftp.serverId, typeof sftp.path === 'string' ? sftp.path : undefined)
  }
}
// ---------------------------------------------------------------- seat mount
/** The sidebar entry button that opens the panel. */
function createEntry() {
  return el('button', {
    type: 'button',
    class: 'dsh-ot-entry',
    'data-dsh-ssh-entry': '',
    'aria-label': t('main.title'),
    onClick: () => setOpen(!model.open),
  },
  el('span', { class: 'dsh-ot-entry-icon', 'aria-hidden': 'true' }, icon('terminal', 15)),
  el('span', { class: 'dsh-ot-entry-label' }, t('main.title')),
  el('span', { class: 'dsh-ot-entry-stats' }))
}

/** Keep the entry's badge in step: live terminals and running transfers. */
function renderEntry() {
  if (entryEl === null) return
  setData(entryEl, 'active', model.open)
  const stats = entryEl.querySelector('.dsh-ot-entry-stats')
  if (stats === null) return
  const live = model.sessions.filter((row) => row.status === 'running').length
  const moving = runningTaskCount()
  const parts = []
  if (live > 0) parts.push(String(live))
  if (moving > 0) parts.push('↑' + moving)
  fill(stats, parts.join(' '))
}

/** The DSH shell's sidebar root, across its layout generations. */
function sidebarRoot() {
  const column = document.querySelector(SIDEBAR_SELECTOR)
  if (column === null) return undefined
  const logoRow = column.querySelector('[class*="logoRow"]')
  return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) ?? undefined
}

/** The centre column the panel takes over. */
function conversationColumn() {
  const column = document.querySelector(CONVERSATION_SELECTOR)
  return column === null ? undefined : column
}

/** Put the entry with the other panel plugins' entries. */
function placeEntry() {
  if (entryEl === null) return
  const root = sidebarRoot()
  if (root === undefined || !root.isConnected) return
  if (entryEl.parentElement === root) return
  const family = Array.from(root.children).filter((child) =>
    child instanceof HTMLElement && child.matches(ENTRY_SELECTOR + ', ' + SIBLING_ENTRIES))
  if (family.length > 0) {
    root.insertBefore(entryEl, family[family.length - 1].nextElementSibling)
    return
  }
  const nested = root.querySelector('button[class*="newSession"]')
  const row = nested === null || nested.parentElement === null
    ? null
    : (nested.parentElement === root ? nested : nested.closest('[class*="logoRow"]'))
  if (row !== null) {
    root.insertBefore(entryEl, row.nextElementSibling)
    return
  }
  root.append(entryEl)
}

/** Attach (or re-attach) the view as a trailing child of the centre column. */
function ensureView() {
  const column = conversationColumn()
  if (column === undefined) return
  if (viewEl === null || !viewEl.isConnected) {
    if (viewEl !== null) viewEl.remove()
    viewEl = el('div', { class: 'dsh-ot-view', 'data-dsh-ot-view': '' })
    panelEl = null
  }
  if (viewEl.parentElement !== column) column.append(viewEl)
  if (panelEl === null || !panelEl.isConnected) {
    viewEl.replaceChildren()
    buildPanel(viewEl)
    renderPanel()
  }
}

/** Open or close the panel, telling the sibling panels to stand down. */
function setOpen(open) {
  model.open = open
  if (open) {
    document.documentElement.setAttribute(OPEN_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    void bootData()
  } else {
    document.documentElement.removeAttribute(OPEN_ATTR)
    closeMenu()
  }
  emit()
}

/** First-open data load; subsequent opens only refresh. */
let dataBooted = false
async function bootData() {
  if (dataBooted) {
    await loadState()
    // Every terminal was hidden while the panel was closed, so xterm never measured
    // itself; a fit on reopen is what keeps the grid honest.
    for (const tab of model.tabs) if (tab.kind === 'terminal') focusTerminal(tab.id)
    return
  }
  dataBooted = true
  await loadState()
  const remembered = storeGet(STORE_KEYS.selectedServer, '')
  if (typeof remembered === 'string' && remembered.length > 0 && serverById(remembered) !== undefined) {
    model.selectedServerId = remembered
  }
  restoreWorkspace(model.workspace)
  model.booted = true
  emit()
  await pushSubscriptions()
}
