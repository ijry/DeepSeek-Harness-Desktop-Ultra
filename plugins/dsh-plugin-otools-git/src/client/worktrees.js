/**
 * The 工作树 pane: the worktree list with add / lock / remove / prune.
 *
 * The DSH shell already switches workspaces, so a worktree row does not try to
 * become the active repository — it points at the path and says whether DSH has
 * that folder open, which is the honest thing a panel can do here.
 */

/** Render the worktree pane. */
function renderWorktreePane(host) {
  const rows = model.children.worktrees ?? []
  const main = currentRepo()
  const bar = el('div', { class: 'dsh-og-filters' },
    button('新增工作树...', { kind: 'primary', icon: 'plus', onClick: () => openWorktreeDialog() }),
    button('清理失效记录', { onClick: () => void act('/worktree/prune', {}, '已清理失效工作树记录') }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadChildren() })))

  if (rows.length === 0) {
    fill(host, bar, emptyState('这个仓库只有主工作树', '工作树可以让同一个仓库在不同目录里检出不同分支'))
    return
  }

  const openPaths = new Set(model.repos.map((row) => (row.root ?? row.path).replace(/\\/g, '/')))
  const columns = [
    {
      key: 'path',
      label: '目录',
      render: (row) => el('div', { class: 'dsh-og-msg-cell' },
        el('span', { class: 'dsh-og-file-icon' }, icon('worktree')),
        el('span', { class: 'dsh-og-msg-text', title: row.path }, row.path)),
    },
    {
      key: 'branch',
      label: '分支',
      width: 170,
      render: (row) => (row.detached === true
        ? el('span', { style: { color: 'var(--og-text-3)' } }, '游离 ' + row.shortHead)
        : row.branch),
    },
    { key: 'head', label: 'HEAD', width: 80, cellClass: 'dsh-og-cell-mono', render: (row) => row.shortHead },
    {
      key: 'state',
      label: '状态',
      width: 160,
      render: (row) => {
        const chips = el('div', { style: { display: 'flex', gap: '4px' } })
        if (row.isMain === true) chips.append(tag('主仓库', 'primary'))
        if (row.locked === true) chips.append(tag('已锁定', 'warning', { title: row.lockReason }))
        if (row.prunable === true) chips.append(tag('失效', 'danger', { title: row.prunableReason }))
        if (openPaths.has(row.path.replace(/\\/g, '/'))) chips.append(tag('DSH 已打开', 'success'))
        return chips
      },
    },
    {
      key: 'actions',
      label: '操作',
      width: 100,
      render: (row) => el('div', { style: { display: 'flex', gap: '4px' } },
        iconButton('more', {
          title: '更多',
          onClick: (event) => menuUnder(event.currentTarget, worktreeMenu(row)),
        })),
    },
  ]
  const all = main === undefined || main.root === undefined
    ? rows
    : [{ path: main.root, branch: main.branch, shortHead: main.shortOid, detached: main.detached, isMain: true }, ...rows]
  fill(host, bar, el('div', { class: 'dsh-og-table-scroll' }, table(columns, all, {})))
}

/** A worktree row's menu. */
function worktreeMenu(row) {
  return [
    { head: row.path },
    { label: '复制目录路径', icon: 'copy', onClick: () => copyText(row.path, '已复制目录路径') },
    row.isMain === true ? undefined : 'sep',
    row.isMain === true ? undefined : (row.locked === true
      ? { label: '解锁', onClick: () => void act('/worktree/lock', { path: row.path, lock: false }, '已解锁') }
      : { label: '锁定...', icon: 'lock', onClick: () => void lockWorktreeRow(row) }),
    row.isMain === true ? undefined : {
      label: '删除这个工作树',
      icon: 'trash',
      tone: 'danger',
      onClick: () => void removeWorktreeRow(row),
    },
  ]
}

