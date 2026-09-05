/**
 * The model: one plain object, plus a subscriber list.
 *
 * The panel repaints from this on every change, EXCEPT for the two things that
 * cannot survive a repaint — a live xterm instance and an editor textarea's caret.
 * Those live in per-tab pane elements that `shell.js` reconciles instead of
 * rebuilding (see `syncPanes`), which is the one structural difference from the
 * sibling plugins' "repaint everything" approach.
 */

const model = {
  // shell
  open: false,
  connected: false,
  booted: false,
  busy: 0,
  revision: 0,
  language: 'zh',
  // ledger
  servers: [],
  favoriteCommands: [],
  favoriteDirs: {},
  prefs: {},
  workspace: null,
  knownHosts: [],
  workspaces: [],
  // runtime
  sessions: [],
  tasks: [],
  tunnels: { portForwards: [], socks5: [] },
  connections: {},
  jobs: [],
  ai: { available: false, reason: '' },
  local: { pty: false, reason: '', shell: '', platform: '' },
  desktop: { platform: '', rdp: [], vnc: [] },
  vendor: { ready: true, missing: [] },
  // selection
  selectedServerId: '',
  tabs: [],
  activeTabId: null,
  // panes
  sftp: {
    serverId: '',
    path: '',
    loading: false,
    error: '',
    children: {},
    expanded: {},
    search: { keyword: '', loading: false, items: [], truncated: false, active: false },
  },
  drawerOpen: false,
  aiOpen: false,
  aiJobId: null,
  hostKey: null,
  serverFilter: '',
}

/** The local-shell row, which is not a stored server. */
function localServer() {
  return {
    id: LOCAL_SERVER_ID,
    name: t('main.localTerminal'),
    protocol: 'ssh',
    host: '',
    port: 0,
    username: '',
    local: true,
  }
}

/** Every row the sidebar shows, local shell first (the reference's order). */
function allServers() {
  const filter = model.serverFilter.trim().toLowerCase()
  const rows = [localServer(), ...model.servers]
  if (filter.length === 0) return rows
  return rows.filter((row) => (
    row.name.toLowerCase().includes(filter) ||
    String(row.host).toLowerCase().includes(filter) ||
    String(row.group ?? '').toLowerCase().includes(filter)
  ))
}

/** One server row by id (including the local one). */
function serverById(id) {
  if (id === LOCAL_SERVER_ID) return localServer()
  return model.servers.find((row) => row.id === id)
}

/** The selected row, or undefined. */
function selectedServer() {
  return serverById(model.selectedServerId)
}

/** Whether a row can open a terminal. */
function canOpenTerminal(server) {
  return server !== undefined && (server.id === LOCAL_SERVER_ID || server.protocol === 'ssh')
}

/** Whether a row can browse files. */
function canUseSftp(server) {
  return server !== undefined && server.id !== LOCAL_SERVER_ID && server.protocol === 'ssh'
}

/** Whether a row launches a desktop client. */
function canLaunchDesktop(server) {
  return server !== undefined && server.id !== LOCAL_SERVER_ID && (server.protocol === 'rdp' || server.protocol === 'vnc')
}

/** The connection state one row shows as a dot. */
function connectionState(serverId) {
  if (serverId === LOCAL_SERVER_ID) return 'local'
  const row = model.connections[serverId]
  if (row === undefined) return 'disconnected'
  return row.status ?? 'disconnected'
}

/** One preference, with its default. */
function pref(key, fallback) {
  const value = model.prefs[key]
  return value === undefined ? fallback : value
}

/** Tabs, in creation order. */
function tabsOf(serverId) {
  return model.tabs.filter((tab) => tab.serverId === serverId)
}

/** One tab by id. */
function tabById(id) {
  return model.tabs.find((tab) => tab.id === id)
}

/** The active tab, or undefined. */
function activeTab() {
  return tabById(model.activeTabId)
}

/** One session record by id. */
function sessionById(sessionId) {
  return model.sessions.find((row) => row.sessionId === sessionId)
}

