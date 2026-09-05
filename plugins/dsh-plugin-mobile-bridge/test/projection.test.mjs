/**
 * Projection tests. This is the module a phone's whole rendering depends on, and
 * the one place where an upstream change in dsh's event vocabulary shows up
 * first, so the fixtures below are shaped exactly like real `SessionEvent`s
 * rather than like the projection's own output.
 *
 * @module dsh-plugin-mobile-bridge/test/projection
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { FRAME } from '../lib/shared/protocol.js'
import { framesOf, hostFramesOf, messageOf, messagesOf, summaryOf, textOf } from '../lib/host/projection.js'

const userMessage = (seq, text, extra = {}) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
})

const assistantMessage = (seq, turn, step, content, extra = {}) => ({
  type: 'assistant/message',
  seq,
  time: 2000 + seq,
  data: {
    turn,
    step,
    message: { id: `a-${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } },
    ...extra,
  },
})

test('text and reasoning are separated, images counted', () => {
  const event = assistantMessage(5, 1, 0, [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
  ])
  const message = messageOf(event)
  assert.equal(message.role, 'assistant')
  assert.equal(message.text, 'Hello world')
  assert.equal(message.reasoning, 'thinking')
  assert.deepEqual(message.toolCalls, [{ callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }])
  assert.equal(message.seq, 5)
  assert.equal(message.messageId, 'a-5')
})

test('a plugin-injected user message keeps its origin', () => {
  const event = userMessage(3, 'AGENTS.md says…', {
    source: { kind: 'plugin', plugin: 'dsh-agent-instructions', form: 'instructions' },
  })
  const message = messageOf(event)
  assert.equal(message.origin, 'plugin')
  assert.equal(message.plugin, 'dsh-agent-instructions')
})

test('an interrupted assistant message says so', () => {
  const message = messageOf(assistantMessage(7, 1, 0, [{ type: 'text', text: 'partial' }], { interrupted: true }))
  assert.equal(message.interrupted, true)
})

test('a tool result carries its call id and failure bit', () => {
  const okResult = messageOf({
    type: 'tool/result',
    seq: 9,
    time: 3000,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: 't-9',
        role: 'user',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', callId: 'c1', content: 'file.txt' }],
      },
    },
  })
  assert.equal(okResult.role, 'tool')
  assert.deepEqual(okResult.toolResult, { callId: 'c1', ok: true })
  assert.equal(okResult.text, 'file.txt')

  const failed = messageOf({
    type: 'tool/result',
    seq: 10,
    time: 3001,
    data: {
      turn: 1,
      step: 0,
      message: { id: 't-10', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [] },
      error: { name: 'ToolError', code: 'enoent' },
    },
  })
  assert.equal(failed.toolResult.ok, false)
  assert.equal(failed.toolResult.error, 'enoent')
})

test('events with no surface project onto nothing', () => {
  for (const type of ['turn/start', 'step/start', 'request/header', 'llm/retry', 'todo/write']) {
    assert.equal(messageOf({ type, seq: 1, time: 0, data: {} }), null, `${type} has no message`)
  }
})

test('textOf tolerates anything an unknown block shape throws at it', () => {
  assert.equal(textOf(undefined), '')
  assert.equal(textOf([null, 42, { type: 'text' }, { type: 'text', text: 'ok' }]), 'ok')
})

test('a compaction replace drops exactly the range it shadows', () => {
  const page = [
    { event: userMessage(1, 'first') },
    { event: assistantMessage(2, 1, 0, [{ type: 'text', text: 'answer one' }]) },
    { event: userMessage(3, 'second') },
    { event: assistantMessage(4, 2, 0, [{ type: 'text', text: 'answer two' }]) },
    {
      event: {
        ...userMessage(5, '(summary of the first two turns)', {
          source: { kind: 'plugin', plugin: 'dsh-compaction-basic', form: 'recall' },
        }),
        surfaceOp: { op: 'replace', start: 1, end: 3 },
        sourceEventSeqs: [1, 2, 3],
      },
    },
  ]
  const messages = messagesOf(page)
  assert.deepEqual(
    messages.map((message) => message.seq),
    [4, 5],
    'seqs 1-3 are shadowed by the replacement, seq 4 survives',
  )
  assert.equal(messages[1].text, '(summary of the first two turns)')
})

test('an ordinary page keeps seq order and drops nothing', () => {
  const messages = messagesOf([
    { event: assistantMessage(2, 1, 0, [{ type: 'text', text: 'b' }]) },
    { event: userMessage(1, 'a') },
  ])
  assert.deepEqual(
    messages.map((message) => message.text),
    ['a', 'b'],
  )
})

test('chunks open a message once and then stream deltas', () => {
  const memo = {}
  const chunk = (kind, text) => ({
    rpcId: 'r1',
    payload: {
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'assistant/chunk', seq: 1, time: 0, data: { turn: 1, step: 0, chunk: { type: kind, index: 0, text } } },
    },
  })

  const first = framesOf(chunk('text-delta', 'He'), memo)
  assert.deepEqual(
    first.map((frame) => frame.type),
    [FRAME.messageStart, FRAME.messageDelta],
    'the first chunk both opens the message and carries text',
  )
  assert.equal(first[0].messageId, '1:0', 'a streaming message is keyed by turn:step — dsh mints no id yet')

  const second = framesOf(chunk('text-delta', 'llo'), memo)
  assert.deepEqual(
    second.map((frame) => frame.type),
    [FRAME.messageDelta],
    'a second chunk must not re-open the message',
  )
  assert.equal(second[0].text, 'llo')

  const reasoning = framesOf(chunk('reasoning-delta', 'hmm'), memo)
  assert.equal(reasoning[0].kind, 'reasoning')

  // Non-text chunks (usage, finish, block boundaries) are bookkeeping.
  const usage = framesOf(
    {
      rpcId: 'r1',
      payload: {
        type: 'session/event',
        sessionId: 's1',
        event: { type: 'assistant/chunk', seq: 2, time: 0, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: {} } } },
      },
    },
    memo,
  )
  assert.deepEqual(usage, [])
})

test('answerable interactions carry the envelope rpcId, not a frame field', () => {
  const approval = framesOf({
    rpcId: 'rpc-approval-1',
    payload: {
      type: 'approval/requested',
      sessionId: 's1',
      approvalId: 'ap-1',
      toolName: 'bash',
      callId: 'c1',
      reason: 'writes outside the workspace',
    },
  })
  assert.equal(approval[0].type, FRAME.approvalRequested)
  assert.equal(approval[0].requestId, 'rpc-approval-1', 'answering with a fresh id would orphan the response')
  assert.equal(approval[0].approvalId, 'ap-1')
  assert.equal(approval[0].reason, 'writes outside the workspace')

  const question = framesOf({
    rpcId: 'rpc-question-1',
    payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q1', question: '选哪个？' }] },
  })
  assert.equal(question[0].requestId, 'rpc-question-1')
  assert.equal(question[0].questions.length, 1)
})

test('only the title projection crosses the boundary', () => {
  const title = framesOf({
    rpcId: 'r',
    payload: { type: 'session/projection', sessionId: 's1', key: 'title', value: '修一个 bug', seq: 12 },
  })
  assert.deepEqual(title, [{ type: FRAME.sessionTitle, sessionId: 's1', title: '修一个 bug' }])

  const other = framesOf({
    rpcId: 'r',
    payload: { type: 'session/projection', sessionId: 's1', key: 'sessionListMetadata', value: {}, seq: 12 },
  })
  assert.deepEqual(other, [], 'host bookkeeping is not a phone concern')
})

test('unknown frame types and unknown event types are dropped, never guessed', () => {
  assert.deepEqual(framesOf({ rpcId: 'r', payload: { type: 'something/new', sessionId: 's1' } }), [])
  assert.deepEqual(
    framesOf({
      rpcId: 'r',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'team/task', seq: 1, time: 0, data: {} } },
    }),
    [],
  )
  assert.deepEqual(framesOf(undefined), [])
  assert.deepEqual(hostFramesOf(undefined), [])
})

test('a stream error is reported rather than swallowed', () => {
  const frames = framesOf({
    rpcId: 'r',
    payload: { type: 'stream/error', error: { code: 'internal', message: '爆了' } },
  })
  assert.deepEqual(frames, [{ type: FRAME.error, code: 'internal', message: '爆了' }])
})

test('host frames project lifecycle and status only', () => {
  assert.deepEqual(hostFramesOf({ rpcId: 'r', payload: { type: 'host/session-added', sessionId: 's1', blank: true, cwd: '/w' } }), [
    { type: FRAME.sessionAdded, sessionId: 's1', blank: true, cwd: '/w' },
  ])
  assert.deepEqual(hostFramesOf({ rpcId: 'r', payload: { type: 'host/session-status', sessionId: 's1', running: true } }), [
    { type: FRAME.sessionStatus, sessionId: 's1', running: true },
  ])
  assert.equal(hostFramesOf({ rpcId: 'r', payload: { type: 'host/agent-error', sessionId: 's1', message: 'x' } })[0].type, FRAME.error)
  // Workspace churn is a list the phone re-reads on demand; forwarding it would
  // give the client a second source of truth to reconcile.
  assert.deepEqual(hostFramesOf({ rpcId: 'r', payload: { type: 'host/workspace-changed', workspace: {} } }), [])
})

test('a tool result frame precedes its message so a card can settle in place', () => {
  const frames = framesOf({
    rpcId: 'r',
    payload: {
      type: 'session/event',
      sessionId: 's1',
      event: {
        type: 'tool/result',
        seq: 4,
        time: 0,
        data: {
          turn: 1,
          step: 0,
          message: { id: 't', role: 'user', source: { kind: 'tool', callId: 'c9' }, content: [{ type: 'tool-result', callId: 'c9', content: 'done' }] },
        },
      },
    },
  })
  assert.deepEqual(
    frames.map((frame) => frame.type),
    [FRAME.toolResult, FRAME.messageEnd],
  )
  assert.equal(frames[0].callId, 'c9')
  assert.equal(frames[0].ok, true)
})

test('a session summary keeps its title projection and drops the rest', () => {
  const row = summaryOf({
    sessionId: 's1',
    updatedAt: 12,
    running: true,
    blank: false,
    cwd: '/w',
    projections: { asOfSeq: 9, values: { title: '标题', sessionListMetadata: { blank: false } } },
  })
  assert.deepEqual(row, { sessionId: 's1', title: '标题', updatedAt: 12, running: true, blank: false, cwd: '/w' })
  assert.equal(summaryOf({ sessionId: 's2' }).title, null, 'no projection means no title yet')
})

test('the finished message closes its stream key so a new step can open one', () => {
  const memo = {}
  const chunk = () =>
    framesOf(
      {
        rpcId: 'r',
        payload: {
          type: 'session/event',
          sessionId: 's1',
          event: {
            type: 'assistant/chunk',
            seq: 1,
            time: 0,
            data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } },
          },
        },
      },
      memo,
    )
  assert.equal(chunk().length, 2, 'opens the message and carries text')
  assert.equal(chunk().length, 1, 'still the same message')

  const end = framesOf(
    {
      rpcId: 'r',
      payload: {
        type: 'session/event',
        sessionId: 's1',
        event: assistantMessage(3, 1, 0, [{ type: 'text', text: 'x' }]),
      },
    },
    memo,
  )
  assert.equal(end[0].type, FRAME.messageEnd)
  assert.equal(end[0].streamId, '1:0', 'the client needs this to retire its provisional bubble')
  assert.equal(chunk().length, 2, 'a chunk after the end opens a fresh message')
})



