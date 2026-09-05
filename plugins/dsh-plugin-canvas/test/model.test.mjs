/**
 * 节点记录与派生层的领域测试：把 codeg-plus canvas-model.test.ts /
 * canvas_service.rs 的不变量搬过来——kind 专属的绑定校验、颜色词表、几何夹取、
 * 成员列表的原子增删、便签是否「写了字」，以及派生图的顺序、封顶、冻结、
 * 折叠、展开、未解析绑定、颜色继承。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CUSTOM_MEMBERS,
  applyPatch,
  createNodeRecord,
  memberElementId,
  nodeElementId,
  noteHoldsProse,
  parseMemberElementId,
  parseNodeElementId,
} from '../src/shared/model.js'
import { compareByRecency, computeRegionMembers, deriveBoard } from '../src/shared/derive.js'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_VISIBLE_MEMBERS,
  REGION_COLLAPSED_HEIGHT,
  REGION_FOOTER_HEIGHT,
  regionHeightForRows,
  regionWidthForColumns,
} from '../src/shared/units.js'

const NOW = '2026-09-05T00:00:00.000Z'
const ctx = { id: 1, now: NOW }

const session = (id, over = {}) => ({
  id,
  title: `会话 ${id}`,
  status: 'idle',
  updatedAt: '2026-09-01T00:00:00.000Z',
  workspace: 'D:/repo',
  agentType: 'dsh',
  model: 'deepseek-chat',
  ...over,
})

const emptyDerive = {
  sessions: [],
  expandedRegions: new Set(),
  overlay: new Map(),
}

test('每个 kind 只保留自己的绑定字段，别的强制为 null', () => {
  const row = createNodeRecord(
    { kind: 'workspace', workspace: ' D:/repo ', agentType: 'x', sessionId: 's1' },
    ctx
  )
  assert.equal(row.workspace, 'D:/repo')
  assert.equal(row.agentType, null)
  assert.equal(row.sessionId, null)
  assert.equal(row.gridColumns, 0)
  assert.deepEqual(row.memberIds, [])
})

test('绑定缺失就拒绝，未知 kind 也拒绝', () => {
  assert.throws(() => createNodeRecord({ kind: 'workspace' }, ctx), /needs a workspace/)
  assert.throws(() => createNodeRecord({ kind: 'agent' }, ctx), /needs an agentType/)
  assert.throws(() => createNodeRecord({ kind: 'session' }, ctx), /must not be empty/)
  assert.throws(() => createNodeRecord({ kind: 'folder' }, ctx), /unknown node kind/)
})

test('content 只属于便签，颜色必须在词表里', () => {
  assert.throws(() => createNodeRecord({ kind: 'custom', content: '偷渡' }, ctx), /only applies to notes/)
  assert.equal(createNodeRecord({ kind: 'note', content: '写了' }, ctx).content, '写了')
  assert.equal(createNodeRecord({ kind: 'note', content: '' }, ctx).content, null)
  assert.throws(() => createNodeRecord({ kind: 'note', color: '#ff0000' }, ctx), /unknown theme color/)
  assert.equal(createNodeRecord({ kind: 'note', color: ' violet ' }, ctx).color, 'violet')
})

test('几何被夹取：尺寸下限 48、上限 20000，坐标必须有限', () => {
  const row = createNodeRecord({ kind: 'note', x: 5, y: 5, width: 1, height: 1e9 }, ctx)
  assert.equal(row.width, 48)
  assert.equal(row.height, 20000)
  assert.throws(() => createNodeRecord({ kind: 'note', x: Number.NaN }, ctx), /not finite/)
  assert.equal(createNodeRecord({ kind: 'note', x: 1e9 }, ctx).x, 1000000)
})

test('网格轴只对区域生效，且被夹在 0..12', () => {
  assert.equal(createNodeRecord({ kind: 'custom', gridColumns: 99 }, ctx).gridColumns, 12)
  assert.equal(createNodeRecord({ kind: 'custom', gridColumns: -3 }, ctx).gridColumns, 0)
  assert.equal(createNodeRecord({ kind: 'note', gridColumns: 3 }, ctx).gridColumns, 0)
  const note = createNodeRecord({ kind: 'note' }, ctx)
  assert.throws(() => applyPatch(note, { gridRows: 2 }, { now: NOW }), /only applies to regions/)
})

test('成员增删是原子列表操作，只对自定义区域开放，且有上限', () => {
  const region = createNodeRecord({ kind: 'custom' }, ctx)
  const patched = applyPatch(region, { memberAdd: 's1' }, { now: NOW })
  assert.deepEqual(patched.memberIds, ['s1'])
  // 重复加是幂等的。
  assert.deepEqual(applyPatch(patched, { memberAdd: 's1' }, { now: NOW }).memberIds, ['s1'])
  assert.deepEqual(applyPatch(patched, { memberRemove: 's1' }, { now: NOW }).memberIds, [])
  // 移除不存在的成员不报错（幂等），加不存在的会话会。
  assert.deepEqual(applyPatch(patched, { memberRemove: 'nope' }, { now: NOW }).memberIds, ['s1'])
  assert.throws(
    () => applyPatch(region, { memberAdd: 'ghost' }, { now: NOW, memberIsLive: () => false }),
    /does not exist/
  )
  const full = { ...region, memberIds: Array.from({ length: MAX_CUSTOM_MEMBERS }, (_, i) => `s${i}`) }
  assert.throws(() => applyPatch(full, { memberAdd: 'extra' }, { now: NOW }), /at most 200/)
  const workspace = createNodeRecord({ kind: 'workspace', workspace: 'D:/r' }, ctx)
  assert.throws(() => applyPatch(workspace, { memberAdd: 's1' }, { now: NOW }), /only apply to custom/)
})

test('便签正文保留内部空白，全空才清掉；空字符串清标题和颜色', () => {
  const note = createNodeRecord({ kind: 'note', color: 'red', title: '标' }, ctx)
  assert.equal(applyPatch(note, { content: '  两行\n\n  ' }, { now: NOW }).content, '  两行\n\n  ')
  assert.equal(applyPatch(note, { content: '' }, { now: NOW }).content, null)
  assert.equal(applyPatch(note, { title: '   ' }, { now: NOW }).title, null)
  assert.equal(applyPatch(note, { color: '' }, { now: NOW }).color, null)
  const region = createNodeRecord({ kind: 'custom' }, ctx)
  assert.throws(() => applyPatch(region, { content: 'x' }, { now: NOW }), /only applies to notes/)
})

test('只有真的写了字的便签才拦删除', () => {
  assert.equal(noteHoldsProse({ kind: 'note', content: '写了' }), true)
  assert.equal(noteHoldsProse({ kind: 'note', content: '   \n ' }), false)
  assert.equal(noteHoldsProse({ kind: 'note', content: null }), false)
  // 别的节点都是「别处东西的排列」，删掉不毁内容。
  assert.equal(noteHoldsProse({ kind: 'custom', content: '写了' }), false)
  assert.equal(noteHoldsProse(undefined), false)
})

test('元素 id 往返，会话 id 里的连字符不会把 member id 切坏', () => {
  assert.equal(parseNodeElementId(nodeElementId(42)), 42)
  assert.equal(parseNodeElementId('member-1-s'), null)
  assert.deepEqual(parseMemberElementId(memberElementId(7, 'a-b-c')), {
    regionId: 7,
    sessionId: 'a-b-c',
  })
  assert.equal(parseMemberElementId('member-x-y'), null)
  assert.equal(parseMemberElementId('node-1'), null)
})

// ── 成员解析与排序 ──

test('工作区区域按目录匹配，智能体区域按 agentType 匹配', () => {
  const sessions = [
    session('a', { workspace: 'D:/one' }),
    session('b', { workspace: 'D:/two', agentType: 'other' }),
  ]
  const ws = createNodeRecord({ kind: 'workspace', workspace: 'D:/one' }, ctx)
  assert.deepEqual(
    computeRegionMembers(ws, sessions).map((s) => s.id),
    ['a']
  )
  const agent = createNodeRecord({ kind: 'agent', agentType: 'other' }, ctx)
  assert.deepEqual(
    computeRegionMembers(agent, sessions).map((s) => s.id),
    ['b']
  )
})

test('子会话（delegate/loop/有 parentId）不上画布', () => {
  const sessions = [
    session('a'),
    session('b', { kind: 'delegate' }),
    session('c', { kind: 'loop' }),
    session('d', { parentId: 'a' }),
  ]
  const ws = createNodeRecord({ kind: 'workspace', workspace: 'D:/repo' }, ctx)
  assert.deepEqual(
    computeRegionMembers(ws, sessions).map((s) => s.id),
    ['a']
  )
})

test('自定义区域解析存下来的 id，过期的静默掉队，并按最近更新排序', () => {
  const region = {
    ...createNodeRecord({ kind: 'custom' }, ctx),
    memberIds: ['old', 'gone', 'new'],
  }
  const sessions = [
    session('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
    session('new', { updatedAt: '2026-08-01T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    computeRegionMembers(region, sessions).map((s) => s.id),
    ['new', 'old']
  )
})

test('排序是 (updatedAt 降, id 降)，时间戳撞车时 id 兜底', () => {
  const a = session('a', { updatedAt: NOW })
  const b = session('b', { updatedAt: NOW })
  assert.deepEqual([a, b].sort(compareByRecency).map((s) => s.id), ['b', 'a'])
})

// ── 派生图 ──

/** 一个 3 列的自定义区域，带 n 个成员。 */
const customWith = (id, memberIds, over = {}) => ({
  ...createNodeRecord({ kind: 'custom', x: 100, y: 100 }, { id, now: NOW }),
  memberIds,
  ...over,
})

