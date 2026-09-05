/**
 * The cordis entry point, against a fake context.
 *
 * What this pins down is the wiring, which is the part that fails at DSH boot
 * rather than in a route: the export shape, that nothing is required at the top
 * level (a missing service must not stop the plugin from coming up), that the
 * routes only mount once BOTH the workspace registry and the webServer exist, and
 * that tearing down either one unregisters the routes.
 *
 * @module dsh-plugin-otools-git/test/entry
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as plugin from '../src/index.js'

/**
 * A cordis-shaped context. `inject(names, cb)` calls `cb` with a child context
 * once every named service is present, and keeps `cb`'s return value as the
 * disposer — the same contract the real one has.
 */
function fakeContext(services) {
  const disposers = []
  const ctx = {
    ...services,
    inject(names, callback) {
      const missing = names.filter((name) => services[name] === undefined)
      if (missing.length > 0) return () => undefined
      const child = fakeContext(services)
      const dispose = callback(child.ctx)
      disposers.push(...child.disposers)
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, disposers }
}

/** A webServer that records what got registered. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

describe('plugin entry', () => {
  let home

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-og-home-'))
    process.env.DSH_HOME = home
  })

  after(async () => {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  })

  it('exports the namespace-plugin shape with no default export', () => {
    assert.equal(plugin.name, 'dsh-plugin-otools-git')
    assert.deepEqual(plugin.inject, [], 'top-level inject must stay empty or the web shell fails boot')
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.default, undefined, 'a default export would double-register the plugin')
  })

  it('mounts the routes when the workspace registry and webServer are both present', () => {
    const webServer = fakeWebServer()
    const { ctx } = fakeContext({
      workspaceRegistry: { list: () => [], get: () => undefined },
      webServer,
    })
    plugin.apply(ctx)
    const paths = webServer.routes.map((route) => route.kind + ' ' + route.path)
    assert.deepEqual(paths, [
      'prefix /dsh-plugin-otools-git',
      'exact /dsh-plugin-otools-git/events',
    ])
  })

  it('comes up with no model services, and with them', () => {
    for (const extra of [{}, { llm: { stream: () => undefined }, agentDefaultModel: { currentSelection: () => ({}) } }]) {
      const webServer = fakeWebServer()
      const { ctx } = fakeContext({
        workspaceRegistry: { list: () => [], get: () => undefined },
        webServer,
        ...extra,
      })
      assert.doesNotThrow(() => plugin.apply(ctx))
      assert.equal(webServer.routes.length, 2)
    }
  })

  it('mounts nothing at all without a webServer, and does not throw', () => {
    const { ctx } = fakeContext({ workspaceRegistry: { list: () => [], get: () => undefined } })
    assert.doesNotThrow(() => plugin.apply(ctx))
  })

  it('mounts nothing without a workspace registry — a repository must come from DSH', () => {
    const webServer = fakeWebServer()
    const { ctx } = fakeContext({ webServer })
    assert.doesNotThrow(() => plugin.apply(ctx))
    assert.equal(webServer.routes.length, 0)
  })

  it('unregisters its routes when disposed', () => {
    const webServer = fakeWebServer()
    const { ctx, disposers } = fakeContext({
      workspaceRegistry: { list: () => [], get: () => undefined },
      webServer,
    })
    plugin.apply(ctx)
    assert.equal(webServer.routes.length, 2)
    for (const dispose of disposers) dispose()
    assert.equal(webServer.routes.length, 0, 'routes leaked after dispose')
  })

  it('keeps its state under the DSH home', async () => {
    const { readdir } = await import('node:fs/promises')
    const webServer = fakeWebServer()
    const { ctx } = fakeContext({
      workspaceRegistry: { list: () => [], get: () => undefined },
      webServer,
    })
    plugin.apply(ctx)
    // The eager prefs load is fire-and-forget; give it a tick.
    await new Promise((r) => setTimeout(r, 50))
    // Nothing is written until a preference changes, so the directory may be
    // empty — what matters is that no file landed anywhere else.
    const entries = await readdir(home).catch(() => [])
    for (const entry of entries) {
      assert.match(entry, /^dsh-plugin-otools-git/, 'unexpected file in the DSH home: ' + entry)
    }
  })
})
