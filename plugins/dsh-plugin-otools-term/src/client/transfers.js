/**
 * The transfer drawer: the reference's bottom sheet, with a row per task.
 *
 * Same fields the reference showed (kind · basename, status tag, source → target,
 * current item, file count, bytes, a progress bar, the error). Two additions: a
 * cancel button, because a recursive transfer of the wrong folder used to be
 * unstoppable, and honest progress on a single large file — the reference emitted one
 * event per file, so a 4 GB copy sat at 0% and then jumped to 100%.
 */

/** Localised status text. */
function taskStatusText(status) {
  const known = { pending: 'main.taskStatus.pending', transferring: 'main.taskStatus.transferring', completed: 'main.taskStatus.completed', failed: 'main.taskStatus.failed' }
  return known[status] === undefined ? status : t(known[status])
}

/** Tag tone per status. */
function taskTone(status) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'transferring') return 'primary'
  return undefined
}

/** Render the drawer into its host element. */
function renderDrawer(host) {
  setData(host, 'hidden', !model.drawerOpen)
  if (!model.drawerOpen) {
    fill(host)
    return
  }
  const body = el('div', { class: 'dsh-ot-drawer-body' })
  if (model.tasks.length === 0) {
    body.append(el('div', { class: 'dsh-ot-empty' }, t('main.noTransferTasks')))
  }
  for (const task of model.tasks) body.append(renderTask(task))
  fill(host,
    el('div', { class: 'dsh-ot-drawer-head' },
      el('span', { class: 'dsh-ot-drawer-title' }, t('main.transferTasks')),
      el('div', { class: 'dsh-ot-toolbar-group' },
        button({ label: t('main.clearFinished'), onClick: () => void clearFinishedTasks() }),
        iconButton('close', {
          variant: 'ghost',
          title: t('main.close'),
          onClick: () => {
            model.drawerOpen = false
            emit()
          },
        }))),
    body)
}

/** One task card. */
function renderTask(task) {
  const running = task.status === 'pending' || task.status === 'transferring'
  return el('div', { class: 'dsh-ot-task' },
    el('div', { class: 'dsh-ot-task-head' },
      el('span', { class: 'dsh-ot-task-name', title: task.source },
        (task.kind === 'upload' ? t('main.taskKindUpload') : t('main.taskKindDownload')) + ' · ' + baseName(task.source)),
      el('div', { class: 'dsh-ot-toolbar-group' },
        tag(taskStatusText(task.status), taskTone(task.status)),
        running
          ? iconButton('close', { variant: 'ghost', title: t('main.cancelTask'), onClick: () => void cancelTask(task.id) })
          : undefined)),
    el('div', { class: 'dsh-ot-task-line' }, task.source + ' → ' + task.target),
    el('div', { class: 'dsh-ot-task-meta' },
      el('span', {}, task.currentItem.length > 0 ? task.currentItem : '-'),
      el('span', {}, t('main.fileCount', { done: task.completedFiles, total: task.totalFiles })),
      el('span', {}, formatBytes(task.bytesTransferred) + ' / ' + formatBytes(task.bytesTotal))),
    progressBar(task.progress, task.status),
    task.error.length > 0 ? el('div', { class: 'dsh-ot-task-error' }, task.error) : undefined)
}

/** Ask the host to stop one transfer. */
async function cancelTask(taskId) {
  try {
    await apiPost('/transfer/cancel', { taskId })
  } catch (error) {
    toastError(error)
  }
}

/** Drop the finished rows. */
async function clearFinishedTasks() {
  try {
    const value = await apiPost('/transfer/clear', {})
    model.tasks = value.tasks
    emit()
  } catch (error) {
    toastError(error)
  }
}
