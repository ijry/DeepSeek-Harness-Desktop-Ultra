/**
 * The 工作区 pane: the four working-tree sections on the left, the diff on the
 * right, the commit box underneath — the same three-part layout as the
 * reference's GitStatusPanel, including its two splitters.
 *
 * Section semantics follow git rather than the reference's Chinese status strings:
 * the host reports the porcelain XY pair per file, so a file that is both staged
 * and modified appears in both sections and each row's checkbox acts on the side
 * it is shown under.
 */

/** Render the status pane into `host`. */
function renderStatusPane(host) {
  if (model.workspaceId.length === 0) {
    fill(host, emptyState('先在左边选一个仓库'))
    return
  }
  if (model.statusError !== null) {
    fill(host, el('div', { class: 'dsh-og-pane-inner' },
      alertBox('error', '读取仓库状态失败', model.statusError),
      el('div', { style: { 'margin-top': '10px' } },
        button('重试', { kind: 'primary', onClick: () => void loadStatus() }))))
    return
  }
  if (model.status === null) {
    fill(host, el('div', { class: 'dsh-og-loading' }, '正在读取仓库状态...'))
    return
  }

  const filesWidth = pref('filesPanelWidth') > 0 ? pref('filesPanelWidth') : 380
  const files = el('div', { class: 'dsh-og-status-files', style: { width: filesWidth + 'px' } })
  const sections = el('div', { class: 'dsh-og-status-sections' })
  const diff = el('div', { class: 'dsh-og-diff' })

  files.append(sections, commitBox())
  renderSections(sections)
  renderDiffPanel(diff)

  const handle = resizeHandle({
    axis: 'x',
    min: 260,
    max: () => Math.max(300, host.clientWidth - 300),
    value: () => files.getBoundingClientRect().width,
    onMove: (value) => {
      files.style.width = value + 'px'
    },
    onCommit: (value) => void savePrefs({ filesPanelWidth: Math.round(value) }),
    onReset: () => {
      files.style.width = '380px'
      void savePrefs({ filesPanelWidth: 0 })
    },
  })

  fill(host, el('div', { class: 'dsh-og-status' }, files, handle, diff))
}

/** The state banner shown above the sections while a merge/rebase is unfinished. */
function repoStateBanner() {
  const state = model.status?.repoState
  if (state === undefined || state === null || state.state === 'clean') return undefined
  const label = REPO_STATE_TEXT[state.state] ?? state.state
  const detail = []
  if (state.headName !== undefined) detail.push('分支 ' + state.headName)
  if (state.onto !== undefined) detail.push('目标 ' + shortOid(state.onto))
  if (state.step !== undefined && state.total !== undefined) detail.push(state.step + '/' + state.total)
  const operation = state.state === 'rebasing' ? 'rebase'
    : state.state === 'cherry_picking' ? 'cherry-pick'
      : state.state === 'reverting' ? 'revert' : 'merge'
  return el('div', { style: { 'margin-bottom': '8px' } },
    alertBox('warning', label + (detail.length > 0 ? '（' + detail.join('，') + '）' : ''),
      el('div', { style: { display: 'flex', gap: '8px', 'margin-top': '6px' } },
        button('继续', {
          kind: 'primary',
          size: 'mini',
          onClick: () => void runSequencer(operation, 'continue'),
        }),
        operation === 'merge' ? undefined : button('跳过', {
          size: 'mini',
          onClick: () => void runSequencer(operation, 'skip'),
        }),
        button('中止', {
          kind: 'danger',
          size: 'mini',
          onClick: () => void runSequencer(operation, 'abort'),
        }))))
}

/** All four sections, in display order. */
function renderSections(host) {
  const status = model.status
  const banner = repoStateBanner()
  const nodes = banner === undefined ? [] : [banner]

  if (status.unborn === true) {
    nodes.push(el('div', { style: { 'margin-bottom': '8px' } },
      alertBox('info', '这是一个还没有任何提交的仓库', '第一次提交会创建 ' + (status.branch ?? 'main') + ' 分支。')))
  }

  let rendered = 0
  for (const section of SECTIONS) {
    const rows = status.groups[section.id] ?? []
    if (rows.length === 0) continue
    rendered += 1
    nodes.push(sectionBlock(section, rows))
  }
  if (rendered === 0) {
    nodes.push(emptyState('工作区是干净的', status.headSubject === undefined ? undefined : 'HEAD: ' + status.headSubject))
  }
  fill(host, nodes)
}

