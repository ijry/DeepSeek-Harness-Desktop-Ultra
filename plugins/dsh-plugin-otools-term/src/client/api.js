/**
 * The transport: the `{ok, value}` / `{ok, error}` envelope the host speaks, the SSE
 * stream the panel listens on, the terminal WebSocket, and the batched HTTP fallback
 * for input.
 *
 * Terminal bytes prefer the WebSocket — DSH's webserver has an upgrade hook, so a
 * keystroke can be a frame instead of an HTTP request. Everything else (ledger
 * changes, transfer progress, tunnel state, AI deltas) stays on SSE.
 *
 * The HTTP path is kept as a fallback rather than deleted, because a build without the
 * upgrade hook, or a proxy that eats upgrades, must still give a working terminal:
 * keystrokes are then coalesced into one in-flight POST (`INPUT_FLUSH_MS`), so holding
 * a key is one request per frame rather than one per character, and output arrives on
 * the SSE stream instead.
 */

/** A rejected envelope, carrying the host's stable code. */
class ApiError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (extra !== undefined && extra !== null) Object.assign(this, extra)
  }
}

/** This panel's identity on the event stream (stable across reloads). */
function clientId() {
  let id = storeGet(STORE_KEYS.clientId, '')
  if (typeof id !== 'string' || id.length === 0) {
    id = newId('panel')
    storeSet(STORE_KEYS.clientId, id)
  }
  return id
}

/** GET one route. */
async function apiGet(path, params) {
  const query = new URLSearchParams()
  if (params !== undefined && params !== null) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      query.set(key, String(value))
    }
  }
  const suffix = query.toString()
  return unwrap(await fetch(ROUTE_PREFIX + path + (suffix.length > 0 ? '?' + suffix : ''), {
    headers: { accept: 'application/json' },
  }))
}

/** POST one route with a JSON body. */
async function apiPost(path, body) {
  return unwrap(await fetch(ROUTE_PREFIX + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))
}

/** Unwrap one envelope, throwing an ApiError on failure. */
async function unwrap(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('internal', 'HTTP ' + response.status + '：返回的不是 JSON')
  }
  if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload.value
  const error = payload !== null && typeof payload === 'object' ? payload.error : undefined
  throw new ApiError(
    error !== undefined && typeof error.code === 'string' ? error.code : 'internal',
    error !== undefined && typeof error.message === 'string' ? error.message : 'HTTP ' + response.status,
    error,
  )
}

/** Run one request with the busy counter held. */
async function withBusy(run) {
  model.busy += 1
  emit()
  try {
    return await run()
  } finally {
    model.busy -= 1
    emit()
  }
}

// --------------------------------------------------------------------- SSE
let sse = null

/**
 * Subscribe to the host's event stream.
 *
 * Frame kinds: `hello` (a whole `/state`), `state` (the ledger changed — refetch),
 * `session`, `session-removed`, `connection`, `output`, `overflow`, `task`, `tasks`,
 * `tunnels`, `job`, `job-delta`.
 */
function startSse(handlers) {
  stopSse()
  if (typeof window.EventSource !== 'function') return
  let source
  try {
    source = new window.EventSource(SSE_PATH + '?clientId=' + encodeURIComponent(clientId()))
  } catch (error) {
    console.warn(LOG + ' event stream unavailable:', messageOf(error))
    return
  }
  sse = source

  source.addEventListener('open', () => {
    model.connected = true
    emit()
    // A reconnected stream has forgotten which sessions this panel shows.
    void pushSubscriptions()
  })
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; the panel only reflects the state.
    model.connected = false
    emit()
  })
  source.addEventListener('hello', (event) => {
    model.connected = true
    const data = parseEvent(event)
    if (data !== undefined) applyState(data)
    emit()
    void pushSubscriptions()
    if (handlers.onHello !== undefined) handlers.onHello(data)
  })
  source.addEventListener('state', (event) => {
    const data = parseEvent(event)
    if (data !== undefined && typeof data.revision === 'number' && data.revision === model.revision) return
    void loadState()
  })
  source.addEventListener('session', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.sessionId !== 'string') return
    mergeSession(data)
    if (handlers.onSession !== undefined) handlers.onSession(data)
    emit()
  })
  source.addEventListener('session-removed', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.sessionId !== 'string') return
    model.sessions = model.sessions.filter((row) => row.sessionId !== data.sessionId)
    if (handlers.onSessionRemoved !== undefined) handlers.onSessionRemoved(data.sessionId)
    emit()
  })
  source.addEventListener('connection', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.serverId !== 'string') return
    const next = { ...model.connections }
    next[data.serverId] = { ...(next[data.serverId] ?? {}), status: data.status, error: data.error }
    model.connections = next
    emit()
  })
  source.addEventListener('output', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.sessionId !== 'string' || typeof data.data !== 'string') return
    // The whole frame is handed over, not just the bytes: it carries the byte offset
    // the replay splice needs, and dropping it here would make a re-attach over the
    // SSE fallback print the last screenful twice.
    if (handlers.onOutput !== undefined) handlers.onOutput(data.sessionId, data.data, data)
  })
  source.addEventListener('overflow', (event) => {
    const data = parseEvent(event)
    if (data !== undefined && handlers.onOverflow !== undefined) handlers.onOverflow(data.sessionId)
  })
  source.addEventListener('task', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.id !== 'string') return
    mergeTask(data)
    emit()
  })
  source.addEventListener('tasks', (event) => {
    const data = parseEvent(event)
    if (data !== undefined && Array.isArray(data.tasks)) model.tasks = data.tasks
    emit()
  })
  source.addEventListener('tunnels', (event) => {
    const data = parseEvent(event)
    if (data !== undefined && data.tunnels !== undefined) model.tunnels = data.tunnels
    emit()
  })
  source.addEventListener('job', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.id !== 'string') return
    mergeJob(data)
    emit()
  })
  source.addEventListener('job-delta', (event) => {
    const data = parseEvent(event)
    if (data === undefined || typeof data.id !== 'string' || typeof data.delta !== 'string') return
    const job = model.jobs.find((row) => row.id === data.id)
    if (job === undefined) return
    job.text = (job.text ?? '') + data.delta
    emit()
  })
}

