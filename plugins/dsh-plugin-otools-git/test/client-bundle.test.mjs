/**
 * Client bundle test: load the built bundle into a synthetic DOM, mount it, and
 * drive it against the real host routes.
 *
 * This is the check the syntax pass cannot make: the client fragments share ONE
 * lexical scope, so a name declared twice, or a function called before its
 * fragment is concatenated, only shows up when the bundle actually runs.
 *
 * The DOM here is hand-rolled rather than jsdom — the panel uses a small, fixed
 * slice of the DOM API, and a dependency-free test keeps `npm run check` honest
 * about this package having no dependencies at all.
 *
 * @module dsh-plugin-otools-git/test/client-bundle
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { registerGitRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { PrefsStore } from '../src/host/store.js'
import { createRepoIndex } from '../src/host/workspaces.js'
import { installDom } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Run git in a directory with a deterministic identity. */
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

describe('client bundle', () => {
  let dir
  let repo
  let server
  let dispose
  let dom
  let plugin
  let disposeClient

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-og-client-'))
    repo = join(dir, 'repo')
    git(dir, 'init', '--initial-branch=main', 'repo')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first commit')
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\n', 'utf8')
    await writeFile(join(repo, 'new.txt'), 'fresh\n', 'utf8')
    git(repo, 'add', 'a.txt')

    // The host, on a real loopback server.
    const workspaces = {
      list: () => [{ id: 'ws1', path: repo, title: 'repo' }],
      get: (id) => (id === 'ws1' ? { id: 'ws1', path: repo, title: 'repo' } : undefined),
    }
    const routes = []
    dispose = registerGitRoutes({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
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
    const base = `http://127.0.0.1:${server.address().port}`

    // The browser side: a synthetic DOM, then the built bundle evaluated in it.
    dom = installDom({ origin: base, routePrefix: ROUTE_PREFIX })
    const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    // The loader the wrapper calls.
    dom.window.__ModuleLoader__ = {
      load(entry) {
        plugin = entry.factory(() => undefined)
      },
    }
    const run = new Function('window', 'document', 'navigator', 'fetch', 'EventSource',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
      'MutationObserver', 'CustomEvent', 'URLSearchParams', 'console',
      'Node', 'Element', 'HTMLElement', bundle)
    run(dom.window, dom.document, dom.window.navigator, dom.window.fetch, dom.window.EventSource,
      setTimeout, clearTimeout, setInterval, clearInterval, dom.window.requestAnimationFrame,
      dom.window.MutationObserver, dom.window.CustomEvent, URLSearchParams, console,
      dom.Node, dom.Element, dom.HTMLElement)
  })

  after(async () => {
    // The panel keeps a MutationObserver and a 3s re-mount interval alive, so it
    // MUST be disposed or the test runner never sees the event loop drain.
    disposeClient?.()
    dom?.restore()
    dispose?.()
    await new Promise((resolveClose) => server.close(resolveClose))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  /** Let the panel's pending fetches settle. */
  async function settle(rounds = 12) {
    for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 30))
  }

  /**
   * Wait until the panel shows something. The boot does four sequential rounds of
   * `git` spawns, and on Windows those are slow enough that a fixed sleep is a
   * flake generator.
   */
  async function waitFor(predicate, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 40))
    }
    const panel = dom.document.querySelector('[data-dsh-og-panel]')
    assert.fail('timed out waiting for ' + label + '; panel text was: ' +
      (panel === null ? '(no panel)' : panel.textContent.slice(0, 400)))
  }

  /** The whole panel's text, for the "does it say X" assertions. */
  function panelText() {
    const panel = dom.document.querySelector('[data-dsh-og-panel]')
    return panel === null ? '' : panel.textContent
  }

  it('exports the DSH client plugin shape', () => {
    assert.equal(typeof plugin, 'object')
    assert.equal(plugin.name, 'dsh-plugin-otools-git/client')
    assert.deepEqual(plugin.inject, [])
    assert.equal(typeof plugin.apply, 'function')
  })

  it('mounts a sidebar entry and injects its stylesheet', () => {
    // cordis semantics: effect(fn) calls fn and keeps its return as the disposer.
    plugin.apply({
      effect: (fn) => {
        disposeClient = fn()
      },
    })
    const entry = dom.document.querySelector('[data-dsh-otools-git-entry]')
    assert.notEqual(entry, null)
    assert.match(entry.textContent, /Git/)
    assert.notEqual(dom.document.getElementById('dsh-plugin-otools-git-style'), null)
  })

  it('opens the panel and paints the toolbar, tabs and status bar', async () => {
    const entry = dom.document.querySelector('[data-dsh-otools-git-entry]')
    entry.dispatchEvent({ type: 'click' })
    await waitFor(() => panelText().includes('已暂存文件'), 'the status pane to load')

    assert.equal(dom.document.documentElement.hasAttribute('data-dsh-og-open'), true)
    const text = panelText()
    for (const label of ['工作区', '历史', '分支', '标签', '贮藏', '远端', '子模块', '工作树']) {
      assert.ok(text.includes(label), 'toolbar is missing ' + label)
    }
    assert.ok(text.includes('拉取') && text.includes('推送'), 'push/pull buttons missing')
    assert.ok(text.includes('当前分支:'), 'status bar missing')
  })

  it('lists the workspace repository in the sidebar', () => {
    const cards = dom.document.querySelectorAll('.dsh-og-repo')
    assert.equal(cards.length, 1)
    assert.ok(cards[0].textContent.includes('repo'))
    assert.ok(cards[0].textContent.includes('main'), 'branch should be shown')
  })

  it('shows the staged and untracked sections with their files', () => {
    const text = panelText()
    assert.ok(text.includes('已暂存文件'), 'staged section missing')
    assert.ok(text.includes('未跟踪文件'), 'untracked section missing')
    assert.ok(text.includes('a.txt'), 'staged file missing')
    assert.ok(text.includes('new.txt'), 'untracked file missing')
  })

  it('renders a file diff when a row is clicked', async () => {
    const rows = dom.document.querySelectorAll('.dsh-og-file')
    const staged = rows.find((row) => row.textContent.includes('a.txt'))
    assert.notEqual(staged, undefined)
    staged.dispatchEvent({ type: 'click' })
    await waitFor(() => dom.document.querySelectorAll('.dsh-og-diff-line').length > 0, 'the diff to render')
    const lines = dom.document.querySelectorAll('.dsh-og-diff-line')
    const added = lines.filter((line) => line.getAttribute('data-kind') === 'add')
    assert.ok(added.some((line) => line.textContent.includes('TWO')), 'added line missing')
  })

  /**
   * An untracked file is invisible to `git diff`, so its diff has to be
   * synthesized. If that fallback is missing, clicking a brand-new file shows
   * "no text difference" — which looks like the panel is broken.
   */
  it('renders a whole-file diff for an untracked file', async () => {
    const untracked = dom.document.querySelectorAll('.dsh-og-file')
      .find((row) => row.textContent.includes('new.txt'))
    assert.notEqual(untracked, undefined)
    untracked.dispatchEvent({ type: 'click' })
    await waitFor(() => {
      const lines = dom.document.querySelectorAll('.dsh-og-diff-line')
      return lines.some((line) => line.getAttribute('data-kind') === 'add' && line.textContent.includes('fresh'))
    }, 'the untracked file diff to render')
  })

  it('switches to the history tab and draws the graph', async () => {
    const buttons = dom.document.querySelectorAll('.dsh-og-tbtn')
    const history = buttons.find((row) => row.textContent.includes('历史'))
    history.dispatchEvent({ type: 'click' })
    await waitFor(() => panelText().includes('first commit'), 'the history table to load')
    assert.ok(panelText().includes('哈希'), 'hash column missing')
    assert.ok(dom.document.querySelectorAll('.dsh-og-graph-svg').length > 0, 'graph column missing')
  })

  it('opens the branch tab and lists the current branch', async () => {
    const buttons = dom.document.querySelectorAll('.dsh-og-tbtn')
    buttons.find((row) => row.textContent.includes('分支')).dispatchEvent({ type: 'click' })
    await waitFor(() => panelText().includes('新建分支'), 'the branch pane to load')
    assert.ok(panelText().includes('main'), 'branch row missing')
    assert.ok(panelText().includes('当前'), 'current marker missing')
  })

  it('opens a dialog and closes it on Escape', async () => {
    const buttons = dom.document.querySelectorAll('.dsh-og-btn')
    const create = buttons.find((row) => row.textContent.includes('新建分支'))
    assert.notEqual(create, undefined)
    create.dispatchEvent({ type: 'click' })
    await settle(2)
    let dialog = dom.document.querySelector('.dsh-og-dialog')
    assert.notEqual(dialog, null)
    assert.ok(dialog.textContent.includes('创建新分支'))

    dom.document.dispatchEvent({ type: 'keydown', key: 'Escape' })
    await settle(2)
    dialog = dom.document.querySelector('.dsh-og-dialog')
    assert.equal(dialog, null, 'Escape should close the dialog')
  })

  /**
   * Every remaining pane, clicked through once. These panes have no assertions
   * beyond "it painted something and threw nothing" — which is exactly the bug
   * class a shared-scope bundle produces: a helper that only one pane calls, and
   * that nothing else would ever have exercised.
   */
  it('paints the remaining tabs without throwing', async () => {
    const errors = []
    const originalError = console.error
    const originalWarn = console.warn
    console.error = (...args) => errors.push(args.join(' '))
    console.warn = (...args) => errors.push(args.join(' '))
    try {
      for (const [label, marker] of [
        ['标签', '新建标签'],
        ['贮藏', '贮藏当前改动'],
        ['远端', '添加远端'],
        ['子模块', '添加子模块'],
        ['工作树', '新增工作树'],
        ['工作区', '已暂存文件'],
      ]) {
        const button = dom.document.querySelectorAll('.dsh-og-tbtn')
          .find((row) => row.textContent.includes(label))
        assert.notEqual(button, undefined, 'no toolbar button for ' + label)
        button.dispatchEvent({ type: 'click' })
        await waitFor(() => panelText().includes(marker), label + ' pane to paint')
      }
    } finally {
      console.error = originalError
      console.warn = originalWarn
    }
    const real = errors.filter((line) => line.includes('render failed') || line.includes('listener threw'))
    assert.deepEqual(real, [], 'a pane render threw')
  })

  it('opens the settings dialog and switches through its tabs', async () => {
    const settings = dom.document.querySelectorAll('.dsh-og-tbtn').find((row) => row.textContent.includes('设置'))
    settings.dispatchEvent({ type: 'click' })
    await waitFor(() => {
      const dialog = dom.document.querySelector('.dsh-og-dialog')
      return dialog !== null && dialog.textContent.includes('全局 user.name')
    }, 'the settings dialog to load')

    const dialog = dom.document.querySelector('.dsh-og-dialog')
    for (const [label, marker] of [
      ['Git 配置', 'user.email'],
      ['账号凭证', '添加凭证'],
      ['AI 提交信息', '提交信息风格'],
      ['关于', 'Git 版本'],
    ]) {
      const tab = dialog.querySelectorAll('.dsh-og-tab').find((row) => row.textContent.includes(label))
      assert.notEqual(tab, undefined, 'no settings tab named ' + label)
      tab.dispatchEvent({ type: 'click' })
      await settle(2)
      assert.ok(dom.document.querySelector('.dsh-og-dialog').textContent.includes(marker),
        'settings tab ' + label + ' did not paint ' + marker)
    }
    dom.document.dispatchEvent({ type: 'keydown', key: 'Escape' })
    await settle(2)
  })

  it('closes the panel when another panel plugin activates', async () => {
    dom.document.dispatchEvent({ type: 'dsh-panel-activate', detail: 'dsh-plugin-taskboard' })
    await settle(2)
    assert.equal(dom.document.documentElement.hasAttribute('data-dsh-og-open'), false)
  })
})
