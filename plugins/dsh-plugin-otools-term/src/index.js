/**
 * Host loader entry for dsh-plugin-otools-term — an SSH / SFTP / remote-desktop
 * workbench for the DSH web GUI whose interface is a faithful re-implementation of
 * otools-term's 墨鱼终端 panel, with the driver rewritten for Node.
 *
 * The reference is a Tauri plugin: a Rust cdylib built on the `ssh2` crate
 * (libssh2) plus a hand-rolled `forkpty` for the local shell, talking to a Vue 3 +
 * Element Plus front end over Tauri commands. None of that exists in a dsh profile,
 * so every driver is replaced by its Node equivalent:
 *
 *   SSH transport, SFTP, direct-tcpip   →  ssh2 (pure JS, one shared connection
 *                                          per server instead of one per channel)
 *   local PTY (forkpty / piped cmd.exe) →  node-pty when present, pipes otherwise
 *   terminal widget (xterm 5 via vite)  →  the same xterm.js, served from this
 *                                          package's node_modules by /vendor
 *   Tauri commands / events             →  JSON routes + one multiplexed SSE stream
 *   native file dialogs                 →  the browser's own file input, plus
 *                                          transfers scoped to DSH workspaces
 *
 * Added on top of the port: DSH's own model behind an AI bar (一句话 → 命令, and
 * "解释这段报错"), trust-on-first-use host-key verification, a real PTY resize, and
 * host-side sessions that survive a page reload.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` / `inject`
 * / `apply`, NO default export. Keeps ZERO runtime @deepseek-ai/* imports (the SDK
 * helpers live in host/sdk.js).
 *
 * @module dsh-plugin-otools-term
 */
import { TermEngine } from './host/engine.js'
import { registerTermRoutes } from './host/routes.js'
import { KNOWN_HOSTS_FILE, SECRETS_FILE } from './host/secrets.js'
import { dshHomePath } from './host/sdk.js'
import { STORE_FILE, TermStore } from './host/store.js'
import { emptyWorkspaces, workspaceFace } from './host/workspaces.js'

/** Cordis plugin name. */
export const name = 'dsh-plugin-otools-term'

/**
 * No top-level services. The panel needs the webServer, and would like the
 * workspace registry and the model services — all of them are injected lazily
 * inside `apply` so a build missing any one of them still comes up (without a
 * model the AI bar reports why instead of vanishing; without the registry the
 * workspace-scoped transfers are simply not offered).
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const store = new TermStore({ file: dshHomePath(STORE_FILE) })
  // Eager first load: `/state` serves a snapshot without triggering the lazy load,
  // so a fresh boot would otherwise hand the panel defaults until the first write.
  // load() never throws — a corrupt ledger is quarantined instead.
  void store.load()

  // The model services are optional and may arrive after the routes do, so the AI
  // bar reads them through a mutable holder rather than capturing a value.
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

  // Same for the workspace registry: it only gates the workspace-scoped transfers.
  const workspaces = { face: emptyWorkspaces() }
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    workspaces.face = workspaceFace(wsCtx.workspaceRegistry)
    return () => {
      workspaces.face = emptyWorkspaces()
    }
  })

  const engine = new TermEngine({
    store,
    ai,
    secretsFile: dshHomePath(SECRETS_FILE),
    knownHostsFile: dshHomePath(KNOWN_HOSTS_FILE),
    // A face that forwards, so a registry arriving later is picked up without
    // rebuilding the engine.
    workspaces: {
      list: () => workspaces.face.list(),
      get: (id) => workspaces.face.get(id),
    },
  })

  let disposeRoutes
  ctx.inject(['webServer'], (webCtx) => {
    disposeRoutes = registerTermRoutes(webCtx, { engine })
    // cordis inject semantics: the callback's return value is the disposer.
    return () => disposeRoutes?.()
  })

  // Everything the host owns — live SSH connections, PTYs, listening sockets — has
  // to come down with the plugin, not with the process.
  ctx.effect(() => () => {
    disposeRoutes?.()
    engine.dispose()
  }, `${name}: engine`)
}
