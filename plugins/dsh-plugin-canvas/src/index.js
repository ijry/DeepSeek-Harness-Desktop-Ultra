/**
 * Host loader entry for dsh-plugin-canvas — an infinite session canvas for the
 * dsh web GUI, replicating codeg-plus's 无限会话 board (regions bound to
 * workspaces and agents, pinned session cards, sticky notes, drag-to-group).
 *
 * Wiring: the ledger store (one JSON file under the DSH home), the normalized
 * workspace/session view, and the /dsh-plugin-canvas JSON+SSE routes. Mounts
 * through the official dsh plugin system — no upstream source changes.
 *
 * What this plugin deliberately does NOT do: register agent tools, inject system
 * prompt text, or touch a session's contents. It is a pure GUI surface, so
 * installing it cannot change how the agent behaves — only how you look at your
 * work. That is why `inject` names no `tools` / `systemPrompt`.
 *
 * Export shape follows the taskboard precedent: `name` / `inject` / `apply`, no
 * default export, and ZERO runtime `@deepseek-ai/*` imports.
 *
 * @module dsh-plugin-canvas
 */
import { registerCanvasRoutes } from './host/routes.js'
import { dshHomePath } from './host/sdk.js'
import { createSessionsView } from './host/sessions.js'
import { CanvasStore } from './host/store.js'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'dsh-plugin-canvas.json'

/** Cordis plugin name. */
export const name = 'dsh-plugin-canvas'

/**
 * No hard service requirement at this level.
 *
 * Everything the board needs is requested through nested `ctx.inject` below, so
 * an assembly that lacks one of them leaves the CHILD fiber pending instead of
 * this one. That distinction is load-bearing on the browser side of dsh — the web
 * shell fails the whole page boot when a client entry stays pending — and it is
 * the same discipline here: a canvas without a webserver should be inert, not a
 * boot error.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const store = new CanvasStore({ file: dshHomePath(LEDGER_FILE) })
  // Eager first load: GET /state reads a snapshot without triggering the lazy
  // load, so a fresh boot would otherwise serve an EMPTY board until the first
  // mutation. load() never throws — a corrupt ledger is quarantined instead.
  void store.load()

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const view = createSessionsView(wsCtx)
    let disposeRoutes
    wsCtx.inject(['webServer'], (webCtx) => {
      disposeRoutes = registerCanvasRoutes(webCtx, {
        store,
        view,
        now: () => Date.now(),
        // Optional: an assembly without the query service still gets a board,
        // just without titles or transcripts (see host/sessions.js).
        sessionQuery: webCtx.sessionQuery,
      })
      // cordis inject semantics: the callback's return value is the disposer.
      return () => disposeRoutes?.()
    })
    return () => disposeRoutes?.()
  })
}
