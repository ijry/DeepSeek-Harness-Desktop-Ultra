import assert from 'node:assert/strict'
import test from 'node:test'

import { OtoolsSocketService } from '../src/host/service.js'

const catalog = (confirmation = 'none') => ({
  title: 'Example',
  commands: [{
    name: 'work/run', effect: 'write', confirmation,
    input: {
      type: 'object',
      properties: { value: { type: 'integer', minimum: 1, maximum: 3 } },
      required: ['value'],
      additionalProperties: false,
    },
  }],
})

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const token = ++id
      timers.set(token, { at: now + delay, fn })
      return token
    },
    clearTimeout(token) { timers.delete(token) },
    advance(ms) {
      now += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, row]) => row.at <= now)
          .sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) break
        for (const [token, row] of due) {
          timers.delete(token)
          row.fn()
        }
      }
    },
  }
}

function attach(service, frames, overrides = {}) {
  return service.attachClient({
    id: overrides.id ?? 'client-a', transport: 'paired', deviceId: 'phone-a',
    send(frame, priority) { frames.push({ frame, priority }); return true },
    ...overrides,
  })
}

test('validates declared input before dispatch and rejects unknown commands', async () => {
  let calls = 0
  const frames = []
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.work', protocolVersion: 1, exposure: 'paired', catalog: catalog(),
    hello: () => ({}), onRequest: () => { calls += 1; return { ok: true } },
  })
  const client = attach(service, frames)
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'bad',
    name: 'work/run', data: { value: 0, extra: true },
  })
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'missing',
    name: 'work/missing', data: {},
  })
  assert.equal(calls, 0)
  assert.deepEqual(frames.map(row => row.frame.error.code), ['invalid_input', 'not_found'])
  client.dispose(); source.dispose(); service.dispose()
})

test('cancel aborts only the matching pending request and settles once', async () => {
  const frames = []
  let aborted = false
  let resolve
  const work = new Promise(done => { resolve = done })
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.work', protocolVersion: 1, exposure: 'paired', catalog: catalog(),
    hello: () => ({}),
    onRequest: (_request, context) => {
      context.signal.addEventListener('abort', () => { aborted = true })
      return work
    },
  })
  const client = attach(service, frames)
  const pending = service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'req',
    name: 'work/run', data: { value: 1 },
  })
  await Promise.resolve()
  service.cancelRequest(client, { source: 'example.work', requestId: 'req' })
  await pending
  resolve({ late: true })
  await Promise.resolve()
  assert.equal(aborted, true)
  const responses = frames.map(row => row.frame).filter(frame => frame.kind === 'response')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].error.code, 'cancelled')
  client.dispose(); source.dispose(); service.dispose()
})

test('request timeout aborts and a late resolution cannot send a second response', async () => {
  const clock = fakeClock()
  const frames = []
  let resolve
  const work = new Promise(done => { resolve = done })
  const service = new OtoolsSocketService({ clock, requestTimeoutMs: 30_000 })
  const source = service.registerSource({
    id: 'example.work', protocolVersion: 1, exposure: 'paired', catalog: catalog(),
    hello: () => ({}), onRequest: () => work,
  })
  const client = attach(service, frames)
  const pending = service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'req',
    name: 'work/run', data: { value: 1 },
  })
  clock.advance(30_000)
  await pending
  resolve({ late: true })
  await Promise.resolve()
  const responses = frames.map(row => row.frame).filter(frame => frame.kind === 'response')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].error.code, 'timeout')
  client.dispose(); source.dispose(); service.dispose()
})

test('five failures open a per-client/source circuit for thirty seconds', async () => {
  const clock = fakeClock()
  const frames = []
  let calls = 0
  const service = new OtoolsSocketService({ clock })
  const source = service.registerSource({
    id: 'example.work', protocolVersion: 1, exposure: 'paired', catalog: catalog(),
    hello: () => ({}), onRequest: () => { calls += 1; return { ok: true } },
  })
  const client = attach(service, frames)
  for (let index = 0; index < 5; index += 1) {
    await service.dispatchRequest(client, {
      v: 2, kind: 'request', source: 'example.work', requestId: String(index),
      name: 'work/run', data: { value: 0 },
    })
  }
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'blocked',
    name: 'work/run', data: { value: 1 },
  })
  assert.equal(calls, 0)
  assert.equal(frames.at(-1).frame.error.code, 'circuit_open')

  const otherFrames = []
  const other = attach(service, otherFrames, { id: 'client-b' })
  await service.dispatchRequest(other, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'other',
    name: 'work/run', data: { value: 1 },
  })
  assert.equal(calls, 1)
  clock.advance(30_001)
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'open',
    name: 'work/run', data: { value: 1 },
  })
  assert.equal(calls, 2)
  other.dispose(); client.dispose(); source.dispose(); service.dispose()
})

test('drops low priority events with one overflow but never silently drops responses', async () => {
  const frames = []
  let acceptLow = false
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.work', protocolVersion: 1, exposure: 'paired', catalog: catalog(),
    hello: () => ({}), onRequest: () => ({ done: true }),
  })
  const client = attach(service, frames, {
    send(frame, priority) {
      if (priority === 'low' && !acceptLow) return false
      frames.push({ frame, priority })
      return true
    },
  })
  await service.subscribe(client, 'example.work')
  frames.length = 0
  source.emit('progress', { value: 1 }, 'low')
  source.emit('progress', { value: 2 }, 'low')
  assert.deepEqual(frames.map(row => row.frame.kind), ['overflow'])
  acceptLow = true
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.work', requestId: 'req',
    name: 'work/run', data: { value: 1 },
  })
  assert.equal(frames.at(-1).frame.kind, 'response')
  assert.equal(frames.at(-1).frame.ok, true)
  client.dispose(); source.dispose(); service.dispose()
})