/** How many transfers are still moving. */
function runningTaskCount() {
  return model.tasks.filter((task) => task.status === 'pending' || task.status === 'transferring').length
}

/** Whether one forwarding rule is up. */
function isForwardRunning(serverId, ruleId) {
  return model.tunnels.portForwards.some((row) => row.serverId === serverId && row.ruleId === ruleId)
}

/** Whether one server's SOCKS5 proxy is up. */
function isSocksRunning(serverId) {
  return model.tunnels.socks5.some((row) => row.serverId === serverId)
}

/** Whether a server has any tunnel up (the sidebar shows a badge). */
function hasTunnels(serverId) {
  return model.tunnels.portForwards.some((row) => row.serverId === serverId) || isSocksRunning(serverId)
}

/** The favourite directories of one server. */
function favoriteDirsOf(serverId) {
  const rows = model.favoriteDirs[serverId]
  return Array.isArray(rows) ? rows : []
}

// ------------------------------------------------------------------ events
const listeners = new Set()

/** Subscribe to model changes; returns the unsubscriber. */
function onModel(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Announce a change. A throwing listener must not stop the others. */
function emit() {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error(LOG + ' listener failed:', messageOf(error))
    }
  }
}

/** Merge a `/state` (or `hello`) payload into the model. */
function applyState(value) {
  if (value === null || typeof value !== 'object') return
  if (typeof value.revision === 'number') model.revision = value.revision
  if (typeof value.language === 'string') lang.current = value.language === 'en' ? 'en' : 'zh'
  if (Array.isArray(value.servers)) model.servers = value.servers
  if (Array.isArray(value.favoriteCommands)) model.favoriteCommands = value.favoriteCommands
  if (value.favoriteDirs !== null && typeof value.favoriteDirs === 'object') model.favoriteDirs = value.favoriteDirs
  if (value.prefs !== null && typeof value.prefs === 'object') model.prefs = value.prefs
  if (Object.hasOwn(value, 'workspace')) model.workspace = value.workspace
  if (Array.isArray(value.sessions)) model.sessions = value.sessions
  if (Array.isArray(value.tasks)) model.tasks = value.tasks
  if (value.tunnels !== null && typeof value.tunnels === 'object') model.tunnels = value.tunnels
  if (value.connections !== null && typeof value.connections === 'object') model.connections = value.connections
  if (Array.isArray(value.jobs)) model.jobs = value.jobs
  if (Array.isArray(value.knownHosts)) model.knownHosts = value.knownHosts
  if (Array.isArray(value.workspaces)) model.workspaces = value.workspaces
  if (value.ai !== null && typeof value.ai === 'object') model.ai = value.ai
  if (value.local !== null && typeof value.local === 'object') model.local = value.local
  if (value.desktop !== null && typeof value.desktop === 'object') model.desktop = value.desktop
  if (value.vendor !== null && typeof value.vendor === 'object') model.vendor = value.vendor
}

/** Merge one session record. */
function mergeSession(record) {
  const index = model.sessions.findIndex((row) => row.sessionId === record.sessionId)
  if (index === -1) model.sessions = [...model.sessions, record]
  else {
    const next = [...model.sessions]
    next[index] = record
    model.sessions = next
  }
}

/** Merge one transfer task, newest first. */
function mergeTask(record) {
  const index = model.tasks.findIndex((row) => row.id === record.id)
  if (index === -1) model.tasks = [record, ...model.tasks].slice(0, 200)
  else {
    const next = [...model.tasks]
    next[index] = record
    model.tasks = next
  }
}

/** Merge one AI job. */
function mergeJob(record) {
  const index = model.jobs.findIndex((row) => row.id === record.id)
  if (index === -1) model.jobs = [record, ...model.jobs].slice(0, 20)
  else {
    const next = [...model.jobs]
    next[index] = record
    model.jobs = next
  }
}

/** The AI job the bar is showing. */
function activeJob() {
  return model.jobs.find((row) => row.id === model.aiJobId)
}
