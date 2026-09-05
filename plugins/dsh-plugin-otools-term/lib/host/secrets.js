/**
 * Credential material, kept out of the ledger the browser reads.
 *
 * Two files under the DSH home, both written 0600:
 *
 *   dsh-plugin-otools-term-secrets.json       passwords / passphrases / key bodies
 *   dsh-plugin-otools-term-known-hosts.json   accepted host keys (trust on first use)
 *
 * The browser can WRITE a secret (that is how you save a password) and can ask
 * whether one exists, but there is no route that reads one back — the value only
 * ever travels from this file into an ssh2 config object inside the host process.
 * The reference plugin shipped passwords to its front end inside the same JSON
 * blob it used for window layout, and passed them to `cmdkey /pass:` on a Windows
 * command line where any process listing could see them.
 *
 * Host keys are verified. The reference fetched the remote key only to log it and
 * connected regardless, which makes every session trust-on-every-use — i.e. no
 * protection against an intercepted connection at all. Here the first connection
 * to a host returns its fingerprint as a `host_key` failure, the panel shows it,
 * and only an explicit accept writes it down; a LATER mismatch is a hard failure
 * that no accept button clears (the user has to delete the pin, which is the same
 * stance OpenSSH takes).
 *
 * @module dsh-plugin-otools-term/host/secrets
 */
import { createHash } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { ERR, TermError } from '../shared/protocol.js'
import { writePrivate } from './sdk.js'

/** Secret-store file name; the caller joins it onto the DSH home. */
export const SECRETS_FILE = 'dsh-plugin-otools-term-secrets.json'

/** Host-key pin file name. */
export const KNOWN_HOSTS_FILE = 'dsh-plugin-otools-term-known-hosts.json'

/** The fields a server record can have a secret for. */
export const SECRET_FIELDS = ['password', 'passphrase', 'privateKeyBody']

/** Longest secret accepted (a 4096-bit key with comments is a few KB). */
const MAX_SECRET_CHARS = 64 * 1024

/** A JSON object from disk, or null when unreadable/corrupt (quarantined). */
async function readObject(file, label) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[dsh-plugin-otools-term] ${label} unreadable:`, error.message)
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(`[dsh-plugin-otools-term] quarantining corrupt ${label}`)
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* best effort */ }
    return null
  }
  return parsed
}

/** The secret store. */
export class SecretStore {
  constructor(options) {
    this.file = options.file
    // Null prototype: keys are server ids read from a file.
    this.rows = Object.create(null)
    this.loaded = false
    this.writes = Promise.resolve()
  }

  /** Load once. Never throws. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    const parsed = await readObject(this.file, 'secret store')
    if (parsed === null) return
    const rows = Object.create(null)
    for (const [id, row] of Object.entries(parsed)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      const clean = Object.create(null)
      for (const field of SECRET_FIELDS) {
        const value = row[field]
        if (typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS) clean[field] = value
      }
      if (Object.keys(clean).length > 0) rows[String(id).slice(0, 200)] = clean
    }
    this.rows = rows
  }

  /** Whether one field is stored (the only thing the browser learns). */
  has(serverId, field) {
    const row = this.rows[serverId]
    return row !== undefined && typeof row[field] === 'string' && row[field].length > 0
  }

  /** Read one secret. Host-side only — no route returns this. */
  get(serverId, field) {
    const row = this.rows[serverId]
    if (row === undefined) return undefined
    const value = row[field]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /**
   * Merge a patch. `undefined` leaves a field alone; `null` or `''` clears it.
   * Returns the presence map so the caller can answer the browser.
   */
  async set(serverId, patch) {
    await this.load()
    const row = { ...(this.rows[serverId] ?? {}) }
    for (const field of SECRET_FIELDS) {
      if (!Object.hasOwn(patch, field)) continue
      const value = patch[field]
      if (value === null || value === '' || value === undefined) {
        delete row[field]
        continue
      }
      if (typeof value !== 'string') throw new TermError(ERR.invalidInput, `${field} must be a string`)
      if (value.length > MAX_SECRET_CHARS) throw new TermError(ERR.tooLarge, `${field} is too long`)
      row[field] = value
    }
    if (Object.keys(row).length === 0) delete this.rows[serverId]
    else this.rows[serverId] = row
    await this.persist()
    return this.presence(serverId)
  }

  /** Forget every secret of one server. */
  async remove(serverId) {
    await this.load()
    if (this.rows[serverId] === undefined) return
    delete this.rows[serverId]
    await this.persist()
  }

  /** `{hasPassword, hasPassphrase, hasPrivateKeyBody}` for one server. */
  presence(serverId) {
    return {
      hasPassword: this.has(serverId, 'password'),
      hasPassphrase: this.has(serverId, 'passphrase'),
      hasPrivateKeyBody: this.has(serverId, 'privateKeyBody'),
    }
  }

  /** Atomic 0600 write inside the serial chain. */
  persist() {
    const run = () => writePrivate(this.file, JSON.stringify(this.rows, null, 2))
    const result = this.writes.then(run, run)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
}

/** `SHA256:<base64>`, the fingerprint spelling OpenSSH prints. */
export function fingerprintOf(keyBuffer) {
  const digest = createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/** The pin store. */
export class KnownHosts {
  constructor(options) {
    this.file = options.file
    this.rows = Object.create(null)
    this.loaded = false
    this.writes = Promise.resolve()
  }

  /** Load once. Never throws. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    const parsed = await readObject(this.file, 'known-hosts file')
    if (parsed === null) return
    const rows = Object.create(null)
    for (const [key, row] of Object.entries(parsed)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      if (typeof row.fingerprint !== 'string' || row.fingerprint.length === 0) continue
      rows[String(key).slice(0, 300)] = {
        fingerprint: row.fingerprint.slice(0, 200),
        keyType: typeof row.keyType === 'string' ? row.keyType.slice(0, 60) : '',
        acceptedAt: typeof row.acceptedAt === 'number' ? row.acceptedAt : 0,
      }
    }
    this.rows = rows
  }

  /** The ledger key for one endpoint. */
  static keyOf(host, port) {
    return port === 22 ? String(host).toLowerCase() : `[${String(host).toLowerCase()}]:${port}`
  }

  /** The pinned record for one endpoint, or undefined. */
  lookup(host, port) {
    return this.rows[KnownHosts.keyOf(host, port)]
  }

  /** Pin one endpoint's key. */
  async remember(host, port, keyType, fingerprint) {
    await this.load()
    this.rows[KnownHosts.keyOf(host, port)] = { fingerprint, keyType, acceptedAt: Date.now() }
    await this.persist()
  }

  /** Drop a pin (the only way past a mismatch). */
  async forget(host, port) {
    await this.load()
    delete this.rows[KnownHosts.keyOf(host, port)]
    await this.persist()
  }

  /** Every pin, for the settings dialog. */
  list() {
    return Object.entries(this.rows).map(([endpoint, row]) => ({ endpoint, ...row }))
  }

  /** Atomic 0600 write inside the serial chain. */
  persist() {
    const run = () => writePrivate(this.file, JSON.stringify(this.rows, null, 2))
    const result = this.writes.then(run, run)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
}