test('区域排在成员卡之前，成员按网格摆放（绝对坐标 = 区域角 + 槽位）', () => {
  const region = customWith(1, ['a', 'b'])
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions: [session('a', { updatedAt: '2026-08-02T00:00:00.000Z' }), session('b')],
  })
  assert.deepEqual(
    board.elements.map((e) => e.type),
    ['region', 'sessionCard', 'sessionCard']
  )
  assert.equal(board.elements[0].memberTotal, 2)
  assert.equal(board.elements[0].visibleCount, 2)
  assert.deepEqual(board.elements[1].position, { x: 112, y: 152 })
  assert.deepEqual(board.elements[2].position, { x: 348, y: 152 })
  assert.equal(board.elements[1].regionOwnsMembers, true)
  assert.deepEqual(board.regionRects[0], {
    id: 1,
    kind: 'custom',
    x: 100,
    y: 100,
    width: regionWidthForColumns(3),
    height: regionHeightForRows(2),
  })
})

test('拖拽浮层盖过入账位置与网格槽位', () => {
  const region = customWith(1, ['a'])
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions: [session('a')],
    overlay: new Map([
      ['node-1', { x: 500, y: 500 }],
      ['member-1-a', { x: 900, y: 900 }],
    ]),
  })
  assert.deepEqual(board.elements[0].position, { x: 500, y: 500 })
  assert.deepEqual(board.elements[1].position, { x: 900, y: 900 })
})

