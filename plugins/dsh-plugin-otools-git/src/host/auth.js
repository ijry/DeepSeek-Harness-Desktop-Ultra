/**
 * Credentials for network operations: HTTPS username/password (or token) per
 * host, and the SSH host-key trust prompt.
 *
 * The stored form is `{ schemaVersion, hosts: { host: { username, password } } }`
 * written atomically with mode 0o600, and the browser is only ever told WHICH
 * hosts have a credential and under which username — never the secret. That is
 * one better than the reference plugin, which keeps this material in a
 * world-readable JSON blob next to its other state.
 *
 * Environment beats disk for the username/password pair too: an operator who
 * exports GIT_USERNAME/GIT_PASSWORD (or the GitHub/GitLab token variables) wins
 * over anything stored here, and is reported by variable NAME so the settings
 * panel can explain why a host works without a stored row.
 *
 * @module dsh-plugin-otools-git/host/auth
 */
import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ERR, GitError } from '../shared/protocol.js'

/** Credential file name; the caller joins it onto the DSH home. */
export const CREDENTIALS_FILE = 'dsh-plugin-otools-git-credentials.json'

/** Stored-file schema version (bump on breaking record changes). */
const SCHEMA_VERSION = 1

/** Owner-only mode for a file holding secret material. */
const SECRET_MODE = 0o600

/**
 * Environment variables that can stand in for a stored credential, and the one
 * host each is allowed to authenticate. Scoped per host on purpose: a token that
 * applied to every host would be sent to whatever a remote happens to name, so a
 * workspace whose origin points at `github.someone-elses-box.com` must not
 * receive the user's real GITHUB_TOKEN.
 */
const ENV_CREDENTIALS = [
  { host: 'github.com', userVar: 'GITHUB_ACTOR', tokenVars: ['GITHUB_TOKEN', 'GH_TOKEN'], defaultUser: 'x-access-token' },
  { host: 'gitlab.com', userVar: undefined, tokenVars: ['GITLAB_TOKEN'], defaultUser: 'oauth2' },
]

/** Serial write chain: every mutation is a read-modify-write over one file. */
let writes = Promise.resolve()

/** Run one mutation inside the serial write chain. */
function serialize(run) {
  const result = writes.then(run, run)
  writes = result.then(() => undefined, () => undefined)
  return result
}

/** Hosts match lowercased: DNS is case-insensitive and remote casing varies. */
export function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase()
}

/** The secret-free rows the browser may see, in a stable order. */
function hostRows(hosts) {
  return [...hosts.keys()].sort().map((host) => ({
    host,
    username: hosts.get(host).username,
    source: 'file',
  }))
}

/**
 * Stored credentials as a Map of host → `{username, password}`. A Map, not a
 * plain object: host names come out of a file, and a hand-edited `__proto__` key
 * would mutate a prototype instead of storing a row.
 *
 * Never throws — a missing file is the common case and a corrupt one is
 * quarantined and treated as empty, because a broken credential file must
 * degrade to "no stored credential", never take a route down.
 */
async function loadCredentials(file) {
  const hosts = new Map()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[dsh-plugin-otools-git] credentials unreadable:', error.message)
    }
    return hosts
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      typeof parsed.hosts !== 'object' || parsed.hosts === null || Array.isArray(parsed.hosts)) {
    console.warn('[dsh-plugin-otools-git] quarantining corrupt credentials file')
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* best effort */ }
    return hosts
  }
  for (const [host, entry] of Object.entries(parsed.hosts)) {
    const username = typeof entry?.username === 'string' ? entry.username.trim() : ''
    const password = typeof entry?.password === 'string' ? entry.password : ''
    // A row with no usable secret is not a credential; dropping it keeps "this
    // host has one" honest in the browser's list.
    if (password.length === 0) continue
    hosts.set(normalizeHost(host), { username, password })
  }
  return hosts
}

/**
 * Write the credential file atomically and owner-only: a temp file in the SAME
 * directory (so the rename cannot cross a filesystem), mode 0o600 at creation,
 * then an explicit chmod because the mode option is only a REQUEST that the
 * process umask masks, then rename over the target.
 *
 * On Windows chmod is very nearly a no-op — the file inherits the directory's
 * ACL — so the mode is a POSIX-only guarantee and the UI does not claim
 * otherwise there.
 */
