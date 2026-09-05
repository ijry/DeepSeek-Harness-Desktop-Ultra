/**
 * The AI bar: DSH's own model, one row under the terminal.
 *
 * Two jobs, and a deliberate asymmetry between them:
 *
 *   一句话 → 命令   the answer is INSERTED into the terminal without a trailing
 *                   newline, so the user reads it and presses Enter. "Run it" exists,
 *                   but a command matching the danger list has to be confirmed first.
 *   解释这屏输出     the answer is prose in the same bar; nothing is ever sent to the
 *                   shell.
 *
 * Nothing here talks to a model directly: `/ai/start` runs it host-side through
 * `ctx.llm.stream` and the deltas arrive on the panel's event stream, which means
 * closing the bar (or the whole panel) does not cancel a generation, and reopening
 * shows what has arrived so far.
 */

/** Render the bar into its host element. */
function renderAiBar(host) {
  const tab = activeTab()
  const isTerminal = tab !== undefined && tab.kind === 'terminal'
  setData(host, 'hidden', !model.aiOpen)
  if (!model.aiOpen) {
    fill(host)
    return
  }
  if (model.ai.available !== true) {
    fill(host, el('div', { class: 'dsh-ot-ai-row' },
      el('span', { class: 'dsh-ot-field-hint' }, t('ai.unavailable', { reason: model.ai.reason ?? '' })),
      el('span', { style: { flex: '1' } }),
      iconButton('close', { variant: 'ghost', title: t('main.close'), onClick: () => toggleAiBar(false) })))
    return
  }

  const job = activeJob()
  const box = input({
    value: model.aiAsk ?? '',
    placeholder: t('ai.askPlaceholder'),
    onInput: (event) => {
      model.aiAsk = event.target.value
    },
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void startAiJob('command')
      }
    },
  })
  const rows = [
    el('div', { class: 'dsh-ot-ai-row' },
      el('span', { class: 'dsh-ot-entry-icon' }, icon('sparkles', 16)),
      box,
      button({ label: t('ai.generate'), variant: 'primary', disabled: !isTerminal, onClick: () => void startAiJob('command') }),
      button({ label: t('ai.explain'), disabled: !isTerminal, onClick: () => void startAiJob('explain') }),
      iconButton('close', { variant: 'ghost', title: t('main.close'), onClick: () => toggleAiBar(false) })),
    el('div', { class: 'dsh-ot-ai-meta' },
      el('span', {}, t('ai.model', { provider: model.ai.provider ?? '', model: model.ai.model ?? '' })),
      isTerminal ? undefined : el('span', {}, t('ai.needTerminal'))),
  ]

  if (job !== undefined) rows.push(...renderAiJob(job, tab))
  fill(host, ...rows)
}

/** The answer block for one job. */
function renderAiJob(job, tab) {
  const rows = []
  const running = job.status === 'running'
  rows.push(el('div', { class: 'dsh-ot-ai-out', 'data-kind': job.kind },
    job.text.length > 0 ? job.text : (running ? t('ai.thinking') : (job.error.length > 0 ? job.error : ''))))
  if (job.kind === 'command' && job.risk !== undefined && job.risk.dangerous === true) {
    rows.push(el('div', { class: 'dsh-ot-ai-danger' },
      icon('warning', 16),
      el('div', {},
        el('div', { style: { 'font-weight': '600' } }, t('ai.dangerTitle')),
        el('div', {}, t('ai.dangerBody', { reasons: job.risk.reasons.join(', ') })))))
  }
  const actions = [
    running
      ? button({ label: t('ai.cancel'), onClick: () => void apiPost('/ai/cancel', { jobId: job.id }).catch(toastError) })
      : undefined,
  ]
  if (!running && job.kind === 'command' && job.text.length > 0) {
    actions.push(button({
      label: t('ai.insert'),
      variant: 'primary',
      disabled: tab === undefined || tab.kind !== 'terminal',
      onClick: () => insertAiCommand(job, tab, false),
    }))
    actions.push(button({
      label: t('ai.run'),
      icon: 'play',
      disabled: tab === undefined || tab.kind !== 'terminal',
      onClick: () => void insertAiCommand(job, tab, true),
    }))
    actions.push(button({ label: t('ai.copy'), icon: 'copy', onClick: () => void copyText(job.text, t('main.copied')) }))
  }
  if (!running) {
    actions.push(button({
      label: t('ai.discard'),
      onClick: () => {
        model.aiJobId = null
        emit()
      },
    }))
  }
  rows.push(el('div', { class: 'dsh-ot-ai-row', style: { 'justify-content': 'flex-end' } }, ...actions.filter((row) => row !== undefined)))
  return rows
}

/** Show or hide the bar. */
function toggleAiBar(open) {
  model.aiOpen = open === undefined ? !model.aiOpen : open === true
  emit()
}

/** Start one job for the active terminal. */
async function startAiJob(kind) {
  const tab = activeTab()
  if (tab === undefined || tab.kind !== 'terminal') {
    toast(t('ai.needTerminal'), 'warning')
    return
  }
  const ask = String(model.aiAsk ?? '').trim()
  if (kind === 'command' && ask.length === 0) return
  try {
    const job = await apiPost('/ai/start', {
      kind,
      sessionId: tab.sessionId,
      ask,
      language: pref('aiLanguage', 'zh'),
      withContext: true,
    })
    mergeJob(job)
    model.aiJobId = job.id
    if (kind === 'command') model.aiAsk = ''
    emit()
  } catch (error) {
    toast(t('ai.failed', { message: friendlyError(error) }), 'error')
  }
}

/**
 * Put one suggested command into the terminal.
 *
 * Inserting sends the text with NO newline: the command lands at the prompt and the
 * user presses Enter. Running appends the newline, and a command on the danger list
 * has to be confirmed first (unless the user turned that off).
 */
async function insertAiCommand(job, tab, run) {
  const text = job.text
  if (run === true && job.risk !== undefined && job.risk.dangerous === true && pref('confirmDangerousCommands', true) === true) {
    const go = await confirmDialog({
      title: t('ai.dangerTitle'),
      message: text,
      detail: t('ai.dangerBody', { reasons: job.risk.reasons.join(', ') }),
      danger: true,
      confirmLabel: t('ai.dangerConfirm'),
    })
    if (!go) return
  }
  const sent = typeIntoTerminal(tab.id, run === true ? text + '\n' : text)
  if (!sent) {
    toast(t('main.terminalNotReady'), 'warning')
    return
  }
  model.aiJobId = null
  emit()
}
