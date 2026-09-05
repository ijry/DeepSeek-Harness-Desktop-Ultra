/**
 * Route-layer tests: drive the real handlers with a real ledger file and a real
 * engine (whose child process is the only stub). What is exercised end to end is
 * the part that only breaks once the pieces are wired together — the `{ ok }`
 * envelope and its status map, the schedule preview, the version guard on the wire,
 * and the SSE handshake.
 *
 * @module dsh-plugin-automation/test/routes
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { AutomationEngine } from '../src/host/engine.js'
import { registerAutomationRoutes, ROUTE_PREFIX, SSE_PATH } from '../src/host/routes.js'
import { AutomationStore } from '../src/host/store.js'

const NOW = new Date(2026, 8, 7, 9, 0, 0).getTime()

/** Collect a response without a socket. */
function fakeRes() {
  const out = { status: 0, headers: {}, body: '', chunks: [], ended: false }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    write(chunk) {
      out.chunks.push(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) out.body += chunk
      out.ended = true
    },
    on() {},
  }
}

/** A request the handler can consume, body included. */
function fakeReq(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:41234' }
  req.on = req.on.bind(req)
  return req
}

const DRAFT = {
  name: '每日测试',
  prompt: '跑测试',
  schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
  action: { kind: 'headless' },
  workspaceId: 'ws-1',
}

/** Mount the routes against stubs and hand back a `call()` returning the envelope. */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-routes-'))
  const clock = { now: NOW }
  const now = () => clock.now
  const store = new AutomationStore({ file: join(dir, 'ledger.json'), now })
  const children = []
  const engine = new AutomationEngine({
    store,
    workspaces: { get: () => ({ id: 'ws-1', path: dir, title: 'proj' }), list: () => [] },
    taskboardBase: () => undefined,
    now,
    cliEntry: { command: 'node', prefix: ['fake'] },
    startRun: async () => {
      let resolve
      const done = new Promise((inner) => {
        resolve = inner
      })
      const handle = { pid: 1, kill: () => resolve({ status: 'canceled', output: '' }), done, settle: resolve }
      children.push(handle)
      return handle
    },
  })
  const routes = new Map()
  const ctx = {
    webServer: {
      port: 41234,
      host: '127.0.0.1',
      register({ kind, path, handler }) {
        routes.set(kind + ' ' + path, handler)
        return () => routes.delete(kind + ' ' + path)
      },
    },
  }
  const dispose = registerAutomationRoutes(ctx, {
    store,
    engine,
    workspaces: { list: () => [{ id: 'ws-1', path: dir, title: 'proj' }], get: () => ({ id: 'ws-1', path: dir, title: 'proj' }) },
    taskboardBase: { observe() {}, resolve: () => undefined },
    now,
  })

  const handler = routes.get('prefix ' + ROUTE_PREFIX)
  const call = async (method, path, body) => {
    const res = fakeRes()
    await handler(fakeReq(method, path, body), res)
    return { status: res.out.status, payload: res.out.body === '' ? undefined : JSON.parse(res.out.body) }
  }
  return { dir, clock, store, engine, children, routes, call, dispose }
}

test('创建、读取、改名、删除走完一圈', async () => {
  const { call, dispose } = await harness()
  const created = await call('POST', ROUTE_PREFIX + '/automations', { draft: DRAFT })
  assert.equal(created.status, 201)
  assert.equal(created.payload.ok, true)
  const id = created.payload.value.id
  // The derived description travels with the record so the browser needs no cron.
  assert.equal(created.payload.value.scheduleText, '每个工作日 09:00')
  assert.equal(created.payload.value.version, 1)

  const state = await call('GET', ROUTE_PREFIX + '/state')
  assert.equal(state.payload.value.automations.length, 1)
  assert.equal(state.payload.value.workspaces.length, 1)
  assert.equal(state.payload.value.engine.cliAvailable, true)

  const renamed = await call('POST', ROUTE_PREFIX + '/automations/update',
    { id, draft: { ...DRAFT, name: '改过名' }, ifVersion: 1 })
  assert.equal(renamed.payload.value.name, '改过名')

  const stale = await call('POST', ROUTE_PREFIX + '/automations/update',
    { id, draft: { ...DRAFT, name: '又改' }, ifVersion: 1 })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.error.code, 'conflict')

  const removed = await call('POST', ROUTE_PREFIX + '/automations/delete', { id })
  assert.equal(removed.payload.ok, true)
  assert.equal((await call('GET', ROUTE_PREFIX + '/state')).payload.value.automations.length, 0)
  dispose()
})

