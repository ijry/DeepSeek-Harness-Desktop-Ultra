/**
 * Shared RFC 6455 transport used by the panel-event wrapper and the bidirectional
 * bus. This canonical file is copied into each published consumer by
 * `npm run sync:shared`; keep it package-independent.
 *
 * @module dsh-plugin-shared/host/socket
 */
import { createHash } from 'node:crypto'

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PING_MS = 20_000
const DEFAULT_MAX_MESSAGE = 64 * 1024
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

export function acceptKey(key) {
  return createHash('sha1').update(`${key}${HANDSHAKE_GUID}`).digest('base64')
}

export function encodeFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = body.length
  const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10)
  header[0] = (fin ? 0x80 : 0) | opcode
  if (length < 126) header[1] = length
  else if (length < 65_536) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, body])
}

/** Compatibility parser used by existing byte-level tests and server frames. */
export function readFrame(buffer, maxBytes = DEFAULT_MAX_MESSAGE) {
  if (buffer.length < 2) return undefined
  const fin = (buffer[0] & 0x80) !== 0
  const rsv = buffer[0] & 0x70
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const wide = buffer.readBigUInt64BE(2)
    if (wide > BigInt(maxBytes)) return { overflow: true }
    length = Number(wide)
    offset = 10
  }
  if (length > maxBytes) return { overflow: true }
  const maskAt = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return undefined
  let payload = buffer.subarray(offset, offset + length)
  if (masked) {
    const mask = buffer.subarray(maskAt, maskAt + 4)
    const plain = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i += 1) plain[i] = payload[i] ^ mask[i % 4]
    payload = plain
  }
  return { fin, rsv, opcode, masked, payload, size: offset + length }
}

function validKey(key) {
  if (typeof key !== 'string') return false
  try {
    return Buffer.from(key, 'base64').length === 16
  } catch {
    return false
  }
}

function writeHttpError(socket, status) {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}

