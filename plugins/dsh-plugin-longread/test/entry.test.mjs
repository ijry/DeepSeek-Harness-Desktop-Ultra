/**
 * 宿主入口的接线。这个插件对 agent 的承诺是「什么都不做」：不注册工具、不加系统
 * 提示段落。所以这里的 ctx 替身在 `tools` / `systemPrompt` 上装了地雷 —— 一旦有人
 * 顺手加了个工具，这个测试就红。
 *
 * @module dsh-plugin-longread/test/entry
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../src/index.js'
import { ROUTE_PREFIX } from '../src/host/routes.js'

/** A context that records injects and explodes on any agent-facing service. */
function stubContext(available) {
  const asked = []
  const disposers = []
  const services = available ?? {}
  const ctx = {
    asked,
    disposers,
    inject(names, callback) {
      asked.push([...names])
      if (!names.every((name) => name in services)) return undefined
      // Object.create, not a spread: spreading would READ every getter, and the
      // two mines below are getters.
      const child = Object.create(ctx)
      for (const [key, value] of Object.entries(services)) child[key] = value
      const dispose = callback(child)
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get tools() { throw new Error('longread must not touch ctx.tools') },
    get systemPrompt() { throw new Error('longread must not touch ctx.systemPrompt') },
  }
  return ctx
}

function webServerStub(registered) {
  return {
    register(route) {
      registered.push(route)
      return () => registered.splice(registered.indexOf(route), 1)
    },
  }
}

test('导出的是命名空间插件：name / inject / apply，没有 default', () => {
  assert.equal(plugin.name, 'dsh-plugin-longread')
  assert.deepEqual(plugin.inject, [])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal('default' in plugin, false)
  assert.equal(plugin.LEDGER_FILE, 'dsh-plugin-longread.json')
  assert.equal(plugin.TEXT_DIR, 'dsh-plugin-longread-books')
})

test('挂上 webServer 就注册前缀路由，且不碰工具与系统提示', () => {
  const registered = []
  const ctx = stubContext({
    webServer: webServerStub(registered),
    workspaceRegistry: { list: () => [] },
  })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, ROUTE_PREFIX)
  assert.equal(typeof registered[0].handler, 'function')
  assert.deepEqual(ctx.asked, [['workspaceRegistry'], ['webServer']])
})

test('没有 workspaceRegistry 也照样起来 —— 伪装退化成内置路径表而不是坏掉', () => {
  const registered = []
  const ctx = stubContext({ webServer: webServerStub(registered) })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(registered.length, 1, '面板的 API 不该依赖工作区注册表')
})

test('没有 webServer 时什么都不注册，也不抛', () => {
  const ctx = stubContext({ workspaceRegistry: { list: () => [] } })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.deepEqual(ctx.asked, [['workspaceRegistry'], ['webServer']])
})

test('disposer 把路由注销干净', () => {
  const registered = []
  const ctx = stubContext({ webServer: webServerStub(registered), workspaceRegistry: { list: () => [] } })
  plugin.apply(ctx)
  assert.equal(registered.length, 1)
  for (const dispose of ctx.disposers.splice(0)) dispose()
  assert.equal(registered.length, 0)
})
