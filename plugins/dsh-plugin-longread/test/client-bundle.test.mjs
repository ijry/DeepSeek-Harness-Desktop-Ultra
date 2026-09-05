/**
 * 发布出去的浏览器产物是 lib/client.js，不是 src/client/index.js：构建把源码包进
 * dsh 的模块加载器，而 web 外壳只会执行那个包装体。这个测试盯住加载器契约本身 ——
 * 执行一次只登记一个工厂、工厂是惰性的、返回的是一个 cordis 插件。
 *
 * 它是唯一能抓出「包装步骤悄悄产出了外壳装不进去的文件」的检查，语法检查抓不到。
 *
 * @module dsh-plugin-longread/test/client-bundle
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
  assert.equal(registered[0].id, 'dsh-plugin-longread', 'id 必须与包名和 cordis.patch.yml 的行名一致')
  assert.equal(typeof registered[0].factory, 'function')
})

test('工厂是惰性的：脚本执行阶段不碰 document，也不注入样式', async () => {
  // 这正是 loader 模型的要求：执行脚本只登记工厂，一切副作用（包括注入 CSS）都要
  // 留到工厂被调用时。sandbox 里根本没有 document，脚本阶段一旦访问它就会抛。
  const { registered } = await loadBundle()
  assert.equal(registered.length, 1)
})

test('工厂返回的是一个 cordis 插件（name / inject / apply），且不 require 任何东西', async () => {
  const { registered } = await loadBundle()
  const require = (name) => {
    throw new Error(`browser bundle must not require anything, asked for ${name}`)
  }
  const plugin = registered[0].factory(require)
  assert.equal(plugin.name, 'dsh-plugin-longread/client')
  // Array.isArray + length 而不是 deepEqual：bundle 跑在自己的 vm realm 里，数组的
  // 原型不同，deepStrictEqual 会仅因身份不同而失败。
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

test('产物里不残留 import / export —— 浏览器按 classic script 解析它', async () => {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const leftover = source.split('\n').filter((line) => /^\s*(import\s*[{('"*]|export\s)/.test(line))
  assert.deepEqual(leftover, [])
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'lib/client.js' }))
})
