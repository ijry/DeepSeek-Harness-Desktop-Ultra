/**
 * The transport: the `{ok, value}` / `{ok, error}` envelope the host speaks, plus
 * the change stream that carries preference changes and live operation progress —
 * a WebSocket where the host offers one, the SSE route otherwise.
 *
 * Requests name a registered workspace or a worktree listed by Git for it. The
 * host validates both against the workspace registry before running commands.
 */

/** A rejected envelope, carrying the host's stable code. */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
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
  )
}

/**
 * Run one request with the busy counter held, so the shell can show that
 * something is in flight without every caller remembering to.
 */
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

/** The current repository's request parameters, or undefined when none is open. */
function repoParams(extra) {
  if (model.workspaceId.length === 0) return undefined
  return { workspaceId: repoTarget(), ...(extra ?? {}) }
}

// ------------------------------------------------------------------ stream
// The host's change stream arrives on a WebSocket, with the SSE route as the
// fallback. Why two carriers for the same frames: a browser gives one origin
// about six concurrent HTTP/1.1 connections, and a live EventSource holds one of
// them until the panel unloads. The DSH GUI and every panel plugin share that
// single origin, so with the bundled plugins all installed the whole budget sits
// in persistent streams — and unrelated requests on the same origin (the shell's
// own folder picker, its session lists) then queue forever: no response, no
// error, nothing to time out. A WebSocket rides a separate pool, so this stream
// costs the shell nothing. SSE stays for a DSH build whose webserver has no
// upgrade hook, and for the test DOM, which has no WebSocket.
let stream = null
let legacyStream = null
let legacyGeneration = 0
let streamRetry = null
/** The operation listener, kept so a reconnect can register it again. */
let opListener = null

/** Handshake deadline before falling back to SSE. */
const SOCKET_OPEN_TIMEOUT_MS = 4000

/** Reconnect delay after a working socket drops (the SSE `retry` value). */
const STREAM_RETRY_MS = 2000

/** Every event name the host sends, on either carrier. */
const STREAM_EVENTS = ['hello', 'prefs', 'operation']
let clientContext


/**
 * Subscribe to the host's change stream. Three event kinds, identical on both
 * carriers: `hello` (the baseline revision plus the live operation list), `prefs`
 * (re-read the preferences) and `operation` (one operation record changed —
 * merged in place so the progress dialog updates without a refetch).
 */
function startStream(onOperation) {
  stopStream()
  if (onOperation !== undefined) opListener = onOperation
  stream = openPanelChannel(clientContext, {
    source: 'otools-git',
    startFallback: () => startLegacyStream(),
    onOpen: () => { void refreshAll(); model.connected = true; emit() },
    onFrame: (name, data) => { applyStreamEvent(name, data) },
    onClose: () => { model.connected = false; emit() },
  })
}

function stopStream() {
  const stop = stream
  stream = null
  if (typeof stop === 'function') stop()
  stopLegacyStream()
}

function stopLegacyStream() {
  legacyGeneration += 1
  if (streamRetry !== null) {
    clearTimeout(streamRetry)
    streamRetry = null
  }
  const current = legacyStream
  legacyStream = null
  if (current === null) return
  try {
    current.close()
  } catch { /* already closed */ }
}

/** Come back after a carrier that used to work dropped. */
function scheduleStreamRetry(generation) {
  if (streamRetry !== null) return
  streamRetry = setTimeout(() => {
    streamRetry = null
    if (generation !== legacyGeneration) return
    if (!startSocket(generation)) startSse(generation)
  }, STREAM_RETRY_MS)
}

/** Open the socket. False means this browser or this DSH build cannot use one. */
function startLegacyStream() {
  stopLegacyStream()
  const generation = legacyGeneration
  if (!startSocket(generation)) startSse(generation)
  return () => { if (generation === legacyGeneration) stopLegacyStream() }
}

