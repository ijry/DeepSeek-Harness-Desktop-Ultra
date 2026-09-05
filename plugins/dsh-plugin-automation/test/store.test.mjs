/**
 * Store tests: durability (atomic publish, quarantine, dropped rows), the restart
 * repair that settles runs whose process is gone, the version guard, and pruning.
 * Real files in a temp dir — the write path is the part worth testing against an
 * actual filesystem.
 *
 * @module dsh-plugin-automation/test/store
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AutomationStore } from '../src/host/store.js'
import { createAutomation, defaultSettings, normalizeDraft } from '../src/shared/protocol.js'

const NOW = new Date(2026, 8, 7, 9, 0, 0).getTime()

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-store-'))
  const file = join(dir, 'ledger.json')
  return { dir, file, store: new AutomationStore({ file, now: () => NOW }) }
}

function sampleRecord(patch = {}) {
  const draft = normalizeDraft({
    name: '每日测试',
    prompt: '跑测试',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    action: { kind: 'headless' },
    ...patch,
  }, defaultSettings())
  return createAutomation(draft, { now: NOW, id: patch.id ?? 'auto_1' })
}

test('缺文件时从空账本起步，并且不创建文件', async () => {
  const { dir, store } = await freshStore()
  await store.load()
  assert.deepEqual(store.snapshot().automations, {})
  assert.deepEqual(await readdir(dir), [])
})

test('提交后落盘可读，revision 单调递增', async () => {
  const { file, store } = await freshStore()
  await store.insertAutomation(sampleRecord())
  const first = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(first.revision, 1)
  assert.equal(first.automations.auto_1.name, '每日测试')
  await store.saveSettings({ maxConcurrentRuns: 4 })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 2)
  assert.equal(store.settings().maxConcurrentRuns, 4)
})

test('坏文件被隔离而不是让插件启动失败', async () => {
  const { dir, file, store } = await freshStore()
  await writeFile(file, 'not json at all', 'utf8')
  await store.load()
  assert.deepEqual(store.snapshot().automations, {})
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /\.corrupt-\d+$/)
})

test('看不懂的行被逐条丢掉，其余照常加载', async () => {
  const { file } = await freshStore()
  await writeFile(file, JSON.stringify({
    revision: 7,
    settings: { maxConcurrentRuns: 99 },
    automations: {
      good: { ...sampleRecord({ id: 'good' }) },
      // id mismatch, missing prompt, unparseable cron: three different lies.
      other: { ...sampleRecord({ id: 'nope' }) },
      empty: { id: 'empty', name: 'x', schedule: { kind: 'cron', cron: '0 9 * * *' }, action: { kind: 'headless' }, createdAt: NOW },
      broken: { ...sampleRecord({ id: 'broken' }), schedule: { kind: 'cron', cron: '99 * * * *' } },
    },
    runs: { orphan: { id: 'orphan', automationId: 'gone', status: 'succeeded', createdAt: NOW } },
  }), 'utf8')
  const store = new AutomationStore({ file, now: () => NOW })
  await store.load()
  const ledger = store.snapshot()
  assert.deepEqual(Object.keys(ledger.automations), ['good'])
  // An orphan run has nothing to belong to.
  assert.deepEqual(Object.keys(ledger.runs), [])
  // Out-of-range settings are clamped, not rejected.
  assert.equal(ledger.settings.maxConcurrentRuns, 8)
  assert.equal(ledger.revision, 7)
})

test('上一个进程留下的 running 行在加载时变成「被中断」', async () => {
  const { file } = await freshStore()
  await writeFile(file, JSON.stringify({
    revision: 1,
    settings: defaultSettings(),
    automations: { auto_1: sampleRecord() },
    runs: {
      run_1: { id: 'run_1', automationId: 'auto_1', status: 'running', startedAt: NOW - 60_000, createdAt: NOW - 60_000 },
    },
  }), 'utf8')
  const store = new AutomationStore({ file, now: () => NOW })
  const repaired = await store.flushRepairs()
  assert.equal(repaired, 1)
  const run = store.run('run_1')
  assert.equal(run.status, 'failed')
  assert.match(run.error, /重启/)
  assert.equal(run.durationMs, 60_000)
  // The repair is persisted, so the next reader does not have to re-derive it.
  assert.equal(JSON.parse(await readFile(file, 'utf8')).runs.run_1.status, 'failed')
})

test('版本守卫拦住并发覆盖，删除同样受保护', async () => {
  const { store } = await freshStore()
  await store.insertAutomation(sampleRecord())
  const draft = normalizeDraft({
    name: '改过名', prompt: '跑测试', schedule: { kind: 'manual' }, action: { kind: 'headless' },
  }, defaultSettings())
  await assert.rejects(
    () => store.updateAutomation('auto_1', draft, { now: NOW, ifVersion: 99 }),
    (error) => error.code === 'conflict',
  )
  const updated = await store.updateAutomation('auto_1', draft, { now: NOW, ifVersion: 1 })
  assert.equal(updated.version, 2)
  assert.equal(updated.name, '改过名')
  // The rename must not have touched the counters.
  assert.equal(updated.runCount, 0)
  await assert.rejects(
    () => store.deleteAutomation('auto_1', { ifVersion: 1 }),
    (error) => error.code === 'conflict',
  )
  assert.equal(await store.deleteAutomation('auto_1', { ifVersion: 2 }), true)
  assert.equal(await store.deleteAutomation('auto_1', {}), false)
})

test('历史按上限修剪，但正在跑的那条永不修剪', async () => {
  const { store } = await freshStore()
  await store.saveSettings({ keepRunsPerAutomation: 2 })
  await store.insertAutomation(sampleRecord({ schedule: { kind: 'manual' } }))
  const opened = []
  for (let index = 0; index < 4; index += 1) {
    const { run } = await store.beginRun('auto_1', { now: NOW + index * 1000, trigger: 'manual' })
    opened.push(run)
    await store.finishRun(run.id, { status: 'succeeded', now: NOW + index * 1000 + 10 })
  }
  const { run: live } = await store.beginRun('auto_1', { now: NOW + 9000, trigger: 'manual' })
  assert.equal(live.status, 'running')
  const rows = Object.values(store.snapshot().runs)
  assert.equal(rows.filter((row) => row.status === 'running').length, 1)
  assert.ok(rows.length <= 3, `修剪后应当只剩上限加在跑的那条，实际 ${rows.length}`)
  assert.ok(store.run(live.id) !== undefined)
  // The oldest finished run is the one that went.
  assert.equal(store.run(opened[0].id), undefined)
})

test('删除自动化会连带忘掉它的运行历史', async () => {
  const { store } = await freshStore()
  await store.insertAutomation(sampleRecord({ schedule: { kind: 'manual' } }))
  const { run } = await store.beginRun('auto_1', { now: NOW, trigger: 'manual' })
  await store.finishRun(run.id, { status: 'succeeded', now: NOW + 10 })
  await store.deleteAutomation('auto_1', {})
  assert.deepEqual(store.snapshot().runs, {})
})
