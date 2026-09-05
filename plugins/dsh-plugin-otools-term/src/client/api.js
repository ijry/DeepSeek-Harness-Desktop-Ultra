/**
 * The transport: the `{ok, value}` / `{ok, error}` envelope the host speaks, the one
 * event channel the panel listens on, and the batched HTTP fallback for input.
 *
 * The channel is a WebSocket whenever DSH's webserver offers an upgrade hook, and an
 * SSE stream only when it does not. That preference is about a budget the whole page
 * shares rather than about latency: a browser allows about six concurrent HTTP/1.1
 * connections per ORIGIN, every DSH panel plugin lives on the shell's origin, and an
 * EventSource holds one of those six for as long as the panel is loaded. Once six
 * panels stream at the same time, every other request on the origin queues forever —
 * no response, no error, no timeout. This panel used to hang on "正在启动会话…"
 * exactly there: its `<script src=…/vendor/xterm.js>` never got a connection, so it
 * fired neither `load` nor `error` and the attach waited for a promise that could
 * never settle. A WebSocket is exempt from that pool, so the socket carries
 * everything and the fallback stream is closed the moment the socket is up.
 *
 * The HTTP fallback is kept rather than deleted, because a build without the upgrade
 * hook, or a proxy that eats upgrades, must still give a working terminal: keystrokes
 * are then coalesced into one in-flight POST (`INPUT_FLUSH_MS`), so holding a key is
 * one request per frame rather than one per character.
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
  return unwrap(await fetchWithDeadline(ROUTE_PREFIX + path + (suffix.length > 0 ? '?' + suffix : ''), {
    headers: { accept: 'application/json' },
  }))
}

/** POST one route with a JSON body. */
async function apiPost(path, body) {
  return unwrap(await fetchWithDeadline(ROUTE_PREFIX + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))
}

/**
 * One JSON request, with a deadline.
 *
 * A same-origin request that cannot get a connection does not fail — it waits, with
 * no event of any kind. Every await in this panel therefore has an end: a spinner
 * that turns into an error the user can act on beats one that spins for the rest of
 * the session. Only the JSON routes go through here; uploads (XHR) and downloads (an
 * anchor) are allowed to take as long as their bytes need.
 */
async function fetchWithDeadline(url, init) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(API_TIMEOUT_MS)
    : undefined
  try {
    return await fetch(url, signal === undefined ? init : { ...init, signal })
  } catch (error) {
    // An aborted fetch and a refused one both land here; the timeout is the only one
    // worth naming, because its cause (a starved connection pool, a host that stopped
    // answering) is not obvious from "failed to fetch".
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new ApiError(timedOut ? 'timeout' : 'internal', timedOut ? t('err.stalled') : messageOf(error))
  }
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

// ----------------------------------------------------------------- streams
let sse = null

/** Every frame kind the host sends. Both channels carry all of them. */
const STREAM_EVENTS = [
  'hello', 'state', 'session', 'session-removed', 'connection', 'output', 'overflow',
  'task', 'tasks', 'tunnels', 'job', 'job-delta',
]

/** The channel manager: which one is up, and whether a fallback is armed. */
const streamState = { handlers: null, started: false, fallbackTimer: null }

/**
 * Open the panel's event channel: the WebSocket first, the SSE stream only if the
 * socket has not come up in `SOCKET_GRACE_MS`.
 *
 * Both are started in that order rather than at once so the common case costs the page
 * no HTTP connection at all (see the file header); a build with no upgrade hook waits
 * the grace period once and then streams over SSE for the rest of the session.
 */
function startStreams(handlers) {
  streamState.handlers = handlers
  streamState.started = true
  startSocket(handlers)
  if (socketState.socket === null) {
    // No WebSocket to try: stream now rather than after a pointless wait.
    startSse(handlers)
    return
  }
  armSseFallback()
}

/** Arm the SSE fallback, unless the socket beats it. */
function armSseFallback() {
  if (streamState.fallbackTimer !== null || sse !== null) return
  streamState.fallbackTimer = setTimeout(() => {
    streamState.fallbackTimer = null
    if (!streamState.started || socketOpen()) return
    startSse(streamState.handlers ?? {})
  }, SOCKET_GRACE_MS)
}

/** Disarm the fallback (the socket made it). */
function disarmSseFallback() {
  if (streamState.fallbackTimer === null) return
  clearTimeout(streamState.fallbackTimer)
  streamState.fallbackTimer = null
}

