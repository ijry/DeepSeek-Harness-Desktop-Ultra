/**
 * Host tests: the real driver against a real SSH server.
 *
 * `test/ssh-server.mjs` starts an `ssh2.Server` with password auth, an echoing shell,
 * `exec`, direct-tcpip forwarding and an fs-backed SFTP subsystem — so everything
 * below goes over an actual SSH connection. A mock would have let the interesting bugs
 * through: the host-key refusal, the PTY window-change, the byte offsets that make a
 * re-attach exact, the SOCKS5 handshake.
 *
 * @module dsh-plugin-otools-term/test/host
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { TermEngine } from '../src/host/engine.js'
import { registerTermRoutes, ROUTE_PREFIX, SOCKET_PATH } from '../src/host/routes.js'
import { KNOWN_HOSTS_FILE, SECRETS_FILE } from '../src/host/secrets.js'
import { STORE_FILE, TermStore } from '../src/host/store.js'
import { startSshServer } from './ssh-server.mjs'

/** Wait until `check` returns something truthy, or fail. */
async function until(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
}

describe('host driver', () => {
  let dir
  let remoteRoot
  let workspace
  let ssh
  let engine
  let dispose
  let server
  let base
  let events
  let serverId

  /** GET a route and unwrap the envelope. */
  const get = async (path, params) => {
    const query = new URLSearchParams(params ?? {}).toString()
    const response = await fetch(base + ROUTE_PREFIX + path + (query.length > 0 ? '?' + query : ''))
    return { status: response.status, body: await response.json() }
  }
  /** POST a route and unwrap the envelope. */
  const post = async (path, body) => {
    const response = await fetch(base + ROUTE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, body: await response.json() }
  }
  /** POST and require success. */
  const ok = async (path, body) => {
    const result = await post(path, body)
    assert.equal(result.body.ok, true, path + ' failed: ' + JSON.stringify(result.body))
    return result.body.value
  }
  /** GET and require success. */
  const okGet = async (path, params) => {
    const result = await get(path, params)
    assert.equal(result.body.ok, true, path + ' failed: ' + JSON.stringify(result.body))
    return result.body.value
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ot-host-'))
    remoteRoot = join(dir, 'remote')
    workspace = join(dir, 'workspace')
    await mkdir(remoteRoot, { recursive: true })
    await mkdir(join(remoteRoot, 'sub'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(remoteRoot, 'hello.txt'), 'hello world\n', 'utf8')
    await writeFile(join(remoteRoot, 'sub', 'inner.txt'), 'inner\n', 'utf8')
    await writeFile(join(workspace, 'upload-me.txt'), 'from the workspace\n', 'utf8')
    try {
      await symlink(join(remoteRoot, 'hello.txt'), join(remoteRoot, 'link.txt'))
    } catch { /* Windows without developer mode: the symlink case is skipped */ }

    ssh = await startSshServer({ root: remoteRoot })

    const store = new TermStore({ file: join(dir, STORE_FILE) })
    engine = new TermEngine({
      store,
      ai: {},
      secretsFile: join(dir, SECRETS_FILE),
      knownHostsFile: join(dir, KNOWN_HOSTS_FILE),
      workspaces: {
        list: () => [{ id: 'ws1', path: workspace, title: 'workspace' }],
        get: (id) => (id === 'ws1' ? { id: 'ws1', path: workspace, title: 'workspace' } : undefined),
      },
    })

    const routes = []
    const upgrades = []
    dispose = registerTermRoutes({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
        // The real DSH webserver has this hook (dsh-host-webserver's
        // `registerUpgrade`), so the terminal socket is exercised here rather than
        // only its HTTP fallback.
        registerUpgrade(route) {
          upgrades.push(route)
          return () => {
            const index = upgrades.indexOf(route)
            if (index >= 0) upgrades.splice(index, 1)
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
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = upgrades.find((row) => row.path === url.pathname)
      if (route === undefined) {
        socket.destroy()
        return
      }
      void route.handler(req, socket, head)
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    base = 'http://127.0.0.1:' + server.address().port

    // One SSE reader for the whole suite, parsed into a list of frames. The abort
    // controller matters: an SSE response never ends, so without it the reader keeps
    // the event loop alive and `node --test` never exits.
    events = { frames: [], done: false, controller: new AbortController() }
    const stream = await fetch(base + ROUTE_PREFIX + '/events?clientId=test-panel', { signal: events.controller.signal })
    void (async () => {
      try {
        const reader = stream.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            const eventLine = part.split('\n').find((line) => line.startsWith('event: '))
            const dataLine = part.split('\n').find((line) => line.startsWith('data: '))
            if (eventLine === undefined || dataLine === undefined) continue
            try {
              events.frames.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
            } catch { /* a keepalive comment */ }
          }
        }
      } catch { /* aborted at teardown */ }
      events.done = true
    })()

    const saved = await ok('/servers/save', {
      server: { name: 'test box', protocol: 'ssh', host: ssh.host, port: ssh.port, username: ssh.username },
      secrets: { password: ssh.password },
    })
    serverId = saved.server.id
  })

  after(async () => {
    events?.controller.abort()
    dispose?.()
    engine?.dispose()
    await new Promise((resolveClose) => server.close(resolveClose))
    await ssh?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('stores a server without leaking its password', async () => {
    const state = await okGet('/state')
    assert.equal(state.servers.length, 1)
    assert.equal(state.servers[0].hasPassword, true)
    assert.equal(Object.hasOwn(state.servers[0], 'password'), false)
    const onDisk = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'))
    assert.equal(JSON.stringify(onDisk).includes(ssh.password), false)
  })

  it('refuses an unknown host key, then connects once it is accepted', async () => {
    const refused = await post('/connection/connect', { serverId })
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'host_key')
    assert.match(refused.body.error.fingerprint, /^SHA256:/)
    assert.equal(refused.body.error.mismatch, false)

    await ok('/connection/host-key/accept', {
      serverId,
      fingerprint: refused.body.error.fingerprint,
      keyType: refused.body.error.keyType,
    })
    const connected = await ok('/connection/connect', { serverId })
    assert.equal(connected.status, 'connected')
    const state = await okGet('/state')
    assert.equal(state.knownHosts.length, 1)
  })

  it('opens a shell, echoes input, and reports a resize to the PTY', async () => {
    const sessionId = 'sess-shell-1'
    await ok('/terminal/subscribe', { clientId: 'test-panel', sessionIds: [sessionId] })
    const session = await ok('/terminal/open', { sessionId, serverId, cols: 80, rows: 24 })
    assert.equal(session.status, 'running')

    const textOf = () => events.frames.filter((frame) => frame.event === 'output' && frame.data.sessionId === sessionId)
      .map((frame) => Buffer.from(frame.data.data, 'base64').toString('utf8')).join('')
    await until(() => textOf().includes('READY 80x24'), 'the shell banner')

    await ok('/terminal/input', { sessionId, data: Buffer.from('hello\r', 'utf8').toString('base64') })
    await until(() => textOf().includes('ECHO hello'), 'the echoed line')

    await ok('/terminal/resize', { sessionId, cols: 100, rows: 30 })
    await until(() => textOf().includes('SIZE 100x30'), 'the window-change')

    // The replay says where it ends, and every frame says where it starts: that pair
    // is what lets a re-attaching panel splice without duplicating.
    const replay = await okGet('/session/replay', { sessionId })
    const replayText = Buffer.from(replay.data, 'base64').toString('utf8')
    assert.match(replayText, /READY 80x24/)
    assert.equal(replay.offset, Buffer.byteLength(replayText, 'utf8') + replay.start)
    const frames = events.frames.filter((frame) => frame.event === 'output' && frame.data.sessionId === sessionId)
    assert.equal(frames[0].data.offset, 0)
    for (let index = 1; index < frames.length; index += 1) {
      assert.equal(frames[index].data.offset, frames[index - 1].data.offset + frames[index - 1].data.bytes)
    }

    await ok('/terminal/close', { sessionId })
    const state = await okGet('/state')
    assert.equal(state.sessions.some((row) => row.sessionId === sessionId), false)
  })

  it('lists, creates, renames, chmods and deletes over SFTP', async () => {
    const home = await okGet('/sftp/home', { serverId })
    assert.equal(home.path, '/')

    const listing = await okGet('/sftp/list', { serverId, path: '/' })
    const names = listing.entries.map((row) => row.name)
    assert.ok(names.includes('hello.txt'))
    assert.ok(names.includes('sub'))
    // Directories first, then by name — the reference's order.
    assert.equal(listing.entries[0].isDirectory, true)
    const file = listing.entries.find((row) => row.name === 'hello.txt')
    assert.equal(file.isFile, true)
    assert.equal(file.size, 12)
    assert.match(file.permissions, /^[rwx-]{9}$/)

    await ok('/sftp/mkdir', { serverId, path: '/made/deeper' })
    await ok('/sftp/create-file', { serverId, path: '/made/deeper/note.txt' })
    await ok('/sftp/write', { serverId, path: '/made/deeper/note.txt', content: 'written\n' })
    const read = await okGet('/sftp/read', { serverId, path: '/made/deeper/note.txt' })
    assert.equal(read.content, 'written\n')
    assert.equal(read.binary, false)

    await ok('/sftp/rename', { serverId, from: '/made/deeper/note.txt', to: '/made/deeper/renamed.txt' })
    assert.equal((await readFile(join(remoteRoot, 'made', 'deeper', 'renamed.txt'), 'utf8')), 'written\n')

    if (process.platform !== 'win32') {
      const chmodded = await ok('/sftp/chmod', { serverId, path: '/made/deeper/renamed.txt', mode: '600' })
      assert.equal(chmodded.permissions, 'rw-------')
    }

    await ok('/sftp/delete', { serverId, path: '/made' })
    const after = await okGet('/sftp/list', { serverId, path: '/' })
    assert.equal(after.entries.some((row) => row.name === 'made'), false)
  })

  it('runs the remote search through find', async () => {
    const found = await okGet('/sftp/search', { serverId, keyword: 'hello' })
    assert.deepEqual(found.items.map((row) => row.path), ['/sub', '/hello.txt'])
    assert.equal(found.truncated, false)
  })

  it('downloads a file and a directory (as tar) to the browser', async () => {
    const single = await fetch(base + ROUTE_PREFIX + '/sftp/download?' +
      new URLSearchParams({ serverId, path: '/hello.txt' }).toString())
    assert.equal(single.status, 200)
    assert.match(single.headers.get('content-disposition'), /filename="hello.txt"/)
    assert.equal(await single.text(), 'hello world\n')

    const tar = await fetch(base + ROUTE_PREFIX + '/sftp/download?' +
      new URLSearchParams({ serverId, path: '/sub' }).toString())
    assert.equal(tar.status, 200)
    assert.equal(tar.headers.get('content-type'), 'application/x-tar')
    const archive = Buffer.from(await tar.arrayBuffer())
    // ustar magic in the first header, and the file's name and bytes inside.
    assert.equal(archive.subarray(257, 262).toString('ascii'), 'ustar')
    assert.ok(archive.includes(Buffer.from('sub/inner.txt', 'ascii')))
    assert.ok(archive.includes(Buffer.from('inner\n', 'ascii')))
    assert.equal(archive.length % 512, 0)
  })

  it('moves a workspace file to the remote and back', async () => {
    const task = await ok('/transfer/upload-workspace', {
      serverId,
      workspaceId: 'ws1',
      relative: 'upload-me.txt',
      remoteDir: '/sub',
    })
    assert.equal(task.kind, 'upload')
    await until(async () => {
      const state = await okGet('/state')
      const row = state.tasks.find((item) => item.id === task.id)
      return row !== undefined && row.status === 'completed' ? row : false
    }, 'the upload to finish')
    assert.equal(await readFile(join(remoteRoot, 'sub', 'upload-me.txt'), 'utf8'), 'from the workspace\n')

    const down = await ok('/transfer/download-workspace', {
      serverId,
      path: '/sub',
      workspaceId: 'ws1',
      relative: 'pulled',
    })
    await until(async () => {
      const state = await okGet('/state')
      const row = state.tasks.find((item) => item.id === down.id)
      return row !== undefined && row.status === 'completed' ? row : false
    }, 'the download to finish')
    assert.equal(await readFile(join(workspace, 'pulled', 'sub', 'inner.txt'), 'utf8'), 'inner\n')
  })

  it('forwards a local port through the connection', async () => {
    // A plain TCP echo server stands in for "something on the remote network".
    const echo = createTcpServer((socket) => socket.pipe(socket))
    await new Promise((resolveListen) => echo.listen(0, '127.0.0.1', resolveListen))
    const target = echo.address().port
    try {
      const runtime = await ok('/tunnel/forward/start', {
        serverId,
        rule: { id: 'rule-1', name: 'echo', listenHost: '127.0.0.1', listenPort: 0, remoteHost: '127.0.0.1', remotePort: target },
      })
      assert.ok(runtime.listenPort > 0)
      const answer = await new Promise((resolvePromise, rejectPromise) => {
        const socket = tcpConnect(runtime.listenPort, '127.0.0.1', () => socket.write('ping through the tunnel'))
        socket.on('data', (chunk) => {
          resolvePromise(chunk.toString('utf8'))
          socket.end()
        })
        socket.on('error', rejectPromise)
      })
      assert.equal(answer, 'ping through the tunnel')
      const state = await okGet('/tunnels', { serverId })
      assert.equal(state.portForwards.length, 1)
      await ok('/tunnel/forward/stop', { serverId, ruleId: 'rule-1' })
      assert.equal((await okGet('/tunnels', { serverId })).portForwards.length, 0)
    } finally {
      await new Promise((resolveClose) => echo.close(resolveClose))
    }
  })

  it('proxies a CONNECT through SOCKS5', async () => {
    const echo = createTcpServer((socket) => socket.pipe(socket))
    await new Promise((resolveListen) => echo.listen(0, '127.0.0.1', resolveListen))
    const target = echo.address().port
    try {
      const runtime = await ok('/tunnel/socks/start', {
        serverId,
        proxy: { listenHost: '127.0.0.1', listenPort: 0 },
      })
      const answer = await new Promise((resolvePromise, rejectPromise) => {
        const socket = tcpConnect(runtime.listenPort, '127.0.0.1')
        const chunks = []
        let phase = 'greeting'
        socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
        socket.on('data', (chunk) => {
          if (phase === 'greeting') {
            assert.deepEqual([...chunk.subarray(0, 2)], [0x05, 0x00])
            phase = 'request'
            const port = Buffer.alloc(2)
            port.writeUInt16BE(target, 0)
            socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]), port]))
            return
          }
          if (phase === 'request') {
            assert.equal(chunk[1], 0x00)
            phase = 'data'
            socket.write('socks says hi')
            return
          }
          chunks.push(chunk)
          resolvePromise(Buffer.concat(chunks).toString('utf8'))
          socket.end()
        })
        socket.on('error', rejectPromise)
      })
      assert.equal(answer, 'socks says hi')
      await ok('/tunnel/socks/stop', { serverId })
    } finally {
      await new Promise((resolveClose) => echo.close(resolveClose))
    }
  })

  it('serves the vendored xterm assets and nothing else', async () => {
    const script = await fetch(base + ROUTE_PREFIX + '/vendor/xterm.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /javascript/)
    const body = await script.text()
    assert.ok(body.length > 10_000)
    assert.equal((await fetch(base + ROUTE_PREFIX + '/vendor/xterm.css')).status, 200)
    // The table is an allow-list, so a traversal is simply not a name on it.
    assert.equal((await fetch(base + ROUTE_PREFIX + '/vendor/../package.json')).status, 404)
    assert.equal((await fetch(base + ROUTE_PREFIX + '/vendor/index.js')).status, 404)
  })

  it('carries terminal bytes over the WebSocket when one is offered', async () => {
    const sessionId = 'sess-socket-1'
    await ok('/terminal/open', { sessionId, serverId, cols: 80, rows: 24 })
    const socket = new WebSocket(base.replace('http', 'ws') + SOCKET_PATH + '?clientId=socket-panel')
    const frames = []
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        socket.addEventListener('open', resolvePromise)
        socket.addEventListener('error', rejectPromise)
      })
      socket.addEventListener('message', (event) => {
        try {
          frames.push(JSON.parse(String(event.data)))
        } catch { /* not our frame */ }
      })
      // Everything the panel needs on the socket: subscribe, type, resize.
      socket.send(JSON.stringify({ kind: 'subscribe', sessionIds: [sessionId] }))
      socket.send(JSON.stringify({ kind: 'input', data: Buffer.from('over-the-socket\r').toString('base64'), sessionId }))
      const textOf = () => frames.filter((frame) => frame.event === 'output' && frame.data.sessionId === sessionId)
        .map((frame) => Buffer.from(frame.data.data, 'base64').toString('utf8')).join('')
      await until(() => textOf().includes('ECHO over-the-socket'), 'the echo over the socket')
      socket.send(JSON.stringify({ kind: 'resize', sessionId, cols: 133, rows: 44 }))
      await until(() => textOf().includes('SIZE 133x44'), 'the resize over the socket')

      // A malformed frame is answered, not fatal.
      socket.send(JSON.stringify({ kind: 'input', sessionId, data: 'not base64!!' }))
      await until(() => frames.some((frame) => frame.event === 'socket-error'), 'the rejected frame')
      assert.equal(socket.readyState, 1)
    } finally {
      socket.close()
      await ok('/terminal/close', { sessionId })
    }
  })

  it('opens a local terminal (PTY or the pipe fallback)', async () => {
    const sessionId = 'sess-local-1'
    await ok('/terminal/subscribe', { clientId: 'test-panel', sessionIds: [sessionId] })
    const session = await ok('/terminal/open', { sessionId, serverId: '__local__', cols: 90, rows: 20 })
    assert.equal(session.kind, 'local')
    assert.equal(session.status, 'running')
    const marker = process.platform === 'win32' ? 'dsh-ot-local-ok' : 'dsh-ot-local-ok'
    await ok('/terminal/input', { sessionId, data: Buffer.from('echo ' + marker + '\r', 'utf8').toString('base64') })
    const textOf = () => events.frames.filter((frame) => frame.event === 'output' && frame.data.sessionId === sessionId)
      .map((frame) => Buffer.from(frame.data.data, 'base64').toString('utf8')).join('')
    await until(() => textOf().includes(marker), 'the local shell to echo')
    await ok('/terminal/close', { sessionId })
  })
})
