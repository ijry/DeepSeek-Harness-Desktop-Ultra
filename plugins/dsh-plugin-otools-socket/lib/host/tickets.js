import { randomBytes } from 'node:crypto'

const TICKET_START_TTL_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1000
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const KINDS = new Set(['upload', 'download', 'binary-ws'])

function ticketError(code, message) {
  return Object.assign(new Error(message), { code })
}

function validSpec(spec) {
  return spec && typeof spec === 'object'
    && typeof spec.deviceId === 'string' && spec.deviceId.length > 0
    && typeof spec.sourceId === 'string' && spec.sourceId.length > 0
    && KINDS.has(spec.kind)
    && typeof spec.contentType === 'string' && spec.contentType.length > 0
    && Number.isSafeInteger(spec.maxBytes) && spec.maxBytes > 0
    && Number.isInteger(spec.idleTimeoutMs) && spec.idleTimeoutMs >= MIN_TIMEOUT_MS && spec.idleTimeoutMs <= MAX_IDLE_TIMEOUT_MS
    && Number.isInteger(spec.maxDurationMs) && spec.maxDurationMs >= MIN_TIMEOUT_MS && spec.maxDurationMs <= MAX_DURATION_MS
    && typeof spec.onStart === 'function'
}

export class TicketStore {
  constructor(options = {}) {
    this.clock = options.clock ?? {
      now: options.now ?? (() => Date.now()),
      setTimeout: (fn, delay) => {
        const timer = setTimeout(fn, delay)
        timer.unref?.()
        return timer
      },
      clearTimeout: timer => clearTimeout(timer),
    }
    this.now = this.clock.now
    this.isDeviceActive = options.isDeviceActive ?? (() => true)
    this.unused = new Map()
    this.active = new Set()
  }

  issue(spec) {
    if (!validSpec(spec)) throw ticketError('invalid_input', 'transfer specification is invalid')
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + TICKET_START_TTL_MS
    this.unused.set(ticket, { ...spec, ticket, expiresAt })
    return { ticket, expiresAt }
  }

  consume(ticket, identity) {
    const row = this.unused.get(ticket)
    if (!row || row.expiresAt <= this.now()) {
      if (row) this.unused.delete(ticket)
      throw ticketError('ticket_unavailable', 'transfer ticket is unavailable')
    }
    if (row.deviceId !== identity.deviceId) throw ticketError('forbidden', 'ticket belongs to another device')
    if (identity.sourceId !== undefined && row.sourceId !== identity.sourceId) {
      throw ticketError('forbidden', 'ticket belongs to another source')
    }
    if (row.kind !== identity.kind) throw ticketError('forbidden', 'ticket kind does not match')
    if (!this.isDeviceActive(row.deviceId)) throw ticketError('unauthorized', 'device is inactive')

    this.unused.delete(ticket)
    const controller = new AbortController()
    const active = {
      ...row,
      signal: controller.signal,
      abort: reason => {
        if (controller.signal.aborted) return
        controller.abort(reason)
        active.done()
      },
      done: () => {
        this.clock.clearTimeout(active.idleTimer)
        this.clock.clearTimeout(active.durationTimer)
        this.active.delete(active)
      },
    }
    const armIdle = () => {
      this.clock.clearTimeout(active.idleTimer)
      active.idleTimer = this.clock.setTimeout(() => active.abort('idle_timeout'), row.idleTimeoutMs)
    }
    active.touch = armIdle
    armIdle()
    active.durationTimer = this.clock.setTimeout(() => active.abort('max_duration'), row.maxDurationMs)
    this.active.add(active)
    return active
  }

  invalidateSource(sourceId) {
    for (const [ticket, row] of this.unused) if (row.sourceId === sourceId) this.unused.delete(ticket)
    for (const row of [...this.active]) if (row.sourceId === sourceId) {
      row.abort('source_disposed')
      this.active.delete(row)
    }
  }

  invalidateDevice(deviceId) {
    for (const [ticket, row] of this.unused) if (row.deviceId === deviceId) this.unused.delete(ticket)
    for (const row of [...this.active]) if (row.deviceId === deviceId) {
      row.abort('device_revoked')
      this.active.delete(row)
    }
  }

  dispose() {
    this.unused.clear()
    for (const row of [...this.active]) row.abort('service_disposed')
    this.active.clear()
  }
}
