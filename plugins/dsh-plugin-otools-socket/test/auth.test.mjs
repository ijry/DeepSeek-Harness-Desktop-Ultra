import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCESS_TTL_MS,
  PairingOffers,
  REFRESH_TTL_MS,
  mintDevice,
  mintToken,
  offerAccepts,
} from '../src/host/auth.js'

import { DeviceAuth } from '../src/host/auth.js'

class MemoryStore {
  constructor(options = {}) {
    this.devices = []
    this.failNext = false
    this.delay = options.delay ?? (() => Promise.resolve())
    this.queue = Promise.resolve()
  }

  snapshot() { return { devices: structuredClone(this.devices) } }

  transact(mutator) {
    const run = async () => {
      await this.delay()
      const draft = structuredClone({ devices: this.devices })
      const result = mutator(draft)
      if (this.failNext) {
        this.failNext = false
        throw new Error('disk full')
      }
      this.devices = draft.devices
      return result
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

test('issued credentials have explicit expiry and are absent from persisted record', () => {
  const { tokens, record } = mintDevice('phone', 1000)
  assert.equal(record.accessExpiresAt, 1000 + ACCESS_TTL_MS)
  assert.equal(record.refreshExpiresAt, 1000 + REFRESH_TTL_MS)
  assert.equal(record.revokedAt, null)
  const persisted = JSON.stringify(record)
  assert.equal(persisted.includes(tokens.accessToken), false)
  assert.equal(persisted.includes(tokens.refreshToken), false)
  assert.match(record.tokenHash, /^[a-f0-9]{64}$/)
  assert.match(record.refreshHash, /^[a-f0-9]{64}$/)
  assert.match(tokens.accessToken, /^dshs_[A-Za-z0-9_-]{43}$/)
  assert.match(tokens.refreshToken, /^dshs_[A-Za-z0-9_-]{43}$/)
})

test('pair offer expires and is consumed once', () => {
  let now = 1000
  const offers = new PairingOffers(() => now)
  const first = offers.current()
  assert.equal(offerAccepts(first, first.code, first.secret, now), true)
  assert.equal(offers.consume(first.code, first.secret), true)
  assert.equal(offers.consume(first.code, first.secret), false)
  const second = offers.current()
  now = second.expiresAt
  assert.equal(offers.consume(second.code, second.secret), false)
})

test('pair failures are throttled after ten attempts in one minute', () => {
  let now = 0
  const offers = new PairingOffers(() => now)
  for (let index = 0; index < 10; index += 1) assert.equal(offers.consume('AAAA-AAAA', 'wrong'), false)
  assert.equal(offers.throttled(), true)
  now = 60_001
  assert.equal(offers.throttled(), false)
})

test('pair returns plaintext only after durable write succeeds', async () => {
  const store = new MemoryStore()
  const offers = new PairingOffers(() => 1000)
  const auth = new DeviceAuth({ store, offers, now: () => 1000 })
  const offer = offers.current()
  store.failNext = true
  await assert.rejects(auth.pair({ code: offer.code, secret: offer.secret, name: 'phone' }), /disk full/)
  assert.equal(store.devices.length, 0)
  // Persistence failed before consumption, so the same one-use offer remains valid.
  const paired = await auth.pair({ code: offer.code, secret: offer.secret, name: 'phone' })
  assert.match(paired.accessToken, /^dshs_/)
  assert.equal(store.devices.length, 1)
})

test('access authentication enforces expiry and revocation', async () => {
  let now = 1000
  const store = new MemoryStore()
  const auth = new DeviceAuth({ store, offers: new PairingOffers(() => now), now: () => now })
  const offer = auth.offers.current()
  const paired = await auth.pair({ code: offer.code, secret: offer.secret, name: 'phone' })
  assert.equal(auth.authenticateAccess(paired.accessToken).deviceId, paired.deviceId)
  now = 1000 + ACCESS_TTL_MS
  assert.equal(auth.authenticateAccess(paired.accessToken), undefined)
  now = 2000
  await auth.revoke(paired.deviceId)
  assert.equal(auth.authenticateAccess(paired.accessToken), undefined)
})

test('refresh rotates once; concurrent use has exactly one winner', async () => {
  let release
  let calls = 0
  const gate = () => new Promise(resolve => {
    calls += 1
    if (calls === 1) release = resolve
    else resolve()
  })
  const store = new MemoryStore({ delay: gate })
  const auth = new DeviceAuth({ store, offers: new PairingOffers(() => 1000), now: () => 1000 })
  const offer = auth.offers.current()
  const pairing = auth.pair({ code: offer.code, secret: offer.secret, name: 'phone' })
  await Promise.resolve()
  release()
  const paired = await pairing

  const results = await Promise.allSettled([
    auth.refresh(paired.refreshToken),
    auth.refresh(paired.refreshToken),
  ])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.filter(row => row.status === 'rejected').length, 1)
  const next = results.find(row => row.status === 'fulfilled').value
  assert.notEqual(next.refreshToken, paired.refreshToken)
  await assert.rejects(auth.refresh(paired.refreshToken), error => error?.code === 'unauthorized')
})

test('failed refresh persistence keeps the old durable refresh valid', async () => {
  const store = new MemoryStore()
  const auth = new DeviceAuth({ store, offers: new PairingOffers(() => 1000), now: () => 1000 })
  const offer = auth.offers.current()
  const paired = await auth.pair({ code: offer.code, secret: offer.secret, name: 'phone' })
  store.failNext = true
  await assert.rejects(auth.refresh(paired.refreshToken), /disk full/)
  const next = await auth.refresh(paired.refreshToken)
  assert.match(next.refreshToken, /^dshs_/)
})

test('mintToken has 256 bits of entropy and stable prefix', () => {
  const token = mintToken()
  assert.match(token, /^dshs_[A-Za-z0-9_-]{43}$/)
})
