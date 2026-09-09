import assert from 'node:assert/strict'
import test from 'node:test'
import { openPanelChannel } from '../src/client/panel-channel.js'

function clock() {
  const rows = new Map(); let next = 1
  return { rows, setTimeout(fn) { const id = next++; rows.set(id, fn); return id }, clearTimeout(id) { rows.delete(id) }, run() { const values = [...rows.values()]; rows.clear(); values.forEach(fn => fn()) } }
}

function context(service) {
  let cleanup
  return { ctx: { inject(_names, callback) { if (service !== undefined) cleanup = callback({ otoolsSocket: service }); return () => cleanup?.() } }, dispose: () => cleanup?.() }
}

test('late shared takeover ignores fallback close and unload starts one replacement', () => {
  const time = clock(); const events = []; let handlers; let lateClose; let fallbackId = 0
  const service = { subscribe(_source, next) { handlers = next; return () => events.push('unsubscribe') } }
  const seat = context(service)
  const stop = openPanelChannel(seat.ctx, {
    source: 'panel.source', clock: time,
    startFallback: () => {
      const id = ++fallbackId
      events.push('fallback:' + id)
      lateClose = () => events.push('fallback-close:' + id)
      return () => events.push('fallback-stop:' + id)
    },
    onOpen: data => events.push('ready:' + data.revision),
    onFrame: name => events.push(name), onClose: () => events.push('close'),
  })
  time.run()
  handlers.onReady({ revision: 1 })
  lateClose()
  time.run()
  handlers.onEvent('change', {})
  seat.dispose()
  lateClose()
  time.run()
  stop(); stop()
  assert.deepEqual(events, [
    'fallback:1', 'fallback-stop:1', 'ready:1', 'fallback-close:1', 'change',
    'unsubscribe', 'close', 'fallback:2', 'fallback-close:2', 'fallback-stop:2',
  ])
})

test('dispose before grace starts no fallback', () => {
  const time = clock(); let starts = 0
  const stop = openPanelChannel({}, { source: 'panel.source', clock: time, startFallback: () => { starts += 1 } })
  stop(); time.run()
  assert.equal(starts, 0)
})
