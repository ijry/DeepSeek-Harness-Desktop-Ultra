/**
 * Drift guard between the host's vocabulary and the browser's hand-kept copy.
 *
 * src/client/vocab.js cannot import src/shared/protocol.js — the bundle has no
 * module resolution — so the two are kept in step by hand. This test is what
 * makes "by hand" safe: it reads both sources and fails when a code, a status
 * letter, an enum member or a preference key exists on one side only.
 *
 * @module dsh-plugin-otools-git/test/client-mirror
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ERR, STATUS_LETTERS } from '../src/shared/protocol.js'
import { MERGE_MODES, RESET_MODES } from '../src/host/refs.js'
import { AI_LANGUAGES, AI_STYLES } from '../src/host/ai.js'
import { defaultPrefs } from '../src/host/store.js'
import { CLIENT_PARTS } from '../scripts/wrap-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** One client fragment's source. */
function readPart(name) {
  return readFile(join(root, 'src', 'client', name), 'utf8')
}

/** Every id inside a `[{ id: 'x', ... }]` literal assigned to `name`. */
function idsOf(source, name) {
  const block = source.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\n\\]', 'm'))
  if (block === null) return undefined
  return [...block[1].matchAll(/id: '([^']+)'/g)].map((row) => row[1])
}

describe('client vocabulary mirrors the host', () => {
  it('localizes every error code the host can send', async () => {
    const source = await readPart('vocab.js')
    const handled = new Set([...source.matchAll(/case '([a-z_]+)': return/g)].map((row) => row[1]))
    // Two codes deliberately fall through to the default branch, which returns
    // the message verbatim: `git_error` carries git's own stderr and `internal`
    // carries a stack-level message — in both cases a localized wrapper would
    // hide the only useful part.
    const passthrough = new Set(['internal', 'git_error'])
    const expected = Object.values(ERR).filter((code) => !passthrough.has(code))
    for (const code of expected) {
      assert.ok(handled.has(code), 'client friendlyError is missing a case for ' + code)
    }
    for (const code of handled) {
      assert.ok(Object.values(ERR).includes(code), 'client handles unknown code ' + code)
    }
  })

  it('covers exactly the host status alphabet', async () => {
    const source = await readPart('vocab.js')
    const block = source.match(/const STATUS_TEXT = \{([\s\S]*?)\n\}/m)
    assert.notEqual(block, null, 'STATUS_TEXT not found in vocab.js')
    const letters = new Set([...block[1].matchAll(/^\s*(?:'([^']+)'|([A-Z]))\s*:/gm)]
      .map((row) => row[1] ?? row[2]))
    for (const letter of Object.keys(STATUS_LETTERS)) {
      // The space key is written as `' '`.
      assert.ok(letters.has(letter), 'client STATUS_TEXT is missing ' + JSON.stringify(letter))
    }
    assert.equal(letters.size, Object.keys(STATUS_LETTERS).length)
  })

  it('offers the same reset and merge modes the host accepts', async () => {
    const source = await readPart('vocab.js')
    assert.deepEqual(idsOf(source, 'RESET_MODES'), RESET_MODES)
    assert.deepEqual(idsOf(source, 'MERGE_MODES'), MERGE_MODES)
  })

  it('offers the same AI styles and languages the host accepts', async () => {
    const source = await readPart('vocab.js')
    assert.deepEqual(idsOf(source, 'AI_STYLES'), AI_STYLES)
    assert.deepEqual(idsOf(source, 'AI_LANGUAGES'), AI_LANGUAGES)
  })

  it('only reads and writes preference keys the host declares', async () => {
    const known = new Set(Object.keys(defaultPrefs()))
    const reads = new Set()
    const writes = new Set()
    for (const part of CLIENT_PARTS) {
      const source = await readPart(part)
      for (const row of source.matchAll(/\bpref\('([A-Za-z]+)'\)/g)) reads.add(row[1])
      for (const row of source.matchAll(/savePrefs\(\{\s*([A-Za-z]+)\s*:/g)) writes.add(row[1])
    }
    for (const key of reads) assert.ok(known.has(key), 'client reads unknown preference ' + key)
    for (const key of writes) assert.ok(known.has(key), 'client writes unknown preference ' + key)
    // Sanity: the guard is worthless if the scan found nothing.
    assert.ok(reads.size > 8, 'preference scan found suspiciously few reads')
    assert.ok(writes.size > 8, 'preference scan found suspiciously few writes')
  })

  it('only calls routes the host registers', async () => {
    const [routes, actions] = await Promise.all([
      readFile(join(root, 'src', 'host', 'routes.js'), 'utf8'),
      readFile(join(root, 'src', 'host', 'actions.js'), 'utf8'),
    ])
    const served = new Set()
    for (const row of routes.matchAll(/route === '([^']+)'/g)) served.add(row[1])
    for (const row of routes.matchAll(/route\.startsWith\('([^']+)'\)/g)) served.add(row[1])
    for (const row of actions.matchAll(/route === '([^']+)'/g)) served.add(row[1])

    const called = new Set()
    for (const part of CLIENT_PARTS) {
      const source = await readPart(part)
      for (const row of source.matchAll(/api(?:Get|Post)\('([^']+)'/g)) called.add(row[1])
      for (const row of source.matchAll(/startOperation\('([^']+)'/g)) called.add(row[1])
      for (const row of source.matchAll(/\bact\('([^']+)'/g)) called.add(row[1])
    }
    for (const route of called) {
      const known = served.has(route) || [...served].some((prefix) => route.startsWith(prefix))
      assert.ok(known, 'client calls unserved route ' + route)
    }
    assert.ok(called.size > 25, 'route scan found suspiciously few calls')
  })

  it('lists every client fragment in the build order', async () => {
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(join(root, 'src', 'client'))).filter((name) => name.endsWith('.js')).sort()
    assert.deepEqual([...CLIENT_PARTS].sort(), files,
      'src/client/*.js and CLIENT_PARTS disagree — a fragment would be silently dropped from the bundle')
    // boot.js must stay last: it defines apply() and assigns module.exports.
    assert.equal(CLIENT_PARTS[CLIENT_PARTS.length - 1], 'boot.js')
  })
})
