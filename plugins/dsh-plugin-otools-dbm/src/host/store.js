/**
 * Everything this plugin writes to disk.
 *
 * Five files under `<DSH home>/dsh-plugin-otools-dbm/`:
 *
 *   connections.json   the connection ledger — HOLDS DATABASE PASSWORDS, 0600
 *   state.json         the panel's own UI state (tree expansion, last table…)
 *   ui-state.json      the same, under the panel's `ui` scheme
 *   backup-plans.json  scheduled backups
 *   sync-logs.json     the sync centre's history, newest first, capped
 *
 * Two deliberate choices worth knowing:
 *
 * 1. Passwords are stored in plaintext, 0600, exactly as the reference plugin
 *    (and AirDB, and every other desktop DB client) does. Encrypting them with a
 *    key that also has to live on the same disk buys nothing; what does buy
 *    something is the file mode and never echoing a password back to the browser.
 *    `redactConnection` is the enforcement point for the second half of that.
 * 2. Writes are atomic (temp file + rename, mode applied before the rename), so a
 *    crash mid-save cannot leave a truncated ledger — losing every saved
 *    connection is the kind of bug a user never forgives.
 *
 * @module dsh-plugin-otools-dbm/host/store
 */
import { readFile } from 'node:fs/promises'

import { DbmError, ERR } from '../shared/protocol.js'

import { pluginHomePath, writeFileAtomic } from './sdk.js'

export const CONNECTIONS_FILE = 'connections.json'
export const STATE_FILE = 'state.json'
export const UI_STATE_FILE = 'ui-state.json'
export const BACKUP_PLANS_FILE = 'backup-plans.json'
export const SYNC_LOGS_FILE = 'sync-logs.json'

/** Newest-first history cap; the sync centre only ever shows the recent past. */
export const SYNC_LOG_LIMIT = 300

/** A JSON file with an in-memory copy, atomic writes and a corrupt-file path. */
export class JsonStore {
  /**
   * @param options.file - absolute path.
   * @param options.fallback - value to use when the file is missing or unreadable.
   * @param options.mode - file mode; 0o600 for anything holding a secret.
   */
  constructor({ file, fallback, mode = 0o600 }) {
    this.file = file
    this.mode = mode
    this.makeFallback = typeof fallback === 'function' ? fallback : () => structuredClone(fallback)
    this.value = undefined
    this.loading = null
    this.revision = 0
  }

  /** Load once; never throws. A corrupt file is renamed aside, not deleted. */
  async load() {
    if (this.value !== undefined) {
      return this.value
    }
    if (this.loading !== null) {
      return this.loading
    }
    this.loading = (async () => {
      try {
        const raw = await readFile(this.file, 'utf8')
        this.value = JSON.parse(raw)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`[dsh-plugin-otools-dbm] ${this.file} 读取失败，已回退到默认值:`, error?.message ?? error)
          await quarantine(this.file)
        }
        this.value = this.makeFallback()
      }
      this.loading = null
      return this.value
    })()
    return this.loading
  }

  /** The loaded value without waiting — defaults until `load()` resolves. */
  snapshot() {
    return this.value === undefined ? this.makeFallback() : this.value
  }

  /** Replace the whole value and persist it. */
  async save(value) {
    this.value = value
    this.revision += 1
    await writeFileAtomic(this.file, `${JSON.stringify(value, null, 2)}\n`, this.mode)
    return value
  }

  /** Read-modify-write under the caller's mutator. */
  async update(mutate) {
    const current = await this.load()
    const next = mutate(current)
    return this.save(next === undefined ? current : next)
  }
}

/** Rename an unparseable file aside so the next boot starts clean. */
async function quarantine(file) {
  try {
    const { rename } = await import('node:fs/promises')
    await rename(file, `${file}.corrupt-${Date.now()}`)
  } catch {
    // Best effort: if we cannot move it, the fallback value still applies.
  }
}