test('拖拽期间冻结的成员列表盖过实时计算', () => {
  const region = createNodeRecord({ kind: 'workspace', workspace: 'D:/repo' }, ctx)
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions: [session('a'), session('b')],
    frozenMembers: new Map([[1, ['b']]]),
  })
  assert.equal(board.elements.length, 2)
  assert.equal(board.elements[1].sessionId, 'b')
})

test('折叠的区域是个胶囊，没有任何成员卡', () => {
  const region = customWith(1, ['a', 'b'], { collapsed: true })
  const board = deriveBoard({ ...emptyDerive, nodes: [region], sessions: [session('a'), session('b')] })
  assert.equal(board.elements.length, 1)
  assert.equal(board.elements[0].height, REGION_COLLAPSED_HEIGHT)
  assert.equal(board.elements[0].memberTotal, 2)
})

test('没钉行数时可见成员封顶 24，超出的进「+N」并留出页脚高度', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const region = customWith(1, ids)
  const sessions = ids.map((id) => session(id))
  const board = deriveBoard({ ...emptyDerive, nodes: [region], sessions })
  const frame = board.elements[0]
  assert.equal(frame.memberTotal, 30)
  assert.equal(frame.visibleCount, MAX_VISIBLE_MEMBERS)
  assert.equal(frame.hiddenCount, 6)
  // 8 行卡片 + 页脚。
  assert.equal(frame.height, regionHeightForRows(8) + REGION_FOOTER_HEIGHT)

  const expanded = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions,
    expandedRegions: new Set([1]),
  })
  assert.equal(expanded.elements[0].visibleCount, 30)
  assert.equal(expanded.elements[0].hiddenCount, 0)
  assert.equal(expanded.elements[0].height, regionHeightForRows(10))
})

test('钉死的列数拥有框宽度，钉死的行数封顶可见数并保住声明形状', () => {
  const region = customWith(1, ['a'], { gridColumns: 2, gridRows: 2, width: 9999, height: 10 })
  const board = deriveBoard({ ...emptyDerive, nodes: [region], sessions: [session('a')] })
  assert.equal(board.elements[0].width, regionWidthForColumns(2))
  // 只有一个成员，但 2×2 的框仍然按 2 行渲染。
  assert.equal(board.elements[0].height, regionHeightForRows(2))

  const many = customWith(1, ['a', 'b', 'c', 'd', 'e'], { gridColumns: 2, gridRows: 2 })
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) => session(id))
  const capped = deriveBoard({ ...emptyDerive, nodes: [many], sessions })
  assert.equal(capped.elements[0].visibleCount, 4)
  assert.equal(capped.elements[0].hiddenCount, 1)
  assert.equal(capped.elements[0].height, regionHeightForRows(2) + REGION_FOOTER_HEIGHT)
})

test('未解析的绑定只出提示，不出成员卡', () => {
  const region = createNodeRecord({ kind: 'workspace', workspace: 'D:/gone' }, ctx)
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions: [session('a', { workspace: 'D:/gone' })],
    workspaces: new Set(['D:/live']),
  })
  assert.equal(board.elements.length, 1)
  assert.equal(board.elements[0].unresolved, true)
  assert.equal(board.elements[0].memberTotal, 0)
})