/** Lock a worktree with a reason. */
async function lockWorktreeRow(row) {
  const reason = await promptBox({
    title: '锁定工作树',
    message: '锁定后 git 不会自动清理它。理由（会写进 git 的记录）：',
    placeholder: '例如：放在移动硬盘上',
    emptyMessage: '请填写理由',
  })
  if (reason === undefined) return
  await act('/worktree/lock', { path: row.path, lock: true, reason }, '已锁定')
  await loadChildren()
}

/** Remove a worktree. */
async function removeWorktreeRow(row) {
  const confirmed = await confirmBox({
    title: '删除工作树',
    message: '确定要删除工作树 "' + row.path + '" 吗？',
    confirmText: '删除',
    tone: 'danger',
    alert: { tone: 'warning', title: '目录会被删除', description: '里面未提交的改动会一起消失；分支本身不会被删除。' },
  })
  if (!confirmed) return
  try {
    await withBusy(() => apiPost('/worktree/remove', {
      workspaceId: model.workspaceId,
      path: row.path,
      force: false,
    }))
    toast('已删除工作树', 'success')
  } catch (error) {
    // git refuses a dirty worktree without --force; ask rather than force by default.
    if (/contains modified or untracked files|is dirty/i.test(messageOf(error))) {
      const force = await confirmBox({
        title: '工作树里有未提交的改动',
        message: '"' + row.path + '" 里还有改动，强制删除会一并丢弃。',
        confirmText: '强制删除',
        tone: 'danger',
      })
      if (!force) return
      await act('/worktree/remove', { path: row.path, force: true }, '已强制删除工作树')
    } else {
      toastError(error)
    }
  }
  await Promise.all([loadChildren(), loadRepos()])
}

/** Create a worktree. */
function openWorktreeDialog() {
  const state = { path: '', mode: 'new-branch', branch: '', startPoint: '' }
  openDialog({
    title: '新建工作树',
    build: (handle) => [
      field('根仓库', input({ value: currentRepo()?.root ?? '', readonly: true })),
      field('目录', input({
        placeholder: '相对根仓库的路径，或一个绝对路径',
        onInput: (event) => {
          state.path = event.target.value
        },
      })),
      field('模式', select({
        value: state.mode,
        options: [
          { id: 'new-branch', label: '新分支' },
          { id: 'existing-branch', label: '已有分支' },
          { id: 'detached', label: '游离检出' },
        ],
        onChange: (value) => {
          state.mode = value
          handle.render()
        },
      })),
      state.mode === 'existing-branch'
        ? field('分支', select({
          value: state.branch,
          options: [
            { id: '', label: '请选择已有分支' },
            ...model.branches.filter((row) => row.remote !== true && row.worktreePath === undefined)
              .map((row) => ({ id: row.name, label: row.name })),
          ],
          onChange: (value) => {
            state.branch = value
          },
        }), '已经在别的工作树里检出的分支不能重复检出。')
        : undefined,
      state.mode === 'new-branch'
        ? field('新分支', input({
          placeholder: '例如 feature/login',
          onInput: (event) => {
            state.branch = event.target.value
          },
        }))
        : undefined,
      state.mode === 'existing-branch'
        ? undefined
        : field('起点（可选）', input({
          placeholder: '留空则从当前 HEAD 开始',
          onInput: (event) => {
            state.startPoint = event.target.value
          },
        })),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('新建', {
        kind: 'primary',
        onClick: async () => {
          if (state.path.trim().length === 0) {
            toast('请填写工作树目录', 'warning')
            return
          }
          if (state.mode !== 'detached' && state.branch.trim().length === 0) {
            toast(state.mode === 'new-branch' ? '请输入新分支名称' : '请选择已有分支', 'warning')
            return
          }
          handle.close()
          await act('/worktree/add', {
            path: state.path.trim(),
            mode: state.mode,
            branch: state.branch.trim().length === 0 ? undefined : state.branch.trim(),
            startPoint: state.startPoint.trim().length === 0 ? undefined : state.startPoint.trim(),
          }, '已创建工作树')
          await Promise.all([loadChildren(), loadBranches()])
        },
      }),
    ],
  })
}
