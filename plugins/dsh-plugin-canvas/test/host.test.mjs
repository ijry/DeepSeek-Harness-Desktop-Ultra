/**
 * host 行为测试：账本的 revision 协议（一次提交一次 +1、空操作不消耗）、
 * 崩坏文件隔离与 id 不复用，以及八个变更各自的不变量——尤其是
 * codeg-plus 里那几条「不能悄悄毁掉用户唯一入口」的守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/host/store.js'
import {
  createNode,
  deleteNode,
  deleteNodes,
  detachMember,
  groupIntoRegion,
  moveNodes,
  pruneForSessions,
  updateNode,
} from '../src/host/board.js'
import { readTranscript } from '../src/host/transcript.js'
import { CARD_HEIGHT, CARD_WIDTH, regionHeightForRows, regionWidthForColumns } from '../src/shared/units.js'

const NOW = '2026-09-05T00:00:00.000Z'
const ctx = { now: () => NOW, sessionIsLive: () => true, workspaceExists: () => true }

/** A fresh draft, as the store hands it to a mutator. */
const draft = (over = {}) => ({ schemaVersion: 1, revision: 0, nextId: 1, nodes: [], ...over })

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-canvas-'))
  try {
    await run(new CanvasStore({ file: join(dir, 'ledger.json') }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('一次提交把 revision 加一，空操作既不写盘也不占号', async () => {
  await withStore(async (store) => {
    const created = await store.mutate((d) => createNode(d, { kind: 'note' }, ctx))
    assert.equal(created.committed, true)
    assert.equal(created.revision, 1)
    assert.equal(created.change.kind, 'upsert')

    const noop = await store.mutate(() => undefined)
    assert.equal(noop.committed, false)
    assert.equal(noop.revision, 1)

    // 同值 patch 也是空操作：客户端会把响应里的 revision 与自己的比，不会误判 gap。
    const same = await store.mutate((d) => updateNode(d, 1, { collapsed: false }, ctx))
    assert.equal(same.committed, false)
    assert.equal(store.revision, 1)
  })
})

test('订阅者收到的每个变更都带自己的 revision，且是冻结的', async () => {
  await withStore(async (store) => {
    const seen = []
    store.subscribe((change) => seen.push(change))
    await store.mutate((d) => createNode(d, { kind: 'note' }, ctx))
    await store.mutate((d) => createNode(d, { kind: 'custom' }, ctx))
    assert.deepEqual(seen.map((c) => c.revision), [1, 2])
    assert.equal(Object.isFrozen(seen[0]), true)
  })
})

test('账本落盘后能原样读回，崩坏的文件被隔离而不是让画布起不来', async () => {
  await withStore(async (store, dir) => {
    await store.mutate((d) => createNode(d, { kind: 'note', x: 10, y: 20 }, ctx))
    const raw = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
    assert.equal(raw.nodes.length, 1)
    assert.equal(raw.revision, 1)

    const reopened = new CanvasStore({ file: join(dir, 'ledger.json') })
    await reopened.load()
    assert.equal(reopened.snapshot().nodes[0].x, 10)
    assert.equal(reopened.revision, 1)

    await writeFile(join(dir, 'broken.json'), '{ 这不是 JSON', 'utf8')
    const broken = new CanvasStore({ file: join(dir, 'broken.json') })
    await broken.load()
    assert.deepEqual(broken.snapshot().nodes, [])
  })
})

test('损坏的行被丢掉，且分配的 id 绝不会撞上存活的行', async () => {
  await withStore(async (store, dir) => {
    const file = join(dir, 'mixed.json')
    await writeFile(
      file,
      JSON.stringify({
        revision: 7,
        // nextId 落后于实际最大 id——手改过或写盘被截断都可能这样。
        nextId: 2,
        nodes: [
          { id: 9, kind: 'note', memberIds: [], x: 0, y: 0, width: 100, height: 100 },
          { id: 10, kind: '不存在的 kind', memberIds: [], x: 0, y: 0, width: 1, height: 1 },
          { id: 11, kind: 'note', memberIds: [], x: Number.NaN, y: 0, width: 1, height: 1 },
        ],
      }),
      'utf8'
    )
    const loaded = new CanvasStore({ file })
    await loaded.load()
    assert.deepEqual(loaded.snapshot().nodes.map((n) => n.id), [9])
    const created = await loaded.mutate((d) => createNode(d, { kind: 'note' }, ctx))
    assert.equal(created.change.node.id, 10)
  })
})

// ── 八个变更 ──

test('创建时绑定目标必须存在：会话没了、工作区没了都拒绝', () => {
  const dead = { ...ctx, sessionIsLive: () => false }
  assert.throws(
    () => createNode(draft(), { kind: 'session', sessionId: 'gone' }, dead),
    /does not exist/
  )
  const noWorkspace = { ...ctx, workspaceExists: () => false }
  assert.throws(
    () => createNode(draft(), { kind: 'workspace', workspace: 'w1' }, noWorkspace),
    /workspace w1 not found/
  )
})

test('批量移动跳过已消失的 id、夹取坐标，并回报「真的写下去的」值', () => {
  const d = draft()
  createNode(d, { kind: 'note' }, ctx)
  const change = moveNodes(d, [{ id: 1, x: 1e9, y: 5 }, { id: 999, x: 0, y: 0 }], ctx)
  assert.deepEqual(change.moves, [{ id: 1, x: 1000000, y: 5 }])
  assert.equal(d.nodes[0].x, 1000000)
  // 一个都没写下去就不该有事件。
  assert.equal(moveNodes(d, [{ id: 999, x: 0, y: 0 }], ctx), undefined)
  assert.equal(moveNodes(d, [], ctx), undefined)
})

test('从自定义区域拖出成员：移除 + 建卡是一次变更，重放会 not_found', () => {
  const d = draft()
  const region = createNode(d, { kind: 'custom' }, ctx).node
  region.memberIds = ['s1']
  const change = detachMember(d, region.id, 's1', 300, 400, ctx)
  assert.equal(change.kind, 'detached')
  assert.equal(change.removedFrom, region.id)
  assert.deepEqual(region.memberIds, [])
  assert.equal(change.node.kind, 'session')
  assert.equal(change.node.sessionId, 's1')
  assert.deepEqual([change.node.width, change.node.height], [CARD_WIDTH, CARD_HEIGHT])
  assert.throws(() => detachMember(d, region.id, 's1', 0, 0, ctx), /not a member/)
})

test('从绑定区域拖出成员是「复制」：没有成员可移除，也不该报错', () => {
  const d = draft()
  const region = createNode(d, { kind: 'workspace', workspace: 'w1' }, ctx).node
  const change = detachMember(d, region.id, 's1', 0, 0, ctx)
  assert.equal(change.removedFrom, null)
  assert.equal(change.node.sessionId, 's1')
  // 便签不是区域。
  const note = createNode(d, { kind: 'note' }, ctx).node
  assert.throws(() => detachMember(d, note.id, 's1', 0, 0, ctx), /not a region/)
})

test('收进新区域：去重保序、吞掉被收的卡片、几何必须四件齐全', () => {
  const d = draft()
  const pinA = createNode(d, { kind: 'session', sessionId: 's1' }, ctx).node
  const pinB = createNode(d, { kind: 'session', sessionId: 's2' }, ctx).node
  const change = groupIntoRegion(
    d,
    {
      memberIds: ['s1', 's2', 's1'],
      consumeNodeIds: [pinA.id, pinB.id],
      gridColumns: 2,
      x: 10,
      y: 20,
      width: regionWidthForColumns(2),
      height: regionHeightForRows(1),
    },
    ctx
  )
  assert.equal(change.kind, 'grouped')
  assert.deepEqual(change.node.memberIds, ['s1', 's2'])
  assert.deepEqual(change.deletedIds.sort(), [pinA.id, pinB.id].sort())
  assert.deepEqual(d.nodes.map((n) => n.kind), ['custom'])
  assert.throws(
    () => groupIntoRegion(d, { memberIds: ['s1'], consumeNodeIds: [], x: 0 }, ctx),
    /needs x, y, width and height together/
  )
})

test('被吞掉的卡片必须真的进了成员表——否则等于悄悄销毁用户唯一的入口', () => {
  const d = draft()
  const pin = createNode(d, { kind: 'session', sessionId: 's9' }, ctx).node
  assert.throws(
    () =>
      groupIntoRegion(
        d,
        {
          memberIds: ['s1'],
          consumeNodeIds: [pin.id],
          x: 0,
          y: 0,
          width: 484,
          height: 196,
        },
        ctx
      ),
    /must be a member of the region/
  )
  // 卡片还在。
  assert.equal(d.nodes.some((n) => n.id === pin.id), true)
})

test('合并进已有区域：成员取并集，几何被忽略；非自定义区域拒绝', () => {
  const d = draft()
  const region = createNode(d, { kind: 'custom', x: 5, y: 5 }, ctx).node
  region.memberIds = ['s1']
  const change = groupIntoRegion(d, { targetRegionId: region.id, memberIds: ['s2', 's1'], consumeNodeIds: [] }, ctx)
  assert.deepEqual(change.node.memberIds, ['s1', 's2'])
  assert.deepEqual(change.deletedIds, [])
  assert.equal(change.node.x, 5)
  const bound = createNode(d, { kind: 'agent', agentType: 'a' }, ctx).node
  assert.throws(
    () => groupIntoRegion(d, { targetRegionId: bound.id, memberIds: ['s3'], consumeNodeIds: [] }, ctx),
    /only custom regions/
  )
  assert.throws(
    () => groupIntoRegion(d, { targetRegionId: 999, memberIds: [], consumeNodeIds: [] }, ctx),
    /not found/
  )
})

test('删除：单个与批量都只报真的删掉了的，什么都没删就没有事件', () => {
  const d = draft()
  const a = createNode(d, { kind: 'note' }, ctx).node
  const b = createNode(d, { kind: 'note' }, ctx).node
  assert.deepEqual(deleteNode(d, a.id), { kind: 'deleted', id: a.id })
  assert.equal(deleteNode(d, a.id), undefined)
  const batch = deleteNodes(d, [b.id, 999])
  assert.deepEqual(batch, { kind: 'pruned', deletedIds: [b.id], updated: [] })
  assert.equal(deleteNodes(d, [999]), undefined)
  assert.equal(deleteNodes(d, []), undefined)
})

test('清理消失的会话：删掉钉住的卡片，并把自定义区域的成员表刷干净', () => {
  const d = draft()
  const pin = createNode(d, { kind: 'session', sessionId: 'gone' }, ctx).node
  const region = createNode(d, { kind: 'custom' }, ctx).node
  region.memberIds = ['gone', 'alive']
  const change = pruneForSessions(d, ['gone'], ctx)
  assert.deepEqual(change.deletedIds, [pin.id])
  assert.deepEqual(change.updated.map((n) => n.memberIds), [['alive']])
  assert.equal(d.nodes.length, 1)
  // 没有引用就没有事件。
  assert.equal(pruneForSessions(d, ['gone'], ctx), undefined)
  assert.equal(pruneForSessions(d, [], ctx), undefined)
})

// ── 会话正文 ──

test('会话正文把 surface 事件折成可读的轮次，未知块与推理块不显示', async () => {
  const query = {
    async readSurface() {
      return {
        events: [
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '帮我看看' }], source: { kind: 'user' } },
          },
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '注入的上下文' }], source: { kind: 'inject' } },
          },
          {
            type: 'assistant/message',
            data: {
              message: {
                content: [
                  { type: 'reasoning', text: '不该出现' },
                  { type: 'text', text: '好的' },
                  { type: 'tool-call', name: 'bash' },
                  { type: '未来的块' },
                ],
              },
            },
          },
          { type: 'tool/result', data: { name: 'bash', content: [{ type: 'text', text: 'ok' }] } },
          { type: 'assistant/chunk', data: { chunk: {} } },
          { type: 'assistant/message', data: { message: { content: [] } } },
        ],
      }
    },
  }
  const { turns, truncated } = await readTranscript(query, 'session-a')
  assert.equal(truncated, false)
  assert.deepEqual(
    turns.map((t) => [t.role, t.label]),
    [
      ['user', '你'],
      ['user', '注入 · inject'],
      ['assistant', '助手'],
      ['tool', '工具 bash'],
    ]
  )
  assert.equal(turns[2].text, '好的\n[工具调用 bash]')
  assert.ok(!turns[2].text.includes('不该出现'))
})

test('没有 sessionQuery、或读取失败时，正文是空的而不是报错', async () => {
  assert.deepEqual(await readTranscript(undefined, 'a'), { turns: [], truncated: false })
  const broken = {
    async readSurface() {
      throw new Error('log gone')
    },
  }
  assert.deepEqual(await readTranscript(broken, 'a'), { turns: [], truncated: false })
})
