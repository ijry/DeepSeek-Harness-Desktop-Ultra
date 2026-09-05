/**
 * The 贮藏 pane and the create-stash dialog.
 *
 * The reference offered only apply and delete. `pop` (apply and drop, the thing
 * people actually mean), `--index` (restore what was staged) and `stash branch`
 * are here too, because leaving them out means dropping to a terminal for the
 * common cases.
 */

/** Render the stash pane. */
function renderStashPane(host) {
  const bar = el('div', { class: 'dsh-og-filters' },
    button('贮藏当前改动...', { kind: 'primary', icon: 'stash', onClick: () => openStashDialog() }),
    model.stashes.length === 0 ? undefined : button('清空全部', {
      kind: 'text',
      onClick: async () => {
        const confirmed = await confirmBox({
          title: '清空贮藏',
          message: '确定要删除全部 ' + model.stashes.length + ' 条贮藏吗？此操作不可恢复。',
          confirmText: '全部删除',
          tone: 'danger',
        })
        if (!confirmed) return
        await act('/stash/clear', {}, '已清空贮藏')
        await loadStashes()
      },
    }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadStashes() })))

  if (model.stashes.length === 0) {
    fill(host, bar, emptyState('暂无 stash 记录'))
    return
  }

  const list = el('div', { class: 'dsh-og-filelist', style: { width: '36%' } })
  const scroll = el('div', { class: 'dsh-og-filelist-scroll' })
  for (const row of model.stashes) scroll.append(stashRow(row))
  list.append(scroll)

  const right = el('div', { class: 'dsh-og-diff' })
  renderStashDetail(right)

  const handle = resizeHandle({
    axis: 'x',
    min: 220,
    max: () => Math.max(260, host.clientWidth - 280),
    value: () => list.getBoundingClientRect().width,
    onMove: (value) => {
      list.style.width = value + 'px'
    },
  })
  fill(host, bar, el('div', { class: 'dsh-og-split-row' }, list, handle, right))
}

/** One stash row. */
function stashRow(row) {
  const node = el('div', {
    class: 'dsh-og-row',
    'data-current': row.refName === model.activeStash ? 'true' : undefined,
    onClick: () => void loadStashDetail(row.refName),
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      showMenu(event.clientX, event.clientY, stashMenu(row))
    },
  },
  el('span', { class: 'dsh-og-file-icon' }, icon('stash')),
  el('div', { style: { flex: '1', 'min-width': '0' } },
    el('div', { class: 'dsh-og-row-name' }, row.message.length === 0 ? '(无描述)' : row.message),
    el('div', { class: 'dsh-og-repo-meta' },
      el('span', { class: 'dsh-og-cell-mono' }, row.refName),
      row.date === undefined ? undefined : el('span', {}, row.date))),
  el('div', { class: 'dsh-og-row-actions' },
    iconButton('more', {
      title: '操作',
      onClick: (event) => {
        event.stopPropagation()
        menuUnder(event.currentTarget, stashMenu(row))
      },
    })))
  return node
}

/** A stash row's menu. */
function stashMenu(row) {
  return [
    { head: row.refName },
    { label: '应用到工作区（保留贮藏）', icon: 'download', onClick: () => void applyStashRow(row, 'apply', false) },
    { label: '应用并恢复暂存区', onClick: () => void applyStashRow(row, 'apply', true) },
    { label: '弹出（应用后删除）', icon: 'download', onClick: () => void applyStashRow(row, 'pop', false) },
    'sep',
    { label: '基于它创建分支...', icon: 'branch', onClick: () => void stashToBranchRow(row) },
    'sep',
    { label: '删除这条贮藏', icon: 'trash', tone: 'danger', onClick: () => void dropStashRow(row) },
  ]
}

/**
 * Apply or pop a stash. The reference required a clean worktree before allowing
 * this; git does not, and refusing a merge git would have done cleanly is worse
 * than letting it try — so a dirty tree gets a warning instead of a wall.
 */
async function applyStashRow(row, action, restoreIndex) {
  const dirty = (model.status?.counts.total ?? 0) > 0
  if (dirty) {
    const confirmed = await confirmBox({
      title: action === 'pop' ? '弹出贮藏' : '应用贮藏',
      message: '工作区当前有未提交的改动，应用 ' + row.refName + ' 可能产生冲突。要继续吗？',
      confirmText: '继续',
      tone: 'warning',
    })
    if (!confirmed) return
  }
  const result = await act('/stash/apply', { ref: row.refName, action, restoreIndex },
    action === 'pop' ? '已弹出 ' + row.refName : '已应用 ' + row.refName)
  if (result !== undefined) await loadStashes()
}