/** The connection ledger. */
export class ConnectionStore {
  constructor() {
    this.store = new JsonStore({
      file: pluginHomePath(CONNECTIONS_FILE),
      fallback: () => ({ connections: [] }),
      mode: 0o600,
    })
  }

  async list() {
    const state = await this.store.load()
    return Array.isArray(state.connections) ? state.connections : []
  }

  async get(id) {
    const wanted = String(id ?? '')
    return (await this.list()).find((row) => String(row.id) === wanted)
  }

  /** Like `get`, but throws the panel's own wording when it is missing. */
  async require(id) {
    const found = await this.get(id)
    if (found === undefined) {
      throw new DbmError(ERR.notFound, `连接不存在: ${String(id ?? '')}`)
    }
    return found
  }

  async add(connection) {
    const rows = await this.list()
    const name = String(connection?.name ?? '').trim()
    if (name.length === 0) {
      throw new DbmError(ERR.invalidInput, '连接名称不能为空')
    }
    if (rows.some((row) => String(row.name).trim() === name)) {
      throw new DbmError(ERR.conflict, '连接名称已存在')
    }
    const id = String(connection?.id ?? '').trim() || String(Date.now())
    const record = {
      ...connection,
      id,
      created_at: connection?.created_at ?? new Date().toISOString(),
    }
    await this.store.save({ connections: [...rows, record] })
    return id
  }

  async replace(id, connection) {
    const rows = await this.list()
    const index = rows.findIndex((row) => String(row.id) === String(id))
    if (index === -1) {
      throw new DbmError(ERR.notFound, `连接不存在: ${String(id ?? '')}`)
    }
    const name = String(connection?.name ?? '').trim()
    if (rows.some((row, position) => position !== index && String(row.name).trim() === name)) {
      throw new DbmError(ERR.conflict, '连接名称已存在')
    }
    const next = rows.slice()
    next[index] = { ...rows[index], ...connection, id: String(id), created_at: rows[index].created_at }
    await this.store.save({ connections: next })
    return next[index]
  }

  async remove(id) {
    const rows = await this.list()
    const next = rows.filter((row) => String(row.id) !== String(id))
    if (next.length === rows.length) {
      throw new DbmError(ERR.notFound, `连接不存在: ${String(id ?? '')}`)
    }
    await this.store.save({ connections: next })
  }
}

/**
 * A connection as the browser may see it.
 *
 * The panel's edit form needs to know THAT a password is set (so it can show a
 * filled field it will not resend), never what it is. The same goes for the SSH
 * password, the key passphrase and the ODBC connection string, which routinely
 * embeds `PWD=`.
 */
export function redactConnection(connection) {
  if (connection === null || connection === undefined) {
    return connection
  }
  const masked = { ...connection }
  masked.password = connection.password ? SECRET_PLACEHOLDER : ''
  if (masked.ssh !== null && masked.ssh !== undefined) {
    masked.ssh = {
      ...masked.ssh,
      password: masked.ssh.password ? SECRET_PLACEHOLDER : '',
      passphrase: masked.ssh.passphrase ? SECRET_PLACEHOLDER : '',
    }
  }
  if (masked.odbc !== null && masked.odbc !== undefined && masked.odbc.connection_string) {
    masked.odbc = { ...masked.odbc, connection_string: SECRET_PLACEHOLDER }
  }
  if (masked.mongodb !== null && masked.mongodb !== undefined && masked.mongodb.tls_certificate_key_file_password) {
    masked.mongodb = { ...masked.mongodb, tls_certificate_key_file_password: SECRET_PLACEHOLDER }
  }
  // The connection string is derived from the credentials, so it leaks them.
  if (typeof masked.connection_string === 'string' && masked.connection_string.length > 0) {
    masked.connection_string = masked.connection_string.replace(/(:\/\/[^:/@]*:)[^@]*@/, '$1***@')
  }
  return masked
}

