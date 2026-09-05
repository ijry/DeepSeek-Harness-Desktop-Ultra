/**
 * The shell: the sidebar, the toolbar, the tab panes and the status bar — the
 * layout of the reference's Git.vue, with its 55px toolbar, 45px icon-over-label
 * buttons, resizable 230px sidebar and three-item bottom bar.
 *
 * One render function rebuilds the whole panel from the model. A git panel's
 * state changes in coarse steps (a status read, a page of history, a checkout),
 * so a full repaint is both simpler and fast enough; the two things that must NOT
 * be repainted from scratch — the commit textarea's caret and the operation
 * dialog's scroll — are handled by their own code.
 */

let panelEl = null
let sideEl = null
let toolbarEl = null
let bodyEl = null
let statusbarEl = null
let entryEl = null
let viewEl = null

/** Build the panel shell once. */
function buildPanel(view) {
  sideEl = el('div', { class: 'dsh-og-side' })
  toolbarEl = el('div', { class: 'dsh-og-toolbar' })
  bodyEl = el('div', { class: 'dsh-og-body' })
  statusbarEl = el('div', { class: 'dsh-og-statusbar' })

  const sidebarWidth = pref('sidebarWidth') ?? 230
  sideEl.style.width = sidebarWidth + 'px'
  const handle = resizeHandle({
    axis: 'x',
    min: 180,
    max: () => 520,
    value: () => sideEl.getBoundingClientRect().width,
    onMove: (value) => {
      sideEl.style.width = value + 'px'
    },
    onCommit: (value) => void savePrefs({ sidebarWidth: Math.round(value) }),
    onReset: () => {
      sideEl.style.width = '230px'
      void savePrefs({ sidebarWidth: 230 })
    },
  })

  const main = el('div', { class: 'dsh-og-main' }, toolbarEl, bodyEl, statusbarEl)
  panelEl = el('div', { class: 'dsh-og-panel', 'data-dsh-og-panel': '' }, sideEl, handle, main)
  view.append(panelEl)
}

/** Repaint everything. */
function renderPanel() {
  if (panelEl === null || !panelEl.isConnected) return
  renderSideColumn()
  renderToolbar()
  renderBody()
  renderStatusBar()
  renderEntry()
}

/** The sidebar: a heading plus the repository tree. */
function renderSideColumn() {
  const head = el('div', { class: 'dsh-og-side-head' },
    el('span', { class: 'dsh-og-side-title' }, '仓库'),
    iconButton('refresh', { title: '刷新仓库列表', onClick: () => void refreshAll() }))
  const treeHost = el('div', { style: { flex: '1', 'min-height': '0', display: 'flex', 'flex-direction': 'column' } })
  renderRepoTree(treeHost)
  fill(sideEl, head, treeHost)
}

/** The toolbar: tabs on the left, git actions in the middle, settings on the right. */
function renderToolbar() {
  const hasRepo = model.workspaceId.length > 0
  const status = model.status
  const left = el('div', { class: 'dsh-og-toolbar-group' })
  for (const tab of TABS) {
    left.append(toolbarButton({
      icon: tab.icon,
      label: tab.label,
      active: model.tab === tab.id,
      disabled: !hasRepo,
      badge: tabBadge(tab.id),
      onClick: () => switchTab(tab.id),
    }))
  }

  const mid = el('div', { class: 'dsh-og-toolbar-group' },
    el('div', { class: 'dsh-og-toolbar-sep' }),
    toolbarButton({
      icon: 'download',
      label: '拉取',
      disabled: !hasRepo || model.remotes.length === 0,
      badge: status === null || status.behind === 0 ? undefined : status.behind,
      onClick: () => openPullDialog(),
    }),
    toolbarButton({
      icon: 'upload',
      label: '推送',
      disabled: !hasRepo || model.remotes.length === 0,
      badge: status === null || status.ahead === 0 ? undefined : status.ahead,
      onClick: () => openPushDialog(),
    }),
    toolbarButton({
      icon: 'refresh',
      label: '抓取',
      disabled: !hasRepo || model.remotes.length === 0,
      onClick: () => openFetchDialog(),
    }),
    el('div', { class: 'dsh-og-toolbar-sep' }),
    toolbarButton({ icon: 'branch', label: '分支', disabled: !hasRepo, onClick: () => openBranchDialog() }),
    toolbarButton({ icon: 'merge', label: '合并', disabled: !hasRepo, onClick: () => openMergeDialog() }),
    toolbarButton({ icon: 'stash', label: '贮藏', disabled: !hasRepo, onClick: () => openStashDialog() }))

  const right = el('div', { class: 'dsh-og-toolbar-group dsh-og-right' },
    model.busy > 0 ? el('span', { style: { 'font-size': '11px', color: 'var(--og-text-3)', 'align-self': 'center' } }, '处理中...') : undefined,
    toolbarButton({ icon: 'refresh', label: '刷新', disabled: !hasRepo, onClick: () => void refreshTab() }),
    toolbarButton({ icon: 'settings', label: '设置', disabled: !hasRepo, onClick: () => openSettingsDialog() }))

  fill(toolbarEl, left, mid, right)
}

