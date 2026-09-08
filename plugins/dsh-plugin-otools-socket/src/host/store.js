import * as nodeFs from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const MAX_DEVICES = 64

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, targetId: randomUUID(), displayName: '', devices: [] }
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function sanitize(raw, now) {
  const ledger = emptyLedger()
  if (!raw || typeof raw !== 'object') return ledger
  if (typeof raw.targetId === 'string' && raw.targetId.length > 0) ledger.targetId = raw.targetId
  if (typeof raw.displayName === 'string') ledger.displayName = raw.displayName.slice(0, 64)
  ledger.devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .filter(row => row && typeof row === 'object'
      && typeof row.deviceId === 'string'
      && validHash(row.tokenHash)
      && validHash(row.refreshHash)
      && Number.isFinite(row.accessExpiresAt)
      && Number.isFinite(row.refreshExpiresAt)
      && row.refreshExpiresAt > now)
    .map(row => ({
      deviceId: row.deviceId,
      name: typeof row.name === 'string' ? row.name.slice(0, 64) : 'Unnamed device',
      tokenHash: row.tokenHash,
      refreshHash: row.refreshHash,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : 0,
      revokedAt: Number.isFinite(row.revokedAt) ? row.revokedAt : null,
    }))
    .slice(-MAX_DEVICES)
  return ledger
}

export class DeviceStore {
  constructor(options) {
    this.file = options.file
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? (() => Date.now())
    this.ledger = emptyLedger()
    this.loaded = false
    this.queue = Promise.resolve()
    this.listeners = new Set()
  }

  async load() {
    if (this.loaded) return this.snapshot()
    let raw = null
    try {
      raw = JSON.parse(await this.fs.readFile(this.file, 'utf8'))
    } catch (reason) {
      if (reason?.code !== 'ENOENT') {
        try { await this.fs.rename(this.file, `${this.file}.corrupt-${this.now()}`) } catch { /* start clean */ }
      }
    }
    this.ledger = sanitize(raw, this.now())
    this.loaded = true
    return this.snapshot()
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: this.ledger.schemaVersion,
      targetId: this.ledger.targetId,
      displayName: this.ledger.displayName,
      devices: this.ledger.devices.map(device => ({ ...device })),
    })
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async persist(draft) {
    await this.fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${this.now()}`
    await this.fs.writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
    await this.fs.rename(tmp, this.file)
  }

  transact(mutator) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      const value = mutator(draft)
      if (value === false) return false
      draft.schemaVersion = SCHEMA_VERSION
      if (draft.devices.length > MAX_DEVICES) draft.devices = draft.devices.slice(-MAX_DEVICES)
      await this.persist(draft)
      this.ledger = draft
      const snapshot = this.snapshot()
      for (const listener of this.listeners) {
        try { listener(snapshot) } catch { /* one listener cannot roll back durable commit */ }
      }
      return value
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
