/**
 * The 历史 pane: the filter strip, the commit table with its graph column, and
 * the selected commit's detail + changed files + diff.
 *
 * Columns and their headings are the reference's (graph, 哈希, 消息, 作者, 日期),
 * as is the infinite scroll that loads the next page when the list nears its
 * bottom and the "已加载全部提交记录" footer.
 */

/** Render the history pane into `host`. */
function renderHistoryPane(host) {
  if (model.workspaceId.length === 0) {
    fill(host, emptyState('先在左边选一个仓库'))
    return
  }
  const upper = el('div', { class: 'dsh-og-history' })
  renderHistoryList(upper)

  const lower = el('div', { class: 'dsh-og-split-row' })
  renderCommitDetail(lower)

  const handle = resizeHandle({
    axis: 'y',
    min: 140,
    max: () => Math.max(180, host.clientHeight - 200),
    value: () => upper.getBoundingClientRect().height,
    onMove: (value) => {
      upper.style.flex = '0 0 ' + value + 'px'
    },
    onCommit: (value) => void savePrefs({ diffHeight: Math.round(value) }),
    onReset: () => {
      upper.style.flex = '1 1 auto'
      void savePrefs({ diffHeight: 0 })
    },
  })
  if (model.activeCommit !== null) {
    const saved = pref('diffHeight')
    upper.style.flex = saved > 0 ? '0 0 ' + saved + 'px' : '0 0 45%'
  }

  fill(host, el('div', { class: 'dsh-og-split' },
    historyFilters(),
    upper,
    model.activeCommit === null ? undefined : handle,
    model.activeCommit === null ? undefined : lower))
}

/** The filter strip. */
function historyFilters() {
  const wrap = el('div', { class: 'dsh-og-filters' })
  const branchOptions = [
    { id: 'current', label: '当前分支' },
    { id: 'all', label: '所有分支' },
    ...model.branches.map((row) => ({ id: row.name, label: row.name })),
  ]
  wrap.append(select({
    value: model.historyBranch,
    width: 160,
    title: '选择分支',
    options: branchOptions,
    onChange: (value) => {
      model.historyBranch = value
      void loadHistory(false)
    },
  }))
  const filterInput = (key, placeholder, width) => input({
    value: model.historyFilters[key],
    placeholder,
    width,
    onInput: debounce((event) => {
      model.historyFilters[key] = event.target.value
      void loadHistory(false)
    }, 320),
  })
  wrap.append(filterInput('message', '按提交信息筛选', 150))
  wrap.append(filterInput('author', '按作者筛选', 110))
  wrap.append(filterInput('hash', '按哈希筛选', 120))
  wrap.append(input({
    type: 'date',
    value: model.historyFilters.dateFrom,
    title: '开始日期',
    width: 132,
    onChange: (event) => {
      model.historyFilters.dateFrom = event.target.value
      void loadHistory(false)
    },
  }))
  wrap.append(input({
    type: 'date',
    value: model.historyFilters.dateTo,
    title: '结束日期',
    width: 132,
    onChange: (event) => {
      model.historyFilters.dateTo = event.target.value
      void loadHistory(false)
    },
  }))
  wrap.append(button('清空', {
    size: 'mini',
    onClick: () => {
      model.historyFilters = { message: '', author: '', hash: '', dateFrom: '', dateTo: '' }
      model.historyBranch = 'current'
      void loadHistory(false)
    },
  }))
  wrap.append(select({
    value: String(pref('historyPageSize') ?? 100),
    width: 92,
    title: '每页条数',
    options: PAGE_SIZES.map((n) => ({ id: String(n), label: n + ' 条' })),
    onChange: (value) => {
      void savePrefs({ historyPageSize: Number.parseInt(value, 10) })
      void loadHistory(false)
    },
  }))
  return wrap
}

