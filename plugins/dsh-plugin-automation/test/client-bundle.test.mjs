/**
 * The published browser artifact is `lib/client.js`, not `src/client/index.js`: the
 * build wraps the source in the DSH module loader, and the web shell only ever
 * executes that wrapper. This test asserts the loader contract itself — that
 * executing the bundle registers exactly one factory, that the factory is lazy
 * (nothing happens until it runs), and that it hands back a cordis plugin.
 *
 * It is the one check that would catch a wrap step that silently produced a file
 * the shell cannot load, which no amount of syntax checking would.
 *
 * @module dsh-plugin-automation/test/client-bundle
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { wrapClient } from '../scripts/wrap-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Execute the built bundle against a loader shim and return what it registered. */
async function loadBundle() {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const registered = []
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)
  return { registered, sandbox }
}

test('构建产物注册一个、且只有一个 loader 工厂', async () => {
  const { registered } = await loadBundle()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-plugin-automation', 'id 必须与包名和 cordis.patch.yml 的行名一致')
  assert.equal(typeof registered[0].factory, 'function')
})

test('工厂返回的是一个 cordis 插件（name / inject / apply），且不 require 任何东西', async () => {
  const { registered } = await loadBundle()
  const plugin = registered[0].factory((name) => {
    throw new Error(`browser bundle must not require anything, asked for ${name}`)
  })
  assert.equal(plugin.name, 'dsh-plugin-automation/client')
  // Array.isArray + length rather than deepEqual: the bundle runs in its own vm
  // realm, so its arrays have a different prototype.
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(plugin.inject.length, 0)
  assert.equal(typeof plugin.apply, 'function')
})

test('没有 window / document 时 apply 直接返回，不抛', async () => {
  // 失败策略是「记日志、绝不抛」：一个缺席的 DOM 座位不能让 web GUI 起不来。
  const { registered } = await loadBundle()
  const plugin = registered[0].factory(() => {
    throw new Error('no requires')
  })
  assert.doesNotThrow(() => plugin.apply({}))
})

test('lib/client.js 与 src/client/index.js 保持同步（产物不能忘记提交）', async () => {
  const source = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')
  const built = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  // Line endings are normalized: git's autocrlf rewrites the checkout on Windows,
  // and that is not drift.
  const normalize = (text) => text.replace(/\r\n/g, '\n')
  assert.equal(normalize(built), normalize(wrapClient(source)))
})

test('浏览器包里没有 @deepseek-ai 运行时依赖', async () => {
  const built = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(/require\(\s*['"]@deepseek-ai/.test(built), false)
  assert.equal(/from\s+['"]@deepseek-ai/.test(built), false)
})
