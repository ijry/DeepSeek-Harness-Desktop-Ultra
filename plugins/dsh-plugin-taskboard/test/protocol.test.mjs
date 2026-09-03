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
  STATUSES_BY_COLUMN,
  agentCanMove,
  canUserAccept,
  canUserReject,
  columnForStatus,
  createTaskRecord,
  groupTasksByColumn,
  isClaim,
  isValidStatus,
  normalizeTitle,
  summarizeTask,
  userCanMove,
} from '../src/shared/protocol.js'

test('每个状态映射到 codeg-plus 四列看板', () => {
  const mapping = {
    todo: 'todo',
    queued: 'todo',
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
  assert.deepEqual(grouped.todo.map((t) => t.id), ['b', 'a'])
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