/** What a redacted password field looks like on the wire. */
export const SECRET_PLACEHOLDER = '__dsh_dbm_secret__'

/**
 * Merge an incoming edit over the stored record, keeping secrets the browser did
 * not resend. Without this, saving the edit form would blank every password.
 */
export function mergeSecrets(incoming, stored) {
  if (stored === null || stored === undefined) {
    return incoming
  }
  const merged = { ...incoming }
  if (merged.password === SECRET_PLACEHOLDER || merged.password === undefined) {
    merged.password = stored.password ?? ''
  }
  if (merged.ssh !== null && merged.ssh !== undefined) {
    merged.ssh = { ...merged.ssh }
    if (merged.ssh.password === SECRET_PLACEHOLDER || merged.ssh.password === undefined) {
      merged.ssh.password = stored.ssh?.password ?? ''
    }
    if (merged.ssh.passphrase === SECRET_PLACEHOLDER || merged.ssh.passphrase === undefined) {
      merged.ssh.passphrase = stored.ssh?.passphrase ?? ''
    }
  }
  if (merged.odbc !== null && merged.odbc !== undefined && merged.odbc.connection_string === SECRET_PLACEHOLDER) {
    merged.odbc = { ...merged.odbc, connection_string: stored.odbc?.connection_string ?? '' }
  }
  if (
    merged.mongodb !== null
    && merged.mongodb !== undefined
    && merged.mongodb.tls_certificate_key_file_password === SECRET_PLACEHOLDER
  ) {
    merged.mongodb = {
      ...merged.mongodb,
      tls_certificate_key_file_password: stored.mongodb?.tls_certificate_key_file_password ?? '',
    }
  }
  return merged
}

/** The panel's own UI state, one file per scheme. */
export class PluginStateStore {
  constructor() {
    this.stores = new Map()
  }

  fileFor(scheme) {
    const normalized = String(scheme ?? '').trim()
    if (normalized.length === 0) {
      return pluginHomePath(STATE_FILE)
    }
    if (normalized === 'ui') {
      return pluginHomePath(UI_STATE_FILE)
    }
    if (!/^[a-z0-9_-]{1,32}$/i.test(normalized)) {
      throw new DbmError(ERR.invalidInput, `状态分区名不合法: ${normalized}`)
    }
    return pluginHomePath(`state-${normalized}.json`)
  }

  storeFor(scheme) {
    const file = this.fileFor(scheme)
    let store = this.stores.get(file)
    if (store === undefined) {
      store = new JsonStore({ file, fallback: () => ({}), mode: 0o600 })
      this.stores.set(file, store)
    }
    return store
  }

  async read(scheme) {
    return this.storeFor(scheme).load()
  }

  async write(scheme, state) {
    const value = state === null || state === undefined ? {} : state
    await this.storeFor(scheme).save(value)
  }
}

/** Scheduled backups. */
export class BackupPlanStore extends JsonStore {
  constructor() {
    super({ file: pluginHomePath(BACKUP_PLANS_FILE), fallback: () => ({ plans: [] }), mode: 0o600 })
  }

  async list() {
    const state = await this.load()
    return Array.isArray(state.plans) ? state.plans : []
  }

  async replaceAll(plans) {
    await this.save({ plans })
    return plans
  }
}

/** The sync centre's history. */
export class SyncLogStore extends JsonStore {
  constructor() {
    super({ file: pluginHomePath(SYNC_LOGS_FILE), fallback: () => ({ logs: [] }), mode: 0o600 })
  }

  async list() {
    const state = await this.load()
    const logs = Array.isArray(state.logs) ? state.logs : []
    return logs
      .slice()
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      .slice(0, SYNC_LOG_LIMIT)
  }

  async append(entry) {
    const logs = await this.list()
    await this.save({ logs: [entry, ...logs].slice(0, SYNC_LOG_LIMIT) })
    return entry
  }
}
