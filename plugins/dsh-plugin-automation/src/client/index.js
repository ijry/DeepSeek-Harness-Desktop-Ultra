/**
 * Browser half of dsh-plugin-automation — a codeg-plus-style 自动化 page for the
 * DSH web GUI, built in dependency-free vanilla DOM on purpose: the host serves
 * the JSON+SSE API at /dsh-plugin-automation and this bundle only talks to it, so
 * it needs no React runtime and no @deepseek-ai/* packages in the browser.
 *
 * Export shape: `name` / `inject` / `apply` (no default export). The build
 * (scripts/wrap-client.mjs) wraps this file in the DSH module loader
 * (`window.__ModuleLoader__.load`), which provides a CommonJS `module`, so this
 * file assigns `module.exports` when present and is otherwise inert.
 *
 * Failure policy mirrors the sibling plugins: DOM/panel problems are logged, never
 * thrown — the web shell must not fail boot because a panel seat is missing on some
 * DSH layout.
 *
 * Division of labour with the host, deliberately lopsided: NO schedule arithmetic
 * happens here. "每天 09:00" and the next-fire preview are answered by
 * /preview and carried on each record as `scheduleText`, so the text under the
 * cron field and the moment the job actually fires cannot disagree. What this file
 * mirrors from src/shared/*.js is only presentation vocabulary (labels, caps,
 * choice lists); the two copies MUST change together — the same constraint the
 * taskboard and repopanel plugins document.
 *
 * Security stance: an automation's name, prompt and captured output are shown as
 * TEXT NODES only. The output of a scheduled agent run is not trusted markup — it
 * is whatever the model and the tools it ran produced — so this file contains no
 * `innerHTML` at all, not even for its own icons.
 *
 * @module dsh-plugin-automation/client
 */
