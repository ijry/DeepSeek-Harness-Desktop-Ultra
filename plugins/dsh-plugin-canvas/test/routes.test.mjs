/**
 * 路由层测试：用一个假的 webServer 把 handler 抓下来，再用假的 req/res 驱动它。
 *
 * 这一层没有领域逻辑，但它决定了浏览器看到什么——状态码、`{ok}` 封套、
 * 「响应带的是这次事件的 revision」以及 SSE 的基线帧。这些接错了，画布会以
 * 一种很难查的方式不同步。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/host/store.js'
import { registerCanvasRoutes } from '../src/host/routes.js'

/** 一个只记录的响应对象。 */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    write(chunk) {
      res.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      res.ended = true
    },
    on() {},
    get body() {
      return res.chunks.join('')
    },
    get json() {
      return JSON.parse(res.body)
    },
  }
  return res
}

/** 一个只读一次 body 的请求对象。 */
function fakeReq(method, url, body) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
    on() {},
  }
}

async function withRoutes(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-canvas-routes-'))
  const store = new CanvasStore({ file: join(dir, 'ledger.json') })
  const view = {
    async snapshot() {
      return { sessions: [{ id: 's1' }], workspaces: [{ id: 'w1' }], agents: [], at: 0 }
    },
    sessionIsLive: (id) => id === 's1',
    workspaceExists: (id) => id === 'w1',
    missingFrom: () => [],
  }
  const registered = []
  const ctx = {
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  const dispose = registerCanvasRoutes(ctx, { store, view, now: () => 0 })
  const handler = registered.find((r) => r.kind === 'prefix').handler
  const sse = registered.find((r) => r.kind === 'exact').handler
  /** 发一个请求，返回响应对象。 */
  const call = async (method, path, body) => {
    const res = fakeRes()
    await handler(fakeReq(method, `/dsh-plugin-canvas${path}`, body), res)
    return res
  }
  try {
    await run({ call, sse, store })
  } finally {
    dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test('GET /state 返回 { nodes, revision } 的封套', async () => {
  await withRoutes(async ({ call }) => {
    const res = await call('GET', '/state')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(res.json, { ok: true, value: { nodes: [], revision: 0 } })
  })
})

test('POST /nodes 建卡：201，响应带这次事件的 revision', async () => {
  await withRoutes(async ({ call }) => {
    const res = await call('POST', '/nodes', { kind: 'session', sessionId: 's1', x: 10, y: 20 })
    assert.equal(res.status, 201)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.value.revision, 1)
    assert.equal(res.json.value.value.sessionId, 's1')
    // 同一次提交只推进一格。
    const again = await call('POST', '/nodes', { kind: 'note' })
    assert.equal(again.json.value.revision, 2)
  })
})

test('绑定不存在的会话 → 400；不存在的节点 → 404；半套几何 → 400', async () => {
  await withRoutes(async ({ call }) => {
    const dead = await call('POST', '/nodes', { kind: 'session', sessionId: 'ghost' })
    assert.equal(dead.status, 400)
    assert.equal(dead.json.error.code, 'invalid_input')

    const missing = await call('POST', '/nodes/999/detach', { sessionId: 's1', x: 0, y: 0 })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'not_found')

    const halfFrame = await call('POST', '/group', { memberIds: ['s1'], consumeNodeIds: [], x: 0 })
    assert.equal(halfFrame.status, 400)
    assert.match(halfFrame.json.error.message, /x, y, width and height/)
  })
})

test('批量移动只回报真的写下去的，未知 id 被跳过', async () => {
  await withRoutes(async ({ call }) => {
    await call('POST', '/nodes', { kind: 'note' })
    const res = await call('POST', '/nodes/move', {
      moves: [
        { id: 1, x: 7, y: 8 },
        { id: 404, x: 0, y: 0 },
      ],
    })
    assert.deepEqual(res.json.value.value, [{ id: 1, x: 7, y: 8 }])
  })
})

test('同值 patch 是空操作：不占 revision，但仍然把当前节点还给调用方', async () => {
  await withRoutes(async ({ call }) => {
    await call('POST', '/nodes', { kind: 'note', content: '写了' })
    const noop = await call('POST', '/nodes/1/update', { content: '写了' })
    assert.equal(noop.json.value.revision, 1, '空操作不该推进 revision')
    assert.equal(noop.json.value.value.content, '写了')
    const real = await call('POST', '/nodes/1/update', { content: '改了' })
    assert.equal(real.json.value.revision, 2)
  })
})

test('未知路径 404，非 GET/POST 405', async () => {
  await withRoutes(async ({ call }) => {
    assert.equal((await call('GET', '/nope')).status, 404)
    assert.equal((await call('POST', '/nope', {})).status, 404)
    assert.equal((await call('DELETE', '/state')).status, 405)
  })
})

test('SSE：先发 retry 与基线 hello，之后每次提交一帧 change', async () => {
  await withRoutes(async ({ call, sse }) => {
    const res = fakeRes()
    sse(fakeReq('GET', '/dsh-plugin-canvas/events'), res)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.match(res.body, /^retry: 2000\n\n/)
    assert.match(res.body, /event: hello\ndata: \{"revision":0\}/)

    await call('POST', '/nodes', { kind: 'note' })
    const frames = res.body.split('\n\n').filter((f) => f.startsWith('event: change'))
    assert.equal(frames.length, 1, '一次提交恰好一帧')
    const payload = JSON.parse(frames[0].slice(frames[0].indexOf('data: ') + 6))
    assert.equal(payload.kind, 'upsert')
    assert.equal(payload.revision, 1)
    assert.equal(payload.node.kind, 'note')
  })
})
