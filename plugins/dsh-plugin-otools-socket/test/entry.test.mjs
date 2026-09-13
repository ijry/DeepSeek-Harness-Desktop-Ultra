import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../src/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('runtime modules only import files shipped inside the plugin package', async () => {
  const source = await readFile(join(root, 'src', 'host', 'carriers', 'websocket.js'), 'utf8')
  assert.ok(source.includes("from '../socket.js'"))
  assert.ok(!source.includes('.shared/'), 'plugins/.shared is a repository-only source directory')
})

class FakeContext {
  constructor() {
    this.provided = []
    this.injectors = []
  }
  provide(name, value) {
    this.provided.push({ name, value })
    return () => this.provided.push({ disposed: name })
  }
  inject(names, callback) {
    this.injectors.push({ names, callback })
    return () => {}
  }
}

test('provides exactly one otoolsSocket service and starts no LAN listener by default', async () => {
  const ctx = new FakeContext()
  const dispose = apply(ctx, { externalEnabled: false, file: ':memory:' }, {
    createStore: () => ({ load: async () => {}, snapshot: () => ({ devices: [] }), transact: async fn => fn({ devices: [] }) }),
    startListener: async () => { throw new Error('must not listen') },
  })
  assert.deepEqual(ctx.provided.map(row => row.name), ['otoolsSocket'])
  assert.deepEqual(ctx.injectors.map(row => row.names), [['webServer']])
  assert.equal(typeof dispose, 'function')
  await dispose()
})

test('registers internal socket only after webServer injection and disposes in reverse order', async () => {
  const events = []
  const ctx = new FakeContext()
  const dispose = apply(ctx, { externalEnabled: false, file: ':memory:' }, {
    createStore: () => ({ load: async () => {}, snapshot: () => ({ devices: [] }), transact: async fn => fn({ devices: [] }) }),
    createInternalCarrier: () => ({ dispose: () => events.push('internal') }),
  })
  assert.deepEqual(events, [])
  const injected = ctx.injectors[0]
  const cleanup = injected.callback({ webServer: {} })
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.deepEqual(events, ['internal'])
  await dispose()
})

test('closes an external listener even when disposal wins its startup race', async () => {
  const events = []
  const ctx = new FakeContext()
  let resolveListener
  const listenerReady = new Promise(resolve => { resolveListener = resolve })
  const dispose = apply(ctx, { externalEnabled: true, file: ':memory:' }, {
    createStore: () => ({ load: async () => {}, snapshot: () => ({ devices: [] }), transact: async fn => fn({ devices: [] }) }),
    startListener: () => listenerReady,
  })
  const disposing = dispose()
  resolveListener({ close: () => events.push('listener') })
  await disposing
  assert.deepEqual(events, ['listener'])
  assert.deepEqual(ctx.provided.map(row => row.name ?? ('disposed:' + row.disposed)), [
    'otoolsSocket',
    'disposed:otoolsSocket',
  ])
})
