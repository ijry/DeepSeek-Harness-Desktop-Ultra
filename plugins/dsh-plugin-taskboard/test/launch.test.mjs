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

import { createTaskRecord } from '../src/shared/protocol.js'
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

test('launch 路由：创建会话、排队首条消息、任务留备注', async () => {
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
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, {}), res)

    assert.equal(res.statusCode, 201)
    assert.deepEqual(JSON.parse(res.body), { ok: true, value: { sessionId: 'sess-123', taskId: task.id } })
    // 会话创建带上了任务绑定的项目
    assert.deepEqual(launcher.calls.create, [{ workspaceId: 'ws-1' }])
    // 首条消息指向新会话，内容按看板协议引导
    assert.equal(launcher.calls.prompt.length, 1)
    assert.equal(launcher.calls.prompt[0].sessionId, 'sess-123')
    assert.equal(launcher.calls.prompt[0].mode, 'queue')
    assert.match(launcher.calls.prompt[0].content[0].text, /「修登录超时」/)
    // 任务上留下可追溯的备注，版本推进
    const after = store.get(task.id)
    assert.equal(after.version, task.version + 1)
    assert.equal(after.comments.length, 1)
    assert.match(after.comments[0].body, /sess-123/)
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

test('launch 路由：只有 todo/queued 能发起，running 报 invalid_transition', async () => {
  const { dir, store } = await freshStore()
  try {
    const task = createTaskRecord({ title: '进行中', actor: { kind: 'user' }, now: 1 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    await store.mutate('task-moved', (ledger) => {
      const live = ledger.tasks.find((t) => t.id === task.id)
      live.status = 'running'
      return [live]
    })
    const { handler, dispose } = fakeRouteEnv({ store, workspaces: { list: () => [] }, now: () => 2, launcher: () => recordingLauncher('sess-x') })
    const res = fakeResponse()
    await handler(jsonRequest('POST', `${ROUTE_PREFIX}/tasks/${task.id}/launch`, {}), res)
    assert.equal(res.statusCode, 400)
    assert.equal(JSON.parse(res.body).error.code, 'invalid_transition')
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
