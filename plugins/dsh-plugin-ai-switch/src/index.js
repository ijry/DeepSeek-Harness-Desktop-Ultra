/**
 * Host loader entry for dsh-plugin-ai-switch — the AI Switch account manager and route
 * proxy, ported to the DSH web GUI.
 *
 * The interface is the reference's, file for file: its 33k lines of React are copied into
 * `webview/` and served as a single-page app under this plugin's own route. What changed is
 * everything underneath:
 *
 * 1. **The backend is Node, not Rust.** 107k lines of Rust became ~10k lines of JavaScript.
 *    The parts that survive unchanged in spirit are the ones that touch other people's
 *    files: snapshot, atomic replace, hash-guarded rollback, and one adapter per client
 *    config format — including format-preserving TOML and YAML editors, because a config
 *    write that eats your comments is a config write you stop trusting.
 * 2. **SQLite became JSON documents.** The dataset is a few hundred account rows and a pool
 *    order, read on panel open and written on user action; 28 migrations and a checksum
 *    ledger buy nothing here. Atomic writes and 0600 carry over — these files hold API keys.
 * 3. **The route proxy keeps its own port** (19527, first free upward), not dsh's. The CLIs
 *    need a stable address, dsh's server is behind an auth gate they cannot pass, and an
 *    upstream stream on the shared origin would eat one of the browser's six connections.
 * 4. **Panel events go over WebSocket**, for that same connection budget — see host/socket.js.
 * 5. **The desktop-only half is gone**: no Tailscale sidecar, no OS trust-store install for
 *    local HTTPS, no `ccswitch://` scheme registration, no autostart, no signed updater. Each
 *    one needs an installed application, and this is a plugin. The panel is told so rather
 *    than being left with buttons that fail.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` / `inject` / `apply`,
 * NO default export. Zero runtime `@deepseek-ai/*` imports (the SDK helpers are in
 * host/sdk.js).
 *
 * @module dsh-plugin-ai-switch
 */
import { registerAiSwitchRoutes } from './host/routes.js'

/** Cordis plugin name. */
export const name = 'dsh-plugin-ai-switch'

/**
 * No top-level services.
 *
 * The panel needs the webServer, and nothing else: this plugin registers no agent tools and
 * writes nothing into the system prompt, so an agent session behaves exactly as it did
 * before it was installed. The webServer is injected inside `apply` so a DSH build missing
 * it still comes up.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = registerAiSwitchRoutes(webCtx)
    // cordis inject semantics: the callback's return value is the disposer.
    return () => {
      void dispose()
    }
  })
}
