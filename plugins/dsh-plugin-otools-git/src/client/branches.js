/**
 * The 分支 and 标签 panes, and the dialogs that mutate refs: create branch,
 * merge, rebase, reset, create tag.
 *
 * The branch list is grouped by prefix the way the reference's tag cloud was
 * (`feature/*` under "feature", remotes under their remote), but rendered as rows
 * with an ahead/behind readout and hover actions instead of as bare tags —
 * checkout by double-click was the reference's only affordance and it hid
 * everything else behind nothing.
 */

/** Render the branch pane. */
function renderBranchPane(host) {
  if (model.branches.length === 0) {
    fill(host, emptyState('暂无分支'))
    return
  }
  const bar = el('div', { class: 'dsh-og-filters' },
    button('新建分支...', { kind: 'primary', icon: 'plus', onClick: () => openBranchDialog() }),
    button('合并...', { icon: 'merge', onClick: () => openMergeDialog() }),
    checkbox('显示远程分支', {
      checked: pref('historyIncludeRemote') !== false,
      onChange: (checked) => {
        void savePrefs({ historyIncludeRemote: checked })
        void loadBranches()
      },
    }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadBranches() })))

  const list = el('div', { class: 'dsh-og-list' })
  const locals = model.branches.filter((row) => row.remote !== true)
  const remotes = model.branches.filter((row) => row.remote === true)
  for (const [title, rows] of groupByPrefix(locals, '本地分支')) {
    list.append(groupBlock(title, rows.map((row) => branchRow(row))))
  }
  if (pref('historyIncludeRemote') !== false && remotes.length > 0) {
    for (const [title, rows] of groupByPrefix(remotes, '远程分支')) {
      list.append(groupBlock(title, rows.map((row) => branchRow(row))))
    }
  }
  fill(host, bar, list)
}

/** Group rows by their first path segment, keeping un-prefixed ones together. */
function groupByPrefix(rows, plainTitle) {
  const groups = new Map()
  for (const row of rows) {
    const parts = row.name.split('/')
    const key = parts.length > 1 ? parts[0] : plainTitle
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  // The un-prefixed group first: it holds `main`, which is what people look for.
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === plainTitle) return -1
    if (b[0] === plainTitle) return 1
    return a[0].localeCompare(b[0])
  })
}

/** One titled group. */
function groupBlock(title, rows) {
  return el('div', { class: 'dsh-og-group' },
    el('h5', { class: 'dsh-og-group-title' }, title, el('span', { class: 'dsh-og-section-count' }, '(' + rows.length + ')')),
    rows)
}

/** One branch row. */
function branchRow(row) {
  const node = el('div', {
    class: 'dsh-og-row',
    'data-current': row.current === true ? 'true' : undefined,
    title: row.subject === undefined ? row.name : row.name + ' — ' + row.subject,
    onDblclick: () => void checkoutBranch(row),
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      showMenu(event.clientX, event.clientY, branchMenu(row))
    },
  })
  const glyph = icon('branch')
  glyph.style.color = row.current === true ? 'var(--og-success)' : 'var(--og-text-3)'
  node.append(el('span', { class: 'dsh-og-file-icon' }, glyph))
  node.append(el('span', { class: 'dsh-og-row-name' }, row.name))
  if (row.current === true) node.append(tag('当前', 'success'))
  if (row.worktreePath !== undefined && row.current !== true) {
    node.append(tag('已在其它工作树检出', 'info', { title: row.worktreePath }))
  }
  if (row.upstreamGone === true) node.append(tag('上游已删除', 'danger'))
  const track = trackText(row.ahead ?? 0, row.behind ?? 0)
  if (track.length > 0) node.append(el('span', { class: 'dsh-og-row-sub', title: '领先 / 落后于 ' + row.upstream }, track))
  if (row.date !== undefined) node.append(el('span', { class: 'dsh-og-row-sub' }, row.date))

  const actions = el('div', { class: 'dsh-og-row-actions' })
  if (row.current !== true) {
    actions.append(iconButton('check', { title: '检出', onClick: (event) => {
      event.stopPropagation()
      void checkoutBranch(row)
    } }))
  }
  actions.append(iconButton('more', { title: '更多', onClick: (event) => {
    event.stopPropagation()
    menuUnder(event.currentTarget, branchMenu(row))
  } }))
  node.append(actions)
  return node
}

