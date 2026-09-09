import assert from 'node:assert/strict'
import test from 'node:test'

import { TicketStore } from '../src/host/tickets.js'

const spec = overrides => ({
  deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  contentType: 'application/octet-stream', maxBytes: 1024,
  idleTimeoutMs: 10_000, maxDurationMs: 60_000,
  onStart() {},
  ...overrides,
})

test('wrong device cannot consume; correct device gets only one start', () => {
  const tickets = new TicketStore({ now: () => 1000, isDeviceActive: () => true })
  const issued = tickets.issue(spec())
  const identity = { deviceId: 'phone-a', sourceId: 'example.files', kind: 'download' }
  assert.throws(() => tickets.consume(issued.ticket, { ...identity, deviceId: 'phone-b' }),
    error => error?.code === 'forbidden')
  assert.equal(tickets.consume(issued.ticket, identity).maxBytes, 1024)
  assert.throws(() => tickets.consume(issued.ticket, identity),
    error => error?.code === 'ticket_unavailable')
})

test('expired and revoked-device tickets fail without starting', () => {
  let now = 0
  let active = true
  const tickets = new TicketStore({ now: () => now, isDeviceActive: () => active })
  const expired = tickets.issue(spec())
  now = 60_000
  assert.throws(() => tickets.consume(expired.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  }), error => error?.code === 'ticket_unavailable')
  now = 0
  const revoked = tickets.issue(spec())
  active = false
  assert.throws(() => tickets.consume(revoked.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  }), error => error?.code === 'unauthorized')
})

test('two competing consumers have exactly one winner', async () => {
  const tickets = new TicketStore({ now: () => 0, isDeviceActive: () => true })
  const issued = tickets.issue(spec({ kind: 'upload' }))
  const identity = { deviceId: 'phone-a', sourceId: 'example.files', kind: 'upload' }
  const results = await Promise.allSettled([
    Promise.resolve().then(() => tickets.consume(issued.ticket, identity)),
    Promise.resolve().then(() => tickets.consume(issued.ticket, identity)),
  ])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.filter(row => row.status === 'rejected').length, 1)
})

test('source and device invalidation abort active transfers and unused tickets', () => {
  const tickets = new TicketStore({ now: () => 0, isDeviceActive: () => true })
  const unused = tickets.issue(spec())
  const active = tickets.issue(spec({ kind: 'upload' }))
  const consumed = tickets.consume(active.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'upload',
  })
  let aborted = false
  consumed.signal.addEventListener('abort', () => { aborted = true })
  tickets.invalidateSource('example.files')
  assert.equal(aborted, true)
  assert.throws(() => tickets.consume(unused.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  }), error => error?.code === 'ticket_unavailable')

  const another = tickets.issue(spec({ sourceId: 'example.other' }))
  tickets.invalidateDevice('phone-a')
  assert.throws(() => tickets.consume(another.ticket, {
    deviceId: 'phone-a', sourceId: 'example.other', kind: 'download',
  }), error => error?.code === 'ticket_unavailable')
})

test('idle and maximum-duration clocks abort an active transfer', () => {
  let now = 0
  let next = 0
  const timers = new Map()
  const clock = {
    now: () => now,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id)
        timer.fn()
      }
    },
  }
  const tickets = new TicketStore({ clock, isDeviceActive: () => true })
  const idleTicket = tickets.issue(spec({ idleTimeoutMs: 1000, maxDurationMs: 5000 }))
  const idle = tickets.consume(idleTicket.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  })
  let idleReason
  idle.signal.addEventListener('abort', () => { idleReason = idle.signal.reason })
  clock.advance(900)
  idle.touch()
  clock.advance(900)
  assert.equal(idle.signal.aborted, false)
  clock.advance(101)
  assert.equal(idleReason, 'idle_timeout')

  const durationTicket = tickets.issue(spec({ idleTimeoutMs: 5000, maxDurationMs: 1000 }))
  const duration = tickets.consume(durationTicket.ticket, {
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
  })
  clock.advance(1000)
  assert.equal(duration.signal.reason, 'max_duration')
})

test('validates transfer bounds and handler contract at issue time', () => {
  const tickets = new TicketStore({ now: () => 0, isDeviceActive: () => true })
  for (const invalid of [
    spec({ maxBytes: 0 }),
    spec({ idleTimeoutMs: 999 }),
    spec({ maxDurationMs: 86_400_001 }),
    spec({ onStart: null }),
  ]) assert.throws(() => tickets.issue(invalid), error => error?.code === 'invalid_input')
})
