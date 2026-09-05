/**
 * One subscription to dsh, many phone streams.
 *
 * dsh's `events.mux()` and `events.host()` are single-consumer async iterables,
 * and opening a fresh pair per connected phone would multiply the host's work by
 * the number of devices and give each one a different replay baseline. So the hub
 * consumes each stream exactly once, projects the frames, stamps them with a
 * monotonic bridge event id, and fans them out.
 *
 * The id is what makes a phone's reconnect cheap: a dropped Wi-Fi connection
 * comes back with `Last-Event-ID`, and anything still in the ring is replayed
 * rather than refetched. The ring is bounded, so a phone that was away too long
 * is told to reload history instead — the same posture dsh itself takes with its
 * own replay window.
 *
 * @module dsh-plugin-mobile-bridge/host/stream
 */
import { FRAME } from '../shared/protocol.js'
import { framesOf, hostFramesOf } from './projection.js'

/** Frames kept for reconnect replay. Roughly a minute of a chatty turn. */
export const RING_SIZE = 600

/** How long to wait before reopening a dsh stream that ended unexpectedly. */
const REOPEN_DELAY_MS = 1000

export class EventHub {
  constructor(options) {
    this.bridge = options.bridge
    this.ringSize = options.ringSize ?? RING_SIZE
    this.ring = []
    this.nextId = 1
    this.subscribers = new Set()
    this.controller = null
    this.memo = { open: new Set() }
    this.running = false
  }

  /** The id of the newest frame, or 0 when nothing has been emitted yet. */
  get lastEventId() {
    return this.nextId - 1
  }

  /** The oldest id still replayable, or 0 when the ring is empty. */
  get windowStart() {
    return this.ring.length === 0 ? 0 : this.ring[0].id
  }

  /** Begin consuming both dsh streams. Idempotent. */
  start() {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    void this.#pump(() => this.bridge.muxStream(this.controller.signal), (item) => framesOf(item, this.memo))
    void this.#pump(() => this.bridge.hostStream(this.controller.signal), (item) => hostFramesOf(item))
  }

  /** Stop consuming and close every subscriber. */
  stop() {
    this.running = false
    this.controller?.abort()
    this.controller = null
    for (const subscriber of [...this.subscribers]) subscriber.writer.close()
    this.subscribers.clear()
  }

  /**
   * Consume one dsh stream until aborted, reopening after an unexpected end.
   *
   * A stream that ends without an abort is not a normal condition — dsh keeps it
   * open for the process lifetime — so the hub reopens rather than going quiet:
   * a silently dead stream looks exactly like an idle agent from the phone, which
   * is the worst possible failure mode for a remote control.
   */
  async #pump(open, project) {
    while (this.running) {
      try {
        for await (const item of open()) {
          if (!this.running) return
          for (const frame of project(item)) this.publish(frame)
        }
      } catch (error) {
        if (!this.running) return
        this.publish({
          type: FRAME.error,
          code: 'dsh_error',
          message: `dsh 事件流中断：${error?.message ?? error}`,
        })
      }
      if (!this.running) return
      await new Promise((resolve) => setTimeout(resolve, REOPEN_DELAY_MS))
    }
  }

  /**
   * Stamp one projected frame and hand it to every interested subscriber.
   * @param {object} frame - a bridge frame.
   * @returns {number} the assigned event id.
   */
  publish(frame) {
    const id = this.nextId
    this.nextId += 1
    this.ring.push({ id, frame })
    if (this.ring.length > this.ringSize) this.ring.shift()

    for (const subscriber of [...this.subscribers]) {
      if (subscriber.writer.closed()) {
        this.subscribers.delete(subscriber)
        continue
      }
      if (!wants(subscriber.sessionId, frame)) continue
      subscriber.writer.send(id, 'frame', frame)
    }
    return id
  }

  /**
   * Attach one SSE writer.
   *
   * @param {object} writer - an {@link import('./http.js').sse} writer.
   * @param {{ sessionId?: string|null, lastEventId?: number }} options - filter
   *   and resume point. A `lastEventId` older than the ring reports a gap so the
   *   client refetches history rather than rendering a hole.
   * @returns {() => void} the disposer.
   */
  subscribe(writer, options = {}) {
    const sessionId = options.sessionId ?? null
    const from = Number(options.lastEventId ?? 0)
    const subscriber = { writer, sessionId }
    this.subscribers.add(subscriber)

    const missed = from > 0 && this.windowStart > 0 && from < this.windowStart - 1
    writer.send(this.lastEventId, 'frame', {
      type: FRAME.hello,
      protocolVersion: '1',
      lastEventId: this.lastEventId,
      windowStart: this.windowStart,
      replayed: missed ? 0 : this.ring.filter((row) => row.id > from).length,
      gap: missed,
    })

    if (!missed) {
      for (const row of this.ring) {
        if (row.id <= from) continue
        if (!wants(sessionId, row.frame)) continue
        writer.send(row.id, 'frame', row.frame)
      }
    }

    return () => this.subscribers.delete(subscriber)
  }
}

/**
 * Whether a per-session stream should carry this frame. A frame with no
 * `sessionId` is host-wide (a stream error) and always passes: suppressing it
 * would leave the phone waiting on a stream that is already broken.
 */
function wants(sessionId, frame) {
  if (sessionId === null) return true
  if (frame.sessionId === undefined) return true
  return frame.sessionId === sessionId
}
