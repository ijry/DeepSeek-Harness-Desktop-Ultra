/**
 * The 子模块 pane: the list with its initialization state, plus add / update /
 * sync / remove.
 */

/** Render the submodule pane. */
function renderSubmodulePane(host) {
  const rows = model.children.submodules ?? []
  const bar = el('div', { class: 'dsh-og-filters' },
    button('添加子模块...', { kind: 'primary', icon: 'plus', onClick: () => openSubmoduleDialog() }),
    rows.length === 0 ? undefined : button('全部初始化并更新', {
      icon: 'download',
      onClick: () => void startOperation('/submodule/update', { recursive: true }),
    }),
    rows.length === 0 ? undefined : button('同步地址', {
      onClick: () => void act('/submodule/sync', {}, '已同步子模块地址'),
    }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadChildren() })))

  if (rows.length === 0) {
    fill(host, bar, emptyState('这个仓库没有子模块'))
    return
  }

  const columns = [
    {
      key: 'path',
      label: '路径',
      render: (row) => el('div', { class: 'dsh-og-msg-cell' },
        el('span', { class: 'dsh-og-file-icon' }, icon('submodule')),
        el('span', { class: 'dsh-og-msg-text', title: row.path }, row.path)),
    },
    { key: 'url', label: '地址', cellClass: 'dsh-og-cell-ellipsis dsh-og-cell-mono', render: (row) => el('span', { title: row.url }, row.url ?? '') },
    { key: 'branch', label: '分支', width: 110, render: (row) => row.branch ?? '' },
    { key: 'oid', label: '提交', width: 80, cellClass: 'dsh-og-cell-mono', render: (row) => row.shortOid ?? '' },
    {
      key: 'state',
      label: '状态',
      width: 110,
      render: (row) => {
        if (row.missing === true) return tag('目录缺失', 'danger')
        if (row.conflicted === true) return tag('冲突', 'danger')
        if (row.initialized !== true) return tag('未初始化', 'warning')
        if (row.modified === true) return tag('与记录不一致', 'warning')
        return tag('同步', 'success')
      },
    },
    {
      key: 'actions',
      label: '操作',
      width: 120,
      render: (row) => el('div', { style: { display: 'flex', gap: '4px' } },
        row.initialized === true ? undefined : iconButton('download', {
          title: '初始化并更新',
          onClick: () => void startOperation('/submodule/update', { path: row.path, recursive: true }),
        }),
        iconButton('more', {
          title: '更多',
          onClick: (event) => menuUnder(event.currentTarget, submoduleMenu(row)),
        })),
    },
  ]
  fill(host, bar, el('div', { class: 'dsh-og-table-scroll' }, table(columns, rows, {})))
}

/** A submodule row's menu. */
function submoduleMenu(row) {
  return [
    { head: row.path },
    { label: '初始化并更新', icon: 'download', onClick: () => void startOperation('/submodule/update', { path: row.path, recursive: true }) },
    { label: '更新到远端最新 (--remote)', onClick: () => void startOperation('/submodule/update', { path: row.path, remote: true, recursive: true }) },
    { label: '同步地址', onClick: () => void act('/submodule/sync', { path: row.path }, '已同步地址') },
    'sep',
    { label: '复制路径', icon: 'copy', onClick: () => copyText(row.path, '已复制路径') },
    row.url === undefined ? undefined : { label: '复制地址', icon: 'copy', onClick: () => copyText(row.url, '已复制地址') },
    'sep',
    { label: '移除子模块', icon: 'trash', tone: 'danger', onClick: () => void removeSubmoduleRow(row) },
  ]
}

/** Remove a submodule (deinit, drop from the index, delete the module copy). */
async function removeSubmoduleRow(row) {
  const confirmed = await confirmBox({
    title: '确认删除子模块',
    message: '确定要删除子模块 "' + row.path + '" 吗？\n这会从父仓库中移除它，并删除工作区里的目录。',
    confirmText: '删除',
    tone: 'danger',
    alert: { tone: 'error', title: '子模块目录里未提交的改动会一起消失' },
  })
  if (!confirmed) return
  await act('/submodule/remove', { path: row.path }, '已删除子模块 ' + row.path)
  await loadChildren()
}

/** Add a submodule. */
function openSubmoduleDialog() {
  const state = { url: '', path: '', branch: '' }
  openDialog({
    title: '添加子模块',
    build: () => [
      field('父仓库', input({ value: currentRepo()?.root ?? '', readonly: true })),
      field('子模块地址', input({
        placeholder: 'https://github.com/org/repo.git',
        onInput: (event) => {
          state.url = event.target.value
        },
      })),
      field('子模块路径', input({
        placeholder: '例如 vendor/my-lib',
        onInput: (event) => {
          state.path = event.target.value
        },
      }), '相对父仓库的路径，不能是绝对路径。'),
      field('分支（可选）', input({
        placeholder: '留空则使用远端默认分支',
        onInput: (event) => {
          state.branch = event.target.value
        },
      })),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('创建', {
        kind: 'primary',
        onClick: async () => {
          if (state.url.trim().length === 0 || state.path.trim().length === 0) {
            toast('请填写子模块地址和路径', 'warning')
            return
          }
          handle.close()
          await startOperation('/submodule/add', {
            url: state.url.trim(),
            path: state.path.trim(),
            branch: state.branch.trim().length === 0 ? undefined : state.branch.trim(),
          })
          await loadChildren()
        },
      }),
    ],
  })
}
