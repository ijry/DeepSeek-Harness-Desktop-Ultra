/**
 * Durable state: the host's stable target id, its display name, and the paired
 * devices. One JSON file under the dsh home, written atomically through a serial
 * queue — the same discipline the sibling taskboard plugin uses, for the same
 * reason: two concurrent pair requests must not interleave into a lost device.
 *
 * The pairing offer is deliberately **not** here. It is minted in memory at boot
 * and consumed on first use (see host/auth.js), so there is no plaintext pairing
 * secret at rest to leak, and a QR photographed yesterday cannot pair today.
 *
 * A corrupt file is quarantined rather than thrown: losing the device list means
 * re-pairing a phone, while refusing to start means the whole harness fails to
 * boot over a bookkeeping file.
 *
 * @module dsh-plugin-mobile-bridge/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { mintTargetId } from './auth.js'

/** Ledger schema version; bumped only for a shape change readers must notice. */
export const SCHEMA_VERSION = 1

/** How many devices may be paired at once. A phone-remote is not a fleet manager. */
export const MAX_DEVICES = 16

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, targetId: mintTargetId(), displayName: '', devices: [] }
}

/** Keep only the rows that are shaped like device records. */
function sanitize(raw) {
  const ledger = emptyLedger()
  if (raw === null || typeof raw !== 'object') return ledger
  if (typeof raw.targetId === 'string' && raw.targetId.length > 0) ledger.targetId = raw.targetId
  if (typeof raw.displayName === 'string') ledger.displayName = raw.displayName
  const rows = Array.isArray(raw.devices) ? raw.devices : []
  ledger.devices = rows
    .filter(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.deviceId === 'string' &&
        typeof row.tokenHash === 'string',
    )
    .map((row) => ({
      deviceId: row.deviceId,
      name: typeof row.name === 'string' ? row.name : '未命名设备',
      tokenHash: row.tokenHash,
      refreshHash: typeof row.refreshHash === 'string' ? row.refreshHash : '',
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : 0,
      revokedAt: Number.isFinite(row.revokedAt) ? row.revokedAt : null,
    }))
    .slice(0, MAX_DEVICES)
  return ledger
}

async function persistAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** The paired-device ledger. */
export class DeviceStore {
  constructor(options) {
    this.file = options.file
    this.ledger = emptyLedger()
    this.loaded = false
    this.queue = Promise.resolve()
    this.listeners = new Set()
  }

  /** Read the file once; a missing or corrupt file yields a fresh empty ledger. */
  async load() {
    if (this.loaded) return this.snapshot()
    let raw = null
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const quarantine = `${this.file}.corrupt-${Date.now()}`
        try {
          await rename(this.file, quarantine)
          console.warn(`[dsh-plugin-mobile-bridge] 配对档损坏，已改名为 ${quarantine}`)
        } catch {
          console.warn('[dsh-plugin-mobile-bridge] 配对档损坏且无法改名，本次以空档启动')
        }
      }
    }
    this.ledger = sanitize(raw)
    this.loaded = true
    return this.snapshot()
  }

  /** A frozen read-only view. */
  snapshot() {
    return Object.freeze({
      schemaVersion: this.ledger.schemaVersion,
      targetId: this.ledger.targetId,
      displayName: this.ledger.displayName,
      devices: this.ledger.devices.map((device) => Object.freeze({ ...device })),
    })
  }

  /** Subscribe to committed changes; returns the disposer. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Apply one mutation under the serial queue. The mutator sees a draft and
   * returns true to commit; returning false makes the whole call a no-op.
   * @param {(draft: object) => boolean} mutator - the change.
   * @returns {Promise<object>} the snapshot after the attempt.
   */
  async mutate(mutator) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      if (mutator(draft) !== true) return this.snapshot()
      draft.schemaVersion = SCHEMA_VERSION
      this.ledger = draft
      try {
        await persistAtomic(this.file, `${JSON.stringify(draft, null, 2)}\n`)
      } catch (error) {
        // The in-memory change stands: undoing a successful pair because the
        // disk is full would be the worse outcome, and the next write retries.
        console.warn(`[dsh-plugin-mobile-bridge] 写配对档失败：${error.message}`)
      }
      const snapshot = this.snapshot()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          /* one bad listener must not break a commit */
        }
      }
      return snapshot
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Record a newly paired device, evicting the oldest revoked row when full. */
  addDevice(record) {
    return this.mutate((draft) => {
      draft.devices = draft.devices.filter((device) => device.revokedAt === null)
      if (draft.devices.length >= MAX_DEVICES) draft.devices.shift()
      draft.devices.push(record)
      return true
    })
  }

  /** Mark one device revoked; unknown ids are a no-op, so revoke is idempotent. */
  revokeDevice(deviceId, now) {
    return this.mutate((draft) => {
      const device = draft.devices.find((row) => row.deviceId === deviceId && row.revokedAt === null)
      if (device === undefined) return false
      device.revokedAt = now
      return true
    })
  }

  /** Revoke every live device — the "someone photographed my screen" button. */
  revokeAll(now) {
    return this.mutate((draft) => {
      let changed = false
      for (const device of draft.devices) {
        if (device.revokedAt === null) {
          device.revokedAt = now
          changed = true
        }
      }
      return changed
    })
  }

  /** Rotate one device's credentials in place, keeping its identity and name. */
  rotateDevice(deviceId, tokenHash, refreshHash, now) {
    return this.mutate((draft) => {
      const device = draft.devices.find((row) => row.deviceId === deviceId && row.revokedAt === null)
      if (device === undefined) return false
      device.tokenHash = tokenHash
      device.refreshHash = refreshHash
      device.lastSeenAt = now
      return true
    })
  }

  /**
   * Note that a device was seen. Cheap and frequent, so it never writes: the
   * last-seen stamp is advisory and a lost one costs nothing, while a disk write
   * per request would put the ledger in the hot path.
   */
  touch(deviceId, now) {
    const device = this.ledger.devices.find((row) => row.deviceId === deviceId)
    if (device !== undefined) device.lastSeenAt = now
  }

  /** Set the human-facing host name shown in the pairing QR. */
  setDisplayName(name) {
    return this.mutate((draft) => {
      const next = String(name ?? '').slice(0, 64)
      if (next === draft.displayName) return false
      draft.displayName = next
      return true
    })
  }
}
