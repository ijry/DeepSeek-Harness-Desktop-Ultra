/**
 * The published browser artifact is `lib/client.js`, not `src/client/index.js`:
 * the build wraps the source in the DSH module loader, and the web shell only
 * ever executes that wrapper. This test asserts the loader contract itself —
 * that executing the bundle registers exactly one factory, that the factory is
 * lazy (nothing happens until it runs), and that it hands back a cordis plugin.
 *
 * It is the one check that would catch a wrap step that silently produced a file
 * the shell cannot load, which no amount of syntax checking would.
 *
 * @module dsh-plugin-repopanel/test/client-bundle
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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
  assert.equal(registered[0].id, 'dsh-plugin-repopanel', 'id 必须与包名和 cordis.patch.yml 的行名一致')
  assert.equal(typeof registered[0].factory, 'function')
})

test('工厂是惰性的：脚本执行阶段不碰 document，也不注入样式', async () => {
  // 这正是 loader 模型的要求：执行脚本只登记工厂，一切副作用（包括注入 CSS）
  // 都要留到工厂被调用时。sandbox 里根本没有 document，所以脚本阶段一旦访问它
  // 就会抛，这个测试就红。
  const { registered } = await loadBundle()
  assert.equal(registered.length, 1)
})

test('工厂返回的是一个 cordis 插件（name / inject / apply），且不 require 任何东西', async () => {
  const { registered } = await loadBundle()
  const require = (name) => {
    throw new Error(`browser bundle must not require anything, asked for ${name}`)
  }
  const plugin = registered[0].factory(require)
  assert.equal(plugin.name, 'dsh-plugin-repopanel/client')
  // Array.isArray + length rather than deepEqual: the bundle runs in its own vm
  // realm, so its arrays have a different prototype and deepStrictEqual fails on
  // identity alone.
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
