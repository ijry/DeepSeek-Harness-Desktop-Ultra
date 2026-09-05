/**
 * The LAN / tunnel carrier: the bridge's own `node:http` listener.
 *
 * Why a second server instead of asking dsh to bind all interfaces: dsh's web
 * server carries the whole GUI and the `/api` bridge behind a loopback fence, and
 * upstream is explicit that `dsh web --host 0.0.0.0` is unsupported until remote
 * access has an authentication layer. Flipping that bind would put an
 * unauthenticated agent UI with shell tools on the network. A separate listener
 * serving only the token-authenticated route table keeps dsh's posture exactly as
 * upstream shipped it, and makes the exposed surface something this package can
 * actually enumerate.
 *
 * A bind failure is reported and swallowed. The bridge is an optional
 * convenience; taking the harness down because port 8790 was busy would trade a
 * missing feature for a broken product.
 *
 * @module dsh-plugin-mobile-bridge/host/carriers/listener
 */
import { createServer } from 'node:http'

/**
 * Start the bridge's own listener.
 *
 * @param {object} options - `{ handler, host, port, onError }`.
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }|null>}
 *   the running listener, or null when it could not bind.
 */
export async function startListener(options) {
  const { handler, host = '0.0.0.0', port = 8790 } = options
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      // A handler that throws after headers are out can only be answered by
      // dropping the socket; before that, 500 with the reason.
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error?.message ?? error) } }))
      }
    })
  })

  if (typeof options.upgradeHandler === 'function') {
    server.on('upgrade', (req, socket, head) => {
      void Promise.resolve(options.upgradeHandler(req, socket, head)).catch(() => socket.destroy())
    })
  }

  // Long-poll style SSE streams must not be closed by the server's own idle
  // timer; the bridge's heartbeat is what proves a stream alive.
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000
  server.requestTimeout = 0

  const bound = await new Promise((resolve) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      options.onError?.(error)
      resolve(null)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  if (bound === null) return null

  // Track sockets so disposal actually returns: an open SSE stream would
  // otherwise keep `close()` pending until the phone gives up.
  const sockets = new Set()
  bound.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    host,
    port: bound.address().port,
    async close() {
      await new Promise((resolve) => {
        bound.close(() => resolve())
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    },
  }
}
