import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserBusClient } from '../src/client/bus-client.js'

class FakeSocket {
  constructor() { this.readyState = 0; this.listeners = new Map(); this.sent = []; this.closed = 0 }
  addEventListener(name, fn) { const rows = this.listeners.get(name) ?? []; rows.push(fn); this.listeners.set(name, rows) }
  emit(name, data) { for (const fn of this.listeners.get(name) ?? []) fn(data) }
  open() { this.readyState = 1; this.emit('open', {}) }
  message(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.closed += 1; this.readyState = 3; this.emit('close', {}) }
}

test('five sources share one lazy physical socket', () => {
  const sockets = []
  const client = createBrowserBusClient({ socketFactory: () => { const row = new FakeSocket(); sockets.push(row); return row }, url: 'ws://bus' })
  assert.equal(sockets.length, 0)
  const stops = ['a.a', 'b.b', 'c.c', 'd.d', 'e.e'].map(source => client.subscribe(source, {}))
  assert.equal(sockets.length, 1)
  stops.forEach(stop => stop())
  assert.equal(sockets[0].closed, 1)
})

test('snapshot gates events and reconnect resubscribes', () => {
  const sockets = []
  const timers = []
  const clock = { setTimeout(fn) { timers.push(fn); return timers.length - 1 }, clearTimeout() {}, now: () => 0 }
  const seen = []
  const client = createBrowserBusClient({ socketFactory: () => { const row = new FakeSocket(); sockets.push(row); return row }, url: 'ws://bus', clock })
  client.subscribe('panel.source', {
    onReady: data => seen.push(['ready', data.revision]),
    onEvent: (name, data) => seen.push([name, data.revision]),
    onUnavailable: () => seen.push(['down']),
  })
  sockets[0].open()
  sockets[0].message({ v: 2, kind: 'event', source: 'panel.source', name: 'change', data: { revision: 1 } })
  sockets[0].message({ v: 2, kind: 'event', source: 'panel.source', name: '$snapshot', data: { revision: 1 } })
  sockets[0].message({ v: 2, kind: 'event', source: 'panel.source', name: 'change', data: { revision: 2 } })
  assert.deepEqual(seen, [['ready', 1], ['change', 2]])
  sockets[0].close()
  assert.deepEqual(seen.at(-1), ['down'])
  timers.shift()()
  sockets[1].open()
  assert.equal(sockets[1].sent.some(frame => frame.kind === 'subscribe'), true)
  client.dispose()
})
