/**
 * Import candidates from the user's own `~/.ssh/config`.
 *
 * The reference had no import: every server was typed into its dialog by hand. Most
 * people who want an SSH panel already have a config file, so this reads it and
 * offers the hosts it finds — as CANDIDATES, never as saved rows. The browser shows
 * a list with checkboxes and calls `/servers/save` for the ones the user picks, so
 * an import can never quietly add fifty connections.
 *
 * Only the four directives that map onto a server record are read (`HostName`,
 * `Port`, `User`, `IdentityFile`), plus `ProxyJump`/`ProxyCommand` — which are
 * REPORTED as unsupported rather than silently dropped, because importing such a
 * host as a direct connection would produce a row that cannot connect and no
 * explanation. Patterns with wildcards are skipped for the same reason: `Host *` is
 * a defaults block, not a machine.
 *
 * @module dsh-plugin-otools-term/host/sshconfig
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_PORTS, ERR, TermError } from '../shared/protocol.js'

/** Cap on the file size read (a config, not a database). */
const MAX_CONFIG_BYTES = 512 * 1024

/** Cap on candidates returned. */
const MAX_HOSTS = 200

/** The default location. */
export function defaultConfigPath() {
  return join(homedir(), '.ssh', 'config')
}

/**
 * Parse an ssh_config into candidate rows.
 *
 * Directive names are case-insensitive and may be separated by `=` as well as
 * whitespace, which is what OpenSSH accepts; values may be quoted.
 */
export function parseSshConfig(text) {
  const hosts = []
  let current = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z][\w-]*)\s*(?:=|\s)\s*(.*)$/)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = unquote(match[2].trim())
    if (key === 'host') {
      for (const pattern of value.split(/\s+/).filter((part) => part.length > 0)) {
        current = { alias: pattern, wildcard: /[*?!]/.test(pattern), directives: {} }
        hosts.push(current)
      }
      continue
    }
    if (key === 'match') {
      // A Match block's directives apply conditionally; treating them as a host
      // would invent a machine that does not exist.
      current = { alias: '', wildcard: true, directives: {} }
      hosts.push(current)
      continue
    }
    if (current === null) continue
    if (current.directives[key] === undefined) current.directives[key] = value
  }

  const rows = []
  for (const host of hosts) {
    if (host.wildcard || host.alias.length === 0) continue
    const directives = host.directives
    const unsupported = []
    if (directives.proxyjump !== undefined) unsupported.push(`ProxyJump ${directives.proxyjump}`)
    if (directives.proxycommand !== undefined) unsupported.push('ProxyCommand')
    const identity = directives.identityfile
    rows.push({
      alias: host.alias,
      name: host.alias,
      protocol: 'ssh',
      host: directives.hostname ?? host.alias,
      port: Number.parseInt(directives.port ?? '', 10) || DEFAULT_PORTS.ssh,
      username: directives.user ?? '',
      authType: identity === undefined ? 'password' : 'private_key',
      privateKeyPath: identity === undefined ? '' : expandIdentity(identity),
      unsupported,
    })
    if (rows.length >= MAX_HOSTS) break
  }
  return rows
}

/** Drop one layer of quotes. */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** `~/.ssh/id_ed25519` → an absolute path; a relative one is left alone. */
function expandIdentity(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : value
}

/**
 * Read and parse the config file.
 *
 * A custom path is accepted (some people keep a work config elsewhere) but it must
 * be absolute, and a failure to read is reported as "not found" rather than with the
 * OS error, so this cannot be used to probe the filesystem.
 */
export async function importSshConfig(file) {
  const path = file === undefined || file.length === 0 ? defaultConfigPath() : file
  if (!isAbsolute(path)) throw new TermError(ERR.invalidInput, 'file 必须是绝对路径')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new TermError(ERR.notFound, `读取不到 ${path}`)
  }
  if (text.length > MAX_CONFIG_BYTES) throw new TermError(ERR.tooLarge, 'ssh config 太大')
  return { file: path, hosts: parseSshConfig(text) }
}