/** One toolbar button: 22px icon over an 11px label, with an optional badge. */
function toolbarButton(options) {
  const node = el('button', {
    type: 'button',
    class: 'dsh-og-tbtn',
    'data-active': options.active === true ? 'true' : undefined,
    title: options.title ?? options.label,
    disabled: options.disabled === true,
    onClick: options.onClick,
  },
  el('span', { class: 'dsh-og-tbtn-icon' }, icon(options.icon)),
  el('span', {}, options.label))
  if (options.badge !== undefined && options.badge !== null && options.badge !== 0) {
    node.append(el('span', { class: 'dsh-og-tbtn-badge' }, String(options.badge)))
  }
  return node
}

/** The count a tab shows on its own button. */
function tabBadge(id) {
  if (id === 'status') return model.status === null ? undefined : model.status.counts.total
  if (id === 'stashes') return model.status === null ? undefined : model.status.stashCount
  if (id === 'submodules') return (model.children.submodules ?? []).length
  if (id === 'worktrees') {
    const rows = (model.children.worktrees ?? []).filter((row) => row.isMain !== true)
    return rows.length
  }
  return undefined
}

/** Switch tabs, loading whatever the new one needs. */
function switchTab(id) {
  if (model.tab === id) return
  model.tab = id
  void savePrefs({ activeTab: id })
  emit()
  void refreshTab()
}

/** The active pane. */
function renderBody() {
  if (model.workspaceId.length === 0) {
    fill(bodyEl, el('div', { class: 'dsh-og-pane', 'data-active': 'true' }, noRepoPlaceholder()))
    return
  }
  const pane = el('div', { class: 'dsh-og-pane', 'data-active': 'true' })
  if (model.tab === 'status') renderStatusPane(pane)
  else if (model.tab === 'history') renderHistoryPane(pane)
  else if (model.tab === 'branches') renderBranchPane(pane)
  else if (model.tab === 'tags') renderTagPane(pane)
  else if (model.tab === 'stashes') renderStashPane(pane)
  else if (model.tab === 'remotes') renderRemotePane(pane)
  else if (model.tab === 'submodules') renderSubmodulePane(pane)
  else if (model.tab === 'worktrees') renderWorktreePane(pane)
  fill(bodyEl, pane)
}

/** What the middle shows before a repository is picked. */
function noRepoPlaceholder() {
  const install = model.install
  const wrap = el('div', { class: 'dsh-og-empty' })
  if (install !== null && install.installed !== true) {
    wrap.append(alertBox('error', '没有检测到 Git', install.message ?? '请先安装 git 并确保它在 PATH 上。'))
    return wrap
  }
  if (install !== null && install.tooOld === true) {
    wrap.append(alertBox('warning', 'Git 版本偏低', install.message ?? ''))
  }
  if (model.repos.length === 0) {
    wrap.append(el('div', {}, '还没有打开任何工作区'))
    wrap.append(el('div', { style: { 'font-size': '12px' } }, '在 DSH 里打开一个文件夹，如果它是 git 仓库就会出现在左边。'))
    return wrap
  }
  wrap.append(el('div', {}, '在左边选一个仓库'))
  wrap.append(el('div', { style: { 'font-size': '12px' } },
    '这里的仓库列表就是 DSH 的工作区，不需要手动添加。'))
  return wrap
}

/** The bottom status bar: branch, state, repository path. */
function renderStatusBar() {
  const status = model.status
  const repo = currentRepo()
  const items = []

  const branchLabel = status === null
    ? '未选择'
    : status.detached === true
      ? '游离 ' + (status.shortOid ?? '')
      : (status.branch ?? '未创建分支')
  items.push(el('div', { class: 'dsh-og-status-item' },
    el('span', { class: 'dsh-og-status-label' }, '当前分支:'),
    tag(branchLabel, status === null ? 'info' : (status.detached === true ? 'warning' : 'success'), {
      title: status === null ? undefined : (status.upstream === undefined ? '没有上游' : '上游 ' + status.upstream),
      onClick: () => switchTab('branches'),
    })))

  if (status !== null) {
    const track = trackText(status.ahead, status.behind)
    if (track.length > 0) {
      items.push(el('div', { class: 'dsh-og-status-item' },
        el('span', { class: 'dsh-og-status-label' }, '同步:'),
        tag(track, status.behind > 0 ? 'warning' : 'primary', { title: '领先 / 落后于上游' })))
    }
    const stateText = REPO_STATE_TEXT[status.repoState.state] ?? ''
    items.push(el('div', { class: 'dsh-og-status-item' },
      el('span', { class: 'dsh-og-status-label' }, '状态:'),
      tag(stateText.length > 0 ? stateText : (status.counts.total === 0 ? '干净' : status.counts.total + ' 个改动'),
        stateText.length > 0 ? 'warning' : (status.counts.total === 0 ? 'success' : 'primary'))))
    if (status.stashCount > 0) {
      items.push(el('div', { class: 'dsh-og-status-item' },
        el('span', { class: 'dsh-og-status-label' }, '贮藏:'),
        tag(String(status.stashCount), 'info', { onClick: () => switchTab('stashes') })))
    }
  }

  items.push(el('div', { class: 'dsh-og-status-item', style: { 'margin-left': 'auto', 'min-width': '0' } },
    el('span', { class: 'dsh-og-status-label' }, '当前仓库:'),
    el('span', {
      class: 'dsh-og-status-value',
      title: repo === undefined ? '' : (repo.root ?? repo.path),
      onClick: () => {
        if (repo !== undefined) void copyText(repo.root ?? repo.path, '已复制仓库路径')
      },
    }, repo === undefined ? '未选择' : (repo.root ?? repo.path))))

  items.push(el('div', { class: 'dsh-og-status-item' },
    el('span', {
      class: 'dsh-og-repo-dot',
      style: { background: model.connected ? 'var(--og-success)' : 'var(--og-text-3)' },
      title: model.connected ? '已连接事件流' : '事件流未连接',
    })))

  fill(statusbarEl, items)
}

