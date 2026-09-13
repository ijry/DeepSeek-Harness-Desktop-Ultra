import { URL } from 'node:url'

import { acceptKey, encodeFrame, readFrame } from '../socket.js'

const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

function protocols(req) {
  return String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean)
}

function tokenFromProtocols(values) {
  const row = values.find(value => value.startsWith('dsh-token.'))
  if (!row) return ''
  try { return Buffer.from(row.slice('dsh-token.'.length), 'base64url').toString('utf8') }
  catch { return '' }
}

function reject(socket, status = '401 Unauthorized') {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function upgrade(req, socket, selected) {
  const key = req.headers['sec-websocket-key']
  if (req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') return false
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`, `Sec-WebSocket-Protocol: ${selected}`, '', '',
  ].join('\r\n'))
  socket.setNoDelay?.(true)
  return true
}

function binarySocket(raw, head, active) {
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
  let closed = false
  const binaryListeners = new Set()
  const textListeners = new Set()
  const closeListeners = new Set()
  const close = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    try { raw.write(encodeFrame(OP.close, payload)) } catch { /* gone */ }
    raw.destroy()
    active.done?.()
    for (const listener of closeListeners) listener(code, reason)
  }
  const api = {
    sendBinary: bytes => raw.write(encodeFrame(OP.binary, Buffer.from(bytes))),
    sendText: text => raw.write(encodeFrame(OP.text, Buffer.from(text, 'utf8'))),
    close,
    onBinary: listener => { binaryListeners.add(listener); return () => binaryListeners.delete(listener) },
    onText: listener => { textListeners.add(listener); return () => textListeners.delete(listener) },
    onClose: listener => { closeListeners.add(listener); return () => closeListeners.delete(listener) },
  }
  const consume = () => {
    while (!closed) {
      const frame = readFrame(buffer, active.maxBytes)
      if (!frame) return
      if (frame.overflow || !frame.masked || frame.rsv !== 0 || !frame.fin) return close(1002, 'protocol')
      buffer = buffer.subarray(frame.size)
      if (frame.opcode === OP.binary) {
        active.touch?.()
        for (const listener of binaryListeners) listener(frame.payload)
      } else if (frame.opcode === OP.text) {
        active.touch?.()
        for (const listener of textListeners) listener(frame.payload.toString('utf8'))
      }
      else if (frame.opcode === OP.ping) raw.write(encodeFrame(OP.pong, frame.payload))
      else if (frame.opcode === OP.close) return close()
      else if (frame.opcode !== OP.pong) return close(1002, 'opcode')
    }
  }
  raw.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); consume() })
  raw.on('error', () => close(1011, 'error'))
  raw.on('close', () => close())
  active.signal?.addEventListener('abort', () => close(1008, 'revoked'), { once: true })
  consume()
  return api
}

export function createExternalUpgrade(options) {
  return (req, socket, head) => {
    const values = protocols(req)
    const token = tokenFromProtocols(values)
    const device = options.auth.authenticateAccess(token)
    if (!device) return reject(socket)
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname.endsWith('/socket')) {
      if (!values.includes('dsh-bus-v2') || !upgrade(req, socket, 'dsh-bus-v2')) return reject(socket, '400 Bad Request')
      options.onControl({ req, socket, head, device, protocol: 'dsh-bus-v2' })
      return
    }
    const match = pathname.match(/\/transfer\/([A-Za-z0-9_-]+)$/)
    if (!match || !values.includes('dsh-transfer-v1')) return reject(socket, '400 Bad Request')
    let active
    try { active = options.consumeTransfer(match[1], { deviceId: device.deviceId, kind: 'binary-ws' }) }
    catch { return reject(socket, '403 Forbidden') }
    if (!upgrade(req, socket, 'dsh-transfer-v1')) return reject(socket, '400 Bad Request')
    const api = binarySocket(socket, head, active)
    Promise.resolve(active.onStart({
      kind: 'binary-ws', deviceId: active.deviceId, sourceId: active.sourceId,
      contentType: active.contentType, maxBytes: active.maxBytes, signal: active.signal,
      request: req, socket: api,
    })).catch(() => api.close(1011, 'handler'))
  }
}