/** Parse one SSE payload, tolerating a truncated frame. */
function parseEvent(event) {
  try {
    const data = JSON.parse(event.data)
    return data === null || typeof data !== 'object' ? undefined : data
  } catch {
    return undefined
  }
}

/** Close the stream. */
function stopSse() {
  if (sse !== null) {
    try {
      sse.close()
    } catch { /* already closed */ }
    sse = null
  }
}

/** Tell the host which sessions this panel is showing. */
async function pushSubscriptions() {
  const sessionIds = model.tabs.filter((tab) => tab.kind === 'terminal' && typeof tab.sessionId === 'string')
    .map((tab) => tab.sessionId)
  if (socketSend({ kind: 'subscribe', sessionIds })) return
  try {
    await apiPost('/terminal/subscribe', { clientId: clientId(), sessionIds })
  } catch (error) {
    console.warn(LOG + ' subscribe failed:', messageOf(error))
  }
}

// ------------------------------------------------------------ terminal socket
const socketState = { socket: null, ready: false, attempts: 0, timer: null, handlers: null }

/** Whether the terminal socket is usable right now. */
function socketOpen() {
  return socketState.ready && socketState.socket !== null && socketState.socket.readyState === 1
}

/** Send one frame over the socket; false when there is no socket to send it on. */
function socketSend(message) {
  if (!socketOpen()) return false
  try {
    socketState.socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

/**
 * Open the terminal socket, retrying a few times before settling for HTTP.
 *
 * A missing `WebSocket` (an old browser, or the test's synthetic DOM) and a refused
 * upgrade land in the same place: `socketOpen()` stays false and every caller takes
 * the HTTP path.
 */
function startSocket(handlers) {
  socketState.handlers = handlers
  if (typeof window.WebSocket !== 'function') return
  stopSocket()
  const origin = String(window.location?.origin ?? '')
  const base = origin.startsWith('https') ? 'wss' + origin.slice(5) : (origin.startsWith('http') ? 'ws' + origin.slice(4) : '')
  if (base.length === 0) return
  let socket
  try {
    socket = new window.WebSocket(base + SOCKET_PATH + '?clientId=' + encodeURIComponent(clientId()))
  } catch (error) {
    console.warn(LOG + ' terminal socket unavailable:', messageOf(error))
    return
  }
  socketState.socket = socket
  socket.addEventListener('open', () => {
    socketState.ready = true
    socketState.attempts = 0
    void pushSubscriptions()
  })
  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const data = frame.data
    if (frame.event === 'output' && data !== null && typeof data === 'object') {
      if (handlers.onOutput !== undefined) handlers.onOutput(data.sessionId, data.data, data)
      return
    }
    if (frame.event === 'overflow' && data !== null && typeof data === 'object') {
      if (handlers.onOverflow !== undefined) handlers.onOverflow(data.sessionId)
      return
    }
    if (frame.event === 'socket-error' && data !== null && typeof data === 'object') {
      console.warn(LOG + ' socket rejected a frame:', data.message)
    }
  })
  const closed = () => {
    socketState.ready = false
    socketState.socket = null
    // Three tries, then the HTTP path stands: a panel that cannot upgrade should stop
    // hammering the server about it.
    if (socketState.attempts >= 3 || socketState.timer !== null) return
    socketState.attempts += 1
    socketState.timer = setTimeout(() => {
      socketState.timer = null
      if (socketState.handlers !== null) startSocket(socketState.handlers)
    }, 1000 * socketState.attempts)
  }
  socket.addEventListener('close', closed)
  socket.addEventListener('error', closed)
}

