/**
 * Route-layer tests: drive the real handlers with a real git repository, a real
 * ledger file, and a stubbed network. What is exercised end to end is the part
 * that only breaks when the pieces are wired together — remote resolution, the
 * token fence, the `{ ok }` envelope and its status map, the link join, and the
 * trigger flow's dedup.
 *
 * @module dsh-plugin-repopanel/test/routes
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { PanelStore } from '../src/host/store.js'
import { registerRepoPanelRoutes } from '../src/host/routes.js'

const run = promisify(execFile)

/** A real repository with a real origin — remote.js is not stubbed anywhere. */
async function repoWithOrigin(url) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rp-repo-'))
  await run('git', ['init', '--quiet'], { cwd: dir })
  if (url !== null) await run('git', ['remote', 'add', 'origin', url], { cwd: dir })
  return dir
}

/** Collect a response without a socket. */
function fakeRes() {
  const out = { status: 0, headers: {}, body: '', chunks: [] }
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
  return req
}

/**
 * Mount the routes against stubs and hand back a `call()` that returns the
 * parsed envelope. `forge` and `board` are the two stubbed networks. `null`
 * (never `undefined`) means "absent" for `originUrl` and `token` — a default
 * parameter would swallow an explicit `undefined` and quietly test the default.
 */
async function harness({ originUrl = 'https://github.com/o/r.git', token = 'ghp_x', forge = {}, board = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rp-ledger-'))
  const store = new PanelStore({ file: join(dir, 'ledger.json') })
  const path = await repoWithOrigin(originUrl)
  const workspace = { id: 'ws-1', path, title: 'r' }

  const credentialsFile = join(dir, 'credentials.json')
  if (token !== null) {
    await writeFile(credentialsFile, JSON.stringify({ schemaVersion: 1, hosts: { 'github.com': { token } } }), 'utf8')
  }

  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push({ href, method: init?.method ?? 'GET' })
    for (const [pattern, reply] of Object.entries({ ...forge, ...board })) {
      if (href.includes(pattern)) return reply(href, init)
    }
    return new Response('{"message":"unexpected call"}', { status: 599 })
  }

  const registered = []
  const ctx = { webServer: { register: (route) => { registered.push(route); return () => {} } } }
  const dispose = registerRepoPanelRoutes(ctx, {
    store,
    workspaces: { list: () => [workspace], get: (id) => (id === workspace.id ? workspace : undefined) },
    credentialsFile,
    now: () => 1700000000000,
    fetchImpl,
  })
  const handler = registered.find((route) => route.kind === 'prefix').handler

  const call = async (method, url, body) => {
    const res = fakeRes()
    await handler(fakeReq(method, url, body), res)
    return { status: res.out.status, payload: res.out.body.length > 0 ? JSON.parse(res.out.body) : undefined }
  }
  return { call, handler, store, dispose, calls, workspace }
}

/** One search-API page as GitHub shapes it. */
const searchPage = (items, total = items.length) => () => Response.json({
  total_count: total,
  incomplete_results: false,
  items,
})

const issueItem = (number, overrides = {}) => ({
  number,
  title: `issue ${number}`,
  body: 'body',
  state: 'open',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  user: { login: 'alice', avatar_url: 'https://a' },
  updated_at: '2026-01-01T00:00:00Z',
  html_url: `https://github.com/o/r/issues/${number}`,
  comments: 2,
  ...overrides,
})

test('/remote 把 origin 解析成 forge 坐标（真 git 仓库，不打桩）', async (t) => {
  const { call, dispose } = await harness()
  t.after(dispose)
  const { status, payload } = await call('GET', '/dsh-plugin-repopanel/remote?workspaceId=ws-1')
  assert.equal(status, 200)
  assert.deepEqual(payload.value, {
    host: 'github.com',
    ownerRepo: 'o/r',
    remoteUrl: 'https://github.com/o/r.git',
    provider: 'github',
    supported: true,
  })
})

test('没有 origin 的仓库返回 null，而不是报错', async (t) => {
  const { call, dispose } = await harness({ originUrl: null })
  t.after(dispose)
  const { status, payload } = await call('GET', '/dsh-plugin-repopanel/remote?workspaceId=ws-1')
  assert.equal(status, 200)
  assert.equal(payload.value, null, '「这个工作区没有远端」是一种状态，不是失败')
})

