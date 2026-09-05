/**
 * Plugin configuration, normalized by hand.
 *
 * Upstream plugins declare a schemastery `Config`, but this package deliberately
 * imports nothing from `@deepseek-ai/*` at runtime (see host/sdk.js), so it
 * cannot use that schema type without taking the dependency it is avoiding.
 * Cordis passes the raw config through either way, so the values are normalized
 * here instead — defensively, because an out-of-range port from a hand-edited
 * `cordis.patch.yml` must degrade to the default rather than crash a boot.
 *
 * @module dsh-plugin-mobile-bridge/host/config
 */

/** Default LAN port. Picked to sit clear of dsh's own dev ports. */
export const DEFAULT_PORT = 8790

/** Ledger file name under the dsh home. */
export const LEDGER_FILE = 'dsh-plugin-mobile-bridge.json'

function boolean(value, fallback) {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Normalize a raw plugin config.
 *
 * @param {object} raw - whatever the profile handed over.
 * @returns {{ lan: boolean, lanHost: string, lanPort: number, displayName: string }}
 *   the effective config.
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const port = Number(config.lanPort)
  return {
    // On by default: a bridge nobody can reach is not a bridge, and the route
    // table refuses every stateful request without a paired device anyway.
    lan: boolean(config.lan, true),
    // Only two values make sense. Anything else is a typo that would silently
    // bind somewhere the QR does not point at.
    lanHost: config.lanHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    lanPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
    displayName: typeof config.displayName === 'string' ? config.displayName.slice(0, 64) : '',
  }
}
