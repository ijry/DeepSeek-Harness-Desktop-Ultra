import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const PAIRING_TTL_MS = 30 * 60 * 1000
export const ACCESS_TTL_MS = 24 * 60 * 60 * 1000
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const THROTTLE_WINDOW_MS = 60 * 1000
export const MAX_PAIR_FAILURES = 10
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TOKEN_PREFIX = 'dshs_'

function authError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export function mintToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

function mintCode() {
  const part = () => {
    let value = ''
    for (const byte of randomBytes(4)) value += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    return value
  }
  return `${part()}-${part()}`
}

function normalizeCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== 8) return ''
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)
    ? code : ''
}

function mintOffer(now) {
  return {
    code: mintCode(),
    secret: randomBytes(16).toString('base64url'),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  }
}

export function offerAccepts(offer, code, secret, now) {
  if (!offer || offer.expiresAt <= now) return false
  const codeOk = sameSecret(normalizeCode(code), offer.code)
  const secretOk = sameSecret(secret, offer.secret)
  return codeOk && secretOk
}

export class PairingOffers {
  constructor(now = () => Date.now()) {
    this.now = now
    this.offer = mintOffer(now())
    this.failures = []
  }

  current() {
    if (this.offer.expiresAt <= this.now()) this.offer = mintOffer(this.now())
    return this.offer
  }

  rotate() {
    this.offer = mintOffer(this.now())
    return this.offer
  }

  throttled() {
    const cutoff = this.now() - THROTTLE_WINDOW_MS
    this.failures = this.failures.filter(at => at > cutoff)
    return this.failures.length >= MAX_PAIR_FAILURES
  }

  check(code, secret) {
    if (this.throttled()) return false
    const ok = offerAccepts(this.current(), code, secret, this.now())
    if (!ok) this.failures.push(this.now())
    return ok
  }

  consume(code, secret) {
    if (!this.check(code, secret)) return false
    this.rotate()
    return true
  }
}

export function mintDevice(name, now, deviceId = randomUUID()) {
  const accessToken = mintToken()
  const refreshToken = mintToken()
  return {
    tokens: { accessToken, refreshToken },
    record: {
      deviceId,
      name: String(name ?? '').trim().slice(0, 64) || 'Unnamed device',
      tokenHash: sha256(accessToken),
      refreshHash: sha256(refreshToken),
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshExpiresAt: now + REFRESH_TTL_MS,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    },
  }
}

function liveDevice(devices, token, field, expiresField, now) {
  const presented = String(token ?? '')
  if (!presented.startsWith(TOKEN_PREFIX)) return undefined
  const hash = sha256(presented)
  return devices.find(device => device.revokedAt === null
    && device[expiresField] > now
    && sameSecret(device[field], hash))
}

export class DeviceAuth {
  constructor(options) {
    this.store = options.store
    this.offers = options.offers ?? new PairingOffers(options.now)
    this.now = options.now ?? (() => Date.now())
  }

  async pair(input) {
    if (!this.offers.check(input.code, input.secret)) {
      throw authError(this.offers.throttled() ? 'rate_limited' : 'unauthorized', 'pairing failed')
    }
    const issued = mintDevice(input.name, this.now())
    await this.store.transact(draft => {
      draft.devices = draft.devices.filter(device => device.revokedAt === null)
      draft.devices.push(issued.record)
      return issued.record.deviceId
    })
    this.offers.rotate()
    return { ...issued.tokens, deviceId: issued.record.deviceId }
  }

  authenticateAccess(token) {
    const device = liveDevice(this.store.snapshot().devices, token, 'tokenHash', 'accessExpiresAt', this.now())
    if (device) device.lastSeenAt = this.now()
    return device
  }

  async refresh(token) {
    let plaintext
    const now = this.now()
    const result = await this.store.transact(draft => {
      const device = liveDevice(draft.devices, token, 'refreshHash', 'refreshExpiresAt', now)
      if (!device) throw authError('unauthorized', 'refresh token is invalid')
      const issued = mintDevice(device.name, now, device.deviceId)
      device.tokenHash = issued.record.tokenHash
      device.refreshHash = issued.record.refreshHash
      device.accessExpiresAt = issued.record.accessExpiresAt
      device.refreshExpiresAt = issued.record.refreshExpiresAt
      device.lastSeenAt = now
      plaintext = issued.tokens
      return device.deviceId
    })
    return { ...plaintext, deviceId: result }
  }

  async revoke(deviceId) {
    const now = this.now()
    return this.store.transact(draft => {
      const device = draft.devices.find(row => row.deviceId === deviceId && row.revokedAt === null)
      if (!device) return false
      device.revokedAt = now
      return true
    })
  }

  listDevices() {
    return this.store.snapshot().devices.map(device => ({
      deviceId: device.deviceId,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    }))
  }
}
