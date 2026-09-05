/**
 * The terminal WebSocket: keystrokes up, bytes down, on one socket.
 *
 * DSH's webserver exposes an upgrade hook (`registerUpgrade`, the same one
 * dsh-client-connection and the sibling mobile-bridge plugin use), so a terminal does
 * not have to send one HTTP request per keystroke. What rides here is ONLY terminal
 * traffic; every other event (ledger changes, transfer progress, tunnel state, AI
 * deltas) stays on the SSE stream, which keeps the two concerns separate and means a
 * DSH build without the hook loses nothing but latency — `api.js` falls back to
 * POST-per-batch and SSE output.
 *
 * Framing is `ws`'s job rather than hand-rolled RFC 6455: this package already has
 * runtime dependencies (ssh2, xterm), and a hand-written handshake is exactly the kind
 * of code that looks fine until a continuation frame arrives.
 *
 * @module dsh-plugin-otools-term/host/socket
 */
import { WebSocketServer } from 'ws'
import { decodeInput, normalizeId, normalizeSize } from '../shared/protocol.js'

/** Upgrade path (an exact route on the shared webserver). */
export const SOCKET_PATH = '/dsh-plugin-otools-term/socket'

/** Biggest client frame accepted (a paste, not a file). */
const MAX_FRAME_BYTES = 1024 * 1024

/**
 * Register the upgrade route. Returns a disposer, or undefined when this DSH build has
 * no upgrade hook (the caller then simply stays on the HTTP path).
 */
export function registerTerminalSocket(ctx, options) {
  const { engine } = options
  if (typeof ctx.webServer.registerUpgrade !== 'function') return undefined

  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  const handler = (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let clientId
    try {
      clientId = normalizeId(url.searchParams.get('clientId'), 'clientId')
    } catch {
      // No id, no subscription: refuse the upgrade rather than open a socket whose
      // frames could not be routed anywhere.
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    server.handleUpgrade(req, socket, head, (ws) => {
      const subscriber = engine.hub.addSocket(clientId, ws)
      ws.on('message', (raw, isBinary) => {
        if (isBinary === true) return
        let message
        try {
          message = JSON.parse(String(raw))
        } catch {
          return
        }
        handleMessage(engine, subscriber, clientId, message)
      })
      const drop = () => engine.hub.removeSocket(clientId)
      ws.on('close', drop)
      ws.on('error', drop)
      // A first frame the browser can wait for, so it knows the socket is live before
      // it stops using the HTTP path.
      subscriber.send('socket-ready', { clientId })
    })
  }

  const dispose = ctx.webServer.registerUpgrade({ path: SOCKET_PATH, handler })
  return () => {
    dispose?.()
    for (const client of server.clients) {
      try {
        client.close()
      } catch { /* already closing */ }
    }
    server.close()
  }
}

/**
 * One client frame. Deliberately only three kinds: everything that changes state on
 * the remote machine still goes through the validated POST routes, so this socket
 * cannot become a second, less-checked API.
 */
function handleMessage(engine, subscriber, clientId, message) {
  if (message === null || typeof message !== 'object') return
  try {
    if (message.kind === 'input') {
      engine.sessions.write(normalizeId(message.sessionId, 'sessionId'), decodeInput(message.data))
      return
    }
    if (message.kind === 'resize') {
      const size = normalizeSize(message)
      engine.sessions.resize(normalizeId(message.sessionId, 'sessionId'), size.cols, size.rows)
      return
    }
    if (message.kind === 'subscribe') {
      const ids = Array.isArray(message.sessionIds)
        ? message.sessionIds.slice(0, 64).map((id) => normalizeId(id, 'sessionId'))
        : []
      engine.hub.subscribe(clientId, ids)
      return
    }
    if (message.kind === 'ping') subscriber.send('pong', { at: Date.now() })
  } catch (error) {
    // A bad frame is reported on the socket and dropped; it must not close the
    // terminal the user is typing into.
    subscriber.send('socket-error', { code: error?.code ?? 'invalid_input', message: error?.message ?? String(error) })
  }
}
