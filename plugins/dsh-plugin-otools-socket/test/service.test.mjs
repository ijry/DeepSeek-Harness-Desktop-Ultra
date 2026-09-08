import assert from 'node:assert/strict'
import test from 'node:test'

import { OtoolsSocketService } from '../src/host/service.js'

const command = (name = 'state/read') => ({
  name,
  effect: 'read',
  confirmation: 'none',
  input: { type: 'object', properties: {}, additionalProperties: false },
})
const catalog = title => ({ title, commands: [command()] })

function clientOptions(frames, extra = {}) {
  return {
    id: extra.id ?? 'client-a',
    transport: extra.transport ?? 'paired',
    deviceId: extra.deviceId ?? 'phone-a',
    send(frame, priority) {
      frames.push({ frame, priority })
      return true
    },
    ...extra,
  }
}

test('registers sources, filters paired catalog, updates revision and disposes idempotently', () => {
  const service = new OtoolsSocketService()
  const internal = service.registerSource({
    id: 'example.internal', protocolVersion: 1, catalog: catalog('Internal'),
    hello: () => ({}), onRequest: () => ({}),
  })
  const paired = service.registerSource({
    id: 'example.paired', protocolVersion: 1, exposure: 'paired', catalog: catalog('Paired'),
    hello: () => ({}), onRequest: () => ({}),
  })
  assert.deepEqual(service.catalogFor('paired').sources.map(row => row.id), ['example.paired'])
  assert.deepEqual(service.catalogFor('internal').sources.map(row => row.id), [
    'example.internal', 'example.paired',
  ])
  const before = service.catalogFor('paired').revision
  paired.updateCatalog(catalog('Renamed'))
  assert.equal(service.catalogFor('paired').revision, before + 1)
  assert.equal(service.catalogFor('paired').sources[0].catalog.title, 'Renamed')
  paired.dispose()
  paired.dispose()
  assert.deepEqual(service.catalogFor('paired').sources, [])
  internal.dispose()
  service.dispose()
})

test('rejects duplicate source IDs and a disposed generation cannot publish through replacement', () => {
  const service = new OtoolsSocketService()
  const first = service.registerSource({
    id: 'example.source', protocolVersion: 1, catalog: catalog('One'),
    hello: () => ({}), onRequest: () => ({}),
  })
  assert.throws(() => service.registerSource({
    id: 'example.source', protocolVersion: 1, catalog: catalog('Two'),
    hello: () => ({}), onRequest: () => ({}),
  }), error => error?.code === 'conflict')
  first.dispose()
  const second = service.registerSource({
    id: 'example.source', protocolVersion: 1, catalog: catalog('Two'),
    hello: () => ({}), onRequest: () => ({}),
  })
  assert.throws(() => first.emit('changed', {}), error => error?.code === 'source_unavailable')
  second.dispose()
  service.dispose()
})

test('subscription sends snapshot before queued live events', async () => {
  const frames = []
  let resolveSnapshot
  const snapshot = new Promise(resolve => { resolveSnapshot = resolve })
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.source', protocolVersion: 1, exposure: 'paired', catalog: catalog('Example'),
    hello: () => snapshot, onRequest: () => ({}),
  })
  const client = service.attachClient(clientOptions(frames))
  const subscribed = service.subscribe(client, 'example.source')
  source.emit('changed', { revision: 2 })
  resolveSnapshot({ revision: 1 })
  await subscribed
  assert.deepEqual(frames.map(row => [row.frame.name, row.frame.data]), [
    ['$snapshot', { revision: 1 }],
    ['changed', { revision: 2 }],
  ])
  client.dispose()
  source.dispose()
  service.dispose()
})

test('paired clients cannot subscribe to internal sources', async () => {
  const frames = []
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.internal', protocolVersion: 1, catalog: catalog('Internal'),
    hello: () => ({}), onRequest: () => ({}),
  })
  const client = service.attachClient(clientOptions(frames))
  await assert.rejects(service.subscribe(client, 'example.internal'), error => error?.code === 'forbidden')
  assert.deepEqual(frames, [])
  client.dispose()
  source.dispose()
  service.dispose()
})

test('snapshot queue overflow emits once and retries the baseline', async () => {
  const frames = []
  const resolvers = []
  let helloCalls = 0
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.source', protocolVersion: 1, exposure: 'paired', catalog: catalog('Example'),
    hello: () => new Promise(resolve => {
      helloCalls += 1
      resolvers.push(resolve)
    }),
    onRequest: () => ({}),
  })
  const client = service.attachClient(clientOptions(frames))
  const subscribed = service.subscribe(client, 'example.source')
  source.emit('changed', { text: 'x'.repeat(263000) })
  assert.deepEqual(frames.map(row => row.frame.kind), ['overflow'])
  resolvers[0]({ revision: 1 })
  await Promise.resolve()
  assert.equal(helloCalls, 2)
  resolvers[1]({ revision: 2 })
  await subscribed
  assert.deepEqual(frames.map(row => [row.frame.kind, row.frame.name]), [
    ['overflow', undefined],
    ['event', '$snapshot'],
  ])
  assert.deepEqual(frames.at(-1).frame.data, { revision: 2 })
  client.dispose(); source.dispose(); service.dispose()
})

test('disposing a source aborts its pending requests with source_unavailable', async () => {
  const frames = []
  let aborted = false
  const service = new OtoolsSocketService()
  const source = service.registerSource({
    id: 'example.source', protocolVersion: 1, exposure: 'paired', catalog: catalog('Example'),
    hello: () => ({}),
    onRequest: (_request, context) => new Promise(() => {
      context.signal.addEventListener('abort', () => { aborted = true })
    }),
  })
  const client = service.attachClient(clientOptions(frames))
  const pending = service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.source', requestId: 'pending',
    name: 'state/read', data: {},
  })
  await Promise.resolve()
  source.dispose()
  await pending
  assert.equal(aborted, true)
  assert.equal(frames.at(-1).frame.error.code, 'source_unavailable')
  client.dispose(); service.dispose()
})

test('source errors are redacted and do not prevent the next source response', async () => {
  const frames = []
  const service = new OtoolsSocketService()
  const bad = service.registerSource({
    id: 'example.bad', protocolVersion: 1, exposure: 'paired', catalog: catalog('Bad'),
    hello: () => ({}), onRequest: () => { throw new Error('SECRET C:\\ledger.json') },
  })
  const good = service.registerSource({
    id: 'example.good', protocolVersion: 1, exposure: 'paired', catalog: catalog('Good'),
    hello: () => ({}), onRequest: () => ({ count: 2 }),
  })
  const client = service.attachClient(clientOptions(frames))
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.bad', requestId: '1', name: 'state/read', data: {},
  })
  await service.dispatchRequest(client, {
    v: 2, kind: 'request', source: 'example.good', requestId: '2', name: 'state/read', data: {},
  })
  const responses = frames.map(row => row.frame).filter(frame => frame.kind === 'response')
  assert.equal(responses[0].ok, false)
  assert.equal(responses[0].error.code, 'internal')
  assert.equal(JSON.stringify(responses).includes('SECRET'), false)
  assert.equal(JSON.stringify(responses).includes('ledger'), false)
  assert.deepEqual(responses[1].data, { count: 2 })
  client.dispose(); bad.dispose(); good.dispose(); service.dispose()
})