/** The commit table plus the load-more footer. */
function renderHistoryList(host) {
  const state = model.history
  if (state.error !== null) {
    fill(host, alertBox('error', '读取提交历史失败', state.error))
    return
  }
  if (state.rows.length === 0) {
    fill(host, state.loading
      ? el('div', { class: 'dsh-og-loading' }, '正在读取提交历史...')
      : emptyState('没有符合条件的提交'))
    return
  }

  const graph = computeGraph(state.rows)
  const width = graphWidth(graph.length === 0 ? 1 : graph[0].laneCount)
  const columns = [
    {
      key: 'graph',
      label: '',
      width: width + 8,
      cellClass: 'dsh-og-graph-cell',
      render: (row) => graphCell(graph[state.rows.indexOf(row)], 22),
    },
    {
      key: 'shortHash',
      label: '哈希',
      width: 82,
      cellClass: 'dsh-og-cell-mono',
      render: (row) => row.shortHash,
    },
    { key: 'subject', label: '消息', render: (row) => messageCell(row) },
    { key: 'author', label: '作者', width: 96, cellClass: 'dsh-og-cell-ellipsis' },
    { key: 'date', label: '日期', width: 124, cellClass: 'dsh-og-num' },
  ]

  const node = table(columns, state.rows, {
    onRowClick: (row) => void loadCommit(row.hash),
    isActive: (row) => row.hash === model.activeCommit,
    onRowMenu: (row, event) => showMenu(event.clientX, event.clientY, commitMenu(row)),
  })

  const scroll = el('div', { class: 'dsh-og-history-scroll' }, node)
  if (state.hasMore) {
    scroll.append(el('div', {
      class: 'dsh-og-history-more',
      onClick: () => void loadHistory(true),
    }, state.loading ? '正在加载...' : '点击加载更多...'))
  } else {
    scroll.append(el('div', { class: 'dsh-og-history-more', 'data-done': 'true' }, '已加载全部提交记录'))
  }
  // Infinite scroll: within 120px of the bottom, pull the next page.
  scroll.addEventListener('scroll', () => {
    if (!model.history.hasMore || model.history.loading) return
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 120) void loadHistory(true)
  }, { passive: true })
  fill(host, scroll)
}

/** The message cell: ref chips, then the subject. */
function messageCell(row) {
  const cell = el('div', { class: 'dsh-og-msg-cell' })
  const chips = refChipsFor(row)
  if (chips !== undefined) cell.append(chips)
  cell.append(el('span', { class: 'dsh-og-msg-text', title: row.message }, row.subject))
  return cell
}

/**
 * The branch/tag chips on one row.
 *
 * Built from the tip maps rather than from git's `%D` decoration, so HEAD, local
 * branches, remote branches and tags can be told apart and capped separately —
 * which is how the reference caps at three chips plus a "+N" dropdown.
 */
function refChipsFor(row) {
  const local = []
  const remote = []
  const tags = []
  for (const [name, oid] of Object.entries(model.tips.branches ?? {})) {
    if (oid !== row.hash) continue
    if (name.includes('/')) remote.push(name)
    else local.push(name)
  }
  for (const [name, oid] of Object.entries(model.tips.tags ?? {})) {
    if (oid === row.hash) tags.push(name)
  }
  const head = model.status !== null && model.status.oid === row.hash && model.status.branch !== undefined
    ? model.status.branch
    : undefined

  const all = []
  if (head !== undefined) all.push({ name: 'HEAD → ' + head, tone: 'head' })
  for (const name of local.filter((entry) => entry !== head)) all.push({ name, tone: 'local' })
  for (const name of tags) all.push({ name, tone: 'tag' })
  for (const name of remote) all.push({ name, tone: 'remote' })
  if (all.length === 0) return undefined

  const wrap = el('div', { class: 'dsh-og-chips' })
  for (const entry of all.slice(0, BRANCH_CHIP_LIMIT)) {
    wrap.append(el('span', { class: 'dsh-og-chip', 'data-tone': entry.tone, title: entry.name }, entry.name))
  }
  const hidden = all.slice(BRANCH_CHIP_LIMIT)
  if (hidden.length > 0) {
    wrap.append(el('span', {
      class: 'dsh-og-chip',
      'data-tone': 'remote',
      'data-more': 'true',
      title: hidden.map((entry) => entry.name).join('\n'),
      onClick: (event) => {
        event.stopPropagation()
        showMenu(event.clientX, event.clientY, [
          { head: '还有 ' + hidden.length + ' 个引用' },
          ...hidden.map((entry) => ({ label: entry.name })),
        ])
      },
    }, '+' + hidden.length))
  }
  return wrap
}