async function persistCredentials(file, hosts) {
  await mkdir(dirname(file), { recursive: true })
  const rows = Object.create(null)
  for (const [host, entry] of hosts) rows[host] = { username: entry.username, password: entry.password }
  const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, hosts: rows }, null, 2)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { encoding: 'utf8', mode: SECRET_MODE })
  await chmod(tmp, SECRET_MODE)
  await rename(tmp, file)
}

/** Apply one mutation inside the write chain, answering with the safe host list. */
async function mutate(file, mutator) {
  return serialize(async () => {
    const hosts = await loadCredentials(file)
    if (mutator(hosts) === true) await persistCredentials(file, hosts)
    return hostRows(hosts)
  })
}

/** Which credential environment variables are set, by NAME and host. */
export function envCredentialSources() {
  const rows = []
  for (const entry of ENV_CREDENTIALS) {
    for (const name of entry.tokenVars) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        rows.push({ host: entry.host, variable: name })
        break
      }
    }
  }
  const generic = process.env.GIT_PASSWORD ?? process.env.GIT_TOKEN
  if (typeof generic === 'string' && generic.trim().length > 0) {
    rows.push({ host: '*', variable: process.env.GIT_PASSWORD !== undefined ? 'GIT_PASSWORD' : 'GIT_TOKEN' })
  }
  return rows
}

/** The environment credential for a host, or undefined. */
function credentialFromEnv(host) {
  const key = normalizeHost(host)
  for (const entry of ENV_CREDENTIALS) {
    if (entry.host !== key) continue
    for (const name of entry.tokenVars) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        const user = entry.userVar === undefined ? undefined : process.env[entry.userVar]
        return {
          username: typeof user === 'string' && user.trim().length > 0 ? user.trim() : entry.defaultUser,
          password: value.trim(),
          source: 'env',
        }
      }
    }
  }
  const password = process.env.GIT_PASSWORD ?? process.env.GIT_TOKEN
  if (typeof password === 'string' && password.trim().length > 0) {
    const user = process.env.GIT_USERNAME
    return {
      username: typeof user === 'string' && user.trim().length > 0 ? user.trim() : 'git',
      password: password.trim(),
      source: 'env',
    }
  }
  return undefined
}

/**
 * The credential a host is reached with, plus where it came from. Environment
 * variables are read FRESH every call and never cached at module load: the host
 * process is long-lived, so a token exported after boot has to be seen without
 * restarting it.
 */
export async function resolveCredential(file, host) {
  const key = normalizeHost(host)
  const fromEnv = credentialFromEnv(key)
  if (fromEnv !== undefined) return fromEnv
  if (key.length === 0) return undefined
  const hosts = await loadCredentials(file)
  const row = hosts.get(key)
  return row === undefined ? undefined : { ...row, source: 'file' }
}

/** Which hosts have a stored credential — host and username only, no secret. */
export async function loadCredentialHosts(file) {
  return hostRows(await loadCredentials(file))
}

/** Store (or replace) one host's credential. */
export async function saveCredential(file, host, username, password) {
  const key = normalizeHost(host)
  if (key.length === 0) throw new GitError(ERR.invalidInput, 'host 不能为空')
  if (typeof password !== 'string' || password.trim().length === 0) {
    throw new GitError(ERR.invalidInput, '密码或 Token 不能为空')
  }
  const user = typeof username === 'string' ? username.trim() : ''
  return mutate(file, (hosts) => {
    hosts.set(key, { username: user, password: password.trim() })
    return true
  })
}

/** Forget one host's credential. Idempotent. */
export async function deleteCredential(file, host) {
  const key = normalizeHost(host)
  return mutate(file, (hosts) => hosts.delete(key))
}

// ------------------------------------------------------------ SSH host keys
/** `~/.ssh/known_hosts`, honouring an explicit override. */
export function knownHostsPath() {
  const override = process.env.DSH_OG_KNOWN_HOSTS
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.ssh', 'known_hosts')
}

/** Whether an error is the "unknown/changed SSH host key" one. */
export function isHostKeyError(message) {
  return /Host key verification failed|authenticity of host|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key|known_hosts/i
    .test(String(message ?? ''))
}