/** Close the terminal socket. */
function stopSocket() {
  if (socketState.timer !== null) {
    clearTimeout(socketState.timer)
    socketState.timer = null
  }
  const socket = socketState.socket
  socketState.socket = null
  socketState.ready = false
  if (socket !== null) {
    try {
      socket.close()
    } catch { /* already closed */ }
  }
}

// ----------------------------------------------------------------- loaders
/** The whole state, in one call. */
async function loadState() {
  try {
    applyState(await apiGet('/state'))
  } catch (error) {
    console.warn(LOG + ' state unavailable:', messageOf(error))
  }
  emit()
}

/** Persist a preference patch, optimistically applied first. */
async function savePrefs(patch) {
  model.prefs = { ...model.prefs, ...patch }
  emit()
  try {
    const value = await apiPost('/prefs', { prefs: patch })
    model.prefs = value.prefs
  } catch (error) {
    console.warn(LOG + ' prefs not saved:', messageOf(error))
  }
  emit()
}

// ------------------------------------------------------------- terminal io
/** Pending bytes per session, and the in-flight promise that will send them. */
const inputQueues = new Map()

/**
 * Queue bytes for one session.
 *
 * With the socket up this is one frame per call — a terminal wants the keystroke gone
 * now. Without it, one POST at a time per session: while a request is in flight new
 * keystrokes accumulate and go out together when it settles, which bounds the request
 * rate without ever reordering input.
 */
function sendInput(sessionId, text) {
  if (socketSend({ kind: 'input', sessionId, data: base64OfText(text) })) return
  const queue = inputQueues.get(sessionId) ?? { pending: '', sending: false, timer: null }
  queue.pending += text
  inputQueues.set(sessionId, queue)
  if (queue.sending || queue.timer !== null) return
  queue.timer = setTimeout(() => {
    queue.timer = null
    void flushInput(sessionId)
  }, INPUT_FLUSH_MS)
}

/** Report a new terminal size, over whichever channel is up. */
function sendResize(sessionId, cols, rows) {
  if (socketSend({ kind: 'resize', sessionId, cols, rows })) return
  void apiPost('/terminal/resize', { sessionId, cols, rows }).catch(() => {})
}

/** Send whatever is queued for one session. */
async function flushInput(sessionId) {
  const queue = inputQueues.get(sessionId)
  if (queue === undefined || queue.sending || queue.pending.length === 0) return
  const payload = queue.pending
  queue.pending = ''
  queue.sending = true
  try {
    await apiPost('/terminal/input', { sessionId, data: base64OfText(payload) })
  } catch (error) {
    if (codeOf(error) === 'no_session') {
      const session = sessionById(sessionId)
      if (session !== undefined) mergeSession({ ...session, status: 'closed' })
      emit()
    } else {
      console.warn(LOG + ' input dropped:', messageOf(error))
    }
  } finally {
    queue.sending = false
    if (queue.pending.length > 0) void flushInput(sessionId)
  }
}

/** UTF-8 text → base64, without assuming a Buffer. */
function base64OfText(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

/** base64 → a Uint8Array (terminal output arrives this way). */
function bytesOfBase64(value) {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Forget one session's queue. */
function dropInputQueue(sessionId) {
  const queue = inputQueues.get(sessionId)
  if (queue !== undefined && queue.timer !== null) clearTimeout(queue.timer)
  inputQueues.delete(sessionId)
}

// ------------------------------------------------------------- file bytes
/**
 * Upload one File to a remote directory.
 *
 * `XMLHttpRequest` rather than fetch: it is the only way to get upload progress in a
 * browser, and a 2 GB file with no progress bar is indistinguishable from a hang.
 */
function uploadFile(serverId, dir, file, name, onProgress) {
  return new Promise((resolvePromise, rejectPromise) => {
    const query = new URLSearchParams({ serverId, dir, name: name ?? file.name })
    const request = new XMLHttpRequest()
    request.open('POST', ROUTE_PREFIX + '/sftp/upload?' + query.toString())
    request.responseType = 'json'
    if (onProgress !== undefined && request.upload !== null) {
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      })
    }
    request.addEventListener('load', () => {
      const payload = request.response
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        resolvePromise(payload.value)
        return
      }
      const error = payload !== null && typeof payload === 'object' ? payload.error : undefined
      rejectPromise(new ApiError(error?.code ?? 'internal', error?.message ?? 'HTTP ' + request.status))
    })
    request.addEventListener('error', () => rejectPromise(new ApiError('internal', '上传请求失败')))
    request.addEventListener('abort', () => rejectPromise(new ApiError('internal', '上传已取消')))
    request.send(file)
  })
}

/** Start a browser download of one remote path (a file, or a folder as tar). */
function downloadPath(serverId, path, kind) {
  const query = new URLSearchParams({ serverId, path })
  if (kind !== undefined) query.set('kind', kind)
  // A hidden anchor rather than window.open: no popup blocker, and the
  // Content-Disposition filename is honoured.
  const link = el('a', { href: ROUTE_PREFIX + '/sftp/download?' + query.toString(), download: '' })
  document.body.append(link)
  link.click()
  link.remove()
}
