/**
 * The 远端 pane: the remote list with add / edit / rename / remove, plus fetch and
 * prune. The reference could only add, change a URL and delete; rename, prune and
 * a per-remote fetch are here because a remote pane without them sends you to a
 * terminal for routine work.
 */

/** Render the remote pane. */
function renderRemotePane(host) {
  const bar = el('div', { class: 'dsh-og-filters' },
    button('添加远端...', { kind: 'primary', icon: 'plus', onClick: () => openRemoteDialog() }),
    button('抓取所有远端', { icon: 'download', onClick: () => void startOperation('/fetch', { all: true, prune: true }) }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadRemotes() })))

  if (model.remotes.length === 0) {
    fill(host, bar, emptyState('还没有配置远端', '推送之前需要先添加一个远端仓库'))
    return
  }

  const columns = [
    { key: 'name', label: '名称', width: 140 },
    { key: 'url', label: '地址', cellClass: 'dsh-og-cell-ellipsis dsh-og-cell-mono', render: (row) => el('span', { title: row.url }, row.url) },
    { key: 'push', label: '推送地址', cellClass: 'dsh-og-cell-ellipsis dsh-og-cell-mono', render: (row) => (row.pushUrl === row.fetchUrl ? el('span', { style: { color: 'var(--og-text-3)' } }, '同上') : el('span', { title: row.pushUrl }, row.pushUrl ?? '')) },
    {
      key: 'cred',
      label: '凭证',
      width: 120,
      render: (row) => {
        if (row.host === undefined) return ''
        const stored = (model.credentials.hosts ?? []).find((entry) => entry.host === row.host)
        const env = (model.credentials.env ?? []).find((entry) => entry.host === row.host || entry.host === '*')
        if (stored !== undefined) return tag('已保存', 'success', { title: stored.username })
        if (env !== undefined) return tag('环境变量', 'primary', { title: env.variable })
        return /^https?:/i.test(row.url ?? '') ? tag('未配置', 'info') : tag('SSH', 'info')
      },
    },
    {
      key: 'actions',
      label: '操作',
      width: 150,
      render: (row) => el('div', { style: { display: 'flex', gap: '4px' } },
        iconButton('download', { title: '抓取这个远端', onClick: () => void startOperation('/fetch', { remote: row.name, prune: true }) }),
        iconButton('settings', { title: '编辑', onClick: () => openRemoteDialog(row) }),
        iconButton('more', {
          title: '更多',
          onClick: (event) => menuUnder(event.currentTarget, remoteMenu(row)),
        })),
    },
  ]
  fill(host, bar, el('div', { class: 'dsh-og-table-scroll' }, table(columns, model.remotes, {})))
}

/** A remote row's menu. */
function remoteMenu(row) {
  return [
    { head: row.name },
    { label: '抓取', icon: 'download', onClick: () => void startOperation('/fetch', { remote: row.name, prune: true }) },
    { label: '清理失效引用 (prune)', onClick: () => void startOperation('/prune', { remote: row.name }) },
    'sep',
    { label: '编辑地址...', icon: 'settings', onClick: () => openRemoteDialog(row) },
    { label: '重命名...', onClick: () => void renameRemoteRow(row) },
    { label: '复制地址', icon: 'copy', onClick: () => copyText(row.url, '已复制远端地址') },
    row.host === undefined || !/^https?:/i.test(row.url ?? '')
      ? undefined
      : { label: '设置 HTTPS 凭证...', icon: 'lock', onClick: () => openCredentialDialog(row.host) },
    'sep',
    { label: '删除远端', icon: 'trash', tone: 'danger', onClick: () => void removeRemoteRow(row) },
  ]
}