test('不认识的 host 报 409 unsupported_host，认识但没令牌报 403 no_account', async (t) => {
  const unsupported = await harness({ originUrl: 'https://git.example.com/o/r.git' })
  t.after(unsupported.dispose)
  const bad = await unsupported.call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1')
  assert.equal(bad.status, 409)
  assert.equal(bad.payload.ok, false)
  assert.equal(bad.payload.error.code, 'unsupported_host')

  const noToken = await harness({ token: null })
  t.after(noToken.dispose)
  const denied = await noToken.call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1')
  assert.equal(denied.status, 403)
  assert.equal(denied.payload.error.code, 'no_account')
})

test('未知 workspace 是 404，缺 workspaceId 是 400', async (t) => {
  const { call, dispose } = await harness()
  t.after(dispose)
  assert.equal((await call('GET', '/dsh-plugin-repopanel/remote?workspaceId=nope')).status, 404)
  assert.equal((await call('GET', '/dsh-plugin-repopanel/remote')).status, 400)
})

test('/list 把 forge 的一页与任务板的活状态接起来', async (t) => {
  const { call, store, dispose } = await harness({
    forge: { '/search/issues': searchPage([issueItem(7), issueItem(8)], 2) },
    board: {
      '/dsh-plugin-taskboard/state': () => Response.json({
        ok: true,
        value: { revision: 3, tasks: [{ id: 'task_1', title: '#7 · issue 7', status: 'running' }] },
      }),
    },
  })
  t.after(dispose)

  // #7 已经有任务，#8 没有
  await store.putLink({
    sourceKey: 'github:github.com:o/r:issue:7',
    taskId: 'task_1',
    provider: 'github',
    host: 'github.com',
    ownerRepo: 'o/r',
    kind: 'issue',
    number: 7,
    url: 'u',
    title: 't',
    scenario: 'fix',
    writeback: false,
    createdAt: 1,
  })

  const { status, payload } = await call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1&tab=issues')
  assert.equal(status, 200)
  assert.equal(payload.value.rows.length, 2)
  assert.equal(payload.value.rows[0].number, 7)
  assert.equal(payload.value.rows[0].labels[0].color, '#d73a4a', '裸十六进制要补成 #rrggbb')

  const link = payload.value.links['github:github.com:o/r:issue:7']
  assert.equal(link.status, 'running')
  assert.equal(link.chip, 'active')
  assert.equal(payload.value.links['github:github.com:o/r:issue:8'], undefined)
})

test('任务板不在时列表照常出，只是每行都退回 Start', async (t) => {
  const { call, store, dispose } = await harness({
    forge: { '/search/issues': searchPage([issueItem(7)]) },
    board: { '/dsh-plugin-taskboard/state': () => new Response('', { status: 404 }) },
  })
  t.after(dispose)
  await store.putLink({
    sourceKey: 'github:github.com:o/r:issue:7',
    taskId: 'task_1',
    provider: 'github',
    host: 'github.com',
    ownerRepo: 'o/r',
    kind: 'issue',
    number: 7,
    url: 'u',
    title: 't',
    scenario: 'fix',
    writeback: false,
    createdAt: 1,
  })
  const { status, payload } = await call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1')
  assert.equal(status, 200, '缺一个兄弟插件不该让面板报错')
  assert.deepEqual(payload.value.links, {})
})

/** A board stub that remembers what it was asked to create. */
function boardStub() {
  const tasks = []
  return {
    tasks,
    routes: {
      '/dsh-plugin-taskboard/state': () => Response.json({ ok: true, value: { revision: tasks.length, tasks } }),
      '/dsh-plugin-taskboard/tasks': (href, init) => {
        const body = JSON.parse(init.body)
        const task = { id: `task_${tasks.length + 1}`, status: 'todo', ...body }
        tasks.push(task)
        return Response.json({ ok: true, value: task }, { status: 201 })
      },
    },
  }
}

test('/start 建任务、记映射，prompt 在服务端组好且正文被围起来', async (t) => {
  const board = boardStub()
  const { call, store, dispose } = await harness({
    forge: { '/repos/o/r/issues/7': () => Response.json(issueItem(7, { body: '点了没反应' })) },
    board: board.routes,
  })
  t.after(dispose)

  const { status, payload } = await call('POST', '/dsh-plugin-repopanel/start', {
    workspaceId: 'ws-1',
    kind: 'issue',
    number: 7,
    scenario: 'fix',
    instruction: '只改后端',
  })
  assert.equal(status, 201)
  assert.equal(payload.value.outcome, 'created')
  assert.equal(payload.value.task.id, 'task_1')
  assert.equal(payload.value.task.title, '#7 · issue 7')
  assert.equal(payload.value.task.workspaceId, 'ws-1', '任务要绑在触发它的工作区上')

  const prompt = board.tasks[0].prompt
  assert.match(prompt, /实现或修复/, '场景模板要在最前面')
  assert.match(prompt, /只改后端/)
  assert.match(prompt, /UNTRUSTED DATA/)
  assert.ok(prompt.indexOf('点了没反应') > prompt.indexOf('UNTRUSTED DATA'), '正文必须落在围栏之内')

  const link = store.link('github:github.com:o/r:issue:7')
  assert.equal(link.taskId, 'task_1')
  assert.equal(link.scenario, 'fix')
})