test('校验失败是 400，找不到是 404，坏 JSON 也有信封', async () => {
  const { call, routes, dispose } = await harness()
  const bad = await call('POST', ROUTE_PREFIX + '/automations', { draft: { ...DRAFT, prompt: '  ' } })
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error.message, /提示词/)

  const badCron = await call('POST', ROUTE_PREFIX + '/automations',
    { draft: { ...DRAFT, schedule: { kind: 'cron', cron: '99 * * * *' } } })
  assert.equal(badCron.status, 400)

  const missing = await call('POST', ROUTE_PREFIX + '/automations/run', { id: 'auto_nope' })
  assert.equal(missing.status, 404)

  const res = fakeRes()
  const req = Readable.from([Buffer.from('{not json', 'utf8')])
  req.method = 'POST'
  req.url = ROUTE_PREFIX + '/automations'
  req.headers = {}
  await routes.get('prefix ' + ROUTE_PREFIX)(req, res)
  assert.equal(res.out.status, 400)
  assert.equal(JSON.parse(res.out.body).ok, false)
  dispose()
})

test('/preview 由宿主回答计划的含义与接下来的时间点', async () => {
  const { call, dispose } = await harness()
  const cron = await call('GET', ROUTE_PREFIX + '/preview?kind=cron&cron=0+9+*+*+1-5&count=2')
  assert.equal(cron.payload.value.valid, true)
  assert.equal(cron.payload.value.text, '每个工作日 09:00')
  assert.equal(cron.payload.value.next.length, 2)

  const bad = await call('GET', ROUTE_PREFIX + '/preview?kind=cron&cron=nope')
  assert.equal(bad.payload.value.valid, false)
  assert.ok(bad.payload.value.message.length > 0)

  const never = await call('GET', ROUTE_PREFIX + '/preview?kind=cron&cron=0+0+30+2+*')
  assert.equal(never.payload.value.valid, true)
  assert.deepEqual(never.payload.value.next, [])
  assert.match(never.payload.value.message, /不会触发/)

  const interval = await call('GET', ROUTE_PREFIX + '/preview?kind=interval&intervalMinutes=45&count=2')
  assert.equal(interval.payload.value.text, '每 45 分钟')
  assert.equal(interval.payload.value.next.length, 2)

  const manual = await call('GET', ROUTE_PREFIX + '/preview?kind=manual')
  assert.equal(manual.payload.value.text, '仅手动触发')
  dispose()
})

test('立即运行、历史与终止都从路由层可用', async () => {
  const { call, children, dispose } = await harness()
  const id = (await call('POST', ROUTE_PREFIX + '/automations', { draft: DRAFT })).payload.value.id
  const started = await call('POST', ROUTE_PREFIX + '/automations/run', { id })
  assert.equal(started.status, 201)
  assert.equal(started.payload.value.status, 'running')
  const runId = started.payload.value.id

  const runs = await call('GET', ROUTE_PREFIX + '/runs?automationId=' + id)
  assert.equal(runs.payload.value.length, 1)

  const detail = await call('GET', ROUTE_PREFIX + '/run?id=' + runId)
  assert.equal(detail.payload.value.id, runId)

  children[0].settle({ status: 'succeeded', exitCode: 0, output: '好了' })
  const cancelled = await call('POST', ROUTE_PREFIX + '/runs/cancel', { runId })
  // The run had already settled, so cancel is reported as the no-op it was.
  assert.equal(cancelled.payload.ok, true)
  dispose()
})

test('SSE 先发一帧 hello，带当前 revision', async () => {
  const { call, routes, dispose } = await harness()
  await call('POST', ROUTE_PREFIX + '/automations', { draft: DRAFT })
  const res = fakeRes()
  routes.get('exact ' + SSE_PATH)(fakeReq('GET', SSE_PATH), res)
  assert.equal(res.out.status, 200)
  assert.match(res.out.headers['content-type'], /event-stream/)
  assert.match(res.out.chunks.join(''), /event: hello/)
  assert.match(res.out.chunks.join(''), /"revision":1/)
  dispose()
})

test('未知路径 404，非 GET/POST 是 405', async () => {
  const { call, dispose } = await harness()
  assert.equal((await call('GET', ROUTE_PREFIX + '/nope')).status, 404)
  assert.equal((await call('DELETE', ROUTE_PREFIX + '/state')).status, 405)
  dispose()
})