/** A branch row's menu. */
function branchMenu(row) {
  const items = [{ head: row.name }]
  if (row.current !== true) {
    items.push({ label: row.remote === true ? '检出为本地分支' : '检出', icon: 'check', onClick: () => void checkoutBranch(row) })
  }
  items.push({ label: '基于它新建分支...', icon: 'plus', onClick: () => openBranchDialog(row.name) })
  if (row.current !== true) {
    items.push({ label: '合并到当前分支...', icon: 'merge', onClick: () => openMergeDialog(row.name) })
    items.push({ label: '变基到它...', icon: 'branch', onClick: () => openRebaseDialog(row.name) })
  }
  items.push({ label: '在这里创建标签...', icon: 'tag', onClick: () => openTagDialog(row.name) })
  items.push('sep')
  items.push({ label: '查看它的历史', icon: 'clock', onClick: () => {
    model.historyBranch = row.name
    model.tab = 'history'
    emit()
    void loadHistory(false)
  } })
  items.push({ label: '复制分支名', icon: 'copy', onClick: () => copyText(row.name, '已复制分支名') })
  if (row.remote !== true) {
    items.push('sep')
    items.push({ label: '设置上游...', onClick: () => openUpstreamDialog(row) })
    items.push({ label: '重命名...', onClick: () => void renameBranchRow(row) })
    items.push({
      label: '删除',
      icon: 'trash',
      tone: 'danger',
      disabled: row.current === true,
      onClick: () => void deleteBranchRow(row),
    })
  } else {
    items.push('sep')
    items.push({
      label: '删除远端分支...',
      icon: 'trash',
      tone: 'danger',
      onClick: () => void deleteRemoteBranchRow(row),
    })
  }
  return items
}

/** Check out a branch, warning first when local changes are in the way. */
async function checkoutBranch(row) {
  // A remote branch is checked out as a local one tracking it, which is what
  // every git GUI does and what `git switch <name>` does implicitly.
  const localName = row.remote === true ? row.name.split('/').slice(1).join('/') : row.name
  const exists = model.branches.some((entry) => entry.remote !== true && entry.name === localName)
  // The body is built once, so the force path cannot forget `newBranch` and
  // silently detach HEAD while the toast claims a branch switch.
  const body = row.remote === true && !exists
    ? { name: row.name, newBranch: localName }
    : { name: localName }
  try {
    const validation = await withBusy(() => apiPost('/branch/validate-checkout', {
      workspaceId: model.workspaceId,
      name: row.name,
    }))
    if (validation.canCheckout !== true) {
      const proceed = await confirmBox({
        title: '无法直接切换分支',
        message: validation.reason ?? '存在冲突，请先处理本地改动。',
        confirmText: '仍然切换（丢弃冲突改动）',
        tone: 'danger',
        alert: { tone: 'error', title: '强制切换会丢弃这些文件的本地改动' },
      })
      if (!proceed) return
      await act('/branch/checkout', { ...body, force: true }, '已切换到 ' + localName)
      await Promise.all([loadBranches(), loadRepos()])
      return
    }
  } catch (error) {
    toastError(error)
    return
  }
  await act('/branch/checkout', body, '已切换到 ' + localName)
  await Promise.all([loadBranches(), loadRepos()])
}