// ---------------------------------------------------------------- seat mount
/** The sidebar entry button that opens the panel. */
function createEntry() {
  const node = el('button', {
    type: 'button',
    class: 'dsh-og-entry',
    'data-dsh-otools-git-entry': '',
    'aria-label': 'Git',
    onClick: () => setOpen(!model.open),
  },
  el('span', { class: 'dsh-og-entry-icon', 'aria-hidden': 'true' }, icon('git', 15)),
  el('span', { class: 'dsh-og-entry-label' }, 'Git'),
  el('span', { class: 'dsh-og-entry-stats' }))
  return node
}

/** Keep the entry's badge in step with the active repository. */
function renderEntry() {
  if (entryEl === null) return
  setData(entryEl, 'active', model.open)
  const stats = entryEl.querySelector('.dsh-og-entry-stats')
  if (stats === null) return
  const status = model.status
  const parts = []
  if (status !== null) {
    if (status.counts.total > 0) parts.push('±' + status.counts.total)
    const track = trackText(status.ahead, status.behind)
    if (track.length > 0) parts.push(track)
  }
  fill(stats, parts.join(' '))
}

/** The DSH shell's sidebar root, across its layout generations. */
function sidebarRoot() {
  const column = document.querySelector(SIDEBAR_SELECTOR)
  if (column === null) return undefined
  const logoRow = column.querySelector('[class*="logoRow"]')
  return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) ?? undefined
}

/** The centre column the panel takes over. */
function conversationColumn() {
  const column = document.querySelector(CONVERSATION_SELECTOR)
  return column === null ? undefined : column
}

/**
 * Put the entry with the other panel plugins' entries, so the buttons stay
 * grouped whichever plugin mounts first.
 */
function placeEntry() {
  if (entryEl === null) return
  const root = sidebarRoot()
  if (root === undefined || !root.isConnected) return
  if (entryEl.parentElement === root) return
  const family = Array.from(root.children).filter((child) =>
    child instanceof HTMLElement && child.matches(ENTRY_SELECTOR + ', ' + SIBLING_ENTRIES))
  if (family.length > 0) {
    root.insertBefore(entryEl, family[family.length - 1].nextElementSibling)
    return
  }
  const nested = root.querySelector('button[class*="newSession"]')
  const row = nested === null || nested.parentElement === null
    ? null
    : (nested.parentElement === root ? nested : nested.closest('[class*="logoRow"]'))
  if (row !== null) {
    root.insertBefore(entryEl, row.nextElementSibling)
    return
  }
  root.append(entryEl)
}

/** Attach (or re-attach) the view as a trailing child of the centre column. */
function ensureView() {
  const column = conversationColumn()
  if (column === undefined) return
  if (viewEl === null || !viewEl.isConnected) {
    if (viewEl !== null) viewEl.remove()
    viewEl = el('div', { class: 'dsh-og-view', 'data-dsh-og-view': '' })
    panelEl = null
  }
  if (viewEl.parentElement !== column) column.append(viewEl)
  if (panelEl === null || !panelEl.isConnected) {
    viewEl.replaceChildren()
    buildPanel(viewEl)
    renderPanel()
  }
}

/** Open or close the panel, telling the sibling panels to stand down. */
function setOpen(open) {
  model.open = open
  if (open) {
    document.documentElement.setAttribute(OPEN_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    void bootData()
  } else {
    document.documentElement.removeAttribute(OPEN_ATTR)
    closeMenu()
  }
  emit()
}

/** First-open data load; subsequent opens only refresh. */
let dataBooted = false
async function bootData() {
  if (dataBooted) {
    await refreshTab()
    return
  }
  dataBooted = true
  await loadPrefs()
  const remembered = storeGet(STORE_KEYS.workspaceId, '')
  if (typeof remembered === 'string' && remembered.length > 0) model.workspaceId = remembered
  const savedTab = pref('activeTab')
  if (typeof savedTab === 'string' && TABS.some((row) => row.id === savedTab)) model.tab = savedTab
  await Promise.all([loadInstall(), loadAiAvailability()])
  await loadRepos()
  await Promise.all([refreshTab(), loadChildren(), loadRemotes(), loadBranches(), loadCredentials()])
}
