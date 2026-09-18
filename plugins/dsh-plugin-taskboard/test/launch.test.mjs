/**
 * 发起会话（launch）链路：消息构造、会话 id 提取、launch 路由的守卫与副作用。
 * 路由测试对着真实 TaskStore（临时目录账本）+ 假 launcher（记录调用的桩）跑，
 * 不需要 dsh 宿主。
 *
 * @module dsh-plugin-taskboard/test/launch
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_MAX_PARALLEL, createTaskRecord } from '../src/shared/protocol.js'
import { TaskStore } from '../src/host/store.js'
import { registerTaskboardRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { buildLaunchMessage, createLauncher, sessionIdOf } from '../src/host/launcher.js'

// 消息与备注语言跟随宿主环境变量；测试固定为中文，避免开发机 locale 漂移。
process.env.DSH_DESKTOP_LANG = 'zh'

// --------------------------------------------------------------- 纯函数

test('buildLaunchMessage：带执行 prompt，引导先看详情再认领', () => {
  const message = buildLaunchMessage(
    { id: 'task_a', title: '修登录超时', prompt: '复现后修复，补回归测试。' },
    'zh',
  )
  assert.match(message, /「修登录超时」/)
  assert.match(message, /taskboard_get/)
  assert.match(message, /taskboard_move/)
  assert.match(message, /执行 Prompt：/)
  assert.match(message, /复现后修复，补回归测试。/)
})

test('buildLaunchMessage：没有 prompt 时退回描述，英文输出不串语言', () => {
  const message = buildLaunchMessage(
    { id: 'task_b', title: 'add retry', description: '3 retries with backoff.' },
    'en',
  )
  assert.match(message, /"add retry"/)
  assert.match(message, /Task description:/)
  assert.match(message, /3 retries with backoff\./)
  assert.doesNotMatch(message, /执行/)
})

test('buildLaunchMessage：prompt 与描述都为空时只有指引行，不抛', () => {
  const message = buildLaunchMessage({ id: 'task_c', title: '空任务', prompt: '  ' }, 'zh')
  assert.match(message, /「空任务」/)
  assert.equal(message.includes('任务描述'), false)
})

test('sessionIdOf：容忍上游返回形状的变化', () => {
  assert.equal(sessionIdOf({ sessionId: 's1' }), 's1')
  assert.equal(sessionIdOf({ id: 's2' }), 's2')
  assert.equal(sessionIdOf({ session: { id: 's3' } }), 's3')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
})

test('createLauncher：没有 sessionController 返回 undefined，有则只暴露两个调用', () => {
  assert.equal(createLauncher(undefined), undefined)
  const launcher = createLauncher({ create() {}, prompt() {} })
  assert.deepEqual(Object.keys(launcher).sort(), ['createSession', 'prompt'])
})

test('createLauncher：prompt 透传 request、补 requestId 与未中止的 AbortSignal', async () => {
  const calls = []
  const launcher = createLauncher({
    create: (req) => ({ sessionId: 's' }),
    prompt: (req, signal) => {
      calls.push({ req, signal })
      return { accepted: true }
    },
  })
  await launcher.prompt({ sessionId: 's', mode: 'queue', content: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].req.sessionId, 's')
  assert.equal(calls[0].req.mode, 'queue')
  // SessionPromptRequest.requestId 是必填项，缺了会被上游拒收
  assert.equal(typeof calls[0].req.requestId, 'string')
  assert.ok(calls[0].req.requestId.length > 0)
  assert.equal(typeof calls[0].signal?.throwIfAborted, 'function')
  assert.equal(calls[0].signal.aborted, false)
})

test('createLauncher：调用方自带 requestId 时不覆盖（重试幂等）', async () => {
  const calls = []
  const launcher = createLauncher({
    create: () => ({}),
    prompt: (req) => {
      calls.push(req)
      return { accepted: true }
    },
  })
  await launcher.prompt({ requestId: 'given-id', sessionId: 's', mode: 'queue', content: [] })
  assert.equal(calls[0].requestId, 'given-id')
})

// --------------------------------------------------------------- launch 路由

/** 最小 web 假件：register 捕获 handler，req 支持空 body 迭代。 */
function fakeRouteEnv(options) {
  let handler
  const ctx = {
    webServer: {
      register: (def) => {
        if (def.kind === 'prefix') handler = def.handler
        return () => {}
      },
    },
  }
  const dispose = registerTaskboardRoutes(ctx, options)
  return { handler, dispose }
}

function jsonRequest(method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(text) { this.body = text ?? '' },
    write() {},
    on() {},
  }
}

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cgtb-launch-'))
  const store = new TaskStore({ file: join(dir, 'ledger.json') })
  await store.load()
  return { dir, store }
}

function recordingLauncher(sessionId) {
  const calls = { create: [], prompt: [] }
  return {
    calls,
    async createSession(payload) {
      calls.create.push(payload)
      return { sessionId }
    },
    async prompt(payload) {
      calls.prompt.push(payload)
      return { ok: true }
    },
  }
}

