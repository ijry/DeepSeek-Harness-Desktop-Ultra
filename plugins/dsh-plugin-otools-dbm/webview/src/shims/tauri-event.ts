/**
 * Tauri's event bus, re-implemented on one shared `EventSource`.
 *
 * The panel listens for exactly three things — `task-updated`,
 * `dbm-backup-plans-updated` and `dbm-dictionary-export-progress` — so a single
 * SSE stream with a `name` field is enough. One stream is shared by every
 * listener and opened lazily on the first `listen()`; it reconnects on its own
 * (that is EventSource's job) and closes again when the last listener unsubscribes.
 */
import { hostUrl } from './tauri-core'

export type UnlistenFn = () => void

export interface Event<T> {
  event: string
  id: number
  payload: T
}

type Handler = (event: Event<unknown>) => void

const handlers = new Map<string, Set<Handler>>()
let stream: EventSource | null = null
let nextId = 1

const dispatch = (name: string, payload: unknown) => {
  const bucket = handlers.get(name)
  if (!bucket || bucket.size === 0) {
    return
  }
  const event: Event<unknown> = { event: name, id: nextId++, payload }
  for (const handler of Array.from(bucket)) {
    try {
      handler(event)
    } catch (error) {
      console.error('[otools-dbm] event handler failed', error)
    }
  }
}

const openStream = () => {
  if (stream) {
    return
  }
  stream = new EventSource(hostUrl('/events'))
  stream.onmessage = (message) => {
    if (!message.data) {
      return
    }
    let frame: { name?: unknown; payload?: unknown }
    try {
      frame = JSON.parse(message.data)
    } catch {
      return
    }
    if (typeof frame.name === 'string' && frame.name) {
      dispatch(frame.name, frame.payload)
    }
  }
  stream.onerror = () => {
    // EventSource retries by itself; a transient host restart must not surface
    // as a panel error, so this is intentionally silent.
  }
}

const closeStreamIfIdle = () => {
  if (!stream) {
    return
  }
  for (const bucket of handlers.values()) {
    if (bucket.size > 0) {
      return
    }
  }
  stream.close()
  stream = null
}

/** Subscribe to one host event. Resolves with the unsubscribe function. */
export const listen = async <T = unknown>(
  name: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> => {
  const key = String(name || '').trim()
  if (!key) {
    return () => {}
  }

  const bucket = handlers.get(key) ?? new Set<Handler>()
  handlers.set(key, bucket)
  const wrapped = handler as Handler
  bucket.add(wrapped)
  openStream()

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    bucket.delete(wrapped)
    closeStreamIfIdle()
  }
}

/** Tauri parity for the few call sites that emit locally. */
export const emit = async (name: string, payload?: unknown): Promise<void> => {
  dispatch(name, payload)
}
