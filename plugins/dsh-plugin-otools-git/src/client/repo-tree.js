/**
 * The header repository picker.
 *
 * The old sidebar tree is gone: the repository is picked from one select at the
 * top-left of the panel, in the spirit of the sibling 仓库面板. What git has
 * that the issue panel does not is sub-repositories, so every repository renders
 * as an `<optgroup>` and its submodules render as indented options under it —
 * picking one jumps to the 子模块 tab of that repository.
 *
 * Submodule rows come from `/children` per workspace. The active repository's
 * rows are always the live `model.children`; every other repository's rows are
 * fetched once, cached, and dropped on a full refresh.
 */

/** Per-repository submodule cache for INACTIVE repositories: workspaceId → rows. */
const submoduleCache = new Map()

/** Render the header row: repo picker, worktree picker, path, refresh. */
function renderRepoPicker(host) {
  queueSubmoduleLoads()
  const parent = model.repos.find((row) => row.workspaceId === model.workspaceId)
  const parts = [repoSelect()]
  if (parent !== undefined && parent.isRepo) {
    const rows = [{ path: parent.root, branch: parent.branch }, ...model.children.worktrees]
    parts.push(el('select', {
      class: 'dsh-og-worktree-select',
      'aria-label': '当前工作树',
      onChange: (event) => selectWorktree(event.target.value),
    }, rows.map((row) => el('option', { value: row.path, disabled: row.prunable === true },
      (row.branch ?? '游离 HEAD') + ' · ' + baseName(row.path)))))
    const picked = parts[parts.length - 1]
    picked.value = model.worktreePath || parent.root
  }
  if (parent !== undefined && parent.isRepo) {
    const path = currentRepo()?.root ?? ''
    parts.push(el('span', { class: 'dsh-og-worktree-path', title: path }, path))
  }
  parts.push(iconButton('refresh', {
    title: '刷新仓库列表',
    onClick: () => {
      invalidateSubmoduleCache()
      void refreshAll()
    },
  }))
  fill(host, ...parts)
}

/**
 * The repo select: one optgroup per git repository with the repo itself plus
 * its submodules as options; non-repo workspaces are disabled plain options.
 */
function repoSelect() {
  const select = el('select', {
    class: 'dsh-og-repo-select',
    'aria-label': '选择仓库',
    onChange: (event) => pickRepoValue(event.target.value),
  })
  if (!model.reposLoaded) {
    select.disabled = true
    select.append(el('option', { value: '' }, '正在读取工作区...'))
    return select
  }
  if (model.repos.length === 0) {
    select.disabled = true
    select.append(el('option', { value: '' }, '还没有打开任何工作区'))
    return select
  }
  for (const row of model.repos) {
    if (row.isRepo !== true) {
      select.append(el('option', { value: '', disabled: true },
        (row.title ?? row.name ?? baseName(row.path)) + '（不是 git 仓库）'))
      continue
    }
    const group = el('optgroup', { label: repoGroupLabel(row) })
    group.append(el('option', { value: 'repo:' + row.workspaceId }, repoOptionLabel(row)))
    const submodules = row.workspaceId === model.workspaceId
      ? (model.children.submodules ?? [])
      : (submoduleCache.get(row.workspaceId) ?? [])
    for (const entry of submodules.slice(0, 24)) {
      group.append(el('option', { value: 'sub:' + row.workspaceId + '|' + entry.path },
        '└ ' + (entry.name ?? entry.path) + (entry.initialized === true ? '' : '（未初始化）')))
    }
    if (submodules.length > 24) {
      group.append(el('option', { value: '', disabled: true }, '└ …'))
    }
    select.append(group)
  }
  select.value = model.workspaceId.length > 0 ? 'repo:' + model.workspaceId : ''
  if (select.value !== '' && select.selectedIndex === -1) select.selectedIndex = 0
  return select
}

/** The optgroup label: repository name plus its dirty dot. */
function repoGroupLabel(row) {
  const name = row.title ?? row.name ?? baseName(row.path)
  return row.dirty === true ? name + ' ●' : name
}