/** 在临时目录里建一张卡（状态可指定）。 */
async function seed(store, fields) {
  const task = createTaskRecord({
    title: fields.title ?? '卡',
    actor: { kind: 'user' },
    now: fields.now ?? 1,
  })
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })
  if (fields.status !== undefined || fields.sessionId !== undefined) {
    await store.mutate('task-moved', (ledger) => {
      const live = ledger.tasks.find((t) => t.id === task.id)
      if (fields.status !== undefined) live.status = fields.status
      if (fields.sessionId !== undefined) live.sessionId = fields.sessionId
      return [live]
    })
  }
  return task
}

/** 轮询等待某个异步效果（调度器由账本订阅触发，不返回 promise）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('launch 路由：入队 → 调度器建会话 → 排队首条消息并留备注', async () => {
  const { dir, store } = await freshStore()
  try {
    const task = createTaskRecord({
      title: '修登录超时',
      prompt: '复现后修复。',
      workspaceId: 'ws-1',
      actor: { kind: 'user' },
      now: 100,
    })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const launcher = recordingLauncher('sess-123')
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 200, launcher: () => launcher })
    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: task.version }), res)

    assert.equal(res.statusCode, 201)
    const value = JSON.parse(res.body).value
    assert.deepEqual(value, {
      taskId: task.id,
      sessionId: 'sess-123',
      status: 'queued',
      queued: false,
      active: 1,
      maxParallel: DEFAULT_MAX_PARALLEL,
    })
    // 会话创建带上了任务绑定的项目
    assert.deepEqual(launcher.calls.create, [{ workspaceId: 'ws-1' }])
    // 首条消息指向新会话，内容按看板协议引导
    assert.equal(launcher.calls.prompt.length, 1)
    assert.equal(launcher.calls.prompt[0].sessionId, 'sess-123')
    assert.equal(launcher.calls.prompt[0].mode, 'queue')
    assert.match(launcher.calls.prompt[0].content[0].text, /「修登录超时」/)
    // 卡片推进到 queued（管线内的排队态）、带上会话 id、留可追溯备注。
    // 版本推进两次：一次入队，一次调度器把会话 id/备注写上去。
    const after = store.get(task.id)
    assert.equal(after.status, 'queued')
    assert.equal(after.sessionId, 'sess-123')
    assert.equal(after.version, task.version + 2)
    assert.equal(after.comments.length, 1)
    assert.match(after.comments[0].body, /sess-123/)
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch 路由：额度已满时只入队不建会话，卡片停在「排队中」', async () => {
  const { dir, store } = await freshStore()
  try {
    await store.mutateSettings((ledger) => {
      ledger.settings = { maxParallel: 1 }
      return true
    })
    // 一张会话在干活的卡占满唯一额度
    await seed(store, { title: '在跑', status: 'running', sessionId: 'sess-hold' })
    const task = createTaskRecord({ title: '等下', actor: { kind: 'user' }, now: 2 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const launcher = recordingLauncher('sess-new')
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 300, launcher: () => launcher })
    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: task.version }), res)

    assert.equal(res.statusCode, 201)
    const value = JSON.parse(res.body).value
    assert.equal(value.sessionId, '', '没有空位就不该有会话')
    assert.equal(value.queued, true)
    assert.equal(value.status, 'queued')
    assert.equal(value.active, 1)
    assert.equal(value.maxParallel, 1)
    assert.equal(launcher.calls.create.length, 0, '额度已满不得建会话')
    const after = store.get(task.id)
    assert.equal(after.status, 'queued')
    assert.equal(after.sessionId, undefined)
    assert.equal(after.comments.length, 1)
    assert.match(after.comments[0].body, /排队中/)
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch 路由：空位腾出后队列自动补位发起会话', async () => {
  const { dir, store } = await freshStore()
  try {
    await store.mutateSettings((ledger) => {
      ledger.settings = { maxParallel: 1 }
      return true
    })
    const busy = await seed(store, { title: '在跑', status: 'running', sessionId: 'sess-hold' })
    const task = createTaskRecord({ title: '等下', actor: { kind: 'user' }, now: 2 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const launcher = recordingLauncher('sess-new')
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 400, launcher: () => launcher })
    const first = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: task.version }), first)
    assert.equal(JSON.parse(first.body).value.sessionId, '')
    assert.equal(store.get(task.id).sessionId, undefined)

    // 占着额度的卡被验收（用户动作为主，走 move 路由）
    const second = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${busy.id}/move`, {
      ifVersion: store.get(busy.id).version,
      status: 'done',
    }), second)
    assert.equal(second.statusCode, 200)

    // 额度一空，订阅里的调度器就会给排队卡开会话
    assert.equal(await waitFor(() => store.get(task.id).sessionId === 'sess-new'), true,
      '空位出现后调度器应自动补位')
    assert.equal(launcher.calls.create.length, 1)
    assert.equal(store.get(task.id).status, 'queued', '开了会话也还在等 agent 认领')
    assert.match(launcher.calls.prompt[0].content[0].text, /等下/)
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unqueue 路由：排队中（无会话）的卡回待办；已有会话的卡拒绝取消', async () => {
  const { dir, store } = await freshStore()
  try {
    await store.mutateSettings((ledger) => {
      ledger.settings = { maxParallel: 1 }
      return true
    })
    await seed(store, { title: '在跑', status: 'running', sessionId: 'sess-hold' })
    const task = createTaskRecord({ title: '排队中的卡', actor: { kind: 'user' }, now: 5 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const launcher = recordingLauncher('sess-new')
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 500, launcher: () => launcher })
    const launched = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: task.version }), launched)
    assert.equal(store.get(task.id).status, 'queued')

    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/unqueue`, {
      ifVersion: store.get(task.id).version,
    }), res)
    assert.equal(res.statusCode, 200)
    const after = JSON.parse(res.body).value
    assert.equal(after.status, 'todo')
    assert.equal(after.sessionId, undefined)
    assert.equal(after.queuedAt, undefined)
    assert.match(after.comments[after.comments.length - 1].body, /取消排队/)

    // 已经有会话的排队卡不能取消：没有终止会话的接口，放行只会留下孤儿会话
    const held = await seed(store, { title: '已有会话', status: 'queued', sessionId: 'sess-x' })
    const rejected = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${held.id}/unqueue`, {
      ifVersion: store.get(held.id).version,
    }), rejected)
    assert.equal(rejected.statusCode, 400)
    assert.equal(JSON.parse(rejected.body).error.code, 'invalid_transition')
    assert.equal(store.get(held.id).status, 'queued')
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings 路由：并行上限落账并可持久化；越界报 invalid_input', async () => {
  const { dir, store } = await freshStore()
  try {
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 600, launcher: () => undefined })
    const okRes = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/settings`, { maxParallel: 5 }), okRes)
    assert.equal(okRes.statusCode, 200)
    assert.equal(JSON.parse(okRes.body).value.settings.maxParallel, 5)
    assert.equal(store.snapshot().settings.maxParallel, 5)

    for (const bad of [{ maxParallel: 0 }, { maxParallel: 99 }, { maxParallel: '2' }, {}]) {
      const res = fakeResponse()
      await handler(jsonRequest('POST', `${ROUTE_PREFIX}/settings`, bad), res)
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} 应被拒`)
      assert.equal(JSON.parse(res.body).error.code, 'invalid_input')
    }
    // 非法请求不该改坏已存的值
    assert.equal(store.snapshot().settings.maxParallel, 5)
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch 路由：ifVersion 过期时不建会话，报 version_conflict', async () => {
  const { dir, store } = await freshStore()
  try {
    const task = createTaskRecord({ title: '待办', actor: { kind: 'user' }, now: 1 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const launcher = recordingLauncher('sess-stale')
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 2, launcher: () => launcher })
    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: 999 }), res)
    assert.notEqual(res.statusCode, 201)
    assert.equal(JSON.parse(res.body).error.code, 'version_conflict')
    // 关键：守护发生在开会话之前，过期请求不该留下任何会话
    assert.equal(launcher.calls.create.length, 0)
    assert.equal(launcher.calls.prompt.length, 0)
    assert.equal(store.get(task.id).status, 'todo')
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch 路由：没有 launcher（sessionController 缺失）报 unavailable，503', async () => {
  const { dir, store } = await freshStore()
  try {
    const task = createTaskRecord({ title: '待办', actor: { kind: 'user' }, now: 1 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 2, launcher: () => undefined })
    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, {}), res)
    assert.equal(res.statusCode, 503)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'unavailable')
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 发起会话会把卡片推入队列（queued），所以 queued 本身必须**不可再发起** ——
// 否则同一张卡会排上两个会话，两者抢认领。running/review 同理不可发起。
// 注意 queued 的用例必须带上 sessionId：没有会话的 queued 是「排队中」，
// 调度器会（正确地）给它开会话，那样测的就不是「重复发起」了。
for (const blocked of ['queued', 'running', 'review']) {
  test(`launch 路由：${blocked} 不可发起，报 invalid_transition 且不建会话`, async () => {
    const { dir, store } = await freshStore()
    try {
      const task = createTaskRecord({ title: '非待办卡', actor: { kind: 'user' }, now: 1 })
      await store.mutate('task-created', (ledger) => {
        ledger.tasks.push(task)
        return [task]
      })
      await store.mutate('task-moved', (ledger) => {
        const live = ledger.tasks.find((t) => t.id === task.id)
        live.status = blocked
        if (blocked === 'queued') live.sessionId = 'sess-existing'
        return [live]
      })
      const launcher = recordingLauncher('sess-x')
      const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 2, launcher: () => launcher })
      const res = fakeResponse()
      await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, { ifVersion: 1 }), res)
      assert.equal(res.statusCode, 400)
      assert.equal(JSON.parse(res.body).error.code, 'invalid_transition')
      assert.equal(launcher.calls.create.length, 0)
      assert.equal(launcher.calls.prompt.length, 0)
      dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