/** Rename a local branch. */
async function renameBranchRow(row) {
  const name = await promptBox({
    title: '重命名分支',
    message: '把 "' + row.name + '" 改成：',
    value: row.name,
    emptyMessage: '分支名不能为空',
  })
  if (name === undefined || name === row.name) return
  await act('/branch/rename', { from: row.name, to: name }, '已重命名为 ' + name)
  await loadBranches()
}

/** Delete a local branch, offering `-D` when it is not merged. */
async function deleteBranchRow(row) {
  const unmerged = (row.ahead ?? 0) > 0
  const confirmed = await confirmBox({
    title: '删除分支',
    message: '确定要删除本地分支 "' + row.name + '" 吗？',
    confirmText: '删除',
    tone: 'danger',
    alert: unmerged
      ? { tone: 'warning', title: '这个分支有 ' + row.ahead + ' 个未合并的提交', description: '删除后这些提交将只能靠 reflog 找回。' }
      : undefined,
  })
  if (!confirmed) return
  try {
    await withBusy(() => apiPost('/branch/delete', {
      workspaceId: model.workspaceId,
      names: [row.name],
      force: false,
    }))
    toast('已删除 ' + row.name, 'success', 1800)
  } catch (error) {
    // git refuses an unmerged branch without -D; offer exactly that rather than
    // forcing by default.
    if (/not fully merged/i.test(messageOf(error))) {
      const force = await confirmBox({
        title: '分支未完全合并',
        message: '"' + row.name + '" 还没有合并到任何地方，强制删除会丢掉它独有的提交。',
        confirmText: '强制删除',
        tone: 'danger',
      })
      if (!force) return
      await act('/branch/delete', { names: [row.name], force: true }, '已强制删除 ' + row.name)
    } else {
      toastError(error)
    }
  }
  await Promise.all([loadBranches(), loadRepos()])
}

/** Delete a branch on its remote. */
async function deleteRemoteBranchRow(row) {
  const parts = row.name.split('/')
  const remote = parts[0]
  const branch = parts.slice(1).join('/')
  const confirmed = await confirmBox({
    title: '删除远端分支',
    message: '确定要删除 ' + remote + ' 上的 "' + branch + '" 吗？',
    confirmText: '删除',
    tone: 'danger',
    alert: { tone: 'error', title: '这会影响所有人', description: '远端分支删除后，其他协作者下次 fetch 就会看到它消失。' },
  })
  if (!confirmed) return
  await startOperation('/branch/delete-remote', { remote, branch })
}

/** Set or clear a branch's upstream. */
function openUpstreamDialog(row) {
  const state = { upstream: row.upstream ?? '' }
  const candidates = model.branches.filter((entry) => entry.remote === true).map((entry) => entry.name)
  openDialog({
    title: '设置上游分支',
    build: () => [
      field('本地分支', input({ value: row.name, readonly: true })),
      field('上游', select({
        value: state.upstream,
        options: [{ id: '', label: '（不跟踪任何上游）' }, ...candidates.map((name) => ({ id: name, label: name }))],
        onChange: (value) => {
          state.upstream = value
        },
      }), '上游决定推送和拉取的默认目标，也决定工具栏上领先/落后的计数。'),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('保存', {
        kind: 'primary',
        onClick: async () => {
          handle.close()
          await act('/branch/upstream', {
            branch: row.name,
            upstream: state.upstream.length === 0 ? null : state.upstream,
          }, '已更新上游')
          await loadBranches()
        },
      }),
    ],
  })
}

