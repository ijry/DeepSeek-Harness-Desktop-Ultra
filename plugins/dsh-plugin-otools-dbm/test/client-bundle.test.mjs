/**
 * The built client bundle, run for real.
 *
 * Two things are checked, and both have bitten this repo's other plugins:
 *
 * 1. The bundle must register itself with `window.__ModuleLoader__.load` when
 *    evaluated as a CLASSIC script. `node --check` cannot tell, because
 *    package.json says `type: module`.
 * 2. `apply()` must mount its seats into the shell's DOM, survive a repaint, open
 *    on click, and dispose cleanly — a client that leaves an interval behind keeps
 *    `node --test` from ever finishing.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { installDom } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('client bundle', () => {
  let bundle
  let dom
  let plugin
  let disposeClient
  const fetched = []

  before(async () => {
    bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')

    dom = installDom({
      tokens: { '--dsw-alias-bg-base': '#151517' },
      fetch: (url) => {
        fetched.push(String(url))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, value: { locale: 'en-US' } }),
        })
      },
    })

    const registered = []
    dom.window.__ModuleLoader__ = {
      load(entry) {
        registered.push(entry)
      },
    }

    // The parameter list IS the global surface the bundle may use: anything else it
    // reaches for is a ReferenceError here rather than a mystery in the browser.
    const run = new Function(
      'window',
      'document',
      'console',
      'MutationObserver',
      'CustomEvent',
      'setInterval',
      'clearInterval',
      'URLSearchParams',
      'fetch',
      'getComputedStyle',
      bundle,
    )
    run(
      dom.window,
      dom.document,
      console,
      dom.MutationObserver,
      dom.CustomEvent,
      () => 0,
      () => undefined,
      URLSearchParams,
      dom.window.fetch,
      dom.window.getComputedStyle,
    )

    assert.equal(registered.length, 1, 'the bundle must register exactly one loader entry')
    assert.equal(registered[0].id, 'dsh-plugin-otools-dbm')
    plugin = registered[0].factory(() => undefined)
  })

  after(() => {
    // The client keeps a MutationObserver and a re-mount interval alive; without
    // this the runner never sees the event loop drain.
    disposeClient?.()
  })

  it('returns the plugin shape the web shell expects', () => {
    assert.equal(plugin.name, 'dsh-plugin-otools-dbm/client')
    assert.ok(Array.isArray(plugin.inject))
    assert.equal(plugin.inject.length, 0, 'a non-empty top-level inject fails the whole page boot')
    assert.equal(typeof plugin.apply, 'function')
  })

  it('mounts the sidebar entry and the view', () => {
    plugin.apply({
      effect: (fn) => {
        disposeClient = fn()
      },
    })

    const entry = dom.document.querySelector('[data-dsh-otools-dbm-entry]')
    assert.notEqual(entry, null, 'the sidebar entry must be mounted')
    assert.equal(entry.parentElement, dom.sidebarRoot)

    const view = dom.document.querySelector('[data-dsh-dbm-view]')
    assert.notEqual(view, null, 'the view must be mounted into the conversation column')
    assert.equal(view.parentElement, dom.conversation)

    assert.notEqual(dom.document.getElementById('dsh-plugin-otools-dbm-style'), null)
  })

  it('does not load the app until the panel is opened', () => {
    assert.equal(dom.document.querySelector('iframe'), null)
    assert.deepEqual(fetched, [], 'nothing should be fetched before the first open')
  })

  it('creates the iframe on open, with the host locale and the shell theme', async () => {
    dom.document.querySelector('[data-dsh-otools-dbm-entry]').click()
    // ensureFrame awaits the locale probe.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(fetched, ['/dsh-plugin-otools-dbm/health'])
    const frame = dom.document.querySelector('iframe')
    assert.notEqual(frame, null, 'the iframe must exist once the panel is open')
    assert.match(frame.src, /^\/dsh-plugin-otools-dbm\/app\/\?/)
    assert.match(frame.src, /lang=en-US/)
    // The stub reports the shell's dark background token, so the panel must open
    // in dark mode rather than flashing white.
    assert.match(frame.src, /theme=dark/)
    assert.equal(dom.document.documentElement.getAttribute('data-dsh-dbm-open'), '')
  })

  it('closes when a sibling panel announces itself', () => {
    dom.document.dispatchEvent(new dom.CustomEvent('dsh-panel-activate', { detail: 'dsh-plugin-taskboard' }))
    assert.equal(dom.document.documentElement.getAttribute('data-dsh-dbm-open'), null)
  })

  it('survives a shell repaint without reloading the iframe', () => {
    dom.document.querySelector('[data-dsh-otools-dbm-entry]').click()
    const before = dom.document.querySelector('iframe')
    dom.fireRepaint()
    const after_ = dom.document.querySelector('iframe')
    assert.equal(after_, before, 're-parenting an iframe reloads it, so it must be left alone')
    assert.notEqual(dom.document.querySelector('[data-dsh-otools-dbm-entry]'), null)
  })

  it('re-mounts its seats when the shell throws them away', () => {
    dom.document.querySelector('[data-dsh-otools-dbm-entry]').remove()
    dom.document.querySelector('[data-dsh-dbm-view]').remove()
    dom.fireRepaint()
    assert.notEqual(dom.document.querySelector('[data-dsh-otools-dbm-entry]'), null)
    assert.notEqual(dom.document.querySelector('[data-dsh-dbm-view]'), null)
  })

  it('removes everything it added on dispose', () => {
    disposeClient()
    disposeClient = undefined
    assert.equal(dom.document.querySelector('[data-dsh-otools-dbm-entry]'), null)
    assert.equal(dom.document.querySelector('[data-dsh-dbm-view]'), null)
    assert.equal(dom.document.getElementById('dsh-plugin-otools-dbm-style'), null)
    assert.equal(dom.document.documentElement.getAttribute('data-dsh-dbm-open'), null)
  })
})
