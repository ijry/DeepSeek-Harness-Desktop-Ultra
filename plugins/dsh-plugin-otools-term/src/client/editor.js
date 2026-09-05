/**
 * The remote file editor: one pane per editor tab, opened from the SFTP tree.
 *
 * The reference embedded CodeMirror 6 with six language modes. That is a second
 * vendored library and a per-language module graph for a feature whose job is
 * "change a line in nginx.conf and save it", so this is a textarea with a line
 * gutter, tab-inserts-a-tab, and Ctrl/Cmd+S — the same interaction contract
 * (`save-requested`, dirty tracking, a size cap) without the payload. Syntax
 * highlighting is the one thing knowingly given up, and the README says so.
 *
 * Like the terminal panes, an editor pane is built once and kept across repaints: a
 * textarea rebuilt on every render would lose the caret on every keystroke.
 */

/** tabId → the live editor. */
const editors = new Map()

/** Build the DOM for one editor tab. */
function buildEditorPane(tab) {
  const gutter = el('div', { class: 'dsh-ot-editor-gutter' }, '1')
  const area = el('textarea', {
    class: 'dsh-ot-editor-area',
    spellcheck: 'false',
    wrap: 'off',
    placeholder: t('editor.loading'),
  })
  const status = el('div', { class: 'dsh-ot-editor-foot' })
  const head = el('div', { class: 'dsh-ot-editor-head' })
  const pane = el('div', { class: 'dsh-ot-pane', 'data-tab': tab.id },
    el('div', { class: 'dsh-ot-editor' },
      head,
      el('div', { class: 'dsh-ot-editor-body' }, gutter, area),
      status))

  const entry = { tabId: tab.id, pane, head, area, gutter, status, disposed: false }
  editors.set(tab.id, entry)

  area.addEventListener('input', () => {
    tab.content = area.value
    tab.dirty = tab.content !== tab.original
    renderEditorChrome(tab)
    emit()
  })
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveEditor(tab)
      return
    }
    if (event.key === 'Tab') {
      // A code editor inserts a tab; letting the browser move focus out of a file
      // you are editing is never what was meant.
      event.preventDefault()
      insertAtCaret(area, '\t')
      tab.content = area.value
      tab.dirty = tab.content !== tab.original
      renderEditorChrome(tab)
    }
  })
  area.addEventListener('scroll', () => {
    entry.gutter.scrollTop = area.scrollTop
  })
  area.addEventListener('click', () => renderEditorChrome(tab))
  area.addEventListener('keyup', () => renderEditorChrome(tab))

  void loadEditor(tab)
  return pane
}

/** Insert text at the caret, keeping the caret after it. */
function insertAtCaret(area, text) {
  const start = area.selectionStart
  const end = area.selectionEnd
  area.value = area.value.slice(0, start) + text + area.value.slice(end)
  area.selectionStart = start + text.length
  area.selectionEnd = area.selectionStart
}

/** Read one remote file into its tab. */
async function loadEditor(tab) {
  const entry = editors.get(tab.id)
  if (entry === undefined) return
  tab.loading = true
  renderEditorChrome(tab)
  try {
    const value = await apiGet('/sftp/read', { serverId: tab.serverId, path: tab.filePath })
    tab.binary = value.binary === true
    tab.content = value.binary === true ? '' : value.content
    tab.original = tab.content
    tab.dirty = false
    tab.mode = value.mode
    tab.permissions = value.permissions
    tab.size = value.size
    entry.area.value = tab.content
    entry.area.readOnly = tab.binary === true
    entry.area.placeholder = tab.binary === true ? t('editor.binary') : ''
  } catch (error) {
    toast(t('editor.openFailed', { message: friendlyError(error) }), 'error')
    entry.area.value = ''
    entry.area.placeholder = friendlyError(error)
  } finally {
    tab.loading = false
    renderEditorChrome(tab)
    emit()
  }
}

/** Write one tab back to the server. */
async function saveEditor(tab) {
  const entry = editors.get(tab.id)
  if (entry === undefined || tab.loading === true || tab.saving === true) return
  if (tab.binary === true) return
  tab.saving = true
  renderEditorChrome(tab)
  try {
    const value = await apiPost('/sftp/write', { serverId: tab.serverId, path: tab.filePath, content: tab.content })
    tab.original = tab.content
    tab.dirty = false
    tab.size = value.size
    toast(t('editor.saved'), 'success')
  } catch (error) {
    toast(t('editor.saveFailed', { message: friendlyError(error) }), 'error')
  } finally {
    tab.saving = false
    renderEditorChrome(tab)
    emit()
  }
}

/** Re-read one tab, warning when that would drop edits. */
async function refreshEditor(tab) {
  if (tab.dirty === true) {
    const go = await confirmDialog({
      title: t('editor.refresh'),
      message: t('editor.discardConfirm', { name: tab.name }),
      danger: true,
    })
    if (!go) return
  }
  await loadEditor(tab)
  toast(t('editor.refresh'), 'success')
}

/** Repaint the head, gutter and status line of one editor. */
function renderEditorChrome(tab) {
  const entry = editors.get(tab.id)
  if (entry === undefined) return
  fill(entry.head,
    el('div', { class: 'dsh-ot-editor-path', title: tab.filePath }, tab.filePath),
    el('div', { class: 'dsh-ot-toolbar-group' },
      tab.dirty === true ? tag(t('editor.dirty'), 'warning') : undefined,
      tab.permissions === undefined ? undefined : tag(tab.permissions, undefined, { title: t('sftp.context.chmod') }),
      button({ label: t('editor.refresh'), disabled: tab.loading === true || tab.saving === true, onClick: () => void refreshEditor(tab) }),
      button({
        label: t('editor.save'),
        variant: 'primary',
        disabled: tab.loading === true || tab.saving === true || tab.dirty !== true || tab.binary === true,
        onClick: () => void saveEditor(tab),
      })))

  const lines = entry.area.value.split('\n')
  // The gutter is a text column, not one element per line: a 20 000-line file would
  // otherwise be 20 000 nodes to repaint on every keystroke.
  const numbers = []
  for (let index = 1; index <= Math.max(1, lines.length); index += 1) numbers.push(index)
  fill(entry.gutter, numbers.join('\n'))
  entry.gutter.scrollTop = entry.area.scrollTop

  const caret = entry.area.selectionStart ?? 0
  const before = entry.area.value.slice(0, caret).split('\n')
  fill(entry.status,
    el('span', {}, t('editor.lineColumn', { line: before.length, column: (before[before.length - 1] ?? '').length + 1 })),
    el('span', {}, formatBytes(new TextEncoder().encode(entry.area.value).length)),
    tab.loading === true ? el('span', {}, t('editor.loading')) : undefined)
}

/** Tear one editor down. */
function disposeEditor(tabId) {
  const entry = editors.get(tabId)
  if (entry === undefined) return
  entry.disposed = true
  editors.delete(tabId)
  try {
    entry.pane.remove()
  } catch { /* already detached */ }
}

/** Whether any editor tab of one server has unsaved work. */
function hasDirtyEditors(serverId) {
  return model.tabs.some((tab) => tab.kind === 'editor' && tab.serverId === serverId && tab.dirty === true)
}
