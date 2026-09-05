/**
 * The diff view: the toolbar, the two-column line-number gutter, the classified
 * lines, and the before/after cards for an image.
 *
 * The lines arrive already classified from the host (`add` / `del` / `context` /
 * `hunk` / `meta`), so this only paints. Copying a selection strips the leading
 * `+`/`-` so what lands on the clipboard is source, not a patch — the one piece
 * of diff behaviour the reference got right that is easy to miss.
 */

/** Render the diff pane into `host`. */
function renderDiffPanel(host) {
  const source = model.diffSource
  const head = el('div', { class: 'dsh-og-diff-head' },
    el('span', { class: 'dsh-og-diff-title' }, diffTitle()),
    diffTools())
  const body = el('div', { class: 'dsh-og-diff-body' })

  if (source === null) {
    body.append(el('div', { class: 'dsh-og-diff-empty' }, '请选择一个文件查看差异'))
  } else if (model.diffLoading) {
    body.append(el('div', { class: 'dsh-og-diff-empty' }, '正在加载差异...'))
  } else if (model.diff === null) {
    body.append(el('div', { class: 'dsh-og-diff-empty' }, '暂无可显示差异'))
  } else if (model.diff.error !== undefined) {
    body.append(el('div', { class: 'dsh-og-diff-empty' }, model.diff.error))
  } else if (model.diff.image !== undefined) {
    body.append(imageCards(model.diff.image))
  } else if (model.diff.lines.length === 0) {
    body.append(el('div', { class: 'dsh-og-diff-empty' }, '这个文件没有文本差异'))
  } else {
    body.append(...diffLines(model.diff))
  }
  fill(host, head, body)
}

/** The header text: the path, plus which side is being compared. */
function diffTitle() {
  const source = model.diffSource
  if (source === null) return '差异'
  const scope = source.kind === 'staged' ? '暂存区 ↔ HEAD'
    : source.kind === 'commit' ? '提交 ' + shortOid(source.rev)
      : '工作区 ↔ 暂存区'
  return source.path + '　·　' + scope
}

/** The diff toolbar: context lines, whitespace, word diff, copy. */
function diffTools() {
  const wrap = el('div', { class: 'dsh-og-diff-tools' })
  if (model.diffSource === null) return wrap
  wrap.append(select({
    value: String(pref('diffContext') ?? 3),
    title: '上下文行数',
    width: 66,
    options: CONTEXT_CHOICES.map((n) => ({ id: String(n), label: n + ' 行' })),
    onChange: (value) => {
      void savePrefs({ diffContext: Number.parseInt(value, 10) })
      reloadDiff()
    },
  }))
  wrap.append(iconButton('minus', {
    title: pref('ignoreWhitespace') === true ? '不再忽略空白' : '忽略空白改动',
    onClick: () => {
      void savePrefs({ ignoreWhitespace: pref('ignoreWhitespace') !== true })
      reloadDiff()
    },
  }))
  wrap.append(iconButton('search', {
    title: pref('wordDiff') === true ? '关闭逐词比较' : '逐词比较',
    onClick: () => {
      void savePrefs({ wordDiff: pref('wordDiff') !== true })
      reloadDiff()
    },
  }))
  wrap.append(iconButton('copy', { title: '复制整段差异', onClick: () => copyDiff() }))
  return wrap
}

/** Re-read the open diff after a rendering option changed. */
function reloadDiff() {
  const source = model.diffSource
  if (source === null) return
  void loadDiff({ kind: source.kind, rev: source.rev }, source.path, source.origPath)
}

/** The gutter and the lines, as two sibling columns that scroll together. */
function diffLines(diff) {
  const gutter = el('div', { class: 'dsh-og-diff-gutter' })
  const lines = el('div', { class: 'dsh-og-diff-lines' })
  for (const line of diff.lines) {
    gutter.append(el('div', { class: 'dsh-og-diff-gline' },
      el('span', { class: 'dsh-og-diff-no dsh-og-diff-no-old' }, line.oldNo === undefined ? '' : String(line.oldNo)),
      el('span', { class: 'dsh-og-diff-no' }, line.newNo === undefined ? '' : String(line.newNo))))
    const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
    lines.append(el('pre', { class: 'dsh-og-diff-line', 'data-kind': line.kind },
      line.kind === 'meta' || line.kind === 'hunk' ? line.text : marker + ' ' + line.text))
  }
  lines.addEventListener('copy', onDiffCopy)
  const nodes = [gutter, lines]
  if (diff.truncated === true) {
    nodes.push(el('div', { class: 'dsh-og-diff-empty' }, '差异太长，已截断显示'))
  }
  return nodes
}

/**
 * Strip the two leading characters this view adds to each changed line, so a
 * copied selection is usable source.
 */
function onDiffCopy(event) {
  const selection = window.getSelection()
  if (selection === null) return
  const text = selection.toString()
  if (text.length === 0) return
  const cleaned = text
    .split('\n')
    .map((line) => (/^[+-] /.test(line) ? line.slice(2) : line))
    .join('\n')
  if (cleaned === text) return
  event.clipboardData?.setData('text/plain', cleaned)
  event.preventDefault()
}

/** Copy the whole diff as a patch. */
function copyDiff() {
  const diff = model.diff
  if (diff === null || diff.lines === undefined) return
  const text = diff.lines
    .map((line) => (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'context' ? ' ' : '') + line.text)
    .join('\n')
  void copyText(text, '已复制差异')
}

/** Before/after cards for an image change. */
function imageCards(image) {
  const wrap = el('div', { class: 'dsh-og-diff-image' })
  const card = (title, url) => el('div', { class: 'dsh-og-diff-image-card' },
    el('div', { class: 'dsh-og-diff-image-head' }, title),
    el('div', { class: 'dsh-og-diff-image-wrap' },
      url === undefined || url === null
        ? el('span', { style: { color: 'var(--og-text-3)', 'font-size': '12px' } }, '（不存在）')
        : el('img', { src: url, alt: title })))
  wrap.append(card('修改前', image.before))
  wrap.append(card('修改后', image.after))
  return wrap
}