/** The commit row's context menu — the reference's five items, plus a few. */
function commitMenu(row) {
  const rev = row.hash
  return [
    { head: row.shortHash + ' ' + row.subject.slice(0, 40) },
    { label: '合并到当前分支...', icon: 'merge', onClick: () => openMergeDialog(rev) },
    { label: '变基到这个提交...', icon: 'branch', onClick: () => openRebaseDialog(rev) },
    { label: '创建标签...', icon: 'tag', onClick: () => openTagDialog(rev) },
    { label: '创建分支...', icon: 'branch', onClick: () => openBranchDialog(rev) },
    'sep',
    { label: '挑选到当前分支 (cherry-pick)', onClick: () => void pickOrRevert('cherry-pick', row) },
    { label: '回滚这个提交 (revert)', onClick: () => void pickOrRevert('revert', row) },
    'sep',
    { label: '复制完整哈希', icon: 'copy', onClick: () => copyText(rev, '已复制提交哈希') },
    { label: '复制提交信息', icon: 'copy', onClick: () => copyText(row.message, '已复制提交信息') },
    'sep',
    { label: '重置到这个提交...', icon: 'undo', tone: 'danger', onClick: () => openResetDialog(rev) },
  ]
}

/** Cherry-pick or revert one commit, warning when it is a merge. */
async function pickOrRevert(kind, row) {
  const isMerge = row.parents.length > 1
  const confirmed = await confirmBox({
    title: kind === 'revert' ? '回滚提交' : '挑选提交',
    message: (kind === 'revert' ? '要回滚 ' : '要挑选 ') + row.shortHash + '（' + row.subject + '）吗？' +
      (isMerge ? '\n这是一个合并提交，将以第一父提交为主线。' : ''),
    confirmText: kind === 'revert' ? '回滚' : '挑选',
    tone: 'warning',
  })
  if (!confirmed) return
  const result = await act(
    kind === 'revert' ? '/revert' : '/cherry-pick',
    { revs: [row.hash], mainline: isMerge ? 1 : undefined },
    kind === 'revert' ? '已回滚' : '已挑选',
  )
  if (result !== undefined) await loadHistory(false)
}

/** The selected commit's detail card, file list and diff. */
function renderCommitDetail(host) {
  if (model.activeCommit === null) {
    fill(host, undefined)
    return
  }
  const listWidth = 320
  const list = el('div', { class: 'dsh-og-filelist', style: { width: listWidth + 'px' } })
  const scroll = el('div', { class: 'dsh-og-filelist-scroll' })
  for (const file of model.commitFiles) {
    scroll.append(commitFileRow(file))
  }
  if (model.commitFiles.length === 0) {
    scroll.append(el('div', { class: 'dsh-og-loading' }, '此提交没有文件变更'))
  }
  list.append(scroll, commitDetailCard())

  const diff = el('div', { class: 'dsh-og-diff' })
  renderDiffPanel(diff)

  const handle = resizeHandle({
    axis: 'x',
    min: 220,
    max: () => Math.max(260, host.clientWidth - 280),
    value: () => list.getBoundingClientRect().width,
    onMove: (value) => {
      list.style.width = value + 'px'
    },
  })
  fill(host, list, handle, diff)
}

/** One changed-file row inside a commit. */
function commitFileRow(file) {
  return el('div', {
    class: 'dsh-og-file',
    'data-active': file.path === model.commitFileActive ? 'true' : undefined,
    title: file.origPath === undefined ? file.path : file.origPath + ' → ' + file.path,
    onClick: () => {
      model.commitFileActive = file.path
      emit()
      void loadDiff({ kind: 'commit', rev: model.activeCommit }, file.path, file.origPath)
    },
  },
  el('span', { class: 'dsh-og-file-icon' }, fileIcon(file.path)),
  el('span', { class: 'dsh-og-file-name' }, file.path),
  file.binary === true
    ? tag('二进制', 'info')
    : el('span', { class: 'dsh-og-file-stat' },
      el('span', { class: 'dsh-og-adds' }, '+' + file.additions),
      el('span', { class: 'dsh-og-dels' }, '-' + file.deletions)),
  el('span', {
    class: 'dsh-og-file-mark',
    'data-letter': file.status,
    title: STATUS_TEXT[file.status] ?? file.status,
  }, STATUS_MARK[file.status] ?? file.status))
}

