/**
 * Host loader entry for dsh-plugin-otools-dbm — the 鲨鱼数据库 panel from
 * otools-dbm, ported to the DSH web GUI.
 *
 * The interface is the reference's, file for file: its 30 Vue components are copied
 * verbatim into `webview/` and served as a single-page app under this plugin's own
 * route. What changed is everything underneath:
 *
 * 1. **The backend is Node, not Rust.** The reference's 29k lines of Rust talked to
 *    sqlx/tiberius/oracledb; this talks to mysql2, pg, node:sqlite, tedious,
 *    ioredis, mongodb, @clickhouse/client, kafkajs — the same driver set AirDB
 *    (the author's VS Code database client) settled on, minus the ones that need a
 *    compiler. Optional engines (Oracle, Snowflake) degrade to a named
 *    "driver not installed" error rather than breaking the panel.
 * 2. **The AI features use DSH's model.** `ctx.llm.stream()` on the route
 *    `agentDefaultModel` already picked, so the SQL assistant and the AI dashboard
 *    need no second API key.
 * 3. **Tauri's three bridges became HTTP.** `invoke` is one POST per command,
 *    `listen` is one SSE stream, and the native file dialogs became an in-app
 *    browser over the host's filesystem — a browser tab cannot open an OS dialog,
 *    and the paths that matter live on the host anyway.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` / `inject`
 * / `apply`, NO default export. Zero runtime `@deepseek-ai/*` imports (the SDK
 * helpers live in host/sdk.js).
 *
 * @module dsh-plugin-otools-dbm
 */
import { registerDbmRoutes } from './host/routes.js'

/** Cordis plugin name. */
export const name = 'dsh-plugin-otools-dbm'

/**
 * No top-level services.
 *
 * The panel needs the webServer and would like the model services; all of them are
 * injected lazily inside `apply` so a DSH build missing any one of them still comes
 * up. Without a model the AI panels report why instead of vanishing.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  // The model services are optional and may arrive after the routes do, so they
  // are read through a mutable holder rather than captured by value.
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

  ctx.inject(['webServer'], (webCtx) => {
    const disposeRoutes = registerDbmRoutes(webCtx, { ai })
    // cordis inject semantics: the callback's return value is the disposer.
    return () => disposeRoutes()
  })
}
