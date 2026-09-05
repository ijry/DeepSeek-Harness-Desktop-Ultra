/**
 * Self-contained replacement for the one @deepseek-ai runtime import a host
 * plugin would otherwise take from an SDK package (dsh-home-paths). A published
 * dsh plugin must never resolve @deepseek-ai/* packages from the profile's
 * node_modules at runtime (an npm-mirror copy shadows the CLI-internal build and
 * can break the agent loop), so this file re-implements the one behavior needed:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 *
 * There is no defineTool() here on purpose: this plugin contributes a panel and
 * a prompt section, not agent tools.
 *
 * @module dsh-plugin-repopanel/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}
