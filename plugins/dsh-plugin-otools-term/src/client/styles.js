/**
 * The stylesheet, injected once into document.head.
 *
 * Colours, sizes and spacing are lifted from the reference plugin so the port looks
 * the same: the light values come from MenuGit's `src/style.scss`
 * (`--layout-border-color: #eaeaea`, `--toolbar-bg-color: #f7f7f7`, the sidebar
 * hover/active fills) and the dark values from its `html.dark` block. The reference
 * got them from Element Plus and its shell; here they are declared on the panel root,
 * because this bundle ships no component library.
 *
 * Everything is namespaced `dsh-ot-` and scoped under `.dsh-ot-panel` (or the overlay
 * classes) so it cannot leak into the DSH shell around it.
 */
const STYLES = `
.dsh-ot-panel, .dsh-ot-overlay {
  --ot-border: #eaeaea; --ot-border-light: #eff1f6; --ot-toolbar: #f7f7f7; --ot-sidebar: #fafafa;
  --ot-bg: #ffffff; --ot-fill: #f0efef; --ot-fill-hover: #f5f7fa; --ot-active: #ecf3fd;
  --ot-text: #303133; --ot-text-2: #606266; --ot-text-3: #909399;
  --ot-primary: #2370c6; --ot-primary-soft: rgba(35, 112, 198, .1); --ot-primary-line: rgba(35, 112, 198, .28);
  --ot-success: #1f9d57; --ot-warning: #d68a1c; --ot-danger: #d33c4c; --ot-info: #7f8fa4;
  --ot-folder: #ffb713; --ot-file: #409eff;
  --ot-shadow: 0 8px 20px rgba(0, 0, 0, .12); --ot-shadow-lg: 0 12px 34px rgba(15, 23, 42, .2);
  --ot-mono: Menlo, Monaco, Consolas, "Courier New", monospace;
  --ot-term-bg: #1f2430;
}
@media (prefers-color-scheme: dark) {
  .dsh-ot-panel, .dsh-ot-overlay {
    --ot-border: rgba(255, 255, 255, .1); --ot-border-light: rgba(255, 255, 255, .06);
    --ot-toolbar: #232338; --ot-sidebar: #232338; --ot-bg: #1c1c2b;
    --ot-fill: rgba(255, 255, 255, .05); --ot-fill-hover: rgba(255, 255, 255, .08); --ot-active: rgba(79, 148, 232, .18);
    --ot-text: #e8ebf1; --ot-text-2: rgba(232, 235, 241, .72); --ot-text-3: rgba(232, 235, 241, .48);
    --ot-primary: #4f94e8; --ot-primary-soft: rgba(79, 148, 232, .16); --ot-primary-line: rgba(79, 148, 232, .38);
    --ot-success: #3fb06b; --ot-warning: #e0a13c; --ot-danger: #e25563;
    --ot-shadow: 0 8px 20px rgba(0, 0, 0, .5); --ot-shadow-lg: 0 12px 34px rgba(0, 0, 0, .55);
  }
}

/* ----------------------------------------------------- sidebar entry row */
.dsh-ot-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-text-secondary, #7f8fa4); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left; box-sizing: border-box;
}
.dsh-ot-entry:hover { background: var(--dsw-hover, rgba(128, 128, 128, .12)); color: var(--dsw-text-primary, inherit); }
.dsh-ot-entry[data-active="true"] { background: var(--dsw-active, rgba(128, 128, 128, .18)); color: var(--dsw-text-primary, inherit); font-weight: 500; }
.dsh-ot-entry-icon { display: inline-flex; flex: none; color: #2f9e7e; }
.dsh-ot-entry-stats { margin-left: auto; font-size: 11px; line-height: 1; color: rgba(127, 143, 164, .9); font-variant-numeric: tabular-nums; white-space: nowrap; }
[data-sidebar-collapsed] [data-dsh-ssh-entry], [class*="_collapsed"] [data-dsh-ssh-entry] {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0; justify-content: center; gap: 0;
}
[data-sidebar-collapsed] [data-dsh-ssh-entry] .dsh-ot-entry-label,
[data-sidebar-collapsed] [data-dsh-ssh-entry] .dsh-ot-entry-stats,
[class*="_collapsed"] [data-dsh-ssh-entry] .dsh-ot-entry-label,
[class*="_collapsed"] [data-dsh-ssh-entry] .dsh-ot-entry-stats { display: none; }
/* ------------------------------------------- center-column takeover + shell */
html[data-dsh-ot-open] [data-pane="conversation"] > *:not([data-dsh-ot-view]),
html[data-dsh-ot-open] [class*="centerCol"] > *:not([data-dsh-ot-view]),
html[data-dsh-ot-open] .dshDesktopConversationSurface > *:not([data-dsh-ot-view]) { display: none !important; }
.dsh-ot-view { display: none; }
html[data-dsh-ot-open] .dsh-ot-view { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.dsh-ot-panel {
  display: flex; flex-direction: row; height: 100%; min-height: 0; width: 100%; overflow: hidden;
  box-sizing: border-box; background: var(--ot-bg); color: var(--ot-text); font-size: 13px; line-height: 1.5;
}
.dsh-ot-panel *, .dsh-ot-overlay * { box-sizing: border-box; }

/* --------------------------------------------------------------- sidebar */
.dsh-ot-side { position: relative; flex: none; height: 100%; display: flex; flex-direction: column; background: var(--ot-sidebar); border-right: 1px solid var(--ot-border); overflow: hidden; }
.dsh-ot-side[data-hidden="true"] { display: none; }
.dsh-ot-side-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 8px; background: var(--ot-toolbar); border-bottom: 1px solid var(--ot-border); }
.dsh-ot-side-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-ot-side-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.15; }
.dsh-ot-side-sub { font-size: 11px; line-height: 1.35; color: var(--ot-text-3); }
.dsh-ot-side-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-ot-side-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-ot-servers { min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.dsh-ot-server {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 8px;
  background: var(--ot-bg); border-bottom: 1px solid var(--ot-border); cursor: pointer;
  transition: background-color .18s ease, box-shadow .18s ease;
}
.dsh-ot-server:hover { background: var(--ot-fill-hover); }
.dsh-ot-server[data-active="true"] { background: var(--ot-active); box-shadow: inset 3px 0 0 var(--ot-primary); }
.dsh-ot-server-main { flex: 1; min-width: 0; }
.dsh-ot-server-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-ot-server-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dsh-ot-server[data-active="true"] .dsh-ot-server-name { color: var(--ot-primary); }
.dsh-ot-dot { width: 8px; height: 8px; flex: none; border-radius: 999px; background: var(--ot-text-3); }
.dsh-ot-dot[data-state="connected"] { background: var(--ot-success); }
.dsh-ot-dot[data-state="connecting"] { background: var(--ot-warning); }
.dsh-ot-dot[data-state="error"] { background: var(--ot-danger); }
.dsh-ot-dot[data-state="local"] { background: var(--ot-file); }
.dsh-ot-server-meta { margin-top: 4px; font-size: 12px; color: var(--ot-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-server-badges { display: flex; gap: 4px; flex: none; }
.dsh-ot-menu-btn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 8px; background: transparent; color: var(--ot-text-3); cursor: pointer; }
.dsh-ot-menu-btn:hover { background: var(--ot-fill); color: var(--ot-text); }
.dsh-ot-side-empty { padding: 18px 12px; text-align: center; color: var(--ot-text-3); font-size: 12px; }

/* ------------------------------------------------------------- resizers */
.dsh-ot-resizer { position: relative; flex: none; touch-action: none; z-index: 5; }
.dsh-ot-resizer-x { width: 8px; margin: 0 -3px; cursor: col-resize; align-self: stretch; }
.dsh-ot-resizer-y { height: 8px; margin: -3px 0; cursor: row-resize; }
.dsh-ot-resizer::before { content: ''; position: absolute; background: var(--ot-border); transition: background-color .15s ease; }
.dsh-ot-resizer-x::before { left: 50%; top: 0; bottom: 0; width: 1px; transform: translateX(-50%); }
.dsh-ot-resizer-y::before { top: 50%; left: 0; right: 0; height: 1px; transform: translateY(-50%); }
.dsh-ot-resizer:hover::before, .dsh-ot-resizer[data-dragging="true"]::before { background: var(--ot-primary); box-shadow: 0 0 0 1px var(--ot-primary-soft); }
/* ------------------------------------------------------------------ main */
.dsh-ot-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-ot-toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: var(--ot-toolbar); border-bottom: 1px solid var(--ot-border); }
.dsh-ot-toolbar-left { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.dsh-ot-toolbar-title { font-size: 16px; font-weight: 600; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-toolbar-sub { font-size: 11px; line-height: 1.35; color: var(--ot-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-toolbar-group { display: flex; align-items: center; gap: 8px; flex: none; }
.dsh-ot-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 10px;
  border: 1px solid var(--ot-border); border-radius: 8px; background: var(--ot-bg); color: var(--ot-text);
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dsh-ot-btn:hover:not(:disabled) { background: var(--ot-fill-hover); border-color: var(--ot-primary-line); }
.dsh-ot-btn:disabled { opacity: .5; cursor: not-allowed; }
.dsh-ot-btn[data-icon="true"] { width: 30px; padding: 0; }
.dsh-ot-btn[data-variant="primary"] { background: var(--ot-primary); border-color: var(--ot-primary); color: #fff; }
.dsh-ot-btn[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.08); background: var(--ot-primary); }
.dsh-ot-btn[data-variant="danger"] { color: var(--ot-danger); border-color: var(--ot-danger); background: transparent; }
.dsh-ot-btn[data-variant="ghost"] { border-color: transparent; background: transparent; }
.dsh-ot-btn[data-active="true"] { background: var(--ot-primary-soft); border-color: var(--ot-primary-line); color: var(--ot-primary); }
.dsh-ot-badge { min-width: 18px; height: 18px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--ot-primary); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-ot-tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; font-size: 11px; background: var(--ot-fill); color: var(--ot-text-2); white-space: nowrap; }
.dsh-ot-tag[data-tone="success"] { background: rgba(31, 157, 87, .14); color: var(--ot-success); }
.dsh-ot-tag[data-tone="danger"] { background: rgba(211, 60, 76, .14); color: var(--ot-danger); }
.dsh-ot-tag[data-tone="warning"] { background: rgba(214, 138, 28, .16); color: var(--ot-warning); }
.dsh-ot-tag[data-tone="primary"] { background: var(--ot-primary-soft); color: var(--ot-primary); }
.dsh-ot-select { height: 30px; padding: 0 8px; border: 1px solid var(--ot-border); border-radius: 8px; background: var(--ot-bg); color: var(--ot-text); font: inherit; font-size: 12px; }
.dsh-ot-input, .dsh-ot-textarea {
  width: 100%; padding: 6px 8px; border: 1px solid var(--ot-border); border-radius: 8px;
  background: var(--ot-bg); color: var(--ot-text); font: inherit; font-size: 13px;
}
.dsh-ot-input:focus, .dsh-ot-textarea:focus { outline: none; border-color: var(--ot-primary); box-shadow: 0 0 0 2px var(--ot-primary-soft); }
.dsh-ot-textarea { resize: vertical; min-height: 72px; font-family: var(--ot-mono); }

/* ------------------------------------------------------------------ tabs */
.dsh-ot-tabs { display: flex; align-items: stretch; flex: none; overflow-x: auto; background: var(--ot-toolbar); border-bottom: 1px solid var(--ot-border); scrollbar-width: thin; }
.dsh-ot-tab { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--ot-fill); color: var(--ot-text-2); border: none; border-right: 1px solid var(--ot-border); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; max-width: 240px; }
.dsh-ot-tab[data-active="true"] { background: var(--ot-bg); color: var(--ot-primary); }
.dsh-ot-tab-label { overflow: hidden; text-overflow: ellipsis; }
.dsh-ot-tab-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--ot-text-3); }
.dsh-ot-tab-dot[data-state="running"] { background: var(--ot-success); }
.dsh-ot-tab-dot[data-state="closed"] { background: var(--ot-text-3); }
.dsh-ot-tab-dot[data-state="error"] { background: var(--ot-danger); }
.dsh-ot-tab-close { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border: none; border-radius: 4px; background: transparent; color: var(--ot-text-3); cursor: pointer; font-size: 14px; line-height: 1; }
.dsh-ot-tab-close:hover { background: var(--ot-fill-hover); color: var(--ot-danger); }
.dsh-ot-tab-add { padding: 6px 12px; font-size: 16px; line-height: 1; }

/* ------------------------------------------------------------------ body */
.dsh-ot-body { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; overflow: hidden; background: var(--ot-bg); }
.dsh-ot-panes { flex: 1; min-height: 0; position: relative; }
.dsh-ot-pane { position: absolute; inset: 0; display: none; flex-direction: column; min-height: 0; overflow: hidden; }
.dsh-ot-pane[data-active="true"] { display: flex; }
.dsh-ot-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--ot-text-3); text-align: center; padding: 20px; }
/* -------------------------------------------------------------- terminal */
.dsh-ot-term { flex: 1; min-height: 0; position: relative; padding: 4px 0 0 6px; background: var(--ot-term-bg); overflow: hidden; }
.dsh-ot-term .xterm { height: 100%; }
.dsh-ot-term-overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 13px; text-align: center; padding: 20px; z-index: 4;
}
.dsh-ot-term-overlay[data-hidden="true"] { display: none; }

/* ---------------------------------------------------------------- editor */
.dsh-ot-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 12px 12px; gap: 8px; }
.dsh-ot-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-ot-editor-path { min-width: 0; font-size: 12px; color: var(--ot-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ot-mono); }
.dsh-ot-editor-body { flex: 1; min-height: 0; display: flex; border: 1px solid var(--ot-border); border-radius: 10px; overflow: hidden; background: var(--ot-bg); }
.dsh-ot-editor-gutter { flex: none; padding: 8px 6px 8px 10px; text-align: right; color: var(--ot-text-3); background: var(--ot-fill); font-family: var(--ot-mono); font-size: 12.5px; line-height: 1.5; user-select: none; overflow: hidden; min-width: 44px; }
.dsh-ot-editor-area { flex: 1; min-width: 0; border: none; padding: 8px 10px; resize: none; background: transparent; color: var(--ot-text); font-family: var(--ot-mono); font-size: 12.5px; line-height: 1.5; tab-size: 4; white-space: pre; overflow: auto; }
.dsh-ot-editor-area:focus { outline: none; }
.dsh-ot-editor-foot { display: flex; gap: 12px; font-size: 11px; color: var(--ot-text-3); font-variant-numeric: tabular-nums; }

/* ------------------------------------------------------------------ sftp */
.dsh-ot-sftp { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--ot-border); overflow: hidden; }
.dsh-ot-sftp-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--ot-border); background: var(--ot-toolbar); }
.dsh-ot-sftp-title { font-size: 12px; font-weight: 600; color: var(--ot-text-2); }
.dsh-ot-sftp-path { padding: 4px 8px; font-size: 11px; color: var(--ot-text-3); font-family: var(--ot-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dsh-ot-sftp-search { padding: 4px 8px 6px; }
.dsh-ot-sftp-tree { flex: 1; min-height: 0; overflow: auto; padding: 2px 0 10px; }
.dsh-ot-sftp[data-drop="true"] { outline: 2px dashed var(--ot-primary); outline-offset: -4px; }
.dsh-ot-node { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: pointer; user-select: none; font-size: 12.5px; }
.dsh-ot-node:hover { background: var(--ot-fill-hover); }
.dsh-ot-node[data-active="true"] { background: var(--ot-active); color: var(--ot-primary); }
.dsh-ot-node-twist { width: 14px; flex: none; text-align: center; color: var(--ot-text-3); font-size: 10px; }
.dsh-ot-node-icon { flex: none; display: inline-flex; color: var(--ot-file); }
.dsh-ot-node-icon[data-kind="dir"] { color: var(--ot-folder); }
.dsh-ot-node-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-node-size { flex: none; font-size: 11px; color: var(--ot-text-3); font-variant-numeric: tabular-nums; }
.dsh-ot-node-link { flex: none; font-size: 11px; color: var(--ot-text-3); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-node-actions { flex: none; display: none; gap: 2px; }
.dsh-ot-node:hover .dsh-ot-node-actions { display: flex; }
.dsh-ot-sftp-hint, .dsh-ot-sftp-error { padding: 10px 12px; font-size: 12px; color: var(--ot-text-3); }
.dsh-ot-sftp-error { color: var(--ot-danger); }
.dsh-ot-search-row { display: flex; flex-direction: column; gap: 1px; padding: 5px 10px; cursor: pointer; }
.dsh-ot-search-row:hover { background: var(--ot-fill-hover); }
.dsh-ot-search-name { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.dsh-ot-search-path { font-size: 11px; color: var(--ot-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* --------------------------------------------------------------- AI bar */
.dsh-ot-ai { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--ot-border); background: var(--ot-toolbar); }
.dsh-ot-ai[data-hidden="true"] { display: none; }
.dsh-ot-ai-row { display: flex; align-items: center; gap: 8px; }
.dsh-ot-ai-row input { flex: 1; }
.dsh-ot-ai-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--ot-text-3); }
.dsh-ot-ai-out { padding: 8px 10px; border: 1px solid var(--ot-primary-line); border-radius: 8px; background: var(--ot-primary-soft); font-family: var(--ot-mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-all; max-height: 30vh; overflow: auto; }
.dsh-ot-ai-out[data-kind="explain"] { font-family: inherit; white-space: pre-wrap; word-break: normal; }
.dsh-ot-ai-danger { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border-radius: 8px; background: rgba(211, 60, 76, .12); color: var(--ot-danger); font-size: 12px; }

/* --------------------------------------------------------- transfer drawer */
.dsh-ot-drawer { position: absolute; left: 0; right: 0; bottom: 0; max-height: 46%; display: flex; flex-direction: column; background: var(--ot-bg); border-top: 1px solid var(--ot-border); box-shadow: var(--ot-shadow); z-index: 8; }
.dsh-ot-drawer[data-hidden="true"] { display: none; }
.dsh-ot-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--ot-border); }
.dsh-ot-drawer-title { font-size: 15px; font-weight: 600; }
.dsh-ot-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.dsh-ot-task { padding: 10px; border: 1px solid var(--ot-border-light); border-radius: 8px; background: var(--ot-bg); }
.dsh-ot-task-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-ot-task-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-task-line { margin-top: 5px; font-size: 11.5px; color: var(--ot-text-3); word-break: break-all; }
.dsh-ot-task-meta { margin-top: 5px; display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--ot-text-3); font-variant-numeric: tabular-nums; }
.dsh-ot-progress { margin-top: 7px; height: 8px; border-radius: 999px; background: var(--ot-fill); overflow: hidden; }
.dsh-ot-progress > span { display: block; height: 100%; background: var(--ot-primary); transition: width .2s ease; }
.dsh-ot-progress[data-state="completed"] > span { background: var(--ot-success); }
.dsh-ot-progress[data-state="failed"] > span { background: var(--ot-danger); }
.dsh-ot-task-error { margin-top: 6px; font-size: 11.5px; color: var(--ot-danger); }

/* --------------------------------------------------- menus, dialogs, toasts */
.dsh-ot-menu { position: fixed; z-index: 2147483000; min-width: 180px; max-width: 280px; padding: 4px; border: 1px solid var(--ot-border); border-radius: 10px; background: var(--ot-bg); color: var(--ot-text); box-shadow: var(--ot-shadow-lg); font-size: 13px; }
.dsh-ot-menu-title { padding: 4px 8px 6px; font-size: 11px; color: var(--ot-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ot-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-ot-menu-item:hover:not(:disabled) { background: var(--ot-fill-hover); }
.dsh-ot-menu-item:disabled { opacity: .45; cursor: not-allowed; }
.dsh-ot-menu-item[data-tone="danger"] { color: var(--ot-danger); }
.dsh-ot-menu-sep { height: 1px; margin: 4px 2px; background: var(--ot-border); }
.dsh-ot-overlay { position: fixed; inset: 0; z-index: 2147483100; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(15, 23, 42, .45); }
.dsh-ot-dialog { width: min(680px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 14px; background: var(--ot-bg); color: var(--ot-text); box-shadow: var(--ot-shadow-lg); overflow: hidden; }
.dsh-ot-dialog[data-size="small"] { width: min(440px, 100%); }
.dsh-ot-dialog[data-size="large"] { width: min(820px, 100%); }
.dsh-ot-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--ot-border); font-size: 15px; font-weight: 600; }
.dsh-ot-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsh-ot-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ot-border); }
.dsh-ot-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-ot-field > label { font-size: 12px; color: var(--ot-text-2); }
.dsh-ot-field-hint { font-size: 11px; color: var(--ot-text-3); }
.dsh-ot-row { display: flex; gap: 10px; }
.dsh-ot-row > * { flex: 1; min-width: 0; }
.dsh-ot-check { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.dsh-ot-section { border: 1px solid var(--ot-border-light); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.dsh-ot-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsh-ot-section-title { font-size: 13px; font-weight: 600; }
.dsh-ot-mono { font-family: var(--ot-mono); font-size: 12px; word-break: break-all; }
.dsh-ot-toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483200; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.dsh-ot-toast { padding: 8px 14px; border-radius: 10px; background: var(--ot-bg, #fff); color: var(--ot-text, #303133); border: 1px solid var(--ot-border, #eaeaea); box-shadow: var(--ot-shadow); font-size: 13px; max-width: 60vw; }
.dsh-ot-toast[data-tone="success"] { border-color: var(--ot-success); color: var(--ot-success); }
.dsh-ot-toast[data-tone="error"] { border-color: var(--ot-danger); color: var(--ot-danger); }
.dsh-ot-toast[data-tone="warning"] { border-color: var(--ot-warning); color: var(--ot-warning); }
@media (max-width: 860px) { .dsh-ot-toolbar { flex-wrap: wrap; } .dsh-ot-side { position: absolute; z-index: 9; height: 100%; box-shadow: var(--ot-shadow); } }
`

/** Inject the stylesheet once. */
function injectStyles() {
  if (document.getElementById(STYLE_ID) !== null) return
  document.head.append(el('style', { id: STYLE_ID, type: 'text/css' }, STYLES))
}
