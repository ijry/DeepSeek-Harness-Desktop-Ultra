/**
 * Entry test: the cordis shape, and that `apply` wires the routes and takes them back
 * down again.
 *
 * The reason this is its own file: the panel's whole host half hangs off one `apply`,
 * and a wiring mistake there (a service injected at the top level, a disposer that is
 * never returned) does not show up in any route test — the routes would simply never
 * be registered, or would outlive the plugin.
 *
 * @module dsh-plugin-otools-term/test/entry
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { apply, inject, name } from '../src/index.js'

/** A cordis context stub that records what was asked for. */
function makeContext() {
  const record = { injected: [], routes: [], effects: [], disposers: [] }
  const context = {
    inject(services, callback) {
      record.injected.push([...services])
      // Only the services this stub can supply are handed over; the rest simply never
      // fire, which is exactly what a DSH build without them does.
      const supplied = {
        webServer: {
          register(route) {
            record.routes.push(route)
            return () => {
              const index = record.routes.indexOf(route)
              if (index >= 0) record.routes.splice(index, 1)
            }
          },
        },
        workspaceRegistry: { list: () => [], get: () => undefined },
      }
      if (!services.every((service) => Object.hasOwn(supplied, service))) return
      const child = { ...context, ...supplied }
      const disposer = callback(child)
      if (typeof disposer === 'function') record.disposers.push(disposer)
    },
    effect(fn, label) {
      record.effects.push(label)
      const disposer = fn()
      if (typeof disposer === 'function') record.disposers.push(disposer)
    },
  }
  return { context, record }
}

describe('plugin entry', () => {
  let home

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-ot-entry-'))
    // The ledger and the secret files live under the DSH home, so the test moves it.
    process.env.DSH_HOME = home
  })

  after(async () => {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('exports a namespace plugin with no top-level services', () => {
    assert.equal(name, 'dsh-plugin-otools-term')
    // A client entry that fails to activate fails the whole web boot, and the same
    // caution applies here: everything is injected lazily inside apply().
    assert.deepEqual(inject, [])
    assert.equal(typeof apply, 'function')
  })

  it('registers the routes and gives them back on dispose', () => {
    const { context, record } = makeContext()
    apply(context)
    assert.deepEqual(record.injected, [['llm'], ['agentDefaultModel'], ['workspaceRegistry'], ['webServer']])
    // A prefix route for the JSON API and an exact one for the event stream.
    assert.equal(record.routes.length, 2)
    assert.deepEqual(record.routes.map((route) => route.kind).sort(), ['exact', 'prefix'])
    assert.ok(record.routes.every((route) => route.path.startsWith('/dsh-plugin-otools-term')))
    assert.ok(record.effects.some((label) => String(label).includes('engine')))

    for (const disposer of record.disposers) disposer()
    assert.equal(record.routes.length, 0)
  })
})
