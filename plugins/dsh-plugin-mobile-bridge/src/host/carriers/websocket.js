/**
 * WebSocket downlink for the event stream, hand-rolled on RFC 6455.
 *
 * SSE would be enough for a browser, and it is what `/events` serves. The phone
 * is the reason this exists: MCode is a uni-app build, and `EventSource` is not
 * dependably available on its App runtime — the app's existing direct-host
 * transport is a WebSocket for exactly that reason. Adding a second carrier here
 * is cheaper than making the client maintain two stream implementations.
 *
 * Frames are written unmasked (server-to-client, as specified) and never
 * fragmented: a bridge frame is one JSON object, and text frames up to 2^64-1
 * bytes are legal, so there is nothing to gain from fragmenting. Inbound frames
 * are only inspected far enough to honour close and ping — this is a downlink,
 * so a client that sends application data is misusing it and is ignored.
 *
 * @module dsh-plugin-mobile-bridge/host/carriers/websocket
 */
import { createHash } from 'node:crypto'

/** The RFC 6455 handshake GUID. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Subprotocol prefix carrying a base64url bearer token, for clients that cannot set headers. */
export const TOKEN_PROTOCOL_PREFIX = 'dshm-token.'

/** The negotiated subprotocol name. */
export const STREAM_PROTOCOL = 'dshm-events'

/** `Sec-WebSocket-Accept` for one client key. */
export function accept(key) {
  return createHash('sha1')
    .update(String(key ?? '') + GUID, 'utf8')
    .digest('base64')
}

/**
 * The bearer token a handshake presents, in preference order: the `Authorization`
 * header (native clients), then the token subprotocol (browsers, which cannot set
 * headers on a WebSocket), then the query string.
 * @param {import('node:http').IncomingMessage} req - the upgrade request.
 * @returns {string} the token, or `''`.
 */
export function handshakeToken(req) {
  const header = String(req.headers?.authorization ?? '')
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()

  const offered = String(req.headers?.['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
  const carried = offered.find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX))
  if (carried !== undefined) {
    try {
      return Buffer.from(carried.slice(TOKEN_PROTOCOL_PREFIX.length), 'base64url').toString('utf8')
    } catch {
      return ''
    }
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  return String(url.searchParams.get('token') ?? '')
}

/** Encode one server-to-client text frame. */
export function textFrame(text) {
  const body = Buffer.from(text, 'utf8')
  let header
  if (body.length < 126) {
    header = Buffer.from([0x81, body.length])
  } else if (body.length < 0x10000) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    // 64-bit length; the high word is always zero for anything this bridge sends.
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(body.length, 6)
  }
  return Buffer.concat([header, body])
}

/** Encode a close frame with a status code. */
export function closeFrame(code = 1000) {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(code, 0)
  return Buffer.concat([Buffer.from([0x88, 2]), body])
}

/**
 * Read the opcodes out of a client buffer, dropping payloads.
 *
 * Only the control opcodes matter to a downlink. The payload is skipped rather
 * than unmasked because nothing here consumes it, and unmasking bytes we then
 * discard would be work done purely to be thrown away.
 *
 * @param {Buffer} buffer - accumulated bytes.
 * @returns {{ opcodes: number[], rest: Buffer }} the complete frames' opcodes
 *   and the trailing partial frame.
 */
export function readOpcodes(buffer) {
  const opcodes = []
  let at = 0
  for (;;) {
    if (buffer.length - at < 2) break
    const opcode = buffer[at] & 0x0f
    const masked = (buffer[at + 1] & 0x80) !== 0
    let length = buffer[at + 1] & 0x7f
    let cursor = at + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      // A client sending this bridge more than 4 GiB is not a case worth carrying.
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    if (masked) cursor += 4
    if (buffer.length - cursor < length) break
    opcodes.push(opcode)
    at = cursor + length
  }
  return { opcodes, rest: buffer.subarray(at) }
}

/**
 * Complete one upgrade into a writer shaped like the SSE writer, so the event hub
 * cannot tell the two carriers apart.
 *
 * @param {import('node:http').IncomingMessage} req - the upgrade request.
 * @param {import('node:stream').Duplex} socket - the raw socket.
 * @param {number} [heartbeatMs] - ping interval; NAT and tunnels drop quiet sockets.
 * @returns {{ send: Function, comment: Function, close: Function, closed: () => boolean }} the writer.
 */
export function upgrade(req, socket, heartbeatMs = 20000) {
  const offered = String(req.headers?.['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
  const negotiated = offered.includes(STREAM_PROTOCOL) ? STREAM_PROTOCOL : null

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept(req.headers?.['sec-websocket-key'])}`,
      ...(negotiated === null ? [] : [`Sec-WebSocket-Protocol: ${negotiated}`]),
      '',
      '',
    ].join('\r\n'),
  )
  socket.setNoDelay(true)

  let open = true
  let pending = Buffer.alloc(0)

  const stop = () => {
    if (!open) return
    open = false
    clearInterval(timer)
    socket.destroy()
  }

  const timer = setInterval(() => {
    // An empty ping frame; a client that never answers is dropped by the socket
    // layer, which is the outcome we want anyway.
    if (open) socket.write(Buffer.from([0x89, 0]))
  }, heartbeatMs)

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { opcodes, rest } = readOpcodes(pending)
    pending = rest
    for (const opcode of opcodes) {
      if (opcode === 0x8) {
        socket.write(closeFrame(1000))
        stop()
        return
      }
      if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0]))
    }
  })
  socket.on('error', stop)
  socket.on('close', () => {
    open = false
    clearInterval(timer)
  })

  return {
    /**
     * One event. The id rides inside the JSON rather than in a frame header —
     * WebSocket has no equivalent of SSE's `id:` field, so the client reads
     * `eventId` from the envelope to build its resume point.
     */
    send(id, event, data) {
      if (!open) return false
      return socket.write(textFrame(JSON.stringify({ eventId: id, event, data })))
    },
    comment() {
      /* comments are an SSE concept; the ping frame is this carrier's keepalive */
    },
    close() {
      if (open) socket.write(closeFrame(1000))
      stop()
    },
    closed() {
      return !open
    },
  }
}