/** Close both channels (panel teardown). */
function stopStreams() {
  streamState.started = false
  streamState.handlers = null
  disarmSseFallback()
  stopSse()
  stopSocket()
}

/**
 * Apply one frame, whichever channel it arrived on.
 *
 * The socket wraps a frame as `{event, data}` and SSE as a named event with a JSON
 * body, so this is the one place that knows what each kind means. An unknown kind is
 * ignored: the host may be newer than this bundle.
 */
function applyFrame(event, data, handlers) {
  if (data === undefined) return
  if (event === 'hello') {
    model.connected = true
    applyState(data)
    emit()
    void pushSubscriptions()
    if (handlers.onHello !== undefined) handlers.onHello(data)
    return
  }
  if (event === 'state') {
    // A revision the panel already has needs no refetch.
    if (typeof data.revision === 'number' && data.revision === model.revision) return
    void loadState()
    return
  }
  if (event === 'session') {
    if (typeof data.sessionId !== 'string') return
    mergeSession(data)
    if (handlers.onSession !== undefined) handlers.onSession(data)
    emit()
    return
  }
  if (event === 'session-removed') {
    if (typeof data.sessionId !== 'string') return
    model.sessions = model.sessions.filter((row) => row.sessionId !== data.sessionId)
    if (handlers.onSessionRemoved !== undefined) handlers.onSessionRemoved(data.sessionId)
    emit()
    return
  }
  if (event === 'connection') {
    if (typeof data.serverId !== 'string') return
    const next = { ...model.connections }
    next[data.serverId] = { ...(next[data.serverId] ?? {}), status: data.status, error: data.error }
    model.connections = next
    emit()
    return
  }
  if (event === 'output') {
    if (typeof data.sessionId !== 'string' || typeof data.data !== 'string') return
    // The whole frame is handed over, not just the bytes: it carries the byte offset
    // the replay splice needs, and dropping it here would make a re-attach print the
    // last screenful twice.
    if (handlers.onOutput !== undefined) handlers.onOutput(data.sessionId, data.data, data)
    return
  }
  if (event === 'overflow') {
    if (handlers.onOverflow !== undefined) handlers.onOverflow(data.sessionId)
    return
  }
  if (event === 'task') {
    if (typeof data.id !== 'string') return
    mergeTask(data)
    emit()
    return
  }
  if (event === 'tasks') {
    if (Array.isArray(data.tasks)) model.tasks = data.tasks
    emit()
    return
  }
  if (event === 'tunnels') {
    if (data.tunnels !== undefined) model.tunnels = data.tunnels
    emit()
    return
  }
  if (event === 'job') {
    if (typeof data.id !== 'string') return
    mergeJob(data)
    emit()
    return
  }
  if (event === 'job-delta') {
    if (typeof data.id !== 'string' || typeof data.delta !== 'string') return
    const job = model.jobs.find((row) => row.id === data.id)
    if (job === undefined) return
    job.text = (job.text ?? '') + data.delta
    emit()
  }
}

/**
 * Subscribe over SSE. Idempotent: a stream that is already open is left alone, so the
 * socket's retry loop cannot churn through EventSources.
 */
function startSse(handlers) {
  if (sse !== null) return
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
  for (const name of STREAM_EVENTS) {
    source.addEventListener(name, (event) => applyFrame(name, parseEvent(event), handlers))
  }
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
 * upgrade land in the same place: `socketOpen()` stays false, the SSE stream takes
 * over the events, and every input takes the HTTP path.
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
    model.connected = true
    // The socket carries every frame now, so the fallback stream — and the HTTP
    // connection it was holding on the shared origin — is handed back to the page.
    disarmSseFallback()
    stopSse()
    emit()
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
    if (frame.event === 'socket-error') {
      console.warn(LOG + ' socket rejected a frame:', frame.data?.message)
      return
    }
    if (frame.event === 'socket-ready') return
    applyFrame(frame.event, frame.data === null || typeof frame.data !== 'object' ? undefined : frame.data, handlers)
  })
  const closed = () => {
    socketState.ready = false
    socketState.socket = null
    model.connected = false
    // Nothing to fall back to or retry once the panel is gone: a socket closed by
    // teardown must not resurrect the stream it was replacing.
    if (!streamState.started) return
    // Degrade at once rather than after the retries: missing a session's exit code
    // costs more than the connection an SSE stream holds. It is closed again if a
    // retry gets the socket back.
    startSse(streamState.handlers ?? handlers)
    emit()
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
