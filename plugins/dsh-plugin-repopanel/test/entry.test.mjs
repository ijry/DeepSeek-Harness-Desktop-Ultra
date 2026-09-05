/**
 * The plugin entry's cordis wiring. Everything else is tested directly, but a
 * mistake in `apply` — a service name typo, a nested inject that never fires, a
 * disposer that does not unwind — registers nothing and throws nothing. The
 * panel would simply not exist, and the only symptom would be a 404.
 *
 * The stub context mirrors cordis's contract as the sibling plugin uses it:
 * `inject(names, cb)` runs the callback with a scoped context and treats the
 * return value as that scope's disposer.
 *
 * @module dsh-plugin-repopanel/test/entry
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../src/index.js'
import { ROUTE_PREFIX, SSE_PATH } from '../src/host/routes.js'

/**
 * A cordis-shaped context that only offers the services in `available`, so a
 * test can withhold one and watch the plugin degrade instead of crash.
 */
function stubContext(available) {
  const registered = []
  const sections = []
  const disposers = []

  const make = (extra) => {
    const ctx = { ...extra }
    ctx.inject = (names, callback) => {
      if (!names.every((service) => service in available)) return
      const scoped = make(Object.fromEntries(names.map((service) => [service, available[service]])))
      const dispose = callback(scoped)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    return ctx
  }

  available.webServer = {
    register: (route) => {
      registered.push(route)
      return () => registered.splice(registered.indexOf(route), 1)
    },
  }
  if (available.systemPrompt !== undefined) {
    available.systemPrompt = {
      section: (spec) => {
        sections.push(spec)
        return () => sections.splice(sections.indexOf(spec), 1)
      },
    }
  }
  return { ctx: make({}), registered, sections, disposers }
}

const workspaceRegistry = { list: () => [], get: () => undefined }

test('导出的是命名空间插件的形状：name / inject / apply，没有 default', async () => {
  assert.equal(name, 'dsh-plugin-repopanel')
  assert.deepEqual(inject, [], '顶层不该要求任何服务 —— 提示段是可选的，其余等 workspaceRegistry')
  assert.equal(typeof apply, 'function')
  const module = await import('../src/index.js')
  assert.equal(module.default, undefined, 'dsh 的插件是命名空间导出，不是 default')
})

test('服务齐全时挂上两条路由（JSON 前缀 + 精确 SSE）和一段系统提示', () => {
  const { ctx, registered, sections } = stubContext({ workspaceRegistry, systemPrompt: {} })
  apply(ctx)

  assert.deepEqual(
    registered.map((route) => [route.kind, route.path]).sort(),
    [['exact', SSE_PATH], ['prefix', ROUTE_PREFIX]].sort(),
  )
  for (const route of registered) assert.equal(typeof route.handler, 'function')

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-plugin-repopanel')
  assert.ok(sections[0].order >= 100 && sections[0].order < 200, '提示段属于工具指引那一段（100–199）')
  assert.match(sections[0].text, /UNTRUSTED DATA/, '这一段存在的唯一理由就是这条纪律')
})

test('没有 systemPrompt 服务时照样挂路由 —— 面板不该因为少一段提示就不存在', () => {
  const { ctx, registered, sections } = stubContext({ workspaceRegistry })
  apply(ctx)
  assert.equal(registered.length, 2)
  assert.equal(sections.length, 0)
})

test('没有 workspaceRegistry 时不挂任何路由，也不抛', () => {
  // 仓库是从工作区路径推导出来的，没有注册表就没有仓库可谈。安静地不挂，
  // 而不是挂一组必然 500 的路由。
  const { ctx, registered } = stubContext({ systemPrompt: {} })
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(registered.length, 0)
})

test('卸载时把路由和提示段都收回去', () => {
  const { ctx, registered, sections, disposers } = stubContext({ workspaceRegistry, systemPrompt: {} })
  apply(ctx)
  assert.equal(registered.length, 2)
  for (const dispose of disposers) dispose()
  assert.equal(registered.length, 0, '插件卸载后路由必须消失，否则重载会撞上 duplicate')
  assert.equal(sections.length, 0)
})
