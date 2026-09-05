/**
 * 路由层只做一件事：把 HTTP 映射到 `{ ok }` 信封。所以这里用真的 handler、真的
 * 临时目录，只把 req/res 换成替身 —— 抓的是状态码、信封形状与「删了之后就真的
 * 打不开了」这类跨层行为。
 *
 * @module dsh-plugin-longread/test/routes
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../src/host/store.js'
import { MAX_UPLOAD_BYTES, ROUTE_PREFIX, registerLongreadRoutes } from '../src/host/routes.js'

const TXT = '第一章 甲\n\n' + '甲的正文。'.repeat(60) + '\n\n第二章 乙\n\n' + '乙的正文。'.repeat(60) + '\n'

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? null
      return res
    },
    write(chunk) { res.body += String(chunk) },
    end(chunk) {
      res.ended = true
      if (chunk !== undefined) res.body += String(chunk)
    },
    get json() { return res.body.length === 0 ? null : JSON.parse(res.body) },
  }
  return res
}

function fakeReq(method, path, body, headers) {
  const raw = body === undefined
    ? undefined
    : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))
  const chunks = raw === undefined ? [] : [raw]
  return {
    method,
    url: path,
    headers: headers ?? {},
    async* [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Mount the real routes on a webServer stub and return a call helper. */
async function mount(options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-longread-routes-'))
  const store = new LibraryStore({ file: join(dir, 'library.json'), textDir: join(dir, 'books') })
  let handler
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'prefix')
        assert.equal(route.path, ROUTE_PREFIX)
        handler = route.handler
        return () => { handler = undefined }
      },
    },
  }
  const filePool = { paths: async () => options?.files ?? [] }
  const dispose = registerLongreadRoutes(ctx, { store, filePool, now: () => 1234 })
  const call = async (method, path, body, headers) => {
    const res = fakeRes()
    await handler(fakeReq(method, ROUTE_PREFIX + path, body, headers), res)
    return res
  }
  return { store, call, dispose, dir }
}

/** Import one book the way the panel does: the file's own bytes, name in the query. */
async function importBookVia(call, name) {
  const filename = name ?? 'a.txt'
  const res = await call('POST', '/import?name=' + encodeURIComponent(filename), Buffer.from(TXT, 'utf8'),
    { 'content-type': 'application/octet-stream' })
  assert.equal(res.status, 201)
  return res.json.value
}

test('GET /state 顺手种下示例小说，并且只种一次', async () => {
  const { call } = await mount()
  const first = await call('GET', '/state')
  assert.equal(first.status, 200)
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.equal(first.json.ok, true)
  assert.equal(first.json.value.books.length, 1)
  assert.equal(first.json.value.books[0].builtin, true)
  assert.equal(first.json.value.settings.persona, 'refactor')
  const second = await call('GET', '/state')
  assert.equal(second.json.value.books.length, 1)
})

test('GET plan 给出可播放的计划，章号越界会夹住', async () => {
  const { call } = await mount({ files: ['src/real/file.ts'] })
  const book = await importBookVia(call)
  const res = await call('GET', '/books/' + book.id + '/plan?chapter=1')
  assert.equal(res.status, 200)
  const plan = res.json.value
  assert.equal(plan.chapterIndex, 1)
  assert.equal(plan.chapterTitle, '第二章 乙')
  assert.equal(plan.chapterCount, 2)
  assert.ok(plan.turns.length > 0)
  assert.ok(plan.turns[0].paragraphs.length > 0)
  const clamped = await call('GET', '/books/' + book.id + '/plan?chapter=99')
  assert.equal(clamped.json.value.chapterIndex, 1)
  const first = await call('GET', '/books/' + book.id + '/plan')
  assert.equal(first.json.value.chapterIndex, 0)
})

test('真实路径开关决定伪装引用谁：关掉就一条工作区路径都不出现', async () => {
  const marker = 'src/only/here.ts'
  const on = await mount({ files: [marker] })
  const bookOn = await importBookVia(on.call)
  const planOn = (await on.call('GET', '/books/' + bookOn.id + '/plan?chapter=0')).json.value
  const summariesOn = planOn.turns.flatMap((turn) => turn.calls.map((call) => String(call.summary)))
  assert.ok(summariesOn.includes(marker), '开着就该引用真实文件')

  const off = await mount({ files: [marker] })
  await off.call('POST', '/settings', { useRealPaths: false })
  const bookOff = await importBookVia(off.call)
  const planOff = (await off.call('GET', '/books/' + bookOff.id + '/plan?chapter=0')).json.value
  const summariesOff = planOff.turns.flatMap((turn) => turn.calls.map((call) => String(call.summary)))
  assert.equal(summariesOff.includes(marker), false)
})

