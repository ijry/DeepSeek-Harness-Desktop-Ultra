/**
 * Host loader entry for dsh-plugin-longread — a long-form reader for the DSH web
 * GUI that renders a book as a fake agent session: a prompt, some tool calls, a
 * streamed reply. From across the room it is a work session; up close it is a
 * novel.
 *
 * Wiring: the library store (one JSON ledger plus one .txt per book under the
 * DSH home), the workspace file pool the camouflage draws real paths from, and
 * the /dsh-plugin-longread JSON routes (when a webServer is served).
 *
 * It is a PURE GUI plugin: no tools, no system-prompt section, no agent-visible
 * surface of any kind. Reading a novel must not change how the agent behaves.
 *
 * Export shape follows the sibling plugins: a namespace plugin — `name` /
 * `inject` / `apply`, NO default export. Keeps ZERO runtime @deepseek-ai/*
 * imports (the SDK helper lives in host/sdk.js).
 *
 * @module dsh-plugin-longread
 */
import { createFilePool, workspaceFace } from './host/files.js'
import { dshHomePath } from './host/sdk.js'
import { LibraryStore } from './host/store.js'
import { registerLongreadRoutes } from './host/routes.js'

/** Ledger file name under the DSH home. */
export const LEDGER_FILE = 'dsh-plugin-longread.json'

/** Directory (under the DSH home) holding one .txt per imported book. */
export const TEXT_DIR = 'dsh-plugin-longread-books'

/** Cordis plugin name. */
export const name = 'dsh-plugin-longread'

/**
 * No top-level services. The webServer is required for the panel to have an API
 * at all, but it is injected below so that a headless build simply mounts a
 * store and does nothing.
 */
export const inject = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const store = new LibraryStore({
    file: dshHomePath(LEDGER_FILE),
    textDir: dshHomePath(TEXT_DIR),
  })
  // Eager first load: the state route answers from a snapshot, so a fresh boot
  // would otherwise report an empty library until the first write. load() never
  // throws — a corrupt ledger is quarantined instead.
  void store.load()
  const now = () => Date.now()

  // The workspace registry is optional on purpose: without it the fake tool
  // calls fall back to a built-in path pool, which is a cosmetic downgrade, not
  // a broken panel. This cordis build has no optional-inject form, so the
  // registry is captured when it arrives and released when it goes.
  let registry
  const filePool = createFilePool({ workspaces: workspaceFace(() => registry) })
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    registry = wsCtx.workspaceRegistry
    filePool.invalidate()
    // cordis inject semantics: the callback's return value is the disposer.
    return () => {
      registry = undefined
      filePool.invalidate()
    }
  })

  ctx.inject(['webServer'], (webCtx) => registerLongreadRoutes(webCtx, { store, filePool, now }))
}
