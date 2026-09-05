/**
 * Self-contained replacement for the one @deepseek-ai runtime import a host
 * plugin would otherwise take from an SDK package (dsh-home-paths). A published
 * dsh plugin must never resolve @deepseek-ai/* packages from the profile's
 * node_modules at runtime (an npm-mirror copy shadows the CLI-internal build and
 * can break the agent loop), so this file re-implements the two behaviours
 * needed:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 * - dshCliEntry() finds the `dsh` launcher this very process was started from,
 *   which is what a headless run is spawned with.
 *
 * There is no defineTool() here on purpose: this plugin contributes a panel and
 * a scheduler, not agent tools.
 *
 * @module dsh-plugin-automation/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** Escape hatch for deployments where argv[1] is not the launcher. */
export const CLI_ENV = 'DSH_PLUGIN_AUTOMATION_DSH_ENTRY'

/**
 * How to spawn another dsh: `{ command, prefix }`, where prefix goes before the
 * launcher's own flags, or undefined when no launcher can be identified.
 *
 * The host plugin runs INSIDE a dsh process, so `process.argv[1]` is the very
 * launcher that booted it — the same version, the same install, no PATH lookup
 * and no guessing which of several installs is meant. That is preferred over a
 * bare `dsh` on PATH, which on a machine with both a global npm install and this
 * one would be a coin flip.
 *
 * There is deliberately no `dsh`-on-PATH fallback and never a shell: on Windows
 * a PATH hit would be `dsh.cmd`, which Node only spawns through cmd.exe, and the
 * prompt this plugin passes is user text. Handing user text to cmd.exe quoting is
 * a command-injection surface that a scheduler must not have. When argv[1] is not
 * a launcher (an embedder, a bundled binary), {@link CLI_ENV} names it instead.
 */
export function dshCliEntry(argv = process.argv, env = process.env) {
  const override = env[CLI_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    return { command: process.execPath, prefix: [override.trim()] }
  }
  const entry = argv[1]
  if (typeof entry === 'string' && entry.length > 0 && /\.[cm]?js$/.test(entry)) {
    return { command: process.execPath, prefix: [entry] }
  }
  return undefined
}