/** The repository's own option: branch and change count, as the sidebar showed. */
function repoOptionLabel(row) {
  const bits = []
  if (row.detached === true) {
    bits.push(row.shortOid === undefined ? '游离 HEAD' : '游离 ' + row.shortOid)
  } else {
    bits.push(row.branch ?? '未创建分支')
  }
  const track = trackText(row.ahead ?? 0, row.behind ?? 0)
  if (track.length > 0) bits.push(track)
  if (row.counts !== undefined && row.counts.total > 0) bits.push('±' + row.counts.total)
  const state = REPO_STATE_TEXT[row.repoState] ?? ''
  if (state.length > 0) bits.push(state)
  return bits.join(' · ')
}

/**
 * Fire the one-time `/children` fetch for every inactive repository, so the
 * dropdown can list submodules the user has not opened yet.
 */
function queueSubmoduleLoads() {
  for (const row of model.repos) {
    if (row.isRepo !== true || row.workspaceId === model.workspaceId) continue
    if (submoduleCache.has(row.workspaceId)) continue
    submoduleCache.set(row.workspaceId, [])
    const workspaceId = row.workspaceId
    apiGet('/children', { workspaceId })
      .then((children) => {
        submoduleCache.set(workspaceId, children.submodules ?? [])
        emit()
      })
      .catch(() => {
        submoduleCache.set(workspaceId, [])
      })
  }
}

/** Drop the cached submodule rows (a full refresh or an explicit reload). */
function invalidateSubmoduleCache() {
  submoduleCache.clear()
}

/** Decode a picked option: a repository, or one of its submodules. */
function pickRepoValue(value) {
  if (typeof value !== 'string' || value.length === 0) return
  if (value.startsWith('sub:')) {
    const rest = value.slice(4)
    const at = rest.indexOf('|')
    if (at > 0) selectSubmodule(rest.slice(0, at), rest.slice(at + 1))
    return
  }
  if (value.startsWith('repo:')) selectRepo(value.slice(5))
}

/**
 * Picking a submodule points the panel at its parent repository and opens the
 * 子模块 tab — the sidebar's submodule row behaviour, moved into the picker.
 */
function selectSubmodule(workspaceId, path) {
  const alreadyActive = model.workspaceId === workspaceId && !model.worktreePath
  if (model.tab !== 'submodules') {
    model.tab = 'submodules'
    void savePrefs({ activeTab: 'submodules' })
  }
  if (!alreadyActive) {
    selectRepo(workspaceId)
    return
  }
  emit()
  void refreshTab()
  void loadChildren()
  void path
}

/** Point the panel at one repository and load what the active tab needs. */
function selectRepo(workspaceId) {
  if (model.workspaceId === workspaceId && !model.worktreePath) return
  model.workspaceId = workspaceId
  model.worktreePath = ''
  storeSet(STORE_KEYS.worktreePath, '')
  storeSet(STORE_KEYS.workspaceId, workspaceId)
  resetRepoState()
  emit()
  void Promise.all([refreshTab(), loadBranches(), loadRemotes()])
  void loadChildren()
}

function selectWorktree(path) {
  const parent = model.repos.find((row) => row.workspaceId === model.workspaceId)
  if (path === parent?.root) {
    selectRepo(model.workspaceId)
    return
  }
  const worktree = model.children.worktrees.find((row) => row.path === path && !row.prunable)
  if (worktree === undefined || model.worktreePath === path) return
  const children = model.children
  resetRepoState()
  model.children = children
  model.worktreePath = path
  model.tab = 'status'
  storeSet(STORE_KEYS.workspaceId, model.workspaceId)
  storeSet(STORE_KEYS.worktreePath, path)
  emit()
  void Promise.all([refreshTab(), loadBranches(), loadRemotes()])
}

/** Copy to the clipboard, reporting either way. */
async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''))
    toast(successMessage ?? '已复制', 'success', 1800)
  } catch {
    toast('复制失败，浏览器拒绝了剪贴板访问', 'error')
  }
}
