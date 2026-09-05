/**
 * The plugin entry's cordis wiring. Everything else is tested directly, but a
 * mistake in `apply` — a service name typo, a nested inject that never fires, a
 * disposer that does not unwind — registers nothing and throws nothing. The panel
 * would simply not exist, and the only symptom would be a 404.
 *
 * The stub context mirrors cordis's contract as the sibling plugins use it:
 * `inject(names, cb)` runs the callback with a scoped context and treats the return
 * value as that scope's disposer.
 *
 * @module dsh-plugin-automation/test/entry
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LEDGER_FILE, apply, inject, name } from '../src/index.js'
import { ROUTE_PREFIX, SSE_PATH } from '../src/host/routes.js'

/**
 * A cordis-shaped context that only offers the services in `available`, so a test
 * can withhold one and watch the plugin degrade instead of crash.
 */
function stubContext(available) {
  const registered = []
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

  if (available.webServer !== undefined) {
    available.webServer = {
      port: 41234,
      host: '127.0.0.1',
      register: (route) => {
        registered.push(route)
        return () => registered.splice(registered.indexOf(route), 1)
      },
    }
  }
  return { ctx: make({}), registered, disposers }
}

const workspaceRegistry = { list: () => [], get: () => undefined }

/** Every run of this test writes into its own DSH home. */
async function isolateHome() {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-auto-home-'))
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('导出的是命名空间插件的形状：name / inject / apply，没有 default', async () => {
  assert.equal(name, 'dsh-plugin-automation')
  assert.deepEqual(inject, [], '顶层不该要求任何服务 —— 调度器等 workspaceRegistry，路由再等 webServer')
  assert.equal(typeof apply, 'function')
  assert.equal(LEDGER_FILE, 'dsh-plugin-automation.json')
  const module = await import('../src/index.js')
  assert.equal(module.default, undefined, '不要 default 导出：dsh 的加载器按命名空间插件读取')
})

test('两个服务都在时注册 JSON 前缀与 SSE 精确路由', async () => {
  const restore = await isolateHome()
  try {
    const { ctx, registered, disposers } = stubContext({ workspaceRegistry, webServer: {} })
    apply(ctx)
    assert.deepEqual(registered.map((route) => route.kind + ' ' + route.path).sort(),
      ['exact ' + SSE_PATH, 'prefix ' + ROUTE_PREFIX].sort())
    for (const route of registered) assert.equal(typeof route.handler, 'function')
    // Unwinding must actually remove them, or a reload would double-register and
    // the webserver rejects a duplicate (kind, path).
    for (const dispose of [...disposers].reverse()) dispose()
    assert.deepEqual(registered, [])
  } finally {
    restore()
  }
})

test('没有 webServer 时不注册路由，也不抛 —— 调度器照样起来', async () => {
  const restore = await isolateHome()
  try {
    const { ctx, registered } = stubContext({ workspaceRegistry })
    assert.doesNotThrow(() => apply(ctx))
    assert.deepEqual(registered, [])
  } finally {
    restore()
  }
})

test('没有 workspaceRegistry 时整个插件安静地不工作', async () => {
  const restore = await isolateHome()
  try {
    const { ctx, registered } = stubContext({ webServer: {} })
    assert.doesNotThrow(() => apply(ctx))
    assert.deepEqual(registered, [], '项目注册表是解析运行目录的前提，没有它就不该开始调度')
  } finally {
    restore()
  }
})
