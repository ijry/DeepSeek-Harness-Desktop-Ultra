/**
 * Forge credentials: which token a host is reached with, where that token came
 * from, and — only when the user typed one into the panel — where it is stored.
 *
 * Environment beats disk. An operator who exports GITHUB_TOKEN must win over a
 * stale stored one, and a launch that already carries a token in its
 * environment needs no on-disk secret at all.
 *
 * The stored form is deliberately tiny (`{ schemaVersion, hosts: { host:
 * { token } } }`) and is written atomically with mode 0o600. `resolveToken` is
 * the ONLY function here whose result may carry token material; the
 * browser-facing list carries host names and nothing else, and no code path in
 * this file logs a token, not even truncated.
 *
 * @module dsh-plugin-repopanel/host/auth
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ERR, PanelError } from '../shared/protocol.js'

/** Credential file name; the caller joins it onto the DSH home. */
export const CREDENTIALS_FILE = 'dsh-plugin-repopanel-credentials.json'

/** Stored-file schema version (bump on breaking record changes). */
const CREDENTIALS_SCHEMA_VERSION = 1

/** Owner-only mode for a file holding token material. */
const SECRET_MODE = 0o600

/**
 * Environment variables per provider, in precedence order, and the ONE host each
 * is allowed to authenticate. Rows rather than a keyed object so an unknown
 * provider string cannot reach an inherited Object property instead of missing.
 *
 * `host` is the whole point of this table, not decoration. Provider detection
 * matches a host LABEL (`github.acme.com` is treated as GitHub Enterprise), so a
 * provider-scoped environment token that applied to every matching host would be
 * sent to whatever `origin` happens to name — and a workspace whose origin points
 * at `github.someone-elses-box.com` would receive the user's real GITHUB_TOKEN.
 * An environment token therefore authenticates its canonical host and nothing
 * else; a self-hosted or Enterprise instance needs its own stored credential,
 * which is per-host by construction.
 */
const ENV_TOKENS = [
  { provider: 'github', host: 'github.com', names: ['GITHUB_TOKEN', 'GH_TOKEN'] },
  { provider: 'gitlab', host: 'gitlab.com', names: ['GITLAB_TOKEN'] },
]

/**
 * Serial write chain, as in the taskboard store: every mutation here is a
 * read-modify-write over one file, so two concurrent saves that interleaved
 * would drop the first one's host.
 */
let writes = Promise.resolve()

/** Run one mutation inside the serial write chain. */
function serialize(run) {
  const result = writes.then(run, run)
  writes = result.then(() => undefined, () => undefined)
  return result
}

/** Hosts match lowercased: DNS is case-insensitive and remote casing varies. */
function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase()
}

/** The token-free rows the browser is allowed to see, in a stable order. */
function hostRows(hosts) {
  return [...hosts.keys()].sort().map((host) => ({ host, source: 'file' }))
}

/**
 * Which provider environment variables are currently set, as
 * `[{ provider, variable, host }]` — the NAME of the variable and the one host it
 * authenticates, never its value.
 *
 * The settings UI needs this to stay honest: an env token is provider-scoped, not
 * host-scoped, so without it the panel would report "no credential stored for
 * github.com" while every request quietly succeeds, and the user would go looking
 * for a bug that is not there. `host` is equally load-bearing — it tells the user
 * that an Enterprise instance is NOT covered by this variable and still needs its
 * own stored token.
 */
export function envTokenSources() {
  const rows = []
  for (const entry of ENV_TOKENS) {
    for (const name of entry.names) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        rows.push({ provider: entry.provider, variable: name, host: entry.host })
        // Precedence: only the first variable that answers for a provider is
        // the one actually used, so listing the rest would be a lie.
        break
      }
    }
  }
  return rows
}

/**
 * The stored credentials as a Map of host → token. A Map, not a plain object:
 * host names come out of the file, and a hand-edited `__proto__` key would
 * mutate a prototype instead of storing a row.
 *
 * Never throws. A missing file is the common case; an unreadable or corrupt one
 * is quarantined and treated as empty, exactly like the taskboard ledger — a
 * broken credential file must degrade to "no stored token", never take a route
 * down.
 */
