/**
 * The wire contract: stable error codes, the HTTP status each maps to, and every
 * input validator the routes use.
 *
 * Both halves of a route (GET query and POST body) go through the validators
 * here. That rule is inherited from the sibling otools-git plugin, where the GET
 * side once passed query strings straight into a `git` argv; the shapes that get
 * validated in THIS plugin are different but the reasoning is the same:
 *
 *   - a remote path reaches an SFTP request and, for "open terminal here", a
 *     shell command line, so it is normalised and quoted rather than trusted;
 *   - a local path reaches the host's own filesystem, so it must resolve INSIDE a
 *     folder DSH already has open (`workspaces.js` does the containment check —
 *     the browser can never name an arbitrary directory);
 *   - a listen host/port opens a socket on the user's machine, so the host is
 *     restricted to loopback unless the caller opts out explicitly.
 *
 * @module dsh-plugin-otools-term/shared/protocol
 */

/** Stable error codes. The browser localises these; the prose is the detail. */
export const ERR = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  noSession: 'no_session',
  authRequired: 'auth_required',
  hostKey: 'host_key',
  connect: 'connect',
  sftp: 'sftp',
  transfer: 'transfer',
  tunnel: 'tunnel',
  portInUse: 'port_in_use',
  desktop: 'desktop',
  ptyUnavailable: 'pty_unavailable',
  tooLarge: 'too_large',
  timeout: 'timeout',
  aiUnavailable: 'ai_unavailable',
  internal: 'internal',
}

/** HTTP status for one code. */
export function statusOf(code) {
  switch (code) {
    case ERR.invalidInput: return 400
    case ERR.authRequired: return 401
    case ERR.hostKey: return 409
    case ERR.notFound: return 404
    case ERR.noSession: return 410
    case ERR.portInUse: return 409
    case ERR.tooLarge: return 413
    case ERR.timeout: return 504
    case ERR.connect:
    case ERR.sftp:
    case ERR.transfer:
    case ERR.tunnel:
    case ERR.desktop:
    case ERR.ptyUnavailable:
    case ERR.aiUnavailable: return 502
    default: return 500
  }
}

/** One failure with a stable code. */
export class TermError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'TermError'
    this.code = code
    if (extra !== undefined && extra !== null) Object.assign(this, extra)
  }
}

/** Shorthand for the most common throw. */
export function invalid(message) {
  return new TermError(ERR.invalidInput, message)
}

// --------------------------------------------------------------- primitives

/** A required non-empty string, length-capped. */
export function normalizeText(value, name, max = 200) {
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  const text = value.trim()
  if (text.length === 0) throw invalid(`${name} is required`)
  if (text.length > max) throw invalid(`${name} is too long`)
  if (text.includes('\0')) throw invalid(`${name} must not contain NUL`)
  return text
}

/** An optional string; '' and nullish both mean "absent". */
export function optionalText(value, name, max = 200) {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeText(value, name, max)
}

/** A secret (password / passphrase / key body): kept verbatim, only length-capped. */
export function normalizeSecret(value, name, max = 64 * 1024) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  if (value.length > max) throw invalid(`${name} is too long`)
  if (value.includes('\0')) throw invalid(`${name} must not contain NUL`)
  return value
}

/** A boolean from JSON or a query string. */
export function normalizeFlag(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  return false
}

/** A TCP port. */
export function normalizePort(value, name = 'port', fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback
  const port = Number(value)
  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid(`${name} must be a port between 1 and 65535`)
  }
  return port
}

/**
 * A LISTEN port, where 0 additionally means "let the OS choose".
 *
 * The tunnel code already reports the port the OS picked (`address().port`), so 0 is a
 * usable answer to "I just need a free port" rather than an error — and it is how the
 * tests bind without racing for a fixed number.
 */
export function normalizeListenPort(value, name = 'listenPort', fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback
  const port = Number(value)
  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalid(`${name} must be a port between 0 and 65535`)
  }
  return port
}

