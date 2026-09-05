/**
 * Host loader entry for dsh-plugin-otools-git — a full Git client for the DSH web
 * GUI whose interface is a faithful re-implementation of otools-git's 章鱼Git
 * panel, with two deliberate changes:
 *
 * 1. The repository list is DSH's workspace registry, not a ledger the user
 *    maintains by hand. No "add repository" step, no reordering, no rename.
 * 2. The AI commit-message writer talks to DSH's own model plumbing
 *    (`ctx.llm.stream` on the route DSH's `agentDefaultModel` already picked), so
 *    there is no second API key to configure.
 *
 * Excluded on purpose, per the port's scope: the soft-copyright (软著) document
 * generator, the built-in terminal and the file editor. Everything else the
 * reference does is here.
 *
 * Wiring: the preference ledger and the HTTPS credential file (both single JSON
 * files under the DSH home), then the /dsh-plugin-otools-git JSON + SSE routes.
 * Mounts via the official dsh plugin system — no DSH source changes.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` /
 * `inject` / `apply`, NO default export. Keeps ZERO runtime @deepseek-ai/*
 * imports (the SDK helper lives in host/sdk.js).
 *
 * @module dsh-plugin-otools-git
 */
import { CREDENTIALS_FILE } from './host/auth.js'
import { registerGitRoutes } from './host/routes.js'
import { dshHomePath } from './host/sdk.js'
import { PREFS_FILE, PrefsStore } from './host/store.js'
import { createRepoIndex, workspaceFace } from './host/workspaces.js'

/** Cordis plugin name. */
export const name = 'dsh-plugin-otools-git'

/**
 * No top-level services. The panel needs the workspace registry and the
 * webServer, and would like the model services — all of them are injected
 * lazily inside `apply` so a build missing any one of them still comes up
 * (without a model, the AI button reports why instead of vanishing).
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const prefs = new PrefsStore({ file: dshHomePath(PREFS_FILE) })
  // Eager first load: the prefs GET serves a snapshot without triggering the
  // lazy load, so a fresh boot would otherwise hand the panel defaults until the
  // first write. load() never throws — a corrupt ledger is quarantined instead.
  void prefs.load()
  const credentialsFile = dshHomePath(CREDENTIALS_FILE)

  // The model services are optional and may arrive after the routes do, so the
  // panel reads them through a mutable holder rather than capturing a value.
  const ai = { llm: undefined, defaultModel: undefined }
  ctx.inject(['llm'], (llmCtx) => {
    ai.llm = llmCtx.llm
    return () => {
      ai.llm = undefined
    }
  })
  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    ai.defaultModel = modelCtx.agentDefaultModel
    return () => {
      ai.defaultModel = undefined
    }
  })

  // Routes need both the workspace registry (a repository is derived from a
  // workspace path) and the webServer.
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const repos = createRepoIndex({ workspaces: workspaceFace(wsCtx.workspaceRegistry) })
    let disposeRoutes
    wsCtx.inject(['webServer'], (webCtx) => {
      disposeRoutes = registerGitRoutes(webCtx, { prefs, repos, credentialsFile, ai })
      // cordis inject semantics: the callback's return value is the disposer.
      return () => disposeRoutes?.()
    })
    return () => disposeRoutes?.()
  })
}
