/**
 * 事件 socket 测试：手写的 RFC 6455 三块（握手响应、服务端帧编码、客户端帧解析），
 * 以及推送中枢本身——用一个假的已升级 socket 驱动握手、基线帧、广播、客户端关闭
 * 和同源闸门，最后再用 Node 自带的 WebSocket 客户端做一次真实握手。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { acceptKey, createEventSocket, createSocketHub, encodeFrame, readFrame } from '../src/host/socket.js'
// socket.js 是跨插件共享的副本，不再自带路径常量；路由归调用方所有。从 routes.js 取，
// 这样这条测试同时盯住「插件真的把自己的那条路径接上了」。
import { SOCKET_PATH } from '../src/host/routes.js'

/** Minimal stand-in for the upgraded Duplex: records writes, replays events. */
class FakeSocket {
  constructor() {
    this.writes = []
    this.destroyed = false
    this.handlers = new Map()
  }

  write(chunk) {
    this.writes.push(chunk)
    return true
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
  }

  setNoDelay() {}

  on(event, handler) {
    this.handlers.set(event, handler)
    return this
  }

  emit(event, ...args) {
    this.handlers.get(event)?.(...args)
  }

  /** The frames written so far, decoded as `{ event, data }` payloads. */
  frames() {
    return this.writes
      .filter((chunk) => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 0x1)
      .map((chunk) => JSON.parse(readFrame(chunk).payload.toString('utf8')))
  }
}

/** One client text frame, masked the way a browser masks it. */
function maskedFrame(text, opcode = 0x1, options = {}) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  if (payload.length >= 126) throw new Error('test helper only supports short payloads')
  const fin = options.fin === false ? 0 : 0x80
  const maskedBit = options.masked === false ? 0 : 0x80
  const header = Buffer.from([fin | opcode, maskedBit | payload.length])
  return options.masked === false ? Buffer.concat([header, payload]) : Buffer.concat([header, mask, masked])
}

function fakeCtx() {
  const registered = {}
  return {
    registered,
    webServer: {
      registerUpgrade({ path, handler }) {
        registered.path = path
        registered.handler = handler
        registered.disposed = false
        return () => { registered.disposed = true }
      },
    },
  }
}

const upgradeRequest = (headers = {}) => ({
  headers: {
    host: '127.0.0.1:1234',
    origin: 'http://127.0.0.1:1234',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
    ...headers,
  },
})

test('acceptKey：按 RFC 6455 的例子算握手响应', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('encodeFrame：三种长度形式的头部各自正确，且服务端帧不带掩码', () => {
  const short = encodeFrame(0x1, Buffer.alloc(5))
  assert.equal(short[0], 0x81)
  assert.equal(short[1], 5)
  assert.equal(short.length, 7)

  const medium = encodeFrame(0x1, Buffer.alloc(300))
  assert.equal(medium[1], 126)
  assert.equal(medium.readUInt16BE(2), 300)
  assert.equal(medium.length, 304)

  const long = encodeFrame(0x1, Buffer.alloc(70_000))
  assert.equal(long[1], 127)
  assert.equal(long.readBigUInt64BE(2), 70_000n)
  assert.equal(long.length, 70_010)

  // No mask bit on the length byte: masking is the client's job only.
  assert.equal(short[1] & 0x80, 0)
})

test('readFrame：帧不全时返回 undefined，齐了就解掩码', () => {
  const frame = maskedFrame('ping-me')
  assert.equal(readFrame(frame.subarray(0, 4)), undefined)
  const read = readFrame(frame)
  assert.equal(read.opcode, 0x1)
  assert.equal(read.payload.toString('utf8'), 'ping-me')
  assert.equal(read.size, frame.length)
})

test('readFrame：超过上限的帧报 overflow，而不是照着分配内存', () => {
  const header = Buffer.alloc(10)
  header[0] = 0x82
  header[1] = 127
  header.writeBigUInt64BE(1_000_000n, 2)
  assert.deepEqual(readFrame(header), { overflow: true })
})

test('没有 registerUpgrade 的 DSH 构建：返回 undefined，调用方留在 SSE 上', () => {
  const socket = createEventSocket({ webServer: {} }, { path: SOCKET_PATH, hello: () => ({}) })
  assert.equal(socket, undefined)
})

test('缺 path 直接抛：共享模块不替调用方猜路由', () => {
  const ctx = fakeCtx()
  assert.throws(() => createEventSocket(ctx, { hello: () => ({}) }), TypeError)
  assert.equal(ctx.registered.path, undefined)
})

test('握手成功后先发 hello，broadcast 落到每个客户端', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({ revision: 7 }) })
  assert.equal(ctx.registered.path, '/dsh-plugin-canvas/socket')

  const first = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), first, Buffer.alloc(0))
  const handshake = String(first.writes[0])
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/)
  assert.deepEqual(first.frames(), [{ event: 'hello', data: { revision: 7 } }])

  const second = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), second, Buffer.alloc(0))
  hub.broadcast('change', { kind: 'deleted', id: 9, revision: 8 })
  assert.equal(hub.size(), 2)
  assert.deepEqual(first.frames().at(-1), { event: 'change', data: { kind: 'deleted', id: 9, revision: 8 } })
  assert.deepEqual(second.frames().at(-1), { event: 'change', data: { kind: 'deleted', id: 9, revision: 8 } })

  hub.dispose()
  assert.equal(hub.size(), 0)
  assert.equal(ctx.registered.disposed, true)
  assert.equal(first.destroyed, true)
})

