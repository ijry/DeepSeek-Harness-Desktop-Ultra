/**
 * Host-row tests for dsh-plugin-taskboard: version guards / lookup helpers
 * used by every tool + route mutation, and the serial TaskStore ledger that
 * backs the board (persist + reload + subscriber broadcast).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRecord } from '../src/shared/protocol.js'
import { LedgerChange, TaskStore } from '../src/host/store.js'
import { ERR, ToolError, liveTaskAt, versionGuard } from '../src/host/tools.js'

test('版本守卫：缺失/过期抛 version_conflict，一致时放行', () => {
  const task = { id: 't1', version: 3 }
  assert.equal(versionGuard(task, 3), undefined)
  assert.throws(() => versionGuard(task, 2), (error) => {
    return error instanceof ToolError && error.code === ERR.versionConflict
  })
  assert.throws(() => versionGuard(task, undefined), (error) => {
    return error instanceof ToolError && error.code === ERR.versionConflict
  })
})

test('liveTaskAt：找到返回任务，缺失抛 not_found', () => {
  const task = { id: 't1', version: 1 }
  assert.equal(liveTaskAt({ tasks: [task] }, 't1'), task)
  assert.throws(() => liveTaskAt({ tasks: [] }, 'missing'), (error) => {
    return error instanceof ToolError && error.code === ERR.notFound
  })
})

test('TaskStore：串行提交持久化、递增修订并广播 LedgerChange', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cgtb-host-'))
  const file = join(dir, 'ledger.json')
  try {
    const store = new TaskStore({ file })
    const changes = []
    const unsubscribe = store.subscribe((change) => changes.push(change))
    const created = createTaskRecord({ title: '任务甲', actor: { kind: 'user' }, now: 100 })

    const first = await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(created)
      return [created]
    })
    assert.equal(first.committed, true)
    assert.equal(store.revision, 1)
    assert.equal(changes.length, 1)
    assert.ok(changes[0] instanceof LedgerChange)
    assert.equal(changes[0].revision, 1)
    assert.equal(changes[0].kind, 'task-created')
    assert.equal(changes[0].tasks[0].id, created.id)

    const again = new TaskStore({ file })
    await again.load()
    assert.equal(again.revision, 1)
    const reloaded = again.get(created.id)
    assert.equal(reloaded.title, '任务甲')
    assert.equal(reloaded.status, 'todo')
    unsubscribe()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot 与 get 返回深度冻结副本，内部状态不受调用方影响', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cgtb-snap-'))
  const store = new TaskStore({ file: join(dir, 'ledger.json') })
  try {
    await store.load()
    const snapshot = store.snapshot()
    assert.throws(() => snapshot.tasks.push({}), TypeError)
    assert.equal(store.snapshot().revision, 0)
    const task = createTaskRecord({ title: '冻结', actor: { kind: 'agent', sessionId: 's' }, now: 1 })
    await store.mutate('task-created', (ledger) => {
      ledger.tasks.push(task)
      return [task]
    })
    const frozen = store.get(task.id)
    assert.throws(() => { frozen.title = 'mutated' }, TypeError)
    assert.equal(store.get(task.id).title, '冻结')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
