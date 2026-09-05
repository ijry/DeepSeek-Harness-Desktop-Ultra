/**
 * Browser half of dsh-plugin-taskboard — a codeg-plus-style 任务看板 view for
 * the DSH web GUI, built in dependency-free vanilla DOM on purpose: the host
 * serves the JSON+SSE API at /dsh-plugin-taskboard and this bundle only talks
 * to it, so it needs no React runtime or @deepseek-ai/* packages in the
 * browser.
 *
 * Export shape: `name` / `inject` / `apply` (no default export). The build
 * (scripts/wrap-client.mjs) wraps this file in the DSH module loader
 * (`window.__ModuleLoader__.load`), which provides a CommonJS `module`, so
 * this file assigns `module.exports` when present and is otherwise inert.
 *
 * Failure policy mirrors the reference plugin: DOM/board problems are logged,
 * never thrown — the web shell must not fail boot because a board seat is
 * missing on some DSH layout.
 *
 * The column/status vocabulary intentionally mirrors the shared protocol
 * (src/shared/protocol.js) and codeg-plus board-columns.ts; keep both copies
 * in sync when the vocabulary changes.
 *
 * @module dsh-plugin-taskboard/client
 */
(function () {
  'use strict'

  const PLUGIN_ID = 'dsh-plugin-taskboard'
  const ROUTE_PREFIX = '/dsh-plugin-taskboard'
  const SSE_PATH = '/dsh-plugin-taskboard/events'
  const STYLE_ID = 'dsh-plugin-taskboard-style'

  // ------------------------------------------------------------------- i18n
  // This bundle is wrapped into ONE standalone file (scripts/wrap-client.mjs)
  // and cannot import shared/lang.js, so the normalizer and the whole string
  // table live here. The language comes from the host (`language` on GET
  // /state, i.e. the shell's DSH_DESKTOP_LANG); standalone installs (no
  // shell) fall back to navigator.language and finally to Chinese.
  const LANGS = ['zh', 'en']
  const DEFAULT_LANG = 'zh'
  const lang = { current: DEFAULT_LANG }

  /** Same rules as shared/lang.js: zh / zh-CN / zh_CN.UTF-8 / en / en-US. */
  function normalizeLang(value) {
    if (typeof value !== 'string') return null
    const primary = value.trim().toLowerCase().replace(/_/g, '-').split(/[-.@]/)[0]
    return LANGS.includes(primary) ? primary : null
  }

  const STRINGS = {
    zh: {
      column: { todo: '待办', inProgress: '进行中', attention: '需关注', done: '已完成' },
      status: {
        todo: '待办',
        queued: '排队',
        preparing: '准备中',
        running: '执行中',
        awaiting_input: '等待输入',
        review: '待验收',
        merging: '合并中',
        failed: '失败',
        done: '已完成',
        canceled: '已取消',
      },
      'actor.you': '你',
      'time.now': '刚刚',
      'time.minutes': (n) => n + ' 分钟前',
      'time.hours': (n) => n + ' 小时前',
      'board.title': '任务看板',
      'board.connecting': '连接中…',
      'board.live': '实时同步中',
      'board.offline': '连接断开',
      'board.refresh': '刷新',
      'board.newTask': '＋ 新建任务',
      'board.searchPlaceholder': '搜索标题 / 任务 ID',
      'board.showCanceled': '显示已取消',
      'board.allProjects': '全部项目',
      'board.noProject': '无项目',
      'board.noTasks': '暂无任务',
      'board.untitled': '（无标题）',
      'entry.stats': (c) => '待办 ' + c.todo + ' · 需关注 ' + c.attention + ' · 待验收 ' + c.review,
      'modal.close': '关闭',
      'toast.syncFailed': (detail) => '同步失败：' + detail,
      'form.editTitle': '编辑任务',
      'form.newTitle': '新建任务',
      'form.titlePlaceholder': '必填：一句话描述要做什么',
      'form.descPlaceholder': '背景 / 上下文（可选）',
      'form.promptPlaceholder': '让 Agent 执行的 Prompt（可选）',
      'form.title': '标题 *',
      'form.description': '描述',
      'form.prompt': '执行 Prompt',
      'form.project': '项目',
      'form.cancel': '取消',
      'form.save': '保存',
      'form.create': '创建',
      'form.needTitle': '请填写任务标题',
      'form.submitting': '提交中…',
      'toast.taskUpdated': '任务已更新',
      'toast.taskCreated': '任务已创建',
      'detail.title': '任务详情',
      'detail.notes': '备注与评论',
      'detail.notePlaceholder': '写备注 / 补充说明，Ctrl+Enter 发送',
      'detail.send': '发送',
      'detail.none': '（无）',
      'detail.loading': '加载任务详情中…',
      'detail.kvStatus': '状态',
      'detail.kvTask': '任务',
      'detail.kvProject': '项目',
      'detail.kvClaim': '认领',
      'detail.kvUpdated': '更新',
      'detail.kvCreated': '创建',
      'detail.noNotes': '暂无备注',
      'detail.edit': '编辑',
      'detail.accept': '✓ 通过验收',
      'detail.sendBack': '退回待办',
      'detail.reopen': '重新打开',
      'detail.move': '移动',
      'detail.moveTo': '移到',
      'detail.refreshFailed': (raw) => '刷新任务详情失败：' + raw,
      'toast.taskGone': '任务已被删除或不存在',
      'toast.sentBack': '已退回待办',
      'toast.taskDeleted': '任务已删除',
      'toast.noteEmpty': '先写点备注内容',
      'toast.noteSent': '备注已发送',
      'confirm.sendBack': '退回待办？确认后任务回到“待办”列并解除认领。',
      'confirm.delete': '确定删除该任务吗？删除后不可恢复。',
      'action.accept': '验收',
      'action.reopenTask': '重新打开任务',
      'action.moveTask': '移动任务',
      'action.updateTask': '更新任务',
      'action.createTask': '创建任务',
      'action.rejectTask': '退回任务',
      'action.deleteTask': '删除任务',
      'action.sendNote': '发送备注',
      'result.ok': (label) => label + '成功',
      'result.stale': (label) => label + '未生效：任务刚被更新过，请重试',
      'result.gone': (label) => label + '未生效：任务已不存在',
      'result.forbidden': (label) => label + '未生效：任务当前状态不允许该操作',
      'result.transition': (label) => label + '未生效：当前状态不允许这个操作',
      'result.invalid': (parts) => parts.label + '未生效：' + parts.detail,
      'result.failed': (parts) => parts.label + '失败：' + parts.detail,
    },
    en: {
      column: { todo: 'To do', inProgress: 'In progress', attention: 'Attention', done: 'Done' },
      status: {
        todo: 'To do',
        queued: 'Queued',
        preparing: 'Preparing',
        running: 'Running',
        awaiting_input: 'Awaiting input',
        review: 'Review',
        merging: 'Merging',
        failed: 'Failed',
        done: 'Done',
        canceled: 'Canceled',
      },
      'actor.you': 'you',
      'time.now': 'just now',
      'time.minutes': (n) => n + ' min ago',
      'time.hours': (n) => n + ' hr ago',
      'board.title': 'Task Board',
      'board.connecting': 'Connecting…',
      'board.live': 'Live sync',
      'board.offline': 'Disconnected',
      'board.refresh': 'Refresh',
      'board.newTask': '+ New task',
      'board.searchPlaceholder': 'Search title / task ID',
      'board.showCanceled': 'Show canceled',
      'board.allProjects': 'All projects',
      'board.noProject': 'No project',
      'board.noTasks': 'No tasks',
      'board.untitled': '(untitled)',
      'entry.stats': (c) => 'To do ' + c.todo + ' · Attention ' + c.attention + ' · Review ' + c.review,
      'modal.close': 'Close',
      'toast.syncFailed': (detail) => 'Sync failed: ' + detail,
      'form.editTitle': 'Edit task',
      'form.newTitle': 'New task',
      'form.titlePlaceholder': 'Required: one line on what to do',
      'form.descPlaceholder': 'Background / context (optional)',
      'form.promptPlaceholder': 'Prompt for the agent to run (optional)',
      'form.title': 'Title *',
      'form.description': 'Description',
      'form.prompt': 'Prompt',
      'form.project': 'Project',
      'form.cancel': 'Cancel',
      'form.save': 'Save',
      'form.create': 'Create',
      'form.needTitle': 'Enter a task title',
      'form.submitting': 'Submitting…',
      'toast.taskUpdated': 'Task updated',
      'toast.taskCreated': 'Task created',
      'detail.title': 'Task detail',
      'detail.notes': 'Notes & comments',
      'detail.notePlaceholder': 'Write a note, Ctrl+Enter to send',
      'detail.send': 'Send',
      'detail.none': '(none)',
      'detail.loading': 'Loading task detail…',
      'detail.kvStatus': 'Status',
      'detail.kvTask': 'Task',
      'detail.kvProject': 'Project',
      'detail.kvClaim': 'Claim',
      'detail.kvUpdated': 'Updated',
      'detail.kvCreated': 'Created',
      'detail.noNotes': 'No notes yet',
      'detail.edit': 'Edit',
      'detail.accept': '✓ Accept',
      'detail.sendBack': 'Send back to todo',
      'detail.reopen': 'Reopen',
      'detail.move': 'Move',
      'detail.moveTo': 'Move to',
      'detail.refreshFailed': (raw) => 'Refreshing the task detail failed: ' + raw,
      'toast.taskGone': 'That task is deleted or does not exist',
      'toast.sentBack': 'Sent back to todo',
      'toast.taskDeleted': 'Task deleted',
      'toast.noteEmpty': 'Write a note first',
      'toast.noteSent': 'Note sent',
      'confirm.sendBack': 'Send back to todo? The task returns to the To do column and the claim is released.',
      'confirm.delete': 'Delete this task? This cannot be undone.',
      'action.accept': 'Accept',
      'action.reopenTask': 'Reopen task',
      'action.moveTask': 'Move task',
      'action.updateTask': 'Update task',
      'action.createTask': 'Create task',
      'action.rejectTask': 'Send task back',
      'action.deleteTask': 'Delete task',
      'action.sendNote': 'Send note',
      'result.ok': (label) => label + ': done',
      'result.stale': (label) => label + ' did not apply: the task was just updated, please retry',
      'result.gone': (label) => label + ' did not apply: the task no longer exists',
      'result.forbidden': (label) => label + ' did not apply: the task’s current status does not allow it',
      'result.transition': (label) => label + ' did not apply: the current status does not allow this operation',
      'result.invalid': (parts) => parts.label + ' did not apply: ' + parts.detail,
      'result.failed': (parts) => parts.label + ' failed: ' + parts.detail,
    },
  }

  /** The live dictionary — never captured, so a language switch is visible. */
  function dict() {
    return STRINGS[lang.current] ?? STRINGS.zh
  }

  /** One string from the live dictionary; parameterized entries are functions. */
  function t(key, arg) {
    const value = dict()[key]
    if (typeof value === 'function') return value(arg)
    return value === undefined ? key : value
  }

  /** Board column label. */
  function columnLabel(id) {
    const labels = dict().column
    return labels[id] ?? String(id)
  }

  /** Status label; an unknown status renders raw, as it always did. */
  function statusLabel(status) {
    const labels = dict().status
    return labels[status] ?? String(status)
  }

  /**
   * Adopt a language. The board chrome (toolbar, controls, sidebar entry) is
   * built once, so a real switch has to re-create it; unknown values are
   * ignored, which is what keeps the fallback chain intact.
   */
  function setLang(value) {
    const next = normalizeLang(value)
    if (next === null || next === lang.current) return
    lang.current = next
    rebuildBoard()
    emit()
  }

  // ---------------------------------------------------------------- domain
  /** The four board columns in order; labels come from the string table. */
  const COLUMNS = ['todo', 'inProgress', 'attention', 'done']

  function columnOf(status) {
    switch (status) {
      case 'todo':
      case 'queued':
        return 'todo'
      case 'preparing':
      case 'running':
        return 'inProgress'
      case 'awaiting_input':
      case 'review':
      case 'merging':
      case 'failed':
        return 'attention'
      case 'done':
      case 'canceled':
        return 'done'
      default:
        return 'todo'
    }
  }

  function byFreshest(a, b) {
    return (
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
  }

  function actorLabel(actor) {
    if (actor === undefined || actor === null) return 'unknown'
    return actor.kind === 'agent'
      ? 'agent ' + String(actor.sessionId ?? '').slice(0, 12)
      : t('actor.you')
  }

  function fmtTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
    const delta = Date.now() - ms
    if (delta < 60000) return t('time.now')
    if (delta < 3600000) return t('time.minutes', Math.floor(delta / 60000))
    if (delta < 86400000) return t('time.hours', Math.floor(delta / 3600000))
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs) {
    const node = document.createElement(tag)
    if (attrs !== undefined && attrs !== null) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'style') node.setAttribute('style', String(value))
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else if (key.startsWith('data-')) node.setAttribute(key, String(value))
        else if (key === 'value' || key === 'checked' || key === 'disabled') {
          try { node[key] = value } catch { node.setAttribute(key, String(value)) }
        } else node.setAttribute(key, String(value))
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i]
      if (child === undefined || child === null || child === false) continue
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item === undefined || item === null || item === false) continue
          node.append(item instanceof Node ? item : document.createTextNode(String(item)))
        }
      } else {
        node.append(child instanceof Node ? child : document.createTextNode(String(child)))
      }
    }
    return node
  }

  function textArea(attrs) {
    const node = document.createElement('textarea')
    if (attrs !== undefined) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'value') node.value = String(value)
        else node.setAttribute(key, String(value))
      }
    }
    return node
  }

  // --------------------------------------------------------------- network
  const api = {
    async request(path, options) {
      const res = await fetch(path, options)
      let data = null
      try { data = await res.json() } catch { /* non-JSON error body */ }
      if (res.ok !== true || data === null || data.ok !== true) {
        const detail = data !== null && data.error !== undefined ? data.error.message : 'HTTP ' + res.status
        const err = new Error(String(detail))
        err.status = res.status
        throw err
      }
      return data.value
    },
    post(path, body) {
      return api.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    state() { return api.request(ROUTE_PREFIX + '/state') },
    workspaces() { return api.request(ROUTE_PREFIX + '/workspaces') },
    task(id) { return api.request(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id)) },
    create(payload) { return api.post(ROUTE_PREFIX + '/tasks', payload) },
    update(id, payload) { return api.post(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id) + '/update', payload) },
    move(id, payload) { return api.post(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id) + '/move', payload) },
    reject(id, payload) { return api.post(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id) + '/reject', payload) },
    comment(id, body) { return api.post(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id) + '/comment', { body }) },
    remove(id, payload) { return api.post(ROUTE_PREFIX + '/tasks/' + encodeURIComponent(id) + '/delete', payload) },
  }

  // ---------------------------------------------------------------- styles
  const STYLES = `
:root {
  --cgtb-bg: #15181e;
  --cgtb-panel: #1c212a;
  --cgtb-panel-2: #232936;
  --cgtb-border: rgba(255,255,255,.09);
  --cgtb-text: #e8ebf1;
  --cgtb-text-2: rgba(232,235,241,.64);
  --cgtb-text-3: rgba(232,235,241,.4);
  --cgtb-input: #101318;
  --cgtb-hover: rgba(255,255,255,.07);
  --cgtb-active: rgba(255,255,255,.12);
  --cgtb-shadow: 0 12px 34px rgba(0,0,0,.5);
  --cgtb-focus: #5b8cff;
  --cgtb-danger: #e25563;
  --cgtb-ok: #3fb06b;
  --cgtb-st-todo: #5b8cff;
  --cgtb-st-queued: #7f8fa4;
  --cgtb-st-preparing: #e0a13c;
  --cgtb-st-running: #e0863a;
  --cgtb-st-awaiting_input: #a06ce0;
  --cgtb-st-review: #c058e6;
  --cgtb-st-merging: #2bb3a3;
  --cgtb-st-failed: #e25563;
  --cgtb-st-done: #3fb06b;
  --cgtb-st-canceled: #7f8fa4;
}
@media (prefers-color-scheme: light) {
  :root {
    --cgtb-bg: #f3f5f9;
    --cgtb-panel: #ffffff;
    --cgtb-panel-2: #eef1f6;
    --cgtb-border: rgba(15,23,42,.12);
    --cgtb-text: #1b2430;
    --cgtb-text-2: rgba(27,36,48,.62);
    --cgtb-text-3: rgba(27,36,48,.4);
    --cgtb-input: #ffffff;
    --cgtb-hover: rgba(15,23,42,.06);
    --cgtb-active: rgba(15,23,42,.1);
    --cgtb-shadow: 0 12px 34px rgba(15,23,42,.2);
  }
}

/* Sidebar entry row (sits next to the New Session family block). */
.dsh-cgtb-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-text-secondary, var(--cgtb-text-2, inherit)); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left; box-sizing: border-box;
}
.dsh-cgtb-entry:hover { background: var(--dsw-hover, var(--cgtb-hover, rgba(128,128,128,.12))); color: var(--dsw-text-primary, var(--cgtb-text, inherit)); }
.dsh-cgtb-entry[data-active="true"] { background: var(--dsw-active, var(--cgtb-active, rgba(128,128,128,.18))); color: var(--dsw-text-primary, var(--cgtb-text, inherit)); font-weight: 500; }
.dsh-cgtb-entry-icon { display: inline-flex; flex: none; color: var(--cgtb-st-todo, #5b8cff); }
.dsh-cgtb-entry-label { flex: none; }
.dsh-cgtb-entry-stats { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--cgtb-text-3, gray); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-cgtb-entry-badge { color: var(--cgtb-st-todo, #5b8cff); }
.dsh-cgtb-entry-badge[data-kind="attention"] { color: var(--cgtb-st-review, #c058e6); }
[data-sidebar-collapsed] [data-dsh-cgtb-entry],
[class*="_collapsed"] [data-dsh-cgtb-entry] {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0;
  justify-content: center; gap: 0; text-align: center;
}
[data-sidebar-collapsed] [data-dsh-cgtb-entry] .dsh-cgtb-entry-label,
[data-sidebar-collapsed] [data-dsh-cgtb-entry] .dsh-cgtb-entry-stats,
[class*="_collapsed"] [data-dsh-cgtb-entry] .dsh-cgtb-entry-label,
[class*="_collapsed"] [data-dsh-cgtb-entry] .dsh-cgtb-entry-stats { display: none; }

/* Triple-generation center-column coverage (dev pane / layout centerCol /
   DSH Desktop conversation surface). The board container is a trailing
   child the shell never manages; when open its siblings are hidden. */
html[data-dsh-cgtb-open] [data-pane="conversation"] > *:not([data-dsh-cgtb-view]),
html[data-dsh-cgtb-open] [class*="centerCol"] > *:not([data-dsh-cgtb-view]),
html[data-dsh-cgtb-open] .dshDesktopConversationSurface > *:not([data-dsh-cgtb-view]) { display: none !important; }
.dsh-cgtb-view { display: none; }
html[data-dsh-cgtb-open] .dsh-cgtb-view { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }

.dsh-cgtb-board { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; padding: 10px 14px; box-sizing: border-box; color: var(--cgtb-text, inherit); font-size: 13px; }
.dsh-cgtb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 0; }
.dsh-cgtb-title { font-size: 15px; font-weight: 600; margin: 0; }
.dsh-cgtb-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--cgtb-text-3, gray); }
.dsh-cgtb-live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--cgtb-ok, #3fb06b); }
.dsh-cgtb-live[data-state="down"]::before { background: var(--cgtb-danger, #e25563); }
.dsh-cgtb-live[data-state="down"] { color: var(--cgtb-danger, #e25563); }
.dsh-cgtb-spacer { flex: 1 1 8px; }
.dsh-cgtb-btn {
  display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--cgtb-border, rgba(128,128,128,.25));
  background: var(--cgtb-panel, transparent); color: var(--cgtb-text, inherit);
  border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.dsh-cgtb-btn:hover { background: var(--cgtb-hover, rgba(128,128,128,.12)); }
.dsh-cgtb-btn[disabled] { opacity: .55; cursor: default; }
.dsh-cgtb-btn[data-kind="primary"] { background: color-mix(in srgb, var(--cgtb-st-todo, #5b8cff) 16%, transparent); border-color: color-mix(in srgb, var(--cgtb-st-todo, #5b8cff) 45%, transparent); }
.dsh-cgtb-btn[data-kind="danger"] { color: var(--cgtb-danger, #e25563); border-color: color-mix(in srgb, var(--cgtb-danger, #e25563) 45%, transparent); background: color-mix(in srgb, var(--cgtb-danger, #e25563) 12%, transparent); }
.dsh-cgtb-btn[data-kind="ok"] { color: var(--cgtb-ok, #3fb06b); border-color: color-mix(in srgb, var(--cgtb-ok, #3fb06b) 45%, transparent); background: color-mix(in srgb, var(--cgtb-ok, #3fb06b) 12%, transparent); }
.dsh-cgtb-btn[data-kind="ghost"] { border-color: transparent; background: transparent; }

/* Toolbar controls (search / workspace filter / show-canceled). */
.dsh-cgtb-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-cgtb-search {
  width: 180px; box-sizing: border-box; padding: 5px 9px; border-radius: 8px;
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.3)); background: var(--cgtb-input, transparent);
  color: var(--cgtb-text, inherit); font: inherit; font-size: 12.5px;
}
.dsh-cgtb-search:focus, .dsh-cgtb-select:focus { outline: none; border-color: var(--cgtb-focus, #5b8cff); }
.dsh-cgtb-select {
  box-sizing: border-box; padding: 5px 8px; border-radius: 8px; max-width: 200px;
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.3)); background: var(--cgtb-input, transparent);
  color: var(--cgtb-text, inherit); font: inherit; font-size: 12.5px;
}
.dsh-cgtb-select option { color: initial; background: #fff; }
.dsh-cgtb-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--cgtb-text-2, gray); cursor: pointer; user-select: none; }

/* Board columns and cards. */
.dsh-cgtb-columns { display: flex; gap: 10px; flex: 1 1 auto; min-height: 0; overflow-x: auto; padding-bottom: 2px; }
.dsh-cgtb-column { display: flex; flex-direction: column; flex: 1 1 0; min-width: 230px; max-width: 340px; min-height: 0; background: var(--cgtb-panel, rgba(128,128,128,.06)); border: 1px solid var(--cgtb-border, rgba(128,128,128,.12)); border-radius: 12px; overflow: hidden; }
.dsh-cgtb-col-head { display: flex; align-items: center; gap: 7px; padding: 9px 12px 7px; font-weight: 600; font-size: 12.5px; }
.dsh-cgtb-col-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cgtb-st-todo, #5b8cff); }
.dsh-cgtb-col-dot[data-column="inProgress"] { background: var(--cgtb-st-running, #e0863a); }
.dsh-cgtb-col-dot[data-column="attention"] { background: var(--cgtb-st-review, #c058e6); }
.dsh-cgtb-col-dot[data-column="done"] { background: var(--cgtb-st-done, #3fb06b); }
.dsh-cgtb-col-count { margin-left: auto; font-weight: 400; font-size: 11px; color: var(--cgtb-text-3, gray); font-variant-numeric: tabular-nums; }
.dsh-cgtb-cards { display: flex; flex-direction: column; gap: 7px; padding: 4px 9px 10px; overflow-y: auto; min-height: 0; }
.dsh-cgtb-card {
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.14)); border-left: 3px solid var(--cgtb-st-todo, #5b8cff);
  background: var(--cgtb-panel-2, rgba(128,128,128,.08)); border-radius: 10px; padding: 8px 10px; cursor: pointer;
  display: flex; flex-direction: column; gap: 6px; text-align: left; color: inherit; font: inherit;
}
.dsh-cgtb-card:hover { border-color: var(--cgtb-active, rgba(128,128,128,.3)); }
.dsh-cgtb-card[data-status="queued"] { border-left-color: var(--cgtb-st-queued, #7f8fa4); }
.dsh-cgtb-card[data-status="preparing"] { border-left-color: var(--cgtb-st-preparing, #e0a13c); }
.dsh-cgtb-card[data-status="running"] { border-left-color: var(--cgtb-st-running, #e0863a); }
.dsh-cgtb-card[data-status="awaiting_input"] { border-left-color: var(--cgtb-st-awaiting_input, #a06ce0); }
.dsh-cgtb-card[data-status="review"] { border-left-color: var(--cgtb-st-review, #c058e6); }
.dsh-cgtb-card[data-status="merging"] { border-left-color: var(--cgtb-st-merging, #2bb3a3); }
.dsh-cgtb-card[data-status="failed"] { border-left-color: var(--cgtb-st-failed, #e25563); }
.dsh-cgtb-card[data-status="done"] { border-left-color: var(--cgtb-st-done, #3fb06b); }
.dsh-cgtb-card[data-status="canceled"] { border-left-color: var(--cgtb-st-canceled, #7f8fa4); }
.dsh-cgtb-card-title { font-weight: 500; font-size: 13px; line-height: 1.35; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dsh-cgtb-card-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 11px; color: var(--cgtb-text-2, gray); }
.dsh-cgtb-chip { display: inline-flex; align-items: center; gap: 3px; border-radius: 5px; padding: 1px 6px; font-size: 10.5px; line-height: 1.6; border: 1px solid transparent; }
.dsh-cgtb-chip[data-kind="status"] { color: var(--cgtb-st-todo, #5b8cff); background: color-mix(in srgb, var(--cgtb-st-todo, #5b8cff) 14%, transparent); }
.dsh-cgtb-chip[data-kind="ws"] { color: var(--cgtb-text-2, gray); background: var(--cgtb-hover, rgba(128,128,128,.1)); }
.dsh-cgtb-chip[data-kind="claim"] { color: var(--cgtb-st-preparing, #e0a13c); }
.dsh-cgtb-chip[data-kind="note"] { color: var(--cgtb-text-3, gray); }
.dsh-cgtb-card-time { margin-left: auto; color: var(--cgtb-text-3, gray); white-space: nowrap; }
.dsh-cgtb-empty { padding: 16px 6px; text-align: center; color: var(--cgtb-text-3, gray); font-size: 12px; }

/* Modal + toast overlays. */
.dsh-cgtb-modal-backdrop {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(5,8,14,.55); backdrop-filter: blur(2px);
}
.dsh-cgtb-modal {
  display: flex; flex-direction: column; width: min(660px, calc(100vw - 32px)); max-height: min(86vh, 860px);
  background: var(--cgtb-bg, #15181e); color: var(--cgtb-text, inherit);
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.25)); border-radius: 14px;
  box-shadow: var(--cgtb-shadow, 0 12px 34px rgba(0,0,0,.5)); overflow: hidden; font-size: 13px;
}
.dsh-cgtb-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--cgtb-border, rgba(128,128,128,.15)); }
.dsh-cgtb-modal-title { font-size: 14.5px; font-weight: 600; margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cgtb-modal-close { margin-left: auto; }
.dsh-cgtb-modal-body { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.dsh-cgtb-modal-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 11px 16px; border-top: 1px solid var(--cgtb-border, rgba(128,128,128,.15)); }
.dsh-cgtb-field { display: flex; flex-direction: column; gap: 5px; }
.dsh-cgtb-field > label { font-size: 12px; color: var(--cgtb-text-2, gray); }
.dsh-cgtb-input, .dsh-cgtb-textarea {
  width: 100%; box-sizing: border-box; border-radius: 9px; padding: 7px 10px;
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.3)); background: var(--cgtb-input, transparent);
  color: var(--cgtb-text, inherit); font: inherit; font-size: 13px;
}
.dsh-cgtb-input:focus, .dsh-cgtb-textarea:focus { outline: none; border-color: var(--cgtb-focus, #5b8cff); }
.dsh-cgtb-textarea { resize: vertical; min-height: 64px; line-height: 1.5; }
.dsh-cgtb-input[disabled], .dsh-cgtb-textarea[disabled] { opacity: .55; }
.dsh-cgtb-kv { display: grid; grid-template-columns: 84px 1fr; gap: 6px 10px; align-items: baseline; font-size: 12.5px; }
.dsh-cgtb-kv dt { color: var(--cgtb-text-3, gray); }
.dsh-cgtb-kv dd { margin: 0; word-break: break-word; white-space: pre-wrap; line-height: 1.5; }
.dsh-cgtb-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
.dsh-cgtb-section-title { font-size: 12px; font-weight: 600; color: var(--cgtb-text-2, gray); margin: 2px 0 0; }
.dsh-cgtb-comments { display: flex; flex-direction: column; gap: 8px; }
.dsh-cgtb-comment { border: 1px solid var(--cgtb-border, rgba(128,128,128,.12)); border-radius: 10px; padding: 8px 10px; background: var(--cgtb-panel, rgba(128,128,128,.05)); }
.dsh-cgtb-comment-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--cgtb-text-3, gray); margin-bottom: 4px; }
.dsh-cgtb-comment-body { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.dsh-cgtb-composer { display: flex; flex-direction: column; gap: 6px; }
.dsh-cgtb-toast-wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.dsh-cgtb-toast {
  max-width: 360px; border-radius: 10px; padding: 9px 13px; font-size: 12.5px; line-height: 1.45;
  background: var(--cgtb-panel-2, #262b35); color: var(--cgtb-text, inherit);
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.3)); box-shadow: var(--cgtb-shadow, 0 8px 24px rgba(0,0,0,.4));
  pointer-events: auto; white-space: pre-wrap; word-break: break-word;
}
.dsh-cgtb-toast[data-kind="error"] { border-color: color-mix(in srgb, var(--cgtb-danger, #e25563) 55%, transparent); }
.dsh-cgtb-toast[data-kind="success"] { border-color: color-mix(in srgb, var(--cgtb-ok, #3fb06b) 55%, transparent); }
@media (prefers-reduced-motion: reduce) { .dsh-cgtb-card, .dsh-cgtb-btn, .dsh-cgtb-toast { transition: none !important; animation: none !important; } }

/* Task detail modal (openDetail): title / pre blocks / composer row. */
.dsh-cgtb-detail-title { font-size: 15px; font-weight: 600; line-height: 1.45; word-break: break-word; }
.dsh-cgtb-pre {
  white-space: pre-wrap; word-break: break-word; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12.5px; margin: 0;
  background: var(--cgtb-input, rgba(128,128,128,.06));
  border: 1px solid var(--cgtb-border, rgba(128,128,128,.14));
  border-radius: 9px; padding: 8px 10px;
}
.dsh-cgtb-muted { color: var(--cgtb-text-3, gray); font-size: 12px; }
.dsh-cgtb-composer-row { display: flex; align-items: center; gap: 8px; }
.dsh-cgtb-move { display: inline-flex; align-items: center; gap: 6px; }
`

  /** Inject the stylesheet once; re-inject when a reload drops it. */
  function injectStyles() {
    if (typeof document === 'undefined') return
    let style = document.getElementById(STYLE_ID)
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      document.head.append(style)
    }
  }

  // ------------------------------------------------------------- board model
  const PANEL_NAME = 'dsh-plugin-taskboard'
  const ACTIVATE_EVENT = 'dsh-panel-activate'
  const OPEN_ATTR = 'data-dsh-cgtb-open'
  const ENTRY_SELECTOR = '[data-dsh-cgtb-entry]'
  const CONVERSATION_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
  const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
  const OTHER_OPEN_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-atb-active', 'data-dsh-ssh-active']
  const HOLD_STATUSES = ['preparing', 'running', 'awaiting_input', 'merging']
  const COLUMN_MEMBERS = {
    todo: ['todo', 'queued'],
    inProgress: ['preparing', 'running'],
    attention: ['awaiting_input', 'review', 'merging', 'failed'],
    done: ['done', 'canceled'],
  }
  const ALL_STATUSES = ['todo', 'queued', 'preparing', 'running', 'awaiting_input', 'review', 'merging', 'failed', 'done', 'canceled']

  const model = {
    open: false,
    revision: 0,
    hydrated: false,
    tasks: new Map(),
    workspaces: [],
    wsFilter: 'ALL',
    search: '',
    showCanceled: false,
    connected: false,
    lastSync: 0,
  }
  const listeners = new Set()
  function emit() {
    for (const fn of [...listeners]) {
      try { fn() } catch (error) { console.warn('[dsh-plugin-taskboard] listener threw:', error?.message ?? error) }
    }
  }

  /** Compact card shape shared by full records and SSE summaries. */
  function toSummary(task) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      version: task.version,
      workspaceId: task.workspaceId ?? '',
      claimedBy: typeof task.claimedBy === 'string' ? task.claimedBy : undefined,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    }
  }
  function applyLedger(ledger) {
    model.revision = typeof ledger.revision === 'number' ? ledger.revision : 0
    model.tasks.clear()
    for (const task of Array.isArray(ledger.tasks) ? ledger.tasks : []) {
      if (task === null || typeof task !== 'object' || task.id === undefined) continue
      model.tasks.set(task.id, toSummary(task))
    }
    model.hydrated = true
    model.lastSync = Date.now()
    emit()
  }
  function applyChange(frame) {
    if (frame === null || typeof frame !== 'object') return
    if (typeof frame.revision === 'number') model.revision = frame.revision
    for (const summary of Array.isArray(frame.tasks) ? frame.tasks : []) {
      if (summary === null || typeof summary !== 'object' || summary.id === undefined) continue
      if (frame.kind === 'task-deleted') model.tasks.delete(summary.id)
      else model.tasks.set(summary.id, toSummary(summary))
    }
    model.lastSync = Date.now()
    emit()
  }
  function applyTaskFull(task) {
    if (task === null || typeof task !== 'object' || task.id === undefined) return
    model.tasks.set(task.id, toSummary(task))
    model.lastSync = Date.now()
    emit()
  }

  async function refresh() {
    try {
      const ledger = await api.state()
      // The host reports the shell's language; it outranks the boot seed.
      setLang(ledger.language)
      applyLedger(ledger)
      model.connected = true
    } catch (error) {
      model.connected = false
      toast(t('toast.syncFailed', String(error?.message ?? error)))
    }
    emit()
  }
  async function loadWorkspaces() {
    try {
      const rows = await api.workspaces()
      model.workspaces = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []
    } catch (error) {
      console.warn('[dsh-plugin-taskboard] workspace list unavailable:', error?.message ?? error)
    }
    emit()
  }

  // ------------------------------------------------------------------ toast
  let toastWrap = null
  function toast(message, kind = 'error', timeoutMs = 3600) {
    if (typeof document === 'undefined') return
    if (toastWrap === null || !toastWrap.isConnected) {
      toastWrap = el('div', { class: 'dsh-cgtb-toast-wrap' })
      document.body.append(toastWrap)
    }
    const item = el('div', { class: 'dsh-cgtb-toast', 'data-kind': kind }, String(message))
    toastWrap.append(item)
    setTimeout(() => { try { item.remove() } catch { /* gone */ } }, timeoutMs)
  }

  // ------------------------------------------------------------ derived ui
  function userMoveTargets(status) {
    if (status === 'done' || status === 'canceled') return ['todo']
    return ALL_STATUSES.filter((candidate) => candidate !== status && candidate !== 'merging')
  }
  function isDeletable(status) {
    return !HOLD_STATUSES.includes(status) && status !== 'review'
  }
  function wsLabel(id) {
    if (typeof id !== 'string' || id === '') return ''
    const row = model.workspaces.find((workspace) => workspace.id === id)
    return row === undefined ? id : (row.title ?? row.path ?? row.id)
  }
  function boardCounts() {
    let todo = 0
    let attention = 0
    let review = 0
    for (const task of model.tasks.values()) {
      if (task.status === 'done' || task.status === 'canceled') continue
      if (task.status === 'review') review++
      const column = columnOf(task.status)
      if (column === 'todo') todo++
      else if (column === 'attention') attention++
    }
    return { todo, attention, review }
  }
  function statusColor(status) {
    const colors = {
      todo: 'var(--cgtb-st-todo, #5b8cff)', queued: 'var(--cgtb-st-queued, #7f8fa4)',
      preparing: 'var(--cgtb-st-preparing, #e0a13c)', running: 'var(--cgtb-st-running, #e0863a)',
      awaiting_input: 'var(--cgtb-st-awaiting_input, #a06ce0)', review: 'var(--cgtb-st-review, #c058e6)',
      merging: 'var(--cgtb-st-merging, #2bb3a3)', failed: 'var(--cgtb-st-failed, #e25563)',
      done: 'var(--cgtb-st-done, #3fb06b)', canceled: 'var(--cgtb-st-canceled, #7f8fa4)',
    }
    return colors[status] ?? colors.todo
  }

  // -------------------------------------------------------------------- sse
  let sse = null
  function startSse() {
    stopSse()
    if (typeof EventSource === 'undefined') return
    let source
    try { source = new EventSource(SSE_PATH) } catch (error) {
      console.warn('[dsh-plugin-taskboard] EventSource failed:', error?.message ?? error)
      return
    }
    sse = source
    source.addEventListener('open', () => { model.connected = true; emit() })
    source.addEventListener('error', () => { model.connected = false; emit() })
    source.addEventListener('hello', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (typeof data.revision === 'number' && data.revision > model.revision) void refresh()
      } catch { /* malformed frame; full refresh stays safe */ }
    })
    source.addEventListener('change', (event) => {
      try { applyChange(JSON.parse(event.data)) } catch { void refresh() }
    })
  }
  function stopSse() {
    if (sse !== null) {
      try { sse.close() } catch { /* already closed */ }
      sse = null
    }
  }

  // ------------------------------------------------------- open / close
  function setOpen(open) {
    if (model.open === open) return
    model.open = open
    const rootEl = document.documentElement
    if (open) {
      for (const attr of OTHER_OPEN_ATTRS) rootEl.removeAttribute(attr)
      rootEl.setAttribute(OPEN_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      rootEl.removeAttribute(OPEN_ATTR)
    }
    emit()
  }

  // ------------------------------------------------------------ dom seats
  let entry = null
  let view = null
  let liveEl = null
  let searchInput = null
  let wsSelect = null
  let cancelCheck = null
  let columnsEl = null

  function sidebarRoot() {
    const column = document.querySelector(SIDEBAR_SELECTOR)
    if (column === null) return undefined
    const logoRow = column.querySelector('[class*="logoRow"]')
    return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) ?? undefined
  }
  function conversationColumn() {
    const column = document.querySelector(CONVERSATION_SELECTOR)
    return column === null ? undefined : column
  }

  function createEntry() {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshCgtbEntry = ''
    button.className = 'dsh-cgtb-entry'
    button.setAttribute('aria-label', t('board.title'))
    button.innerHTML =
      '<span class="dsh-cgtb-entry-icon">📋</span>' +
      '<span class="dsh-cgtb-entry-label"></span>' +
      '<span class="dsh-cgtb-entry-stats"></span>'
    button.addEventListener('click', () => setOpen(!model.open))
    return button
  }

  /** Insert the sidebar entry next to the New Session row/family block. */
  function placeEntry() {
    if (entry === null) return false
    const root = sidebarRoot()
    if (root === undefined || !root.isConnected) return false
    if (entry.parentElement === root && root.contains(entry)) return true
    const nested = root.querySelector('button[class*="newSession"]')
    const row = nested !== null && nested.parentElement !== null
      ? (nested.parentElement === root ? nested : nested.closest('[class*="logoRow"]'))
      : null
    const family = Array.from(root.children).filter((child) =>
      child instanceof HTMLElement && child.matches(ENTRY_SELECTOR + ', [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'))
    if (family.length > 0) {
      root.insertBefore(entry, family[0])
      return true
    }
    if (row !== null) {
      root.insertBefore(entry, row.nextElementSibling)
      return true
    }
    root.append(entry)
    return true
  }

  /** Attach (or re-attach) the board view container as a trailing child. */
  function ensureView() {
    const column = conversationColumn()
    if (column === undefined) return
    if (view === null || !view.isConnected) {
      if (view !== null) view.remove()
      view = el('div', { class: 'dsh-cgtb-view', 'data-dsh-cgtb-view': '' })
    }
    if (view.parentElement !== column) column.append(view)
  }

  function buildBoardDom() {
    const title = el('h2', { class: 'dsh-cgtb-title' }, t('board.title'))
    liveEl = el('span', { class: 'dsh-cgtb-live', 'data-state': 'down' }, t('board.connecting'))
    const refreshBtn = el('button', { class: 'dsh-cgtb-btn', type: 'button', onClick: () => { void refresh(); void loadWorkspaces() } }, t('board.refresh'))
    const newTaskBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'primary', type: 'button', onClick: () => openCreate(null) }, t('board.newTask'))
    const closeBtn = el('button', { class: 'dsh-cgtb-btn', type: 'button', onClick: () => setOpen(false) }, '✕')
    const toolbar = el('div', { class: 'dsh-cgtb-toolbar' },
      title, liveEl, el('span', { class: 'dsh-cgtb-spacer' }), refreshBtn, newTaskBtn, closeBtn)

    searchInput = el('input', {
      class: 'dsh-cgtb-search', type: 'search', placeholder: t('board.searchPlaceholder'),
      onInput: () => { model.search = searchInput.value.trim(); renderColumns() },
    })
    wsSelect = el('select', {
      class: 'dsh-cgtb-select',
      onChange: () => { model.wsFilter = wsSelect.value; renderColumns() },
    })
    cancelCheck = el('input', {
      type: 'checkbox',
      onChange: () => { model.showCanceled = cancelCheck.checked; renderColumns() },
    })
    const controls = el('div', { class: 'dsh-cgtb-controls' },
      searchInput, wsSelect,
      el('label', { class: 'dsh-cgtb-check' }, cancelCheck, t('board.showCanceled')))
    columnsEl = el('div', { class: 'dsh-cgtb-columns' })
    view.append(el('div', { class: 'dsh-cgtb-board' }, toolbar, controls, columnsEl))
  }

  /** Re-create the board chrome after a language switch (same DOM shape). */
  function rebuildBoard() {
    if (view === null || !view.isConnected) return
    view.textContent = ''
    liveEl = null
    searchInput = null
    wsSelect = null
    cancelCheck = null
    columnsEl = null
    wsOptionsSignature = null
    buildBoardDom()
    searchInput.value = model.search
    cancelCheck.checked = model.showCanceled
  }

  function renderEntry() {
    if (entry === null) return
    if (model.open) entry.dataset.active = 'true'
    else delete entry.dataset.active
    entry.setAttribute('aria-label', t('board.title'))
    const label = entry.querySelector('.dsh-cgtb-entry-label')
    if (label !== null) label.textContent = t('board.title')
    const stats = entry.querySelector('.dsh-cgtb-entry-stats')
    if (stats === null) return
    const counts = boardCounts()
    stats.textContent = counts.todo + ' · ' + counts.attention + (counts.review > 0 ? ' · ' + counts.review : '')
    stats.title = t('entry.stats', counts)
  }

  // ------------------------------------------------------------ rendering
  let modelListenerBound = false
  function modelListener() {
    renderEntry()
    renderLiveIndicator()
    renderWorkspaces()
    renderColumns()
  }
  function bindModelListener() {
    if (modelListenerBound) return
    modelListenerBound = true
    listeners.add(modelListener)
  }
  function unbindModelListener() {
    if (!modelListenerBound) return
    modelListenerBound = false
    listeners.delete(modelListener)
  }

  /** Board rows honouring the search / workspace / canceled filters. */
  function filteredTasks() {
    const term = model.search.toLowerCase()
    const rows = []
    for (const task of model.tasks.values()) {
      if (task.status === 'canceled' && !model.showCanceled) continue
      if (model.wsFilter !== 'ALL' && task.workspaceId !== model.wsFilter) continue
      if (term.length > 0) {
        const hay = String(task.title ?? '') + '\n' + String(task.id ?? '')
        if (!hay.toLowerCase().includes(term)) continue
      }
      rows.push(task)
    }
    return rows.sort(byFreshest)
  }

  /** One compact task card button (title, status/ws/claim/comment chips). */
  function cardFor(task) {
    const color = statusColor(task.status)
    const statusChip = el('span', { class: 'dsh-cgtb-chip', 'data-kind': 'status' }, statusLabel(task.status))
    statusChip.style.color = color
    statusChip.style.backgroundColor = 'color-mix(in srgb, ' + color + ' 14%, transparent)'
    const meta = el('div', { class: 'dsh-cgtb-card-meta' }, statusChip)
    if (task.workspaceId !== undefined && task.workspaceId !== '') {
      meta.append(el('span', { class: 'dsh-cgtb-chip', 'data-kind': 'ws' }, wsLabel(task.workspaceId)))
    }
    if (task.claimedBy !== undefined) {
      meta.append(el('span', { class: 'dsh-cgtb-chip', 'data-kind': 'claim' }, '⏳ ' + String(task.claimedBy).slice(0, 12)))
    }
    if (typeof task.commentCount === 'number' && task.commentCount > 0) {
      meta.append(el('span', { class: 'dsh-cgtb-chip', 'data-kind': 'note' }, '💬 ' + task.commentCount))
    }
    meta.append(el('span', { class: 'dsh-cgtb-card-time' }, fmtTime(task.updatedAt)))
    return el('button', {
      class: 'dsh-cgtb-card', type: 'button', 'data-status': task.status,
      onClick: () => openDetail(task.id),
    }, el('div', { class: 'dsh-cgtb-card-title' }, String(task.title ?? t('board.untitled'))), meta)
  }

  function renderColumns() {
    if (columnsEl === null) return
    const buckets = { todo: [], inProgress: [], attention: [], done: [] }
    for (const task of filteredTasks()) buckets[columnOf(task.status)].push(task)
    columnsEl.textContent = ''
    for (const column of COLUMNS) {
      const list = buckets[column]
      const head = el('div', { class: 'dsh-cgtb-col-head' },
        el('span', { class: 'dsh-cgtb-col-dot', 'data-column': column }),
        columnLabel(column),
        el('span', { class: 'dsh-cgtb-col-count' }, String(list.length)))
      const cards = el('div', { class: 'dsh-cgtb-cards' })
      if (list.length === 0) cards.append(el('div', { class: 'dsh-cgtb-empty' }, t('board.noTasks')))
      else for (const task of list) cards.append(cardFor(task))
      columnsEl.append(el('section', { class: 'dsh-cgtb-column' }, head, cards))
    }
  }

  let wsOptionsSignature = null
  function renderWorkspaces() {
    if (wsSelect === null) return
    const signature = model.workspaces.map((w) => w.id + ':' + (w.title ?? w.path ?? '')).join('|')
    if (signature !== wsOptionsSignature) {
      wsOptionsSignature = signature
      wsSelect.textContent = ''
      wsSelect.append(el('option', { value: 'ALL' }, t('board.allProjects')))
      wsSelect.append(el('option', { value: '' }, t('board.noProject')))
      for (const workspace of model.workspaces) {
        wsSelect.append(el('option', { value: workspace.id }, String(workspace.title ?? workspace.path ?? workspace.id)))
      }
    }
    const available = model.wsFilter === 'ALL' || model.wsFilter === '' ||
      model.workspaces.some((workspace) => workspace.id === model.wsFilter)
    if (!available) model.wsFilter = 'ALL'
    if (wsSelect.value !== model.wsFilter) wsSelect.value = model.wsFilter
  }

  function renderLiveIndicator() {
    if (liveEl === null) return
    liveEl.dataset.state = model.connected ? 'up' : 'down'
    liveEl.textContent = model.connected ? t('board.live') : t('board.offline')
  }

  async function refreshAll() {
    await Promise.allSettled([refresh(), loadWorkspaces()])
  }

  // ----------------------------------------------------------- modals
  let detailFrame = null
  const modalStack = []

  /** Build a modal shell (backdrop / head / body / foot); stackable. */
  function openModalFrame(titleText) {
    const backdrop = el('div', { class: 'dsh-cgtb-modal-backdrop' })
    const bodyEl = el('div', { class: 'dsh-cgtb-modal-body' })
    const footEl = el('div', { class: 'dsh-cgtb-modal-foot' })
    const closeBtn = el('button', { class: 'dsh-cgtb-btn dsh-cgtb-modal-close', type: 'button', 'aria-label': t('modal.close') }, '✕')
    const modal = el('div', { class: 'dsh-cgtb-modal' },
      el('div', { class: 'dsh-cgtb-modal-head' }, el('h3', { class: 'dsh-cgtb-modal-title' }, String(titleText)), closeBtn),
      bodyEl, footEl)
    backdrop.append(modal)
    document.body.append(backdrop)
    let closed = false
    const frame = { close, body: bodyEl, foot: footEl }
    function close() {
      if (closed) return
      closed = true
      const at = modalStack.indexOf(frame)
      if (at >= 0) modalStack.splice(at, 1)
      document.removeEventListener('keydown', onKey)
      if (backdrop.isConnected) backdrop.remove()
      if (detailFrame === frame) detailFrame = null
    }
    const onKey = (event) => {
      if (event.key === 'Escape' && modalStack[modalStack.length - 1] === frame) close()
    }
    document.addEventListener('keydown', onKey)
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })
    closeBtn.addEventListener('click', close)
    modalStack.push(frame)
    return frame
  }

  function askConfirm(message) {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message) === true
    }
    return true
  }

  function isConflictError(error) {
    return /version_conflict|not_found/.test(String(error?.message ?? error))
  }

  function friendlyWriteError(label, error) {
    const raw = String(error?.message ?? error)
    if (raw.includes('version_conflict')) return t('result.stale', label)
    if (raw.includes('not_found')) return t('result.gone', label)
    if (raw.includes('forbidden')) return t('result.forbidden', label)
    if (raw.includes('invalid_transition')) return t('result.transition', label)
    if (raw.includes('invalid_input')) {
      return t('result.invalid', { label, detail: raw.replace(/^Error:\s*invalid_input:\s*/i, '') })
    }
    return t('result.failed', { label, detail: raw })
  }

  function workspaceOptions(selectedId) {
    const options = [el('option', { value: '' }, t('board.noProject'))]
    for (const workspace of model.workspaces) {
      options.push(el('option', { value: workspace.id }, String(workspace.title ?? workspace.path ?? workspace.id)))
    }
    return options
  }

  /** Create (initial === null) or edit an existing full task record. */
  function openCreate(initial, onSaved) {
    const isEdit = initial !== null && initial !== undefined
    const frame = openModalFrame(isEdit ? t('form.editTitle') : t('form.newTitle'))
    const titleInput = el('input', {
      class: 'dsh-cgtb-input', type: 'text', maxlength: '200',
      placeholder: t('form.titlePlaceholder'),
      value: isEdit ? String(initial.title ?? '') : '',
    })
    const descInput = textArea({
      class: 'dsh-cgtb-input dsh-cgtb-textarea', rows: 3,
      placeholder: t('form.descPlaceholder'),
      value: isEdit ? String(initial.description ?? '') : '',
    })
    const promptInput = textArea({
      class: 'dsh-cgtb-input dsh-cgtb-textarea', rows: 4,
      placeholder: t('form.promptPlaceholder'),
      value: isEdit ? String(initial.prompt ?? '') : '',
    })
    const wsField = el('select', { class: 'dsh-cgtb-select' }, workspaceOptions(isEdit ? (initial.workspaceId ?? '') : ''))
    frame.body.append(
      el('div', { class: 'dsh-cgtb-field' }, el('label', {}, t('form.title')), titleInput),
      el('div', { class: 'dsh-cgtb-field' }, el('label', {}, t('form.description')), descInput),
      el('div', { class: 'dsh-cgtb-field' }, el('label', {}, t('form.prompt')), promptInput),
      el('div', { class: 'dsh-cgtb-field' }, el('label', {}, t('form.project')), wsField),
    )
    const cancelBtn = el('button', { class: 'dsh-cgtb-btn', type: 'button' }, t('form.cancel'))
    const submitBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'primary', type: 'button' }, isEdit ? t('form.save') : t('form.create'))
    cancelBtn.addEventListener('click', () => frame.close())
    frame.foot.append(cancelBtn, submitBtn)
    titleInput.focus()

    async function submit() {
      const cleanTitle = titleInput.value.trim()
      if (cleanTitle.length === 0) {
        toast(t('form.needTitle'))
        titleInput.focus()
        return
      }
      const payload = {
        title: cleanTitle,
        description: descInput.value.trim(),
        prompt: promptInput.value.trim(),
        workspaceId: wsField.value,
      }
      if (isEdit) payload.ifVersion = initial.version
      submitBtn.disabled = true
      submitBtn.textContent = t('form.submitting')
      try {
        const record = isEdit ? await api.update(initial.id, payload) : await api.create(payload)
        if (record !== undefined && record !== null && typeof record === 'object' && record.id !== undefined) {
          applyTaskFull(record)
        }
        toast(isEdit ? t('toast.taskUpdated') : t('toast.taskCreated'), 'success')
        frame.close()
        onSaved?.(record)
      } catch (error) {
        toast(friendlyWriteError(isEdit ? t('action.updateTask') : t('action.createTask'), error))
        submitBtn.disabled = false
        submitBtn.textContent = isEdit ? t('form.save') : t('form.create')
      }
    }
    submitBtn.addEventListener('click', () => { void submit() })
  }

  // ------------------------------------------------------- task detail
  /** Open the full-record detail modal: meta, actions, comments. */
  function openDetail(id, fallback) {
    if (detailFrame !== null) detailFrame.close()
    const frame = openModalFrame(t('detail.title'))
    detailFrame = frame
    const closedRef = { current: false }
    const baseClose = frame.close
    frame.close = function () {
      if (closedRef.current) return
      closedRef.current = true
      listeners.delete(onModelChange)
      baseClose()
    }
    let record = (fallback !== undefined && fallback !== null && fallback.id === id)
      ? Object.assign({}, fallback)
      : null
    let syncing = null
    let busy = false

    const infoEl = el('div', { class: 'dsh-cgtb-detail-info' })
    const notesTitle = el('h4', { class: 'dsh-cgtb-section-title' }, t('detail.notes'))
    const notesList = el('div', { class: 'dsh-cgtb-comments' })
    const composer = textArea({
      class: 'dsh-cgtb-input dsh-cgtb-textarea', rows: 2,
      placeholder: t('detail.notePlaceholder'),
    })
    const sendBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'primary', type: 'button' }, t('detail.send'))
    frame.body.append(
      infoEl,
      notesTitle,
      notesList,
      el('div', { class: 'dsh-cgtb-composer' },
        el('div', { class: 'dsh-cgtb-composer-row' }, composer, sendBtn)),
    )

    function statusChip(status) {
      const chip = el('span', { class: 'dsh-cgtb-chip', 'data-kind': 'status' }, statusLabel(status))
      const color = statusColor(status)
      chip.style.color = color
      chip.style.backgroundColor = 'color-mix(in srgb, ' + color + ' 14%, transparent)'
      return chip
    }

    function textBlock(title, value) {
      const box = el('div', {})
      box.append(el('h4', { class: 'dsh-cgtb-section-title' }, title))
      const text = value === undefined || value === null ? '' : String(value)
      if (text.trim().length === 0) box.append(el('div', { class: 'dsh-cgtb-muted' }, t('detail.none')))
      else box.append(el('pre', { class: 'dsh-cgtb-pre' }, text))
      return box
    }

    function renderAll() {
      infoEl.textContent = ''
      if (record === null) {
        infoEl.append(el('div', { class: 'dsh-cgtb-muted' }, t('detail.loading')))
        renderActions()
        return
      }
      const task = record
      infoEl.append(el('div', { class: 'dsh-cgtb-detail-title' }, String(task.title ?? t('board.untitled'))))
      const dl = el('dl', { class: 'dsh-cgtb-kv' })
      const addRow = (key, value) => {
        dl.append(el('dt', {}, key))
        if (value instanceof Node) dl.append(el('dd', {}, value))
        else dl.append(el('dd', {}, value === undefined || value === null || value === '' ? '—' : String(value)))
      }
      addRow(t('detail.kvStatus'), statusChip(task.status))
      addRow(t('detail.kvTask'), String(task.id).slice(0, 8))
      if (typeof task.workspaceId === 'string' && task.workspaceId !== '') addRow(t('detail.kvProject'), wsLabel(task.workspaceId))
      if (typeof task.claimedBy === 'string' && task.claimedBy !== '') addRow(t('detail.kvClaim'), task.claimedBy)
      addRow(t('detail.kvUpdated'), fmtTime(task.updatedAt))
      addRow(t('detail.kvCreated'), fmtTime(task.createdAt))
      infoEl.append(dl)
      if (task.description !== undefined && task.description !== null && String(task.description).trim() !== '') {
        infoEl.append(textBlock(t('form.description'), task.description))
      }
      if (task.prompt !== undefined && task.prompt !== null && String(task.prompt).trim() !== '') {
        infoEl.append(textBlock(t('form.prompt'), task.prompt))
      }
      renderComments()
      renderActions()
    }

    function renderComments() {
      if (record === null) return
      const list = Array.isArray(record.comments) ? record.comments.slice() : []
      list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      notesTitle.textContent = t('detail.notes') + (list.length > 0 ? ' · ' + String(list.length) : '')
      notesList.textContent = ''
      if (list.length === 0) {
        notesList.append(el('div', { class: 'dsh-cgtb-muted' }, t('detail.noNotes')))
        return
      }
      for (const comment of list) {
        const head = el('div', { class: 'dsh-cgtb-comment-head' },
          el('span', {}, String(actorLabel(comment.actor))),
          el('span', {}, fmtTime(comment.createdAt)))
        notesList.append(el('div', { class: 'dsh-cgtb-comment' },
          head,
          el('div', { class: 'dsh-cgtb-comment-body' }, String(comment.body ?? ''))))
      }
    }

    function setButtonsEnabled(enabled) {
      for (const btn of frame.foot.querySelectorAll('button')) btn.disabled = !enabled
      const sel = frame.foot.querySelector('select')
      if (sel !== null) sel.disabled = !enabled
    }

    function renderActions() {
      frame.foot.textContent = ''
      if (record === null) return
      const current = record.status
      const editBtn = el('button', { class: 'dsh-cgtb-btn', type: 'button' }, t('detail.edit'))
      editBtn.addEventListener('click', () => { void editTask() })
      frame.foot.append(editBtn)
      if (current === 'review') {
        const acceptBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'ok', type: 'button' }, t('detail.accept'))
        acceptBtn.addEventListener('click', () => {
          void act(t('action.accept'), () => api.move(id, { ifVersion: record.version, status: 'done' }))
        })
        const rejectBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'danger', type: 'button' }, t('detail.sendBack'))
        rejectBtn.addEventListener('click', () => { void rejectTask() })
        frame.foot.append(acceptBtn, rejectBtn)
      } else {
        const targets = userMoveTargets(current)
        const select = el('select', { class: 'dsh-cgtb-select' })
        for (const target of targets) select.append(el('option', { value: target }, statusLabel(target)))
        const reopen = current === 'done' || current === 'canceled'
        const moveBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'primary', type: 'button' }, reopen ? t('detail.reopen') : t('detail.move'))
        moveBtn.addEventListener('click', () => {
          const target = select.value
          void act(reopen ? t('action.reopenTask') : t('action.moveTask'),
            () => api.move(id, { ifVersion: record.version, status: target }))
        })
        frame.foot.append(el('label', { class: 'dsh-cgtb-move' }, t('detail.moveTo'), select), moveBtn)
      }
      if (isDeletable(current)) {
        const delBtn = el('button', { class: 'dsh-cgtb-btn', 'data-kind': 'danger', type: 'button' }, t('action.deleteTask'))
        delBtn.addEventListener('click', () => { void deleteTask() })
        frame.foot.append(delBtn)
      }
      const refreshBtn = el('button', { class: 'dsh-cgtb-btn', type: 'button' }, t('board.refresh'))
      refreshBtn.addEventListener('click', () => { void syncFull({ silent: false }) })
      frame.foot.append(refreshBtn)
      if (busy) setButtonsEnabled(false)
    }

    /** Fetch the live full record; never lets the modal go stale. */
    function syncFull(options) {
      if (syncing !== null) return syncing
      const silent = options === undefined || options === null || options.silent !== false
      syncing = api.task(id)
        .then((full) => {
          if (full !== null && typeof full === 'object' && full.id !== undefined) record = full
          if (!closedRef.current) renderAll()
          return full
        })
        .catch((error) => {
          const raw = String((error !== null && error !== undefined && error.message !== undefined) ? error.message : error)
          if (/not_found/.test(raw)) {
            toast(t('toast.taskGone'))
            frame.close()
          } else if (!silent) {
            toast(t('detail.refreshFailed', raw))
          }
          return null
        })
        .finally(() => { syncing = null })
      return syncing
    }

    function act(label, fn) {
      if (busy || record === null) return Promise.resolve()
      busy = true
      setButtonsEnabled(false)
      sendBtn.disabled = true
      return Promise.resolve()
        .then(fn)
        .then((result) => {
          if (result !== null && typeof result === 'object' &&
              result.id === id && typeof result.status === 'string') {
            record = result
            applyTaskFull(result)
          }
          toast(t('result.ok', label), 'success')
        })
        .catch((error) => {
          toast(friendlyWriteError(label, error))
          if (isConflictError(error)) return syncFull({ silent: true })
          return null
        })
        .finally(() => {
          busy = false
          sendBtn.disabled = false
          if (!closedRef.current) renderAll()
        })
    }

    async function editTask() {
      if (record === null || busy) return
      try {
        await syncFull({ silent: true })
      } catch (error) { return }
      if (closedRef.current || record === null) return
      openCreate(record, (updated) => {
        if (closedRef.current) return
        record = updated
        renderAll()
      })
    }

    async function rejectTask() {
      if (record === null || busy) return
      const ok = askConfirm(t('confirm.sendBack'))
      if (!ok) return
      busy = true
      setButtonsEnabled(false)
      sendBtn.disabled = true
      try {
        const result = await api.reject(id, { ifVersion: record.version })
        if (result !== null && typeof result === 'object' &&
            result.id === id && typeof result.status === 'string') {
          record = result
          applyTaskFull(result)
        }
        toast(t('toast.sentBack'), 'success')
      } catch (error) {
        toast(friendlyWriteError(t('action.rejectTask'), error))
        if (isConflictError(error)) await syncFull({ silent: true })
      } finally {
        busy = false
        sendBtn.disabled = false
        if (!closedRef.current) renderAll()
      }
    }

    async function deleteTask() {
      if (record === null || busy) return
      const ok = askConfirm(t('confirm.delete'))
      if (!ok) return
      busy = true
      setButtonsEnabled(false)
      sendBtn.disabled = true
      try {
        await api.remove(id, { ifVersion: record.version })
        model.tasks.delete(id)
        emit()
        toast(t('toast.taskDeleted'), 'success')
        frame.close()
      } catch (error) {
        toast(friendlyWriteError(t('action.deleteTask'), error))
        if (isConflictError(error)) await syncFull({ silent: true })
      } finally {
        busy = false
        sendBtn.disabled = false
        if (!closedRef.current) renderAll()
      }
    }

    async function sendComment() {
      const text = composer.value.trim()
      if (text.length === 0) {
        toast(t('toast.noteEmpty'))
        composer.focus()
        return
      }
      if (busy) return
      busy = true
      sendBtn.disabled = true
      try {
        const result = await api.comment(id, text)
        composer.value = ''
        if (result !== null && typeof result === 'object' &&
            result.id === id && typeof result.status === 'string') {
          record = result
          applyTaskFull(result)
        }
        toast(t('toast.noteSent'), 'success')
      } catch (error) {
        toast(friendlyWriteError(t('action.sendNote'), error))
      } finally {
        busy = false
        sendBtn.disabled = false
        if (!closedRef.current) {
          renderAll()
          composer.focus()
        }
      }
    }

    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void sendComment()
      }
    })
    sendBtn.addEventListener('click', () => { void sendComment() })

    function onModelChange() {
      if (closedRef.current || busy || record === null) return
      const active = document.activeElement
      if (active !== null && active instanceof Node && active !== document.body &&
          (frame.body.contains(active) || frame.foot.contains(active))) return
      void syncFull({ silent: true })
    }
    listeners.add(onModelChange)

    renderAll()
    void syncFull({ silent: false })
  }

  // ----------------------------------------------------------------- boot
  const bootState = { running: false }

  /** DSH web-shell entry: mount the sidebar entry + board view, then sync. */
  function apply(ctx) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (bootState.running) return
    bootState.running = true
    const state = { disposed: false }
    let observer = null
    let timer = null

    function ensureMounted() {
      if (state.disposed) return
      try {
        if (entry === null) entry = createEntry()
        placeEntry()
        if (conversationColumn() !== undefined) {
          ensureView()
          if (view !== null && view.firstElementChild === null) buildBoardDom()
        }
      } catch (error) {
        console.warn('[dsh-plugin-taskboard] seat mount failed:', error !== null && error !== undefined ? error.message : error)
      }
    }

    let onActivate = null
    let onDocClick = null

    function dispose() {
      if (state.disposed) return
      state.disposed = true
      if (timer !== null) clearInterval(timer)
      if (observer !== null) { try { observer.disconnect() } catch (error) { /* noop */ } }
      if (onActivate !== null) document.removeEventListener(ACTIVATE_EVENT, onActivate)
      if (onDocClick !== null) document.removeEventListener('click', onDocClick, true)
      unbindModelListener()
      stopSse()
      document.documentElement.removeAttribute(OPEN_ATTR)
      model.open = false
      model.hydrated = false
      model.connected = false
      model.tasks.clear()
      if (entry !== null) { try { entry.remove() } catch (error) { /* noop */ } entry = null }
      if (view !== null) { try { view.remove() } catch (error) { /* noop */ } view = null }
      const style = document.getElementById(STYLE_ID)
      if (style !== null) style.remove()
      bootState.running = false
    }

    try {
      // Pick the dictionary BEFORE the first paint: the board chrome is built
      // synchronously below. navigator.language is the standalone fallback —
      // the host's `language` (GET /state) overrides it on the first sync.
      lang.current = normalizeLang(typeof navigator !== 'undefined' ? navigator.language : null) ?? DEFAULT_LANG
      injectStyles()
      bindModelListener()
      ensureMounted()
      modelListener()
      void refreshAll()
      startSse()
      observer = new MutationObserver(() => { ensureMounted() })
      const root = document.body ?? document.documentElement
      observer.observe(root, { childList: true, subtree: true })
      timer = setInterval(() => { ensureMounted() }, 3000)

      onActivate = (event) => {
        if (state.disposed) return
        if (event.detail !== undefined && event.detail !== PANEL_NAME && model.open) setOpen(false)
      }
      onDocClick = (event) => {
        if (state.disposed || !model.open) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(ENTRY_SELECTOR +
            ', [data-dsh-cgtb-view], .dsh-cgtb-modal-backdrop, .dsh-cgtb-toast-wrap') !== null) return
        setOpen(false)
      }
      document.addEventListener(ACTIVATE_EVENT, onActivate)
      document.addEventListener('click', onDocClick, true)

      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, 'dsh-plugin-taskboard: client mount')
      } else {
        window.addEventListener('beforeunload', dispose, { once: true })
      }
    } catch (error) {
      console.error('[dsh-plugin-taskboard] client boot failed:', error !== null && error !== undefined ? error.message : error)
      dispose()
    }
  }

  // ---------------------------------------------------------------- export
  // The wrap step evaluates this file inside window.__ModuleLoader__.load with
  // a CommonJS `module` in scope; a plain Node require() gets the same shape.
  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = {
      name: PLUGIN_ID + '/client',
      inject: [],
      apply,
    }
  }
})();