function closePayload(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

export function createSocketHub(ctx, options) {
  const {
    path,
    authorize = () => true,
    onOpen = () => {},
    onMessage = () => {},
    onClose = () => {},
    serialize = JSON.stringify,
    maxBacklogBytes = 1024 * 1024,
    maxMessageBytes = DEFAULT_MAX_MESSAGE,
  } = options ?? {}
  if (typeof path !== 'string' || path === '') throw new TypeError('createSocketHub requires path')
  if (typeof ctx.webServer?.registerUpgrade !== 'function') return undefined

  const clients = new Set()
  let ping
  let disposed = false

  const stopPing = () => {
    if (clients.size === 0 && ping !== undefined) {
      clearInterval(ping)
      ping = undefined
    }
  }

  const drop = (client, code, reason) => {
    if (client.closed) return
    client.closed = true
    clients.delete(client)
    if (code !== undefined) {
      try { client.socket.write(encodeFrame(OP.close, closePayload(code, reason))) } catch { /* gone */ }
    }
    try { client.socket.destroy() } catch { /* gone */ }
    try { onClose(client, { code, reason }) } catch { /* plugin callback cannot retain socket */ }
    stopPing()
  }

  const send = (client, value) => {
    if (client?.closed || !clients.has(client)) return false
    const pending = (client.socket.writableLength ?? 0)
    if (pending > maxBacklogBytes) {
      drop(client, 1009, 'backlog')
      return false
    }
    let text
    try { text = serialize(value) } catch { return false }
    try {
      client.socket.write(encodeFrame(OP.text, Buffer.from(text, 'utf8')))
      return true
    } catch {
      drop(client)
      return false
    }
  }

  const consumeFrame = (client, frame) => {
    if (frame.rsv !== 0 || !frame.masked) return drop(client, 1002, 'protocol')
    const control = frame.opcode >= 0x8
    if (control && (!frame.fin || frame.payload.length > 125)) return drop(client, 1002, 'control')
    if (![OP.continuation, OP.text, OP.binary, OP.close, OP.ping, OP.pong].includes(frame.opcode)) {
      return drop(client, 1002, 'opcode')
    }
    if (frame.opcode === OP.close) return drop(client, 1000, 'closed')
    if (frame.opcode === OP.ping) {
      try { client.socket.write(encodeFrame(OP.pong, frame.payload)) } catch { drop(client) }
      return
    }
    if (frame.opcode === OP.pong) return
    if (frame.opcode === OP.binary) return drop(client, 1003, 'binary')

    if (frame.opcode === OP.text) {
      if (client.fragments !== null) return drop(client, 1002, 'fragment')
      client.fragments = [frame.payload]
      client.fragmentBytes = frame.payload.length
    } else {
      if (client.fragments === null) return drop(client, 1002, 'continuation')
      client.fragments.push(frame.payload)
      client.fragmentBytes += frame.payload.length
    }
    if (client.fragmentBytes > maxMessageBytes) return drop(client, 1009, 'message')
    if (!frame.fin) return

    const payload = Buffer.concat(client.fragments, client.fragmentBytes)
    client.fragments = null
    client.fragmentBytes = 0
    let text
    try { text = fatalUtf8.decode(payload) } catch { return drop(client, 1007, 'utf8') }
    let value
    try { value = JSON.parse(text) } catch { return drop(client, 1007, 'json') }
    try { onMessage(client, value) } catch { drop(client, 1011, 'handler') }
  }

  const consume = (client) => {
    while (!client.closed) {
      const frame = readFrame(client.buffer, maxMessageBytes)
      if (frame === undefined) return
      if (frame.overflow === true) return drop(client, 1009, 'message')
      client.buffer = client.buffer.subarray(frame.size)
      consumeFrame(client, frame)
    }
  }

  const handler = (req, socket, head) => {
    if (disposed) {
      writeHttpError(socket, '503 Service Unavailable')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (req.headers['sec-websocket-version'] !== '13' || !validKey(key)) {
      writeHttpError(socket, '400 Bad Request')
      return
    }
    let authorization
    try { authorization = authorize(req) } catch { authorization = false }
    const accept = authorized => {
      if (authorized !== true) {
        const status = authorized?.status === '400 Bad Request' ? authorized.status : '401 Unauthorized'
        writeHttpError(socket, status)
        return
      }

      socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', '',
    ].join('\r\n'))
    socket.setNoDelay?.(true)
    const client = {
      socket,
      closed: false,
      buffer: head?.length ? Buffer.from(head) : Buffer.alloc(0),
      fragments: null,
      fragmentBytes: 0,
    }
    clients.add(client)
    socket.on('data', chunk => {
      if (client.closed) return
      client.buffer = Buffer.concat([client.buffer, chunk])
      consume(client)
    })
    socket.on('error', () => drop(client))
    socket.on('close', () => drop(client))
    consume(client)
    if (client.closed) return
    try { onOpen(client) } catch { drop(client, 1011, 'handler'); return }

      if (ping === undefined) {
        ping = setInterval(() => {
          for (const row of [...clients]) {
            try { row.socket.write(encodeFrame(OP.ping)) } catch { drop(row) }
          }
        }, PING_MS)
        ping.unref?.()
      }
    }
    if (authorization && typeof authorization.then === 'function') {
      authorization.then(accept, () => accept(false))
    } else {
      accept(authorization)
    }
  }

  const disposeRoute = ctx.webServer.registerUpgrade({ path, handler })
  return {
    broadcast(value, filter = () => true) {
      for (const client of [...clients]) if (filter(client)) send(client, value)
    },
    send,
    size: () => clients.size,
    dispose() {
      if (disposed) return
      disposed = true
      if (ping !== undefined) clearInterval(ping)
      ping = undefined
      for (const client of [...clients]) drop(client, 1001, 'shutdown')
      disposeRoute?.()
    },
  }
}

export function createEventSocket(ctx, options) {
  const { path, hello } = options ?? {}
  if (typeof path !== 'string' || path === '') throw new TypeError('createEventSocket 需要一个 path')
  const hub = createSocketHub(ctx, {
    path,
    authorize(req) {
      const origin = req.headers.origin
      const sameOrigin = origin === undefined || origin === ''
        || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
      return sameOrigin ? true : { status: '400 Bad Request' }
    },
    onOpen(client) { hub.send(client, { event: 'hello', data: hello() }) },
    onMessage() {},
    onClose() {},
    serialize: JSON.stringify,
    maxBacklogBytes: 1024 * 1024,
  })
  if (hub === undefined) return undefined
  return {
    broadcast: (event, data) => hub.broadcast({ event, data }),
    size: hub.size,
    dispose: hub.dispose,
  }
}
