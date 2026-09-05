/**
 * Engine + store integration: the firing pipeline as a whole. The child process is
 * replaced by a controllable seam (`startRun`) so the test can hold a run open,
 * settle it on command, and observe every ledger transition; the clock is a
 * variable, because a scheduler tested against the real clock tests nothing.
 *
 * @module dsh-plugin-automation/test/engine
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AutomationEngine } from '../src/host/engine.js'
import { AutomationStore } from '../src/host/store.js'
import { createAutomation, defaultSettings, normalizeDraft } from '../src/shared/protocol.js'

/** 2026-09-07 09:00 local, a Monday — every cron in here is weekday-shaped. */
const MONDAY_9AM = new Date(2026, 8, 7, 9, 0, 0).getTime()

/** A child stand-in: `settle(outcome)` finishes it, `killed` records the signal. */
function fakeChild() {
  const state = { killed: undefined }
  let resolve
  const done = new Promise((inner) => {
    resolve = inner
  })
  return {
    state,
    handle: {
      pid: 4242,
      kill(reason) {
        state.killed = reason
        resolve({ status: reason === 'timeout' ? 'timeout' : 'canceled', output: '', error: '已终止' })
      },
      done,
    },
    settle(outcome) {
      resolve(outcome)
    },
  }
}

async function harness(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-eng-'))
  const file = join(dir, 'ledger.json')
  const clock = { now: MONDAY_9AM }
  const now = () => clock.now
  const store = new AutomationStore({ file, now })
  const children = []
  const cards = []
  const engine = new AutomationEngine({
    store,
    workspaces: { get: () => ({ id: 'ws1', path: dir, title: 'proj' }), list: () => [] },
    taskboardBase: () => 'http://127.0.0.1:1234',
    now,
    cliEntry: { command: 'node', prefix: ['fake'] },
    startRun: overrides.startRun ?? (async () => {
      const child = fakeChild()
      children.push(child)
      return child.handle
    }),
    fileCard: overrides.fileCard ?? (async (spec) => {
      cards.push(spec)
      return { id: 'task_1', title: spec.automation.name }
    }),
    ...overrides.engine,
  })
  return { dir, file, clock, store, engine, children, cards }
}

/** Insert one automation straight into the ledger. */
async function seed(store, patch, now) {
  const draft = normalizeDraft({
    name: '每日测试',
    prompt: '跑测试',
    schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
    action: { kind: 'headless' },
    workspaceId: 'ws1',
    ...patch,
  }, defaultSettings())
  const record = createAutomation(draft, { now, id: patch?.id ?? 'auto_1' })
  await store.insertAutomation(record)
  return store.automation(record.id)
}

test('到点触发一次运行，结算后计数与下一次时间都前移', async () => {
  const { clock, store, engine, children } = await harness()
  const record = await seed(store, {}, clock.now)
  // Created at 09:00 Monday, so the next slot is Tuesday 09:00.
  clock.now = record.nextRunAt
  await engine.tick()
  const opened = store.snapshot()
  const running = Object.values(opened.runs)
  assert.equal(running.length, 1)
  assert.equal(running[0].status, 'running')
  assert.equal(running[0].trigger, 'schedule')
  // The slot moved forward the moment the run opened, so the next tick is quiet.
  assert.ok(store.automation('auto_1').nextRunAt > clock.now)

  clock.now += 90_000
  // Hold the settlement promise before finishing: the engine drops its in-flight
  // entry as part of settling, and the ledger write is real file I/O.
  const live = [...engine.inFlight.values()][0]
  children[0].settle({ status: 'succeeded', exitCode: 0, output: '3 passed', sessionId: 'session-x' })
  await live.settled
  const settled = Object.values(store.snapshot().runs)[0]
  assert.equal(settled.status, 'succeeded')
  assert.equal(settled.durationMs, 90_000)
  assert.equal(settled.sessionId, 'session-x')
  const after = store.automation('auto_1')
  assert.equal(after.runCount, 1)
  assert.equal(after.failureCount, 0)
  assert.equal(after.lastStatus, 'succeeded')
})

test('上一次还没结束时默认跳过，并留下一条 skipped 记录', async () => {
  const { clock, store, engine } = await harness()
  const record = await seed(store, {}, clock.now)
  clock.now = record.nextRunAt
  await engine.tick()
  // Fire again by hand while the first run is still open.
  const skipped = await engine.runNow('auto_1')
  assert.equal(skipped.status, 'skipped')
  assert.match(skipped.error, /上一次运行还没结束/)
  const runs = Object.values(store.snapshot().runs)
  assert.equal(runs.filter((run) => run.status === 'running').length, 1)
  assert.equal(runs.filter((run) => run.status === 'skipped').length, 1)
})

test('overlap=cancel 时新的一次会先终止旧的', async () => {
  const { clock, store, engine, children } = await harness()
  await seed(store, { overlap: 'cancel' }, clock.now)
  await engine.runNow('auto_1')
  clock.now += 1000
  await engine.runNow('auto_1')
  assert.equal(children[0].state.killed, 'cancel')
  const runs = Object.values(store.snapshot().runs).sort((a, b) => a.createdAt - b.createdAt)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].status, 'canceled')
  assert.equal(runs[1].status, 'running')
})

