/**
 * End-to-end route tests over a real HTTP server with a fake `apiProxy`.
 *
 * These exist mainly for the security properties, which cannot be unit-tested in
 * pieces: that no session route answers without a token, that the admin routes
 * are unreachable on the carrier a tunnel would hit, that a pairing code buys
 * exactly one device, and that a refresh retires the credential it replaces.
 *
 * @module dsh-plugin-mobile-bridge/test/routes
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PairingOffers } from '../lib/host/auth.js'
import { createBridge } from '../lib/host/bridge.js'
import { createRoutes, createUpgradeHandler } from '../lib/host/routes.js'
import { DeviceStore } from '../lib/host/store.js'
import { EventHub } from '../lib/host/stream.js'
import { APPROVAL_OUTCOME, ROUTE_PREFIX } from '../lib/shared/protocol.js'

/** A stand-in for dsh's `/api` surface, recording what the bridge asked for. */
function fakeApiProxy() {
  const calls = []
  const record = (name) => (request, signal) => {
    calls.push({ name, payload: request.payload, rpcId: request.rpcId, signal })
    return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: RESULTS[name] ?? {} } })
  }
  const RESULTS = {
    describe: { version: '0.1.1-rc.2', cwd: '/w', attachedSessions: 1, home: '/h', canOpenPath: true },
    list: { items: [{ sessionId: 's1', updatedAt: 5, running: false, blank: false, cwd: '/w' }] },
    create: { sessionId: 's-new' },
    history: { events: [], hasMore: false, projections: { asOfSeq: 3, values: { title: 'T' } } },
    prompt: { accepted: true },
    cancel: { accepted: true },
    workspaces: { items: [{ workspaceId: 'w1', title: 'proj', path: '/w', sessionIds: ['s1'] }], archivedSessionIds: [] },
  }
  // The two stream openers never yield: these tests drive the hub directly, and a
  // stream that produced fixtures would make every assertion timing-dependent.
  const idle = () => ({ async *[Symbol.asyncIterator]() {} })

  return {
    calls,
    proxy: {
      host: { describe: record('describe') },
      sessions: {
        list: record('list'),
        search: record('search'),
        create: record('create'),
        history: record('history'),
        prompt: record('prompt'),
        cancel: record('cancel'),
        rename: record('rename'),
        models: record('models'),
        selectModel: record('selectModel'),
      },
      workspace: { list: record('workspaces') },
      events: { mux: idle, host: idle },
      respond(message) {
        calls.push({ name: 'respond', message })
        return Promise.resolve({ accepted: true })
      },
    },
  }
}

