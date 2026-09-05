/**
 * Security regressions.
 *
 * Every case here was a working exploit at some point in this plugin's history,
 * and every one of them had the same shape: a value that reached a `git` argv
 * without going through `src/shared/protocol.js`. git accepts options anywhere on
 * its command line, so "it is only a revision" is not a defence — `--output=`
 * truncates a file and `--contents=` reads one.
 *
 * @module dsh-plugin-otools-git/test/security
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { registerGitRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { PrefsStore } from '../src/host/store.js'
import { createRepoIndex } from '../src/host/workspaces.js'
import { isInside } from '../src/host/commit.js'

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

describe('security', () => {
  let dir
  let repo
  let secretFile
  let victimFile
  let server
  let dispose
  let base

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-og-sec-'))
    repo = join(dir, 'repo')
    git(dir, 'init', '--initial-branch=main', 'repo')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first')

    // Two files OUTSIDE the repository: one to try to read, one to try to clobber.
    secretFile = join(dir, 'top-secret.json')
    await writeFile(secretFile, '{"password":"correct-horse"}', 'utf8')
    victimFile = join(dir, 'victim.txt')
    await writeFile(victimFile, 'PLEASE DO NOT OVERWRITE ME', 'utf8')
    // A sibling directory whose path shares the repository's prefix — the case a
    // bare `startsWith` containment check lets through.
    await writeFile(join(dir, 'repo-secrets.txt'), 'sibling secret', 'utf8')

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
      ai: {},
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

  /** GET one route, answering with the parsed envelope either way. */
  async function get(path) {
    const response = await fetch(`${base}${path}`)
    return response.json()
  }

  /** POST one route, answering with the parsed envelope either way. */
  async function post(path, payload) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
    return response.json()
  }

  it('refuses a rev that is really a git option (arbitrary file read)', async () => {
    // `git blame --contents=<file>` substitutes that file's contents and
    // --porcelain echoes them back — an arbitrary read through a query string.
    const body = await get('/blame?workspaceId=ws1&path=a.txt&rev=' +
      encodeURIComponent('--contents=' + secretFile))
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'invalid_input')
    const blob = JSON.stringify(body)
    assert.equal(blob.includes('correct-horse'), false, 'the secret leaked into the response')
  })

  it('refuses an option-shaped rev, branch and stash ref (arbitrary file write)', async () => {
    // `--output=<file>` makes git truncate and rewrite that file.
    const attempts = [
      '/history?workspaceId=ws1&branch=' + encodeURIComponent('--output=' + victimFile),
      '/diff/summary?workspaceId=ws1&kind=commit&rev=' + encodeURIComponent('--output=' + victimFile),
      '/diff/file?workspaceId=ws1&kind=commit&path=a.txt&rev=' + encodeURIComponent('--output=' + victimFile),
      '/commit?workspaceId=ws1&rev=' + encodeURIComponent('--output=' + victimFile),
      '/stash/files?workspaceId=ws1&ref=' + encodeURIComponent('--output=' + victimFile),
      '/stash/diff?workspaceId=ws1&ref=' + encodeURIComponent('--output=' + victimFile),
      '/diff/summary?workspaceId=ws1&kind=range&from=main&to=' + encodeURIComponent('--output=' + victimFile),
    ]
    for (const path of attempts) {
      const body = await get(path)
      assert.equal(body.ok, false, path + ' should have been refused')
      assert.equal(body.error.code, 'invalid_input', path + ' had the wrong code')
    }
    assert.equal(await readFile(victimFile, 'utf8'), 'PLEASE DO NOT OVERWRITE ME',
      'a request overwrote a file outside the repository')
  })

  it('refuses a path that leaves the worktree, including a prefix sibling', async () => {
    for (const path of ['../top-secret.json', '../repo-secrets.txt', '/etc/passwd', 'a/../../x']) {
      const body = await get('/worktree-file?workspaceId=ws1&path=' + encodeURIComponent(path))
      assert.equal(body.ok, false, path + ' should have been refused')
      assert.equal(body.error.code, 'invalid_input', path + ' had the wrong code')
    }
    // Same for the conflict view and the file-history route, which take a path too.
    for (const route of ['/conflict', '/file/history']) {
      const body = await get(route + '?workspaceId=ws1&path=' + encodeURIComponent('../top-secret.json'))
      assert.equal(body.ok, false, route + ' should have been refused')
    }
  })

  it('containment requires a separator, not just a prefix', () => {
    assert.equal(isInside('/a/repo', '/a/repo/file.txt'), true)
    assert.equal(isInside('/a/repo', '/a/repo'), true)
    // The bug this pins: a sibling whose name starts with the root's name.
    assert.equal(isInside('/a/repo', '/a/repo-secrets/id_rsa'), false)
    assert.equal(isInside('/a/repo', '/a/other/file.txt'), false)
  })

  it('refuses to disable git ownership checks through safe.directory', async () => {
    for (const paths of [['*'], ['%(prefix)'], ['--global'], ['relative/path']]) {
      const body = await post('/safe-directory', { workspaceId: 'ws1', paths })
      assert.equal(body.ok, false, JSON.stringify(paths) + ' should have been refused')
    }
    // And a real absolute path that is not a repository DSH knows about.
    const body = await post('/safe-directory', { workspaceId: 'ws1', paths: [dir] })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not_found')
  })

  it('refuses an option-shaped ssh host', async () => {
    for (const host of ['-oProxyCommand=touch x', '--help', 'a b', 'host;touch x']) {
      const body = await post('/ssh/inspect', { host })
      assert.equal(body.ok, false, host + ' should have been refused')
      assert.equal(body.error.code, 'invalid_input')
    }
  })

  it('refuses a repository outside every registered workspace', async () => {
    for (const path of [dir, tmpdir(), join(dir, 'repo-secrets.txt')]) {
      const body = await get('/status?root=' + encodeURIComponent(path))
      assert.equal(body.ok, false, path + ' should have been refused')
    }
  })

  it('never returns credential material, only which host has one', async () => {
    const saved = await post('/credentials', {
      host: 'example.com',
      username: 'someone',
      password: 'super-secret-token',
    })
    assert.equal(saved.ok, true)
    const blob = JSON.stringify(saved)
    assert.equal(blob.includes('super-secret-token'), false, 'the password came back in the response')
    assert.ok(blob.includes('example.com'))
    assert.ok(blob.includes('someone'))

    const listed = await get('/credentials')
    assert.equal(JSON.stringify(listed).includes('super-secret-token'), false)

    // Nor does it leak through an error message on a failing network call.
    const push = await post('/push', { workspaceId: 'ws1', remote: 'nope' })
    assert.equal(JSON.stringify(push).includes('super-secret-token'), false)
  })
})
