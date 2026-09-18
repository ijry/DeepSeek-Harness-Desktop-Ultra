/**
 * Domain tests for dsh-plugin-taskboard: lock the codeg-plus board semantics
 * the browser half and the agent protocol both rely on — column mapping,
 * freshest-first ordering, review-only acceptance/reject, and the gates that
 * keep done/canceled human-owned and merging engine-reserved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_TRANSITIONS,
  ALL_STATUSES,
  BOARD_COLUMN_IDS,
  DEFAULT_MAX_PARALLEL,
  MAX_PARALLEL_LIMIT,
  STATUSES_BY_COLUMN,
  agentCanMove,
  canUserAccept,
  canUserReject,
  columnForStatus,
  createTaskRecord,
  emptyLedger,
  groupTasksByColumn,
  hasSession,
  isClaim,
  isValidStatus,
  isWaitingInQueue,
  normalizeMaxParallel,
  normalizeSettings,
  normalizeTitle,
  occupiesSlot,
  queueOrder,
  summarizeTask,
  userCanMove,
} from '../src/shared/protocol.js'

test('每个状态映射到 codeg-plus 四列看板', () => {
  const mapping = {
    todo: 'todo',
    // 发起会话把卡从积压推进执行管线，排队中（等额度）也算「进行中」：
    // 只有「取消排队」才会把它送回「待办」。
    queued: 'inProgress',
    preparing: 'inProgress',
    running: 'inProgress',
    awaiting_input: 'attention',
    review: 'attention',
    merging: 'attention',
    failed: 'attention',
    done: 'done',
    canceled: 'done',
  }
  assert.deepEqual(BOARD_COLUMN_IDS, ['todo', 'inProgress', 'attention', 'done'])
  for (const [status, column] of Object.entries(mapping)) {
    assert.equal(columnForStatus(status), column, `${status} -> ${column}`)
    assert.equal(isValidStatus(status), true, `${status} 是合法状态`)
  }
  const flat = BOARD_COLUMN_IDS.flatMap((column) => STATUSES_BY_COLUMN[column])
  assert.deepEqual([...flat].sort(), [...ALL_STATUSES].sort())
  assert.equal(new Set(flat).size, flat.length, '状态在列间不重复')
})

test('分列按最近更新排序，canceled 默认隐藏', () => {
  const now = 1_000_000
  const base = { version: 1, createdAt: now, updatedAt: now }
  const tasks = [
    { id: 'a', title: 'A', ...base, status: 'todo', updatedAt: now + 3 },
    { id: 'b', title: 'B', ...base, status: 'queued', updatedAt: now + 5 },
    { id: 'c', title: 'C', ...base, status: 'canceled', updatedAt: now + 9 },
    { id: 'd', title: 'D', ...base, status: 'done', updatedAt: now + 1 },
    { id: 'e', title: 'E', ...base, status: 'review', updatedAt: now + 7 },
  ]
  const grouped = groupTasksByColumn(tasks, false)
  assert.deepEqual(grouped.todo.map((t) => t.id), ['a'], '待办列只剩还没排队的卡')
  assert.deepEqual(grouped.inProgress.map((t) => t.id), ['b'], 'queued 排在「进行中」列')
  assert.deepEqual(grouped.attention.map((t) => t.id), ['e'])
  assert.deepEqual(grouped.done.map((t) => t.id), ['d'], 'canceled 默认隐藏')
  const withCanceled = groupTasksByColumn(tasks, true)
  assert.deepEqual(withCanceled.done.map((t) => t.id), ['c', 'd'])
})

test('验收/退回只在 review 开放；终态只能重开到 todo；merging 用户不可达', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(canUserAccept(status), status === 'review', `accept ${status}`)
    assert.equal(canUserReject(status), status === 'review', `reject ${status}`)
  }
  assert.equal(userCanMove('review', 'done'), true, '通过验收 review -> done')
  assert.equal(userCanMove('review', 'todo'), true, '退回重做 review -> todo')
  assert.equal(userCanMove('done', 'todo'), true, '终态重开 done -> todo')
  assert.equal(userCanMove('canceled', 'todo'), true, '终态重开 canceled -> todo')
  assert.equal(userCanMove('done', 'review'), false)
  assert.equal(userCanMove('canceled', 'done'), false)
  for (const from of ALL_STATUSES) {
    assert.equal(userCanMove(from, 'merging'), false, `user cannot reach merging from ${from}`)
  }
})

test('agent 永远不能进入 done/canceled/merging', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ['done', 'canceled', 'merging']) {
      assert.equal(agentCanMove(from, to), false, `${from} -> ${to}`)
      assert.equal(AGENT_TRANSITIONS[from].includes(to), false)
    }
  }
  assert.equal(isClaim('todo', 'preparing'), true, 'todo 认领')
  assert.equal(isClaim('queued', 'preparing'), true, 'queued 认领')
  assert.equal(isClaim('todo', 'queued'), false)
  assert.equal(isClaim('running', 'preparing'), false)
  assert.equal(agentCanMove('running', 'review'), true, '交验')
  assert.equal(agentCanMove('running', 'awaiting_input'), true, '等待用户')
  assert.equal(agentCanMove('awaiting_input', 'review'), true)
  assert.equal(agentCanMove('failed', 'todo'), true, '失败可重试')
})

test('新建任务记录：规范化、默认状态与摘要', () => {
  const now = 500
  const task = createTaskRecord({
    title: '  给登录页补测试  ',
    description: ' 描述  ',
    prompt: undefined,
    workspaceId: '',
    actor: { kind: 'user' },
    now,
  })
  assert.equal(task.title, '给登录页补测试')
  assert.equal(task.status, 'todo')
  assert.equal(task.version, 1)
  assert.equal(task.createdAt, now)
  assert.equal(task.updatedAt, now)
  assert.equal(task.workspaceId, '')
  assert.equal(task.createdBy.kind, 'user')
  assert.deepEqual(task.comments, [])
  assert.throws(() => normalizeTitle('   '), /must not be empty/)
  const summary = summarizeTask(task)
  assert.equal(summary.column, 'todo')
  assert.equal(summary.commentCount, 0)
})

test('summarizeTask：输出必须是 lossless JSON（任何键都不得为 undefined）', () => {
  // 回归：summarizeTask 曾对未认领任务输出 claimedBy: undefined，
  // JSON.stringify 会把这个键整个丢掉，于是 dsh 的工具输出校验以
  // "value is not lossless JSON" 拒收 —— taskboard_list 直接报错。
  const task = createTaskRecord({ title: '未认领的待办', actor: { kind: 'user' }, now: 7 })
  const summary = summarizeTask(task)
  for (const [key, value] of Object.entries(summary)) {
    assert.notEqual(value, undefined, `summarizeTask().${key} 不应为 undefined`)
  }
  // 逐键往返：stringify → parse 后键集合不变，才是真正 lossless。
  const round = JSON.parse(JSON.stringify(summary))
  assert.deepEqual(Object.keys(round).sort(), Object.keys(summary).sort())
  assert.equal(summary.claimedBy, '')
  assert.equal(summary.workspaceId, '')
  assert.equal(summary.sessionId, '', '没有会话时 sessionId 也是空串而不是 undefined')
})

// --------------------------------------------------------------- 执行队列

test('额度占用：只有「没有会话的 queued」不占额度（否则队列永远等不到空位）', () => {
  const base = { id: 't', title: 'T', version: 1, createdAt: 0, updatedAt: 0 }
  // 会话在干活：占额度
  for (const status of ['preparing', 'running', 'awaiting_input', 'merging']) {
    assert.equal(occupiesSlot({ ...base, status }), true, `${status} 占额度`)
    assert.equal(isWaitingInQueue({ ...base, status }), false, `${status} 不是排队等待`)
  }
  // 已发起、会话已建好、等 agent 认领：仍占额度（否则会超发会话）
  assert.equal(occupiesSlot({ ...base, status: 'queued', sessionId: 's1' }), true)
  assert.equal(isWaitingInQueue({ ...base, status: 'queued', sessionId: 's1' }), false)
  // 已发起、还没会话：真正的「排队中」，不占额度
  assert.equal(occupiesSlot({ ...base, status: 'queued' }), false)
  assert.equal(occupiesSlot({ ...base, status: 'queued', sessionId: '' }), false)
  assert.equal(isWaitingInQueue({ ...base, status: 'queued' }), true)
  assert.equal(hasSession({ ...base, status: 'queued' }), false)
  // 交验 / 失败 / 终态都让出额度（人还能接下一张）
  for (const status of ['review', 'failed', 'done', 'canceled', 'todo']) {
    assert.equal(occupiesSlot({ ...base, status, sessionId: 's1' }), false, `${status} 让出额度`)
  }
})

test('队列顺序：先来先服务，queuedAt 缺失时退回 updatedAt', () => {
  const rows = [
    { id: 'c', queuedAt: 300, updatedAt: 999 },
    { id: 'a', queuedAt: 100, updatedAt: 999 },
    { id: 'b', queuedAt: 200, updatedAt: 1 },
  ]
  assert.deepEqual([...rows].sort(queueOrder).map((t) => t.id), ['a', 'b', 'c'])
  const fallback = [
    { id: 'z', updatedAt: 50 },
    { id: 'y', updatedAt: 10 },
  ]
  assert.deepEqual([...fallback].sort(queueOrder).map((t) => t.id), ['y', 'z'])
  assert.equal(queueOrder({ id: 'a', queuedAt: 1 }, { id: 'b', queuedAt: 1 }) < 0, true, '同时入队按 id 稳定排序')
})

test('并行上限：只接受 1..MAX 的整数，缺省给默认值', () => {
  assert.equal(normalizeMaxParallel(undefined), DEFAULT_MAX_PARALLEL)
  assert.equal(normalizeMaxParallel(null), DEFAULT_MAX_PARALLEL)
  assert.equal(normalizeMaxParallel(''), DEFAULT_MAX_PARALLEL)
  assert.equal(normalizeMaxParallel(1), 1)
  assert.equal(normalizeMaxParallel(MAX_PARALLEL_LIMIT), MAX_PARALLEL_LIMIT)
  for (const bad of [0, -1, 1.5, MAX_PARALLEL_LIMIT + 1, '3', NaN, true, {}]) {
    assert.throws(() => normalizeMaxParallel(bad), /maxParallel must be an integer/, `${String(bad)} 应被拒`)
  }
})

test('settings 容错：坏值退回默认，好值原样保留', () => {
  assert.deepEqual(normalizeSettings(undefined), { maxParallel: DEFAULT_MAX_PARALLEL })
  assert.deepEqual(normalizeSettings({ maxParallel: 7 }), { maxParallel: 7 })
  assert.deepEqual(normalizeSettings({ maxParallel: 'seven' }), { maxParallel: DEFAULT_MAX_PARALLEL })
  assert.deepEqual(normalizeSettings(null), { maxParallel: DEFAULT_MAX_PARALLEL })
  // 新账本自带 settings，旧账本（没有这个键）由 load 补上默认值
  assert.deepEqual(emptyLedger().settings, { maxParallel: DEFAULT_MAX_PARALLEL })
})
