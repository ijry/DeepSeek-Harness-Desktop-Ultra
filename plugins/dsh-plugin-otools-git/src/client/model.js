/**
 * One flat model plus a listener set — the whole panel re-renders from it.
 *
 * A git panel is a live view of a working tree, so almost nothing here is a
 * cache: `status`, `history`, `branches` and friends are whatever the last read
 * returned, and they are dropped when the repository changes. The exceptions are
 * `prefs` (durable, mirrored on the host) and `ops` (the operation records the
 * SSE stream keeps up to date).
 */
const model = {
  // shell
  open: false,
  booted: false,
  connected: false,
  revision: 0,
  tab: 'status',
  repos: [],
  reposLoaded: false,
  workspaceId: '',
  worktreePath: '',
  // The checkout path of a submodule opened as its own repository. Like
  // `worktreePath`, it overrides `workspaceId` as the request target; unlike it,
  // a submodule is not a linked worktree, so it is kept separate.
  submodulePath: '',
  install: null,
  aiAvailability: null,
  prefs: null,
  busy: 0,

  // per-repository reads
  status: null,
  statusError: null,
  children: { submodules: [], worktrees: [] },
  history: { rows: [], hasMore: false, offset: 0, loading: false, error: null },
  tips: { branches: {}, tags: {} },
  branches: [],
  tags: [],
  stashes: [],
  remotes: [],
  identity: null,
  config: null,
  credentials: { hosts: [], env: [] },

  // status pane
  selection: { section: '', paths: [] },
  activeFile: null,
  diff: null,
  diffLoading: false,
  diffSource: null,
  commitMessage: '',
  aiBusy: false,

  // history pane
  historyFilters: { message: '', author: '', hash: '', dateFrom: '', dateTo: '' },
  historyBranch: 'current',
  activeCommit: null,
  commitDetail: null,
  commitFiles: [],
  commitFileActive: null,

  // stash pane
  activeStash: null,
  stashFiles: [],

  // operations
  ops: [],
  activeOp: null,
}

const listeners = new Set()

/** Notify every listener. A throwing listener must not stop the others. */
function emit() {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (error) {
      console.warn(LOG + ' listener threw:', messageOf(error))
    }
  }
}

/** Subscribe to model changes; returns the unsubscriber. */
function onModel(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The repository row the panel is pointed at. */
function currentRepo() {
  const parent = model.repos.find((row) => row.workspaceId === model.workspaceId)
  if (parent === undefined) return parent
  if (model.worktreePath) {
    const worktree = model.children.worktrees.find((row) => row.path === model.worktreePath)
    return { ...parent, ...worktree, root: model.worktreePath, path: model.worktreePath,
      title: baseName(model.worktreePath), branch: model.status?.branch ?? worktree?.branch }
  }
  if (model.submodulePath) {
    const submodule = model.children.submodules.find(
      (row) => joinPath(parent.root, row.path) === model.submodulePath)
    return { ...parent, ...submodule, root: model.submodulePath, path: model.submodulePath,
      title: baseName(model.submodulePath), branch: model.status?.branch ?? submodule?.branch }
  }
  return parent
}

/** The absolute checkout path of a repository's submodule, from its `.gitmodules` path. */
function submodulePathOf(workspaceId, relPath) {
  const parent = model.repos.find((row) => row.workspaceId === workspaceId)
  if (parent === undefined || parent.isRepo !== true) return ''
  return joinPath(parent.root, relPath)
}

function repoTarget() {
  return model.worktreePath || model.submodulePath || model.workspaceId
}

/** The effective preference value, per-repo override first. */
function pref(key) {
  const prefs = model.prefs
  if (prefs === null || prefs === undefined) return undefined
  const own = prefs.perRepo === undefined || prefs.perRepo === null
    ? undefined
    : prefs.perRepo[model.workspaceId]
  if (own !== undefined && own !== null && Object.hasOwn(own, key)) return own[key]
  return prefs[key]
}

/** Drop every per-repository read (on a repository switch). */
function resetRepoState() {
  model.status = null
  model.statusError = null
  model.children = { submodules: [], worktrees: [] }
  model.history = { rows: [], hasMore: false, offset: 0, loading: false, error: null }
  model.tips = { branches: {}, tags: {} }
  model.branches = []
  model.tags = []
  model.stashes = []
  model.remotes = []
  model.identity = null
  model.config = null
  model.selection = { section: '', paths: [] }
  model.activeFile = null
  model.diff = null
  model.diffSource = null
  model.commitMessage = ''
  model.activeCommit = null
  model.commitDetail = null
  model.commitFiles = []
  model.commitFileActive = null
  model.activeStash = null
  model.stashFiles = []
}

/** Is a path currently selected in this section? */
function isSelected(section, path) {
  return model.selection.section === section && model.selection.paths.includes(path)
}

/**
 * Click-to-select with the modifier semantics a file list is expected to have:
 * plain click replaces the selection, ctrl/cmd toggles one row, shift extends
 * from the anchor. The reference only had a shift-held toggle mode; ranges are
 * what everyone actually reaches for, and they cost nothing here.
 */
function selectPath(section, path, event, orderedPaths) {
  const selection = model.selection
  const sameSection = selection.section === section
  const additive = event !== undefined && event !== null && (event.ctrlKey === true || event.metaKey === true)
  const ranged = event !== undefined && event !== null && event.shiftKey === true

  if (ranged && sameSection && selection.anchor !== undefined && Array.isArray(orderedPaths)) {
    const from = orderedPaths.indexOf(selection.anchor)
    const to = orderedPaths.indexOf(path)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      model.selection = { section, paths: orderedPaths.slice(lo, hi + 1), anchor: selection.anchor }
      return
    }
  }
  if (additive && sameSection) {
    const paths = selection.paths.includes(path)
      ? selection.paths.filter((entry) => entry !== path)
      : [...selection.paths, path]
    model.selection = { section, paths, anchor: path }
    return
  }
  model.selection = { section, paths: [path], anchor: path }
}

/** The paths a context action applies to: the selection, or the clicked row. */
function actionPaths(section, path) {
  if (model.selection.section === section && model.selection.paths.includes(path)) {
    return [...model.selection.paths]
  }
  return [path]
}
