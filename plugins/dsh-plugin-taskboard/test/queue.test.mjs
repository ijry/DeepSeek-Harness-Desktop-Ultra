/**
 * 队列调度器（host/queue.js）单测：额度门控、FIFO 顺序、空位腾出后补位、
 * 失败不自旋、缺 launcher 时安静退出。
 *
 * 这里对真实 TaskStore（临时目录账本）跑，launcher 是记录调用的桩——不需要 dsh
 * 宿主，也不依赖订阅时序（pump() 由测试显式 await）。
 *
 * @module dsh-plugin-taskboard/test/queue
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskRecord } from '../src/shared/protocol.js'
import { TaskStore } from '../src/host/store.js'
import { createQueuePump } from '../src/host/queue.js'

// 备注文案跟随宿主语言；测试固定中文，避免开发机 locale 漂移。
process.env.DSH_DESKTOP_LANG = 'zh'

async function freshStore(maxParallel) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cgtb-queue-'))
  const store = new TaskStore({ file: join(dir, 'ledger.json') })
  await store.load()
  if (maxParallel !== undefined) {
    await store.mutateSettings((ledger) => {
      ledger.settings = { maxParallel }
      return true
    })
  }
  return { dir, store }
}

/** 会话 id 递增的桩，方便断言「为谁开了会话」。 */
function sequenceLauncher(options) {
  const calls = { create: [], prompt: [] }
  let n = 0
  return {
    calls,
    async createSession(payload) {
      calls.create.push(payload)
      if (options?.failOnCreate === true) throw new Error('boom: session refused')
      n += 1
      return { sessionId: `sess-${n}` }
    },
    async prompt(payload) {
      calls.prompt.push(payload)
      return { ok: true }
    },
  }
}

/** 直接造一张指定状态 / 会话的卡。 */
async function seed(store, id, fields) {
  const task = createTaskRecord({
    title: id,
    workspaceId: fields.workspaceId ?? '',
    actor: { kind: 'user' },
    now: 1,
  })
  task.id = id
  task.status = fields.status ?? 'todo'
  if (fields.sessionId !== undefined) task.sessionId = fields.sessionId
  if (fields.queuedAt !== undefined) task.queuedAt = fields.queuedAt
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })
  return task
}

/** 一个新的 pump，绑定给定 store 与 launcher 解析器。 */
function pumpFor(store, resolveLauncher) {
  return createQueuePump({ store, resolveLauncher, now: () => 1000 })
}