/** Stand up both carriers on one loopback port each and return a driver. */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'mbridge-'))
  const store = new DeviceStore({ file: join(dir, 'ledger.json') })
  const offers = new PairingOffers()
  const { proxy, calls } = fakeApiProxy()
  const bridge = createBridge(proxy)
  const hub = new EventHub({ bridge })

  const shared = {
    bridge,
    store,
    hub,
    offers,
    reach: () => ({ lan: true, listening: true, port: 8790, host: '0.0.0.0', error: null, localUrl: `http://127.0.0.1:8790${ROUTE_PREFIX}`, urls: [`http://10.0.0.5:8790${ROUTE_PREFIX}`], dshRoutePrefix: ROUTE_PREFIX }),
    displayName: () => '测试机 的 dsh',
    dshVersion: () => '0.1.1-rc.2',
    downloadUrl: 'https://getmcode.lingyun.net',
    now: () => Date.now(),
  }

  const servers = {}
  for (const [key, admin] of [
    ['local', true],
    ['remote', false],
  ]) {
    const handler = createRoutes({ ...shared, admin })
    const upgradeHandler = createUpgradeHandler(shared)
    const server = createServer((req, res) => void handler(req, res))
    server.on('upgrade', (req, socket, head) => void upgradeHandler(req, socket, head))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers[key] = {
      server,
      port: server.address().port,
      base: `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`,
    }
  }

  return {
    calls,
    store,
    offers,
    hub,
    local: servers.local.base,
    remote: servers.remote.base,
    remotePort: servers.remote.port,
    async close() {
      hub.stop()
      for (const key of Object.keys(servers)) {
        await new Promise((resolve) => servers[key].server.close(resolve))
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** One request; returns `{ status, body }` with the JSON envelope parsed. */
async function call(base, path, options = {}) {
  const res = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: res.status, body: await res.json() }
}

/** Pair one device and return its tokens. */
async function pairOnce(kit, base = kit.remote) {
  const offer = kit.offers.current()
  const paired = await call(base, '/pair', {
    method: 'POST',
    body: { code: offer.code, secret: offer.secret, deviceName: '测试手机' },
  })
  assert.equal(paired.status, 201, JSON.stringify(paired.body))
  return paired.body.value
}

test('hello is public and carries no credential', async () => {
  const kit = await harness()
  try {
    const { status, body } = await call(kit.remote, '/hello')
    assert.equal(status, 200)
    assert.equal(body.value.targetAgent, 'dsh')
    assert.equal(body.value.protocolVersion, '1')
    assert.equal(body.value.requiresPairing, true)
    assert.ok(Array.isArray(body.value.capabilities) && body.value.capabilities.length > 0)
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes(kit.offers.current().secret), 'hello must never leak the pairing secret')
    assert.ok(!serialized.includes(kit.offers.current().code), 'nor the pairing code')
  } finally {
    await kit.close()
  }
})

test('every session route refuses an unauthenticated caller', async () => {
  const kit = await harness()
  try {
    for (const [method, path] of [
      ['GET', '/sessions'],
      ['POST', '/sessions'],
      ['GET', '/workspaces'],
      ['GET', '/sessions/s1/messages'],
      ['POST', '/sessions/s1/prompt'],
      ['POST', '/sessions/s1/cancel'],
      ['POST', '/answers'],
      ['GET', '/events'],
      ['GET', '/search?q=x'],
    ]) {
      const { status, body } = await call(kit.remote, path, { method, body: method === 'POST' ? {} : undefined })
      assert.equal(status, 401, `${method} ${path} answered ${status}`)
      assert.equal(body.error.code, 'unauthorized')
    }
    assert.equal(kit.calls.length, 0, 'not one call reached dsh')
  } finally {
    await kit.close()
  }
})

test('a pairing code buys exactly one device', async () => {
  const kit = await harness()
  try {
    const offer = kit.offers.current()
    const first = await call(kit.remote, '/pair', { method: 'POST', body: { code: offer.code, secret: offer.secret } })
    assert.equal(first.status, 201)
    assert.ok(first.body.value.accessToken.startsWith('dshm_'))
    assert.equal(first.body.value.target.targetAgent, 'dsh')

    const replay = await call(kit.remote, '/pair', { method: 'POST', body: { code: offer.code, secret: offer.secret } })
    assert.equal(replay.status, 401, 'a photographed QR must not pair a second phone')
    assert.equal(replay.body.error.code, 'pairing_failed')
  } finally {
    await kit.close()
  }
})

test('a wrong secret fails even with the right code, and throttles', async () => {
  const kit = await harness()
  try {
    const offer = kit.offers.current()
    const wrong = await call(kit.remote, '/pair', { method: 'POST', body: { code: offer.code, secret: 'nope' } })
    assert.equal(wrong.status, 401)
    // The offer survives a failure, or one typo would force a rescan.
    assert.equal(kit.offers.current().code, offer.code)

    for (let i = 0; i < 12; i += 1) {
      await call(kit.remote, '/pair', { method: 'POST', body: { code: 'AAAA-AAAA', secret: 'x' } })
    }
    const throttled = await call(kit.remote, '/pair', { method: 'POST', body: { code: offer.code, secret: offer.secret } })
    assert.equal(throttled.status, 429)
    assert.equal(throttled.body.error.code, 'rate_limited')
  } finally {
    await kit.close()
  }
})

test('admin routes exist on the loopback carrier and nowhere else', async () => {
  const kit = await harness()
  try {
    const blocked = await call(kit.remote, '/admin/state')
    assert.equal(blocked.status, 403, 'the carrier a tunnel reaches must not serve admin')
    assert.equal(blocked.body.error.code, 'forbidden')

    const allowed = await call(kit.local, '/admin/state')
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.value.displayName, '测试机 的 dsh')
    assert.equal(allowed.body.value.pairing.code, kit.offers.current().code)
    assert.ok(
      !JSON.stringify(allowed.body).includes(kit.offers.current().secret),
      'even the admin state poll keeps the secret out; only /admin/qr carries it',
    )

    const qr = await call(kit.local, '/admin/qr')
    assert.equal(qr.status, 200)
    assert.equal(qr.body.value.payload.pairSecret, kit.offers.current().secret)
    assert.ok(qr.body.value.pairing.path.length > 100, 'the pairing QR has geometry')
    assert.ok(qr.body.value.download.path.length > 100, 'so does the download QR')
    assert.equal(qr.body.value.payload.targetAgent, 'dsh')
  } finally {
    await kit.close()
  }
})

