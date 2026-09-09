import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createExternalUpgrade } from '../src/host/carriers/websocket.js'

class FakeSocket {
  constructor() { this.writes = []; this.destroyed = false; this.handlers = new Map() }
  write(value) { this.writes.push(value); return true }
  destroy() { this.destroyed = true; this.handlers.get('close')?.() }
  setNoDelay() {}
  on(name, handler) { this.handlers.set(name, handler); return this }
}

const req = (protocols, url = '/dsh-plugin-otools-socket/socket') => ({
  url,
  headers: {
    host: '127.0.0.1:8790',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
    'sec-websocket-protocol': protocols,
  },
})

test('control upgrade requires bus and encoded token protocols and never echoes secret token protocol', () => {
  const attached = []
  const upgrade = createExternalUpgrade({
    auth: { authenticateAccess: token => token === 'access' ? { deviceId: 'phone-a' } : undefined },
    onControl: context => attached.push(context),
    consumeTransfer() { throw new Error('unused') },
  })
  const missing = new FakeSocket()
  upgrade(req('dsh-bus-v2'), missing, Buffer.alloc(0))
  assert.equal(missing.destroyed, true)

  const socket = new FakeSocket()
  const encoded = Buffer.from('access').toString('base64url')
  upgrade(req(`dsh-bus-v2, dsh-token.${encoded}`), socket, Buffer.alloc(0))
  assert.match(String(socket.writes[0]), /^HTTP\/1\.1 101/)
  assert.match(String(socket.writes[0]), /Sec-WebSocket-Protocol: dsh-bus-v2/)
  assert.doesNotMatch(String(socket.writes[0]), /dsh-token/)
  assert.equal(attached[0].device.deviceId, 'phone-a')
})

test('binary transfer upgrade validates protocol, token, kind and device', () => {
  const started = []
  const encoded = Buffer.from('access').toString('base64url')
  const upgrade = createExternalUpgrade({
    auth: { authenticateAccess: token => token === 'access' ? { deviceId: 'phone-a' } : undefined },
    onControl() {},
    consumeTransfer(ticket, identity) {
      assert.equal(ticket, 'ticket-a')
      assert.deepEqual(identity, { deviceId: 'phone-a', kind: 'binary-ws' })
      return { onStart: context => started.push(context), maxBytes: 1024, signal: new AbortController().signal }
    },
  })
  const socket = new FakeSocket()
  upgrade(req(`dsh-transfer-v1, dsh-token.${encoded}`, '/dsh-plugin-otools-socket/transfer/ticket-a'), socket, Buffer.alloc(0))
  assert.match(String(socket.writes[0]), /Sec-WebSocket-Protocol: dsh-transfer-v1/)
  assert.equal(started.length, 1)
  assert.equal(started[0].kind, 'binary-ws')
})