test('有空位就开会话：从最久排队的卡开始，排满即止', async () => {
  const { dir, store } = await freshStore(2)
  try {
    // 一张会话在干活的卡占掉 1 个额度
    await seed(store, 'busy', { status: 'preparing', sessionId: 'sess-busy' })
    // 两张排队中，late 比 early 更晚入队
    await seed(store, 'late', { status: 'queued', queuedAt: 200 })
    await seed(store, 'early', { status: 'queued', queuedAt: 100 })
    const launcher = sequenceLauncher()
    const pump = pumpFor(store, () => launcher)

    const result = await pump.pump()
    assert.deepEqual(result.started, [{ id: 'early', sessionId: 'sess-1' }])
    assert.deepEqual(result.failures, [])
    assert.equal(launcher.calls.create.length, 1, '只有 1 个空位，只该开 1 场会话')
    // FIFO：先来先服务
    assert.equal(store.get('early').sessionId, 'sess-1')
    assert.equal(store.get('late').sessionId, undefined, '额度用满后第二张继续排队')
    // 会话备注与排队时钟：有会话就不再是「排队中」
    const early = store.get('early')
    assert.equal(early.comments.length, 1)
    assert.match(early.comments[0].body, /sess-1/)
    assert.equal(early.queuedAt, undefined)
    // 首条消息指向卡片本身
    assert.equal(launcher.calls.prompt[0].sessionId, 'sess-1')
    assert.equal(launcher.calls.prompt[0].mode, 'queue')
    assert.match(launcher.calls.prompt[0].content[0].text, /early/)
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('空位腾出后补位；已经排上的卡不会被重复发起', async () => {
  const { dir, store } = await freshStore(1)
  try {
    await seed(store, 'busy', { status: 'running', sessionId: 'sess-busy' })
    await seed(store, 'waiting', { status: 'queued', queuedAt: 5 })
    const launcher = sequenceLauncher()
    const pump = pumpFor(store, () => launcher)

    // 额度被占：什么都不该发生
    const blocked = await pump.pump()
    assert.deepEqual(blocked.started, [])
    assert.equal(launcher.calls.create.length, 0)

    // 在跑的卡交验/验收后让出额度
    await store.mutate('task-moved', (ledger) => {
      const task = ledger.tasks.find((t) => t.id === 'busy')
      task.status = 'review'
      return [task]
    })
    const first = await pump.pump()
    assert.deepEqual(first.started, [{ id: 'waiting', sessionId: 'sess-1' }])

    // 再 pump 一次不会给同一张卡开第二场会话（它已有会话、占着额度）
    const again = await pump.pump()
    assert.deepEqual(again.started, [])
    assert.equal(launcher.calls.create.length, 1)
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开会话失败：记录 failure、结束本轮（不自旋），卡片留在队列里', async () => {
  const { dir, store } = await freshStore(3)
  try {
    await seed(store, 'waiting', { status: 'queued', queuedAt: 1 })
    const launcher = sequenceLauncher({ failOnCreate: true })
    const pump = pumpFor(store, () => launcher)

    const result = await pump.pump()
    assert.deepEqual(result.started, [])
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].id, 'waiting')
    assert.match(result.failures[0].message, /boom/)
    // 关键：失败只试一次，绝不空转重试
    assert.equal(launcher.calls.create.length, 1)
    // 卡片原样留在队列里，用户可取消排队或修好原因后改动看板触发新一轮
    const after = store.get('waiting')
    assert.equal(after.status, 'queued')
    assert.equal(after.sessionId, undefined)
    assert.equal(after.comments.length, 0)
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有 launcher（组合缺 sessionController）时安静返回，不改账本', async () => {
  const { dir, store } = await freshStore(3)
  try {
    await seed(store, 'waiting', { status: 'queued', queuedAt: 1 })
    const revision = store.revision
    const pump = pumpFor(store, () => undefined)
    const result = await pump.pump()
    assert.deepEqual(result, { started: [], failures: [] })
    assert.equal(store.revision, revision)
    assert.equal(store.get('waiting').sessionId, undefined)
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有 launcher 空跑一轮后调度器不得假死：服务随后挂上时照常开会话', async () => {
  const { dir, store } = await freshStore(1)
  try {
    await seed(store, 'waiting', { status: 'queued', queuedAt: 1 })
    const launcher = sequenceLauncher()
    // 组合通常在插件之后才挂上 sessionController：插件加载时的补跑跑不到 launcher。
    let available
    const pump = createQueuePump({ store, resolveLauncher: () => available, now: () => 1000 })

    const before = await pump.pump()
    assert.deepEqual(before, { started: [], failures: [] }, '没有 launcher 时安静返回')

    // 回归：runPasses() 在这条路径上会「一个 await 都不过」同步 return，
    // 若把 promise 直接内联赋给 running，清理会先于赋值执行、running 永久停在
    // 已完成的 promise 上，此后每次 pump 都以为有一轮在跑，队列彻底不动。
    available = launcher
    const after = await pump.pump()
    assert.deepEqual(after.started, [{ id: 'waiting', sessionId: 'sess-1' }])
    assert.equal(launcher.calls.create.length, 1)
    assert.equal(store.get('waiting').sessionId, 'sess-1')
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('在一轮刚结束的同一 tick 里再派发：请求不丢，会补跑一轮', async () => {
  const { dir, store } = await freshStore(1)
  try {
    await seed(store, 'waiting', { status: 'queued', queuedAt: 1 })
    const launcher = sequenceLauncher()
    let available
    const pump = createQueuePump({ store, resolveLauncher: () => available, now: () => 1000 })

    // 两次调用落在同一个 tick：第二次只能并入第一次（rerun），第一次已经
    // 同步走完。并入的请求不能被吞掉。
    const first = pump.pump()
    available = launcher
    const second = pump.pump()
    await first
    await second

    const deadline = Date.now() + 2000
    while (launcher.calls.create.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(launcher.calls.create.length, 1, '并入的调度请求必须补跑')
    assert.equal(store.get('waiting').sessionId, 'sess-1')
    pump.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dispose 之后不再调度（插件卸载后不该冒出会话）', async () => {
  const { dir, store } = await freshStore(3)
  try {
    await seed(store, 'waiting', { status: 'queued', queuedAt: 1 })
    const launcher = sequenceLauncher()
    const pump = pumpFor(store, () => launcher)
    pump.dispose()
    const result = await pump.pump()
    assert.deepEqual(result, { started: [], failures: [] })
    assert.equal(launcher.calls.create.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