test('客户端 close 帧：回一个 close 并把它从广播里摘掉', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({}) })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, Buffer.alloc(0))
  socket.emit('data', maskedFrame('', 0x8))
  assert.equal(hub.size(), 0)
  assert.equal(socket.destroyed, true)
  const last = socket.writes.at(-1)
  assert.equal(Buffer.isBuffer(last) && (last[0] & 0x0f), 0x8)
})

test('客户端 ping 帧：原样 pong 回去，连接留着', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({}) })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, Buffer.alloc(0))
  socket.emit('data', maskedFrame('hi', 0x9))
  const last = socket.writes.at(-1)
  assert.equal(last[0] & 0x0f, 0xa)
  assert.equal(readFrame(last).payload.toString('utf8'), 'hi')
  assert.equal(hub.size(), 1)
  hub.dispose()
})

test('跨源 upgrade 被拒：WebSocket 不受 CORS 约束，所以这道闸必须自己写', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({}) })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest({ origin: 'http://evil.example' }), socket, Buffer.alloc(0))
  assert.match(String(socket.writes[0]), /^HTTP\/1\.1 400 Bad Request/)
  assert.equal(socket.destroyed, true)
  assert.equal(hub.size(), 0)
  hub.dispose()
})

test('缺 Sec-WebSocket-Key 的 upgrade 也被拒', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({}) })
  const socket = new FakeSocket()
  const request = upgradeRequest()
  delete request.headers['sec-websocket-key']
  ctx.registered.handler(request, socket, Buffer.alloc(0))
  assert.match(String(socket.writes[0]), /^HTTP\/1\.1 400 Bad Request/)
  assert.equal(hub.size(), 0)
  hub.dispose()
})

test('head 里预读到的帧不会被丢掉', () => {
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({}) })
  const socket = new FakeSocket()
  // A client that closes immediately: its close frame arrives in `head`.
  ctx.registered.handler(upgradeRequest(), socket, maskedFrame('', 0x8))
  assert.equal(hub.size(), 0)
  assert.equal(socket.destroyed, true)
})

test('raw hub：upgrade head 已含 close 时不调用 onOpen', () => {
  const ctx = fakeCtx()
  let opened = 0
  const hub = createSocketHub(ctx, {
    path: '/test/socket',
    authorize: () => true,
    onOpen: () => { opened += 1 },
    onMessage() {},
    onClose() {},
    serialize: JSON.stringify,
    maxBacklogBytes: 1024 * 1024,
  })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, maskedFrame('', 0x8))
  assert.equal(opened, 0)
  assert.equal(hub.size(), 0)
  assert.equal(socket.destroyed, true)
  hub.dispose()
})

