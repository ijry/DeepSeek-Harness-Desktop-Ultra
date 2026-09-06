/**
 * The push socket every panel plugin's event stream rides on: the SSE frames on
 * a WebSocket instead.
 *
 * Why a second transport for the same frames: a browser gives one origin about
 * six concurrent HTTP/1.1 connections, and an EventSource holds one of them for
 * as long as the panel lives. The DSH GUI and every panel plugin share a single
 * origin (the `dsh web` port), so once the bundled plugins are all installed the
 * whole budget sits in persistent streams — and every later request on that
 * origin queues forever: no response, no `error` event, nothing to time out.
 * That is what makes the shell look frozen (`添加工作区` doing nothing is the
 * host's `POST /api/host.pickDirectory` never getting a connection). WebSockets
 * ride a separate pool (hundreds per host), so moving the stream here hands the
 * HTTP connection back. The SSE route stays as the fallback for a DSH build
 * whose webserver has no `registerUpgrade` hook.
 *
 * Framing is hand-rolled instead of pulling in `ws`, which is only reasonable
 * because this socket is push-only: server frames are written unmasked, and
 * client frames are read just far enough to honour close and ping. Nothing the
 * browser sends is treated as data, so the parser has no interesting states.
 *
 * ————————————————————————————————————————————————————————————————————————————
 * GENERATED FILE — do not edit in place.
 *
 * The canonical copy is `plugins/.shared/host/socket.js`; every plugin's
 * `src/host/socket.js` is a byte-identical copy of it, written by
 * `npm run sync:shared` at the repo root and pinned by
 * `scripts/shared-sources.test.mjs`. Edit the canonical copy, re-run the sync,
 * and rebuild the plugins' `lib/`.
 *
 * This module deliberately knows nothing about which plugin it serves: the
 * upgrade path is the caller's (`options.path`), which is also what lets a
 * future shared channel mount one socket for several plugins.
 * ————————————————————————————————————————————————————————————————————————————
 *
 * @module dsh-plugin-shared/host/socket
 */
import { createHash } from 'node:crypto'

/** RFC 6455's handshake GUID. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Keepalive cadence, mirroring the SSE heartbeat. */
const PING_MS = 20_000

/** Longest client frame buffered before the socket is dropped (no payload is read). */
const MAX_CLIENT_FRAME = 64 * 1024

/** Opcodes this module uses. */
const OP = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa }

/** The `Sec-WebSocket-Accept` value for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${HANDSHAKE_GUID}`).digest('base64')
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length
  const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (length < 126) header[1] = length
  else if (length < 65_536) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Read one client frame.
 * @returns undefined while the buffer holds no complete frame, `{ overflow: true }`
 *   for a frame past {@link MAX_CLIENT_FRAME}, else `{ opcode, payload, size }`.
 */
export function readFrame(buffer) {
  if (buffer.length < 2) return undefined
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
    if (wide > BigInt(MAX_CLIENT_FRAME)) return { overflow: true }
    length = Number(wide)
    offset = 10
  }
  if (length > MAX_CLIENT_FRAME) return { overflow: true }
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
  return { opcode, payload, size: offset + length }
}

/**
 * Register the push socket. Returns `{ broadcast, size, dispose }`, or undefined
 * when this DSH build has no upgrade hook — the caller then stays on SSE alone.
 * @param ctx - plugin context (needs `ctx.webServer.registerUpgrade`).
 * @param options - { path, hello }: `path` is the upgrade route (required, the
 *   caller owns its own routing), `hello()` yields the baseline frame payload.
 */
export function createEventSocket(ctx, options) {
  const { path, hello } = options
  if (typeof path !== 'string' || path === '') throw new TypeError('createEventSocket 需要一个 path')
  if (typeof ctx.webServer?.registerUpgrade !== 'function') return undefined

  const clients = new Set()
  let ping

  const drop = (socket) => {
    if (!clients.delete(socket)) return
    try {
      socket.destroy()
    } catch { /* already gone */ }
    if (clients.size === 0 && ping !== undefined) {
      clearInterval(ping)
      ping = undefined
    }
  }

  const send = (socket, event, data) => {
    try {
      socket.write(encodeFrame(OP.text, Buffer.from(JSON.stringify({ event, data }), 'utf8')))
    } catch {
      drop(socket)
    }
  }

  const handler = (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    const origin = req.headers.origin
    // An upgrade is not a CORS request, so the same-origin rule the SSE route
    // gets for free has to be spelled out: without it any page could open this
    // stream and read whatever the plugin pushes.
    const sameOrigin = origin === undefined || origin === ''
      || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
    if (typeof key !== 'string' || key === '' || !sameOrigin) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '', '',
    ].join('\r\n'))
    socket.setNoDelay?.(true)
    clients.add(socket)

    let buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    const consume = () => {
      for (;;) {
        const frame = readFrame(buffer)
        if (frame === undefined) return
        if (frame.overflow === true) {
          drop(socket)
          return
        }
        buffer = buffer.subarray(frame.size)
        if (frame.opcode === OP.close) {
          try {
            socket.write(encodeFrame(OP.close))
          } catch { /* closing anyway */ }
          drop(socket)
          return
        }
        if (frame.opcode === OP.ping) {
          try {
            socket.write(encodeFrame(OP.pong, frame.payload))
          } catch {
            drop(socket)
            return
          }
        }
        // Text, binary and pong frames are ignored: this socket is push-only,
        // so nothing the browser sends can reach the plugin through it.
      }
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      consume()
    })
    socket.on('error', () => drop(socket))
    socket.on('close', () => drop(socket))
    consume()

    // Baseline frame, same contract as the SSE `hello`: the panel reconciles by
    // revision and refetches on a gap instead of replaying lost frames.
    send(socket, 'hello', hello())

    if (ping === undefined) {
      ping = setInterval(() => {
        for (const client of [...clients]) {
          try {
            client.write(encodeFrame(OP.ping))
          } catch {
            drop(client)
          }
        }
      }, PING_MS)
      ping.unref?.()
    }
  }

  const disposeRoute = ctx.webServer.registerUpgrade({ path, handler })
  return {
    broadcast: (event, data) => {
      for (const socket of [...clients]) send(socket, event, data)
    },
    size: () => clients.size,
    dispose: () => {
      if (ping !== undefined) {
        clearInterval(ping)
        ping = undefined
      }
      for (const socket of [...clients]) {
        try {
          socket.write(encodeFrame(OP.close))
        } catch { /* already gone */ }
        drop(socket)
      }
      disposeRoute?.()
    },
  }
}
