/**
 * The AI seam, with a fake model service in place of DSH's.
 *
 * The requirement was "the AI goes straight to DSH", which means three things this
 * checks: the route comes from `agentDefaultModel` and not from the panel's request
 * (the reference's request carried its own provider/baseUrl/apiKey, and those fields
 * must be IGNORED here), a missing model is reported rather than crashed on, and the
 * model's habit of wrapping an answer in a code fence does not reach the panel.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { aiAvailability, generateText, loadChatHistory, resolveRoute, saveChatHistory, unwrapModelText } from '../src/host/ai.js'

/** A fake `ctx.llm` that yields the chunks `dsh-llm` would. */
function fakeLlm(chunks, capture) {
  return {
    stream(request) {
      capture?.push(request)
      return (async function* stream() {
        for (const chunk of chunks) {
          yield chunk
        }
      })()
    },
  }
}

const textDeltas = (text) => [
  ...text.split(' ').map((word, index) => ({ type: 'text-delta', text: index === 0 ? word : ` ${word}` })),
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('ai', () => {
  let dir

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-ai-'))
    process.env.DSH_HOME = join(dir, 'dsh-home')
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.DSH_HOME
  })

  it('says why it is unavailable instead of throwing something opaque', async () => {
    assert.deepEqual(aiAvailability({}), { available: false, reason: '当前 DSH 没有可用的模型服务' })
    assert.deepEqual(aiAvailability({ llm: fakeLlm([]) }), {
      available: false,
      reason: 'DSH 还没有配置默认模型，请先在 DSH 里选择模型',
    })
    await assert.rejects(() => generateText({}, { userPrompt: 'x' }), /没有可用的模型服务/)
  })

  it('reads the route from DSH, not from the request', async () => {
    const requests = []
    const ai = {
      llm: fakeLlm(textDeltas('SELECT 1'), requests),
      defaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }),
      },
    }
    assert.deepEqual(aiAvailability(ai), { available: true, provider: 'deepseek', model: 'deepseek-chat' })

    const answer = await generateText(ai, {
      systemPrompt: 'be terse',
      userPrompt: 'count the rows',
      maxTokens: 128,
      // The reference's request shape carried its own credentials; they must be
      // ignored, or the panel would quietly talk to somewhere else.
      provider: 'openai',
      baseUrl: 'http://evil.example',
      apiKey: 'sk-should-be-ignored',
      model: 'gpt-nonsense',
    })
    assert.equal(answer, 'SELECT 1')

    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.equal(request.provider, 'deepseek')
    assert.equal(request.model, 'deepseek-chat')
    assert.equal(request.reasoningEffort, 'low')
    assert.equal(request.system, 'be terse')
    assert.equal(request.maxTokens, 128)
    assert.equal(request.messages.length, 1)
    assert.equal(request.messages[0].role, 'user')
    assert.equal(request.messages[0].content[0].text, 'count the rows')
    assert.equal(request.messages[0].source.plugin, 'dsh-plugin-otools-dbm')
    assert.ok(request.signal !== undefined, 'a call nobody is waiting for must be abortable')

    const serialized = JSON.stringify(request)
    assert.equal(serialized.includes('evil.example'), false)
    assert.equal(serialized.includes('sk-should-be-ignored'), false)
  })

  it('reports a terminal error chunk instead of returning empty text', async () => {
    const ai = {
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }]),
      defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    // `llm/stream` signals failure with a finish chunk, not a throw.
    await assert.rejects(() => generateText(ai, { userPrompt: 'x' }), /rate limited/)
  })

  it('reports an aborted stream as a timeout', async () => {
    const ai = {
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted' } }]),
      defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    await assert.rejects(() => generateText(ai, { userPrompt: 'x' }), /中断/)
  })

  it('refuses an empty answer rather than handing the panel nothing', async () => {
    const ai = {
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]),
      defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }
    await assert.rejects(() => generateText(ai, { userPrompt: 'x' }), /没有返回内容/)
  })

  it('unwraps the code fence a model insists on adding', () => {
    assert.equal(unwrapModelText('```sql\nSELECT 1\n```'), 'SELECT 1')
    assert.equal(unwrapModelText('```\nSELECT 1\n```'), 'SELECT 1')
    assert.equal(unwrapModelText('```vue\n<template></template>\n```'), '<template></template>')
    // A fence in the MIDDLE is part of the answer, not a wrapper.
    assert.match(unwrapModelText('here:\n```sql\nSELECT 1\n```'), /here:/)
    assert.equal(unwrapModelText('  SELECT 1  '), 'SELECT 1')
  })

  it('ignores a broken default-model service', () => {
    assert.equal(resolveRoute(undefined), undefined)
    assert.equal(resolveRoute({}), undefined)
    assert.equal(resolveRoute({ currentSelection: () => { throw new Error('boom') } }), undefined)
    assert.equal(resolveRoute({ currentSelection: () => ({ provider: 'p' }) }), undefined)
  })

  it('round-trips a chat history and caps it', async () => {
    await saveChatHistory('dbm-query-1-shop', [
      { role: 'user', content: '  统计一下  ' },
      { role: 'assistant', content: 'SELECT count(*) FROM t' },
      { role: 'user', content: '   ' },
    ])
    const history = await loadChatHistory('dbm-query-1-shop')
    assert.equal(history.length, 2, 'an empty message is dropped')
    assert.equal(history[0].content, '统计一下')
    assert.equal(history[0].role, 'user')
    assert.equal(typeof history[0].id, 'string')
    assert.match(history[0].createdAt, /^\d{4}-\d{2}-\d{2}T/)

    const many = Array.from({ length: 260 }, (_, index) => ({ role: 'user', content: `m${index}` }))
    await saveChatHistory('dbm-query-1-shop', many)
    const capped = await loadChatHistory('dbm-query-1-shop')
    assert.equal(capped.length, 200, 'a chat that grows without bound eventually stops parsing')
    assert.equal(capped.at(-1).content, 'm259')
  })

  it('refuses a chat prefix that could escape its filename', async () => {
    await assert.rejects(() => saveChatHistory('../../evil', []), /不合法/)
    await assert.rejects(() => loadChatHistory(''), /不合法/)
  })
})