test('raw hub：分片文本中间允许 ping，只在完整后交给 onMessage', () => {
  const ctx = fakeCtx()
  const messages = []
  const hub = createSocketHub(ctx, {
    path: '/test/socket', authorize: () => true,
    onOpen() {}, onMessage: (_client, value) => messages.push(value), onClose() {},
    serialize: JSON.stringify, maxBacklogBytes: 1024 * 1024,
  })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, Buffer.alloc(0))
  socket.emit('data', maskedFrame('{"ok":', 0x1, { fin: false }))
  socket.emit('data', maskedFrame('hi', 0x9))
  assert.deepEqual(messages, [])
  socket.emit('data', maskedFrame('true}', 0x0))
  assert.deepEqual(messages, [{ ok: true }])
  assert.equal(socket.writes.some(chunk => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 0xa), true)
  hub.dispose()
})

test('raw hub：拒绝未掩码文本和无起始帧的 continuation', () => {
  for (const bad of [
    maskedFrame('{}', 0x1, { masked: false }),
    maskedFrame('{}', 0x0),
  ]) {
    const ctx = fakeCtx()
    let messages = 0
    const hub = createSocketHub(ctx, {
      path: '/test/socket', authorize: () => true,
      onOpen() {}, onMessage: () => { messages += 1 }, onClose() {},
      serialize: JSON.stringify, maxBacklogBytes: 1024 * 1024,
    })
    const socket = new FakeSocket()
    ctx.registered.handler(upgradeRequest(), socket, bad)
    assert.equal(messages, 0)
    assert.equal(hub.size(), 0)
    const close = socket.writes.find(chunk => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 0x8)
    assert.equal(readFrame(close).payload.readUInt16BE(0), 1002)
    hub.dispose()
  }
})

test('raw hub：非法 UTF-8 以 1007 关闭', () => {
  const ctx = fakeCtx()
  const hub = createSocketHub(ctx, {
    path: '/test/socket', authorize: () => true,
    onOpen() {}, onMessage() {}, onClose() {},
    serialize: JSON.stringify, maxBacklogBytes: 1024 * 1024,
  })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, maskedFrame(Buffer.from([0xc3, 0x28])))
  const close = socket.writes.find(chunk => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 0x8)
  assert.equal(readFrame(close).payload.readUInt16BE(0), 1007)
  assert.equal(hub.size(), 0)
  hub.dispose()
})

test('raw hub：authorization 可以拒绝握手', () => {
  const ctx = fakeCtx()
  const hub = createSocketHub(ctx, {
    path: '/test/socket', authorize: () => false,
    onOpen() {}, onMessage() {}, onClose() {},
    serialize: JSON.stringify, maxBacklogBytes: 1024 * 1024,
  })
  const socket = new FakeSocket()
  ctx.registered.handler(upgradeRequest(), socket, Buffer.alloc(0))
  assert.match(String(socket.writes[0]), /^HTTP\/1\.1 401 Unauthorized/)
  assert.equal(socket.destroyed, true)
  hub.dispose()
})

test('真实握手：Node 自带的 WebSocket 客户端能连上并收到 hello 与 change', async () => {
  // The fakes above pin the framing byte by byte; this one pins it against a
  // real RFC 6455 implementation, which is the part hand-rolled framing gets
  // wrong. Node's built-in WebSocket plays the browser.
  const ctx = fakeCtx()
  const hub = createEventSocket(ctx, { path: SOCKET_PATH, hello: () => ({ revision: 3 }) })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => ctx.registered.handler(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const client = new WebSocket(`ws://127.0.0.1:${port}${ctx.registered.path}`)
  const frames = []
  const received = new Promise((resolve) => {
    client.addEventListener('message', (event) => {
      frames.push(JSON.parse(event.data))
      if (frames.length === 2) resolve()
    })
  })
  await new Promise((resolve, reject) => {
    client.addEventListener('open', resolve, { once: true })
    client.addEventListener('error', () => reject(new Error('握手失败')), { once: true })
  })
  hub.broadcast('change', { kind: 'upsert', revision: 4 })
  await received
  assert.deepEqual(frames, [
    { event: 'hello', data: { revision: 3 } },
    { event: 'change', data: { kind: 'upsert', revision: 4 } },
  ])

  // The client's close frame must unwind the hub, not leave a zombie subscriber.
  const closed = new Promise((resolve) => client.addEventListener('close', resolve, { once: true }))
  client.close()
  await closed
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(hub.size(), 0)

  hub.dispose()
  await new Promise((resolve) => server.close(resolve))
})
