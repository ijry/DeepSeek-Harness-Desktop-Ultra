/**
 * 会话视图测试：把 dsh 的两个真实服务（workspaceRegistry / sessionQuery）换成
 * 替身，钉住归一之后的那份形状——工作区归属、标题的批量结果怎么读、子会话怎么
 * 标记、缓存与失败重试，以及给账本用的三个同步判定。
 *
 * 这一层是整个插件里最容易「接错上游字段名」的地方：接错了不报错，只是每张卡片
 * 都显示未命名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionsView, DEFAULT_AGENT } from '../src/host/sessions.js'

/** 一个工作区注册表替身。 */
const registry = (workspaces) => ({
  list: () => workspaces,
  archivedSessionIds: [],
})

/** 一个 sessionQuery 替身：listSessions 给头，readTitleSnapshots 给标题。 */
function query(headers, titles = {}) {
  const calls = { titleBatches: [] }
  return {
    calls,
    async listSessions() {
      return headers.map((header) => ({ header, live: header.id === 'session-a', persisted: true }))
    },
    async readTitleSnapshots(ids) {
      calls.titleBatches.push([...ids])
      return ids.map((id) =>
        titles[id] === undefined
          ? { sessionId: id, status: 'rejected', reason: new Error('log gone') }
          : { sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: titles[id] } } }
      )
    },
  }
}

/** 把 DSH_HOME 指到空目录，别让测试去翻真实的会话日志。 */
async function withHome(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-canvas-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    await run()
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    await rm(dir, { recursive: true, force: true })
  }
}

test('归一之后：工作区归属、agentPreset、标题、子会话标记', async () => {
  await withHome(async () => {
    const ws = { id: 'w1', path: 'D:/repo', title: '仓库', createdAt: '', updatedAt: '', sessionIds: ['session-a'] }
    const view = createSessionsView({
      workspaceRegistry: registry([ws]),
      sessionQuery: query(
        [
          { id: 'session-a', createdAt: 100, cwd: 'D:/repo', agentPreset: 'standard' },
          { id: 'session-b', createdAt: 200, cwd: 'D:/other' },
          { id: 'session-c', createdAt: 300, origin: 'subagent', parentSession: 'session-a' },
        ],
        { 'session-a': '第一个会话' }
      ),
    })
    const snapshot = await view.snapshot()
    const byId = new Map(snapshot.sessions.map((s) => [s.id, s]))

    assert.equal(byId.get('session-a').workspace, 'w1')
    assert.equal(byId.get('session-a').agentType, 'standard')
    assert.equal(byId.get('session-a').title, '第一个会话')
    assert.equal(byId.get('session-a').live, true)
    // 没登记在任何工作区里的会话仍然在列表里，只是没有工作区。
    assert.equal(byId.get('session-b').workspace, null)
    assert.equal(byId.get('session-b').agentType, DEFAULT_AGENT)
    // 标题读失败的那两个不缓存，留着下次重试。
    assert.equal(byId.get('session-b').title, null)
    // 子会话是「某个会话的内部结构」，画布上不算同级。
    assert.equal(byId.get('session-c').kind, 'delegate')
    assert.equal(byId.get('session-c').parentId, 'session-a')

    // 只有创建时间可用时，updatedAt 退回创建时间，并按它降序。
    assert.deepEqual(
      snapshot.sessions.map((s) => s.id),
      ['session-c', 'session-b', 'session-a']
    )
    // 智能体列表是「预设 ∪ 会话里真的用到的」。
    assert.deepEqual(snapshot.agents.map((a) => a.id).sort(), [DEFAULT_AGENT, 'standard'])
    assert.deepEqual(snapshot.workspaces[0].sessionIds, ['session-a'])
  })
})

test('标题成功的会被缓存，失败的下次还会再问一遍', async () => {
  await withHome(async () => {
    const q = query([{ id: 'session-a', createdAt: 1 }, { id: 'session-b', createdAt: 2 }], {
      'session-a': '有标题',
    })
    const view = createSessionsView({ workspaceRegistry: registry([]), sessionQuery: q })
    await view.snapshot()
    await view.snapshot(true)
    assert.equal(q.calls.titleBatches.length, 2)
    assert.deepEqual(q.calls.titleBatches[0], ['session-b', 'session-a'])
    // 第二轮只再问失败的那个。
    assert.deepEqual(q.calls.titleBatches[1], ['session-b'])
  })
})

test('没有 sessionQuery 时退回工作区账，画布仍然能用', async () => {
  await withHome(async () => {
    const ws = { id: 'w1', path: 'D:/repo', title: '仓库', createdAt: '', updatedAt: '', sessionIds: ['s1', 's2'] }
    const view = createSessionsView({ workspaceRegistry: registry([ws]) })
    const snapshot = await view.snapshot()
    // 这条路径上一个时间戳都没有，排序只剩「id 降序」这个确定性兜底。
    assert.deepEqual(snapshot.sessions.map((s) => s.id), ['s2', 's1'])
    const first = snapshot.sessions.find((s) => s.id === 's1')
    assert.equal(first.workspace, 'w1')
    assert.equal(first.cwd, 'D:/repo')
  })
})

test('给账本用的三个同步判定：冷启动放行，热起来之后照实说', async () => {
  await withHome(async () => {
    const view = createSessionsView({
      workspaceRegistry: registry([
        { id: 'w1', path: 'D:/r', title: 'r', createdAt: '', updatedAt: '', sessionIds: [] },
      ]),
      sessionQuery: query([{ id: 'session-a', createdAt: 1 }]),
    })
    // 还没建立视图时 fail-open：否则刚建的会话会没法拖上板子。
    assert.equal(view.sessionIsLive('随便'), true)
    assert.equal(view.workspaceExists('随便'), true)
    assert.deepEqual(view.missingFrom([{ kind: 'session', sessionId: 'gone', memberIds: [] }]), [])

    await view.snapshot()
    assert.equal(view.sessionIsLive('session-a'), true)
    assert.equal(view.sessionIsLive('ghost'), false)
    assert.equal(view.workspaceExists('w1'), true)
    assert.equal(view.workspaceExists('w2'), false)
    assert.deepEqual(
      view.missingFrom([
        { kind: 'session', sessionId: 'gone', memberIds: [] },
        { kind: 'custom', memberIds: ['session-a', 'also-gone'] },
      ]),
      ['gone', 'also-gone']
    )
  })
})