/** Run a helper binary, resolving to `{code, stdout, stderr}`. */
function run(command, args, timeoutMs = 20_000) {
  return new Promise((resolveResult) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolveResult({
        code: error === null ? 0 : (error.code ?? 1),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/**
 * A hostname safe to hand `ssh-keyscan` as an argv element. Validated here rather
 * than trusted: a value starting with `-` would be read as an option.
 */
function normalizeSshHost(host) {
  const text = normalizeHost(host)
  if (text.length === 0) throw new GitError(ERR.invalidInput, 'host 不能为空')
  if (text.startsWith('-')) throw new GitError(ERR.invalidInput, 'host 不能以 - 开头')
  if (!/^[a-z0-9.\-_]+$/.test(text)) throw new GitError(ERR.invalidInput, `host 含有非法字符：${host}`)
  return text
}

/**
 * The host key a server offers, with its fingerprint, so the user can compare it
 * against what the service publishes before trusting it.
 *
 * `ssh-keyscan` + `ssh-keygen -lf` rather than a handshake library: both ship
 * with OpenSSH and with Git for Windows, so this needs no dependency. Status is
 * `trusted` (already in known_hosts), `mismatch` (a DIFFERENT key is on file —
 * never auto-fixed), `unknown` (first contact) or `unavailable`.
 */
export async function inspectHostKey(host, port = 22) {
  const target = normalizeSshHost(host)
  const scan = await run('ssh-keyscan', port === 22 ? ['-T', '8', target] : ['-T', '8', '-p', String(port), target])
  const lines = scan.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.startsWith('#'))
  if (lines.length === 0) {
    return { host: target, port, status: 'unavailable', message: `无法连接到 ${target}:${port} 读取主机密钥` }
  }
  // Prefer the strongest key type the server offered, matching what ssh picks.
  const order = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']
  lines.sort((a, b) => order.indexOf(a.split(' ')[1]) - order.indexOf(b.split(' ')[1]))
  const entry = lines[0]
  const keyType = entry.split(' ')[1]
  const fingerprint = await fingerprintOf(entry)
  const known = await readKnownHosts()
  const displayHost = port === 22 ? target : `[${target}]:${port}`
  const existing = known.filter((line) => line.startsWith(`${displayHost} `) || line.startsWith(`${displayHost},`))
  if (existing.length === 0) {
    return { host: target, port, displayHost, status: 'unknown', keyType, fingerprint, entry, knownHostsPath: knownHostsPath() }
  }
  const matches = existing.some((line) => line.trim() === entry.trim())
  return {
    host: target,
    port,
    displayHost,
    status: matches ? 'trusted' : 'mismatch',
    keyType,
    fingerprint,
    entry,
    knownHostsPath: knownHostsPath(),
  }
}

/** SHA256 fingerprint of one known_hosts line. */
async function fingerprintOf(entry) {
  const { mkdtemp, writeFile: write, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-og-'))
  const file = join(dir, 'key')
  try {
    await write(file, `${entry}\n`, 'utf8')
    const result = await run('ssh-keygen', ['-lf', file])
    const match = result.stdout.match(/(SHA256:[A-Za-z0-9+/=]+)/)
    return match === null ? undefined : match[1]
  } catch {
    return undefined
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The lines currently in known_hosts. */
async function readKnownHosts() {
  try {
    return (await readFile(knownHostsPath(), 'utf8')).split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * Append a host key to known_hosts after the user confirmed the fingerprint.
 *
 * A MISMATCH is refused outright: a changed key is either a server rotation the
 * user must confirm out of band or a man-in-the-middle, and silently rewriting
 * the entry would erase the only warning they get.
 */
export async function trustHostKey(host, port = 22) {
  const info = await inspectHostKey(host, port)
  if (info.status === 'mismatch') {
    throw new GitError(
      ERR.sshAuth,
      `${info.displayHost} 的主机密钥与本地记录不一致，已拒绝自动写入，请先人工核验是否为服务端轮换`,
    )
  }
  if (info.status === 'trusted') return info
  if (info.status !== 'unknown' || typeof info.entry !== 'string') {
    throw new GitError(ERR.sshAuth, info.message ?? `无法读取 ${host} 的主机密钥`)
  }
  const file = knownHostsPath()
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${info.entry}\n`, { encoding: 'utf8', mode: 0o600 })
  return { ...info, status: 'trusted' }
}
