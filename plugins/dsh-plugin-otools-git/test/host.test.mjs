/**
 * End-to-end host test: mount the routes on a real http server against a real
 * temporary git repository, then drive the API the way the browser does.
 *
 * Uses `node:test` with no test framework and no network beyond loopback, so it
 * runs in CI on every platform. Every `git` call is the real binary — the point
 * of this file is that the porcelain parsing matches the git that is installed,
 * which a mock would not tell us.
 *
 * @module dsh-plugin-otools-git/test/host
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { registerGitRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { PrefsStore } from '../src/host/store.js'
import { createRepoIndex } from '../src/host/workspaces.js'

/** Run git in a directory, throwing with its stderr on failure. */
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

describe('host routes', () => {
  let dir
  let repo
  let server
  let base
  let dispose
  /** The workspace list the fake registry serves; mutated by one test. */
  const workspaceRows = []

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-og-test-'))
    repo = join(dir, 'repo')
    git(dir, 'init', '--initial-branch=main', 'repo')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'bee\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first commit')
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n', 'utf8')
    await writeFile(join(repo, 'c.txt'), 'see\n', 'utf8')
    git(repo, 'add', 'a.txt')

    // A mutable list so one test can add a workspace whose folder does not exist.
    workspaceRows.push({ id: 'ws1', path: repo, title: 'repo' })
    const workspaces = {
      list: () => workspaceRows,
      get: (id) => workspaceRows.find((row) => row.id === id),
    }
    const prefs = new PrefsStore({ file: join(dir, 'prefs.json') })
    const repos = createRepoIndex({ workspaces })
    const routes = []
    const ctx = {
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    }
    dispose = registerGitRoutes(ctx, {
      prefs,
      repos,
      credentialsFile: join(dir, 'credentials.json'),
      ai: {},
    })

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
      const prefix = routes.find((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
      const route = exact ?? prefix
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

  /** GET one route, asserting the ok envelope. */
  async function get(path) {
    const response = await fetch(`${base}${path}`)
    const body = await response.json()
    assert.equal(body.ok, true, `GET ${path} failed: ${JSON.stringify(body.error)}`)
    return body.value
  }

  /** POST one route, asserting the ok envelope. */
  async function post(path, payload) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
    const body = await response.json()
    assert.equal(body.ok, true, `POST ${path} failed: ${JSON.stringify(body.error)}`)
    return body.value
  }

  /** POST one route expecting a failure, answering with its error. */
  async function postFail(path, payload) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
    const body = await response.json()
    assert.equal(body.ok, false, `POST ${path} unexpectedly succeeded`)
    return body.error
  }

  it('lists the workspace as a repository', async () => {
    const rows = await get('/repos')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].workspaceId, 'ws1')
    assert.equal(rows[0].isRepo, true)
    assert.equal(rows[0].branch, 'main')
  })

  it('survives a workspace whose folder is gone', async () => {
    // A folder the user deleted must degrade to "not a repository", not take the
    // whole list down — and definitely not be reported as "git is not installed".
    workspaceRows.push({ id: 'ws-gone', path: join(dir, 'deleted-' + Date.now()), title: 'gone' })
    try {
      const rows = await get('/repos')
      assert.equal(rows.length, 2)
      const gone = rows.find((row) => row.workspaceId === 'ws-gone')
      assert.equal(gone.isRepo, false)
      // The real repository is still listed and still readable.
      assert.equal(rows.find((row) => row.workspaceId === 'ws1').isRepo, true)
      const response = await fetch(`${base}/status?workspaceId=ws-gone`)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'not_repo')
    } finally {
      workspaceRows.length = 1
    }
  })

  it('reports the working tree split into sections', async () => {
    const status = await get('/status?workspaceId=ws1')
    assert.equal(status.branch, 'main')
    assert.equal(status.repoState.state, 'clean')
    assert.deepEqual(status.groups.staged.map((row) => row.path), ['a.txt'])
    assert.deepEqual(status.groups.untracked.map((row) => row.path), ['c.txt'])
    assert.equal(status.counts.total, 2)
  })

  it('diffs the index and one file inside it', async () => {
    const summary = await get('/diff/summary?workspaceId=ws1&kind=staged')
    assert.deepEqual(summary.files.map((row) => row.path), ['a.txt'])
    assert.equal(summary.files[0].additions, 2)
    assert.equal(summary.files[0].deletions, 1)

    const diff = await get('/diff/file?workspaceId=ws1&kind=staged&path=a.txt')
    const adds = diff.lines.filter((line) => line.kind === 'add').map((line) => line.text)
    assert.deepEqual(adds, ['TWO', 'four'])
    const dels = diff.lines.filter((line) => line.kind === 'del').map((line) => line.text)
    assert.deepEqual(dels, ['two'])
    // Line numbers must be tracked per hunk for the gutter to be right.
    const firstAdd = diff.lines.find((line) => line.kind === 'add')
    assert.equal(typeof firstAdd.newNo, 'number')
  })

  it('reads history with the reference date format', async () => {
    const page = await get('/history?workspaceId=ws1&limit=10')
    assert.equal(page.rows.length, 1)
    assert.equal(page.rows[0].subject, 'first commit')
    assert.match(page.rows[0].date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.deepEqual(page.rows[0].parents, [])
  })

  it('stages, commits and unstages through the API', async () => {
    await post('/stage', { workspaceId: 'ws1', paths: ['c.txt'] })
    let status = await get('/status?workspaceId=ws1')
    assert.deepEqual(status.groups.untracked, [])
    assert.deepEqual(status.groups.staged.map((row) => row.path), ['a.txt', 'c.txt'])

    const result = await post('/commit', { workspaceId: 'ws1', message: 'second commit\n\nwith a body' })
    assert.match(result.oid, /^[0-9a-f]{40}$/)

    status = await get('/status?workspaceId=ws1')
    assert.equal(status.counts.total, 0)
    const page = await get('/history?workspaceId=ws1&limit=10')
    assert.equal(page.rows.length, 2)
    assert.equal(page.rows[0].subject, 'second commit')
    assert.match(page.rows[0].message, /with a body/)
  })

  it('filters history by message, author and hash', async () => {
    const byMessage = await get('/history?workspaceId=ws1&limit=10&message=second')
    assert.equal(byMessage.rows.length, 1)
    const byAuthor = await get('/history?workspaceId=ws1&limit=10&author=Test')
    assert.equal(byAuthor.rows.length, 2)
    const full = await get('/history?workspaceId=ws1&limit=10')
    const byHash = await get(`/history?workspaceId=ws1&limit=10&hash=${full.rows[1].shortHash}`)
    assert.equal(byHash.rows.length, 1)
    assert.equal(byHash.rows[0].hash, full.rows[1].hash)
    const none = await get('/history?workspaceId=ws1&limit=10&message=nothing-matches-this')
    assert.equal(none.rows.length, 0)
  })

  it('creates, checks out and deletes a branch', async () => {
    await post('/branch/create', { workspaceId: 'ws1', name: 'feature/x', checkout: true })
    let branches = await get('/branches?workspaceId=ws1')
    const feature = branches.find((row) => row.name === 'feature/x')
    assert.equal(feature.current, true)

    const validation = await post('/branch/validate-checkout', { workspaceId: 'ws1', name: 'main' })
    assert.equal(validation.canCheckout, true)
    // A local change to a file the switch would rewrite is reported, not hidden.
    await writeFile(join(repo, 'a.txt'), 'about to collide\n', 'utf8')
    git(repo, 'commit', '-am', 'diverge on feature')
    await writeFile(join(repo, 'a.txt'), 'uncommitted\n', 'utf8')
    const blocked = await post('/branch/validate-checkout', { workspaceId: 'ws1', name: 'main' })
    assert.equal(blocked.canCheckout, false)
    assert.deepEqual(blocked.conflicts, ['a.txt'])
    await post('/discard', { workspaceId: 'ws1', tracked: ['a.txt'] })
    await post('/branch/checkout', { workspaceId: 'ws1', name: 'main' })
    await post('/branch/delete', { workspaceId: 'ws1', names: ['feature/x'], force: true })
    branches = await get('/branches?workspaceId=ws1')
    assert.equal(branches.some((row) => row.name === 'feature/x'), false)
  })

  it('creates and lists a tag, then deletes it', async () => {
    await post('/tag/create', { workspaceId: 'ws1', name: 'v1.0.0', message: 'release one' })
    const tags = await get('/tags?workspaceId=ws1')
    assert.equal(tags.length, 1)
    assert.equal(tags[0].name, 'v1.0.0')
    assert.equal(tags[0].annotated, true)
    assert.equal(tags[0].subject, 'release one')
    await post('/tag/delete', { workspaceId: 'ws1', names: ['v1.0.0'] })
    assert.equal((await get('/tags?workspaceId=ws1')).length, 0)
  })

  it('stashes a change, shows its diff and pops it', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n', 'utf8')
    const created = await post('/stash/create', { workspaceId: 'ws1', message: 'wip here' })
    assert.equal(created.noChanges, false)
    const stashes = await get('/stashes?workspaceId=ws1')
    assert.equal(stashes.length, 1)
    assert.equal(stashes[0].refName, 'stash@{0}')
    assert.match(stashes[0].message, /wip here/)

    const files = await get(`/stash/files?workspaceId=ws1&ref=${encodeURIComponent('stash@{0}')}`)
    assert.deepEqual(files.map((row) => row.path), ['a.txt'])
    const diff = await get(`/stash/diff?workspaceId=ws1&ref=${encodeURIComponent('stash@{0}')}`)
    assert.equal(diff.lines.some((line) => line.kind === 'add' && line.text === 'five'), true)

    const applied = await post('/stash/apply', { workspaceId: 'ws1', ref: 'stash@{0}', action: 'pop' })
    assert.equal(applied.conflict, false)
    assert.equal((await get('/stashes?workspaceId=ws1')).length, 0)
    await post('/discard', { workspaceId: 'ws1', tracked: ['a.txt'] })
  })

  it('discards a tracked change and deletes an untracked file', async () => {
    await writeFile(join(repo, 'a.txt'), 'ruined\n', 'utf8')
    await writeFile(join(repo, 'junk.txt'), 'junk\n', 'utf8')
    let status = await get('/status?workspaceId=ws1')
    assert.equal(status.counts.total, 2)
    await post('/discard', { workspaceId: 'ws1', tracked: ['a.txt'], untracked: ['junk.txt'] })
    status = await get('/status?workspaceId=ws1')
    assert.equal(status.counts.total, 0)
  })

  it('merges a branch and reports a conflict as an outcome', async () => {
    git(repo, 'checkout', '-b', 'side')
    await writeFile(join(repo, 'a.txt'), 'side change\n', 'utf8')
    git(repo, 'commit', '-am', 'side change')
    git(repo, 'checkout', 'main')
    await writeFile(join(repo, 'a.txt'), 'main change\n', 'utf8')
    git(repo, 'commit', '-am', 'main change')

    const result = await post('/merge', { workspaceId: 'ws1', ref: 'side' })
    assert.equal(result.conflict, true)
    const status = await get('/status?workspaceId=ws1')
    assert.equal(status.repoState.state, 'merging')
    assert.deepEqual(status.groups.conflicted.map((row) => row.path), ['a.txt'])

    const stages = await get('/conflict?workspaceId=ws1&path=a.txt')
    assert.equal(stages.ours.trim(), 'main change')
    assert.equal(stages.theirs.trim(), 'side change')

    await post('/conflict/resolve', { workspaceId: 'ws1', paths: ['a.txt'], side: 'ours' })
    await post('/sequencer', { workspaceId: 'ws1', operation: 'merge', action: 'continue' })
    assert.equal((await get('/status?workspaceId=ws1')).repoState.state, 'clean')
  })

  it('resets to the previous commit', async () => {
    const before = await get('/history?workspaceId=ws1&limit=5')
    await post('/reset', { workspaceId: 'ws1', ref: 'HEAD~1', mode: 'mixed' })
    const after2 = await get('/history?workspaceId=ws1&limit=5')
    assert.equal(after2.rows[0].hash, before.rows[1].hash)
  })

  it('reads and writes the identity, and refuses an unknown config key', async () => {
    const identity = await get('/identity?workspaceId=ws1')
    assert.equal(identity.effectiveName, 'Test')
    await post('/config/set', { workspaceId: 'ws1', key: 'user.name', value: 'Renamed', scope: 'local' })
    assert.equal((await get('/identity?workspaceId=ws1')).localName, 'Renamed')
    const error = await postFail('/config/set', { workspaceId: 'ws1', key: 'core.editor', value: 'vim' })
    assert.equal(error.code, 'invalid_input')
  })

  it('rejects a path that leaves the repository and a ref that looks like a flag', async () => {
    const escape = await postFail('/stage', { workspaceId: 'ws1', paths: ['../outside.txt'] })
    assert.equal(escape.code, 'invalid_input')
    const absolute = await postFail('/stage', { workspaceId: 'ws1', paths: ['/etc/passwd'] })
    assert.equal(absolute.code, 'invalid_input')
    const flag = await postFail('/branch/create', { workspaceId: 'ws1', name: '--upload-pack=touch' })
    assert.equal(flag.code, 'invalid_input')
    const transport = await postFail('/remote/add', { workspaceId: 'ws1', name: 'evil', url: 'ext::sh -c touch' })
    assert.equal(transport.code, 'invalid_input')
    const stash = await postFail('/stash/apply', { workspaceId: 'ws1', ref: 'HEAD', action: 'pop' })
    assert.equal(stash.code, 'invalid_input')
  })

  it('refuses a repository outside every registered workspace', async () => {
    const response = await fetch(`${base}/status?root=${encodeURIComponent(tmpdir())}`)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not_found')
  })

  it('manages remotes', async () => {
    await post('/remote/add', { workspaceId: 'ws1', name: 'origin', url: 'https://example.com/x.git' })
    let remotes = await get('/remotes?workspaceId=ws1')
    assert.equal(remotes.length, 1)
    assert.equal(remotes[0].host, 'example.com')
    await post('/remote/set-url', { workspaceId: 'ws1', name: 'origin', url: 'https://example.com/y.git' })
    remotes = await get('/remotes?workspaceId=ws1')
    assert.equal(remotes[0].url, 'https://example.com/y.git')
    await post('/remote/rename', { workspaceId: 'ws1', from: 'origin', to: 'upstream' })
    remotes = await get('/remotes?workspaceId=ws1')
    assert.equal(remotes[0].name, 'upstream')
    await post('/remote/remove', { workspaceId: 'ws1', name: 'upstream' })
    assert.equal((await get('/remotes?workspaceId=ws1')).length, 0)
  })

  it('persists preferences, globally and per workspace', async () => {
    const saved = await post('/prefs', { prefs: { activeTab: 'history', sidebarWidth: 300 } })
    assert.equal(saved.activeTab, 'history')
    assert.equal(saved.sidebarWidth, 300)
    const perRepo = await post('/prefs', { workspaceId: 'ws1', prefs: { activeTab: 'branches' } })
    assert.equal(perRepo.perRepo.ws1.activeTab, 'branches')
    assert.equal(perRepo.activeTab, 'history')
    // Out-of-range and unknown values are clamped/dropped, never stored raw.
    const clamped = await post('/prefs', { prefs: { sidebarWidth: 99_999, activeTab: 'nope' } })
    assert.equal(clamped.sidebarWidth, 640)
    assert.equal(clamped.activeTab, 'history')
    const read = await get('/prefs')
    assert.equal(read.prefs.sidebarWidth, 640)
  })

  it('reports the AI writer as unavailable without a model service', async () => {
    const availability = await get('/ai/availability')
    assert.equal(availability.available, false)
    assert.equal(typeof availability.reason, 'string')
  })

  it('reports the git installation', async () => {
    const install = await get('/install')
    assert.equal(install.installed, true)
    assert.match(install.version, /^git version/)
  })

  /**
   * The two commit shapes `git diff <rev>^!` gets wrong: a ROOT commit (which it
   * diffs against the current HEAD, so the first commit looks like it changed
   * everything since) and a MERGE commit (which it reports as no change at all).
   */
  it('diffs a root commit against nothing and a merge against its first parent', async () => {
    const page = await get('/history?workspaceId=ws1&limit=50&branch=all')
    const root = page.rows[page.rows.length - 1]
    const rootFiles = await get(`/diff/summary?workspaceId=ws1&kind=commit&rev=${root.hash}`)
    // The very first commit added exactly the two files it was created with.
    assert.deepEqual(rootFiles.files.map((row) => row.status).sort(), ['A', 'A'])
    assert.deepEqual(rootFiles.files.map((row) => row.path).sort(), ['a.txt', 'b.txt'])

    // A merge of its own, so this does not depend on what earlier tests left behind.
    git(repo, 'checkout', '-b', 'diff-side')
    await writeFile(join(repo, 'from-side.txt'), 'side only\n', 'utf8')
    git(repo, 'add', 'from-side.txt')
    git(repo, 'commit', '-m', 'side adds a file')
    git(repo, 'checkout', 'main')
    git(repo, 'merge', '--no-ff', '-m', 'merge diff-side', 'diff-side')

    const after2 = await get('/history?workspaceId=ws1&limit=10')
    const merge = after2.rows.find((row) => row.parents.length > 1)
    assert.notEqual(merge, undefined, 'the merge commit should be in history')
    const mergeFiles = await get(`/diff/summary?workspaceId=ws1&kind=commit&rev=${merge.hash}`)
    // Against its first parent the merge brought in exactly the side file.
    assert.deepEqual(mergeFiles.files.map((row) => row.path), ['from-side.txt'])
    const mergeDiff = await get(
      `/diff/file?workspaceId=ws1&kind=commit&rev=${merge.hash}&path=from-side.txt`)
    assert.ok(mergeDiff.lines.some((line) => line.kind === 'add' && line.text === 'side only'),
      'a merge commit file must produce diff lines')
  })

  it('lists worktrees and (empty) submodules', async () => {
    const children = await get('/children?workspaceId=ws1')
    assert.deepEqual(children.submodules, [])
    assert.equal(Array.isArray(children.worktrees), true)
  })

  /**
   * A repository with no commits has no HEAD, so `restore --staged` and `reset`
   * both fail — each with its own wording. Unstaging has to fall back to
   * `rm --cached`, and the first commit has to work.
   */
  it('stages, unstages and commits in a repository with no commits yet', async () => {
    const fresh = join(dir, 'unborn')
    git(dir, 'init', '--initial-branch=main', 'unborn')
    git(fresh, 'config', 'user.name', 'Test')
    git(fresh, 'config', 'user.email', 't@example.com')
    git(fresh, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(fresh, 'one.txt'), 'a\n', 'utf8')
    await writeFile(join(fresh, 'two.txt'), 'b\n', 'utf8')
    workspaceRows.push({ id: 'ws-unborn', path: fresh, title: 'unborn' })
    try {
      let status = await get('/status?workspaceId=ws-unborn')
      assert.equal(status.unborn, true)
      assert.equal(status.counts.untracked, 2)

      await post('/stage', { workspaceId: 'ws-unborn', paths: ['one.txt', 'two.txt'] })
      status = await get('/status?workspaceId=ws-unborn')
      assert.equal(status.counts.staged, 2)

      // The per-file path: `restore --staged` says "could not resolve 'HEAD'".
      await post('/unstage', { workspaceId: 'ws-unborn', paths: ['two.txt'] })
      status = await get('/status?workspaceId=ws-unborn')
      assert.deepEqual(status.groups.staged.map((row) => row.path), ['one.txt'])
      assert.deepEqual(status.groups.untracked.map((row) => row.path), ['two.txt'])

      const result = await post('/commit', { workspaceId: 'ws-unborn', message: 'first ever' })
      assert.match(result.oid, /^[0-9a-f]{40}$/)
      const page = await get('/history?workspaceId=ws-unborn&limit=5')
      assert.equal(page.rows.length, 1)
      assert.deepEqual(page.rows[0].parents, [])
    } finally {
      workspaceRows.length = 1
    }
  })
})
