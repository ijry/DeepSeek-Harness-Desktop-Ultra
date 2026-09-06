/**
 * The panel's event carrier: one WebSocket, push-only, `{channel, payload}` frames.
 *
 * Not SSE, and that is the one architectural decision here that is about the browser rather
 * than about ai-switch. A browser allows about six concurrent HTTP/1.1 connections per
 * ORIGIN; every dsh panel plugin shares one origin (dsh's web server), and an SSE stream
 * holds one of those six for as long as the panel is open. With the nine plugins already in
 * this repo that budget is exactly spent, and the symptom is not an error — it is the whole
 * GUI going quiet, because a request that cannot get a connection queues forever. A
 * WebSocket is exempt from that pool.
 *
 * No panel code changes for this: the reference's front end already speaks WebSocket on
 * `/ws/events` with exactly these frames, and its transport builds that URL from its own
 * base, which the ported `transport/index.ts` points at this plugin's prefix.
 *
 * Terminal output rides the same socket. The reference has a second socket per session
 * (`/ws/terminal/:id`), but its own `XtermPane` reads output through `transport.subscribe`
 * on the events socket and sends keystrokes through the `write_terminal_input` command — the
 * per-session socket exists for its mobile client, which this plugin does not serve. One
 * socket also matters here: dsh's `registerUpgrade` takes an EXACT path, so a per-session
 * path would need a route per session.
 *
 * @module dsh-plugin-ai-switch/host/socket
 */
import { WebSocketServer } from 'ws'

import { PLUGIN_ID } from './sdk.js'

/** Upgrade path. The panel's transport derives this from its own base URL. */
export const SOCKET_PATH = `/${PLUGIN_ID}/ws/events`

/** Biggest client frame accepted. The socket is push-only, so this is generous already. */
const MAX_FRAME_BYTES = 1024 * 1024

/** Keep-alive so an idle proxy does not drop the socket. */
const PING_MS = 20_000

/**
 * The event hub: the socket set, the fan-out, and the SSE fallback's subscribers.
 *
 * Anything that wants to tell the panel something takes `hub.emit` and calls it; nothing
 * else needs to know which carrier a given panel is on.
 */
export class EventHub {
  constructor() {
    this.sockets = new Set()
    this.streams = new Set()
    this.ping = null
  }

  /** `(channel, payload) => void`, bound — safe to pass around. */
  get emit() {
    return (channel, payload) => {
      this.broadcast(channel, payload)
    }
  }

  /** Is anyone watching? The terminal refuses input when nobody is. */
  get connected() {
    return this.sockets.size > 0 || this.streams.size > 0
  }

  broadcast(channel, payload) {
    if (!this.connected) {
      return
    }
    const frame = JSON.stringify({ channel, payload })
    for (const socket of Array.from(this.sockets)) {
      try {
        socket.send(frame)
      } catch {
        this.sockets.delete(socket)
      }
    }
    for (const stream of Array.from(this.streams)) {
      try {
        stream.write(`data: ${frame}\n\n`)
      } catch {
        this.streams.delete(stream)
      }
    }
  }

  #startPing() {
    if (this.ping !== null) {
      return
    }
    this.ping = setInterval(() => {
      for (const socket of Array.from(this.sockets)) {
        try {
          socket.ping()
        } catch {
          this.sockets.delete(socket)
        }
      }
      for (const stream of Array.from(this.streams)) {
        try {
          stream.write(': ping\n\n')
        } catch {
          this.streams.delete(stream)
        }
      }
    }, PING_MS)
    this.ping.unref?.()
  }

  #stopPing() {
    if (this.ping !== null && !this.connected) {
      clearInterval(this.ping)
      this.ping = null
    }
  }

  addSocket(socket) {
    this.sockets.add(socket)
    this.#startPing()
    const drop = () => {
      this.sockets.delete(socket)
      this.#stopPing()
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  /** The SSE fallback, for a dsh build with no upgrade hook. */
  addStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    this.streams.add(res)
    this.#startPing()
    const drop = () => {
      this.streams.delete(res)
      this.#stopPing()
    }
    res.on('error', drop)
    req.on('close', drop)
  }

  close() {
    if (this.ping !== null) {
      clearInterval(this.ping)
      this.ping = null
    }
    for (const socket of this.sockets) {
      try {
        socket.close()
      } catch {
        /* already closing */
      }
    }
    for (const stream of this.streams) {
      try {
        stream.end()
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear()
    this.streams.clear()
  }
}

/**
 * Register the upgrade route.
 *
 * @returns a disposer, or undefined on a dsh build with no upgrade hook — the caller then
 *   leaves the SSE route as the only carrier, which works but costs one of those six
 *   connections for as long as the panel is open.
 */
export function registerSockets(ctx, { hub }) {
  if (typeof ctx.webServer.registerUpgrade !== 'function') {
    return undefined
  }
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  const dispose = ctx.webServer.registerUpgrade({
    path: SOCKET_PATH,
    handler: (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        hub.addSocket(ws)
        // Push-only: a frame the client sends is dropped rather than trusted as a second,
        // unvalidated API. Everything that changes state goes through the POST routes.
        ws.on('message', () => {})
      })
    },
  })

  return () => {
    dispose?.()
    for (const client of server.clients) {
      try {
        client.close()
      } catch {
        /* already closing */
      }
    }
    server.close()
  }
}