test('智能体区域从不「未解析」——没有会话就是空区域', () => {
  const region = createNodeRecord({ kind: 'agent', agentType: 'ghost' }, ctx)
  const board = deriveBoard({ ...emptyDerive, nodes: [region], sessions: [session('a')] })
  assert.equal(board.elements[0].unresolved, false)
  assert.equal(board.elements[0].memberTotal, 0)
})

test('钉住的会话卡用固定 footprint；展开成详情卡才换成 520×560', () => {
  const pin = createNodeRecord({ kind: 'session', sessionId: 'a', width: 9999 }, ctx)
  const sessions = [session('a')]
  const summary = deriveBoard({ ...emptyDerive, nodes: [pin], sessions })
  assert.equal(summary.elements[0].type, 'sessionCard')
  assert.equal(summary.elements[0].width, CARD_WIDTH)
  assert.equal(summary.elements[0].height, CARD_HEIGHT)
  assert.equal(summary.pinRects.length, 1)

  const detail = deriveBoard({
    ...emptyDerive,
    nodes: [{ ...pin, width: CARD_WIDTH, height: CARD_HEIGHT }],
    sessions,
    detailCards: new Set([1]),
  })
  assert.equal(detail.elements[0].type, 'sessionDetail')
  assert.equal(detail.elements[0].width, 520)
  assert.equal(detail.elements[0].height, 560)
  // 展开的卡片不再是合并目标：520×560 是读东西的窗口，不是能摞的瓦片。
  assert.equal(detail.pinRects.length, 0)
})

test('用户调过尺寸的详情卡保留自己的尺寸', () => {
  const pin = { ...createNodeRecord({ kind: 'session', sessionId: 'a' }, ctx), width: 700, height: 800 }
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [pin],
    sessions: [session('a')],
    detailCards: new Set([1]),
  })
  assert.equal(board.elements[0].width, 700)
  assert.equal(board.elements[0].height, 800)
})

test('会话已删除的卡片不会展开——没有东西可展开', () => {
  const pin = createNodeRecord({ kind: 'session', sessionId: 'gone' }, ctx)
  const board = deriveBoard({ ...emptyDerive, nodes: [pin], sessions: [], detailCards: new Set([1]) })
  assert.equal(board.elements[0].type, 'sessionCard')
  assert.equal(board.elements[0].unresolved, true)
  assert.equal(board.pinRects.length, 0)
})

test('颜色：钉住的卡用自己那行的颜色，成员卡用持有它的区域的颜色', () => {
  const pin = createNodeRecord({ kind: 'session', sessionId: 'a', color: 'violet' }, ctx)
  const region = customWith(2, ['b'], { color: 'orange' })
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [pin, region],
    sessions: [session('a'), session('b')],
  })
  assert.equal(board.elements[0].color, 'violet')
  assert.equal(board.elements[2].color, 'orange')
})

test('实时 resize 尺寸盖过入账几何，并重排网格', () => {
  const region = customWith(1, ['a', 'b', 'c'])
  const board = deriveBoard({
    ...emptyDerive,
    nodes: [region],
    sessions: ['a', 'b', 'c'].map((id) => session(id)),
    sizeOverlay: new Map([['node-1', { width: regionWidthForColumns(1), height: 200 }]]),
  })
  assert.equal(board.elements[0].width, regionWidthForColumns(1))
  // 一列 → 三行，高度按内容长起来。
  assert.equal(board.elements[0].height, regionHeightForRows(3))
})

test('排序按毫秒数值比，而不是按字符串——否则 900 会排在 1000 前面', () => {
  const older = session('a', { updatedAt: 900 })
  const newer = session('b', { updatedAt: 1000 })
  assert.deepEqual([older, newer].sort(compareByRecency).map((s) => s.id), ['b', 'a'])
  // ISO 字符串也仍然按字面顺序（宿主给的是毫秒，但别人给字符串也不该错）。
  const isoOld = session('c', { updatedAt: '2026-01-01T00:00:00.000Z' })
  const isoNew = session('d', { updatedAt: '2026-08-01T00:00:00.000Z' })
  assert.deepEqual([isoOld, isoNew].sort(compareByRecency).map((s) => s.id), ['d', 'c'])
})

test('绑定区域的成员用实时绑定解析，冻结时必须用解析结果而不是空的成员表', () => {
  const region = createNodeRecord({ kind: 'workspace', workspace: 'D:/repo' }, ctx)
  // 工作区/智能体区域的 memberIds 永远是空的，这正是拖拽冻结踩过的坑。
  assert.deepEqual(region.memberIds, [])
  const resolved = computeRegionMembers(region, [session('a'), session('b')])
  assert.deepEqual(resolved.map((s) => s.id), ['b', 'a'])
})