test('a paired device reaches the allowlisted surface and nothing more', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)

    const list = await call(kit.remote, '/sessions', { token: accessToken })
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.value.items, [
      { sessionId: 's1', title: null, updatedAt: 5, running: false, blank: false, cwd: '/w' },
    ])

    const created = await call(kit.remote, '/sessions', { method: 'POST', token: accessToken, body: { cwd: '/w' } })
    assert.equal(created.status, 201)
    assert.equal(created.body.value.sessionId, 's-new')
    assert.deepEqual(kit.calls.at(-1).payload, { cwd: '/w' })

    const messages = await call(kit.remote, '/sessions/s1/messages?limit=5', { token: accessToken })
    assert.equal(messages.status, 200)
    assert.equal(messages.body.value.title, 'T')
    assert.deepEqual(kit.calls.at(-1).payload, { sessionId: 's1', maxMessages: 5 })

    const workspaces = await call(kit.remote, '/workspaces', { token: accessToken })
    assert.deepEqual(workspaces.body.value.items, [{ workspaceId: 'w1', title: 'proj', path: '/w', sessions: 1 }])

    // No route reaches settings, credentials, agentPreset, or the directory
    // picker: they do not exist in this table, which is the point.
    for (const path of ['/settings', '/credentials', '/host/pickDirectory', '/api/settings.describe']) {
      const { status } = await call(kit.remote, path, { token: accessToken })
      assert.equal(status, 404, `${path} must not exist`)
    }
  } finally {
    await kit.close()
  }
})

test('a page size beyond the ceiling is clamped, not honoured', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    await call(kit.remote, '/sessions/s1/messages?limit=100000', { token: accessToken })
    assert.equal(kit.calls.at(-1).payload.maxMessages, 200)
    await call(kit.remote, '/sessions/s1/messages?limit=0', { token: accessToken })
    assert.equal(kit.calls.at(-1).payload.maxMessages, 40, 'a nonsense limit falls back to the default')
  } finally {
    await kit.close()
  }
})

test('a prompt becomes dsh content parts, and an empty one is refused', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)

    const sent = await call(kit.remote, '/sessions/s1/prompt', {
      method: 'POST',
      token: accessToken,
      body: { text: '看看 CI', mode: 'steer', images: [{ mediaType: 'image/png', data: 'AAA', name: 'shot.png' }] },
    })
    assert.equal(sent.status, 200)
    const payload = kit.calls.at(-1).payload
    assert.equal(payload.sessionId, 's1')
    assert.equal(payload.mode, 'steer')
    assert.deepEqual(payload.content, [
      { type: 'text', text: '看看 CI' },
      { type: 'image', mediaType: 'image/png', data: 'AAA', name: 'shot.png' },
    ])

    const blank = await call(kit.remote, '/sessions/s1/prompt', { method: 'POST', token: accessToken, body: { text: '   ' } })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error.code, 'invalid_input')

    const notAnImage = await call(kit.remote, '/sessions/s1/prompt', {
      method: 'POST',
      token: accessToken,
      body: { text: 'x', images: [{ mediaType: 'application/zip', data: 'AAA' }] },
    })
    assert.equal(notAnImage.status, 200)
    assert.equal(kit.calls.at(-1).payload.content.length, 1, 'a non-image attachment is dropped, not forwarded')

    const badMode = await call(kit.remote, '/sessions/s1/prompt', {
      method: 'POST',
      token: accessToken,
      body: { text: 'x', mode: 'whatever' },
    })
    assert.equal(badMode.status, 200)
    assert.equal(kit.calls.at(-1).payload.mode, 'queue', 'an unknown mode falls back to queue, never to steer')
  } finally {
    await kit.close()
  }
})