/** A bounded integer. */
export function normalizeInt(value, name, { min, max, fallback }) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw invalid(`${name} must be a number`)
  const rounded = Math.round(number)
  if (rounded < min || rounded > max) throw invalid(`${name} must be between ${min} and ${max}`)
  return rounded
}

/** One of a closed set. */
export function normalizeEnum(value, allowed, name) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value
}

/** An id this plugin minted (server id, session id, task id, rule id). */
export function normalizeId(value, name = 'id') {
  const text = normalizeText(value, name, 120)
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) throw invalid(`${name} contains characters that are not allowed`)
  return text
}

// ------------------------------------------------------------------ network

/**
 * A hostname or IP. Deliberately permissive about the shape (an SSH host can be
 * an IPv6 literal or a `.local` name) but strict about what could smuggle
 * somewhere else: no whitespace, no shell metacharacters, no scheme, no path.
 */
export function normalizeHost(value, name = 'host') {
  const text = normalizeText(value, name, 255)
  if (/[\s"'`$;|&<>(){}[\]\\/]/.test(text)) throw invalid(`${name} contains characters that are not allowed`)
  if (text.startsWith('-')) throw invalid(`${name} must not start with -`)
  return text
}

/** A username, without the shell-hostile characters a login name never has. */
export function normalizeUser(value, name = 'username') {
  const text = normalizeText(value, name, 64)
  if (/[\s"'`$;|&<>()]/.test(text)) throw invalid(`${name} contains characters that are not allowed`)
  return text
}

/** Loopback names, the only addresses a listener binds to without an opt-out. */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']

/** Whether a listen address is loopback-only. */
export function isLoopback(host) {
  return LOOPBACK_HOSTS.includes(String(host).trim().toLowerCase())
}

/**
 * A listen address for a port forward or the SOCKS5 proxy.
 *
 * Binding a tunnel to `0.0.0.0` publishes a hole into the remote network to
 * everything that can reach this machine, so a non-loopback bind has to be asked
 * for explicitly (`allowPublic`) instead of happening because a field was left at
 * a default.
 */
export function normalizeListenHost(value, allowPublic) {
  const text = value === undefined || value === null || value === '' ? '127.0.0.1' : normalizeHost(value, 'listenHost')
  if (!isLoopback(text) && allowPublic !== true) {
    throw invalid('监听地址只能是 127.0.0.1（要对外暴露请勾选「允许非本机访问」）')
  }
  return text
}

// -------------------------------------------------------------------- paths

/**
 * A path on the REMOTE machine. Normalised to POSIX with a single leading slash
 * kept when present; a relative path is left relative (the browser sends `~` and
 * relative paths before the first `realpath` answer arrives).
 */
export function normalizeRemotePath(value, name = 'path') {
  const text = normalizeText(value, name, 4096)
  const posix = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = posix.length > 1 ? posix.replace(/\/+$/, '') : posix
  return trimmed.length === 0 ? '/' : trimmed
}

/** An optional remote path. */
export function optionalRemotePath(value, name = 'path') {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeRemotePath(value, name)
}

/** One path segment (a new file or folder name, or a rename target). */
export function normalizeSegment(value, name = 'name') {
  const text = normalizeText(value, name, 255)
  if (text === '.' || text === '..') throw invalid(`${name} must not be . or ..`)
  if (text.includes('/') || text.includes('\\')) throw invalid(`${name} must not contain a path separator`)
  return text
}

/** Join a remote directory and one segment. */
export function joinRemote(dir, segment) {
  const base = normalizeRemotePath(dir, 'dir')
  return base === '/' ? `/${segment}` : `${base}/${segment}`
}

/** The parent of a remote path ('/' at the root). */
export function parentRemote(path) {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  const cut = normalized.lastIndexOf('/')
  if (cut <= 0) return '/'
  return normalized.slice(0, cut)
}

/** The last segment of a remote path. */
export function baseRemote(path) {
  const normalized = normalizeRemotePath(path)
  const cut = normalized.lastIndexOf('/')
  return cut === -1 ? normalized : normalized.slice(cut + 1) || '/'
}

/**
 * Single-quote one argument for a POSIX shell. Used for the two places a remote
 * path reaches a command line rather than an SFTP request: `cd <dir>` when a
 * terminal is opened at a folder, and the `du`/`find` size probe.
 *
 * POSIX single quotes protect everything except a single quote itself, which is
 * closed, escaped and reopened — the standard `'\''` dance.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

// ------------------------------------------------------------- file modes

/** A unix mode from a `chmod` dialog: an octal string or a number. */
export function normalizeMode(value, name = 'mode') {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o7777) return value
  const text = normalizeText(value, name, 6)
  if (!/^[0-7]{3,4}$/.test(text)) throw invalid(`${name} must be 3 or 4 octal digits`)
  return Number.parseInt(text, 8)
}

/** `rwxr-xr-x` for a mode, the way the browser lists it. */
export function formatMode(mode) {
  const bits = typeof mode === 'number' ? mode & 0o7777 : 0
  let out = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const group = (bits >> shift) & 0o7
    out += (group & 4) === 4 ? 'r' : '-'
    out += (group & 2) === 2 ? 'w' : '-'
    out += (group & 1) === 1 ? 'x' : '-'
  }
  return out
}

// ------------------------------------------------------------------ servers

/** The three protocols the server list can hold. */
export const PROTOCOLS = ['ssh', 'rdp', 'vnc']

/** Default port per protocol, matching the reference. */
export const DEFAULT_PORTS = { ssh: 22, rdp: 3389, vnc: 5900 }

/** The two SSH auth types the reference offers. */
export const AUTH_TYPES = ['password', 'private_key']

/** The id of the built-in local-shell row (not a stored server). */
export const LOCAL_SERVER_ID = '__local__'

/** What happens to tabs when a connection is closed. */
export const CLOSE_BEHAVIORS = ['close-tabs', 'keep-tabs']

/**
 * One server definition as it is stored and sent to the browser. Secrets are NOT
 * part of this shape: `hasPassword` / `hasPassphrase` / `hasPrivateKeyBody` are
 * booleans, and the values themselves live in the 0600 secrets file.
 */
export function normalizeServer(value, options = {}) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  const protocol = PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'ssh'
  const server = {
    id: options.id !== undefined ? options.id : normalizeId(raw.id, 'id'),
    name: normalizeText(raw.name, 'name', 120),
    protocol,
    host: normalizeHost(raw.host),
    port: normalizePort(raw.port, 'port', DEFAULT_PORTS[protocol]),
    username: protocol === 'vnc' ? (optionalUser(raw.username) ?? '') : normalizeUser(raw.username),
    group: optionalText(raw.group, 'group', 60) ?? '',
    note: optionalText(raw.note, 'note', 500) ?? '',
  }
  if (protocol === 'ssh') {
    server.authType = AUTH_TYPES.includes(raw.authType) ? raw.authType : 'password'
    server.privateKeyPath = optionalText(raw.privateKeyPath, 'privateKeyPath', 4096) ?? ''
    server.useAgent = normalizeFlag(raw.useAgent)
    server.portForwards = Array.isArray(raw.portForwards)
      ? raw.portForwards.map((rule) => normalizePortForwardRule(rule)).slice(0, 64)
      : []
    server.socks5Proxy = normalizeSocks5(raw.socks5Proxy)
    server.keepaliveSeconds = normalizeInt(raw.keepaliveSeconds, 'keepaliveSeconds', { min: 0, max: 600, fallback: 30 })
  } else {
    server.authType = 'password'
    server.privateKeyPath = ''
    server.useAgent = false
    server.portForwards = []
    server.socks5Proxy = normalizeSocks5(undefined)
    server.keepaliveSeconds = 0
  }
  return server
}

/** A username that may be blank (VNC needs no login name). */
function optionalUser(value) {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeUser(value)
}

/** One local→remote forward rule. */
export function normalizePortForwardRule(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    id: raw.id === undefined || raw.id === null || raw.id === '' ? newId('rule') : normalizeId(raw.id, 'rule.id'),
    name: optionalText(raw.name, 'rule.name', 80) ?? '',
    listenHost: normalizeListenHost(raw.listenHost ?? raw.localHost, normalizeFlag(raw.allowPublic)),
    listenPort: normalizeListenPort(raw.listenPort ?? raw.localPort, 'rule.listenPort', 3307),
    remoteHost: normalizeHost(raw.remoteHost ?? '127.0.0.1', 'rule.remoteHost'),
    remotePort: normalizePort(raw.remotePort, 'rule.remotePort', 3306),
    allowPublic: normalizeFlag(raw.allowPublic),
    enabled: normalizeFlag(raw.enabled),
  }
}

