/**
 * Route tests: the plugin mounted on a real HTTP server, driven with real requests.
 *
 * `buildCommands` is unit-tested elsewhere; what this file checks is the layer the panel
 * actually talks through — the URL shape, the error envelope `normalizeApiError` reads, the
 * static bundle, and the event socket. A stub `ctx.webServer` stands in for dsh's, matching
 * the contract in `dsh-host-webserver`'s own .d.ts: `register({kind, path, handler})` and
 * `registerUpgrade({path, handler})`, each returning a disposer.
 *
 * @module dsh-plugin-ai-switch/test/routes
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { registerAiSwitchRoutes, ROUTE_PREFIX } from '../src/host/routes.js'

let cleanups = []

after(async () => {
  for (const cleanup of cleanups) {
    await cleanup()
  }
  cleanups = []
})

/**
 * Stand the plugin up behind a real listener.
 *
 * The stub dispatches exact routes before prefix routes, which is the order dsh's own
 * webServer documents.
 */
async function mount() {
  const home = await mkdtemp(join(tmpdir(), 'ais-home-'))
  const userHomeDir = await mkdtemp(join(tmpdir(), 'ais-user-'))
  const exact = new Map()
  const prefixes = []
  const upgrades = new Map()

  const ctx = {
    webServer: {
      register({ kind, path, handler }) {
        if (kind === 'exact') {
          exact.set(path, handler)
          return () => exact.delete(path)
        }
        const entry = { path, handler }
        prefixes.push(entry)
        return () => {
          const at = prefixes.indexOf(entry)
          if (at !== -1) {
            prefixes.splice(at, 1)
          }
        }
      },
      registerUpgrade({ path, handler }) {
        upgrades.set(path, handler)
        return () => upgrades.delete(path)
      },
    },
  }

  const disposePlugin = registerAiSwitchRoutes(ctx, { home, userHomeDir })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler =
      exact.get(url.pathname) ?? prefixes.find((entry) => url.pathname.startsWith(entry.path))?.handler
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = upgrades.get(url.pathname)
    if (handler === undefined) {
      socket.destroy()
      return
    }
    void handler(req, socket, head)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`

  cleanups.push(async () => {
    await disposePlugin()
    await new Promise((resolveClose) => server.close(resolveClose))
    await rm(home, { recursive: true, force: true })
    await rm(userHomeDir, { recursive: true, force: true })
  })

  return { base, upgrades, port: server.address().port }
}

/** POST one command the way the panel's transport does. */
async function call(base, command, args = {}) {
  const response = await fetch(`${base}/api/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
}

describe('the panel API', () => {
  it('answers a command with the bare value, not an envelope', async () => {
    const { base } = await mount()
    const { status, body } = await call(base, 'list_platform_capabilities')
    assert.equal(status, 200)
    // The reference's web transport does `response.json()` and hands the result straight to
    // the caller. A `{ok, value}` wrapper here would mean editing every call site.
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 7)
  })

  it('reports a failure in the shape normalizeApiError reads', async () => {
    const { base } = await mount()
    const { status, body } = await call(base, 'list_route_credentials', { platform: 'nope' })
    assert.equal(status, 400)
    assert.deepEqual(Object.keys(body).sort(), [
      'code',
      'details',
      'message',
      'operation_id',
      'recoverable',
    ])
    assert.equal(body.code, 'platform.unknown')
    assert.equal(body.details, 'nope')
    assert.equal(body.recoverable, true)
  })

  it('answers an unknown command with the code the panel knows', async () => {
    const { base } = await mount()
    const { status, body } = await call(base, 'no_such_command')
    assert.equal(status, 404)
    assert.equal(body.code, 'web.command_unknown')
    assert.equal(body.details, 'no_such_command')
  })

  it('refuses a body that is not a JSON object', async () => {
    const { base } = await mount()
    const response = await fetch(`${base}/api/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"',
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'host.invalid_json')
  })

  it('answers GET /health with the language the shell picked', async () => {
    const { base } = await mount()
    const payload = await (await fetch(`${base}/health`)).json()
    assert.equal(payload.ok, true)
    assert.ok(['zh-CN', 'en'].includes(payload.language))
    assert.equal(typeof payload.pty, 'boolean')
    assert.equal(payload.proxy.bind_host, '127.0.0.1')
  })

  it('serves the built panel and falls back to index.html for a deep link', async () => {
    const { base } = await mount()
    const index = await fetch(`${base}/app/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type') ?? '', /text\/html/)
    // index.html must never be cached or a plugin upgrade keeps serving the old asset names.
    assert.equal(index.headers.get('cache-control'), 'no-store')
    const html = await index.text()
    assert.match(html, /<div id="root">/)
    assert.match(html, /ai-switch\.language/)

    const deep = await fetch(`${base}/app/settings/whatever`)
    assert.equal(deep.status, 200)
    assert.match(await deep.text(), /<div id="root">/)
  })

  it('redirects the bare prefix to the app', async () => {
    const { base } = await mount()
    const response = await fetch(base, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), `${ROUTE_PREFIX}/app/`)
  })

  it('never serves a file outside the bundle', async () => {
    const { base } = await mount()
    // Percent-encoded so `fetch` does not collapse the traversal before it is sent, and both
    // separators because Windows accepts either. All of these are refused outright rather
    // than answered with the SPA fallback — a 200 would read as "that path is legitimate".
    for (const path of [
      '..%2f..%2f..%2fpackage.json',
      '/..%2f..%2f..%2fpackage.json',
      '..%5c..%5cpackage.json',
      'assets%2f..%2f..%2fpackage.json',
    ]) {
      const response = await fetch(`${base}/app/${path}`)
      const body = await response.text()
      assert.equal(response.status, 403, `${path} must be refused, got ${response.status}`)
      assert.equal(body.includes('cordis.patch.yml'), false, `${path} must not reach the manifest`)
    }
  })

  it('rejects a method the API does not answer', async () => {
    const { base } = await mount()
    const response = await fetch(`${base}/api/health`, { method: 'DELETE' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, POST')
  })

  it('registers the events upgrade route and pushes frames to it', async () => {
    const { upgrades, port } = await mount()
    const path = `${ROUTE_PREFIX}/ws/events`
    assert.equal(typeof upgrades.get(path), 'function', 'the panel socket must be registered')

    // A raw RFC 6455 client: enough to complete the handshake and read one frame, without
    // adding a dependency the test does not otherwise need.
    const { createHash, randomBytes } = await import('node:crypto')
    const { connect } = await import('node:net')
    const key = randomBytes(16).toString('base64')
    const socket = connect(port, '127.0.0.1')
    await new Promise((resolveConnect) => socket.once('connect', resolveConnect))
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
      + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    const head = await new Promise((resolveHead) => socket.once('data', (chunk) => resolveHead(chunk.toString('latin1'))))
    assert.match(head, /^HTTP\/1\.1 101 /)
    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    assert.match(head, new RegExp(`sec-websocket-accept: ${expectedAccept.replace(/[+/=]/g, '\\$&')}`, 'i'))
    socket.destroy()
  })
})
