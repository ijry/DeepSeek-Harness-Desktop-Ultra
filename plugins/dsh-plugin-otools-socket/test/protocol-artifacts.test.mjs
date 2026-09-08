import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUS_VERSION,
  CATALOG_MAX_BYTES,
  CATALOG_CHUNK_MAX_BYTES,
  CLIENT_BACKLOG_MAX_BYTES,
  CONTROL_FRAME_MAX_BYTES,
  ERROR_CODES,
  REQUEST_TIMEOUT_MS,
  UI_VERSION,
  createCatalogAssembler,
  decodeControlFrame,
  encodeCatalogFrames,
  encodeControlFrame,
} from '../src/shared/protocol.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifacts = join(root, 'src', 'shared', 'protocol-artifacts')

async function loadCases(kind) {
  const dir = join(artifacts, 'golden', kind)
  const files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
  const rows = []
  for (const file of files) {
    rows.push(...JSON.parse(await readFile(join(dir, file), 'utf8')))
  }
  return rows
}

test('protocol constants are frozen', () => {
  assert.equal(BUS_VERSION, 2)
  assert.equal(UI_VERSION, 1)
  assert.equal(CONTROL_FRAME_MAX_BYTES, 262144)
  assert.equal(CATALOG_MAX_BYTES, 524288)
  assert.equal(CATALOG_CHUNK_MAX_BYTES, 98304)
  assert.equal(CLIENT_BACKLOG_MAX_BYTES, 1048576)
  assert.equal(REQUEST_TIMEOUT_MS, 30000)
  assert.deepEqual(ERROR_CODES, [
    'bad_frame', 'bad_version', 'frame_too_large', 'source_unavailable',
    'not_found', 'forbidden', 'unauthorized', 'rate_limited', 'timeout',
    'cancelled', 'circuit_open', 'ticket_unavailable', 'invalid_input',
    'conflict', 'internal',
  ])
})

test('every valid golden frame round-trips byte-for-byte as data', async () => {
  const cases = await loadCases('valid')
  assert.ok(cases.length >= 10)
  for (const row of cases) {
    const encoded = encodeControlFrame(row.frame)
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= CONTROL_FRAME_MAX_BYTES, row.name)
    assert.deepEqual(decodeControlFrame(encoded), row.frame, row.name)
  }
})

test('every invalid golden frame fails with its pinned stable code', async () => {
  const cases = await loadCases('invalid')
  assert.ok(cases.length >= 12)
  for (const row of cases) {
    assert.throws(
      () => decodeControlFrame(JSON.stringify(row.frame)),
      error => error?.code === row.code,
      row.name,
    )
  }
})

test('complete UTF-8 envelope is bounded, not only the data field', () => {
  const base = {
    v: 2,
    kind: 'event',
    source: 'example.notes',
    name: 'notes/changed',
  }
  let low = 0
  let high = CONTROL_FRAME_MAX_BYTES
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    const frame = { ...base, data: { text: 'x'.repeat(middle) } }
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (bytes <= CONTROL_FRAME_MAX_BYTES) low = middle
    else high = middle
  }
  const atLimit = { ...base, data: { text: 'x'.repeat(low) } }
  assert.ok(Buffer.byteLength(encodeControlFrame(atLimit), 'utf8') <= CONTROL_FRAME_MAX_BYTES)
  assert.throws(
    () => encodeControlFrame({ ...base, data: { text: 'x'.repeat(high) } }),
    error => error?.code === 'frame_too_large',
  )
})

test('catalog chunks stay below the wire cap and replace atomically', () => {
  const catalog = {
    revision: 7,
    sources: [{
      id: 'example.notes',
      protocolVersion: 1,
      catalog: { title: 'Large notes', commands: [], pages: [{
        id: 'large', title: '例'.repeat(100000), layout: {},
      }] },
    }],
  }
  const frames = encodeCatalogFrames(catalog)
  assert.ok(frames.length > 1)
  assert.ok(frames.length <= 6)
  const assembler = createCatalogAssembler({ now: () => 0 })
  for (const frame of frames.slice(0, -1)) {
    assert.ok(Buffer.byteLength(encodeControlFrame(frame), 'utf8') <= CONTROL_FRAME_MAX_BYTES)
    assert.equal(assembler.accept(frame), null)
  }
  assert.deepEqual(assembler.accept(frames.at(-1)), catalog)
})

test('catalog assembly rejects duplicates, order gaps and expiry', () => {
  const catalog = {
    revision: 8,
    sources: [{ id: 'example.large', protocolVersion: 1, catalog: {
      title: 'Large catalog', commands: [], pages: [{
        id: 'large', title: 'x'.repeat(150000), layout: {},
      }],
    } }],
  }
  const frames = encodeCatalogFrames(catalog)
  assert.ok(frames.length > 1)

  const duplicate = createCatalogAssembler({ now: () => 0 })
  assert.equal(duplicate.accept(frames[0]), null)
  assert.throws(() => duplicate.accept(frames[0]), error => error?.code === 'bad_frame')

  const gap = createCatalogAssembler({ now: () => 0 })
  assert.throws(() => gap.accept(frames[1]), error => error?.code === 'bad_frame')

  let now = 0
  const expired = createCatalogAssembler({ now: () => now })
  assert.equal(expired.accept(frames[0]), null)
  now = 30001
  assert.throws(() => expired.accept(frames[1]), error => error?.code === 'bad_frame')
})

test('disconnect reset drops incomplete catalog assembly', () => {
  const catalog = {
    revision: 9,
    sources: [{ id: 'example.reset', protocolVersion: 1, catalog: {
      title: 'Reset catalog', commands: [], pages: [{
        id: 'large', title: 'x'.repeat(150000), layout: {},
      }],
    } }],
  }
  const frames = encodeCatalogFrames(catalog)
  const assembler = createCatalogAssembler({ now: () => 0 })
  assert.equal(assembler.accept(frames[0]), null)
  assembler.reset()
  assert.throws(() => assembler.accept(frames[1]), error => error?.code === 'bad_frame')
})