(function () {
  'use strict'

  // --------------------------------------------------------------- seat ids
  const PLUGIN_ID = 'dsh-plugin-automation'
  const ROUTE_PREFIX = '/dsh-plugin-automation'
  const SSE_PATH = '/dsh-plugin-automation/events'
  const STYLE_ID = 'dsh-plugin-automation-style'
  const PANEL_NAME = 'dsh-plugin-automation'
  const ACTIVATE_EVENT = 'dsh-panel-activate'
  const OPEN_ATTR = 'data-dsh-au-open'
  const ENTRY_SELECTOR = '[data-dsh-automation-entry]'
  const CONVERSATION_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
  const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
  const SIBLING_ENTRIES = '[data-dsh-repopanel-entry], [data-dsh-cgtb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'
  const LOG = '[' + PLUGIN_ID + ']'

  // ------------------------------------------------------------- vocabulary
  // Hand-kept COPY of the presentation vocabulary in src/shared/*.js — see the
  // file header. Nothing here may drift from the host's copy without breaking a
  // label or a form default.
  const MAX_NAME_CHARS = 120
  const MAX_NOTE_CHARS = 2000
  const MAX_PROMPT_CHARS = 20000
  const MIN_TIMEOUT_MINUTES = 1
  const MAX_TIMEOUT_MINUTES = 720
  const INTERVAL_CHOICES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]

  const SCHEDULE_LABELS = { cron: '按计划（cron）', interval: '固定间隔', manual: '仅手动触发' }
  const ACTION_LABELS = { headless: '运行一次会话', taskboard: '投递到任务看板' }
  const ACTION_HINTS = {
    headless: '到点后真的跑一次 agent：在项目目录里开一个一次性会话，把提示词交给它，结束后把最终回答记进历史。',
    taskboard: '到点后只在任务看板上建一张卡，不执行任何东西 —— 等你或 agent 在会话里接手。',
  }
  const OVERLAP_LABELS = { skip: '跳过这一次', cancel: '终止上一次，跑新的' }
  const STATUS_LABELS = {
    running: '运行中', succeeded: '成功', failed: '失败',
    timeout: '超时', canceled: '已取消', skipped: '已跳过',
  }
  const TRIGGER_LABELS = { schedule: '计划触发', manual: '手动触发', catchup: '错过补跑' }
  const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'enabled', label: '已启用' },
    { id: 'paused', label: '已暂停' },
    { id: 'failing', label: '最近失败' },
  ]
  /** Ready-made cron shapes the schedule editor offers before the raw field. */
  const CRON_PRESETS = [
    { cron: '0 9 * * 1-5', label: '工作日 09:00' },
    { cron: '0 9 * * *', label: '每天 09:00' },
    { cron: '0 18 * * 1-5', label: '工作日 18:00' },
    { cron: '0 9 * * 1', label: '每周一 09:00' },
    { cron: '0 9 1 * *', label: '每月 1 日 09:00' },
    { cron: '0 * * * *', label: '每小时' },
  ]

  // ---------------------------------------------------------------- helpers
  /** Message of an unknown throwable, never `[object Object]`. */
  function messageOf(error) {
    if (error === null || error === undefined) return '未知错误'
    if (typeof error.message === 'string' && error.message.length > 0) return error.message
    return String(error)
  }

  /** Element builder: attrs then children, events via `onclick`-style keys. */
  function el(tag, attrs) {
    const node = document.createElement(tag)
    if (attrs !== undefined && attrs !== null) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'style') node.setAttribute('style', String(value))
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else if (key.startsWith('data-') || key.startsWith('aria-')) node.setAttribute(key, String(value))
        else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
          try { node[key] = value } catch { node.setAttribute(key, String(value)) }
        } else node.setAttribute(key, String(value))
      }
    }
    for (let index = 2; index < arguments.length; index += 1) {
      const child = arguments[index]
      if (child === undefined || child === null || child === false) continue
      const items = Array.isArray(child) ? child : [child]
      for (const item of items) {
        if (item === undefined || item === null || item === false) continue
        node.append(item instanceof Node ? item : document.createTextNode(String(item)))
      }
    }
    return node
  }

  const pad2 = (value) => String(value).padStart(2, '0')

  /** `09-08 09:00`, or `2026-09-08 09:00` when the year is not this one. */
  function stamp(ms, withYear) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
    const at = new Date(ms)
    const head = withYear === true || at.getFullYear() !== new Date().getFullYear()
      ? at.getFullYear() + '-' + pad2(at.getMonth() + 1) + '-' + pad2(at.getDate())
      : pad2(at.getMonth() + 1) + '-' + pad2(at.getDate())
    return head + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes())
  }

  /** `3 分钟前` / `2 小时后` — the list rows read better in relative time. */
  function relative(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
    const delta = ms - Date.now()
    const ahead = delta > 0
    const seconds = Math.abs(delta) / 1000
    const suffix = ahead ? '后' : '前'
    if (seconds < 45) return ahead ? '就快了' : '刚刚'
    if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟' + suffix
    if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时' + suffix
    if (seconds < 86400 * 30) return Math.round(seconds / 86400) + ' 天' + suffix
    return stamp(ms)
  }

  /** `1 分 30 秒` for a run duration. */
  function duration(msValue) {
    if (typeof msValue !== 'number' || !Number.isFinite(msValue) || msValue < 0) return ''
    const total = Math.round(msValue / 1000)
    if (total < 60) return total + ' 秒'
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (minutes < 60) return minutes + ' 分' + (seconds === 0 ? '' : ' ' + seconds + ' 秒')
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分'
  }

  /** Truncate for a one-line preview, on characters (never bytes). */
  function clip(text, cap) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length > cap ? value.slice(0, cap - 1) + '…' : value
  }

  // -------------------------------------------------------------------- api
  /** One JSON call against the host, unwrapping the `{ ok }` envelope. */
  async function call(path, init) {
    let response
    try {
      response = await fetch(path, init)
    } catch (error) {
      throw new Error('连不上宿主：' + messageOf(error))
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('宿主返回了非 JSON 响应（HTTP ' + response.status + '）')
    }
    if (payload !== null && payload.ok === true) return payload.value
    const failure = new Error(payload?.error?.message ?? 'HTTP ' + response.status)
    failure.code = payload?.error?.code ?? ''
    throw failure
  }

  const get = (path, params) => call(ROUTE_PREFIX + path + (params === undefined ? '' : '?' + new URLSearchParams(params)))
  const post = (path, body) => call(ROUTE_PREFIX + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  // ------------------------------------------------------------------ model
  /**
   * One flat model. Everything durable lives on the host; this holds the last
   * snapshot plus the purely local view state (which row is expanded, which filter
   * is on). `runsByAutomation` is a lazy cache filled when a row is expanded.
   */
  const model = {
    open: false,
    booted: false,
    loading: false,
    connected: false,
    revision: 0,
    error: null,
    settings: null,
    automations: [],
    runs: [],
    engine: { running: [], cliAvailable: true },
    workspaces: [],
    filter: 'all',
    workspaceFilter: '',
    expanded: null,
    runsByAutomation: {},
    busy: {},
  }

  const listeners = new Set()
  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch (error) {
        console.warn(LOG + ' listener threw:', messageOf(error))
      }
    }
  }

  /** The workspace title for an id, falling back to the id itself. */
  function workspaceLabel(id) {
    if (id === undefined || id === null || id === '') return '（未指定项目）'
    const found = model.workspaces.find((row) => row.id === id)
    if (found === undefined) return id + '（项目已不在列表里）'
    return found.title !== undefined && found.title !== null && String(found.title).length > 0 ? String(found.title) : found.path
  }

  /** The live run of an automation, from the engine's in-flight table. */
  function liveRunOf(id) {
    return (model.engine?.running ?? []).find((row) => row.automationId === id)
  }

  /** The rows the current filter and project selection leave on screen. */
  function visibleRows() {
    return model.automations.filter((row) => {
      if (model.workspaceFilter !== '' && row.workspaceId !== model.workspaceFilter) return false
      if (model.filter === 'enabled') return row.enabled === true
      if (model.filter === 'paused') return row.enabled !== true
      if (model.filter === 'failing') return (row.consecutiveFailures ?? 0) > 0
      return true
    })
  }

  // ------------------------------------------------------------------ toast
  let toastWrap = null
  function toast(message, kind = 'error', timeoutMs = 4200) {
    if (typeof document === 'undefined') return
    if (toastWrap === null || !toastWrap.isConnected) {
      toastWrap = el('div', { class: 'dsh-au-toast-wrap', 'aria-live': 'polite', role: 'status' })
      document.body.append(toastWrap)
    }
    const item = el('div', { class: 'dsh-au-toast', 'data-kind': kind }, String(message))
    toastWrap.append(item)
    setTimeout(() => {
      try {
        item.remove()
      } catch { /* already gone */ }
    }, timeoutMs)
  }

  /** Run one host write with a busy flag, a toast on failure, and a refresh. */
  async function guard(key, work, okMessage) {
    if (model.busy[key] === true) return false
    model.busy[key] = true
    emit()
    try {
      await work()
      if (okMessage !== undefined) toast(okMessage, 'ok', 2600)
      return true
    } catch (error) {
      toast(messageOf(error), 'error', 6000)
      return false
    } finally {
      delete model.busy[key]
      await refresh()
    }
  }

  // ----------------------------------------------------------------- styles
  const STYLES = `
:root {
  --au-bg: #15181e;
  --au-panel: #1c212a;
  --au-panel-2: #232936;
  --au-border: rgba(255,255,255,.09);
  --au-text: #e8ebf1;
  --au-text-2: rgba(232,235,241,.64);
  --au-text-3: rgba(232,235,241,.4);
  --au-input: #101318;
  --au-hover: rgba(255,255,255,.07);
  --au-active: rgba(255,255,255,.12);
  --au-shadow: 0 12px 34px rgba(0,0,0,.5);
  --au-accent: #5b8cff;
  --au-emerald: #3fb06b;
  --au-rose: #e25563;
  --au-amber: #e0a13c;
  --au-muted: #7f8fa4;
}
@media (prefers-color-scheme: light) {
  :root {
    --au-bg: #f3f5f9;
    --au-panel: #ffffff;
    --au-panel-2: #eef1f6;
    --au-border: rgba(15,23,42,.12);
    --au-text: #1b2430;
    --au-text-2: rgba(27,36,48,.62);
    --au-text-3: rgba(27,36,48,.4);
    --au-input: #ffffff;
    --au-hover: rgba(15,23,42,.06);
    --au-active: rgba(15,23,42,.1);
    --au-shadow: 0 12px 34px rgba(15,23,42,.2);
    --au-emerald: #1f9d57;
    --au-rose: #d33c4c;
  }
}
.dsh-au-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-text-secondary, var(--au-text-2, inherit)); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left; box-sizing: border-box;
}
.dsh-au-entry:hover { background: var(--dsw-hover, var(--au-hover)); color: var(--dsw-text-primary, var(--au-text)); }
.dsh-au-entry[data-active="true"] { background: var(--dsw-active, var(--au-active)); color: var(--dsw-text-primary, var(--au-text)); font-weight: 500; }
.dsh-au-entry-icon { display: inline-flex; flex: none; color: var(--au-accent); }
.dsh-au-entry-label { flex: none; }
.dsh-au-entry-stats {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; line-height: 1;
  color: var(--au-text-3); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dsh-au-entry-stats b { font-weight: 600; color: var(--au-rose); }
[data-sidebar-collapsed] [data-dsh-automation-entry],
[class*="_collapsed"] [data-dsh-automation-entry] {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0;
  justify-content: center; gap: 0; text-align: center;
}
[data-sidebar-collapsed] [data-dsh-automation-entry] .dsh-au-entry-label,
[data-sidebar-collapsed] [data-dsh-automation-entry] .dsh-au-entry-stats,
[class*="_collapsed"] [data-dsh-automation-entry] .dsh-au-entry-label,
[class*="_collapsed"] [data-dsh-automation-entry] .dsh-au-entry-stats { display: none; }
html[data-dsh-au-open] [data-pane="conversation"] > *:not([data-dsh-au-view]),
html[data-dsh-au-open] [class*="centerCol"] > *:not([data-dsh-au-view]),
html[data-dsh-au-open] .dshDesktopConversationSurface > *:not([data-dsh-au-view]) { display: none !important; }
.dsh-au-view { display: none; }
html[data-dsh-au-open] .dsh-au-view { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.dsh-au-panel {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0;
  box-sizing: border-box; font-size: 13px; color: var(--dsw-text-primary, var(--au-text));
}
.dsh-au-head {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 10px;
  border-bottom: 1px solid var(--au-border);
}
.dsh-au-row1, .dsh-au-row2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-au-title { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-au-sub { font-size: 11.5px; color: var(--au-text-3); }
.dsh-au-spacer { margin-left: auto; }
.dsh-au-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px;
  border-radius: 8px; border: 1px solid var(--au-border); background: var(--au-panel-2);
  color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
}
.dsh-au-btn:hover { background: var(--au-hover); }
.dsh-au-btn[disabled] { opacity: .45; cursor: default; }
.dsh-au-btn[data-variant="primary"] {
  background: color-mix(in srgb, var(--au-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--au-accent) 45%, transparent); color: var(--au-accent);
}
.dsh-au-btn[data-variant="danger"] { color: var(--au-rose); border-color: color-mix(in srgb, var(--au-rose) 40%, transparent); background: transparent; }
.dsh-au-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--au-text-2); }
.dsh-au-btn[data-variant="ghost"]:hover { background: var(--au-hover); color: var(--au-text); }
.dsh-au-btn[data-size="sm"] { height: 24px; padding: 0 8px; font-size: 11.5px; }
.dsh-au-pill {
  height: 26px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--au-border);
  background: transparent; color: var(--au-text-2); font: inherit; font-size: 12px; cursor: pointer;
}
.dsh-au-pill[data-on="true"] {
  color: var(--au-accent); border-color: color-mix(in srgb, var(--au-accent) 45%, transparent);
  background: color-mix(in srgb, var(--au-accent) 14%, transparent);
}
.dsh-au-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.dsh-au-card {
  border: 1px solid var(--au-border); border-radius: 12px; background: var(--au-panel);
  padding: 11px 13px; display: flex; flex-direction: column; gap: 8px;
}
.dsh-au-card[data-off="true"] { opacity: .68; }
.dsh-au-card-top { display: flex; align-items: flex-start; gap: 9px; }
.dsh-au-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--au-muted); }
.dsh-au-dot[data-on="true"] { background: var(--au-emerald); }
.dsh-au-dot[data-live="true"] { background: var(--au-accent); animation: dsh-au-pulse 1.4s ease-in-out infinite; }
@keyframes dsh-au-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.dsh-au-card-name { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-au-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--au-text-3); }
.dsh-au-card-note { font-size: 12px; color: var(--au-text-2); overflow-wrap: anywhere; }
.dsh-au-card-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-au-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px;
  border-radius: 999px; font-size: 11px; line-height: 1; white-space: nowrap;
  border: 1px solid color-mix(in srgb, var(--au-muted) 40%, transparent); color: var(--au-muted);
}
.dsh-au-chip[data-kind="running"] { color: var(--au-accent); border-color: color-mix(in srgb, var(--au-accent) 45%, transparent); }
.dsh-au-chip[data-kind="succeeded"] { color: var(--au-emerald); border-color: color-mix(in srgb, var(--au-emerald) 45%, transparent); }
.dsh-au-chip[data-kind="failed"] { color: var(--au-rose); border-color: color-mix(in srgb, var(--au-rose) 45%, transparent); }
.dsh-au-chip[data-kind="timeout"] { color: var(--au-amber); border-color: color-mix(in srgb, var(--au-amber) 45%, transparent); }
.dsh-au-runs { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--au-border); padding-top: 8px; }
.dsh-au-run {
  display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 8px;
  font-size: 11.5px; color: var(--au-text-2); cursor: pointer; background: transparent; border: none;
  font-family: inherit; text-align: left; width: 100%;
}
.dsh-au-run:hover { background: var(--au-hover); }
.dsh-au-run-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.dsh-au-empty {
  margin: 28px auto; max-width: 460px; text-align: center; display: flex; flex-direction: column;
  align-items: center; gap: 10px; color: var(--au-text-2);
}
.dsh-au-empty-glyph { font-size: 30px; opacity: .8; }
.dsh-au-empty-title { font-size: 14px; font-weight: 600; color: var(--au-text); }
.dsh-au-empty-text { font-size: 12.5px; line-height: 1.6; }
.dsh-au-warn {
  border: 1px solid color-mix(in srgb, var(--au-amber) 45%, transparent); border-radius: 10px;
  background: color-mix(in srgb, var(--au-amber) 10%, transparent); color: var(--au-amber);
  padding: 8px 11px; font-size: 12px; line-height: 1.5;
}
.dsh-au-modal-backdrop {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(5,8,14,.55); backdrop-filter: blur(2px);
}
.dsh-au-modal {
  display: flex; flex-direction: column; width: min(680px, calc(100vw - 32px));
  max-height: min(88vh, 900px); overflow: hidden; font-size: 13px; border-radius: 14px;
  background: var(--au-bg); color: var(--dsw-text-primary, var(--au-text));
  border: 1px solid var(--au-border); box-shadow: var(--au-shadow);
}
.dsh-au-modal[data-width="sm"] { width: min(420px, calc(100vw - 32px)); }
.dsh-au-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--au-border); }
.dsh-au-modal-title { margin: 0; font-size: 14.5px; font-weight: 600; }
.dsh-au-modal-body { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 13px; min-height: 0; }
.dsh-au-modal-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 11px 16px; border-top: 1px solid var(--au-border); }
.dsh-au-field { display: flex; flex-direction: column; gap: 5px; }
.dsh-au-label { font-size: 12px; font-weight: 500; color: var(--au-text-2); }
.dsh-au-hint { font-size: 11.5px; color: var(--au-text-3); line-height: 1.55; }
.dsh-au-hint[data-kind="error"] { color: var(--au-rose); }
.dsh-au-hint[data-kind="ok"] { color: var(--au-emerald); }
.dsh-au-input, .dsh-au-select, .dsh-au-textarea {
  width: 100%; box-sizing: border-box; border-radius: 8px; padding: 7px 9px;
  border: 1px solid var(--au-border); background: var(--au-input);
  color: var(--dsw-text-primary, var(--au-text)); font: inherit; font-size: 12.5px;
}
.dsh-au-textarea { min-height: 132px; resize: vertical; line-height: 1.6; font-family: inherit; }
.dsh-au-input:focus, .dsh-au-select:focus, .dsh-au-textarea:focus { outline: 2px solid color-mix(in srgb, var(--au-accent) 55%, transparent); outline-offset: -1px; }
.dsh-au-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dsh-au-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-au-switch-row { display: flex; align-items: flex-start; gap: 9px; }
.dsh-au-switch-row input { margin-top: 3px; }
.dsh-au-switch-text { display: flex; flex-direction: column; gap: 2px; }
.dsh-au-preview {
  border: 1px solid var(--au-border); border-radius: 9px; background: var(--au-panel);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--au-text-2);
}
.dsh-au-preview b { color: var(--au-text); font-weight: 600; }
.dsh-au-pre {
  margin: 0; max-height: 320px; overflow: auto; border-radius: 9px; padding: 10px 12px;
  background: var(--au-input); border: 1px solid var(--au-border); color: var(--au-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px;
  line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-au-tpl {
  display: flex; flex-direction: column; gap: 4px; text-align: left; width: 100%;
  border: 1px solid var(--au-border); border-radius: 10px; background: var(--au-panel);
  padding: 10px 12px; cursor: pointer; color: inherit; font: inherit;
}
.dsh-au-tpl:hover { background: var(--au-hover); border-color: color-mix(in srgb, var(--au-accent) 40%, transparent); }
.dsh-au-tpl-name { font-size: 13px; font-weight: 600; }
.dsh-au-toast-wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.dsh-au-toast {
  max-width: 380px; border-radius: 10px; padding: 9px 13px; font-size: 12.5px; line-height: 1.45;
  background: var(--au-panel-2); color: var(--dsw-text-primary, var(--au-text));
  border: 1px solid var(--au-border); box-shadow: var(--au-shadow); white-space: pre-wrap;
}
.dsh-au-toast[data-kind="error"] { border-color: color-mix(in srgb, var(--au-rose) 55%, transparent); }
.dsh-au-toast[data-kind="ok"] { border-color: color-mix(in srgb, var(--au-emerald) 55%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .dsh-au-dot[data-live="true"] { animation: none !important; }
  .dsh-au-btn { transition: none !important; }
}
`

  /** Inject the stylesheet once; re-inject when a reload drops it. */
  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLES
    document.head.append(style)
  }

  // -------------------------------------------------------------- dom seats
  let entry = null
  let view = null
  let panelEl = null
  let headEl = null
  let row1El = null
  let row2El = null
  let bodyEl = null

  function sidebarRoot() {
    const column = document.querySelector(SIDEBAR_SELECTOR)
    if (column === null) return undefined
    const logoRow = column.querySelector('[class*="logoRow"]')
    return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) ?? undefined
  }

  function conversationColumn() {
    return document.querySelector(CONVERSATION_SELECTOR) ?? undefined
  }

  function createEntry() {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.dshAutomationEntry = ''
    button.className = 'dsh-au-entry'
    button.setAttribute('aria-label', '自动化')
    // Built as nodes, not markup: there is no innerHTML anywhere in this file, so
    // the "automation text never becomes markup" rule has no exception to police.
    button.append(
      el('span', { class: 'dsh-au-entry-icon', 'aria-hidden': 'true' }, '⏱'),
      el('span', { class: 'dsh-au-entry-label' }, '自动化'),
      el('span', { class: 'dsh-au-entry-stats' }),
    )
    button.addEventListener('click', () => setOpen(!model.open))
    return button
  }

  /**
   * Insert the sidebar entry next to the New Session row, at the END of the block
   * of panel-plugin entries, so the panel buttons stay together whichever plugin
   * mounts first.
   */
  function placeEntry() {
    if (entry === null) return false
    const root = sidebarRoot()
    if (root === undefined || !root.isConnected) return false
    if (entry.parentElement === root && root.contains(entry)) return true
    const family = Array.from(root.children).filter((child) =>
      child instanceof HTMLElement && child.matches(ENTRY_SELECTOR + ', ' + SIBLING_ENTRIES))
    if (family.length > 0) {
      root.insertBefore(entry, family[family.length - 1].nextElementSibling)
      return true
    }
    const nested = root.querySelector('button[class*="newSession"]')
    const row = nested === null || nested.parentElement === null
      ? null
      : (nested.parentElement === root ? nested : nested.closest('[class*="logoRow"]'))
    if (row !== null) {
      root.insertBefore(entry, row.nextElementSibling)
      return true
    }
    root.append(entry)
    return true
  }

  /** Attach (or re-attach) the view container as a trailing child of the column. */
  function ensureView() {
    const column = conversationColumn()
    if (column === undefined) return
    if (view === null || !view.isConnected) {
      if (view !== null) view.remove()
      view = el('div', { class: 'dsh-au-view', 'data-dsh-au-view': '' })
    }
    if (view.parentElement !== column) column.append(view)
  }

  /** Build the panel shell once: header (two rows) and the list body. */
  function buildPanelDom() {
    row1El = el('div', { class: 'dsh-au-row1' })
    row2El = el('div', { class: 'dsh-au-row2' })
    headEl = el('div', { class: 'dsh-au-head' }, row1El, row2El)
    bodyEl = el('div', { class: 'dsh-au-body', role: 'region', 'aria-label': '自动化列表' })
    panelEl = el('div', { class: 'dsh-au-panel', 'data-dsh-au-panel': '' }, headEl, bodyEl)
    view.append(panelEl)
  }

  /** Open or close the panel, telling sibling panels to stand down. */
  function setOpen(next) {
    model.open = next === true
    if (model.open) {
      document.documentElement.setAttribute(OPEN_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      if (!model.booted) void refresh()
    } else {
      document.documentElement.removeAttribute(OPEN_ATTR)
    }
    emit()
  }

  // --------------------------------------------------------------- data load
  /** Re-read the whole panel state. Cheap: one local request over a JSON file. */
  async function refresh() {
    model.loading = true
    emit()
    try {
      const state = await get('/state')
      model.revision = state.revision
      model.settings = state.settings
      model.automations = Array.isArray(state.automations) ? state.automations : []
      model.runs = Array.isArray(state.runs) ? state.runs : []
      model.engine = state.engine ?? { running: [], cliAvailable: true }
      model.workspaces = Array.isArray(state.workspaces) ? state.workspaces : []
      model.booted = true
      model.error = null
      if (model.expanded !== null) await loadRuns(model.expanded, true)
    } catch (error) {
      model.error = messageOf(error)
    } finally {
      model.loading = false
      emit()
    }
  }

  /** The run history of one automation, cached until the next refresh. */
  async function loadRuns(automationId, quiet) {
    try {
      model.runsByAutomation[automationId] = await get('/runs', { automationId, limit: '20' })
    } catch (error) {
      if (quiet !== true) toast(messageOf(error))
      model.runsByAutomation[automationId] = []
    }
    emit()
  }

  // ------------------------------------------------------------ header rows
  // The header is rebuilt on every render: it holds no text input, so nothing can
  // lose focus mid-typing (the forms live in modals, which are built once).
  function renderHeader() {
    if (row1El === null || row2El === null) return
    row1El.textContent = ''
    row2El.textContent = ''
    const settings = model.settings
    const armed = model.automations.filter((row) => row.enabled === true).length

    row1El.append(
      el('h2', { class: 'dsh-au-title' }, '自动化'),
      el('span', { class: 'dsh-au-sub' }, model.booted
        ? `${model.automations.length} 条 · ${armed} 条已启用`
        : '正在读取…'),
      el('div', { class: 'dsh-au-spacer' }),
      el('button', {
        class: 'dsh-au-btn', 'data-variant': 'primary', type: 'button',
        onclick: () => openTemplates(),
      }, '＋ 新建'),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: () => openSettings() }, '设置'),
      el('button', {
        class: 'dsh-au-btn', 'data-variant': 'ghost', type: 'button',
        title: '重新读取', onclick: () => void refresh(),
      }, '刷新'),
    )

    // The master switch is a header control on purpose: stopping every automation
    // must never require opening a form.
    const masterOn = settings === null ? true : settings.enabled !== false
    row2El.append(
      el('button', {
        class: 'dsh-au-pill', 'data-on': String(masterOn), type: 'button',
        title: masterOn ? '点一下暂停所有定时触发' : '点一下恢复定时触发',
        onclick: () => void guard('master', () => post('/settings', { enabled: !masterOn })),
      }, masterOn ? '定时触发：开' : '定时触发：已暂停'),
    )
    for (const filter of FILTERS) {
      row2El.append(el('button', {
        class: 'dsh-au-pill', 'data-on': String(model.filter === filter.id), type: 'button',
        onclick: () => {
          model.filter = filter.id
          emit()
        },
      }, filter.label))
    }
    row2El.append(el('div', { class: 'dsh-au-spacer' }), workspaceSelect())
  }

  /** The project filter. Only projects that actually own an automation are listed. */
  function workspaceSelect() {
    const used = new Set(model.automations.map((row) => row.workspaceId).filter((id) => id !== undefined))
    const select = el('select', {
      class: 'dsh-au-select', style: 'width:auto;min-width:150px', 'aria-label': '按项目筛选',
      onchange: (event) => {
        model.workspaceFilter = event.target.value
        emit()
      },
    }, el('option', { value: '' }, '所有项目'))
    for (const id of used) {
      select.append(el('option', { value: id, selected: model.workspaceFilter === id }, clip(workspaceLabel(id), 40)))
    }
    select.value = model.workspaceFilter
    return select
  }

  /** The sidebar badge: how many are armed, and how many are failing right now. */
  function renderEntry() {
    if (entry === null) return
    if (model.open) entry.dataset.active = 'true'
    else delete entry.dataset.active
    const stats = entry.querySelector('.dsh-au-entry-stats')
    if (stats === null) return
    stats.textContent = ''
    if (!model.booted) return
    const armed = model.automations.filter((row) => row.enabled === true).length
    const failing = model.automations.filter((row) => (row.consecutiveFailures ?? 0) > 0).length
    const live = (model.engine?.running ?? []).length
    if (live > 0) stats.append(el('span', { title: '正在运行' }, '▶ ' + live))
    if (armed > 0) stats.append(el('span', { title: '已启用' }, String(armed)))
    if (failing > 0) stats.append(el('b', { title: '最近失败' }, '!' + failing))
  }

  // ------------------------------------------------------------------- list
  function renderList() {
    if (bodyEl === null) return
    bodyEl.textContent = ''
    if (model.error !== null) {
      bodyEl.append(stateBlock('⚠', '读取失败', model.error, [
        el('button', { class: 'dsh-au-btn', type: 'button', onclick: () => void refresh() }, '重试'),
      ]))
      return
    }
    if (!model.booted) {
      bodyEl.append(stateBlock('⏱', '正在读取自动化…', ''))
      return
    }
    if (model.engine?.cliAvailable === false) {
      bodyEl.append(el('div', { class: 'dsh-au-warn' },
        '找不到 dsh 启动器，「运行一次会话」这种自动化没法执行。请设置环境变量 ' +
        'DSH_PLUGIN_AUTOMATION_DSH_ENTRY 指向 dsh 的 bin.js 后重启 dsh。'))
    }
    if (model.settings !== null && model.settings.enabled === false) {
      bodyEl.append(el('div', { class: 'dsh-au-warn' }, '定时触发已被总开关暂停，所有计划都不会到点执行；「立即运行」仍然可用。'))
    }
    const rows = visibleRows()
    if (rows.length === 0) {
      bodyEl.append(model.automations.length === 0
        ? stateBlock('⏱', '还没有自动化', '自动化 = 一段提示词 + 一个时间表。到点后它会在你选的项目里跑一次 agent，' +
          '把结果记进历史；也可以只在任务看板上建一张卡，等你接手。', [
          el('button', { class: 'dsh-au-btn', 'data-variant': 'primary', type: 'button', onclick: () => openTemplates() }, '从模板开始'),
          el('button', { class: 'dsh-au-btn', type: 'button', onclick: () => openEditor(null) }, '手动新建'),
        ])
        : stateBlock('🔍', '这个筛选下没有自动化', '换个筛选或项目看看。'))
      return
    }
    for (const row of rows) bodyEl.append(cardFor(row))
  }

  /** The empty / error block shape used by the list body. */
  function stateBlock(glyph, title, text, actions) {
    return el('div', { class: 'dsh-au-empty' },
      el('div', { class: 'dsh-au-empty-glyph', 'aria-hidden': 'true' }, glyph),
      el('div', { class: 'dsh-au-empty-title' }, title),
      text === '' || text === undefined ? null : el('div', { class: 'dsh-au-empty-text' }, text),
      actions === undefined ? null : el('div', { class: 'dsh-au-inline' }, actions),
    )
  }

  /** One automation row. */
  function cardFor(row) {
    const live = liveRunOf(row.id)
    const busy = model.busy['run:' + row.id] === true
    const card = el('div', { class: 'dsh-au-card', 'data-off': String(row.enabled !== true) })

    const meta = el('div', { class: 'dsh-au-card-meta' },
      el('span', {}, row.scheduleText ?? ''),
      el('span', {}, '·'),
      el('span', { title: ACTION_HINTS[row.action?.kind] ?? '' }, ACTION_LABELS[row.action?.kind] ?? row.action?.kind),
      el('span', {}, '·'),
      el('span', { title: row.workspaceId === undefined ? '在 dsh 的工作目录里运行' : undefined },
        clip(workspaceLabel(row.workspaceId), 34)),
    )
    if (row.enabled === true && typeof row.nextRunAt === 'number') {
      meta.append(el('span', {}, '·'), el('span', { title: stamp(row.nextRunAt, true) }, '下一次 ' + relative(row.nextRunAt)))
    }
    if (row.lastStatus !== undefined && row.lastStatus !== null) {
      meta.append(el('span', {}, '·'), el('span', { class: 'dsh-au-chip', 'data-kind': row.lastStatus },
        (STATUS_LABELS[row.lastStatus] ?? row.lastStatus) +
        (typeof row.lastRunAt === 'number' ? ' · ' + relative(row.lastRunAt) : '')))
    }

    card.append(el('div', { class: 'dsh-au-card-top' },
      el('span', {
        class: 'dsh-au-dot', 'data-on': String(row.enabled === true),
        'data-live': String(live !== undefined),
      }),
      el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px' },
        el('div', { class: 'dsh-au-card-name' }, row.name),
        row.note === undefined ? null : el('div', { class: 'dsh-au-card-note' }, clip(row.note, 160)),
        meta,
        row.pausedReason === undefined ? null : el('div', { class: 'dsh-au-hint', 'data-kind': 'error' }, row.pausedReason),
      ),
    ))

    const actions = el('div', { class: 'dsh-au-card-actions' })
    if (live !== undefined) {
      actions.append(el('button', {
        class: 'dsh-au-btn', 'data-size': 'sm', 'data-variant': 'danger', type: 'button',
        onclick: () => void guard('cancel:' + live.runId, () => post('/runs/cancel', { runId: live.runId }), '已请求终止'),
      }, '终止本次'))
    } else {
      actions.append(el('button', {
        class: 'dsh-au-btn', 'data-size': 'sm', 'data-variant': 'primary', type: 'button', disabled: busy,
        onclick: () => void guard('run:' + row.id, async () => {
          const run = await post('/automations/run', { id: row.id })
          if (run !== null && run.status === 'skipped') throw new Error(run.error ?? '这次被跳过了')
        }, '已开始运行'),
      }, busy ? '启动中…' : '立即运行'))
    }
    actions.append(
      el('button', {
        class: 'dsh-au-btn', 'data-size': 'sm', type: 'button',
        onclick: () => void guard('toggle:' + row.id,
          () => post('/automations/enabled', { id: row.id, enabled: row.enabled !== true, ifVersion: row.version })),
      }, row.enabled === true ? '暂停' : '启用'),
      el('button', { class: 'dsh-au-btn', 'data-size': 'sm', type: 'button', onclick: () => openEditor(row) }, '编辑'),
      el('button', {
        class: 'dsh-au-btn', 'data-size': 'sm', 'data-variant': 'ghost', type: 'button',
        onclick: () => {
          model.expanded = model.expanded === row.id ? null : row.id
          if (model.expanded === row.id && model.runsByAutomation[row.id] === undefined) void loadRuns(row.id)
          emit()
        },
      }, model.expanded === row.id ? '收起历史' : '历史'),
      el('div', { class: 'dsh-au-spacer' }),
      el('button', {
        class: 'dsh-au-btn', 'data-size': 'sm', 'data-variant': 'danger', type: 'button',
        onclick: () => confirmDelete(row),
      }, '删除'),
    )
    card.append(actions)
    if (model.expanded === row.id) card.append(runsBlock(row))
    return card
  }

  /** The inline run history under an expanded row. */
  function runsBlock(row) {
    const runs = model.runsByAutomation[row.id]
    const block = el('div', { class: 'dsh-au-runs' })
    if (runs === undefined) {
      block.append(el('div', { class: 'dsh-au-hint' }, '正在读取历史…'))
      return block
    }
    if (runs.length === 0) {
      block.append(el('div', { class: 'dsh-au-hint' }, '还没有运行记录。'))
      return block
    }
    for (const run of runs) {
      const summary = run.status === 'succeeded'
        ? clip(run.output ?? '', 90)
        : clip(run.error ?? run.output ?? '', 90)
      block.append(el('button', {
        class: 'dsh-au-run', type: 'button', onclick: () => openRunDetail(run.id),
      },
        el('span', { class: 'dsh-au-chip', 'data-kind': run.status }, STATUS_LABELS[run.status] ?? run.status),
        el('span', { class: 'dsh-au-run-text' },
          stamp(run.startedAt ?? run.createdAt) +
          ' · ' + (TRIGGER_LABELS[run.trigger] ?? run.trigger) +
          (run.durationMs === undefined ? '' : ' · ' + duration(run.durationMs)) +
          (summary === '' ? '' : ' · ' + summary)),
      ))
    }
    return block
  }

  // ----------------------------------------------------------- modal frames
  /** The stack of open overlays; Escape closes the topmost one only. */
  const overlays = []

  /**
   * One hand-rolled modal frame. Returns { body, foot, close } so callers only
   * describe content. Clicking the backdrop closes it; the panel behind stays open.
   */
  function openModalFrame(titleText, options) {
    const width = options?.width ?? 'md'
    const body = el('div', { class: 'dsh-au-modal-body' })
    const foot = el('div', { class: 'dsh-au-modal-foot' })
    const frame = el('div', { class: 'dsh-au-modal', 'data-width': width, role: 'dialog', 'aria-modal': 'true' })
    const backdrop = el('div', { class: 'dsh-au-modal-backdrop' }, frame)
    const close = () => {
      const index = overlays.indexOf(overlay)
      if (index >= 0) overlays.splice(index, 1)
      try {
        backdrop.remove()
      } catch { /* already gone */ }
      options?.onClose?.()
    }
    const overlay = { close }
    frame.append(
      el('div', { class: 'dsh-au-modal-head' },
        el('h3', { class: 'dsh-au-modal-title' }, titleText),
        el('div', { class: 'dsh-au-spacer' }),
        el('button', { class: 'dsh-au-btn', 'data-variant': 'ghost', type: 'button', onclick: close, 'aria-label': '关闭' }, '✕'),
      ),
      body,
      foot,
    )
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close()
    })
    document.body.append(backdrop)
    overlays.push(overlay)
    return { body, foot, close }
  }

  /** A yes/no question. `danger` colours the confirming button. */
  function askConfirm(options) {
    const frame = openModalFrame(options.title, { width: 'sm' })
    frame.body.append(el('div', { class: 'dsh-au-hint', style: 'font-size:12.5px' }, options.text))
    frame.foot.append(
      el('div', { class: 'dsh-au-spacer' }),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: frame.close }, '取消'),
      el('button', {
        class: 'dsh-au-btn', 'data-variant': options.danger === true ? 'danger' : 'primary', type: 'button',
        onclick: () => {
          frame.close()
          options.onConfirm()
        },
      }, options.confirmLabel ?? '确定'),
    )
  }

  function confirmDelete(row) {
    askConfirm({
      title: '删除这条自动化？',
      text: `「${row.name}」以及它的运行历史都会被删掉，这个操作不可撤销。正在运行的那一次会被终止。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => void guard('delete:' + row.id,
        () => post('/automations/delete', { id: row.id, ifVersion: row.version }), '已删除'),
    })
  }

  /** A labelled field wrapper. */
  function field(labelText, control, hint) {
    return el('div', { class: 'dsh-au-field' },
      el('label', { class: 'dsh-au-label' }, labelText),
      control,
      hint === undefined ? null : el('div', { class: 'dsh-au-hint' }, hint),
    )
  }

  /** A checkbox row with a title and an explanation. */
  function switchRow(labelText, checked, hint, onChange) {
    const input = el('input', { type: 'checkbox', checked, onchange: (event) => onChange(event.target.checked) })
    return el('label', { class: 'dsh-au-switch-row' }, input,
      el('span', { class: 'dsh-au-switch-text' },
        el('span', { style: 'font-size:12.5px' }, labelText),
        hint === undefined ? null : el('span', { class: 'dsh-au-hint' }, hint),
      ))
  }

  // ----------------------------------------------------------------- editor
  /** The draft a brand-new automation starts from. */
  function blankDraft() {
    return {
      name: '',
      note: '',
      prompt: '',
      workspaceId: model.workspaceFilter !== '' ? model.workspaceFilter : (model.workspaces[0]?.id ?? ''),
      schedule: { kind: 'cron', cron: '0 9 * * 1-5', intervalMinutes: 60 },
      action: { kind: 'headless', timeoutMinutes: model.settings?.defaultTimeoutMinutes ?? 30 },
      enabled: true,
      usePreamble: true,
      catchUp: false,
      overlap: 'skip',
    }
  }

  /** An existing record as an editable draft (never a reference into the model). */
  function recordToDraft(row) {
    return {
      name: row.name ?? '',
      note: row.note ?? '',
      prompt: row.prompt ?? '',
      workspaceId: row.workspaceId ?? '',
      schedule: {
        kind: row.schedule?.kind ?? 'cron',
        cron: row.schedule?.cron ?? '0 9 * * 1-5',
        intervalMinutes: row.schedule?.intervalMinutes ?? 60,
      },
      action: {
        kind: row.action?.kind ?? 'headless',
        timeoutMinutes: row.action?.timeoutMinutes ?? model.settings?.defaultTimeoutMinutes ?? 30,
      },
      enabled: row.enabled === true,
      usePreamble: row.usePreamble !== false,
      catchUp: row.catchUp === true,
      overlap: row.overlap === 'cancel' ? 'cancel' : 'skip',
    }
  }

  /** The payload the host validates. Empty optional fields become undefined. */
  function draftPayload(draft) {
    const schedule = draft.schedule.kind === 'cron'
      ? { kind: 'cron', cron: draft.schedule.cron }
      : draft.schedule.kind === 'interval'
        ? { kind: 'interval', intervalMinutes: draft.schedule.intervalMinutes }
        : { kind: 'manual' }
    return {
      name: draft.name,
      note: draft.note === '' ? undefined : draft.note,
      prompt: draft.prompt,
      workspaceId: draft.workspaceId === '' ? undefined : draft.workspaceId,
      schedule,
      action: draft.action.kind === 'headless'
        ? { kind: 'headless', timeoutMinutes: draft.action.timeoutMinutes }
        : { kind: 'taskboard' },
      enabled: draft.enabled,
      usePreamble: draft.usePreamble,
      catchUp: draft.catchUp,
      overlap: draft.overlap,
    }
  }

  /**
   * The create/edit form. `record` null means create; a `template` seeds the fields
   * of a new one. The schedule and action sections re-render in place; the text
   * inputs are built once so typing never loses focus.
   */
  function openEditor(record, template) {
    const draft = record === null ? blankDraft() : recordToDraft(record)
    if (template !== undefined && template !== null) {
      draft.name = template.name
      draft.note = template.note ?? ''
      draft.prompt = template.prompt
      draft.schedule.kind = template.schedule?.kind ?? 'cron'
      if (template.schedule?.cron !== undefined) draft.schedule.cron = template.schedule.cron
      if (template.schedule?.intervalMinutes !== undefined) draft.schedule.intervalMinutes = template.schedule.intervalMinutes
      draft.action.kind = template.action ?? 'headless'
    }
    const frame = openModalFrame(record === null ? '新建自动化' : '编辑自动化')

    const nameInput = el('input', {
      class: 'dsh-au-input', type: 'text', maxlength: String(MAX_NAME_CHARS), value: draft.name,
      placeholder: '例如：每日测试回归',
      oninput: (event) => {
        draft.name = event.target.value
      },
    })
    const noteInput = el('input', {
      class: 'dsh-au-input', type: 'text', maxlength: String(MAX_NOTE_CHARS), value: draft.note,
      placeholder: '一句话说明这条自动化是干什么的（可留空）',
      oninput: (event) => {
        draft.note = event.target.value
      },
    })
    const promptArea = el('textarea', {
      class: 'dsh-au-textarea', maxlength: String(MAX_PROMPT_CHARS),
      placeholder: '到点后交给 agent 的提示词。写清要做什么、做到什么程度、以及不要做什么。',
      oninput: (event) => {
        draft.prompt = event.target.value
        promptCount.textContent = draft.prompt.length + ' / ' + MAX_PROMPT_CHARS
      },
    })
    promptArea.value = draft.prompt
    const promptCount = el('span', { class: 'dsh-au-hint' }, draft.prompt.length + ' / ' + MAX_PROMPT_CHARS)

    const workspaceInput = el('select', {
      class: 'dsh-au-select',
      onchange: (event) => {
        draft.workspaceId = event.target.value
      },
    }, el('option', { value: '' }, '（不指定，用 dsh 的工作目录）'))
    for (const workspace of model.workspaces) {
      workspaceInput.append(el('option', { value: workspace.id }, clip(workspace.title ?? workspace.path, 60)))
    }
    workspaceInput.value = draft.workspaceId

    // ------------------------------------------------------ schedule section
    const scheduleBox = el('div', { class: 'dsh-au-field' })
    const previewBox = el('div', { class: 'dsh-au-preview' })
    let previewTimer

    /** Ask the HOST what this schedule means. Never computed here — see the header. */
    const runPreview = async () => {
      const params = { kind: draft.schedule.kind, count: '3' }
      if (draft.schedule.kind === 'cron') params.cron = draft.schedule.cron
      if (draft.schedule.kind === 'interval') params.intervalMinutes = String(draft.schedule.intervalMinutes)
      previewBox.textContent = ''
      previewBox.append(el('span', { class: 'dsh-au-hint' }, '正在计算…'))
      let preview
      try {
        preview = await get('/preview', params)
      } catch (error) {
        previewBox.textContent = ''
        previewBox.append(el('span', { class: 'dsh-au-hint', 'data-kind': 'error' }, messageOf(error)))
        return
      }
      previewBox.textContent = ''
      if (preview.valid !== true) {
        previewBox.append(el('span', { class: 'dsh-au-hint', 'data-kind': 'error' }, preview.message ?? '这个计划无效'))
        return
      }
      previewBox.append(el('span', {}, el('b', {}, preview.text ?? '')))
      if (preview.message !== undefined) {
        previewBox.append(el('span', { class: 'dsh-au-hint', 'data-kind': 'error' }, preview.message))
      }
      if (Array.isArray(preview.next) && preview.next.length > 0) {
        previewBox.append(el('span', { class: 'dsh-au-hint' },
          '接下来：' + preview.next.map((ms) => stamp(ms, true)).join('、')))
      }
    }
    const schedulePreview = () => {
      clearTimeout(previewTimer)
      previewTimer = setTimeout(() => void runPreview(), 260)
    }

    const renderSchedule = () => {
      scheduleBox.textContent = ''
      const kinds = el('div', { class: 'dsh-au-inline' })
      for (const kind of ['cron', 'interval', 'manual']) {
        kinds.append(el('button', {
          class: 'dsh-au-pill', type: 'button', 'data-on': String(draft.schedule.kind === kind),
          onclick: () => {
            draft.schedule.kind = kind
            renderSchedule()
            schedulePreview()
          },
        }, SCHEDULE_LABELS[kind]))
      }
      scheduleBox.append(el('label', { class: 'dsh-au-label' }, '触发方式'), kinds)

      if (draft.schedule.kind === 'cron') {
        const presets = el('div', { class: 'dsh-au-inline' })
        const cronInput = el('input', {
          class: 'dsh-au-input dsh-au-mono', type: 'text', value: draft.schedule.cron,
          placeholder: '分 时 日 月 周   例如 0 9 * * 1-5',
          oninput: (event) => {
            draft.schedule.cron = event.target.value
            schedulePreview()
          },
        })
        for (const preset of CRON_PRESETS) {
          presets.append(el('button', {
            class: 'dsh-au-pill', type: 'button', 'data-on': String(draft.schedule.cron === preset.cron),
            onclick: () => {
              draft.schedule.cron = preset.cron
              cronInput.value = preset.cron
              for (const pill of presets.children) pill.setAttribute('data-on', String(pill.textContent === preset.label))
              schedulePreview()
            },
          }, preset.label))
        }
        scheduleBox.append(presets, cronInput, el('div', { class: 'dsh-au-hint' },
          '标准 5 字段 crontab（也接受 @daily / @hourly 这类简写），按本机时区计算。'))
      } else if (draft.schedule.kind === 'interval') {
        const select = el('select', {
          class: 'dsh-au-select',
          onchange: (event) => {
            draft.schedule.intervalMinutes = Number.parseInt(event.target.value, 10)
            schedulePreview()
          },
        })
        for (const minutes of INTERVAL_CHOICES) {
          select.append(el('option', { value: String(minutes) },
            minutes % 1440 === 0 ? '每 ' + minutes / 1440 + ' 天'
              : minutes % 60 === 0 ? '每 ' + minutes / 60 + ' 小时' : '每 ' + minutes + ' 分钟'))
        }
        select.value = String(draft.schedule.intervalMinutes)
        scheduleBox.append(select, el('div', { class: 'dsh-au-hint' },
          '从上一次触发起算；宿主没在运行的时间不计入。'))
      } else {
        scheduleBox.append(el('div', { class: 'dsh-au-hint' },
          '不会自己触发，只在你点「立即运行」时跑一次 —— 适合存一段常用的提示词。'))
      }
      scheduleBox.append(previewBox)
    }
    renderSchedule()
    schedulePreview()

    // -------------------------------------------------------- action section
    const actionBox = el('div', { class: 'dsh-au-field' })
    const renderAction = () => {
      actionBox.textContent = ''
      const kinds = el('div', { class: 'dsh-au-inline' })
      for (const kind of ['headless', 'taskboard']) {
        kinds.append(el('button', {
          class: 'dsh-au-pill', type: 'button', 'data-on': String(draft.action.kind === kind),
          onclick: () => {
            draft.action.kind = kind
            renderAction()
          },
        }, ACTION_LABELS[kind]))
      }
      actionBox.append(el('label', { class: 'dsh-au-label' }, '到点后做什么'), kinds,
        el('div', { class: 'dsh-au-hint' }, ACTION_HINTS[draft.action.kind]))
      if (draft.action.kind === 'headless') {
        actionBox.append(el('div', { class: 'dsh-au-inline' },
          el('span', { class: 'dsh-au-hint' }, '超时（分钟）'),
          el('input', {
            class: 'dsh-au-input', type: 'number', min: String(MIN_TIMEOUT_MINUTES), max: String(MAX_TIMEOUT_MINUTES),
            style: 'width:96px', value: String(draft.action.timeoutMinutes),
            oninput: (event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              draft.action.timeoutMinutes = Number.isInteger(parsed) ? parsed : 30
            },
          }),
          el('span', { class: 'dsh-au-hint' }, '超过就终止这次运行，历史里记为超时。'),
        ))
      } else {
        actionBox.append(el('div', { class: 'dsh-au-hint' }, '需要装 dsh-plugin-taskboard，并且必须选一个项目。'))
      }
    }
    renderAction()

    frame.body.append(
      field('名称', nameInput),
      field('说明', noteInput),
      field('项目', workspaceInput, '运行会发生在这个项目的目录里。'),
      el('div', { class: 'dsh-au-field' },
        el('label', { class: 'dsh-au-label' }, '提示词'), promptArea,
        el('div', { class: 'dsh-au-inline' }, promptCount),
      ),
      scheduleBox,
      actionBox,
      el('div', { class: 'dsh-au-field' },
        el('label', { class: 'dsh-au-label' }, '其他'),
        switchRow('启用', draft.enabled, '关掉就只保留配置，不会到点触发。', (value) => {
          draft.enabled = value
        }),
        switchRow('加上无人值守说明', draft.usePreamble,
          '在提示词前加一段「没人能回答你的提问、别做破坏性操作」的说明（内容可在设置里改）。', (value) => {
            draft.usePreamble = value
          }),
        switchRow('错过的时间点补跑一次', draft.catchUp,
          '默认丢弃：宿主没运行时错过的计划，只在历史里记一条「已跳过」。', (value) => {
            draft.catchUp = value
          }),
      ),
    )

    const overlapSelect = el('select', {
      class: 'dsh-au-select', style: 'width:auto',
      onchange: (event) => {
        draft.overlap = event.target.value
      },
    })
    for (const [value, label] of Object.entries(OVERLAP_LABELS)) {
      overlapSelect.append(el('option', { value }, label))
    }
    overlapSelect.value = draft.overlap
    frame.body.append(field('上一次还在运行时', overlapSelect))

    const errorLine = el('div', { class: 'dsh-au-hint', 'data-kind': 'error' })
    const save = el('button', { class: 'dsh-au-btn', 'data-variant': 'primary', type: 'button' },
      record === null ? '创建' : '保存')
    save.addEventListener('click', async () => {
      // Client-side checks are a courtesy; the host validates the same rules and
      // its message is what surfaces when they disagree.
      if (draft.name.trim() === '') {
        errorLine.textContent = '名称不能为空'
        return
      }
      if (draft.prompt.trim() === '') {
        errorLine.textContent = '提示词不能为空'
        return
      }
      if (draft.action.kind === 'taskboard' && draft.workspaceId === '') {
        errorLine.textContent = '投递到任务看板必须选一个项目'
        return
      }
      errorLine.textContent = ''
      save.disabled = true
      const payload = draftPayload(draft)
      const done = record === null
        ? await guard('create', () => post('/automations', { draft: payload }), '已创建')
        : await guard('update:' + record.id,
          () => post('/automations/update', { id: record.id, draft: payload, ifVersion: record.version }), '已保存')
      save.disabled = false
      if (done) frame.close()
    })
    frame.foot.append(
      errorLine,
      el('div', { class: 'dsh-au-spacer' }),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: frame.close }, '取消'),
      save,
    )
  }

  // -------------------------------------------------------- template gallery
  /** The gallery a new automation starts from; "手动新建" skips it. */
  function openTemplates() {
    const frame = openModalFrame('新建自动化：从模板开始')
    frame.body.append(el('div', { class: 'dsh-au-hint' },
      '模板只是把表单填好，创建前你还能改任何一项。所有模板都只做诊断和报告，不会提交、推送或部署。'))
    const list = el('div', { class: 'dsh-au-field' }, el('div', { class: 'dsh-au-hint' }, '正在读取模板…'))
    frame.body.append(list)
    frame.foot.append(
      el('div', { class: 'dsh-au-spacer' }),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: frame.close }, '取消'),
      el('button', {
        class: 'dsh-au-btn', 'data-variant': 'primary', type: 'button',
        onclick: () => {
          frame.close()
          openEditor(null)
        },
      }, '不用模板，手动新建'),
    )
    void (async () => {
      let templates
      try {
        templates = await get('/templates')
      } catch (error) {
        list.textContent = ''
        list.append(el('div', { class: 'dsh-au-hint', 'data-kind': 'error' }, messageOf(error)))
        return
      }
      list.textContent = ''
      let group
      for (const template of templates) {
        if (template.group !== group) {
          group = template.group
          list.append(el('div', { class: 'dsh-au-label', style: 'margin-top:4px' }, group))
        }
        list.append(el('button', {
          class: 'dsh-au-tpl', type: 'button',
          onclick: () => {
            frame.close()
            openEditor(null, template)
          },
        },
          el('span', { class: 'dsh-au-tpl-name' }, template.name),
          el('span', { class: 'dsh-au-hint' }, template.note),
          el('span', { class: 'dsh-au-hint' }, ACTION_LABELS[template.action] ?? template.action),
        ))
      }
    })()
  }

  // ------------------------------------------------------------- run detail
  /** Set by apply() when the shell exposes its session service. */
  let openSession = null

  /** One run, with the whole captured answer. */
  function openRunDetail(runId) {
    const frame = openModalFrame('运行详情')
    const body = el('div', { class: 'dsh-au-field' }, el('div', { class: 'dsh-au-hint' }, '正在读取…'))
    frame.body.append(body)
    frame.foot.append(
      el('div', { class: 'dsh-au-spacer' }),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: frame.close }, '关闭'),
    )
    void (async () => {
      let run
      try {
        run = await get('/run', { id: runId })
      } catch (error) {
        body.textContent = ''
        body.append(el('div', { class: 'dsh-au-hint', 'data-kind': 'error' }, messageOf(error)))
        return
      }
      body.textContent = ''
      const facts = el('div', { class: 'dsh-au-preview' },
        el('span', {}, el('b', {}, run.automationName ?? ''), ' · ',
          STATUS_LABELS[run.status] ?? run.status, ' · ', TRIGGER_LABELS[run.trigger] ?? run.trigger),
        el('span', { class: 'dsh-au-hint' },
          '开始 ' + (run.startedAt === undefined ? '（未开始）' : stamp(run.startedAt, true)) +
          (run.finishedAt === undefined ? '' : ' · 结束 ' + stamp(run.finishedAt, true)) +
          (run.durationMs === undefined ? '' : ' · 耗时 ' + duration(run.durationMs)) +
          (run.exitCode === undefined ? '' : ' · 退出码 ' + run.exitCode)),
        run.scheduledFor === undefined ? null
          : el('span', { class: 'dsh-au-hint' }, '计划时间 ' + stamp(run.scheduledFor, true)),
        run.cwd === undefined ? null : el('span', { class: 'dsh-au-hint' }, '目录 ' + run.cwd),
      )
      body.append(facts)
      if (run.error !== undefined) {
        body.append(field('错误', el('pre', { class: 'dsh-au-pre' }, run.error)))
      }
      if (run.output !== undefined) {
        body.append(field(run.status === 'succeeded' ? '最终回答' : '输出', el('pre', { class: 'dsh-au-pre' }, run.output)))
      }
      if (run.output === undefined && run.error === undefined) {
        body.append(el('div', { class: 'dsh-au-hint' }, '这次运行没有留下输出。'))
      }
      // The session a headless run produced is only linked when it could be
      // identified unambiguously — see host/runner.js identifySession.
      if (typeof run.sessionId === 'string') {
        body.append(el('div', { class: 'dsh-au-inline' },
          el('span', { class: 'dsh-au-hint dsh-au-mono' }, run.sessionId),
          openSession === null ? null : el('button', {
            class: 'dsh-au-btn', 'data-size': 'sm', type: 'button',
            onclick: () => {
              try {
                openSession(run.sessionId)
                frame.close()
                setOpen(false)
              } catch (error) {
                toast('打不开这个会话：' + messageOf(error))
              }
            },
          }, '打开会话')))
      }
      if (typeof run.taskId === 'string') {
        body.append(el('div', { class: 'dsh-au-hint' }, '任务看板卡片：' + run.taskId))
      }
    })()
  }

  // ---------------------------------------------------------------- settings
  /** Global settings: the master switch, the guard rails, and the preamble text. */
  function openSettings() {
    const current = model.settings ?? {}
    const patch = {}
    const frame = openModalFrame('自动化设置', { width: 'md' })
    const numberField = (labelText, key, min, max, hint) => {
      const input = el('input', {
        class: 'dsh-au-input', type: 'number', min: String(min), max: String(max), style: 'width:110px',
        value: String(current[key] ?? min),
        oninput: (event) => {
          const parsed = Number.parseInt(event.target.value, 10)
          if (Number.isInteger(parsed)) patch[key] = parsed
        },
      })
      return field(labelText, input, hint)
    }
    const preambleArea = el('textarea', {
      class: 'dsh-au-textarea', style: 'min-height:150px',
      oninput: (event) => {
        patch.preamble = event.target.value
      },
    })
    preambleArea.value = current.preamble ?? ''

    frame.body.append(
      switchRow('定时触发总开关', current.enabled !== false,
        '关掉后所有计划都不再到点执行，「立即运行」不受影响。', (value) => {
          patch.enabled = value
        }),
      numberField('同时最多运行几次', 'maxConcurrentRuns', 1, 8,
        '超过上限的触发会被跳过并记一条。每一次运行都是一个独立的 dsh 进程。'),
      numberField('默认超时（分钟）', 'defaultTimeoutMinutes', 1, 720, '新建自动化时的默认值。'),
      numberField('每条保留多少运行记录', 'keepRunsPerAutomation', 1, 200, '超出的旧记录会被删掉；正在运行的那条永不删除。'),
      numberField('连续失败多少次后自动暂停', 'autoDisableAfterFailures', 0, 100,
        '0 表示不自动暂停。手动重新启用会把连败计数清零。'),
      field('无人值守说明', preambleArea, '会加在提示词前面（可在每条自动化里单独关掉）。'),
    )
    frame.foot.append(
      el('div', { class: 'dsh-au-spacer' }),
      el('button', { class: 'dsh-au-btn', type: 'button', onclick: frame.close }, '取消'),
      el('button', {
        class: 'dsh-au-btn', 'data-variant': 'primary', type: 'button',
        onclick: async () => {
          const done = await guard('settings', () => post('/settings', patch), '已保存')
          if (done) frame.close()
        },
      }, '保存'),
    )
  }

  // --------------------------------------------------------------------- sse
  let source = null
  let sseTimer = null

  /**
   * Subscribe to committed host changes. The panel refetches on any change rather
   * than applying deltas: the whole state is one small local read, and reconciling
   * by revision means a missed frame costs nothing.
   */
  function startSse() {
    if (typeof EventSource === 'undefined' || source !== null) return
    try {
      source = new EventSource(SSE_PATH)
    } catch (error) {
      console.warn(LOG + ' SSE unavailable:', messageOf(error))
      return
    }
    source.addEventListener('open', () => {
      model.connected = true
      emit()
    })
    source.addEventListener('hello', () => {
      model.connected = true
      // A reconnect may have missed frames; reconcile by refetching once.
      if (model.open) void refresh()
      emit()
    })
    source.addEventListener('change', (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        payload = null
      }
      if (payload !== null && payload.revision === model.revision) return
      if (model.open || !model.booted) void refresh()
      else model.revision = payload?.revision ?? model.revision
    })
    source.addEventListener('error', () => {
      // EventSource reconnects on its own; only the badge changes.
      model.connected = false
      emit()
    })
  }

  function stopSse() {
    if (source !== null) {
      try {
        source.close()
      } catch { /* already closed */ }
      source = null
    }
    if (sseTimer !== null) {
      clearInterval(sseTimer)
      sseTimer = null
    }
  }

  // ---------------------------------------------------------------- rendering
  let renderQueued = false

  /** One coalesced repaint per task: several model writes cost one render. */
  function modelListener() {
    if (renderQueued) return
    renderQueued = true
    Promise.resolve().then(() => {
      renderQueued = false
      try {
        renderEntry()
        if (panelEl !== null) {
          renderHeader()
          renderList()
        }
      } catch (error) {
        console.warn(LOG + ' render failed:', messageOf(error))
      }
    })
  }

  function bindModelListener() {
    listeners.add(modelListener)
  }

  function unbindModelListener() {
    listeners.delete(modelListener)
  }

  // --------------------------------------------------------------------- boot
  const bootState = { running: false }

  /** DSH web-shell entry: mount the sidebar entry + panel view, then listen. */
  function apply(ctx) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (bootState.running) return
    bootState.running = true
    const state = { disposed: false }
    let observer = null
    let mountTimer = null
    let repaintTimer = null
    let onActivate = null
    let onKeyDown = null
    let onDocClick = null

    function ensureMounted() {
      if (state.disposed) return
      try {
        if (entry === null) entry = createEntry()
        placeEntry()
        if (conversationColumn() !== undefined) {
          ensureView()
          if (view !== null && view.firstElementChild === null) buildPanelDom()
        }
      } catch (error) {
        console.warn(LOG + ' seat mount failed:', messageOf(error))
      }
    }

    function dispose() {
      if (state.disposed) return
      state.disposed = true
      if (mountTimer !== null) clearInterval(mountTimer)
      if (repaintTimer !== null) clearInterval(repaintTimer)
      if (observer !== null) {
        try {
          observer.disconnect()
        } catch { /* noop */ }
      }
      if (onActivate !== null) document.removeEventListener(ACTIVATE_EVENT, onActivate)
      if (onKeyDown !== null) document.removeEventListener('keydown', onKeyDown)
      if (onDocClick !== null) document.removeEventListener('click', onDocClick, true)
      while (overlays.length > 0) overlays[overlays.length - 1].close()
      unbindModelListener()
      stopSse()
      document.documentElement.removeAttribute(OPEN_ATTR)
      model.open = false
      model.connected = false
      model.booted = false
      model.automations = []
      model.runs = []
      model.runsByAutomation = {}
      model.expanded = null
      if (entry !== null) {
        try {
          entry.remove()
        } catch { /* noop */ }
        entry = null
      }
      if (view !== null) {
        try {
          view.remove()
        } catch { /* noop */ }
        view = null
      }
      panelEl = null
      headEl = null
      row1El = null
      row2El = null
      bodyEl = null
      const style = document.getElementById(STYLE_ID)
      if (style !== null) style.remove()
      bootState.running = false
    }

    try {
      injectStyles()
      bindModelListener()
      ensureMounted()
      modelListener()
      // The panel shows next-run and "3 分钟前" times, so it needs a slow repaint
      // even when nothing changes on the host. Only while it is open.
      repaintTimer = setInterval(() => {
        if (model.open) modelListener()
      }, 30_000)
      // The badge is worth having before the panel is ever opened: it is how a
      // user notices a failing automation.
      void refresh()
      startSse()
      observer = new MutationObserver(() => ensureMounted())
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
      mountTimer = setInterval(() => ensureMounted(), 3000)

      onActivate = (event) => {
        if (state.disposed) return
        if (event.detail !== undefined && event.detail !== PANEL_NAME && model.open) setOpen(false)
      }
      onKeyDown = (event) => {
        if (state.disposed || event.key !== 'Escape') return
        // Escape closes the topmost overlay only — never the panel itself, and
        // never two layers at once.
        const top = overlays.length === 0 ? undefined : overlays[overlays.length - 1]
        if (top === undefined) return
        event.preventDefault()
        event.stopPropagation()
        top.close()
      }
      onDocClick = (event) => {
        // The panel occupies the conversation column, so any click that lands on
        // the shell's own chrome (a session in the sidebar, "new session") means
        // the user wants the conversation back.
        if (state.disposed || !model.open) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest(ENTRY_SELECTOR + ', [data-dsh-au-view], .dsh-au-modal-backdrop, .dsh-au-toast-wrap') !== null) return
        setOpen(false)
      }
      document.addEventListener(ACTIVATE_EVENT, onActivate)
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('click', onDocClick, true)

      // Jumping to a produced session is the one thing this panel cannot do on its
      // own; the shell's session service is optional, and the button is offered
      // only when it is really there.
      if (ctx !== undefined && ctx !== null && typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sessions'], (sessionCtx) => {
            const service = sessionCtx?.sessions
            if (service === undefined || service === null || typeof service.open !== 'function') return undefined
            openSession = (id) => service.open(id)
            return () => {
              openSession = null
            }
          })
        } catch (error) {
          console.warn(LOG + ' no session service:', messageOf(error))
        }
      }

      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, PLUGIN_ID + ': client mount')
      } else {
        window.addEventListener('beforeunload', dispose, { once: true })
      }
    } catch (error) {
      console.error(LOG + ' client boot failed:', messageOf(error))
      dispose()
    }
  }

  // ---------------------------------------------------------------- export
  // The wrap step evaluates this file inside window.__ModuleLoader__.load with a
  // CommonJS `module` in scope; a plain Node require() gets the same shape.
  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = {
      name: PLUGIN_ID + '/client',
      inject: [],
      apply,
    }
  }
})();
