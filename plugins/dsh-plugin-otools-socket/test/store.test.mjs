import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DeviceStore, SCHEMA_VERSION } from '../src/host/store.js'

const record = overrides => ({
  deviceId: 'device-a', name: 'Phone',
  tokenHash: 'a'.repeat(64), refreshHash: 'b'.repeat(64),
  accessExpiresAt: 86_401_000, refreshExpiresAt: 7_776_001_000,
  createdAt: 1000, lastSeenAt: 1000, revokedAt: null,
  ...overrides,
})

async function tempFile(name = 'dsh-plugin-otools-socket.json') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-socket-store-'))
  return { dir, file: join(dir, name) }
}

test('persists hashed device state atomically and reloads it', async () => {
  const { dir, file } = await tempFile()
  const store = new DeviceStore({ file, now: () => 1000 })
  await store.transact(draft => {
    draft.devices.push(record())
    return 'paired'
  })
  const content = await readFile(file, 'utf8')
  assert.equal(content.includes('dshs_'), false)
  assert.equal(JSON.parse(content).schemaVersion, SCHEMA_VERSION)
  const leftovers = (await readdir(dir)).filter(name => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])

  const loaded = new DeviceStore({ file, now: () => 2000 })
  await loaded.load()
  assert.deepEqual(loaded.snapshot().devices, [record()])
})

test('failed persistence does not mutate in-memory durable state', async () => {
  const { file } = await tempFile()
  const fsImpl = {
    mkdir: async () => {},
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error },
    writeFile: async () => { throw new Error('disk full') },
    rename: async () => {},
  }
  const store = new DeviceStore({ file, fs: fsImpl, now: () => 1000 })
  await store.load()
  await assert.rejects(store.transact(draft => {
    draft.devices.push(record())
    return true
  }), /disk full/)
  assert.deepEqual(store.snapshot().devices, [])
})

test('serializes concurrent transactions without losing rows', async () => {
  const { file } = await tempFile()
  const store = new DeviceStore({ file, now: () => 1000 })
  await Promise.all([
    store.transact(draft => { draft.devices.push(record({ deviceId: 'a' })); return 'a' }),
    store.transact(draft => { draft.devices.push(record({ deviceId: 'b' })); return 'b' }),
  ])
  assert.deepEqual(store.snapshot().devices.map(row => row.deviceId), ['a', 'b'])
})

test('quarantines corrupt ledger and starts fresh', async () => {
  const { dir, file } = await tempFile()
  await writeFile(file, '{bad json', 'utf8')
  const store = new DeviceStore({ file, now: () => 42 })
  await store.load()
  assert.deepEqual(store.snapshot().devices, [])
  const names = await readdir(dir)
  assert.equal(names.some(name => name.startsWith('dsh-plugin-otools-socket.json.corrupt-42')), true)
})

test('sanitizes malformed and expired rows while retaining valid hashes', async () => {
  const { file } = await tempFile()
  await writeFile(file, JSON.stringify({
    schemaVersion: 999,
    targetId: 'target-a',
    displayName: 'Host',
    devices: [record(), { secret: 'plaintext' }, record({ deviceId: 'expired', refreshExpiresAt: 999 })],
  }), 'utf8')
  const store = new DeviceStore({ file, now: () => 1000 })
  await store.load()
  assert.deepEqual(store.snapshot().devices.map(row => row.deviceId), ['device-a'])
})

test('never reads the legacy mobile-bridge ledger', async () => {
  const { dir, file } = await tempFile()
  await writeFile(join(dir, 'dsh-plugin-mobile-bridge.json'), JSON.stringify({ devices: [record()] }), 'utf8')
  const store = new DeviceStore({ file, now: () => 1000 })
  await store.load()
  assert.deepEqual(store.snapshot().devices, [])
  await assert.rejects(access(file))
})