test('错过的时间点默认丢弃并记一条，catchUp 打开时补跑一次', async () => {
  const dropped = await harness()
  const record = await seed(dropped.store, {}, dropped.clock.now)
  // Wake up two days later: the Tuesday slot came due while the host was down.
  dropped.clock.now = record.nextRunAt + 2 * 24 * 3600_000
  await dropped.engine.tick()
  const droppedRuns = Object.values(dropped.store.snapshot().runs)
  assert.equal(droppedRuns.length, 1)
  assert.equal(droppedRuns[0].status, 'skipped')
  assert.match(droppedRuns[0].error, /错过/)
  assert.equal(dropped.children.length, 0)
  assert.ok(dropped.store.automation('auto_1').nextRunAt > dropped.clock.now)

  const caught = await harness()
  const armed = await seed(caught.store, { catchUp: true }, caught.clock.now)
  caught.clock.now = armed.nextRunAt + 2 * 24 * 3600_000
  await caught.engine.tick()
  const caughtRuns = Object.values(caught.store.snapshot().runs)
  assert.equal(caughtRuns.length, 1)
  assert.equal(caughtRuns[0].status, 'running')
  assert.equal(caughtRuns[0].trigger, 'catchup')
})

test('总开关关掉后定时不再触发，但「立即运行」仍然可用', async () => {
  const { clock, store, engine } = await harness()
  const record = await seed(store, {}, clock.now)
  await store.saveSettings({ enabled: false })
  clock.now = record.nextRunAt
  await engine.tick()
  assert.equal(Object.keys(store.snapshot().runs).length, 0)
  const run = await engine.runNow('auto_1')
  assert.equal(run.status, 'running')
})

test('并发上限之外的触发被跳过', async () => {
  const { clock, store, engine } = await harness()
  await store.saveSettings({ maxConcurrentRuns: 1 })
  await seed(store, { id: 'auto_1' }, clock.now)
  await seed(store, { id: 'auto_2', name: '另一条' }, clock.now)
  assert.equal((await engine.runNow('auto_1')).status, 'running')
  const second = await engine.runNow('auto_2')
  assert.equal(second.status, 'skipped')
  assert.match(second.error, /上限/)
})

test('连续失败达到阈值后自动暂停，重新启用会清掉连败', async () => {
  const { clock, store, engine, children } = await harness()
  await store.saveSettings({ autoDisableAfterFailures: 2 })
  await seed(store, {}, clock.now)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await engine.runNow('auto_1')
    const live = [...engine.inFlight.values()][0]
    children[attempt].settle({ status: 'failed', exitCode: 1, error: '炸了' })
    await live.settled
    clock.now += 60_000
  }
  const parked = store.automation('auto_1')
  assert.equal(parked.enabled, false)
  assert.equal(parked.consecutiveFailures, 2)
  assert.match(parked.pausedReason, /自动暂停/)
  assert.equal(parked.nextRunAt, undefined)

  const revived = await store.setEnabled('auto_1', true, { now: clock.now })
  assert.equal(revived.consecutiveFailures, 0)
  assert.equal(revived.pausedReason, undefined)
  assert.ok(Number.isFinite(revived.nextRunAt))
})

test('投递到任务看板的运行立刻结算，并记下卡片 id', async () => {
  const { clock, store, engine, cards } = await harness()
  await seed(store, { action: { kind: 'taskboard' }, schedule: { kind: 'manual' } }, clock.now)
  const run = await engine.runNow('auto_1')
  assert.equal(run.status, 'succeeded')
  assert.equal(run.taskId, 'task_1')
  assert.equal(cards.length, 1)
  // The standing preamble travels with the card, not just with a headless run.
  assert.match(cards[0].prompt, /无人值守/)
})

test('任务看板不可用时运行落到 failed，原因写进历史', async () => {
  const { clock, store, engine } = await harness({
    fileCard: async () => {
      throw new Error('没有装任务看板插件（dsh-plugin-taskboard）')
    },
  })
  await seed(store, { action: { kind: 'taskboard' }, schedule: { kind: 'manual' } }, clock.now)
  const run = await engine.runNow('auto_1')
  assert.equal(run.status, 'failed')
  assert.match(run.error, /任务看板/)
})

test('自动化启动的子进程里调度器不启动（否则每次触发都会分叉一个调度器）', async () => {
  const { store, engine } = await harness({ engine: { env: { DSH_PLUGIN_AUTOMATION_CHILD: '1' } } })
  await seed(store, {}, Date.now())
  engine.start()
  assert.equal(engine.timer, undefined)
  assert.equal(engine.stopped, true)
})

test('找不到 dsh 启动器时运行立刻失败，并说清怎么修', async () => {
  const { clock, store, engine } = await harness({ engine: { cliEntry: null } })
  await seed(store, { schedule: { kind: 'manual' } }, clock.now)
  const run = await engine.runNow('auto_1')
  assert.equal(run.status, 'failed')
  assert.match(run.error, /DSH_PLUGIN_AUTOMATION_DSH_ENTRY/)
  assert.equal(engine.status().cliAvailable, false)
})
