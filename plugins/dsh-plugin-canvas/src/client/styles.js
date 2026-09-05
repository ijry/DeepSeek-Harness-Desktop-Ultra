/**
 * The board's stylesheet, injected once under one `<style>` id.
 *
 * Deliberately self-contained: dsh's GUI is a compiled React app whose class
 * names are build-hashed, so the only safe styling contract is "own everything
 * under .dshc-*". Where a dsh web variable exists it is used with a fallback
 * (`--dsw-*`, the same seam the taskboard plugin uses), so the board follows the
 * host theme when it can and looks right on its own when it cannot.
 *
 * Board units: every size inside a node is a plain px number matching
 * shared/units.js, never a rem — the box comes from the transformed board layer,
 * and a rem would drift from it at any host font size but the default.
 *
 * @module dsh-plugin-canvas/client/styles
 */
export const STYLE_ID = 'dsh-plugin-canvas-style'

export const STYLES = `
:root {
  --dshc-bg: #15181e; --dshc-panel: #1c212a; --dshc-panel-2: #232936;
  --dshc-border: rgba(255,255,255,.14); --dshc-border-2: rgba(255,255,255,.28);
  --dshc-text: #e8ebf1; --dshc-text-2: rgba(232,235,241,.64); --dshc-text-3: rgba(232,235,241,.4);
  --dshc-hover: rgba(255,255,255,.07); --dshc-active: rgba(255,255,255,.12);
  --dshc-shadow: 0 12px 34px rgba(0,0,0,.5); --dshc-primary: #5b8cff; --dshc-danger: #e25563;
  --dshc-ok: #3fb06b; --dshc-dot: rgba(255,255,255,.16);
  --dshc-c-neutral: #8a8f98; --dshc-c-zinc: #8b8b93; --dshc-c-slate: #7c8798; --dshc-c-stone: #928b83;
  --dshc-c-gray: #8e939b; --dshc-c-red: #e25563; --dshc-c-rose: #e2557f; --dshc-c-orange: #e0863a;
  --dshc-c-green: #3fb06b; --dshc-c-blue: #5b8cff; --dshc-c-yellow: #dcb63c; --dshc-c-violet: #a06ce0;
}
@media (prefers-color-scheme: light) {
  :root {
    --dshc-bg: #f3f5f9; --dshc-panel: #ffffff; --dshc-panel-2: #eef1f6;
    --dshc-border: rgba(15,23,42,.14); --dshc-border-2: rgba(15,23,42,.3);
    --dshc-text: #1b2430; --dshc-text-2: rgba(27,36,48,.62); --dshc-text-3: rgba(27,36,48,.4);
    --dshc-hover: rgba(15,23,42,.06); --dshc-active: rgba(15,23,42,.1);
    --dshc-shadow: 0 12px 34px rgba(15,23,42,.2); --dshc-dot: rgba(15,23,42,.18);
  }
}

/* Sidebar entry, next to the New Session family block. */
.dshc-entry { display: flex; align-items: center; gap: 8px; width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-text-secondary, var(--dshc-text-2)); font: inherit; font-size: 13px; cursor: pointer; text-align: left; box-sizing: border-box; }
.dshc-entry:hover { background: var(--dsw-hover, var(--dshc-hover)); color: var(--dsw-text-primary, var(--dshc-text)); }
.dshc-entry[data-active="true"] { background: var(--dsw-active, var(--dshc-active)); color: var(--dsw-text-primary, var(--dshc-text)); font-weight: 500; }
.dshc-entry-icon { flex: none; display: inline-flex; color: var(--dshc-primary); }
.dshc-entry-stats { margin-left: auto; font-size: 11px; color: var(--dshc-text-3); font-variant-numeric: tabular-nums; }
[data-sidebar-collapsed] .dshc-entry { justify-content: center; padding: 6px; }
[data-sidebar-collapsed] .dshc-entry-label, [data-sidebar-collapsed] .dshc-entry-stats { display: none; }

/* The view: an overlay over the conversation column, shown only when open. */
.dshc-view { position: absolute; inset: 0; z-index: 40; display: none; background: var(--dshc-bg); color: var(--dshc-text); font: inherit; }
.dshc-view[data-open="true"] { display: block; }
.dshc-surface { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: default; }
.dshc-surface[data-panning="true"] { cursor: grabbing; }
.dshc-surface[data-marquee="true"], .dshc-surface[data-marquee="true"] * { user-select: none !important; }
.dshc-board { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
.dshc-node { position: absolute; box-sizing: border-box; }
/* Every frame fills the box the board gave it, borders and padding INCLUDED: the
   wrapper's width/height are the node's real footprint, so a frame that added its
   own padding on top would push its own footer out of view. */
.dshc-node > * { box-sizing: border-box; position: relative; width: 100%; height: 100%; }
.dshc-node > .dshc-handle { position: absolute; width: 10px; height: 10px; }
.dshc-wash { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; width: auto; height: auto; }

/* Region frame. */
.dshc-region { display: flex; flex-direction: column; border: 1px solid var(--dshc-border); border-radius: 16px; background: color-mix(in srgb, var(--dshc-panel) 55%, transparent); }
.dshc-region[data-collapsed="true"] { border-radius: 999px; }
.dshc-region[data-unresolved="true"] { border-style: dashed; }
.dshc-region[data-drop="true"] { border-color: var(--dshc-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshc-primary) 40%, transparent); }
.dshc-node[data-selected="true"] > .dshc-region, .dshc-node[data-selected="true"] > .dshc-card, .dshc-node[data-selected="true"] > .dshc-note, .dshc-node[data-selected="true"] > .dshc-detail { border-color: var(--dshc-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshc-primary) 25%, transparent); }
.dshc-rhead { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px; flex: none; }
.dshc-rtitle { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-rtitle[data-muted="true"] { color: var(--dshc-text-2); }
.dshc-rname-input { flex: 1; min-width: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--dshc-text); background: var(--dshc-panel-2); border: 1px solid var(--dshc-primary); border-radius: 6px; padding: 1px 6px; }
.dshc-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-family: ui-monospace, monospace; background: color-mix(in srgb, var(--dshc-primary) 16%, transparent); color: var(--dshc-primary); }
.dshc-dot-run { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: dshc-pulse 1.6s ease-in-out infinite; }
.dshc-rcount { margin-left: auto; font-size: 11px; font-family: ui-monospace, monospace; color: var(--dshc-text-3); }
.dshc-rhint { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 12px; text-align: center; font-size: 12px; color: var(--dshc-text-2); }
.dshc-rmore { position: absolute; left: 0; right: 0; bottom: 0; height: 36px; display: flex; align-items: center; justify-content: center; gap: 6px; border-top: 1px solid var(--dshc-border); background: color-mix(in srgb, var(--dshc-panel) 80%, transparent); border-radius: 0 0 16px 16px; font: inherit; font-size: 11px; color: var(--dshc-text-2); cursor: pointer; }
.dshc-rmore:hover { color: var(--dshc-text); background: var(--dshc-hover); }

/* Session summary card, 224x132. */
.dshc-card { display: flex; flex-direction: column; height: 100%; padding: 8px 10px; border: 1px solid var(--dshc-border); border-radius: 12px; background: var(--dshc-panel); overflow: hidden; }
.dshc-card:hover { border-color: var(--dshc-border-2); }
.dshc-card[data-running="true"] { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dshc-primary) 30%, transparent); animation: dshc-breathe 2.6s ease-in-out infinite; }
.dshc-card[data-mirrored="true"] { border-color: color-mix(in srgb, var(--dshc-primary) 50%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshc-primary) 15%, transparent); }
.dshc-card[data-unresolved="true"] { border-style: dashed; opacity: .7; }
.dshc-crow { display: flex; align-items: center; gap: 6px; height: 14px; font-size: 10px; line-height: 1; color: var(--dshc-text-3); }
.dshc-cagent { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; direction: ltr; }
.dshc-ctitle { margin-top: 7px; font-size: 13px; font-weight: 500; line-height: 17.875px; max-height: 71.5px; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.dshc-cfoot { margin-top: auto; padding-top: 7px; display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; line-height: 13.75px; color: var(--dshc-text-3); }
.dshc-cfoot span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-sdot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dshc-text-3); }
.dshc-sdot[data-live="true"] { background: var(--dshc-ok); }
.dshc-sdot[data-running="true"] { background: var(--dshc-primary); animation: dshc-pulse 1.6s ease-in-out infinite; }

/* Expanded (detail) card: a read-only transcript with its own title bar. */
.dshc-detail { display: flex; flex-direction: column; height: 100%; border: 1px solid var(--dshc-border); border-radius: 16px; background: var(--dshc-panel); overflow: hidden; }
.dshc-dbar { display: flex; align-items: center; gap: 6px; height: 36px; flex: none; padding: 0 10px; border-bottom: 1px solid var(--dshc-border); cursor: grab; user-select: none; }
.dshc-dbar:active { cursor: grabbing; }
.dshc-dtitle { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-dbody { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; font-size: 12px; line-height: 1.55; user-select: text; }
.dshc-turn { margin-bottom: 10px; }
.dshc-turn-who { font-size: 10px; font-family: ui-monospace, monospace; color: var(--dshc-text-3); margin-bottom: 2px; }
.dshc-turn-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.dshc-turn[data-role="assistant"] .dshc-turn-body { color: var(--dshc-text); }
.dshc-turn[data-role="user"] .dshc-turn-body { color: var(--dshc-text); background: var(--dshc-panel-2); border-radius: 8px; padding: 6px 8px; }
.dshc-turn[data-role="tool"] .dshc-turn-body { color: var(--dshc-text-2); font-family: ui-monospace, monospace; font-size: 11px; }

/* Note. */
.dshc-note { height: 100%; border: 1px solid var(--dshc-border); border-radius: 12px; background: var(--dshc-panel); overflow: hidden; }
.dshc-note:hover { border-color: var(--dshc-border-2); }
.dshc-ntext { padding: 12px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow: hidden; height: 100%; box-sizing: border-box; }
.dshc-ntext[data-empty="true"] { color: var(--dshc-text-3); }
.dshc-nedit { width: 100%; height: 100%; box-sizing: border-box; padding: 12px; border: none; outline: none; resize: none; font: inherit; font-size: 13px; line-height: 1.6; color: var(--dshc-text); background: transparent; }

/* Resize handles, drag hints and guides. */
.dshc-handle { position: absolute; width: 10px; height: 10px; border: 1px solid var(--dshc-primary); background: var(--dshc-panel); border-radius: 2px; }
.dshc-handle[data-dir="se"] { right: -5px; bottom: -5px; cursor: nwse-resize; }
.dshc-handle[data-dir="e"] { right: -5px; top: 50%; margin-top: -5px; cursor: ew-resize; }
.dshc-handle[data-dir="s"] { left: 50%; bottom: -5px; margin-left: -5px; cursor: ns-resize; }
.dshc-guide { position: absolute; background: color-mix(in srgb, var(--dshc-primary) 70%, transparent); pointer-events: none; }
.dshc-ghost { position: absolute; display: flex; align-items: flex-start; justify-content: center; border: 2px dashed color-mix(in srgb, var(--dshc-primary) 70%, transparent); border-radius: 16px; background: color-mix(in srgb, var(--dshc-primary) 8%, transparent); pointer-events: none; }
.dshc-ghost-pill { transform: translateY(-50%); padding: 1px 8px; border-radius: 999px; background: var(--dshc-primary); color: #fff; font-size: 11px; white-space: nowrap; }
.dshc-marquee { position: absolute; border: 1px solid var(--dshc-primary); background: color-mix(in srgb, var(--dshc-primary) 12%, transparent); pointer-events: none; }

/* Dock, corner controls, menus, empty state, toasts. */
.dshc-dock { position: absolute; left: 50%; bottom: 15px; transform: translateX(-50%); display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px; padding: 4px; border: 1px solid var(--dshc-border); border-radius: 999px; background: color-mix(in srgb, var(--dshc-panel) 95%, transparent); box-shadow: var(--dshc-shadow); z-index: 3; }
.dshc-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: none; border: none; border-radius: 999px; background: transparent; color: var(--dshc-text-2); font: inherit; font-size: 13px; cursor: pointer; }
.dshc-btn:hover:not(:disabled) { background: var(--dshc-hover); color: var(--dshc-text); }
.dshc-btn:disabled { opacity: .4; pointer-events: none; }
.dshc-btn[data-pressed="true"] { background: var(--dshc-primary); color: #fff; }
.dshc-btn[data-danger="true"]:hover { background: color-mix(in srgb, var(--dshc-danger) 15%, transparent); color: var(--dshc-danger); }
.dshc-sep { width: 1px; height: 20px; margin: 0 4px; background: var(--dshc-border); }
.dshc-count { padding: 0 4px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--dshc-text-2); }
.dshc-corner { position: absolute; right: 15px; bottom: 15px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; z-index: 3; }
.dshc-zoom { display: flex; align-items: center; gap: 2px; padding: 4px; border: 1px solid var(--dshc-border); border-radius: 999px; background: color-mix(in srgb, var(--dshc-panel) 95%, transparent); box-shadow: var(--dshc-shadow); }
.dshc-pct { width: 48px; height: 32px; font-family: ui-monospace, monospace; font-size: 11px; }
.dshc-map { position: relative; border: 1px solid var(--dshc-border); border-radius: 10px; background: color-mix(in srgb, var(--dshc-panel) 92%, transparent); box-shadow: var(--dshc-shadow); overflow: hidden; cursor: pointer; }
.dshc-map-node { position: absolute; border-radius: 2px; background: var(--dshc-text-3); }
.dshc-map-node[data-kind="region"] { background: color-mix(in srgb, var(--dshc-primary) 55%, transparent); }
.dshc-map-view { position: absolute; border: 1px solid var(--dshc-primary); background: color-mix(in srgb, var(--dshc-primary) 10%, transparent); }
.dshc-menu { position: fixed; z-index: 60; min-width: 200px; padding: 4px; border: 1px solid var(--dshc-border); border-radius: 10px; background: var(--dshc-panel); box-shadow: var(--dshc-shadow); font-size: 13px; max-height: 60vh; overflow: auto; }
.dshc-mitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: var(--dshc-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.dshc-mitem:hover { background: var(--dshc-hover); }
.dshc-mitem[data-danger="true"]:hover { color: var(--dshc-danger); }
.dshc-mlabel { padding: 6px 8px 2px; font-size: 11px; color: var(--dshc-text-3); }
.dshc-msearch { width: calc(100% - 8px); margin: 4px; padding: 5px 8px; box-sizing: border-box; border: 1px solid var(--dshc-border); border-radius: 6px; background: var(--dshc-panel-2); color: var(--dshc-text); font: inherit; font-size: 12px; }
.dshc-msub { margin-left: auto; color: var(--dshc-text-3); }
.dshc-swatches { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; padding: 4px; }
.dshc-swatch { width: 24px; height: 24px; border: 1px solid var(--dshc-border); border-radius: 6px; cursor: pointer; padding: 0; }
.dshc-swatch[data-active="true"] { box-shadow: 0 0 0 2px var(--dshc-primary); }
.dshc-cells { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px; }
.dshc-cell { height: 26px; border: none; border-radius: 6px; background: var(--dshc-panel-2); color: var(--dshc-text-2); font: inherit; font-size: 12px; cursor: pointer; }
.dshc-cell[data-active="true"] { background: var(--dshc-primary); color: #fff; }
.dshc-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; text-align: center; pointer-events: none; z-index: 2; }
.dshc-empty h3 { margin: 0; font-size: 14px; font-weight: 500; }
.dshc-empty p { margin: 0; max-width: 420px; font-size: 12px; color: var(--dshc-text-2); }
.dshc-cta { pointer-events: auto; padding: 6px 14px; border: none; border-radius: 999px; background: var(--dshc-primary); color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
.dshc-toasts { position: absolute; left: 50%; top: 16px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; z-index: 70; pointer-events: none; }
.dshc-toast { padding: 6px 12px; border-radius: 8px; background: var(--dshc-danger); color: #fff; font-size: 12px; box-shadow: var(--dshc-shadow); max-width: 70vw; }
.dshc-modal { position: absolute; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.dshc-dialog { width: 340px; padding: 16px; border: 1px solid var(--dshc-border); border-radius: 12px; background: var(--dshc-panel); box-shadow: var(--dshc-shadow); }
.dshc-dialog h3 { margin: 0 0 6px; font-size: 14px; }
.dshc-dialog p { margin: 0 0 14px; font-size: 12px; color: var(--dshc-text-2); }
.dshc-dialog-row { display: flex; justify-content: flex-end; gap: 8px; }
.dshc-tbtn { padding: 5px 12px; border: 1px solid var(--dshc-border); border-radius: 8px; background: transparent; color: var(--dshc-text); font: inherit; font-size: 12px; cursor: pointer; }
.dshc-tbtn[data-danger="true"] { border-color: transparent; background: var(--dshc-danger); color: #fff; }
.dshc-spinner { width: 18px; height: 18px; border: 2px solid var(--dshc-border); border-top-color: var(--dshc-primary); border-radius: 50%; animation: dshc-spin .8s linear infinite; }

@keyframes dshc-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes dshc-breathe { 0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dshc-primary) 30%, transparent) } 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshc-primary) 22%, transparent) } }
@keyframes dshc-spin { to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .dshc-card[data-running="true"], .dshc-dot-run, .dshc-sdot[data-running="true"] { animation: none } }
`
