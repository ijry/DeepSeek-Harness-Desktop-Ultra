/**
 * The event hub: one stream per open panel, carrying everything that changes on the
 * host — terminal bytes, connection status, transfer progress, tunnel state, AI job
 * deltas and ledger revisions.
 *
 * A panel gets ONE channel, and a WebSocket is the first choice; the SSE stream is
 * the fallback for a DSH build whose webserver has no upgrade hook. That preference
 * is not about latency, it is about a budget the whole page shares: a browser allows
 * about six concurrent HTTP/1.1 connections per ORIGIN, and every DSH panel plugin
 * lives on the same origin as the shell. Six panels each holding an SSE stream open
 * spends the entire budget, and from then on every other request on that origin —
 * the shell's own API calls, this plugin's `/vendor/xterm.js`, any fetch at all —
 * queues forever behind them: no response, no error, just silence. (That is exactly
 * how this plugin used to hang on "正在启动会话…": the xterm script tag never fired
 * `load` OR `error` because it never got a socket.) A WebSocket is exempt from that
 * pool, so a panel that streams over one costs the page nothing.
 *
 * Why one multiplexed stream instead of one per terminal, for the same reason: every
 * session rides the same channel, tagged with its `sessionId`, and the browser
 * subscribes to the ones it has on screen.
 *
 * Terminal output is base64 in a JSON frame. That costs a third more bytes than
 * raw, and it is still the right trade: SSE is a text protocol, terminal output is
 * arbitrary binary (a `cat` of a JPEG, a UTF-8 sequence split across two reads),
 * and re-encoding is the only way to hand the browser exactly the bytes the remote
 * sent. The alternative — decoding to a JS string on the host — corrupts any
 * multi-byte sequence that straddles a chunk boundary.
 *
 * @module dsh-plugin-otools-term/host/events
 */

/** Flush window for coalescing terminal output into one frame. */
export const OUTPUT_FLUSH_MS = 12

/** Flush immediately once this much output is pending for a session. */
export const OUTPUT_FLUSH_BYTES = 32 * 1024

/**
 * Per-client socket backlog we refuse to grow past. A terminal that prints faster
 * than the browser can read (`yes`, a build log) must not turn into unbounded host
 * memory: past this, output frames for that client are dropped and the client is
 * told, which is honest and recoverable — the alternative is an OOM.
 */
export const CLIENT_BACKLOG_LIMIT = 4 * 1024 * 1024

/** SSE keepalive comment interval (proxies drop an idle stream). */
export const KEEPALIVE_MS = 25_000

/** One connected browser panel, over an SSE response. */
class Subscriber {
  constructor(id, res) {
    this.id = id
    this.res = res
    this.kind = 'sse'
    this.sessions = new Set()
    this.dropped = 0
    this.closed = false
    // Set while the same panel also has a WebSocket: the socket carries every event
    // then, and this stream is a standby that stops receiving rather than delivering
    // each frame twice. `hello` is still answered — a panel booting over either
    // channel needs the snapshot.
    this.muted = false
  }

  /** Write one frame; returns false when the frame was dropped. */
  send(event, payload) {
    if (this.closed) return false
    const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    try {
      this.res.write(body)
      return true
    } catch {
      this.closed = true
      return false
    }
  }

  /** Whether this client's socket is too far behind to accept more output. */
  get congested() {
    const socket = this.res.socket
    const pending = (this.res.writableLength ?? 0) + (socket === null || socket === undefined ? 0 : socket.writableLength ?? 0)
    return pending > CLIENT_BACKLOG_LIMIT
  }
}

/**
 * One connected browser panel, over a WebSocket.
 *
 * The panel opens one whenever DSH's webserver offers an upgrade hook, and then
 * EVERYTHING travels here: terminal bytes both ways (a keystroke is a frame rather
 * than an HTTP request) and every control event the SSE stream would otherwise
 * carry. A socket costs the page none of its six HTTP/1.1 connections, which is why
 * it is the preferred channel rather than merely the faster one.
 */