function startSocket(generation) {
  if (typeof window.WebSocket !== 'function') return false
  let socket
  try {
    const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
    socket = new window.WebSocket(scheme + window.location.host + SOCKET_PATH)
  } catch (error) {
    console.warn(LOG + ' socket unavailable:', messageOf(error))
    return false
  }
  legacyStream = { kind: 'socket', close: () => socket.close() }
  const mine = legacyStream
  const active = () => generation === legacyGeneration && legacyStream === mine
  let opened = false
  // A handshake nobody answers must not strand the panel without a stream:
  // closing on the deadline routes us to SSE through the close handler.
  const deadline = setTimeout(() => {
    if (opened) return
    try {
      socket.close()
    } catch { /* already closing */ }
  }, SOCKET_OPEN_TIMEOUT_MS)
  socket.addEventListener('open', () => {
    opened = true
    clearTimeout(deadline)
    if (!active()) return
    model.connected = true
    emit()
  })
  socket.addEventListener('message', (event) => {
    if (!active()) return
    const payload = parseEvent(event)
    if (payload === undefined) return
    applyStreamEvent(payload.event, payload.data)
  })
  socket.addEventListener('close', () => {
    clearTimeout(deadline)
    // Only the attempt currently holding the seat may act on its own close: a
    // close arriving after stopStream() — or after a newer attempt took over —
    // must not clear the live connection's bookkeeping or start a second stream.
    if (!active()) return
    legacyStream = null
    model.connected = false
    emit()
    // Opened once means the carrier works and the host went away: come back.
    // Never opened means there is no upgrade hook here — take SSE for good.
    if (opened) scheduleStreamRetry(generation)
    else startSse(generation)
  })
  return true
}

function startSse(generation) {
  if (generation !== legacyGeneration) return
  if (typeof window.EventSource !== 'function') return
  let source
  try {
    source = new window.EventSource(SSE_PATH)
  } catch (error) {
    console.warn(LOG + ' event stream unavailable:', messageOf(error))
    return
  }
  legacyStream = { kind: 'sse', close: () => source.close() }
  const mine = legacyStream
  const active = () => generation === legacyGeneration && legacyStream === mine
  source.addEventListener('open', () => {
    if (!active()) return
    model.connected = true
    emit()
  })
  source.addEventListener('error', () => {
    if (!active()) return
    // EventSource reconnects on its own; the panel only reflects the state.
    model.connected = false
    emit()
  })
  for (const name of STREAM_EVENTS) {
    source.addEventListener(name, (event) => { if (active()) applyStreamEvent(name, parseEvent(event)) })
  }
}

/** Parse one frame's payload, tolerating a truncated one. */
function parseEvent(event) {
  try {
    const data = JSON.parse(event.data)
    return data === null || typeof data !== 'object' ? undefined : data
  } catch {
    return undefined
  }
}

/** Merge one operation record into the list, newest first. */
function mergeOperation(record) {
  const index = model.ops.findIndex((row) => row.id === record.id)
  if (index === -1) model.ops.unshift(record)
  else model.ops[index] = record
  if (model.activeOp !== null && model.activeOp.id === record.id) model.activeOp = record
  if (model.ops.length > 60) model.ops.length = 60
}

/**
 * Apply one decoded frame. Both carriers land here with the same name and the
 * same payload, so the WebSocket and the SSE fallback cannot drift apart.
 */
function applyStreamEvent(name, data) {
  if (data === null || typeof data !== 'object') return
  if (name === 'hello') {
    model.connected = true
    if (typeof data.revision === 'number') model.revision = data.revision
    if (Array.isArray(data.operations)) model.ops = data.operations
    emit()
    return
  }
  if (name === 'prefs') {
    if (typeof data.revision === 'number') model.revision = data.revision
    void loadPrefs()
    return
  }
  if (name !== 'operation' || typeof data.id !== 'string') return
  mergeOperation(data)
  if (opListener !== null) {
    try {
      opListener(data)
    } catch (error) {
      console.warn(LOG + ' operation listener threw:', messageOf(error))
    }
  }
  emit()
}

// ------------------------------------------------------------------ loaders
/**
 * The reads. Each one owns exactly one slice of the model and swallows its own
 * failure into that slice, so a repository whose `git log` fails still shows a
 * working status pane.
 */