/** Create a branch. `startPoint` pre-fills the source. */
function openBranchDialog(startPoint) {
  const state = { name: '', startPoint: startPoint ?? 'HEAD', checkout: true }
  const sources = [
    { id: 'HEAD', label: 'HEAD（当前位置）' },
    ...model.branches.map((row) => ({ id: row.name, label: row.name })),
    ...model.tags.map((row) => ({ id: row.name, label: '标签 ' + row.name })),
  ]
  if (startPoint !== undefined && !sources.some((row) => row.id === startPoint)) {
    sources.unshift({ id: startPoint, label: startPoint })
  }
  openDialog({
    title: '创建新分支',
    build: () => [
      field('新分支名称', input({
        placeholder: '例如 feature/login',
        onInput: (event) => {
          state.name = event.target.value
        },
      }), '不能包含空格，也不能以 - 开头。'),
      field('来源', select({
        value: state.startPoint,
        options: sources,
        onChange: (value) => {
          state.startPoint = value
        },
      })),
      checkbox('创建后立即切换到新分支', {
        checked: state.checkout,
        onChange: (checked) => {
          state.checkout = checked
        },
      }),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'primary',
        onClick: async () => {
          if (state.name.trim().length === 0) {
            toast('请输入新分支名称', 'warning')
            return
          }
          handle.close()
          await act('/branch/create', {
            name: state.name.trim(),
            startPoint: state.startPoint,
            checkout: state.checkout,
          }, '已创建分支 ' + state.name.trim())
          await Promise.all([loadBranches(), loadRepos()])
        },
      }),
    ],
  })
}

/** Merge a ref into HEAD. */
function openMergeDialog(ref) {
  const state = { ref: ref ?? '', mode: 'default', noCommit: false }
  openDialog({
    title: '合并',
    build: () => [
      field('合并来源', ref === undefined
        ? select({
          value: state.ref,
          options: [
            { id: '', label: '请选择要合并的分支' },
            ...model.branches.filter((row) => row.current !== true).map((row) => ({ id: row.name, label: row.name })),
          ],
          onChange: (value) => {
            state.ref = value
          },
        })
        : input({ value: ref, readonly: true })),
      field('合并方式', select({
        value: state.mode,
        options: MERGE_MODES,
        onChange: (value) => {
          state.mode = value
        },
      })),
      checkbox('合并后先不提交（--no-commit）', {
        checked: state.noCommit,
        onChange: (checked) => {
          state.noCommit = checked
        },
      }),
      el('div', { style: { 'margin-top': '10px' } },
        alertBox('info', '合并到 ' + (model.status?.branch ?? 'HEAD'),
          '如果出现冲突，工作区会进入合并状态，可以在工作区里逐个解决后继续。')),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'primary',
        onClick: async () => {
          if (state.ref.trim().length === 0) {
            toast('请选择合并来源', 'warning')
            return
          }
          handle.close()
          await act('/merge', { ref: state.ref.trim(), mode: state.mode, noCommit: state.noCommit }, '已合并 ' + state.ref)
          await Promise.all([loadBranches(), loadHistory(false)])
        },
      }),
    ],
  })
}

/** Rebase HEAD onto a ref. */
function openRebaseDialog(ref) {
  const state = { ref: ref ?? '', autostash: true }
  openDialog({
    title: '变基',
    build: () => [
      el('div', { style: { 'margin-bottom': '12px', 'line-height': '1.7' } },
        '确定要把当前分支的提交重新应用到 ',
        el('code', { class: 'dsh-og-cell-mono' }, state.ref.length === 0 ? '（未选择）' : shortOid(state.ref, 12)),
        ' 上吗？请确认这些提交还没有推送给其他人。'),
      ref === undefined
        ? field('目标', select({
          value: state.ref,
          options: [
            { id: '', label: '请选择目标' },
            ...model.branches.filter((row) => row.current !== true).map((row) => ({ id: row.name, label: row.name })),
          ],
          onChange: (value) => {
            state.ref = value
          },
        }))
        : undefined,
      checkbox('自动贮藏未提交的改动（--autostash）', {
        checked: state.autostash,
        onChange: (checked) => {
          state.autostash = checked
        },
      }),
      el('div', { style: { 'margin-top': '10px' } },
        alertBox('warning', '变基会重写提交历史', '已经推送出去的提交被变基后，其他人再拉取会产生分叉。')),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'warning',
        onClick: async () => {
          if (state.ref.trim().length === 0) {
            toast('请选择变基目标', 'warning')
            return
          }
          handle.close()
          await act('/rebase', { ref: state.ref.trim(), autostash: state.autostash }, '已完成变基')
          await Promise.all([loadBranches(), loadHistory(false)])
        },
      }),
    ],
  })
}

