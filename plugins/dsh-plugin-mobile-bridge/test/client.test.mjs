/**
 * The browser bundle is a single wrapped file with no module resolution, so it
 * restates two constants the host half owns. That duplication is a deliberate
 * trade (see src/client/index.js), and this test is the other half of it: if the
 * route prefix ever moves, the panel stops working silently, and only a check
 * that reads both files catches it.
 *
 * @module dsh-plugin-mobile-bridge/test/client
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ROUTE_PREFIX } from '../lib/shared/protocol.js'
import { PLUGIN_ID, wrapClient } from '../scripts/wrap-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')
const built = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('the panel and the host agree on the route prefix', () => {
  const declared = /var ROUTE_PREFIX = '([^']+)'/.exec(source)
  assert.ok(declared !== null, 'the client must declare ROUTE_PREFIX as a literal')
  assert.equal(declared[1], ROUTE_PREFIX)
})

test('the plugin id matches the package name and the loader row', () => {
  assert.equal(PLUGIN_ID, manifest.name)
  const declared = /var PLUGIN_ID = '([^']+)'/.exec(source)
  assert.equal(declared[1], manifest.name)
  assert.ok(built.includes(`id: '${manifest.name}'`), 'the loader row names the package')
})

test('the built bundle is the wrapped source, byte for byte', () => {
  assert.equal(built, wrapClient(source), 'lib/client.js is stale — run npm run build')
})

test('the bundle loads through the DSH module loader shape', () => {
  assert.ok(built.startsWith('/**'), 'a generated-file banner comes first')
  assert.ok(built.includes('window.__ModuleLoader__.load({'))
  assert.ok(built.includes('factory: (require) => {'))
  assert.ok(built.trimEnd().endsWith('});'))
})

test('the panel exports the client plugin shape and no default', () => {
  assert.ok(source.includes("module.exports = { name: PLUGIN_ID + '/client', inject: [], apply: apply }"))
  assert.ok(!/export default/.test(source), 'cordis function plugins have no default export')
})

test('the manifest declares the client half dsh has to serve', () => {
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.deepEqual(manifest.dsh.client, { inject: [], platform: 'web' })
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})
