/**
 * Reachability facts: which addresses a phone on the same network can actually
 * dial, and what to call this machine in the pairing QR.
 *
 * Enumerating interfaces is not cosmetic. The pairing URL has to be one a phone
 * can reach, and `os.hostname()` is not it: mDNS resolution of a Windows
 * hostname from Android is unreliable, and a VPN or Docker interface will happily
 * offer an address that routes nowhere. So the bridge offers concrete IPv4
 * literals, ranks the ones most likely to be the real LAN first, and ships the
 * rest as fallback candidates in the QR.
 *
 * @module dsh-plugin-mobile-bridge/host/net
 */
import { hostname, networkInterfaces, userInfo } from 'node:os'

import { ROUTE_PREFIX } from '../shared/protocol.js'
import { pick } from '../shared/lang.js'

/**
 * Interface names that are almost never the path a phone takes. Matching is on a
 * lowercased name, so `vEthernet (WSL)` and `docker0` are both caught.
 */
const UNLIKELY = ['vethernet', 'docker', 'veth', 'br-', 'virbr', 'vmnet', 'vboxnet', 'tailscale', 'zerotier', 'utun', 'tun', 'tap', 'wg', 'loopback']

/** RFC1918 rank: a 192.168/16 address is the likeliest home LAN, then 10/8, then CGNAT-ish. */
function rank(name, address) {
  const lower = name.toLowerCase()
  let score = 0
  if (UNLIKELY.some((token) => lower.includes(token))) score += 100
  if (address.startsWith('192.168.')) score += 0
  else if (address.startsWith('10.')) score += 1
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 2
  else if (address.startsWith('169.254.')) score += 50
  else score += 10
  return score
}

/**
 * Every non-loopback IPv4 literal this host currently has, best guess first.
 * IPv6 is deliberately omitted: a bracketed literal in a QR is a support burden
 * and every phone on a home LAN has IPv4.
 * @returns {Array<{ name: string, address: string }>} ranked interfaces.
 */
export function lanAddresses() {
  const out = []
  const table = networkInterfaces()
  for (const [name, entries] of Object.entries(table)) {
    for (const entry of entries ?? []) {
      const family = entry.family === 'IPv4' || entry.family === 4
      if (!family || entry.internal === true) continue
      out.push({ name, address: entry.address })
    }
  }
  return out.sort((a, b) => rank(a.name, a.address) - rank(b.name, b.address) || a.address.localeCompare(b.address))
}

/**
 * Bridge base URLs for a listening port, in the order a client should try them.
 * @param {number} port - the listening port.
 * @param {string} [scheme] - `http` unless a deployment terminates TLS itself.
 * @returns {string[]} base URLs including the route prefix.
 */
export function bridgeUrls(port, scheme = 'http') {
  return lanAddresses().map((entry) => `${scheme}://${entry.address}:${port}${ROUTE_PREFIX}`)
}

/**
 * A human-facing name for this machine, used as the connection name on the phone.
 * Falls back through hostname and username so the phone never shows "undefined".
 * @returns {string} the display name.
 */
export function defaultDisplayName() {
  const host = String(hostname() || '').split('.')[0]
  if (host !== '') return pick(`${host} 的 dsh`, `dsh on ${host}`)
  try {
    const user = String(userInfo().username || '')
    if (user !== '') return pick(`${user} 的 dsh`, `dsh on ${user}`)
  } catch {
    /* userInfo throws on some minimal containers */
  }
  return pick('dsh 桌面', 'dsh desktop')
}