/** Reset HEAD to a revision. */
function openResetDialog(ref) {
  const state = { mode: 'mixed' }
  const dialog = openDialog({
    title: '重置到指定提交',
    build: (handle) => {
      const chosen = RESET_MODES.find((row) => row.id === state.mode)
      return [
        field('目标提交', input({ value: shortOid(ref, 12), readonly: true })),
        field('重置模式', select({
          value: state.mode,
          options: RESET_MODES,
          onChange: (value) => {
            state.mode = value
            handle.render()
          },
        })),
        alertBox(chosen.tone, undefined, chosen.hint),
      ]
    },
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定重置', {
        kind: 'danger',
        onClick: async () => {
          if (state.mode === 'hard') {
            const confirmed = await confirmBox({
              title: '高风险操作确认',
              message: '你正在执行硬重置到 ' + shortOid(ref, 12) + '，这会丢弃本地未提交改动，确定继续吗？',
              confirmText: '继续硬重置',
              tone: 'danger',
            })
            if (!confirmed) return
          }
          handle.close()
          await act('/reset', { ref, mode: state.mode }, '已执行 ' + state.mode.toUpperCase() + ' 重置')
          await Promise.all([loadHistory(false), loadRepos()])
        },
      }),
    ],
  })
  return dialog
}

// ------------------------------------------------------------------- tags
/** Render the tag pane. */
function renderTagPane(host) {
  const bar = el('div', { class: 'dsh-og-filters' },
    button('新建标签...', { kind: 'primary', icon: 'plus', onClick: () => openTagDialog() }),
    el('div', { style: { 'margin-left': 'auto' } },
      button('刷新', { size: 'mini', icon: 'refresh', onClick: () => void loadTags() })))
  if (model.tags.length === 0) {
    fill(host, bar, emptyState('暂无标签'))
    return
  }
  const list = el('div', { class: 'dsh-og-list' })
  for (const row of model.tags) list.append(tagRow(row))
  fill(host, bar, list)
}

/** One tag row. */
function tagRow(row) {
  const node = el('div', {
    class: 'dsh-og-row',
    title: row.subject === undefined ? row.name : row.name + ' — ' + row.subject,
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      showMenu(event.clientX, event.clientY, tagMenu(row))
    },
  })
  const glyph = icon('tag')
  glyph.style.color = 'var(--og-warning)'
  node.append(el('span', { class: 'dsh-og-file-icon' }, glyph))
  node.append(el('span', { class: 'dsh-og-row-name' }, row.name))
  node.append(tag(row.annotated === true ? '附注' : '轻量', row.annotated === true ? 'primary' : 'info'))
  node.append(el('span', { class: 'dsh-og-row-sub dsh-og-cell-mono' }, row.shortTarget))
  if (row.date !== undefined) node.append(el('span', { class: 'dsh-og-row-sub' }, row.date))
  const actions = el('div', { class: 'dsh-og-row-actions' },
    iconButton('more', {
      title: '更多',
      onClick: (event) => {
        event.stopPropagation()
        menuUnder(event.currentTarget, tagMenu(row))
      },
    }))
  node.append(actions)
  return node
}