/** One section: its heading, its group actions, and its rows. */
function sectionBlock(section, rows) {
  const head = el('div', { class: 'dsh-og-section-head' },
    el('h5', { class: 'dsh-og-section-title' }, section.label),
    el('span', { class: 'dsh-og-section-count' }, '(' + rows.length + ')'))
  const actions = el('div', { class: 'dsh-og-section-actions' })

  if (section.id === 'staged') {
    actions.append(button('全部取消暂存', {
      size: 'mini',
      kind: 'text',
      onClick: () => void act('/unstage-all', {}, '已取消暂存全部文件'),
    }))
  } else if (section.id === 'unstaged' || section.id === 'untracked') {
    actions.append(button('全部暂存', {
      size: 'mini',
      kind: 'text',
      onClick: () => void act('/stage', { paths: rows.map((row) => row.path) }, '已暂存 ' + rows.length + ' 个文件'),
    }))
    actions.append(button('全部丢弃', {
      size: 'mini',
      kind: 'text',
      onClick: () => void discard(rows),
    }))
  } else if (section.id === 'conflicted') {
    actions.append(button('全部标记已解决', {
      size: 'mini',
      kind: 'text',
      onClick: () => void act('/conflict/resolve', { paths: rows.map((row) => row.path), side: 'mark' }, '已标记解决'),
    }))
  }
  // The view switch belongs to the first rendered section, as the reference put it.
  if (section.id === SECTIONS.find((entry) => (model.status.groups[entry.id] ?? []).length > 0)?.id) {
    const mode = pref('statusViewMode') === 'tree' ? 'tree' : 'list'
    actions.append(iconButton(mode === 'tree' ? 'files' : 'folder', {
      title: mode === 'tree' ? '切换到文件列表' : '切换到文件树',
      onClick: () => void savePrefs({ statusViewMode: mode === 'tree' ? 'list' : 'tree' }),
    }))
  }
  head.append(actions)

  const body = el('div', { class: 'dsh-og-section-body' })
  if (pref('statusViewMode') === 'tree') renderFileTree(body, section, rows)
  else for (const row of rows) body.append(fileRow(section, row, rows))
  return el('div', { class: 'dsh-og-section' }, head, body)
}

/** One file row. */
function fileRow(section, row, siblings) {
  const orderedPaths = siblings.map((entry) => entry.path)
  const letter = section.id === 'staged' ? row.index : (row.untracked ? '?' : row.worktree)
  const isActive = model.activeFile !== null &&
    model.activeFile.path === row.path && model.activeFile.section === section.id

  const node = el('div', {
    class: 'dsh-og-file',
    'data-active': isActive ? 'true' : undefined,
    'data-selected': isSelected(section.id, row.path) ? 'true' : undefined,
    title: row.origPath === undefined ? row.path : row.origPath + ' → ' + row.path,
    onClick: (event) => {
      selectPath(section.id, row.path, event, orderedPaths)
      openFileDiff(section, row)
    },
    onDblclick: () => void toggleStage(section, [row.path]),
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!isSelected(section.id, row.path)) selectPath(section.id, row.path, undefined, orderedPaths)
      emit()
      showMenu(event.clientX, event.clientY, fileMenu(section, row))
    },
  })

  const box = el('input', { type: 'checkbox' })
  box.checked = section.id === 'staged'
  box.addEventListener('click', (event) => {
    event.stopPropagation()
    void toggleStage(section, actionPaths(section.id, row.path))
  })
  node.append(el('span', { class: 'dsh-og-file-check' }, box))
  node.append(el('span', { class: 'dsh-og-file-icon' }, fileIcon(row.path)))

  const dir = dirName(row.path)
  node.append(el('span', { class: 'dsh-og-file-name' },
    dir.length === 0 ? undefined : el('span', { class: 'dsh-og-file-dir' }, dir + '/'),
    baseName(row.path)))
  if (row.submodule === true) node.append(tag('子模块', 'info'))
  node.append(el('span', {
    class: 'dsh-og-file-mark',
    'data-letter': letter,
    title: STATUS_TEXT[letter] ?? '未知',
  }, STATUS_MARK[letter] ?? letter))
  node.append(rowActions(section, row))
  return node
}

