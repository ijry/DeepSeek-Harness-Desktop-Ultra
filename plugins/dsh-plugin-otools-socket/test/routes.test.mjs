import assert from 'node:assert/strict'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'

import { DeviceAuth, PairingOffers } from '../src/host/auth.js'
import { parseUploadBody } from '../src/host/http.js'
import { createExternalRoutes } from '../src/host/routes.js'
import { startListener } from '../src/host/carriers/listener.js'
import { TicketStore } from '../src/host/tickets.js'

class MemoryStore {
  constructor() { this.devices = []; this.queue = Promise.resolve() }
  snapshot() { return { targetId: 'target-a', displayName: 'DSH', devices: structuredClone(this.devices) } }
  transact(mutator) {
    const run = async () => { const draft = { devices: structuredClone(this.devices) }; const value = mutator(draft); this.devices = draft.devices; return value }
    const result = this.queue.then(run, run); this.queue = result.then(() => undefined, () => undefined); return result
  }
}

function call(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function fixture() {
  let now = 1000
  const store = new MemoryStore()
  const offers = new PairingOffers(() => now)
  const auth = new DeviceAuth({ store, offers, now: () => now })
  const tickets = new TicketStore({ now: () => now, isDeviceActive: id => store.devices.some(row => row.deviceId === id && row.revokedAt === null) })
  const routes = createExternalRoutes({ auth, offers, store, tickets, protocolVersion: 2 })
  const listener = await startListener({ host: '127.0.0.1', port: 0, handler: routes.handler, upgradeHandler: routes.upgradeHandler })
  return { ...listener, auth, offers, store, tickets, routes, now: value => { now = value } }
}

test('multipart upload extracts exactly one file across split boundaries', async () => {
  const boundary = '----dsh-boundary'
  const bytes = Buffer.from([
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="file"; filename="note.txt"\r\n',
    'Content-Type: text/plain\r\n\r\n',
    'hello world\r\n',
    `--${boundary}--\r\n`,
  ].join(''))
  const chunks = []
  for (let index = 0; index < bytes.length; index += 3) chunks.push(bytes.subarray(index, index + 3))
  const parsed = await parseUploadBody(
    Readable.from(chunks),
    `multipart/form-data; boundary=${boundary}`,
    32,
  )
  const file = []
  for await (const chunk of parsed.body) file.push(chunk)
  assert.equal(Buffer.concat(file).toString(), 'hello world')
  assert.equal(parsed.contentType, 'text/plain')
})

test('multipart upload rejects duplicate file and non-file form parts', async () => {
  const boundary = 'dsh'
  const duplicate = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\na\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b"\r\n\r\nb\r\n`,
    `--${boundary}--\r\n`,
  ].join(''))
  await assert.rejects(
    parseUploadBody(Readable.from([duplicate]), `multipart/form-data; boundary=${boundary}`, 32),
    error => error?.code === 'invalid_input',
  )
  const field = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nx\r\n--${boundary}--\r\n`,
  )
  await assert.rejects(
    parseUploadBody(Readable.from([field]), `multipart/form-data; boundary=${boundary}`, 32),
    error => error?.code === 'invalid_input',
  )
})

test('hello is minimal and unauthenticated; catalog is absent', async () => {
  const app = await fixture()
  const response = await call(app.port, '/dsh-plugin-otools-socket/hello')
  assert.equal(response.status, 200)
  const json = JSON.parse(response.body)
  assert.deepEqual(Object.keys(json).sort(), ['ok', 'value'])
  assert.equal(json.value.protocolVersion, 2)
  assert.equal(json.value.requiresPairing, true)
  assert.equal(JSON.stringify(json).includes('catalog'), false)
  await app.close()
})

test('pair is one-use; refresh rotates token and query tokens are rejected', async () => {
  const app = await fixture()
  const offer = app.offers.current()
  const body = JSON.stringify({ code: offer.code, secret: offer.secret, name: 'phone' })
  const paired = await call(app.port, '/dsh-plugin-otools-socket/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal(paired.status, 200)
  const credentials = JSON.parse(paired.body).value
  assert.match(credentials.accessToken, /^dshs_/)
  const reused = await call(app.port, '/dsh-plugin-otools-socket/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal(reused.status, 401)
  const query = await call(app.port, `/dsh-plugin-otools-socket/hello?token=${credentials.accessToken}`)
  assert.equal(query.status, 400)
  const refreshed = await call(app.port, '/dsh-plugin-otools-socket/session/refresh', {
    method: 'POST', headers: { authorization: `Bearer ${credentials.refreshToken}` },
  })
  assert.equal(refreshed.status, 200)
  assert.notEqual(JSON.parse(refreshed.body).value.refreshToken, credentials.refreshToken)
  await app.close()
})

test('stateful transfer path rejects missing or wrong bearer token', async () => {
  const app = await fixture()
  const issued = app.tickets.issue({
    deviceId: 'phone-a', sourceId: 'example.files', kind: 'download',
    contentType: 'text/plain', maxBytes: 10, idleTimeoutMs: 1000, maxDurationMs: 1000,
    onStart() {},
  })
  const missing = await call(app.port, `/dsh-plugin-otools-socket/transfer/${issued.ticket}`)
  assert.equal(missing.status, 401)
  const wrong = await call(app.port, `/dsh-plugin-otools-socket/transfer/${issued.ticket}`, {
    headers: { authorization: 'Bearer wrong' },
  })
  assert.equal(wrong.status, 401)
  await app.close()
})

test('CORS echoes only configured HTTPS origins and never credentials cookies', async () => {
  const app = await fixture()
  const routes = createExternalRoutes({
    auth: app.auth, offers: app.offers, store: app.store, tickets: app.tickets,
    protocolVersion: 2, allowedOrigins: ['https://mcode.example'],
  })
  await app.close()
  const listener = await startListener({ host: '127.0.0.1', port: 0, handler: routes.handler, upgradeHandler: routes.upgradeHandler })
  const allowed = await call(listener.port, '/dsh-plugin-otools-socket/hello', { headers: { origin: 'https://mcode.example' } })
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://mcode.example')
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined)
  const denied = await call(listener.port, '/dsh-plugin-otools-socket/hello', { headers: { origin: 'https://evil.example' } })
  assert.equal(denied.headers['access-control-allow-origin'], undefined)
  await listener.close()
})