class SocketSubscriber {
  constructor(id, socket) {
    this.id = id
    this.socket = socket
    this.kind = 'socket'
    this.sessions = new Set()
    this.dropped = 0
    this.closed = false
    this.muted = false
  }

  send(event, payload) {
    if (this.closed) return false
    try {
      this.socket.send(JSON.stringify({ event, data: payload }))
      return true
    } catch {
      this.closed = true
      return false
    }
  }

  get congested() {
    return (this.socket.bufferedAmount ?? 0) > CLIENT_BACKLOG_LIMIT
  }
}

/** The hub. One instance per plugin load. */
export class EventHub {
  constructor() {
    this.subscribers = new Map()
    this.sockets = new Map()
    this.pending = new Map()
    this.timer = null
    this.seq = 0
    this.keepalive = null
  }

  /** How many panels are listening. */
  get size() {
    return this.subscribers.size
  }

  /**
   * Attach one browser's WebSocket.
   *
   * The socket takes over the whole event feed for that panel (its SSE stream, if it
   * has one, goes quiet), and its session set starts from whatever the SSE stream
   * already had — a reload that opens both must not lose the subscription in between.
   */
  addSocket(clientId, socket) {
    const existing = this.sockets.get(clientId)
    if (existing !== undefined) existing.closed = true
    const subscriber = new SocketSubscriber(clientId, socket)
    const stream = this.subscribers.get(clientId)
    if (stream !== undefined) {
      subscriber.sessions = new Set(stream.sessions)
      stream.muted = true
    }
    this.sockets.set(clientId, subscriber)
    return subscriber
  }

  /** Detach one browser's WebSocket. */
  removeSocket(clientId) {
    const subscriber = this.sockets.get(clientId)
    if (subscriber === undefined) return
    subscriber.closed = true
    this.sockets.delete(clientId)
    const stream = this.subscribers.get(clientId)
    if (stream !== undefined) {
      // The SSE stream takes the feed back, so a dropped socket degrades instead of
      // going quiet.
      stream.muted = false
      stream.sessions = new Set(subscriber.sessions)
    }
  }

  /** Every sink for one client (the socket first). */
  sinksOf(clientId) {
    const rows = []
    const socket = this.sockets.get(clientId)
    if (socket !== undefined) rows.push(socket)
    const stream = this.subscribers.get(clientId)
    if (stream !== undefined) rows.push(stream)
    return rows
  }