async function loadCredentials(file) {
  const hosts = new Map()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[dsh-plugin-repopanel] credentials unreadable:', error.message)
    }
    return hosts
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || typeof parsed.hosts !== 'object' || parsed.hosts === null || Array.isArray(parsed.hosts)) {
    console.warn('[dsh-plugin-repopanel] quarantining corrupt credentials file')
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* best effort */ }
    return hosts
  }
  for (const [host, entry] of Object.entries(parsed.hosts)) {
    const token = typeof entry?.token === 'string' ? entry.token.trim() : ''
    // A row with no usable token material is not a credential; dropping it
    // keeps "this host has a token" honest in the browser's list.
    if (token.length === 0) continue
    hosts.set(normalizeHost(host), token)
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
 * ACL. Treat the mode as a POSIX-only guarantee and do not tell the user the
 * file is locked down there.
 */
async function persistCredentials(file, hosts) {
  await mkdir(dirname(file), { recursive: true })
  // Null prototype so a `__proto__` host key becomes a row instead of silently
  // setting a prototype.
  const rows = Object.create(null)
  for (const [host, token] of hosts) rows[host] = { token }
  const content = JSON.stringify({ schemaVersion: CREDENTIALS_SCHEMA_VERSION, hosts: rows }, null, 2)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { encoding: 'utf8', mode: SECRET_MODE })
  await chmod(tmp, SECRET_MODE)
  await rename(tmp, file)
}

/**
 * Apply one mutation inside the write chain and answer with the token-free host
 * list, so a GUI save can refresh its list from the response without a second
 * read. The mutator reports whether anything actually changed — deleting a host
 * that was never stored must not create the file.
 */
async function mutate(file, mutator) {
  return serialize(async () => {
    const hosts = await loadCredentials(file)
    if (mutator(hosts) === true) await persistCredentials(file, hosts)
    return hostRows(hosts)
  })
}

/** The provider's environment token, in precedence order. */
function tokenFromEnv(provider, host) {
  const row = ENV_TOKENS.find((entry) => entry.provider === provider)
  // Canonical host only — see ENV_TOKENS. An Enterprise host silently falling
  // back to the file is the intended behavior, not an oversight.
  if (row === undefined || row.host !== host) return undefined
  for (const name of row.names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * The token a host is reached with plus where it came from
 * (`{ token, source: 'env' | 'file' }`), or undefined when neither source has
 * one — the caller turns that into ERR.noAccount.
 *
 * Environment variables are read FRESH on every call and never cached at module
 * load: the host process is long-lived, so a user who exports a missing token
 * has to be seen without restarting it.
 */
export async function resolveToken(file, host, provider) {
  const key = normalizeHost(host)
  const fromEnv = tokenFromEnv(provider, key)
  if (fromEnv !== undefined) return { token: fromEnv, source: 'env' }
  if (key.length === 0) return undefined
  const hosts = await loadCredentials(file)
  const token = hosts.get(key)
  return token === undefined ? undefined : { token, source: 'file' }
}

/**
 * Which hosts have a stored credential, as `[{ host, source: 'file' }]`.
 *
 * This is the ONLY credential shape the browser is allowed to see: that a token
 * exists, and for which host. No token material is returned here — not the
 * value, not a prefix, not a length.
 */
export async function loadCredentialHosts(file) {
  return hostRows(await loadCredentials(file))
}

/**
 * Store (or replace) one host's token and answer with the new token-free host
 * list. A blank token is rejected rather than stored: it would present as "this
 * host has a credential" and then fail every request with a 401. The value is
 * trimmed because a pasted token usually arrives with a trailing newline.
 *
 * The file is rewritten even when the token is unchanged, which is also how a
 * file whose mode drifted gets repaired. A failed write throws: a token the
 * user believes is saved but is not is worse than an error on the spot.
 */
export async function saveToken(file, host, token) {
  const key = normalizeHost(host)
  if (key.length === 0) throw new PanelError(ERR.invalidInput, 'host must not be empty')
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new PanelError(ERR.invalidInput, 'token must not be empty')
  }
  const value = token.trim()
  return mutate(file, (hosts) => {
    hosts.set(key, value)
    return true
  })
}

/**
 * Forget one host's token and answer with the new token-free host list. Deleting
 * a host that was never stored is a no-op rather than an error: the panel's
 * remove button has to be idempotent.
 */
export async function deleteToken(file, host) {
  const key = normalizeHost(host)
  return mutate(file, (hosts) => hosts.delete(key))
}