async function loadPrefs() {
  try {
    const value = await apiGet('/prefs')
    model.prefs = value.prefs
    model.revision = value.revision
  } catch (error) {
    console.warn(LOG + ' prefs unavailable:', messageOf(error))
    if (model.prefs === null) model.prefs = {}
  }
  emit()
}

/** Persist a preference patch, optimistically applied first. */
async function savePrefs(patch, perRepo) {
  if (model.prefs === null) model.prefs = {}
  if (perRepo === true && model.workspaceId.length > 0) {
    const rows = { ...(model.prefs.perRepo ?? {}) }
    rows[model.workspaceId] = { ...(rows[model.workspaceId] ?? {}), ...patch }
    model.prefs = { ...model.prefs, perRepo: rows }
  } else {
    model.prefs = { ...model.prefs, ...patch }
  }
  emit()
  try {
    const value = await apiPost('/prefs', {
      prefs: patch,
      workspaceId: perRepo === true ? model.workspaceId : undefined,
    })
    model.prefs = value
  } catch (error) {
    console.warn(LOG + ' prefs not saved:', messageOf(error))
  }
  emit()
}

async function loadRepos() {
  try {
    model.repos = await apiGet('/repos')
    model.reposLoaded = true
    // Pick up where the user left off; fall back to the first repository.
    const known = model.repos.some((row) => row.workspaceId === model.workspaceId && row.isRepo)
    if (!known) {
      const first = model.repos.find((row) => row.isRepo)
      model.workspaceId = first === undefined ? '' : first.workspaceId
      model.worktreePath = ''
      storeSet(STORE_KEYS.worktreePath, '')
      resetRepoState()
    }
  } catch (error) {
    model.reposLoaded = true
    toastError(error)
  }
  emit()
}

async function loadStatus() {
  const params = repoParams({ untracked: pref('untrackedMode') ?? 'all' })
  if (params === undefined) return
  try {
    const status = await apiGet('/status', params)
    if (params.workspaceId !== repoTarget()) return
    model.status = status
    model.statusError = null
  } catch (error) {
    if (params.workspaceId !== repoTarget()) return
    model.status = null
    model.statusError = friendlyError(error)
  }
  emit()
}

async function loadChildren() {
  const workspaceId = model.workspaceId
  if (!workspaceId) return
  try {
    const children = await apiGet('/children', { workspaceId })
    if (workspaceId !== model.workspaceId) return
    model.children = children
    if (model.worktreePath && !children.worktrees.some((row) => row.path === model.worktreePath && !row.prunable)) {
      selectRepo(workspaceId)
      return
    }
  } catch {
    if (workspaceId !== model.workspaceId) return
    model.children = { submodules: [], worktrees: [] }
  }
  emit()
}

async function loadBranches() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.branches = await apiGet('/branches', params)
  } catch (error) {
    toastError(error)
  }
  emit()
}

async function loadTags() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.tags = await apiGet('/tags', params)
  } catch (error) {
    toastError(error)
  }
  emit()
}

async function loadStashes() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.stashes = await apiGet('/stashes', params)
  } catch (error) {
    toastError(error)
  }
  emit()
}

async function loadRemotes() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.remotes = await apiGet('/remotes', params)
  } catch (error) {
    toastError(error)
  }
  emit()
}

/**
 * One page of history. `append` keeps what is already loaded (the infinite
 * scroll), otherwise the list is replaced from offset 0.
 */
async function loadHistory(append) {
  const base = repoParams()
  if (base === undefined) return
  const limit = pref('historyPageSize') ?? 100
  const offset = append === true ? model.history.rows.length : 0
  model.history.loading = true
  model.history.error = null
  emit()
  try {
    const value = await apiGet('/history', {
      ...base,
      limit,
      offset,
      branch: model.historyBranch,
      includeRemote: pref('historyIncludeRemote') === false ? 'false' : 'true',
      message: model.historyFilters.message,
      author: model.historyFilters.author,
      hash: model.historyFilters.hash,
      dateFrom: model.historyFilters.dateFrom,
      dateTo: model.historyFilters.dateTo,
    })
    model.history = {
      rows: append === true ? [...model.history.rows, ...value.rows] : value.rows,
      hasMore: value.hasMore,
      offset,
      loading: false,
      error: null,
    }
  } catch (error) {
    model.history = { ...model.history, loading: false, error: friendlyError(error) }
  }
  emit()
  if (append !== true) void loadTips()
}

