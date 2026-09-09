window.__ModuleLoader__.load({
  id: 'dsh-plugin-otools-socket',
  factory: (require) => {
    var module = { exports: {} };
const BUS_VERSION = 2
const OPEN = 1
const DEFAULT_RECONNECT_MS = 2000

function defaultClock() {
  return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => Date.now() }
}

function eventData(event) {
  if (typeof event?.data === 'string') return event.data
  if (event?.data instanceof ArrayBuffer) return new TextDecoder().decode(event.data)
  return undefined
}

function createBrowserBusClient(options = {}) {
  const socketFactory = options.socketFactory ?? (url => new WebSocket(url))
  const clock = options.clock ?? defaultClock()
  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS
  const subscriptions = new Map()
  let socket
  let reconnectTimer
  let disposed = false
  let generation = 0

  function notifyUnavailable() {
    for (const row of subscriptions.values()) {
      row.ready = false
      for (const handler of row.handlers) handler.onUnavailable?.()
    }
  }

  function send(frame) {
    if (socket?.readyState !== OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  function scheduleReconnect() {
    if (disposed || subscriptions.size === 0 || reconnectTimer !== undefined) return
    reconnectTimer = clock.setTimeout(() => { reconnectTimer = undefined; connect() }, reconnectMs)
  }

  function connect() {
    if (disposed || subscriptions.size === 0 || socket !== undefined) return
    const mine = ++generation
    let opened
    try { opened = socketFactory(options.url) } catch { scheduleReconnect(); return }
    socket = opened
    opened.addEventListener('open', () => {
      if (disposed || socket !== opened || generation !== mine) return
      for (const source of subscriptions.keys()) send({ v: BUS_VERSION, kind: 'subscribe', source })
    })
    opened.addEventListener('message', event => {
      if (disposed || socket !== opened || generation !== mine) return
      let frame
      try { frame = JSON.parse(eventData(event)) } catch { return }
      if (frame?.v !== BUS_VERSION || typeof frame.source !== 'string') return
      const row = subscriptions.get(frame.source)
      if (row === undefined) return
      if (frame.kind === 'event' && frame.name === '$snapshot') {
        row.ready = true
        row.snapshot = frame.data
        for (const handler of row.handlers) handler.onReady?.(frame.data)
      } else if (frame.kind === 'event' && row.ready) {
        for (const handler of row.handlers) handler.onEvent?.(frame.name, frame.data)
      } else if (frame.kind === 'overflow') {
        row.ready = false
        for (const handler of row.handlers) handler.onUnavailable?.()
        send({ v: BUS_VERSION, kind: 'unsubscribe', source: frame.source })
        send({ v: BUS_VERSION, kind: 'subscribe', source: frame.source })
      }
    })
    const close = () => {
      if (socket !== opened || generation !== mine) return
      socket = undefined
      notifyUnavailable()
      scheduleReconnect()
    }
    opened.addEventListener('close', close)
    opened.addEventListener('error', () => { try { opened.close() } catch { close() } })
  }

  function subscribe(source, handlers = {}) {
    if (disposed) throw new Error('browser bus client is disposed')
    let row = subscriptions.get(source)
    if (row === undefined) {
      row = { handlers: new Set(), ready: false, snapshot: undefined }
      subscriptions.set(source, row)
    }
    row.handlers.add(handlers)
    if (row.ready) handlers.onReady?.(row.snapshot)
    if (subscriptions.size === 1) connect()
    else send({ v: BUS_VERSION, kind: 'subscribe', source })
    let active = true
    return () => {
      if (!active) return
      active = false
      row.handlers.delete(handlers)
      if (row.handlers.size > 0) return
      subscriptions.delete(source)
      send({ v: BUS_VERSION, kind: 'unsubscribe', source })
      if (subscriptions.size > 0) return
      if (reconnectTimer !== undefined) clock.clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      const current = socket
      socket = undefined
      generation += 1
      try { current?.close() } catch { /* gone */ }
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (reconnectTimer !== undefined) clock.clearTimeout(reconnectTimer)
    subscriptions.clear()
    const current = socket
    socket = undefined
    generation += 1
    try { current?.close() } catch { /* gone */ }
  }

  return { subscribe, dispose }
}


const name = 'dsh-plugin-otools-socket/client'
const inject = []

function apply(ctx) {
  const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
  const client = createBrowserBusClient({ url: scheme + window.location.host + '/dsh-plugin-otools-socket/socket' })
  const remove = ctx.provide('otoolsSocket', client)
  const dispose = () => { remove?.(); client.dispose() }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-plugin-otools-socket: browser bus')
  else window.addEventListener('beforeunload', dispose, { once: true })
  return dispose
}
    module.exports = { name, inject, apply };
    return module.exports;
  }
});
