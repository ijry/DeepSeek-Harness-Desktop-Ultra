/**
 * The stylesheet, injected once into document.head.
 *
 * Colors, sizes and spacing are lifted from the reference plugin so the port
 * looks the same: the light values come from MenuGit's src/style.scss
 * (`--layout-border-color: #eaeaea`, `--toolbar-bg-color: #f7f7f7`, the nine
 * git-diff tokens, …) and the dark values from its `html.dark` block. The
 * reference got them from Element Plus and the host shell; here they are declared
 * on the panel root instead, because this bundle ships no component library.
 *
 * Everything is namespaced `dsh-og-` and scoped under `.dsh-og-panel` (or the
 * overlay classes) so it cannot leak into the DSH shell around it.
 */
const STYLES = `
.dsh-og-panel, .dsh-og-overlay {
  --og-border: #eaeaea;
  --og-border-light: #eff1f6;
  --og-toolbar: #f7f7f7;
  --og-toolbar-active: #ffffff;
  --og-sidebar: #fafafa;
  --og-statusbar: #f7f7f7;
  --og-panel-head: #f5f7fa;
  --og-bg: #ffffff;
  --og-fill: #f0efef;
  --og-fill-hover: #f5f7fa;
  --og-text: #303133;
  --og-text-2: #606266;
  --og-text-3: #909399;
  --og-primary: #2370c6;
  --og-primary-soft: rgba(35, 112, 198, .1);
  --og-primary-line: rgba(35, 112, 198, .28);
  --og-success: #1f9d57;
  --og-warning: #d68a1c;
  --og-danger: #d33c4c;
  --og-info: #7f8fa4;
  --og-shadow: 0 8px 20px rgba(0, 0, 0, .12);
  --og-shadow-lg: 0 12px 34px rgba(15, 23, 42, .2);
  --og-add-bg: #d8fce0;
  --og-add-text: #004734;
  --og-add-line: #34d058;
  --og-del-bg: #fad1e6;
  --og-del-text: #a1006e;
  --og-del-line: #d73aa8;
  --og-meta-bg: #f1f8ff;
  --og-meta-text: #586069;
  --og-meta-line: #79b8ff;
  --og-gutter-bg: #f7f7f7;
  --og-gutter-text: #b3b3b3;
  --og-context-bg: #fafbfc;
  --og-context-text: #24292e;
  --og-mono: Menlo, Monaco, Consolas, "Courier New", monospace;
}
@media (prefers-color-scheme: dark) {
  .dsh-og-panel, .dsh-og-overlay {
    --og-border: rgba(255, 255, 255, .1);
    --og-border-light: rgba(255, 255, 255, .06);
    --og-toolbar: #232338;
    --og-toolbar-active: rgba(255, 255, 255, .2);
    --og-sidebar: #232338;
    --og-statusbar: #232338;
    --og-panel-head: rgba(255, 255, 255, .1);
    --og-bg: #232338;
    --og-fill: rgba(255, 255, 255, .05);
    --og-fill-hover: rgba(255, 255, 255, .08);
    --og-text: #e8ebf1;
    --og-text-2: rgba(232, 235, 241, .72);
    --og-text-3: rgba(232, 235, 241, .48);
    --og-primary: #4f94e8;
    --og-primary-soft: rgba(79, 148, 232, .16);
    --og-primary-line: rgba(79, 148, 232, .38);
    --og-success: #3fb06b;
    --og-warning: #e0a13c;
    --og-danger: #e25563;
    --og-info: #7f8fa4;
    --og-shadow: 0 8px 20px rgba(0, 0, 0, .5);
    --og-shadow-lg: 0 12px 34px rgba(0, 0, 0, .55);
    --og-add-bg: #00563f;
    --og-add-text: #e6ffec;
    --og-add-line: #17a438;
    --og-del-bg: #90277d;
    --og-del-text: #ffeef0;
    --og-del-line: #d23ad7;
    --og-meta-bg: rgba(79, 148, 232, .12);
    --og-meta-text: #e8ebf1;
    --og-meta-line: #79b8ff;
    --og-gutter-bg: rgba(255, 255, 255, .04);
    --og-gutter-text: #b3b3b3;
    --og-context-bg: #232338;
    --og-context-text: rgba(232, 235, 241, .82);
  }
}

/* ----------------------------------------------------- sidebar entry row */
.dsh-og-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-text-secondary, #7f8fa4); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left; box-sizing: border-box;
}
.dsh-og-entry:hover { background: var(--dsw-hover, rgba(128, 128, 128, .12)); color: var(--dsw-text-primary, inherit); }
.dsh-og-entry[data-active="true"] {
  background: var(--dsw-active, rgba(128, 128, 128, .18));
  color: var(--dsw-text-primary, inherit); font-weight: 500;
}
.dsh-og-entry-icon { display: inline-flex; flex: none; color: #f05033; }
.dsh-og-entry-label { flex: none; }
.dsh-og-entry-stats {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; line-height: 1; color: rgba(127, 143, 164, .9);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
[data-sidebar-collapsed] [data-dsh-otools-git-entry],
[class*="_collapsed"] [data-dsh-otools-git-entry] {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0;
  justify-content: center; gap: 0; text-align: center;
}
[data-sidebar-collapsed] [data-dsh-otools-git-entry] .dsh-og-entry-label,
[data-sidebar-collapsed] [data-dsh-otools-git-entry] .dsh-og-entry-stats,
[class*="_collapsed"] [data-dsh-otools-git-entry] .dsh-og-entry-label,
[class*="_collapsed"] [data-dsh-otools-git-entry] .dsh-og-entry-stats { display: none; }

/* ------------------------------------------- center-column takeover + shell */
html[data-dsh-og-open] [data-pane="conversation"] > *:not([data-dsh-og-view]),
html[data-dsh-og-open] [class*="centerCol"] > *:not([data-dsh-og-view]),
html[data-dsh-og-open] .dshDesktopConversationSurface > *:not([data-dsh-og-view]) { display: none !important; }
.dsh-og-view { display: none; }
html[data-dsh-og-open] .dsh-og-view {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
}
.dsh-og-panel {
  display: flex; flex-direction: row; height: 100%; min-height: 0; width: 100%;
  overflow: hidden; box-sizing: border-box;
  background: var(--og-sidebar); color: var(--og-text);
  font-size: 13px; line-height: 1.5;
}
.dsh-og-panel *, .dsh-og-overlay * { box-sizing: border-box; }

/* --------------------------------------------------------------- sidebar */
.dsh-og-side {
  position: relative; flex-shrink: 0; height: 100%; display: flex; flex-direction: column;
  padding: 10px 0 0; border-right: 1px solid var(--og-border); background: var(--og-sidebar);
}
.dsh-og-side-head {
  display: flex; align-items: center; gap: 6px; padding: 0 10px 8px;
  border-bottom: 1px solid var(--og-border);
}
.dsh-og-side-title { font-size: 12px; font-weight: 600; color: var(--og-text-3); flex: 1; }
.dsh-og-tree { flex: 1; overflow: auto; padding: 6px 6px 12px; }
.dsh-og-repo {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; margin-bottom: 2px;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer;
  transition: background-color .18s ease, border-color .18s ease;
}
.dsh-og-repo:hover { background: var(--og-fill-hover); }
.dsh-og-repo[data-active="true"] {
  background: var(--og-primary-soft); border-color: var(--og-primary-line);
}
.dsh-og-repo[data-repo="false"] { opacity: .55; cursor: default; }
.dsh-og-repo-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-og-repo-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 500;
}
.dsh-og-repo-meta {
  display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--og-text-3);
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden;
}
.dsh-og-repo-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--og-warning); flex: none; }
.dsh-og-repo-children { padding: 2px 0 4px 18px; display: flex; flex-direction: column; gap: 2px; }
.dsh-og-repo-child {
  display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px;
  font-size: 12px; color: var(--og-text-2); cursor: pointer; min-width: 0;
}
.dsh-og-repo-child:hover { background: var(--og-fill-hover); }
.dsh-og-repo-child[data-active="true"] { background: var(--og-primary-soft); color: var(--og-text); }
.dsh-og-repo-child-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ------------------------------------------------------------- resizers */
.dsh-og-resizer { position: relative; flex: none; touch-action: none; z-index: 5; }
.dsh-og-resizer-x { width: 8px; margin: 0 -3px; cursor: col-resize; align-self: stretch; }
.dsh-og-resizer-y { height: 8px; margin: -3px 0; cursor: row-resize; }
.dsh-og-resizer::before {
  content: ''; position: absolute; background: var(--og-border); transition: background-color .15s ease;
}
.dsh-og-resizer-x::before { left: 50%; top: 0; bottom: 0; width: 1px; transform: translateX(-50%); }
.dsh-og-resizer-y::before { top: 50%; left: 0; right: 0; height: 1px; transform: translateY(-50%); }
.dsh-og-resizer:hover::before, .dsh-og-resizer[data-dragging="true"]::before {
  background: var(--og-primary); box-shadow: 0 0 0 1px var(--og-primary-soft);
}
/* ---------------------------------------------------------------- main */
.dsh-og-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%;
  background: var(--og-sidebar);
}
.dsh-og-toolbar {
  display: flex; align-items: stretch; gap: 2px; height: 55px; flex: none;
  padding: 0 8px; background: var(--og-toolbar);
  border-bottom: 1px solid var(--og-border); overflow-x: auto; scrollbar-width: none;
}
.dsh-og-toolbar::-webkit-scrollbar { display: none; }
.dsh-og-toolbar-group { display: flex; align-items: center; gap: 2px; }
.dsh-og-toolbar-group.dsh-og-right { margin-left: auto; }
.dsh-og-toolbar-sep { width: 1px; align-self: center; height: 26px; background: var(--og-border); margin: 0 6px; }
.dsh-og-tbtn {
  position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; height: 45px; min-width: 52px; padding: 0 10px; align-self: center;
  border: 0; border-bottom: 1px solid transparent; border-radius: 0; background: transparent;
  color: var(--og-text-2); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap;
  transition: background-color .15s ease, color .15s ease;
}
.dsh-og-tbtn:hover:not(:disabled) { background: var(--og-fill-hover); color: var(--og-text); }
.dsh-og-tbtn[data-active="true"] {
  background: var(--og-toolbar-active); border-bottom-color: var(--og-primary); color: var(--og-text);
}
.dsh-og-tbtn:disabled { opacity: .4; cursor: not-allowed; }
.dsh-og-tbtn-icon { display: inline-flex; width: 22px; height: 22px; }
.dsh-og-tbtn-icon svg { width: 100%; height: 100%; }
.dsh-og-tbtn-badge {
  position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 999px; background: var(--og-danger); color: #fff;
  font-size: 10px; line-height: 15px; text-align: center; font-variant-numeric: tabular-nums;
}
.dsh-og-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 12px; overflow: hidden; }
.dsh-og-pane { flex: 1; min-height: 0; display: none; flex-direction: column; padding: 10px 0 0; }
.dsh-og-pane[data-active="true"] { display: flex; }

/* ------------------------------------------------------------ status bar */
.dsh-og-statusbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px; flex: none;
  padding: 3px 10px; font-size: 11px;
  background: var(--og-statusbar); border-top: 1px solid var(--og-border);
}
.dsh-og-status-item { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dsh-og-status-label { font-weight: 700; color: var(--og-text-3); }
.dsh-og-status-value {
  color: var(--og-primary); max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* ---------------------------------------------------------------- widgets */
.dsh-og-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 26px; padding: 0 11px; border: 1px solid var(--og-border);
  border-radius: 6px; background: var(--og-bg); color: var(--og-text-2);
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dsh-og-btn:hover:not(:disabled) { border-color: var(--og-primary-line); color: var(--og-primary); }
.dsh-og-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-og-btn[data-kind="primary"] { background: var(--og-primary); border-color: var(--og-primary); color: #fff; }
.dsh-og-btn[data-kind="primary"]:hover:not(:disabled) { filter: brightness(1.1); color: #fff; }
.dsh-og-btn[data-kind="danger"] { background: var(--og-danger); border-color: var(--og-danger); color: #fff; }
.dsh-og-btn[data-kind="danger"]:hover:not(:disabled) { filter: brightness(1.1); color: #fff; }
.dsh-og-btn[data-kind="warning"] { background: var(--og-warning); border-color: var(--og-warning); color: #fff; }
.dsh-og-btn[data-kind="warning"]:hover:not(:disabled) { filter: brightness(1.1); color: #fff; }
.dsh-og-btn[data-kind="text"] { border-color: transparent; background: transparent; padding: 0 6px; }
.dsh-og-btn[data-kind="text"]:hover:not(:disabled) { background: var(--og-fill-hover); }
.dsh-og-btn[data-kind="link"] {
  border-color: transparent; background: transparent; color: var(--og-primary); padding: 0 4px; height: auto;
}
.dsh-og-btn[data-kind="link"]:hover:not(:disabled) { text-decoration: underline; }
.dsh-og-btn[data-size="mini"] { height: 22px; padding: 0 8px; font-size: 11px; }
.dsh-og-btn-icon { display: inline-flex; width: 14px; height: 14px; }
.dsh-og-btn-icon svg { width: 100%; height: 100%; }
.dsh-og-btn[data-busy="true"] { pointer-events: none; opacity: .7; }

.dsh-og-input, .dsh-og-select, .dsh-og-textarea {
  height: 26px; padding: 0 8px; border: 1px solid var(--og-border); border-radius: 6px;
  background: var(--og-bg); color: var(--og-text); font: inherit; font-size: 12px; min-width: 0;
}
.dsh-og-textarea { height: auto; padding: 6px 8px; resize: vertical; line-height: 1.55; font-size: 13px; }
.dsh-og-input:focus, .dsh-og-select:focus, .dsh-og-textarea:focus {
  outline: none; border-color: var(--og-primary); box-shadow: 0 0 0 2px var(--og-primary-soft);
}
.dsh-og-input:disabled, .dsh-og-select:disabled, .dsh-og-textarea:disabled {
  background: var(--og-fill); color: var(--og-text-3); cursor: not-allowed;
}
.dsh-og-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; user-select: none; }
.dsh-og-check input { accent-color: var(--og-primary); margin: 0; }
.dsh-og-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.dsh-og-field-label { font-size: 12px; color: var(--og-text-2); font-weight: 500; }
.dsh-og-field-hint { font-size: 11px; color: var(--og-text-3); line-height: 1.5; }
.dsh-og-tag {
  display: inline-flex; align-items: center; gap: 3px; height: 20px; padding: 0 7px;
  border-radius: 4px; font-size: 11px; line-height: 1; white-space: nowrap;
  border: 1px solid transparent; background: var(--og-fill); color: var(--og-text-2);
}
.dsh-og-tag[data-tone="success"] { background: rgba(31, 157, 87, .12); color: var(--og-success); border-color: rgba(31, 157, 87, .3); }
.dsh-og-tag[data-tone="warning"] { background: rgba(214, 138, 28, .12); color: var(--og-warning); border-color: rgba(214, 138, 28, .3); }
.dsh-og-tag[data-tone="danger"] { background: rgba(211, 60, 76, .12); color: var(--og-danger); border-color: rgba(211, 60, 76, .3); }
.dsh-og-tag[data-tone="primary"] { background: var(--og-primary-soft); color: var(--og-primary); border-color: var(--og-primary-line); }
.dsh-og-tag[data-clickable="true"] { cursor: pointer; }
.dsh-og-tag[data-clickable="true"]:hover { filter: brightness(1.06); }

.dsh-og-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  flex: 1; min-height: 120px; padding: 24px; text-align: center;
  color: var(--og-text-3); font-size: 13px;
}
.dsh-og-empty-icon { opacity: .5; }
.dsh-og-loading { padding: 16px; text-align: center; color: var(--og-text-3); font-size: 12px; }

.dsh-og-toast-wrap {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 8px; z-index: 2147483000; pointer-events: none;
}
.dsh-og-toast {
  min-width: 220px; max-width: 60vw; padding: 8px 14px; border-radius: 8px;
  background: #1f2430; color: #f2f5fa; font-size: 13px; box-shadow: var(--og-shadow-lg);
  border-left: 3px solid var(--og-info); white-space: pre-wrap; word-break: break-word;
}
.dsh-og-toast[data-kind="error"] { border-left-color: var(--og-danger); }
.dsh-og-toast[data-kind="success"] { border-left-color: var(--og-success); }
.dsh-og-toast[data-kind="warning"] { border-left-color: var(--og-warning); }

.dsh-og-alert {
  display: flex; flex-direction: column; gap: 4px; padding: 7px 10px; border-radius: 6px;
  font-size: 12px; line-height: 1.6; border: 1px solid transparent;
}
.dsh-og-alert[data-tone="info"] { background: var(--og-primary-soft); border-color: var(--og-primary-line); color: var(--og-text); }
.dsh-og-alert[data-tone="warning"] { background: rgba(214, 138, 28, .12); border-color: rgba(214, 138, 28, .32); color: var(--og-text); }
.dsh-og-alert[data-tone="error"] { background: rgba(211, 60, 76, .12); border-color: rgba(211, 60, 76, .32); color: var(--og-text); }
.dsh-og-alert[data-tone="success"] { background: rgba(31, 157, 87, .12); border-color: rgba(31, 157, 87, .32); color: var(--og-text); }
.dsh-og-alert-title { font-weight: 600; }
/* ----------------------------------------------------- dialogs & dropdowns */
.dsh-og-overlay {
  position: fixed; inset: 0; z-index: 2147482900;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 8vh 16px 16px; background: rgba(15, 23, 42, .38);
  color: var(--og-text); font-size: 13px; overflow: auto;
}
.dsh-og-dialog {
  width: 540px; max-width: 100%; max-height: 84vh; display: flex; flex-direction: column;
  background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 10px;
  box-shadow: var(--og-shadow-lg); overflow: hidden;
}
.dsh-og-dialog[data-width="wide"] { width: 760px; }
.dsh-og-dialog[data-width="xwide"] { width: 960px; }
.dsh-og-dialog-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--og-border); background: var(--og-panel-head);
}
.dsh-og-dialog-title { flex: 1; font-size: 14px; font-weight: 600; }
.dsh-og-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
.dsh-og-dialog-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  padding: 10px 16px; border-top: 1px solid var(--og-border);
}
.dsh-og-dialog-foot-left { margin-right: auto; display: flex; gap: 8px; align-items: center; }

.dsh-og-drawer {
  margin-left: auto; height: 100%; width: 900px; max-width: 100%;
  display: flex; flex-direction: column; background: var(--og-bg);
  border-left: 1px solid var(--og-border); box-shadow: var(--og-shadow-lg);
}
.dsh-og-overlay[data-drawer="true"] { padding: 0; align-items: stretch; }

.dsh-og-menu {
  position: fixed; z-index: 2147483100; min-width: 168px; padding: 5px 0;
  background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 7px;
  box-shadow: var(--og-shadow); overflow: hidden;
}
.dsh-og-menu-item {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  font-size: 13px; line-height: 18px; color: var(--og-text); cursor: pointer;
  transition: background-color .15s ease;
}
.dsh-og-menu-item:hover { background: var(--og-fill-hover); }
.dsh-og-menu-item[data-tone="danger"] { color: var(--og-danger); }
.dsh-og-menu-item[data-disabled="true"] { opacity: .4; pointer-events: none; }
.dsh-og-menu-sep { height: 1px; margin: 4px 0; background: var(--og-border); }
.dsh-og-menu-head { padding: 6px 14px 5px; font-size: 11px; color: var(--og-text-3); }
/* ----------------------------------------------------------------- tables */
.dsh-og-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsh-og-table thead th {
  position: sticky; top: 0; z-index: 2; text-align: left; font-weight: 600;
  padding: 6px 8px; background: var(--og-panel-head); color: var(--og-text-2);
  border-bottom: 1px solid var(--og-border); white-space: nowrap;
}
.dsh-og-table tbody td {
  padding: 4px 8px; border-bottom: 1px solid var(--og-border-light);
  vertical-align: middle; line-height: 1.35;
}
.dsh-og-table tbody tr { cursor: default; }
.dsh-og-table tbody tr[data-clickable="true"] { cursor: pointer; }
.dsh-og-table tbody tr:hover > td { background: var(--og-fill-hover); }
.dsh-og-table tbody tr[data-active="true"] > td { background: var(--og-primary-soft); }
.dsh-og-table tbody tr[data-selected="true"] > td { background: var(--og-primary-soft); }
.dsh-og-table-scroll { flex: 1; min-height: 0; overflow: auto; }
.dsh-og-cell-mono { font-family: var(--og-mono); font-size: 11px; color: var(--og-text-2); }
.dsh-og-cell-ellipsis { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-og-num { font-variant-numeric: tabular-nums; }
.dsh-og-adds { color: var(--og-success); }
.dsh-og-dels { color: var(--og-danger); }

/* ------------------------------------------------------------ status panel */
.dsh-og-status { flex: 1; min-height: 0; display: flex; flex-direction: row; }
.dsh-og-status-files { flex: none; min-width: 0; display: flex; flex-direction: column; }
.dsh-og-status-sections { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.dsh-og-section { display: flex; flex-direction: column; min-height: 0; }
.dsh-og-section-head {
  display: flex; align-items: center; gap: 6px; flex: none; padding: 4px 2px 6px;
  position: sticky; top: 0; z-index: 3; background: var(--og-sidebar);
}
.dsh-og-section-title { font-size: 13px; font-weight: 600; margin: 0; }
.dsh-og-section-count { font-size: 11px; color: var(--og-text-3); font-variant-numeric: tabular-nums; }
.dsh-og-section-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.dsh-og-section-body { flex: none; display: flex; flex-direction: column; padding-bottom: 8px; }
.dsh-og-file {
  display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 7px;
  cursor: pointer; min-width: 0; transition: background-color .15s ease;
}
.dsh-og-file:hover { background: var(--og-fill-hover); }
.dsh-og-file:hover .dsh-og-file-actions { opacity: 1; }
.dsh-og-file[data-active="true"] { background: var(--og-primary-soft); }
.dsh-og-file[data-selected="true"] { background: var(--og-primary-soft); }
.dsh-og-file-check { flex: none; display: inline-flex; }
.dsh-og-file-check input { accent-color: var(--og-primary); margin: 0; cursor: pointer; }
.dsh-og-file-icon { flex: none; width: 16px; height: 16px; display: inline-flex; }
.dsh-og-file-icon svg { width: 100%; height: 100%; }
.dsh-og-file-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;
}
.dsh-og-file-dir { color: var(--og-text-3); }
.dsh-og-file-mark {
  flex: none; width: 18px; text-align: center; font-family: var(--og-mono);
  font-size: 11px; font-weight: 700;
}
.dsh-og-file-mark[data-letter="A"], .dsh-og-file-mark[data-letter="?"] { color: var(--og-success); }
.dsh-og-file-mark[data-letter="M"], .dsh-og-file-mark[data-letter="T"] { color: var(--og-primary); }
.dsh-og-file-mark[data-letter="D"] { color: var(--og-danger); }
.dsh-og-file-mark[data-letter="R"], .dsh-og-file-mark[data-letter="C"] { color: #7e22ce; }
.dsh-og-file-mark[data-letter="U"] { color: var(--og-danger); }
.dsh-og-file-stat { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; display: flex; gap: 4px; }
.dsh-og-file-actions { flex: none; display: flex; gap: 2px; opacity: 0; transition: opacity .15s ease; }
.dsh-og-file-act {
  width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 5px; background: transparent; color: var(--og-text-3); cursor: pointer;
}
.dsh-og-file-act:hover { background: var(--og-fill); color: var(--og-text); }
.dsh-og-file-act svg { width: 13px; height: 13px; }
.dsh-og-dirnode {
  display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px;
  cursor: pointer; color: var(--og-text-2); font-size: 12px;
}
.dsh-og-dirnode:hover { background: var(--og-fill-hover); }
.dsh-og-dirnode-caret { width: 12px; display: inline-flex; transition: transform .15s ease; }
.dsh-og-dirnode[data-open="false"] .dsh-og-dirnode-caret { transform: rotate(-90deg); }
.dsh-og-tree-children { padding-left: 14px; }

/* ------------------------------------------------------------- commit box */
.dsh-og-commit { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 0 4px; }
.dsh-og-commit-wrap { position: relative; }
.dsh-og-commit-input { width: 100%; min-height: 78px; padding-left: 40px; }
.dsh-og-commit-ai {
  position: absolute; left: 7px; top: 7px; width: 26px; height: 26px; z-index: 2;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--og-primary-line); border-radius: 50%;
  background: var(--og-primary-soft); color: var(--og-primary); cursor: pointer;
}
.dsh-og-commit-ai:hover:not(:disabled) { background: var(--og-primary); color: #fff; }
.dsh-og-commit-ai:disabled { opacity: .45; cursor: not-allowed; }
.dsh-og-commit-ai svg { width: 15px; height: 15px; }
.dsh-og-commit-ai[data-busy="true"] svg { animation: dsh-og-spin 1s linear infinite; }
@keyframes dsh-og-spin { to { transform: rotate(360deg); } }
.dsh-og-commit-count {
  position: absolute; right: 8px; bottom: 6px; font-size: 11px; color: var(--og-text-3);
  font-variant-numeric: tabular-nums; pointer-events: none;
}
.dsh-og-commit-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-og-commit-row-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }

/* ------------------------------------------------------------- diff panel */
.dsh-og-diff { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dsh-og-diff-head {
  display: flex; align-items: center; gap: 8px; flex: none; padding: 4px 8px;
  background: var(--og-panel-head); border: 1px solid var(--og-border);
  border-radius: 6px 6px 0 0; min-width: 0;
}
.dsh-og-diff-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--og-text-2);
}
.dsh-og-diff-tools { display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-og-diff-body {
  flex: 1; min-height: 0; display: flex; flex-direction: row; align-items: flex-start;
  overflow: auto; background: var(--og-bg);
  border: 1px solid var(--og-border); border-top: 0; border-radius: 0 0 6px 6px;
}
.dsh-og-diff-gutter {
  position: sticky; left: 0; z-index: 2; flex: none; display: flex; flex-direction: column;
  user-select: none; background: var(--og-gutter-bg); border-right: 1px solid var(--og-border);
}
.dsh-og-diff-gline { display: flex; height: 1.4em; line-height: 1.4em; font-family: var(--og-mono); font-size: 10px; }
.dsh-og-diff-no {
  display: inline-block; width: 38px; padding-right: 6px; text-align: right;
  color: var(--og-gutter-text); font-size: 10px; font-family: var(--og-mono);
}
.dsh-og-diff-no-old { border-right: 1px solid var(--og-border); }
.dsh-og-diff-no::selection { background: transparent; }
.dsh-og-diff-lines { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dsh-og-diff-line {
  display: block; height: 1.4em; min-height: 1.4em; line-height: 1.4em; width: 100%;
  min-width: max-content; padding: 0 8px; margin: 0; border-left: 2px solid transparent;
  font-family: var(--og-mono); font-size: 10px; white-space: pre;
}
.dsh-og-diff-line[data-kind="add"] { background: var(--og-add-bg); color: var(--og-add-text); border-left-color: var(--og-add-line); }
.dsh-og-diff-line[data-kind="del"] { background: var(--og-del-bg); color: var(--og-del-text); border-left-color: var(--og-del-line); }
.dsh-og-diff-line[data-kind="meta"],
.dsh-og-diff-line[data-kind="hunk"] {
  background: var(--og-meta-bg); color: var(--og-meta-text);
  border-left-color: var(--og-meta-line); font-style: italic;
}
.dsh-og-diff-line[data-kind="context"] { background: var(--og-context-bg); color: var(--og-context-text); }
.dsh-og-diff-empty {
  display: flex; align-items: center; justify-content: center; flex: 1; min-height: 120px;
  color: var(--og-text-3); font-style: italic; font-size: 12px;
}
.dsh-og-diff-image { display: flex; gap: 14px; padding: 14px; flex-wrap: wrap; }
.dsh-og-diff-image-card {
  flex: 1; min-width: 220px; border: 1px solid var(--og-border); border-radius: 10px; overflow: hidden;
}
.dsh-og-diff-image-head {
  padding: 5px 10px; font-size: 11px; color: var(--og-text-2);
  background: var(--og-panel-head); border-bottom: 1px solid var(--og-border);
}
.dsh-og-diff-image-wrap {
  display: flex; align-items: center; justify-content: center; min-height: 200px; padding: 12px;
  background-image:
    linear-gradient(45deg, rgba(148, 163, 184, .12) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, .12) 75%),
    linear-gradient(45deg, rgba(148, 163, 184, .12) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, .12) 75%);
  background-size: 20px 20px; background-position: 0 0, 10px 10px;
}
.dsh-og-diff-image-wrap img {
  max-width: 100%; max-height: 320px; box-shadow: 0 10px 28px rgba(15, 23, 42, .12);
}

/* ---------------------------------------------------------------- history */
.dsh-og-filters {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: none;
  padding-bottom: 8px; border-bottom: 1px solid var(--og-border);
}
.dsh-og-history { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsh-og-history-scroll { flex: 1; min-height: 0; overflow: auto; }
.dsh-og-history-more { padding: 9px; text-align: center; font-size: 12px; color: var(--og-text-3); cursor: pointer; }
.dsh-og-history-more:hover { background: var(--og-fill-hover); }
.dsh-og-history-more[data-done="true"] { cursor: default; }
.dsh-og-history-more[data-done="true"]:hover { background: transparent; }
.dsh-og-graph-cell { padding: 0 !important; width: 1px; }
.dsh-og-graph-svg { display: block; height: 100%; }
.dsh-og-msg-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-og-msg-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-og-chips { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dsh-og-chip {
  display: inline-flex; align-items: center; height: 17px; padding: 0 5px; border-radius: 4px;
  font-size: 10px; line-height: 1; white-space: nowrap; max-width: 160px; overflow: hidden;
  text-overflow: ellipsis; border: 1px solid transparent;
}
.dsh-og-chip[data-tone="head"] { background: rgba(211, 60, 76, .14); color: var(--og-danger); border-color: rgba(211, 60, 76, .34); }
.dsh-og-chip[data-tone="local"] { background: var(--og-primary-soft); color: var(--og-primary); border-color: var(--og-primary-line); }
.dsh-og-chip[data-tone="remote"] { background: var(--og-fill); color: var(--og-text-2); border-color: var(--og-border); }
.dsh-og-chip[data-tone="tag"] { background: rgba(214, 138, 28, .14); color: var(--og-warning); border-color: rgba(214, 138, 28, .34); }
.dsh-og-chip[data-more="true"] { cursor: pointer; }

/* ------------------------------------------------- commit detail / viewer */
.dsh-og-split { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsh-og-split-row { flex: 1; min-height: 0; display: flex; flex-direction: row; }
.dsh-og-filelist { flex: none; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-og-filelist-scroll { flex: 1; min-height: 0; overflow: auto; }
.dsh-og-detail {
  flex: none; margin-top: 10px; padding: 10px; border: 1px solid var(--og-border);
  border-radius: 8px; background: var(--og-fill); font-size: 12px;
}
.dsh-og-detail-subject { font-size: 13px; font-weight: 600; color: var(--og-text); margin-bottom: 6px; word-break: break-word; }
.dsh-og-detail-body {
  font-size: 12px; color: var(--og-text-2); white-space: pre-wrap; word-break: break-word;
  margin-bottom: 8px; max-height: 120px; overflow: auto;
}
.dsh-og-detail-line { display: flex; gap: 8px; padding: 2px 0; align-items: baseline; }
.dsh-og-detail-label { flex: none; width: 44px; color: var(--og-text-3); }
.dsh-og-detail-value { flex: 1; min-width: 0; word-break: break-all; }
.dsh-og-detail-value.dsh-og-cell-mono { font-family: var(--og-mono); }
.dsh-og-parents { display: flex; flex-wrap: wrap; gap: 6px; }

/* --------------------------------------------------------- branch / tag panes */
.dsh-og-list { flex: 1; min-height: 0; overflow: auto; }
.dsh-og-group { margin-bottom: 12px; }
.dsh-og-group-title {
  display: flex; align-items: center; gap: 6px; margin: 0 0 6px;
  font-size: 12px; font-weight: 600; color: var(--og-text-2);
}
.dsh-og-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px;
  cursor: pointer; min-width: 0; transition: background-color .15s ease;
}
.dsh-og-row:hover { background: var(--og-fill-hover); }
.dsh-og-row:hover .dsh-og-row-actions { opacity: 1; }
.dsh-og-row[data-current="true"] { background: var(--og-primary-soft); }
.dsh-og-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-og-row-sub { font-size: 11px; color: var(--og-text-3); flex: none; }
.dsh-og-row-actions { flex: none; display: flex; gap: 4px; opacity: 0; transition: opacity .15s ease; }

/* ---------------------------------------------------------- operation dialog */
.dsh-og-progress { height: 16px; border-radius: 999px; background: var(--og-fill); overflow: hidden; }
.dsh-og-progress-bar {
  height: 100%; width: 0; border-radius: 999px; background: var(--og-primary);
  transition: width .2s ease;
}
.dsh-og-progress[data-status="done"] .dsh-og-progress-bar { background: var(--og-success); }
.dsh-og-progress[data-status="failed"] .dsh-og-progress-bar { background: var(--og-danger); }
.dsh-og-progress[data-status="canceled"] .dsh-og-progress-bar { background: var(--og-warning); }
.dsh-og-op-status { text-align: center; font-weight: 600; margin: 10px 0 4px; font-size: 13px; }
.dsh-og-op-section { margin: 12px 0 0; }
.dsh-og-op-section h4 { margin: 0 0 5px; font-size: 12px; color: var(--og-text-2); font-weight: 600; }
.dsh-og-op-out {
  margin: 0; padding: 10px; max-height: 220px; overflow: auto;
  background: var(--og-fill); border: 1px solid var(--og-border); border-radius: 6px;
  font-family: var(--og-mono); font-size: 11px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; color: var(--og-text-2);
}
.dsh-og-op-line[data-tone="error"] { color: var(--og-danger); }
.dsh-og-op-line[data-tone="done"] { color: var(--og-success); }

/* ---------------------------------------------------------- settings dialog */
.dsh-og-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--og-border); margin-bottom: 14px; }
.dsh-og-tab {
  padding: 7px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--og-text-2); font: inherit; font-size: 13px; cursor: pointer;
}
.dsh-og-tab[data-active="true"] { color: var(--og-primary); border-bottom-color: var(--og-primary); font-weight: 500; }
.dsh-og-setting-row {
  display: grid; grid-template-columns: 168px 1fr; gap: 10px; align-items: center;
  padding: 7px 0; border-bottom: 1px solid var(--og-border-light);
}
.dsh-og-setting-key { font-family: var(--og-mono); font-size: 11px; color: var(--og-text-2); }
.dsh-og-setting-scope { font-size: 10px; color: var(--og-text-3); }
.dsh-og-cred-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 0;
  border-bottom: 1px solid var(--og-border-light);
}
.dsh-og-cred-host { flex: 1; min-width: 0; font-family: var(--og-mono); font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .dsh-og-panel *, .dsh-og-overlay * { transition: none !important; animation: none !important; }
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
