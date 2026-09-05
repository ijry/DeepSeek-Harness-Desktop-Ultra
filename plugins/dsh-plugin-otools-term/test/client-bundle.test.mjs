/**
 * Client bundle test: load the built bundle into a synthetic DOM, mount it, and drive
 * it against the real host routes.
 *
 * This is the check the syntax pass cannot make: the client fragments share ONE
 * lexical scope, so a name declared twice, or a function called before its fragment is
 * concatenated, only shows up when the bundle actually runs.
 *
 * xterm.js cannot load here (there is no script loader in the stub, so the vendor
 * script fails), which is deliberate: the panel has to come up and say so rather than
 * crash, and that path is asserted below.
 *
 * @module dsh-plugin-otools-term/test/client-bundle
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { TermEngine } from '../src/host/engine.js'
import { registerTermRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { KNOWN_HOSTS_FILE, SECRETS_FILE } from '../src/host/secrets.js'
import { STORE_FILE, TermStore } from '../src/host/store.js'
import { installDom } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Wait for a condition the panel reaches asynchronously. */
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

describe('client bundle', () => {
  let dir
  let engine
  let dispose
  let server
  let dom
  let plugin
  let disposeClient

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ot-client-'))
    const store = new TermStore({ file: join(dir, STORE_FILE) })
    engine = new TermEngine({
      store,
      ai: {},
      secretsFile: join(dir, SECRETS_FILE),
      knownHostsFile: join(dir, KNOWN_HOSTS_FILE),
      workspaces: { list: () => [{ id: 'ws1', path: dir, title: 'tmp' }], get: (id) => (id === 'ws1' ? { id: 'ws1', path: dir, title: 'tmp' } : undefined) },
    })
    await store.saveServer({ name: 'box one', protocol: 'ssh', host: '10.0.0.9', port: 22, username: 'root' })
    await store.saveServer({ name: 'desk one', protocol: 'rdp', host: '10.0.0.10', port: 3389, username: 'admin' })

    const routes = []
    dispose = registerTermRoutes({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    }, { engine })
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
      const prefix = routes.find((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
      const route = exact ?? prefix
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req, res)
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const base = 'http://127.0.0.1:' + server.address().port

    dom = installDom({ origin: base, routePrefix: ROUTE_PREFIX })
    const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    dom.window.__ModuleLoader__ = {
      load(entry) {
        plugin = entry.factory(() => undefined)
      },
    }
    // The bundle is evaluated with the browser globals it touches passed in, so a
    // reference to something the stub does not provide is a loud failure here.
    const run = new Function('window', 'document', 'navigator', 'fetch', 'EventSource',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
      'MutationObserver', 'CustomEvent', 'URLSearchParams', 'console', 'TextEncoder', 'TextDecoder',
      'Node', 'Element', 'HTMLElement', bundle)
    run(dom.window, dom.document, dom.window.navigator, dom.window.fetch, dom.window.EventSource,
      setTimeout, clearTimeout, setInterval, clearInterval, dom.window.requestAnimationFrame,
      dom.window.MutationObserver, dom.window.CustomEvent, URLSearchParams, console, TextEncoder, TextDecoder,
      dom.Node, dom.Element, dom.HTMLElement)
  })

  after(async () => {
    disposeClient?.()
    dispose?.()
    engine?.dispose()
    await new Promise((resolveClose) => server.close(resolveClose))
    dom?.restore()
    await rm(dir, { recursive: true, force: true })
  })

  it('exports the loader shape and mounts its sidebar entry', () => {
    assert.equal(plugin.name, 'dsh-plugin-otools-term/client')
    assert.deepEqual(plugin.inject, [])
    plugin.apply({
      effect(fn) {
        disposeClient = fn()
      },
    })
    const entry = dom.document.querySelector('[data-dsh-ssh-entry]')
    assert.notEqual(entry, null)
    assert.equal(entry.textContent.includes('墨鱼终端'), true)
    // The stylesheet went in once.
    assert.notEqual(dom.document.getElementById('dsh-plugin-otools-term-style'), null)
  })

  it('opens the panel and lists the local shell plus both stored connections', async () => {
    const entry = dom.document.querySelector('[data-dsh-ssh-entry]')
    entry.dispatchEvent({ type: 'click' })
    assert.equal(dom.document.documentElement.getAttribute('data-dsh-ot-open'), '')
    const rows = await until(() => {
      const found = dom.document.querySelectorAll('.dsh-ot-server')
      return found.length >= 3 ? found : false
    }, 'the server rows')
    const names = rows.map((row) => row.querySelector('.dsh-ot-server-name').textContent)
    assert.deepEqual(names, ['本地终端', 'box one', 'desk one'])
    // The toolbar and tab strip exist even before anything is selected.
    assert.notEqual(dom.document.querySelector('.dsh-ot-toolbar'), null)
    assert.notEqual(dom.document.querySelector('.dsh-ot-tabs'), null)
  })

  it('selecting the local shell opens a terminal tab that reports the missing xterm', async () => {
    const rows = dom.document.querySelectorAll('.dsh-ot-server')
    rows[0].dispatchEvent({ type: 'click' })
    const tab = await until(() => dom.document.querySelector('.dsh-ot-tab'), 'a terminal tab')
    assert.equal(tab.textContent.includes('本地终端'), true)
    const overlay = await until(() => {
      const found = dom.document.querySelector('.dsh-ot-term-overlay')
      return found !== null && found.textContent.includes('xterm') ? found : false
    }, 'the vendor-missing overlay')
    assert.equal(overlay.textContent.includes('npm install'), true)
  })

  it('opens the connection dialog with the reference fields', async () => {
    // The stub's selector engine has no descendant combinators, so the buttons are
    // found by the title the panel gives them.
    const add = dom.document.querySelector('[title="新建连接"]')
    add.dispatchEvent({ type: 'click' })
    const dialog = await until(() => dom.document.querySelector('.dsh-ot-dialog'), 'the dialog')
    const labels = dialog.querySelectorAll('label').map((row) => row.textContent)
    for (const wanted of ['服务器名称', '协议', '主机地址', '端口', '用户名', '认证方式', '密码']) {
      assert.equal(labels.some((label) => label.includes(wanted)), true, 'missing field: ' + wanted)
    }
    // Close it again so the next test starts clean.
    dialog.querySelectorAll('.dsh-ot-btn')[0].dispatchEvent({ type: 'click' })
    assert.equal(dom.document.querySelector('.dsh-ot-dialog'), null)
  })

  it('opens the settings dialog and shows the PTY state', async () => {
    const settings = dom.document.querySelector('[title="设置"]')
    settings.dispatchEvent({ type: 'click' })
    const dialog = await until(() => dom.document.querySelector('.dsh-ot-dialog'), 'the settings dialog')
    assert.equal(dialog.textContent.includes('关闭响应'), true)
    assert.equal(/node-pty/.test(dialog.textContent), true)
    dialog.querySelectorAll('.dsh-ot-btn')[0].dispatchEvent({ type: 'click' })
  })

  it('merges a live event frame into the model', async () => {
    const source = dom.window.__lastEventSource
    assert.notEqual(source, undefined)
    source.__emit('task', {
      id: 'task-fake-1',
      kind: 'upload',
      serverId: 'x',
      source: '/local/thing.txt',
      target: '/remote/thing.txt',
      status: 'transferring',
      progress: 42,
      bytesTotal: 100,
      bytesTransferred: 42,
      totalFiles: 1,
      completedFiles: 0,
      currentItem: 'thing.txt',
      error: '',
      startedAt: Date.now(),
      finishedAt: null,
    })
    // The toolbar badge counts running transfers, so the frame has to have landed.
    const badge = await until(() => {
      const found = dom.document.querySelectorAll('.dsh-ot-badge')
      return found.length > 0 ? found[0] : false
    }, 'the transfer badge')
    assert.equal(badge.textContent, '1')
  })

  it('disposes cleanly, leaving no seats behind', () => {
    disposeClient()
    disposeClient = undefined
    assert.equal(dom.document.querySelector('[data-dsh-ssh-entry]'), null)
    assert.equal(dom.document.querySelector('.dsh-ot-panel'), null)
    assert.equal(dom.document.getElementById('dsh-plugin-otools-term-style'), null)
    assert.equal(dom.document.documentElement.getAttribute('data-dsh-ot-open'), null)
  })
})
