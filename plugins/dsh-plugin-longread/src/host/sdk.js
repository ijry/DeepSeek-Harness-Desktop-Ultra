/**
 * Self-contained replacement for the one @deepseek-ai runtime helper this
 * plugin would otherwise import. A published dsh plugin must never resolve
 * @deepseek-ai/* from the profile's node_modules at runtime — an npm-mirror copy
 * shadows the CLI-internal build and can break the agent loop — so the behavior
 * is re-implemented here:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 *
 * This plugin registers no tools and contributes no prompt section, so unlike
 * the sibling plugins it needs no defineTool().
 *
 * @module dsh-plugin-longread/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}
