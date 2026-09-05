/**
 * Host loader entry for dsh-plugin-repopanel — a repository panel for the DSH
 * web GUI whose semantics mirror codeg-plus's 仓库面板 (`forge`): the repository
 * is the one a workspace's `origin` remote points at, its issues and changes are
 * read from the forge on demand, and one of them can be handed to an agent as a
 * task on the sibling task board.
 *
 * Wiring: the panel ledger (settings + source-key → task links, one JSON file
 * under the DSH home), the untrusted-data system-prompt section, and the
 * /dsh-plugin-repopanel JSON + SSE routes (when a webServer is served). Mounts
 * via the official dsh plugin system — no DSH source changes, and no changes to
 * the task board either: this plugin talks to it over its own HTTP API.
 *
 * Export shape follows the sibling plugin: a namespace plugin — `name` /
 * `inject` / `apply`, NO default export. Keeps ZERO runtime @deepseek-ai/*
 * imports (the SDK helper lives in host/sdk.js).
 *
 * @module dsh-plugin-repopanel
 */
import {
  REPOPANEL_PROTOCOL,
  REPOPANEL_SECTION_NAME,
  REPOPANEL_SECTION_ORDER,
} from './host/protocol-text.js'
import { CREDENTIALS_FILE } from './host/auth.js'
import { dshHomePath } from './host/sdk.js'
import { PanelStore } from './host/store.js'
import { registerRepoPanelRoutes, workspaceFace } from './host/routes.js'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'dsh-plugin-repopanel.json'

/** Cordis plugin name. */
export const name = 'dsh-plugin-repopanel'

/**
 * No top-level services: the prompt section is optional (the panel is useful
 * without it) and everything else comes up with the workspace registry.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const store = new PanelStore({ file: dshHomePath(LEDGER_FILE) })
  // Eager first load: the settings GET and the link join read snapshots without
  // triggering the lazy load, so a fresh boot would otherwise serve default
  // settings and no links until the first write. load() never throws — a corrupt
  // ledger is quarantined instead.
  void store.load()
  const credentialsFile = dshHomePath(CREDENTIALS_FILE)
  const now = () => Date.now()

  // The untrusted-data discipline. Optional: a build without a system-prompt
  // service still serves the panel, it just loses the standing reminder.
  // cordis inject semantics: the callback's return value is the disposer, and
  // `section()` already returns exactly that.
  ctx.inject(['systemPrompt'], (promptCtx) => promptCtx.systemPrompt.section({
    name: REPOPANEL_SECTION_NAME,
    order: REPOPANEL_SECTION_ORDER,
    text: REPOPANEL_PROTOCOL,
  }))

  // Routes need both the workspace registry (a repository is derived from a
  // workspace path) and the webServer.
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    let disposeRoutes
    wsCtx.inject(['webServer'], (webCtx) => {
      disposeRoutes = registerRepoPanelRoutes(webCtx, {
        store,
        workspaces: workspaceFace(wsCtx.workspaceRegistry),
        credentialsFile,
        now,
      })
      // cordis inject semantics: the callback's return value is the disposer.
      return () => disposeRoutes?.()
    })
    return () => disposeRoutes?.()
  })
}