/** The per-server SOCKS5 listener config. */
export function normalizeSocks5(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    listenHost: normalizeListenHost(raw.listenHost, normalizeFlag(raw.allowPublic)),
    listenPort: normalizeListenPort(raw.listenPort, 'socks5.listenPort', 1080),
    allowPublic: normalizeFlag(raw.allowPublic),
    enabled: normalizeFlag(raw.enabled),
  }
}

/** A fresh id with a readable prefix. */
export function newId(prefix) {
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

// -------------------------------------------------------------- terminal io

/** Terminal geometry bounds. Enough for a 4K screen, small enough to stay sane. */
export const TERM_MIN_COLS = 2
export const TERM_MAX_COLS = 1000
export const TERM_MIN_ROWS = 1
export const TERM_MAX_ROWS = 400

/** A `{cols, rows}` pair from a resize. */
export function normalizeSize(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    cols: normalizeInt(raw.cols, 'cols', { min: TERM_MIN_COLS, max: TERM_MAX_COLS, fallback: 80 }),
    rows: normalizeInt(raw.rows, 'rows', { min: TERM_MIN_ROWS, max: TERM_MAX_ROWS, fallback: 24 }),
  }
}

/** Max base64 input in one POST (a paste, not a file upload). */
export const MAX_INPUT_BYTES = 512 * 1024