test('refresh rotates both halves and retires the old access token', async () => {
  const kit = await harness()
  try {
    const first = await pairOnce(kit)
    assert.equal((await call(kit.remote, '/sessions', { token: first.accessToken })).status, 200)

    const rolled = await call(kit.remote, '/session/refresh', { method: 'POST', body: { refreshToken: first.refreshToken } })
    assert.equal(rolled.status, 200)
    const next = rolled.body.value
    assert.notEqual(next.accessToken, first.accessToken)
    assert.notEqual(next.refreshToken, first.refreshToken)

    assert.equal((await call(kit.remote, '/sessions', { token: next.accessToken })).status, 200)
    assert.equal(
      (await call(kit.remote, '/sessions', { token: first.accessToken })).status,
      401,
      'the replaced access token must stop working',
    )
    assert.equal(
      (await call(kit.remote, '/session/refresh', { method: 'POST', body: { refreshToken: first.refreshToken } })).status,
      401,
      'and so must the replaced refresh token',
    )
  } finally {
    await kit.close()
  }
})

test('logout and admin revoke both cut the device off immediately', async () => {
  const kit = await harness()
  try {
    const mine = await pairOnce(kit)
    assert.equal((await call(kit.remote, '/logout', { method: 'POST', token: mine.accessToken })).status, 200)
    assert.equal((await call(kit.remote, '/sessions', { token: mine.accessToken })).status, 401)

    const other = await pairOnce(kit)
    const state = await call(kit.local, '/admin/state')
    const device = state.body.value.devices.at(-1)
    const revoked = await call(kit.local, '/admin/revoke', { method: 'POST', body: { deviceId: device.deviceId } })
    assert.equal(revoked.status, 200)
    assert.equal((await call(kit.remote, '/sessions', { token: other.accessToken })).status, 401)
    // Revoking also rotates the offer: leaving a live code behind would undo
    // half of what the button is for.
    assert.notEqual(revoked.body.value.pairing.code, state.body.value.pairing.code)
  } finally {
    await kit.close()
  }
})

test('an approval answer echoes the request id dsh minted', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    const answered = await call(kit.remote, '/answers', {
      method: 'POST',
      token: accessToken,
      body: { kind: 'approval', requestId: 'rpc-9', sessionId: 's1', approvalId: 'ap-9', outcome: APPROVAL_OUTCOME.allow },
    })
    assert.equal(answered.status, 200)
    const sent = kit.calls.at(-1).message
    assert.equal(sent.type, 'client-response')
    assert.equal(sent.rpcId, 'rpc-9', 'a fresh id would orphan the answer and hang the agent')
    assert.deepEqual(sent.result.value, { sessionId: 's1', approvalId: 'ap-9', outcome: 'allowed-once' })

    const forged = await call(kit.remote, '/answers', {
      method: 'POST',
      token: accessToken,
      body: { kind: 'approval', requestId: 'rpc-9', sessionId: 's1', approvalId: 'ap-9', outcome: 'cancelled' },
    })
    assert.equal(forged.status, 400, 'a client cannot claim a host-side outcome')
  } finally {
    await kit.close()
  }
})

test('a question answer is shaped as one batch', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    await call(kit.remote, '/answers', {
      method: 'POST',
      token: accessToken,
      body: {
        kind: 'question',
        requestId: 'rpc-q',
        sessionId: 's1',
        answers: [{ id: 'q1', selected: ['A'], custom: '别的' }],
      },
    })
    assert.deepEqual(kit.calls.at(-1).message.result.value, {
      sessionId: 's1',
      answer: { answers: [{ id: 'q1', selected: ['A'], custom: '别的' }] },
    })
  } finally {
    await kit.close()
  }
})

/**
 * Open a WebSocket by hand — the package has no dependencies, so the handshake
 * and the one frame this test reads are done with a raw socket.
 */
function openSocket(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.subarray(0, end).toString('utf8')
      socket.removeAllListeners('data')
      resolve({ socket, head, rest: buffer.subarray(end + 4) })
    })
    // A dropped upgrade answers nothing at all, so close is a real outcome here
    // rather than a stuck promise.
    socket.on('close', () => reject(new Error('socket closed with no response')))
    socket.on('error', reject)
  })
}