/** Add or edit a remote. */
function openRemoteDialog(row) {
  const editing = row !== undefined
  const state = { name: row?.name ?? '', url: row?.url ?? '', pushUrl: row?.pushUrl ?? '', separate: false }
  if (editing && row.pushUrl !== row.fetchUrl) state.separate = true
  openDialog({
    title: editing ? '编辑远端仓库' : '添加远端仓库',
    build: (handle) => [
      field('名称', input({
        value: state.name,
        placeholder: '例如 origin',
        readonly: editing,
        onInput: (event) => {
          state.name = event.target.value
        },
      }), editing ? '名称不能在这里修改，请用"重命名"。' : undefined),
      field('地址', input({
        value: state.url,
        placeholder: 'https://github.com/user/repo.git 或 git@github.com:user/repo.git',
        onInput: (event) => {
          state.url = event.target.value
        },
      })),
      checkbox('推送地址与抓取地址不同', {
        checked: state.separate,
        onChange: (checked) => {
          state.separate = checked
          handle.render()
        },
      }),
      state.separate
        ? field('推送地址', input({
          value: state.pushUrl,
          onInput: (event) => {
            state.pushUrl = event.target.value
          },
        }))
        : undefined,
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'primary',
        onClick: async () => {
          if (state.name.trim().length === 0 || state.url.trim().length === 0) {
            toast('请填写远端名称和地址', 'warning')
            return
          }
          handle.close()
          if (editing) {
            await act('/remote/set-url', {
              name: state.name.trim(),
              url: state.url.trim(),
              which: state.separate ? 'fetch' : 'both',
            }, '已更新远端地址')
            if (state.separate && state.pushUrl.trim().length > 0) {
              await act('/remote/set-url', { name: state.name.trim(), url: state.pushUrl.trim(), which: 'push' }, undefined)
            }
          } else {
            await act('/remote/add', { name: state.name.trim(), url: state.url.trim() }, '已添加远端')
          }
          await loadRemotes()
        },
      }),
    ],
  })
}

/** Rename a remote. */
async function renameRemoteRow(row) {
  const name = await promptBox({
    title: '重命名远端',
    message: '把 "' + row.name + '" 改成：',
    value: row.name,
    emptyMessage: '远端名称不能为空',
  })
  if (name === undefined || name === row.name) return
  await act('/remote/rename', { from: row.name, to: name }, '已重命名为 ' + name)
  await Promise.all([loadRemotes(), loadBranches()])
}

/** Remove a remote. */
async function removeRemoteRow(row) {
  const confirmed = await confirmBox({
    title: '确认删除',
    message: '确定要删除远端 "' + row.name + '" 吗？本地的 ' + row.name + '/* 跟踪分支会一起消失。',
    confirmText: '删除',
    tone: 'danger',
  })
  if (!confirmed) return
  await act('/remote/remove', { name: row.name }, '已删除远端 ' + row.name)
  await Promise.all([loadRemotes(), loadBranches()])
}

/** The HTTPS credential dialog, reached from a remote row or from a push failure. */
function openCredentialDialog(host, options) {
  const opts = options ?? {}
  const state = { username: opts.username ?? '', password: '' }
  const stored = (model.credentials.hosts ?? []).find((entry) => entry.host === host)
  if (stored !== undefined && state.username.length === 0) state.username = stored.username ?? ''
  openDialog({
    title: 'HTTPS 凭证',
    build: () => [
      opts.error === undefined ? undefined : alertBox('warning', '上一次操作失败', opts.error),
      /github\.com$/i.test(host ?? '')
        ? alertBox('info', '检测到 GitHub 远端', 'GitHub 已不接受账号密码，请在这里填 Personal Access Token。')
        : undefined,
      el('div', { style: { margin: '10px 0', 'font-size': '12px', color: 'var(--og-text-2)' } },
        '主机：', el('span', { class: 'dsh-og-cell-mono' }, host ?? '')),
      field('账号', input({
        value: state.username,
        placeholder: '例如：yourname',
        onInput: (event) => {
          state.username = event.target.value
        },
      })),
      field('密码或 Token', input({
        type: 'password',
        placeholder: 'GitHub / GitLab 推荐使用 Token',
        onInput: (event) => {
          state.password = event.target.value
        },
      }), '凭证以 0600 权限单独存在 DSH 家目录下，浏览器之后只会看到"这个主机有凭证"，看不到内容。'),
    ],
    footer: (handle) => [
      stored === undefined ? undefined : button('删除已存凭证', {
        kind: 'danger',
        onClick: async () => {
          handle.close()
          try {
            model.credentials = await apiPost('/credentials/delete', { host })
            toast('已删除 ' + host + ' 的凭证', 'success')
          } catch (error) {
            toastError(error)
          }
          emit()
        },
      }),
      button('取消', { onClick: () => handle.close() }),
      button(opts.retry === undefined ? '保存' : '保存并重试', {
        kind: 'primary',
        onClick: async () => {
          if (state.password.length === 0) {
            toast('请填写密码或 Token', 'warning')
            return
          }
          handle.close()
          try {
            model.credentials = await apiPost('/credentials', {
              host,
              username: state.username.trim(),
              password: state.password,
            })
            toast('已保存 ' + host + ' 的凭证', 'success')
            emit()
            if (opts.retry !== undefined) await opts.retry()
          } catch (error) {
            toastError(error)
          }
        },
      }),
    ],
  })
}
