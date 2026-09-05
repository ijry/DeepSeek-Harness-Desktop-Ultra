/**
 * The sidebar repository tree.
 *
 * This is where the port diverges most from the reference: there is no "add
 * repository" button, no clone/init entry, no drag-to-reorder and no rename,
 * because the rows ARE the DSH workspaces. What is kept is the shape — a card per
 * repository showing its branch and dirty state, with its submodules and sibling
 * worktrees as children.
 */

/** Render the sidebar into `host`. */
function renderRepoTree(host) {
  const tree = el('div', { class: 'dsh-og-tree' })
  if (!model.reposLoaded) {
    fill(host, el('div', { class: 'dsh-og-loading' }, '正在读取工作区...'))
    return
  }
  if (model.repos.length === 0) {
    fill(host, emptyState('还没有打开任何工作区', '在 DSH 里打开一个文件夹，它会出现在这里'))
    return
  }
  for (const row of model.repos) tree.append(repoCard(row))
  fill(host, tree)
}

/** One repository card. */
function repoCard(row) {
  const active = row.workspaceId === model.workspaceId
  const card = el('div', {
    class: 'dsh-og-repo',
    'data-active': active ? 'true' : undefined,
    'data-repo': row.isRepo === true ? undefined : 'false',
    title: row.path,
    onClick: () => {
      if (row.isRepo !== true) {
        toast(row.path + ' 不是一个 git 仓库', 'warning')
        return
      }
      selectRepo(row.workspaceId)
    },
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (row.isRepo !== true) return
      showMenu(event.clientX, event.clientY, repoMenu(row))
    },
  })

  const nameRow = el('div', { class: 'dsh-og-repo-title' },
    el('span', { class: 'dsh-og-file-icon' }, repoGlyph(row)),
    el('span', { class: 'dsh-og-repo-name' }, row.title ?? row.name ?? baseName(row.path)))
  if (row.isRepo === true && row.dirty === true) {
    nameRow.append(el('span', { class: 'dsh-og-repo-dot', title: '有未提交的改动' }))
  }
  card.append(nameRow)

  const meta = el('div', { class: 'dsh-og-repo-meta' })
  if (row.isRepo !== true) {
    meta.append(el('span', {}, '不是 git 仓库'))
  } else {
    meta.append(el('span', {}, row.detached === true
      ? (row.shortOid === undefined ? '游离 HEAD' : '游离 ' + row.shortOid)
      : (row.branch ?? '未创建分支')))
    const track = trackText(row.ahead ?? 0, row.behind ?? 0)
    if (track.length > 0) meta.append(el('span', { title: '领先 / 落后于上游' }, track))
    if (row.counts !== undefined && row.counts.total > 0) {
      meta.append(el('span', { title: '改动文件数' }, '±' + row.counts.total))
    }
    const state = REPO_STATE_TEXT[row.repoState] ?? ''
    if (state.length > 0) meta.append(el('span', { style: { color: 'var(--og-warning)' } }, state))
  }
  card.append(meta)

  if (active) {
    const children = repoChildren(row)
    if (children !== undefined) card.append(children)
  }
  return card
}

/** A repository's own glyph: git for a plain one, worktree for a linked one. */
function repoGlyph(row) {
  const node = icon(row.isRepo === true ? 'git' : 'folder')
  node.style.color = row.isRepo === true ? '#f05033' : 'var(--og-text-3)'
  return node
}

/** The submodule and worktree rows under the active repository. */
function repoChildren(row) {
  const submodules = model.children.submodules ?? []
  const worktrees = (model.children.worktrees ?? []).filter((entry) => entry.isMain !== true)
  if (submodules.length === 0 && worktrees.length === 0) return undefined
  const wrap = el('div', { class: 'dsh-og-repo-children' })
  for (const entry of submodules.slice(0, 8)) {
    wrap.append(el('div', {
      class: 'dsh-og-repo-child',
      title: entry.path + (entry.url === undefined ? '' : ' → ' + entry.url),
      onClick: (event) => {
        event.stopPropagation()
        model.tab = 'submodules'
        emit()
        void loadChildren()
      },
    },
    el('span', { class: 'dsh-og-file-icon' }, icon('submodule')),
    el('span', { class: 'dsh-og-repo-child-name' }, entry.name ?? entry.path),
    entry.initialized === true ? undefined : tag('未初始化', 'warning')))
  }
  for (const entry of worktrees.slice(0, 8)) {
    wrap.append(el('div', {
      class: 'dsh-og-repo-child',
      title: entry.path,
      onClick: (event) => {
        event.stopPropagation()
        model.tab = 'worktrees'
        emit()
        void loadChildren()
      },
    },
    el('span', { class: 'dsh-og-file-icon' }, icon('worktree')),
    el('span', { class: 'dsh-og-repo-child-name' }, entry.branch ?? entry.name),
    entry.prunable === true ? tag('失效', 'danger') : undefined))
  }
  if (submodules.length > 8 || worktrees.length > 8) {
    wrap.append(el('div', { class: 'dsh-og-repo-child', style: { color: 'var(--og-text-3)' } }, '…'))
  }
  return wrap
}

/** The repository row's context menu. */
function repoMenu(row) {
  return [
    { head: row.path },
    {
      label: '刷新',
      icon: 'refresh',
      onClick: () => {
        selectRepo(row.workspaceId)
        void refreshAll()
      },
    },
    {
      label: '复制仓库路径',
      icon: 'copy',
      onClick: () => copyText(row.root ?? row.path, '已复制仓库路径'),
    },
    'sep',
    {
      label: '仓库设置...',
      icon: 'settings',
      onClick: () => {
        selectRepo(row.workspaceId)
        openSettingsDialog()
      },
    },
  ]
}

/** Point the panel at one repository and load what the active tab needs. */
function selectRepo(workspaceId) {
  if (model.workspaceId === workspaceId) return
  model.workspaceId = workspaceId
  storeSet(STORE_KEYS.workspaceId, workspaceId)
  resetRepoState()
  emit()
  void refreshTab()
  void loadChildren()
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