/** Read one unfragmented server text frame out of a buffer, or null. */
function readTextFrame(buffer) {
  if (buffer.length < 2) return null
  let length = buffer[1] & 0x7f
  let at = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    at = 4
  }
  if (buffer.length - at < length) return null
  return { text: buffer.subarray(at, at + length).toString('utf8'), rest: buffer.subarray(at + length) }
}

test('the websocket carrier needs a token and then carries the same frames', async () => {
  const kit = await harness()
  try {
    const denied = await openSocket(kit.remotePort, `${ROUTE_PREFIX}/ws`)
    assert.match(denied.head, /^HTTP\/1\.1 401/, 'a handshake without a token is refused with HTTP, not upgraded')
    assert.match(denied.head, /content-type: application\/json/)
    denied.socket.destroy()

    const { accessToken } = await pairOnce(kit)
    const opened = await openSocket(
      kit.remotePort,
      `${ROUTE_PREFIX}/ws?sessionId=s1`,
      { Authorization: `Bearer ${accessToken}` },
    )
    assert.match(opened.head, /^HTTP\/1\.1 101 Switching Protocols/)
    // The RFC's own example key/accept pair, so a wrong digest cannot pass.
    assert.match(opened.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)

    const frames = []
    let pending = opened.rest
    await new Promise((resolve, reject) => {
      const drain = () => {
        for (;;) {
          const frame = readTextFrame(pending)
          if (frame === null) break
          pending = frame.rest
          frames.push(JSON.parse(frame.text))
          if (frames.length >= 2) resolve()
        }
      }
      drain()
      opened.socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk])
        drain()
      })
      opened.socket.on('error', reject)
      kit.hub.publish({ type: 'message/delta', sessionId: 's1', messageId: '1:0', kind: 'text', text: '嗨' })
      setTimeout(() => reject(new Error(`only ${frames.length} frame(s) arrived`)), 4000)
    })

    assert.equal(frames[0].data.type, 'hello')
    assert.equal(frames[1].data.text, '嗨')
    // WebSocket has no `id:` field, so the resume point rides in the envelope.
    assert.ok(frames[1].eventId > 0)
    assert.equal(frames[1].event, 'frame')
    opened.socket.destroy()
  } finally {
    await kit.close()
  }
})

test('a browser-shaped handshake authenticates through the subprotocol', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    const carried = Buffer.from(accessToken, 'utf8').toString('base64url')
    const opened = await openSocket(kit.remotePort, `${ROUTE_PREFIX}/ws`, {
      'Sec-WebSocket-Protocol': `dshm-events, dshm-token.${carried}`,
    })
    assert.match(opened.head, /^HTTP\/1\.1 101/)
    assert.match(opened.head, /Sec-WebSocket-Protocol: dshm-events/, 'the token protocol must not be echoed back')
    opened.socket.destroy()
  } finally {
    await kit.close()
  }
})

test('the event stream delivers published frames and replays the ring', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    kit.hub.publish({ type: 'session/status', sessionId: 's1', running: true })

    const res = await fetch(`${kit.remote}/events?sessionId=s1`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const until = async (predicate) => {
      while (!predicate(text)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    }

    // hello first, then the ring replay of the frame published before the open.
    await until((seen) => seen.includes('"type":"hello"') && seen.includes('"running":true'))
    assert.match(text, /^retry: 3000/)
    assert.match(text, /id: \d+\nevent: frame\ndata: /)

    kit.hub.publish({ type: 'session/status', sessionId: 'other', running: false })
    kit.hub.publish({ type: 'message/delta', sessionId: 's1', messageId: '1:0', kind: 'text', text: 'hi' })
    await until((seen) => seen.includes('"text":"hi"'))
    assert.ok(!text.includes('"sessionId":"other"'), 'a per-session stream must not carry another session')

    await reader.cancel()
  } finally {
    await kit.close()
  }
})

test('an upgrade on any other path is dropped', async () => {
  const kit = await harness()
  try {
    const { accessToken } = await pairOnce(kit)
    const opened = await openSocket(kit.remotePort, '/somewhere-else', {
      Authorization: `Bearer ${accessToken}`,
    }).catch(() => null)
    assert.equal(opened, null, 'the socket is destroyed without any response')
  } finally {
    await kit.close()
  }
})