async function loadTips() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.tips = await apiGet('/history/tips', params)
  } catch {
    model.tips = { branches: {}, tags: {} }
  }
  emit()
}

async function loadIdentity() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.identity = await apiGet('/identity', params)
  } catch { /* the settings dialog reports it */ }
  emit()
}

async function loadCredentials() {
  try {
    model.credentials = await apiGet('/credentials')
  } catch { /* the settings dialog reports it */ }
  emit()
}

async function loadInstall() {
  try {
    model.install = await apiGet('/install')
  } catch {
    model.install = { installed: false, message: '无法检测 Git 安装状态' }
  }
  emit()
}

async function loadAiAvailability() {
  try {
    model.aiAvailability = await apiGet('/ai/availability')
  } catch {
    model.aiAvailability = { available: false, reason: '无法检测模型可用性' }
  }
  emit()
}

/** The diff of one working-tree / index / commit file. */
async function loadDiff(source, path, origPath) {
  const base = repoParams()
  if (base === undefined) return
  model.diffLoading = true
  model.diffSource = { ...source, path, origPath }
  emit()
  try {
    const params = {
      ...base,
      ...source,
      path,
      origPath,
      context: pref('diffContext') ?? 3,
      ignoreWhitespace: pref('ignoreWhitespace') === true ? 'true' : 'false',
      wordDiff: pref('wordDiff') === true ? 'true' : 'false',
    }
    model.diff = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(path)
      ? { image: await apiGet('/diff/image', params) }
      : await apiGet('/diff/file', params)
  } catch (error) {
    model.diff = { error: friendlyError(error), lines: [] }
  }
  model.diffLoading = false
  emit()
}

/** One commit's detail plus its changed-file list. */
async function loadCommit(rev) {
  const base = repoParams()
  if (base === undefined) return
  model.activeCommit = rev
  model.commitDetail = null
  model.commitFiles = []
  model.commitFileActive = null
  model.diff = null
  emit()
  try {
    const [detail, summary] = await Promise.all([
      apiGet('/commit', { ...base, rev }),
      apiGet('/diff/summary', { ...base, kind: 'commit', rev }),
    ])
    model.commitDetail = detail
    model.commitFiles = summary.files
    if (summary.files.length > 0) {
      model.commitFileActive = summary.files[0].path
      emit()
      await loadDiff({ kind: 'commit', rev }, summary.files[0].path, summary.files[0].origPath)
      return
    }
  } catch (error) {
    toastError(error)
  }
  emit()
}

/** One stash's file list, then its first file's diff. */
async function loadStashDetail(ref) {
  const base = repoParams()
  if (base === undefined) return
  model.activeStash = ref
  model.stashFiles = []
  emit()
  try {
    model.stashFiles = await apiGet('/stash/files', { ...base, ref })
  } catch (error) {
    toastError(error)
  }
  emit()
}

/** Everything the currently active tab needs, in one call. */
async function refreshTab() {
  if (model.workspaceId.length === 0) return
  const tasks = [loadStatus()]
  if (model.tab === 'history') tasks.push(loadHistory(false))
  if (model.tab === 'branches') tasks.push(loadBranches(), loadTags())
  if (model.tab === 'tags') tasks.push(loadTags())
  if (model.tab === 'stashes') tasks.push(loadStashes())
  if (model.tab === 'remotes') tasks.push(loadRemotes())
  if (model.tab === 'submodules' || model.tab === 'worktrees') tasks.push(loadChildren())
  await Promise.all(tasks)
}

/** A full refresh: the repository list, the tab's data, and the toolbar counts. */
async function refreshAll() {
  await loadRepos()
  await Promise.all([refreshTab(), loadChildren()])
}
