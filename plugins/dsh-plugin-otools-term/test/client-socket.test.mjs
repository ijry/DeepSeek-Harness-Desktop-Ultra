/**
 * Which channel the panel streams on.
 *
 * The panel shares one origin with the DSH shell and every other panel plugin, and a
 * browser allows about six concurrent HTTP/1.1 connections per origin. An SSE stream
 * holds one of those for as long as the panel is loaded, so six streaming panels leave
 * the page unable to fetch anything at all — the failure that used to leave this panel
 * on "正在启动会话…" forever, because its `<script src=…/vendor/xterm.js>` never got a
 * connection and therefore fired neither `load` nor `error`.
 *
 * So: with a WebSocket to be had, no stream is opened at all; if the socket dies the
 * stream takes over, and when the socket comes back the stream is closed again.
 *
 * @module dsh-plugin-otools-term/test/client-socket
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

describe('client channel choice', () => {
  let dir
  let engine
  let dispose
  let server
  let dom
  let plugin
  let disposeClient

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ot-socket-'))
    const store = new TermStore({ file: join(dir, STORE_FILE) })
    engine = new TermEngine({
      store,
      ai: {},
      secretsFile: join(dir, SECRETS_FILE),
      knownHostsFile: join(dir, KNOWN_HOSTS_FILE),
      workspaces: { list: () => [], get: () => undefined },
    })
    await store.saveServer({ name: 'box one', protocol: 'ssh', host: '10.0.0.9', port: 22, username: 'root' })

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

    dom = installDom({ origin: base, routePrefix: ROUTE_PREFIX, webSocket: true })
    const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    dom.window.__ModuleLoader__ = {
      load(entry) {
        plugin = entry.factory(() => undefined)
      },
    }
    const run = new Function('window', 'document', 'navigator', 'fetch', 'EventSource',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
      'MutationObserver', 'CustomEvent', 'URLSearchParams', 'console', 'TextEncoder', 'TextDecoder',
      'Node', 'Element', 'HTMLElement', bundle)
    run(dom.window, dom.document, dom.window.navigator, dom.window.fetch, dom.window.EventSource,
      setTimeout, clearTimeout, setInterval, clearInterval, dom.window.requestAnimationFrame,
      dom.window.MutationObserver, dom.window.CustomEvent, URLSearchParams, console, TextEncoder, TextDecoder,
      dom.Node, dom.Element, dom.HTMLElement)
    plugin.apply({
      effect(fn) {
        disposeClient = fn()
      },
    })
  })

  after(async () => {
    disposeClient?.()
    dispose?.()
    engine?.dispose()
    await new Promise((resolveClose) => server.close(resolveClose))
    dom?.restore()
    await rm(dir, { recursive: true, force: true })
  })

  it('opens the socket and no event stream at all', () => {
    const socket = dom.window.__lastSocket
    assert.notEqual(socket, undefined)
    assert.match(String(socket.url), /^ws:\/\/127\.0\.0\.1:\d+\/dsh-plugin-otools-term\/socket\?clientId=/)
    // The whole point: no EventSource, so no HTTP connection held.
    assert.equal(dom.window.__lastEventSource, undefined)
  })

  it('subscribes over the socket once it is open, still without a stream', async () => {
    const socket = dom.window.__lastSocket
    socket.__open()
    const frame = await until(() => socket.sent.find((row) => row.kind === 'subscribe'), 'the subscribe frame')
    assert.deepEqual(frame.sessionIds, [])
    assert.equal(dom.window.__lastEventSource, undefined)
  })

  it('paints itself from frames that arrive on the socket', async () => {
    const entry = dom.document.querySelector('[data-dsh-ssh-entry]')
    entry.dispatchEvent({ type: 'click' })
    // The panel is up on the ledger it fetched; this frame can only come from the
    // socket, so a row bearing its name proves the channel carries control events too.
    await until(() => dom.document.querySelectorAll('.dsh-ot-server').length >= 2, 'the server rows')
    dom.window.__lastSocket.__emit('hello', {
      revision: 99,
      servers: [{ id: 'sock-1', name: 'from-hello', protocol: 'ssh', host: '10.0.0.11', port: 22, username: 'root' }],
    })
    const names = await until(() => {
      const rows = dom.document.querySelectorAll('.dsh-ot-server-name').map((row) => row.textContent)
      return rows.includes('from-hello') ? rows : false
    }, 'the row from the hello frame')
    assert.deepEqual(names, ['本地终端', 'from-hello'])
  })

  it('falls back to the stream when the socket dies, and drops it when the socket returns', async () => {
    dom.window.__lastSocket.__close()
    // Degrading is immediate: being deaf costs more than the connection a stream holds.
    const stream = await until(() => dom.window.__lastEventSource, 'the fallback stream')
    assert.match(String(stream.url), /\/dsh-plugin-otools-term\/events\?clientId=/)
    // The socket is retried on a backoff; when one connects, the stream is closed and
    // its connection goes back to the page.
    const retried = await until(() => (dom.window.__lastSocket.readyState === 0 ? dom.window.__lastSocket : false),
      'a retried socket', 6000)
    retried.__open()
    await until(() => stream.readyState === 2, 'the stream to be closed')
  })
})
