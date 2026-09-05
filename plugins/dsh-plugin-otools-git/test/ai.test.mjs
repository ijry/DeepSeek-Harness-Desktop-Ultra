/**
 * The AI commit-message writer, against a fake `ctx.llm`.
 *
 * A real model cannot be called from a test, but the shape of the call can be
 * asserted exactly — and that shape is the whole integration: which route DSH's
 * `agentDefaultModel` picked, that the diff is fenced as data, that text deltas
 * are concatenated in order, that a `finish` reason other than `stop` is
 * reported, and that the model's fenced/prefixed wrapping is stripped.
 *
 * @module dsh-plugin-otools-git/test/ai
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { aiAvailability, collectContext, resolveRoute, writeCommitMessage } from '../src/host/ai.js'

/** Run git with a deterministic identity. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig-test'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

/** A stand-in for DSH's `ctx.llm` that replays a fixed chunk script. */
function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* replay() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** A stand-in for DSH's `ctx.agentDefaultModel`. */
function fakeModel(selection) {
  return { currentSelection: () => selection }
}

describe('AI commit-message writer', () => {
  let dir
  let repo

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-og-ai-'))
    repo = join(dir, 'repo')
    git(dir, 'init', '--initial-branch=main', 'repo')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'auth.js'), 'export const a = 1\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fix: earlier thing')
    await writeFile(join(repo, 'auth.js'), 'export const a = 2\nexport const b = 3\n', 'utf8')
    git(repo, 'add', 'auth.js')
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('reads the route out of the default-model service', () => {
    assert.deepEqual(resolveRoute(fakeModel({ provider: 'p', model: 'm' })),
      { provider: 'p', model: 'm', reasoningEffort: undefined })
    assert.equal(resolveRoute(undefined), undefined)
    assert.equal(resolveRoute({}), undefined)
    assert.equal(resolveRoute(fakeModel({ provider: 'p' })), undefined)
    // A service that throws must be reported as "no route", not crash the route.
    assert.equal(resolveRoute({ currentSelection: () => { throw new Error('nope') } }), undefined)
  })

  it('reports why it is unavailable rather than hiding the button', () => {
    assert.deepEqual(aiAvailability(undefined, undefined),
      { available: false, reason: '当前 DSH 没有可用的模型服务' })
    assert.deepEqual(aiAvailability({ stream: () => undefined }, undefined),
      { available: false, reason: 'DSH 还没有配置默认模型' })
    assert.deepEqual(aiAvailability({ stream: () => undefined }, fakeModel({ provider: 'p', model: 'm' })),
      { available: true, provider: 'p', model: 'm' })
  })

  it('collects the staged diff, the branch and the recent subjects', async () => {
    const context = await collectContext(repo, {})
    assert.equal(context.source, 'staged')
    assert.match(context.stat, /auth\.js/)
    assert.match(context.patch, /\+export const b = 3/)
    assert.equal(context.branch, 'main')
    assert.deepEqual(context.recentSubjects, ['fix: earlier thing'])
    assert.equal(context.truncated, false)
  })

  it('falls back to the worktree when nothing is staged', async () => {
    const clean = join(dir, 'clean')
    git(dir, 'init', '--initial-branch=main', 'clean')
    git(clean, 'config', 'user.name', 'Test')
    git(clean, 'config', 'user.email', 't@example.com')
    git(clean, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(clean, 'x.txt'), 'one\n', 'utf8')
    git(clean, 'add', '.')
    git(clean, 'commit', '-m', 'init')
    await writeFile(join(clean, 'x.txt'), 'two\n', 'utf8')
    const context = await collectContext(clean, {})
    assert.equal(context.source, 'worktree')
    assert.match(context.patch, /\+two/)
  })

  it('refuses when there is nothing to describe', async () => {
    const empty = join(dir, 'empty')
    git(dir, 'init', '--initial-branch=main', 'empty')
    git(empty, 'config', 'user.name', 'Test')
    git(empty, 'config', 'user.email', 't@example.com')
    git(empty, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(empty, 'y.txt'), 'one\n', 'utf8')
    git(empty, 'add', '.')
    git(empty, 'commit', '-m', 'init')
    await assert.rejects(() => collectContext(empty, {}), (error) => {
      assert.equal(error.code, 'nothing_to_do')
      return true
    })
  })

  it('sends one user turn with the diff fenced as data, and no session', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'feat(auth): ' },
      { type: 'text-delta', text: 'add b\n\n- bump a to 2' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const result = await writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      root: repo,
    })
    assert.equal(result.message, 'feat(auth): add b\n\n- bump a to 2')
    assert.equal(result.subject, 'feat(auth): add b')
    assert.equal(result.provider, 'deepseek-official')
    assert.equal(result.model, 'deepseek-chat')
    assert.equal(result.cutoff, false)

    assert.equal(llm.calls.length, 1)
    const call = llm.calls[0]
    assert.equal(call.provider, 'deepseek-official')
    assert.equal(call.model, 'deepseek-chat')
    assert.equal(call.messages.length, 1)
    assert.equal(call.messages[0].role, 'user')
    assert.equal(call.messages[0].content[0].type, 'text')
    assert.match(call.messages[0].content[0].text, /```diff/)
    assert.deepEqual(call.messages[0].source, { kind: 'plugin', plugin: 'dsh-plugin-otools-git' })
    assert.match(call.system, /只输出提交信息本身/)
    // No session, no purpose: this must not be logged as a session turn.
    assert.equal(call.sessionId, undefined)
    assert.equal(call.purpose, undefined)
    assert.equal(typeof call.maxTokens, 'number')
    assert.notEqual(call.signal, undefined)
  })

  it('streams the deltas to the caller in order', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'chore: ' },
      { type: 'text-delta', text: 'tidy' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const seen = []
    await writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
      onDelta: (text) => seen.push(text),
    })
    assert.deepEqual(seen, ['chore: ', 'tidy'])
  })

  it('strips the wrapping a model likes to add', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: '```\nfeat: wrapped\n```' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const result = await writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
    })
    assert.equal(result.message, 'feat: wrapped')
  })

  it('flags a length cutoff instead of handing back a truncated message silently', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'feat: half a sen' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const result = await writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
    })
    assert.equal(result.cutoff, true)
  })

  it('reports a terminal error chunk as a failure, not as an empty message', async () => {
    const llm = fakeLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream is down' } } },
    ])
    await assert.rejects(() => writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
    }), (error) => {
      assert.equal(error.code, 'ai_unavailable')
      assert.match(error.message, /upstream is down/)
      return true
    })
  })

  it('reports an empty answer as a failure', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    await assert.rejects(() => writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
    }), (error) => {
      assert.equal(error.code, 'ai_unavailable')
      return true
    })
  })

  it('refuses without a model service or a configured route', async () => {
    await assert.rejects(() => writeCommitMessage({ root: repo }), (error) => {
      assert.equal(error.code, 'ai_unavailable')
      return true
    })
    await assert.rejects(() => writeCommitMessage({
      llm: fakeLlm([]),
      defaultModel: undefined,
      root: repo,
    }), (error) => {
      assert.equal(error.code, 'ai_unavailable')
      return true
    })
  })

  it('honours the English and plain-style options', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'Add b' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await writeCommitMessage({
      llm,
      defaultModel: fakeModel({ provider: 'p', model: 'm' }),
      root: repo,
      style: 'plain',
      language: 'en',
      hint: 'mention the bump',
    })
    const call = llm.calls[0]
    assert.match(call.system, /Write in English/)
    assert.doesNotMatch(call.system, /Conventional Commits/)
    assert.match(call.messages[0].content[0].text, /mention the bump/)
    assert.match(call.messages[0].content[0].text, /Author note/)
  })
})
