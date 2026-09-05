/**
 * The commit box: the message textarea with the AI wand overlaid on its top-left
 * corner (exactly where the reference puts it), the amend / sign-off / auto-push
 * checkboxes, and the commit button.
 *
 * The AI wand does not block the box: the request becomes a host OPERATION, its
 * text streams back over SSE, and the textarea fills in as it arrives. That is
 * strictly better than the reference's modal progress dialog for something the
 * user is watching a sentence appear in.
 */

/** The whole commit block. */
function commitBox() {
  const status = model.status
  const staged = status === null ? 0 : status.counts.staged
  const conflicted = status === null ? 0 : status.counts.conflicted
  const amend = pref('amend') === true

  const box = textarea({
    value: model.commitMessage,
    rows: 4,
    placeholder: amend ? '修改最近一次提交的信息...' : '请输入提交信息...',
    maxLength: 20000,
    onInput: (event) => {
      model.commitMessage = event.target.value
      const counter = event.target.parentElement?.querySelector('.dsh-og-commit-count')
      if (counter !== null && counter !== undefined) counter.textContent = model.commitMessage.length + '/20000'
    },
    onKeydown: (event) => {
      // Ctrl/Cmd+Enter commits, which is what every git GUI trains for.
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void doCommit()
      }
    },
  })
  box.classList.add('dsh-og-commit-input')
  commitInputRef = box

  const wand = el('button', {
    type: 'button',
    class: 'dsh-og-commit-ai',
    title: aiTitle(),
    'data-busy': model.aiBusy ? 'true' : undefined,
    disabled: model.aiBusy || model.workspaceId.length === 0,
    onClick: () => void generateCommitMessage(),
  }, icon(model.aiBusy ? 'refresh' : 'wand'))

  const wrap = el('div', { class: 'dsh-og-commit-wrap' },
    wand,
    box,
    el('span', { class: 'dsh-og-commit-count' }, model.commitMessage.length + '/20000'))

  const row = el('div', { class: 'dsh-og-commit-row' },
    checkbox('覆盖最近一次提交', {
      checked: amend,
      onChange: (checked) => {
        void savePrefs({ amend: checked })
        if (checked && model.commitMessage.trim().length === 0) void fillHeadMessage()
      },
    }),
    checkbox('添加 Signed-off-by', {
      checked: pref('signoff') === true,
      onChange: (checked) => void savePrefs({ signoff: checked }),
    }),
    checkbox('提交后自动推送', {
      checked: pref('autoPushAfterCommit') === true,
      onChange: (checked) => void savePrefs({ autoPushAfterCommit: checked }),
    }),
    el('div', { class: 'dsh-og-commit-row-right' },
      el('span', { style: { 'font-size': '11px', color: 'var(--og-text-3)' } },
        conflicted > 0 ? conflicted + ' 个冲突未解决' : staged + ' 个文件已暂存'),
      button(amend ? '修改提交' : '提交', {
        kind: 'warning',
        icon: 'check',
        disabled: model.commitMessage.trim().length === 0 || conflicted > 0 ||
          (staged === 0 && !amend) || model.workspaceId.length === 0,
        onClick: () => void doCommit(),
      })))

  return el('div', { class: 'dsh-og-commit' }, wrap, row)
}

/** Live handle to the textarea, so a streaming AI answer can fill it in place. */
let commitInputRef = null

/** The wand's tooltip, which doubles as the "why not" when no model is set up. */
function aiTitle() {
  const availability = model.aiAvailability
  if (availability === null) return 'AI 生成提交信息'
  if (availability.available !== true) return availability.reason ?? 'AI 不可用'
  return 'AI 生成提交信息（' + availability.model + '）'
}

/** Pre-fill the box with HEAD's message, for an amend. */
async function fillHeadMessage() {
  try {
    const value = await apiGet('/head-message', { workspaceId: model.workspaceId })
    if (typeof value.message === 'string' && value.message.length > 0) {
      model.commitMessage = value.message
      emit()
    }
  } catch { /* an unborn branch has no HEAD message */ }
}

/** Commit, then optionally push. */
async function doCommit() {
  const message = model.commitMessage.trim()
  if (message.length === 0) {
    toast('请输入提交信息', 'warning')
    return
  }
  const amend = pref('amend') === true
  try {
    const result = await withBusy(() => apiPost('/commit', {
      workspaceId: model.workspaceId,
      message,
      amend,
      signoff: pref('signoff') === true,
    }))
    model.commitMessage = ''
    if (amend) void savePrefs({ amend: false })
    toast('已提交 ' + shortOid(result.oid), 'success')
    await Promise.all([loadStatus(), loadRepos(), loadHistory(false)])
    if (pref('autoPushAfterCommit') === true) openPushDialog()
  } catch (error) {
    toastError(error)
  }
  emit()
}

