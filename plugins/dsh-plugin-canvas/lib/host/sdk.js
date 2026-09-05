/**
 * Self-contained replacement for the one @deepseek-ai runtime import this
 * plugin would otherwise take from an SDK package.
 *
 * A published dsh plugin must never resolve `@deepseek-ai/*` from the profile's
 * node_modules at runtime — an npm-mirror copy shadows the CLI-internal build
 * and can break the harness — so `dshHomePath` re-implements exactly what
 * `@deepseek-ai/dsh-home-paths` does: `join(resolve(DSH_HOME ?? ~/.dsh), ...)`.
 *
 * Unlike its taskboard sibling this file carries no `defineTool`: the canvas
 * registers no agent tools and injects no system prompt, so it cannot change how
 * the agent behaves at all (see the README's boundary note).
 *
 * @module dsh-plugin-canvas/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(
    override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')
  )
  return join(home, ...segments)
}
