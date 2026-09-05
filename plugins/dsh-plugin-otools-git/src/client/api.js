/**
 * The transport: the `{ok, value}` / `{ok, error}` envelope the host speaks, plus
 * the SSE stream that carries preference changes and live operation progress.
 *
 * Every request carries `workspaceId`, never a filesystem path the browser made
 * up: the host resolves that id against DSH's workspace registry, which is what
 * keeps the panel from driving `git` in an arbitrary directory.
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
  return { workspaceId: model.workspaceId, ...(extra ?? {}) }
}

// --------------------------------------------------------------------- SSE
let sse = null

/**
 * Subscribe to the host's change stream. Two event kinds: `prefs` (re-read the
 * preferences) and `operation` (one operation record changed — merged in place so
 * the progress dialog updates without a refetch).
 */
function startSse(onOperation) {
  stopSse()
  if (typeof window.EventSource !== 'function') return
  let source
  try {
    source = new window.EventSource(SSE_PATH)
  } catch (error) {
    console.warn(LOG + ' event stream unavailable:', messageOf(error))
    return
  }
  sse = source
  source.addEventListener('open', () => {
    model.connected = true
    emit()
  })
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; the panel only reflects the state.
    model.connected = false
    emit()
  })
  source.addEventListener('hello', (event) => {
    model.connected = true
    const data = parseEvent(event)
    if (data !== undefined) {
      if (typeof data.revision === 'number') model.revision = data.revision
      if (Array.isArray(data.operations)) model.ops = data.operations
    }
    emit()
  })
  source.addEventListener('prefs', (event) => {
    const data = parseEvent(event)
    if (data !== undefined && typeof data.revision === 'number') model.revision = data.revision
    void loadPrefs()
  })
  source.addEventListener('operation', (event) => {
    const record = parseEvent(event)
    if (record === undefined || typeof record.id !== 'string') return
    mergeOperation(record)
    if (onOperation !== undefined) {
      try {
        onOperation(record)
      } catch (error) {
        console.warn(LOG + ' operation listener threw:', messageOf(error))
      }
    }
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

/** Merge one operation record into the list, newest first. */
function mergeOperation(record) {
  const index = model.ops.findIndex((row) => row.id === record.id)
  if (index === -1) model.ops.unshift(record)
  else model.ops[index] = record
  if (model.activeOp !== null && model.activeOp.id === record.id) model.activeOp = record
  if (model.ops.length > 60) model.ops.length = 60
}

function stopSse() {
  if (sse !== null) {
    try {
      sse.close()
    } catch { /* already closed */ }
    sse = null
  }
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
    model.status = await apiGet('/status', params)
    model.statusError = null
  } catch (error) {
    model.status = null
    model.statusError = friendlyError(error)
  }
  emit()
}

async function loadChildren() {
  const params = repoParams()
  if (params === undefined) return
  try {
    model.children = await apiGet('/children', params)
  } catch {
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
