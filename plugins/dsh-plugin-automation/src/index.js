/**
 * Host loader entry for dsh-plugin-automation — scheduled agent work for the DSH
 * web GUI, whose semantics mirror codeg-plus's 自动化: a saved job carries a
 * prompt, a project and a schedule, every firing is recorded as a run with a
 * terminal status, and the run history is what the user reads afterwards.
 *
 * Wiring: the ledger (settings + automations + runs, one JSON file under the DSH
 * home), the scheduler loop, and the /dsh-plugin-automation JSON + SSE routes
 * (when a webServer is served). Mounts via the official dsh plugin system — no
 * DSH source changes, and no changes to the task board either: the optional
 * "file a card instead of running" delivery talks to it over its own HTTP API.
 *
 * This plugin registers NO agent tools and writes NO system-prompt section, so
 * installing it does not change how the agent behaves in a normal session. What it
 * does add is unattended execution: a scheduled job runs an agent with tools in a
 * project directory with nobody watching. That is the whole point of the feature
 * and also its risk — the README says so, the master switch turns it off, and a
 * run that keeps failing parks itself.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` / `inject`
 * / `apply`, NO default export. Keeps ZERO runtime @deepseek-ai/* imports (the SDK
 * helpers live in host/sdk.js).
 *
 * @module dsh-plugin-automation
 */
import { AutomationEngine } from './host/engine.js'
import { registerAutomationRoutes, workspaceFace } from './host/routes.js'
import { dshHomePath } from './host/sdk.js'
import { AutomationStore } from './host/store.js'
import { taskboardBase } from './host/taskboard.js'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'dsh-plugin-automation.json'

/** Cordis plugin name. */
export const name = 'dsh-plugin-automation'

/**
 * No top-level services: everything comes up with the workspace registry, and the
 * routes wait for the webserver on top of that.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const store = new AutomationStore({ file: dshHomePath(LEDGER_FILE) })
  // Eager first load: the scheduler must know about the saved jobs before the
  // first tick, and load() never throws — a corrupt ledger is quarantined.
  void store.load()
  const now = () => Date.now()
  // The webserver may mount after the engine, so the base resolver reads it
  // through a function rather than capturing it.
  const holder = { webServer: undefined }
  const board = taskboardBase({ webServer: () => holder.webServer })

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const workspaces = workspaceFace(wsCtx.workspaceRegistry)
    const engine = new AutomationEngine({
      store,
      workspaces,
      taskboardBase: () => board.resolve(),
      now,
    })
    engine.start()

    let disposeRoutes
    wsCtx.inject(['webServer'], (webCtx) => {
      holder.webServer = webCtx.webServer
      disposeRoutes = registerAutomationRoutes(webCtx, { store, engine, workspaces, taskboardBase: board, now })
      // cordis inject semantics: the callback's return value is the disposer.
      return () => {
        holder.webServer = undefined
        disposeRoutes?.()
        disposeRoutes = undefined
      }
    })

    return () => {
      disposeRoutes?.()
      // Kills every child it started: an unsupervised agent must not outlive its
      // supervisor.
      void engine.dispose()
    }
  })
}