  /**
   * Attach one browser. `hello` carries the current snapshot so a freshly opened
   * panel does not have to wait for the first change.
   */
  add(clientId, res, hello) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // A comment line flushes the response headers through any buffering layer
    // before the first real frame.
    res.write(': ok\n\n')
    const subscriber = new Subscriber(clientId, res)
    // A panel that already has a socket keeps using it; this stream is its standby.
    if (this.sockets.has(clientId)) subscriber.muted = true
    this.subscribers.set(clientId, subscriber)
    subscriber.send('hello', hello ?? {})
    if (this.keepalive === null) {
      this.keepalive = setInterval(() => this.ping(), KEEPALIVE_MS)
      if (typeof this.keepalive.unref === 'function') this.keepalive.unref()
    }
    const drop = () => this.remove(clientId)
    res.on('close', drop)
    res.on('error', drop)
    return subscriber
  }

  /** Detach one browser. */
  remove(clientId) {
    const subscriber = this.subscribers.get(clientId)
    if (subscriber === undefined) return
    subscriber.closed = true
    this.subscribers.delete(clientId)
    try {
      subscriber.res.end()
    } catch { /* already gone */ }
    if (this.subscribers.size === 0 && this.keepalive !== null) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }

  /** Replace one client's set of on-screen sessions. */
  subscribe(clientId, sessionIds) {
    const rows = this.sinksOf(clientId)
    for (const row of rows) row.sessions = new Set(sessionIds)
    return rows.length > 0
  }

  /** Whether ANY client currently shows this session (used by the idle sweeper). */
  hasViewer(sessionId) {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.sessions.has(sessionId)) return true
    }
    for (const subscriber of this.sockets.values()) {
      if (subscriber.sessions.has(sessionId)) return true
    }
    return false
  }

  /**
   * Every sink that should receive the next frame: each panel's socket, plus the SSE
   * streams of panels that have no socket. A snapshot, so dropping a dead sink while
   * writing cannot disturb the walk.
   */
  liveSinks() {
    const rows = [...this.sockets.values()]
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.muted) rows.push(subscriber)
    }
    return rows
  }

  /** Write one frame, dropping the sink it could not be written to. */
  deliver(subscriber, event, payload) {
    if (subscriber.send(event, payload)) return true
    if (subscriber.kind === 'socket') this.removeSocket(subscriber.id)
    else this.remove(subscriber.id)
    return false
  }

  /** Broadcast one non-output event to every panel. */
  broadcast(event, payload) {
    for (const subscriber of this.liveSinks()) this.deliver(subscriber, event, payload)
  }

  /** Send one event only to the panels showing `sessionId`. */
  toSession(sessionId, event, payload) {
    for (const subscriber of this.liveSinks()) {
      if (!subscriber.sessions.has(sessionId)) continue
      this.deliver(subscriber, event, payload)
    }
  }

  /**
   * Queue terminal output. Chunks are concatenated per session and flushed on a
   * short timer, so a program writing a byte at a time does not become one frame
   * per byte.
   *
   * `offset` is the session's byte count BEFORE this chunk. It rides along to the
   * browser so an attaching panel can splice a replay against the live stream
   * without duplicating or losing a byte: the replay says where it ends, and a frame
   * that overlaps it is trimmed rather than written twice.
   */
  output(sessionId, chunk, offset) {
    if (chunk === null || chunk === undefined || chunk.length === 0) return
    const queued = this.pending.get(sessionId)
    if (queued === undefined) {
      this.pending.set(sessionId, { offset: offset ?? 0, chunks: [chunk], bytes: chunk.length })
    } else {
      queued.chunks.push(chunk)
      queued.bytes += chunk.length
    }
    const total = this.pending.get(sessionId).bytes
    if (total >= OUTPUT_FLUSH_BYTES) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, OUTPUT_FLUSH_MS)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  /** Write every queued chunk out now. */
  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) return
    const batch = [...this.pending.entries()]
    this.pending.clear()
    for (const [sessionId, queued] of batch) {
      const data = Buffer.concat(queued.chunks).toString('base64')
      this.seq += 1
      const frame = { sessionId, seq: this.seq, offset: queued.offset, bytes: queued.bytes, data }
      for (const subscriber of this.liveSinks()) {
        if (!subscriber.sessions.has(sessionId)) continue
        if (subscriber.congested) {
          subscriber.dropped += queued.bytes
          // Tell it once per congestion episode rather than every frame.
          if (subscriber.dropped === queued.bytes) subscriber.send('overflow', { sessionId })
          continue
        }
        subscriber.dropped = 0
        this.deliver(subscriber, 'output', frame)
      }
    }
  }

  /** SSE comment keepalive. */
  ping() {
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.closed) {
        this.remove(subscriber.id)
        continue
      }
      try {
        subscriber.res.write(`: ping ${Date.now()}\n\n`)
      } catch {
        this.remove(subscriber.id)
      }
    }
  }

  /** Close every stream (plugin teardown). */
  dispose() {
    this.flush()
    for (const clientId of [...this.subscribers.keys()]) this.remove(clientId)
    for (const [clientId, subscriber] of [...this.sockets]) {
      try {
        subscriber.socket.close()
      } catch { /* already gone */ }
      this.sockets.delete(clientId)
    }
    if (this.keepalive !== null) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }
  }
}