/** Drop one stash. */
async function dropStashRow(row) {
  const confirmed = await confirmBox({
    title: '删除贮藏确认',
    message: '确定要删除贮藏 ' + row.refName + ' 吗？此操作不可恢复。',
    confirmText: '删除',
    tone: 'danger',
  })
  if (!confirmed) return
  await act('/stash/apply', { ref: row.refName, action: 'drop' }, '已删除 ' + row.refName)
  model.activeStash = null
  model.stashFiles = []
  await loadStashes()
}

/** Turn a stash into a branch. */
async function stashToBranchRow(row) {
  const name = await promptBox({
    title: '基于贮藏创建分支',
    message: '把 ' + row.refName + ' 应用到一个新分支上：',
    placeholder: '例如 wip/login',
    emptyMessage: '分支名不能为空',
  })
  if (name === undefined) return
  await act('/stash/branch', { ref: row.refName, branch: name }, '已创建分支 ' + name)
  model.activeStash = null
  await Promise.all([loadStashes(), loadBranches(), loadRepos()])
}

/** The selected stash's files, and the diff of the one that is clicked. */
function renderStashDetail(host) {
  if (model.activeStash === null) {
    fill(host, el('div', { class: 'dsh-og-diff-empty' }, '请选择左侧 stash 查看差异'))
    return
  }
  const files = el('div', { style: { flex: 'none', 'max-height': '35%', overflow: 'auto' } })
  for (const file of model.stashFiles) {
    files.append(el('div', {
      class: 'dsh-og-file',
      'data-active': model.diffSource !== null && model.diffSource.path === file.path ? 'true' : undefined,
      onClick: () => void loadStashFileDiff(file),
    },
    el('span', { class: 'dsh-og-file-icon' }, fileIcon(file.path)),
    el('span', { class: 'dsh-og-file-name' }, file.path),
    el('span', { class: 'dsh-og-file-stat' },
      el('span', { class: 'dsh-og-adds' }, '+' + file.additions),
      el('span', { class: 'dsh-og-dels' }, '-' + file.deletions)),
    el('span', { class: 'dsh-og-file-mark', 'data-letter': file.status }, STATUS_MARK[file.status] ?? file.status)))
  }
  if (model.stashFiles.length === 0) {
    files.append(el('div', { class: 'dsh-og-loading' }, '该 stash 暂无可展示差异'))
  }
  const diff = el('div', { class: 'dsh-og-diff' })
  renderDiffPanel(diff)
  fill(host, files, diff)
}

/** Load one file's diff out of a stash. */
async function loadStashFileDiff(file) {
  model.diffLoading = true
  model.diffSource = { kind: 'stash', path: file.path, rev: model.activeStash }
  emit()
  try {
    model.diff = await apiGet('/stash/diff', {
      workspaceId: model.workspaceId,
      ref: model.activeStash,
      path: file.path,
    })
  } catch (error) {
    model.diff = { error: friendlyError(error), lines: [] }
  }
  model.diffLoading = false
  emit()
}

/**
 * The create-stash dialog. `paths` limits it to a selection, which is how the
 * status pane's "贮藏这些文件" entry works.
 */
function openStashDialog(paths) {
  const state = { message: '', includeUntracked: true, keepIndex: false }
  openDialog({
    title: paths === undefined ? '贮藏当前改动' : '贮藏所选 ' + paths.length + ' 个文件',
    build: () => [
      field('说明（可选）', input({
        placeholder: '留空则使用 git 自动说明',
        onInput: (event) => {
          state.message = event.target.value
        },
      })),
      checkbox('包含未跟踪文件（--include-untracked）', {
        checked: state.includeUntracked,
        onChange: (checked) => {
          state.includeUntracked = checked
        },
      }),
      checkbox('保留暂存区内容（--keep-index）', {
        checked: state.keepIndex,
        onChange: (checked) => {
          state.keepIndex = checked
        },
      }),
      paths === undefined ? undefined : el('div', { style: { 'margin-top': '10px' } },
        alertBox('info', '只贮藏这些文件', paths.slice(0, 8).join('\n') + (paths.length > 8 ? '\n…' : ''))),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'primary',
        onClick: async () => {
          handle.close()
          const result = await act('/stash/create', {
            message: state.message.trim().length === 0 ? undefined : state.message.trim(),
            includeUntracked: state.includeUntracked,
            keepIndex: state.keepIndex,
            paths,
          }, undefined)
          if (result !== undefined) {
            toast(result.noChanges === true ? '没有需要贮藏的改动' : '贮藏完成',
              result.noChanges === true ? 'warning' : 'success')
          }
          await loadStashes()
        },
      }),
    ],
  })
}
