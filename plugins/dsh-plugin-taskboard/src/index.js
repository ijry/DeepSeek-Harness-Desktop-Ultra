/**
 * Host loader entry for dsh-plugin-taskboard — a task kanban for the DSH web
 * GUI whose semantics mirror codeg-plus's 任务看板 (four board columns,
 * human-only acceptance, workspace-bound agent claims).
 *
 * Wiring: the ledger store (one JSON file under the DSH home), the six
 * taskboard_* agent tools, the agent workflow-protocol system-prompt
 * section, and the /dsh-plugin-taskboard JSON+SSE routes (when a webServer
 * is served). Mounts via the official dsh plugin system — no DSH source
 * changes; publishable to the dsh plugin market (npm, keyword dsh-plugin).
 *
 * Export shape follows the dsh-taskboard precedent: a function/namespace
 * plugin — `name` / `inject` / `apply`, NO default export. Keeps ZERO
 * runtime @deepseek-ai/* imports (the SDK helpers live in host/sdk.js).
 *
 * @module dsh-plugin-taskboard
 */
import {
  CODEG_TASKBOARD_SECTION_NAME,
  CODEG_TASKBOARD_SECTION_ORDER,
  protocolText,
} from './host/protocol-text.js'
import { dshHomePath } from './host/sdk.js'
import { TaskStore } from './host/store.js'
import { registerTaskboardRoutes } from './host/routes.js'
import { registerTaskboardTools, workspaceFace } from './host/tools.js'
import { hostLang } from './shared/lang.js'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'dsh-plugin-taskboard.json'

/** Cordis plugin name. */
export const name = 'dsh-plugin-taskboard'

/** Required host services (tool registry + prompt assembly). */
export const inject = ['tools', 'systemPrompt']

/**
 * Mount the host half.
 * @param ctx - the plugin context (tools + systemPrompt injected).
 */
export function apply(ctx) {
  const store = new TaskStore({ file: dshHomePath(LEDGER_FILE) })
  // Eager first load: taskboard_list/get and the GET routes read snapshots
  // without triggering the lazy load, so a fresh boot used to serve an EMPTY
  // board until the first mutation or /state call (dsh-taskboard review P0).
  // load() never throws — a corrupt ledger is quarantined instead.
  void store.load()
  const now = () => Date.now()

  // Agent workflow protocol (columns, claim/version discipline, done-gate),
  // in the language the desktop shell runs in (DSH_DESKTOP_LANG).
  ctx.effect?.(
    () => ctx.systemPrompt.section({
      name: CODEG_TASKBOARD_SECTION_NAME,
      order: CODEG_TASKBOARD_SECTION_ORDER,
      text: protocolText(hostLang()),
    }),
    'dsh-plugin-taskboard: protocol section',
  )

  // Tools, then routes: everything else comes up with the workspace registry
  // (claim boundary needs it) and the webServer (GUI live view needs it).
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    const disposers = []

    disposers.push(...registerTaskboardTools(wsCtx, {
      store,
      workspaces: workspaceFace(wsCtx.workspaceRegistry),
      now,
    }))

    let disposeRoutes
    wsCtx.inject(['webServer'], (webCtx) => {
      disposeRoutes = registerTaskboardRoutes(webCtx, {
        store,
        workspaces: workspaceFace(wsCtx.workspaceRegistry),
        now,
      })
      // cordis inject semantics: the callback's return value is the disposer.
      return () => disposeRoutes?.()
    })

    return () => {
      disposeRoutes?.()
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}