test('进度写入与回读，未知书是 404', async () => {
  const { call } = await mount()
  const book = await importBookVia(call)
  const saved = await call('POST', '/progress', { bookId: book.id, chapterIndex: 1, turnIndex: 2 })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json.value, { chapterIndex: 1, turnIndex: 2, updatedAt: 1234 })
  const state = await call('GET', '/state')
  assert.deepEqual(state.json.value.progress[book.id], { chapterIndex: 1, turnIndex: 2, updatedAt: 1234 })
  const missing = await call('POST', '/progress', { bookId: 'nope', chapterIndex: 0, turnIndex: 0 })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not_found')
  const bad = await call('POST', '/progress', { chapterIndex: 0 })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_input')
})

test('删书之后计划就打不开了', async () => {
  const { call } = await mount()
  const book = await importBookVia(call)
  const removed = await call('POST', '/books/' + book.id + '/delete', {})
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json.value, { id: book.id, removed: true })
  const gone = await call('GET', '/books/' + book.id + '/plan?chapter=0')
  assert.equal(gone.status, 404)
  assert.equal((await call('POST', '/books/' + book.id + '/delete', {})).status, 404)
})

test('坏上传被挡在 400：空 data、不是 JSON 的 body', async () => {
  const { call } = await mount()
  const json = { 'content-type': 'application/json' }
  const empty = await call('POST', '/import', { name: 'a.txt' }, json)
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'invalid_input')
  const garbage = await call('POST', '/import', '{not json', json)
  assert.equal(garbage.status, 400)
  const notABook = await call('POST', '/import', { name: 'a.txt', data: Buffer.from('   ', 'utf8').toString('base64') }, json)
  assert.equal(notABook.status, 400)
  const nothing = await call('POST', '/import?name=a.txt', undefined, { 'content-type': 'application/octet-stream' })
  assert.equal(nothing.status, 400)
})

test('导入收的是文件本身的字节：epub 不必先 base64（那是 40MB 的书进不来的原因）', async () => {
  const { call, store } = await mount()
  const bytes = Buffer.from(TXT, 'utf8')
  const res = await call('POST', '/import?name=' + encodeURIComponent('【某站】九阴真经.txt'), bytes,
    { 'content-type': 'application/octet-stream' })
  assert.equal(res.status, 201)
  assert.equal(res.json.value.title, '九阴真经', '文件名从查询串里取')
  assert.equal(res.json.value.chapters.length, 2)
  // 字节原样落盘：raw 上传不该在中间被解码一次。
  assert.equal(await store.chapterText(res.json.value.id, 0), (await store.text(res.json.value.id)).slice(0, res.json.value.chapters[0].chars))

  // JSON+base64 仍然收：老脚本不该因为面板换了形状就断。
  const legacy = await call('POST', '/import', { name: 'b.txt', data: bytes.toString('base64') },
    { 'content-type': 'application/json' })
  assert.equal(legacy.status, 201)
  assert.equal(legacy.json.value.title, 'b')
  // 没带 content-type 的 JSON 信封也认（旧客户端就是这么发的）。
  const sniffed = await call('POST', '/import', { name: 'c.txt', data: bytes.toString('base64') })
  assert.equal(sniffed.status, 201)
  assert.equal(sniffed.json.value.title, 'c')
})

test('超过上限的上传是 413，且说清上限是多少 —— 不是静默失败', async () => {
  const { call } = await mount()
  const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41)
  const res = await call('POST', '/import?name=big.txt', tooBig, { 'content-type': 'application/octet-stream' })
  assert.equal(res.status, 413)
  assert.equal(res.json.error.code, 'too_large')
  assert.match(res.json.error.message, /128 MB/)
})

test('控制路由的 JSON body 有独立的小上限：settings 不该收得下一本书', async () => {
  const { call } = await mount()
  const fat = JSON.stringify({ speed: 40, pad: 'x'.repeat(2 * 1024 * 1024) })
  const res = await call('POST', '/settings', fat, { 'content-type': 'application/json' })
  assert.equal(res.status, 413)
  assert.equal(res.json.error.code, 'too_large')
})

test('未知路径 404、不认识的方法 405 且带 allow 头', async () => {
  const { call } = await mount()
  assert.equal((await call('GET', '/nope')).status, 404)
  assert.equal((await call('POST', '/nope', {})).status, 404)
  const bad = await call('PUT', '/state')
  assert.equal(bad.status, 405)
  assert.equal(bad.headers.allow, 'GET, POST')
})

test('每个回复都是 { ok } 信封', async () => {
  const { call } = await mount()
  for (const res of [await call('GET', '/state'), await call('POST', '/settings', { speed: 40 })]) {
    assert.equal(typeof res.json.ok, 'boolean')
    assert.ok('value' in res.json || 'error' in res.json)
  }
  const failed = await call('GET', '/books/ghost/plan')
  assert.equal(failed.json.ok, false)
  assert.equal(typeof failed.json.error.message, 'string')
})

test('dispose 之后路由被注销', async () => {
  const { call, dispose } = await mount()
  assert.equal((await call('GET', '/state')).status, 200)
  dispose()
  await assert.rejects(() => call('GET', '/state'), TypeError)
})
