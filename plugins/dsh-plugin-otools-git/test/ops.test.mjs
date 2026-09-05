/**
 * The operation registry and the AI route that uses it, over real HTTP.
 *
 * This is the path the progress dialog and the streaming commit box read, and it
 * is the one place `partial` (streamed content) and `log` (progress lines) have to
 * stay separate — the commit message's newlines live in the former.
 *
 * @module dsh-plugin-otools-git/test/ops
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createOperations } from '../src/host/ops.js'
import { registerGitRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { PrefsStore } from '../src/host/store.js'
import { createRepoIndex } from '../src/host/workspaces.js'

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

describe('operation registry', () => {
  it('reports a run through its records and keeps content out of the log', async () => {
    const seen = []
    const operations = createOperations({ onChange: (record) => seen.push(record) })
    const started = operations.start({ kind: 'push', title: 'x', command: 'git push', root: '/r' }, async (reporter) => {
      reporter.progress({ percent: 30, label: '写入对象' })
      reporter.log('Writing objects:  30% (3/10)')
      reporter.partial('line one\n')
      reporter.partial('\nline two')
      // A later phase must not rewind the bar.
      reporter.progress({ percent: 10, label: '不该后退' })
      return { ok: true }
    })
    assert.equal(started.status, 'running')
    await new Promise((r) => setTimeout(r, 60))

    const final = operations.get(started.id)
    assert.equal(final.status, 'done')
    assert.equal(final.percent, 100)
    assert.deepEqual(final.result, { ok: true })
    assert.deepEqual(final.log, ['Writing objects:  30% (3/10)'])
    // The newlines survive in `partial` — that is the whole reason it exists.
    assert.equal(final.partial, 'line one\n\nline two')
    // The mid-run record showed the higher percentage, never the lower one.
    assert.ok(seen.some((record) => record.percent === 30))
    assert.ok(!seen.some((record) => record.percent === 10))
  })

  it('records a failure with its code and does not throw', async () => {
    const operations = createOperations({})
    const started = operations.start({ kind: 'fetch', title: 'y', root: '/r' }, async () => {
      const error = new Error('boom')
      error.code = 'network'
      error.stderr = 'fatal: could not read from remote\n'
      throw error
    })
    await new Promise((r) => setTimeout(r, 60))
    const final = operations.get(started.id)
    assert.equal(final.status, 'failed')
    assert.equal(final.error.message, 'boom')
    assert.ok(final.log.some((line) => line.includes('could not read from remote')))
  })

  it('cancels a running operation through its signal', async () => {
    const operations = createOperations({})
    const started = operations.start({ kind: 'clone', title: 'z', root: '/r' }, async (reporter) => {
      await new Promise((resolveWait, rejectWait) => {
        reporter.signal.addEventListener('abort', () => rejectWait(new Error('aborted')), { once: true })
        setTimeout(resolveWait, 5_000)
      })
    })
    operations.cancel(started.id)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(operations.get(started.id).status, 'canceled')
  })

  it('reports which repository is busy, so a second mutation can be refused', async () => {
    const operations = createOperations({})
    let release
    const started = operations.start({ kind: 'pull', title: 'w', root: '/r' }, () =>
      new Promise((resolveWait) => {
        release = resolveWait
      }))
    assert.equal(operations.busy('/r').id, started.id)
    assert.equal(operations.busy('/other'), undefined)
    release()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(operations.busy('/r'), undefined)
    operations.dispose()
  })
})

describe('AI route', () => {
  let dir
  let repo
  let server
  let dispose
  let base
  const llmCalls = []

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-og-ops-'))
    repo = join(dir, 'repo')
    git(dir, 'init', '--initial-branch=main', 'repo')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', 'a.txt')

    const workspaces = {
      list: () => [{ id: 'ws1', path: repo, title: 'repo' }],
      get: (id) => (id === 'ws1' ? { id: 'ws1', path: repo, title: 'repo' } : undefined),
    }
    const routes = []
    dispose = registerGitRoutes({
      webServer: {
        register(route) {
          routes.push(route)
          return () => undefined
        },
      },
    }, {
      prefs: new PrefsStore({ file: join(dir, 'prefs.json') }),
      repos: createRepoIndex({ workspaces }),
      credentialsFile: join(dir, 'credentials.json'),
      ai: {
        llm: {
          stream(options) {
            llmCalls.push(options)
            return (async function* replay() {
              yield { type: 'text-delta', text: 'feat: add two\n' }
              yield { type: 'text-delta', text: '\n- second line of the body' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        },
        defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      },
    })
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = routes.find((row) => row.kind === 'exact' && row.path === url.pathname) ??
        routes.find((row) => row.kind === 'prefix' && url.pathname.startsWith(row.path))
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      route.handler(req, res)
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  })

  after(async () => {
    dispose?.()
    await new Promise((resolveClose) => server.close(resolveClose))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('reports the AI writer as available when both services are injected', async () => {
    const response = await fetch(`${base}/ai/availability`)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.available, true)
    assert.equal(body.value.model, 'm')
  })

  it('answers 202 with an operation record and finishes it with the message', async () => {
    const response = await fetch(`${base}/ai/commit-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws1', style: 'conventional', language: 'zh' }),
    })
    assert.equal(response.status, 202)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.kind, 'ai-commit-message')
    assert.equal(body.value.status, 'running')

    // Poll the record until the fake stream drains.
    let record
    for (let i = 0; i < 60; i += 1) {
      const poll = await fetch(`${base}/ops/${body.value.id}`)
      record = (await poll.json()).value
      if (record.status !== 'running') break
      await new Promise((r) => setTimeout(r, 40))
    }
    assert.equal(record.status, 'done')
    assert.equal(record.result.message, 'feat: add two\n\n- second line of the body')
    assert.equal(record.result.subject, 'feat: add two')
    // The streamed copy kept its blank line — the commit box renders this live.
    assert.equal(record.partial, 'feat: add two\n\n- second line of the body')
    assert.equal(llmCalls.length, 1)
  })

  it('rejects an unknown style before spending a token', async () => {
    const before2 = llmCalls.length
    const response = await fetch(`${base}/ai/commit-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws1', style: 'haiku' }),
    })
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'invalid_input')
    assert.equal(llmCalls.length, before2)
  })
})