/** The hover actions on a file row. */
function rowActions(section, row) {
  const wrap = el('div', { class: 'dsh-og-file-actions' })
  if (section.id === 'staged') {
    wrap.append(iconButton('minus', {
      title: '取消暂存',
      onClick: (event) => {
        event.stopPropagation()
        void act('/unstage', { paths: actionPaths(section.id, row.path) }, '已取消暂存')
      },
    }))
  } else if (section.id === 'conflicted') {
    wrap.append(iconButton('check', {
      title: '标记为已解决',
      onClick: (event) => {
        event.stopPropagation()
        void act('/conflict/resolve', { paths: actionPaths(section.id, row.path), side: 'mark' }, '已标记解决')
      },
    }))
  } else {
    wrap.append(iconButton('plus', {
      title: '暂存',
      onClick: (event) => {
        event.stopPropagation()
        void act('/stage', { paths: actionPaths(section.id, row.path) }, '已暂存')
      },
    }))
    wrap.append(iconButton('undo', {
      title: row.untracked === true ? '删除这个未跟踪文件' : '丢弃改动',
      onClick: (event) => {
        event.stopPropagation()
        const paths = actionPaths(section.id, row.path)
        void discard((model.status.groups[section.id] ?? []).filter((entry) => paths.includes(entry.path)))
      },
    }))
  }
  wrap.append(iconButton('clock', {
    title: '文件历史',
    onClick: (event) => {
      event.stopPropagation()
      openFileHistory(row.path)
    },
  }))
  return wrap
}

/** The file row's context menu. */
function fileMenu(section, row) {
  const paths = actionPaths(section.id, row.path)
  const many = paths.length > 1
  const suffix = many ? '所选 ' + paths.length + ' 个文件' : ''
  const items = [{ head: many ? '已选 ' + paths.length + ' 个文件' : row.path }]

  if (section.id === 'staged') {
    items.push({
      label: '取消暂存' + suffix,
      icon: 'minus',
      onClick: () => void act('/unstage', { paths }, '已取消暂存'),
    })
  } else if (section.id === 'conflicted') {
    items.push({
      label: '使用我方 (--ours)',
      onClick: () => void act('/conflict/resolve', { paths, side: 'ours' }, '已按我方解决'),
    })
    items.push({
      label: '使用他方 (--theirs)',
      onClick: () => void act('/conflict/resolve', { paths, side: 'theirs' }, '已按他方解决'),
    })
    items.push({
      label: '标记为已解决',
      icon: 'check',
      onClick: () => void act('/conflict/resolve', { paths, side: 'mark' }, '已标记解决'),
    })
  } else {
    items.push({
      label: '添加到暂存区' + suffix,
      icon: 'plus',
      onClick: () => void act('/stage', { paths }, '已暂存'),
    })
    items.push({
      label: row.untracked === true ? '删除' + suffix : '丢弃改动' + suffix,
      icon: 'undo',
      tone: 'danger',
      onClick: () => void discard((model.status.groups[section.id] ?? []).filter((entry) => paths.includes(entry.path))),
    })
  }

  items.push('sep')
  items.push({ label: '文件历史', icon: 'clock', onClick: () => openFileHistory(row.path) })
  items.push({ label: '复制路径', icon: 'copy', onClick: () => copyText(row.path, '已复制文件路径') })
  if (section.id === 'staged') {
    items.push({
      label: '与 HEAD 比较',
      onClick: () => openFileDiff({ id: 'staged' }, row),
    })
  }
  items.push('sep')
  items.push({
    label: '贮藏这些文件',
    icon: 'stash',
    onClick: () => openStashDialog(paths),
  })
  return items
}

/** The tree view of one section: directories collapse, files are the leaves. */
function renderFileTree(host, section, rows) {
  const root = { dirs: new Map(), files: [] }
  for (const row of rows) {
    const parts = row.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    }
    node.files.push(row)
  }
  fill(host, treeLevel(root, section, rows, ''))
}

/**
 * Collapsed directories for the session, keyed by workspace + section + path so a
 * folder collapsed in one repository does not come back collapsed in another that
 * happens to have a directory by the same name.
 */
const collapsedDirs = new Set()

/** The collapse key for one directory. */
function dirKey(section, path) {
  return model.workspaceId + ':' + section.id + ':' + path
}