// ------------------------------------------------------------- AI generation
/**
 * Ask the host to write a commit message.
 *
 * The host runs it as an operation, so the wand's spinner is driven by the
 * operation record and each `text-delta` arrives as a log line — which is what
 * makes the message appear a phrase at a time instead of all at once.
 */
async function generateCommitMessage() {
  if (model.workspaceId.length === 0) return
  const availability = model.aiAvailability
  if (availability !== null && availability.available !== true) {
    toast(availability.reason ?? 'AI 不可用', 'warning', 5000)
    return
  }
  if (model.commitMessage.trim().length > 0) {
    const confirmed = await confirmBox({
      title: '提示',
      message: '当前提交信息不为空，继续将覆盖现有内容，是否继续？',
      confirmText: '继续',
      tone: 'warning',
    })
    if (!confirmed) return
  }

  model.aiBusy = true
  model.commitMessage = ''
  emit()
  let record
  try {
    record = await apiPost('/ai/commit-message', {
      workspaceId: model.workspaceId,
      style: pref('aiStyle') ?? 'conventional',
      language: pref('aiLanguage') ?? 'zh',
      source: (model.status?.counts.staged ?? 0) > 0 ? 'staged' : 'worktree',
    })
  } catch (error) {
    model.aiBusy = false
    emit()
    toastError(error)
    return
  }
  aiOperationId = record.id
  // The operation can FINISH before this POST's response is parsed — a model that
  // errors immediately does. The SSE record for that would have arrived while
  // `aiOperationId` was still null and been dropped, leaving the wand spinning
  // forever, so whatever the stream already recorded is applied here.
  const known = model.ops.find((row) => row.id === record.id)
  applyAiOperation(known ?? record)
  emit()
  // Only when the panel has no live stream to lean on.
  if (!model.connected) void pollAiOperation(record.id)
}

/**
 * Poll the operation once as a backstop for a browser with no EventSource: with
 * no SSE nothing would ever clear `aiBusy`, so the wand would stay disabled.
 */
async function pollAiOperation(id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (aiOperationId !== id) return
    await new Promise((wait) => setTimeout(wait, 400))
    if (aiOperationId !== id) return
    let record
    try {
      record = await apiGet('/ops/' + id)
    } catch {
      // The record expires 30 minutes after it finishes; stop chasing it.
      model.aiBusy = false
      aiOperationId = null
      emit()
      return
    }
    mergeOperation(record)
    applyAiOperation(record)
    if (record.status !== 'running') return
  }
}

/** The operation currently writing into the commit box, if any. */
let aiOperationId = null

/**
 * Fold one operation record into the commit box. Called for EVERY operation
 * record; it ignores the ones that are not this box's.
 */
function applyAiOperation(record) {
  if (aiOperationId === null || record.id !== aiOperationId) return
  if (record.status === 'running') {
    // `partial` carries the deltas verbatim, newlines and all.
    const text = record.partial
    if (typeof text === 'string' && text.length > 0) {
      model.commitMessage = text
      if (commitInputRef !== null && commitInputRef.isConnected) commitInputRef.value = text
    }
    return
  }
  aiOperationId = null
  model.aiBusy = false
  if (record.status === 'done' && record.result !== undefined && record.result !== null) {
    model.commitMessage = String(record.result.message ?? '')
    if (commitInputRef !== null && commitInputRef.isConnected) commitInputRef.value = model.commitMessage
    const notes = []
    if (record.result.truncated === true) notes.push('改动过大，模型只看到了前一部分')
    if (record.result.cutoff === true) notes.push('输出被长度上限截断')
    toast(notes.length === 0 ? '已生成提交信息' : '已生成提交信息（' + notes.join('；') + '）', 'success', 4200)
  } else if (record.status === 'failed') {
    model.commitMessage = ''
    if (commitInputRef !== null && commitInputRef.isConnected) commitInputRef.value = ''
    toast(record.error === undefined ? 'AI 生成失败' : friendlyError(record.error), 'error', 5200)
  } else if (record.status === 'canceled') {
    toast('已取消 AI 生成', 'warning')
  }
  emit()
}
