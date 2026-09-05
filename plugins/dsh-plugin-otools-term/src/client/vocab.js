/**
 * Vocabulary shared by the whole browser bundle: ids, selectors, route paths and
 * the handful of protocol constants this side needs.
 *
 * The protocol constants are a hand-kept COPY of `src/shared/protocol.js` — the
 * bundle has no module resolution, so it cannot import it, and only the values the
 * browser actually needs are duplicated. `test/client-mirror.test.mjs` keeps the two
 * from drifting.
 */

const PLUGIN_ID = 'dsh-plugin-otools-term'
const ROUTE_PREFIX = '/dsh-plugin-otools-term'
const SSE_PATH = '/dsh-plugin-otools-term/events'
const SOCKET_PATH = '/dsh-plugin-otools-term/socket'
const VENDOR_PREFIX = '/dsh-plugin-otools-term/vendor'
const STYLE_ID = 'dsh-plugin-otools-term-style'
const PANEL_NAME = 'dsh-plugin-otools-term'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const OPEN_ATTR = 'data-dsh-ot-open'
/** The entry attribute the sibling panels already list as a peer. */
const ENTRY_SELECTOR = '[data-dsh-ssh-entry]'
const LOG = '[' + PLUGIN_ID + ']'

/** Seats in the DSH shell, across the layout generations it has shipped. */
const CONVERSATION_SELECTOR =
  '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
const SIDEBAR_SELECTOR =
  '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
/** Sibling panel plugins: their entries stay grouped and only one panel is open. */
const SIBLING_ENTRIES =
  '[data-dsh-cgtb-entry], [data-dsh-taskboard-entry], [data-dsh-repopanel-entry], [data-dsh-otools-git-entry]'

/** localStorage keys. Only browser-local choices live here; the rest is the ledger. */
const STORAGE_PREFIX = PLUGIN_ID + ':'
const STORE_KEYS = {
  clientId: STORAGE_PREFIX + 'clientId',
  selectedServer: STORAGE_PREFIX + 'selectedServer',
}

/** The id of the built-in local-shell row (mirrors shared/protocol.js). */
const LOCAL_SERVER_ID = '__local__'

/** Protocols a stored connection can have. */
const PROTOCOLS = ['ssh', 'rdp', 'vnc']

/** Default port per protocol. */
const DEFAULT_PORTS = { ssh: 22, rdp: 3389, vnc: 5900 }

/** The two SSH auth types. */
const AUTH_TYPES = ['password', 'private_key']

/** What happens to tabs when a connection is closed. */
const CLOSE_BEHAVIORS = ['close-tabs', 'keep-tabs']

/** Sidebar geometry, verbatim from the reference. */
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_DEFAULT_WIDTH = 260
const SERVER_LIST_MIN_HEIGHT = 148
const SFTP_PANEL_MIN_HEIGHT = 220

/** How long the panel waits before flushing typed bytes to the host. */
const INPUT_FLUSH_MS = 8

/** How much of a session's output the browser keeps for the AI bar's context. */
const CLIENT_SCROLLBACK_CHARS = 40_000

/** Message of an unknown throwable, never `[object Object]`. */
function messageOf(error) {
  if (error === null || error === undefined) return t('err.unknown')
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Stable code of an error envelope, or ''. */
function codeOf(error) {
  return error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
}

/** Localise the host's stable error codes; unknown codes keep their prose. */
function friendlyError(error) {
  const message = messageOf(error)
  const code = codeOf(error)
  if (code.length === 0) return message
  const known = t('err.' + code)
  return known === 'err.' + code ? message : known + '：' + message
}

/** The basename of a POSIX path. */
function baseName(path) {
  const text = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = text.lastIndexOf('/')
  return cut === -1 ? text : text.slice(cut + 1)
}

/** The parent of a POSIX path ('/' at the root). */
function parentPath(path) {
  const text = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.length === 0 || text === '/') return '/'
  const cut = text.lastIndexOf('/')
  return cut <= 0 ? '/' : text.slice(0, cut)
}

/** Join a directory and one segment. */
function joinPath(dir, name) {
  const base = String(dir ?? '/').replace(/\/+$/, '')
  return base.length === 0 ? '/' + name : base + '/' + name
}

/** A byte count as the panel shows it. */
function formatBytes(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
  return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

/** A unix timestamp as a short local date-time. */
function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '-'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** A random id with a readable prefix (mirrors the host's `newId`). */
function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