/** One level of the file tree. */
function treeLevel(node, section, rows, prefix) {
  const nodes = []
  const names = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  for (const name of names) {
    const path = prefix.length === 0 ? name : prefix + '/' + name
    const key = dirKey(section, path)
    const open = !collapsedDirs.has(key)
    const child = node.dirs.get(name)
    const caret = el('span', { class: 'dsh-og-dirnode-caret' }, icon('caret'))
    const head = el('div', {
      class: 'dsh-og-dirnode',
      'data-open': open ? 'true' : 'false',
      onClick: () => {
        if (open) collapsedDirs.add(key)
        else collapsedDirs.delete(key)
        emit()
      },
    }, caret, el('span', { class: 'dsh-og-file-icon' }, fileIcon(name, { directory: true })), name)
    nodes.push(head)
    if (open) {
      nodes.push(el('div', { class: 'dsh-og-tree-children' }, treeLevel(child, section, rows, path)))
    }
  }
  for (const row of node.files) nodes.push(fileRow(section, row, rows))
  return nodes
}

// ------------------------------------------------------------------ actions
/** Stage or unstage, depending on which section a row came from. */
async function toggleStage(section, paths) {
  if (section.id === 'staged') {
    await act('/unstage', { paths }, '已取消暂存')
    return
  }
  if (section.id === 'conflicted') {
    await act('/conflict/resolve', { paths, side: 'mark' }, '已标记解决')
    return
  }
  await act('/stage', { paths }, '已暂存')
}

/**
 * Discard, split into "restore this tracked file" and "delete this untracked
 * file" — two different acts that must be confirmed as such, which is why the
 * dialog counts them separately the way the reference's does.
 */
async function discard(rows) {
  if (rows.length === 0) return
  const tracked = rows.filter((row) => row.untracked !== true).map((row) => row.path)
  const untracked = rows.filter((row) => row.untracked === true).map((row) => row.path)
  const lines = []
  if (rows.length === 1) {
    lines.push(untracked.length === 1
      ? '确定要删除文件 "' + rows[0].path + '" 吗？'
      : '确定要丢弃文件 "' + rows[0].path + '" 的改动吗？')
    lines.push(untracked.length === 1 ? '这是一个新文件，将被删除。' : '未提交的改动会丢失，且无法恢复。')
  } else {
    lines.push('确定要重置所选 ' + rows.length + ' 个文件吗？')
    if (untracked.length > 0) lines.push('其中 ' + untracked.length + ' 个未跟踪文件将被删除。')
    if (tracked.length > 0) lines.push('其中 ' + tracked.length + ' 个文件的改动将丢失。')
  }
  const confirmed = await confirmBox({
    title: '确认丢弃改动',
    message: lines.join('\n'),
    confirmText: '丢弃',
    tone: 'danger',
    alert: { tone: 'error', title: '这个操作不可恢复' },
  })
  if (!confirmed) return
  await act('/discard', { tracked, untracked, staged: false }, '已丢弃改动')
}

/**
 * One mutating call plus the refresh it implies. Every status-pane action goes
 * through here so the "act, then re-read, then report" order is the same
 * everywhere and no caller can forget the refresh.
 */
async function act(route, body, successMessage) {
  try {
    const value = await withBusy(() => apiPost(route, { workspaceId: model.workspaceId, ...body }))
    if (value !== null && value !== undefined && value.conflict === true) {
      toast('操作完成，但存在冲突，请在工作区里解决', 'warning', 5000)
    } else if (successMessage !== undefined) {
      toast(successMessage, 'success', 1800)
    }
    await Promise.all([loadStatus(), loadRepos()])
    // A diff that is open on a file the action just changed has to be re-read —
    // but only when it is one of the three sources `/diff/file` serves. A stash
    // diff comes from its own route and replaying it here would 400.
    const source = model.diffSource
    if (source !== null && (source.kind === 'worktree' || source.kind === 'staged' || source.kind === 'commit')) {
      await loadDiff({ kind: source.kind, rev: source.rev }, source.path, source.origPath)
    }
    return value
  } catch (error) {
    toastError(error)
    await loadStatus()
    return undefined
  }
}

/** Continue / skip / abort the operation in progress. */
async function runSequencer(operation, action) {
  if (action === 'abort') {
    const confirmed = await confirmBox({
      title: '中止操作',
      message: '确定要中止当前的 ' + operation + ' 吗？已经解决的冲突会一起回退。',
      confirmText: '中止',
      tone: 'danger',
    })
    if (!confirmed) return
  }
  await act('/sequencer', { operation, action }, operation + ' --' + action + ' 已执行')
}

/** Open one file's diff in the right-hand pane. */
function openFileDiff(section, row) {
  model.activeFile = { section: section.id, path: row.path }
  const kind = section.id === 'staged' ? 'staged' : 'worktree'
  emit()
  void loadDiff({ kind }, row.path, row.origPath)
}