test('/start 第二次报 duplicate；force 才会再建一个', async (t) => {
  const board = boardStub()
  const { call, dispose } = await harness({
    forge: { '/repos/o/r/issues/7': () => Response.json(issueItem(7)) },
    board: board.routes,
  })
  t.after(dispose)
  const body = { workspaceId: 'ws-1', kind: 'issue', number: 7 }

  await call('POST', '/dsh-plugin-repopanel/start', body)
  const second = await call('POST', '/dsh-plugin-repopanel/start', body)
  assert.equal(second.payload.value.outcome, 'duplicate')
  assert.equal(second.payload.value.task.id, 'task_1')
  assert.equal(board.tasks.length, 1, 'duplicate 不该悄悄再建一个任务')

  const forced = await call('POST', '/dsh-plugin-repopanel/start', { ...body, force: true })
  assert.equal(forced.payload.value.outcome, 'created')
  assert.equal(board.tasks.length, 2)
})

test('/start 的场景必须属于该条目类型', async (t) => {
  const board = boardStub()
  const { call, dispose } = await harness({
    forge: { '/repos/o/r/issues/7': () => Response.json(issueItem(7)) },
    board: board.routes,
  })
  t.after(dispose)
  const { status, payload } = await call('POST', '/dsh-plugin-repopanel/start', {
    workspaceId: 'ws-1',
    kind: 'issue',
    number: 7,
    scenario: 'review_only',
  })
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'invalid_input')
  assert.equal(board.tasks.length, 0)
})

test('任务被人手删掉之后，同一条目可以重新触发', async (t) => {
  const board = boardStub()
  const { call, dispose } = await harness({
    forge: { '/repos/o/r/issues/7': () => Response.json(issueItem(7)) },
    board: board.routes,
  })
  t.after(dispose)
  const body = { workspaceId: 'ws-1', kind: 'issue', number: 7 }
  await call('POST', '/dsh-plugin-repopanel/start', body)
  board.tasks.length = 0

  // 去重是按「板上还活着的任务」判的，不是按映射表里有没有记录
  const again = await call('POST', '/dsh-plugin-repopanel/start', body)
  assert.equal(again.payload.value.outcome, 'created')
})

test('/settings 往返：写 scope、跟随全局、全局行不可删', async (t) => {
  const { call, dispose } = await harness()
  t.after(dispose)

  const custom = await call('POST', '/dsh-plugin-repopanel/settings', {
    scope: 'ws-1',
    settings: { defaultIssueScenario: 'plan_first', writebackDefault: true, scenarioPrompts: { all: '先跑测试' } },
  })
  assert.equal(custom.status, 200)
  assert.equal(custom.payload.value.folders['ws-1'].defaultIssueScenario, 'plan_first')

  // settings: null 表示「这个工作区跟随全局」，所以 null 是有意义的，不能被当成缺省
  const follow = await call('POST', '/dsh-plugin-repopanel/settings', { scope: 'ws-1', settings: null })
  assert.equal(follow.payload.value.folders['ws-1'], undefined)

  const global = await call('POST', '/dsh-plugin-repopanel/settings', { scope: null, settings: null })
  assert.equal(global.status, 400, '全局行是兜底，删不得')

  const read = await call('GET', '/dsh-plugin-repopanel/settings')
  assert.equal(read.payload.value.global.defaultIssueScenario, 'fix')
})

test('/settings 拦住超长常驻指令，而不是截半句存下来', async (t) => {
  const { call, dispose } = await harness()
  t.after(dispose)
  const { status, payload } = await call('POST', '/dsh-plugin-repopanel/settings', {
    scope: null,
    settings: { scenarioPrompts: { all: 'x'.repeat(4001) } },
  })
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'invalid_input')
})