/** The commit's own metadata card. */
function commitDetailCard() {
  const detail = model.commitDetail
  if (detail === null) return el('div', { class: 'dsh-og-loading' }, '正在读取提交详情...')
  // The body is what follows the first blank line. Keyed off the blank line, not
  // off "the subject differs from the message" — a one-line subject containing a
  // tab differs from its own trimmed self, and slicing on that produced a body of
  // one stray character.
  const gap = detail.message.search(/\n\s*\n/)
  const body = gap === -1 ? '' : detail.message.slice(gap).trim()

  const card = el('div', { class: 'dsh-og-detail' },
    el('div', { class: 'dsh-og-detail-subject' }, detail.subject.length === 0 ? '(无提交信息)' : detail.subject))
  if (body.length > 0) card.append(el('div', { class: 'dsh-og-detail-body' }, body))

  const line = (label, value) => el('div', { class: 'dsh-og-detail-line' },
    el('span', { class: 'dsh-og-detail-label' }, label),
    el('span', { class: 'dsh-og-detail-value' }, value))
  card.append(line('作者', detail.author + (detail.authorEmail === undefined ? '' : ' <' + detail.authorEmail + '>')))
  if (detail.committer !== detail.author) {
    card.append(line('提交者', detail.committer + ' <' + detail.committerEmail + '>'))
  }
  card.append(line('时间', detail.date))
  card.append(el('div', { class: 'dsh-og-detail-line' },
    el('span', { class: 'dsh-og-detail-label' }, '哈希'),
    el('span', { class: 'dsh-og-detail-value dsh-og-cell-mono' }, detail.hash)))

  const parents = el('div', { class: 'dsh-og-parents' })
  if (detail.parents.length === 0) parents.append(el('span', { style: { color: 'var(--og-text-3)' } }, '无（根提交）'))
  for (const parent of detail.parents) {
    parents.append(button(shortOid(parent, 10), {
      kind: 'link',
      size: 'mini',
      title: parent,
      onClick: () => void loadCommit(parent),
    }))
  }
  card.append(el('div', { class: 'dsh-og-detail-line' },
    el('span', { class: 'dsh-og-detail-label' }, '父级'),
    parents))
  return card
}

/** The file-history drawer: one file's commits, with each one's diff. */
function openFileHistory(path) {
  const state = { rows: [], loading: true, active: null, diff: null }
  const handle = openDrawer({
    title: path + ' 的修改历史',
    build: () => {
      if (state.loading) return el('div', { class: 'dsh-og-loading' }, '正在读取...')
      if (state.rows.length === 0) return emptyState('这个文件没有提交记录')
      const list = el('div', { style: { width: '38%', 'border-right': '1px solid var(--og-border)', overflow: 'auto' } })
      for (const row of state.rows) {
        list.append(el('div', {
          class: 'dsh-og-row',
          'data-current': row.hash === state.active ? 'true' : undefined,
          onClick: () => {
            state.active = row.hash
            handle.render()
            void (async () => {
              try {
                state.diff = await apiGet('/diff/file', {
                  workspaceId: model.workspaceId,
                  kind: 'commit',
                  rev: row.hash,
                  path,
                })
              } catch (error) {
                state.diff = { error: friendlyError(error), lines: [] }
              }
              handle.render()
            })()
          },
        },
        el('div', { style: { flex: '1', 'min-width': '0' } },
          el('div', { class: 'dsh-og-row-name' }, row.subject),
          el('div', { class: 'dsh-og-repo-meta' },
            el('span', {}, row.author),
            el('span', {}, row.date),
            el('span', { class: 'dsh-og-cell-mono' }, row.shortHash)))))
      }
      const right = el('div', { class: 'dsh-og-diff', style: { flex: '1', 'min-width': '0' } })
      const saved = model.diff
      const savedSource = model.diffSource
      model.diff = state.diff
      model.diffSource = state.active === null ? null : { kind: 'commit', rev: state.active, path }
      renderDiffPanel(right)
      model.diff = saved
      model.diffSource = savedSource
      return el('div', { style: { display: 'flex', height: '100%', 'min-height': '0' } }, list, right)
    },
  })
  void (async () => {
    try {
      state.rows = await apiGet('/file/history', { workspaceId: model.workspaceId, path, limit: 200 })
    } catch (error) {
      toastError(error)
    }
    state.loading = false
    handle.render()
  })()
}