/** A tag row's menu. */
function tagMenu(row) {
  return [
    { head: row.name },
    { label: '检出（游离 HEAD）', icon: 'check', onClick: () => void act('/branch/checkout', { name: row.name, detach: true }, '已检出标签 ' + row.name) },
    { label: '基于它新建分支...', icon: 'plus', onClick: () => openBranchDialog(row.name) },
    { label: '查看它的提交', icon: 'clock', onClick: () => {
      model.tab = 'history'
      emit()
      void loadCommit(row.target)
    } },
    'sep',
    { label: '推送这个标签...', icon: 'upload', onClick: () => openPushDialog({ tagsOnly: true }) },
    { label: '复制标签名', icon: 'copy', onClick: () => copyText(row.name, '已复制标签名') },
    'sep',
    { label: '删除本地标签', icon: 'trash', tone: 'danger', onClick: () => void deleteTagRow(row, false) },
    { label: '同时删除远端标签...', icon: 'trash', tone: 'danger', onClick: () => void deleteTagRow(row, true) },
  ]
}

/** Delete a tag locally, and optionally on a remote. */
async function deleteTagRow(row, alsoRemote) {
  const confirmed = await confirmBox({
    title: '删除标签',
    message: alsoRemote
      ? '确定要删除标签 "' + row.name + '"，并从远端一并删除吗？'
      : '确定要删除本地标签 "' + row.name + '" 吗？',
    confirmText: '删除',
    tone: 'danger',
    alert: alsoRemote
      ? { tone: 'error', title: '远端删除会影响所有人' }
      : undefined,
  })
  if (!confirmed) return
  await act('/tag/delete', { names: [row.name] }, '已删除标签 ' + row.name)
  await loadTags()
  if (alsoRemote) {
    const remote = model.remotes.length > 0 ? model.remotes[0].name : 'origin'
    await startOperation('/tag/delete-remote', { remote, names: [row.name] })
  }
}

/** Create a tag. */
function openTagDialog(target) {
  const state = { name: '', target: target ?? 'HEAD', message: '', annotated: true, push: false, remote: '' }
  const targets = [
    { id: 'HEAD', label: 'HEAD（当前位置）' },
    ...model.branches.map((row) => ({ id: row.name, label: row.name })),
  ]
  if (target !== undefined && !targets.some((row) => row.id === target)) {
    targets.unshift({ id: target, label: shortOid(target, 12) })
  }
  openDialog({
    title: '创建标签',
    build: (handle) => [
      field('标签名称', input({
        placeholder: '例如 v1.0.0',
        onInput: (event) => {
          state.name = event.target.value
        },
      })),
      field('目标提交', select({
        value: state.target,
        options: targets,
        onChange: (value) => {
          state.target = value
        },
      })),
      checkbox('附注标签（带说明和作者信息）', {
        checked: state.annotated,
        onChange: (checked) => {
          state.annotated = checked
          handle.render()
        },
      }),
      state.annotated
        ? field('标签说明', textarea({
          rows: 3,
          placeholder: '这个版本做了什么',
          onInput: (event) => {
            state.message = event.target.value
          },
        }))
        : undefined,
      checkbox('创建后推送到远端', {
        checked: state.push,
        onChange: (checked) => {
          state.push = checked
          handle.render()
        },
      }),
      state.push
        ? field('远端', select({
          value: state.remote.length > 0 ? state.remote : (model.remotes[0]?.name ?? ''),
          options: model.remotes.map((row) => ({ id: row.name, label: row.name })),
          onChange: (value) => {
            state.remote = value
          },
        }))
        : undefined,
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('确定', {
        kind: 'primary',
        onClick: async () => {
          const name = state.name.trim()
          if (name.length === 0) {
            toast('请输入标签名称', 'warning')
            return
          }
          if (state.annotated && state.message.trim().length === 0) {
            toast('附注标签需要填写说明', 'warning')
            return
          }
          handle.close()
          await act('/tag/create', {
            name,
            target: state.target,
            message: state.annotated ? state.message.trim() : undefined,
          }, '已创建标签 ' + name)
          await loadTags()
          if (state.push) {
            const remote = state.remote.length > 0 ? state.remote : (model.remotes[0]?.name ?? 'origin')
            await startOperation('/push', { remote, tags: true })
          }
        },
      }),
    ],
  })
}
