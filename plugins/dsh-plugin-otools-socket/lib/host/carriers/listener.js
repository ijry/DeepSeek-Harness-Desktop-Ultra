import { createServer } from 'node:http'

export async function startListener(options) {
  const { handler, upgradeHandler, host = '0.0.0.0', port = 8790 } = options
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'internal error' } }))
      }
    })
  })
  if (typeof upgradeHandler === 'function') {
    server.on('upgrade', (req, socket, head) => {
      try { upgradeHandler(req, socket, head) } catch { socket.destroy() }
    })
  }
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000
  server.requestTimeout = 0

  const bound = await new Promise(resolve => {
    const onError = error => {
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
  if (!bound) return null
  const sockets = new Set()
  bound.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return {
    host,
    port: bound.address().port,
    close: () => new Promise(resolve => {
      bound.close(() => resolve())
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    }),
  }
}