test('/credentials 只告诉浏览器「哪个 host 有凭据、来自哪」，绝不回令牌', async (t) => {
  const { call, dispose } = await harness({ token: null })
  t.after(dispose)

  const saved = await call('POST', '/dsh-plugin-repopanel/credentials', {
    host: 'GitHub.com',
    token: 'ghp_supersecret',
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.payload.value.hosts, [{ host: 'github.com', source: 'file' }])
  assert.ok(
    !JSON.stringify(saved.payload).includes('ghp_supersecret'),
    '响应里出现令牌就等于把它写进了任何一份前端日志',
  )

  const listed = await call('GET', '/dsh-plugin-repopanel/credentials')
  assert.ok(!JSON.stringify(listed.payload).includes('ghp_supersecret'))

  const removed = await call('POST', '/dsh-plugin-repopanel/credentials/delete', { host: 'github.com' })
  assert.deepEqual(removed.payload.value.hosts, [])
})

test('空令牌被拒，不会写出一个存着空字符串的凭据文件', async (t) => {
  const { call, dispose } = await harness({ token: null })
  t.after(dispose)
  const { status, payload } = await call('POST', '/dsh-plugin-repopanel/credentials', { host: 'github.com', token: '   ' })
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'invalid_input')
})

test('/credentials 报告环境变量的名字，但绝不报告它的值', async (t) => {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_from_env'
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  })

  const { call, dispose } = await harness({ token: null })
  t.after(dispose)
  const { payload } = await call('GET', '/dsh-plugin-repopanel/credentials')
  // 环境变量是按 provider 生效的，不是按 host。不报出来，面板就会一边显示
  // 「github.com 没有凭据」一边正常出数据，用户会去找一个不存在的 bug。
  assert.deepEqual(payload.value.env, [{ provider: 'github', variable: 'GITHUB_TOKEN', host: 'github.com' }])
  assert.deepEqual(payload.value.hosts, [])
  assert.ok(!JSON.stringify(payload).includes('ghp_from_env'))
})

test('环境变量只认规范 host —— Enterprise 拿不到它，必须自己存', async (t) => {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_from_env'
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  })

  // provider 是按 host 的某一节匹配的，所以 origin 指到 github.<别人的机器>.com 时
  // 也会被认成 GitHub Enterprise。如果环境变量对所有匹配的 host 都生效，
  // 用户真正的 GITHUB_TOKEN 就会被发到那台机器上去。
  const { call, dispose } = await harness({
    originUrl: 'https://github.someone-elses-box.com/o/r.git',
    token: null,
  })
  t.after(dispose)
  const { status, payload } = await call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1')
  assert.equal(status, 403)
  assert.equal(payload.error.code, 'no_account')
  assert.match(payload.error.message, /github\.someone-elses-box\.com/)
})

test('环境变量优先于落盘的凭据', async (t) => {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_from_env'
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  })

  let seenAuth
  const { call, dispose } = await harness({
    token: 'ghp_from_file',
    forge: {
      '/search/issues': (href, init) => {
        seenAuth = init?.headers?.Authorization ?? init?.headers?.authorization
        return Response.json({ total_count: 0, incomplete_results: false, items: [] })
      },
    },
  })
  t.after(dispose)
  await call('GET', '/dsh-plugin-repopanel/list?workspaceId=ws-1')
  assert.equal(seenAuth, 'Bearer ghp_from_env', '改一个环境变量就该立刻生效，不用重启宿主')
})

test('坏 JSON body 是 400，未知路径是 404，未知方法是 405', async (t) => {
  const { call, handler, dispose } = await harness()
  t.after(dispose)

  assert.equal((await call('POST', '/dsh-plugin-repopanel/nope', {})).status, 404)

  // 手搓一个不是 JSON 的 body —— call() 会替我们序列化，绕不过去
  const broken = fakeRes()
  const req = Readable.from([Buffer.from('{ not json', 'utf8')])
  req.method = 'POST'
  req.url = '/dsh-plugin-repopanel/settings'
  req.headers = { host: '127.0.0.1:1' }
  await handler(req, broken)
  assert.equal(broken.out.status, 400)
  assert.equal(JSON.parse(broken.out.body).error.code, 'invalid_input')

  const wrongMethod = fakeRes()
  const del = Readable.from([])
  del.method = 'DELETE'
  del.url = '/dsh-plugin-repopanel/settings'
  del.headers = { host: '127.0.0.1:1' }
  await handler(del, wrongMethod)
  assert.equal(wrongMethod.out.status, 405)
  assert.equal(wrongMethod.out.headers.allow, 'GET, POST')
})
