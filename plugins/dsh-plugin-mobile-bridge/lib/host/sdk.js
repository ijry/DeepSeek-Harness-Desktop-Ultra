/**
 * Self-contained replacement for the one upstream runtime import a host plugin
 * would otherwise take from an SDK package (`dsh-home-paths`).
 *
 * A published dsh plugin must never resolve `@deepseek-ai/*` packages from the
 * profile's node_modules at runtime: an npm-mirror copy shadows the
 * CLI-internal build and can break the agent loop. So `dshHomePath()` mirrors
 * `join(resolve(DSH_HOME ?? ~/.dsh), ...segments)` here instead, which is also
 * why this package has no dependencies at all and installs offline from the
 * tarball the desktop shell ships.
 *
 * @module dsh-plugin-mobile-bridge/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A path inside the dsh home directory.
 * @param {...string} segments - path segments below the home directory.
 * @returns {string} the absolute path.
 */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}