/** Decode one base64 input chunk. */
export function decodeInput(value) {
  if (typeof value !== 'string') throw invalid('data must be a base64 string')
  if (value.length > MAX_INPUT_BYTES) throw invalid('input chunk is too large')
  if (!/^[A-Za-z0-9+/=\s]*$/.test(value)) throw invalid('data must be base64')
  return Buffer.from(value, 'base64')
}

// ------------------------------------------------------------------- limits

/** Biggest remote file the editor will open (the reference had no limit). */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024

/** Biggest single upload accepted in one request body. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

/** How much terminal output the host keeps per session for replay on re-attach. */
export const SCROLLBACK_BYTES = 256 * 1024

/** Ceiling on live sessions, so a runaway client cannot exhaust the machine. */
export const MAX_SESSIONS = 64

/** How long an orphaned session (no attached browser) stays alive. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

// ----------------------------------------------------------------- ai input

/** The AI bar's two jobs. */
export const AI_KINDS = ['command', 'explain']

/** Cap on the terminal tail handed to the model. */
export const AI_CONTEXT_CHARS = 12_000

/** Cap on the question the user types. */
export const AI_ASK_CHARS = 2_000

/**
 * Strip a code fence the model may have wrapped its answer in, then trim. Used
 * for the command suggestion, where the answer must be runnable text.
 */
export function unwrapModelText(text) {
  let value = String(text ?? '').trim()
  const fence = value.match(/^```[\w-]*\n([\s\S]*?)\n?```$/)
  if (fence !== null) value = fence[1].trim()
  return value
}

/** First line of a multi-line answer, for a one-line preview. */
export function firstLine(text) {
  const value = String(text ?? '')
  const cut = value.indexOf('\n')
  return (cut === -1 ? value : value.slice(0, cut)).trim()
}
