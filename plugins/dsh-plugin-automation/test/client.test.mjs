/**
 * Browser-half smoke tests: run the real bundle against a hand-written DOM stub
 * and drive it the way a user would — mount, open, render rows, expand history,
 * open the editor, toggle, delete.
 *
 * The point is not pixel fidelity, it is that the render path executes at all.
 * A typo in one of these builders throws a TypeError inside `apply`, the panel
 * silently never appears, and no amount of syntax checking notices.
 *
 * @module dsh-plugin-automation/test/client
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createStubDom, StubElement } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PREFIX = '/dsh-plugin-automation'

/** One automation as /state would carry it (host-decorated). */
const AUTOMATION = {
  id: 'auto_1',
  name: '每日测试回归',
  note: '每个工作日早上跑一遍测试',
  prompt: '跑测试',
  workspaceId: 'ws-1',
  schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
  action: { kind: 'headless', timeoutMinutes: 30 },
  enabled: true,
  usePreamble: true,
  catchUp: false,
  overlap: 'skip',
  version: 3,
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now() - 3600000,
  runCount: 4,
  failureCount: 1,
  consecutiveFailures: 0,
  lastRunAt: Date.now() - 7200000,
  lastStatus: 'succeeded',
  nextRunAt: Date.now() + 3600000,
  scheduleText: '每个工作日 09:00',
}

const RUN = {
  id: 'run_1',
  automationId: 'auto_1',
  automationName: '每日测试回归',
  status: 'succeeded',
  trigger: 'schedule',
  startedAt: Date.now() - 7200000,
  finishedAt: Date.now() - 7100000,
  durationMs: 100000,
  exitCode: 0,
  output: '3 passed',
  createdAt: Date.now() - 7200000,
}

/** The shell seats the panel looks for: a sidebar column and a conversation pane. */
function shell(dom) {
  const sidebar = new StubElement('div')
  sidebar.setAttribute('data-pane', 'sidebar')
  const sidebarInner = new StubElement('div')
  sidebar.append(sidebarInner)
  const conversation = new StubElement('div')
  conversation.setAttribute('data-pane', 'conversation')
  dom.body.append(sidebar, conversation)
  return { sidebar, sidebarInner, conversation }
}

/**
 * Boot the built bundle against the stub and hand back everything a test drives it
 * with. `posts` records every write so a test can assert the wire, not the DOM.
 */
async function boot(overrides = {}) {
  const posts = []
  const routes = {
    [PREFIX + '/state']: {
      revision: 1,
      settings: {
        enabled: true, maxConcurrentRuns: 2, defaultTimeoutMinutes: 30,
        keepRunsPerAutomation: 20, autoDisableAfterFailures: 5, preamble: '无人值守说明',
      },
      automations: [AUTOMATION],
      runs: [RUN],
      engine: { running: [], cliAvailable: true, tickCount: 3 },
      workspaces: [{ id: 'ws-1', path: 'D:/repo', title: '项目一' }],
      ...overrides.state,
    },
    [PREFIX + '/runs']: [RUN],
    [PREFIX + '/run']: RUN,
    [PREFIX + '/templates']: [
      { id: 'test-regression', name: '每日测试回归', group: '质量', note: '跑测试', prompt: '跑测试', schedule: { kind: 'cron', cron: '0 9 * * 1-5' }, action: 'headless' },
    ],
    [PREFIX + '/preview']: { valid: true, text: '每个工作日 09:00', next: [Date.now() + 3600000] },
    ...overrides.routes,
  }
  const dom = createStubDom(routes)
  const seats = shell(dom)
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const registered = []
  const sandbox = {
    ...dom.globals,
    window: { ...dom.window, __ModuleLoader__: { load: (entry) => registered.push(entry) } },
  }
  // The client reads `fetch` for GETs and POSTs; record the writes.
  sandbox.fetch = async (path, init) => {
    if (init !== undefined && init.method === 'POST') {
      posts.push({ path: String(path), body: JSON.parse(init.body) })
      return { status: 200, json: async () => ({ ok: true, value: {} }) }
    }
    return dom.globals.fetch(path)
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)
  const plugin = registered[0].factory(() => {
    throw new Error('no requires')
  })
  plugin.apply({})
  // Let the boot refresh and the coalesced first paint settle.
  await settle(dom)
  return { dom, seats, posts, plugin, routes }
}

/**
 * Drain microtasks (the client coalesces paints into a `Promise.resolve().then`)
 * and the stub's timer queue (toasts, the preview debounce).
 */
async function settle(dom, rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    dom.flush()
  }
}

/** The sidebar entry button. */
const entryOf = (dom) => dom.html.querySelector('[data-dsh-automation-entry]')
/** Every rendered automation card. */
const cardsOf = (dom) => dom.html.querySelectorAll('.dsh-au-card')
/** All buttons under a node, by their visible label. */
function buttonNamed(node, label) {
  return node.querySelectorAll('button').find((button) => button.textContent.includes(label))
}

test('挂载后侧栏出现入口，角标反映已启用条数', async () => {
  const { dom } = await boot()
  const entry = entryOf(dom)
  assert.ok(entry !== null, '侧栏没有挂上入口')
  assert.ok(entry.textContent.includes('自动化'))
  // Booted before ever opening: the badge is how a user notices a failing job.
  assert.ok(entry.querySelector('.dsh-au-entry-stats').textContent.includes('1'))
})

test('点入口打开面板，列表渲染出这条自动化的全部要点', async () => {
  const { dom } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  assert.equal(dom.html.getAttribute('data-dsh-au-open'), '')
  const cards = cardsOf(dom)
  assert.equal(cards.length, 1)
  const text = cards[0].textContent
  for (const fragment of ['每日测试回归', '每个工作日 09:00', '运行一次会话', '项目一', '下一次', '成功']) {
    assert.ok(text.includes(fragment), `卡片上少了「${fragment}」：${text}`)
  }
  // The header offers the master switch and the create button.
  const head = dom.html.querySelector('.dsh-au-head')
  assert.ok(head.textContent.includes('定时触发：开'))
  assert.ok(buttonNamed(head, '＋ 新建') !== undefined)
})

test('立即运行、暂停、总开关都发出对应的写请求', async () => {
  const { dom, posts } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  const card = cardsOf(dom)[0]

  buttonNamed(card, '立即运行').dispatch('click')
  await settle(dom)
  assert.deepEqual(posts.at(-1), { path: PREFIX + '/automations/run', body: { id: 'auto_1' } })

  buttonNamed(cardsOf(dom)[0], '暂停').dispatch('click')
  await settle(dom)
  // The version guard travels with every write the editor or the row performs.
  assert.deepEqual(posts.at(-1), {
    path: PREFIX + '/automations/enabled',
    body: { id: 'auto_1', enabled: false, ifVersion: 3 },
  })

  buttonNamed(dom.html.querySelector('.dsh-au-head'), '定时触发：开').dispatch('click')
  await settle(dom)
  assert.deepEqual(posts.at(-1), { path: PREFIX + '/settings', body: { enabled: false } })
})

test('删除要先过确认弹层', async () => {
  const { dom, posts } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  buttonNamed(cardsOf(dom)[0], '删除').dispatch('click')
  await settle(dom)
  const modal = dom.body.querySelector('.dsh-au-modal-backdrop')
  assert.ok(modal !== null, '没有弹出确认框')
  assert.ok(modal.textContent.includes('删除这条自动化？'))
  // Nothing is written until the confirming button is pressed.
  assert.equal(posts.length, 0)
  buttonNamed(modal.querySelector('.dsh-au-modal-foot'), '删除').dispatch('click')
  await settle(dom)
  assert.deepEqual(posts.at(-1), { path: PREFIX + '/automations/delete', body: { id: 'auto_1', ifVersion: 3 } })
  assert.equal(dom.body.querySelector('.dsh-au-modal-backdrop'), null, '确认后弹层没关掉')
})

test('展开历史后能点开一次运行，详情里有最终回答', async () => {
  const { dom } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  buttonNamed(cardsOf(dom)[0], '历史').dispatch('click')
  await settle(dom)
  const runs = cardsOf(dom)[0].querySelectorAll('.dsh-au-run')
  assert.equal(runs.length, 1)
  assert.ok(runs[0].textContent.includes('成功'))
  assert.ok(runs[0].textContent.includes('计划触发'))
  runs[0].dispatch('click')
  await settle(dom)
  const modal = dom.body.querySelector('.dsh-au-modal-backdrop')
  assert.ok(modal.textContent.includes('运行详情'))
  assert.ok(modal.textContent.includes('最终回答'))
  assert.ok(modal.textContent.includes('3 passed'))
  assert.ok(modal.textContent.includes('退出码 0'))
})

test('新建走模板库：选一条模板，编辑器带着它的内容，保存发出创建请求', async () => {
  const { dom, posts } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  buttonNamed(dom.html.querySelector('.dsh-au-head'), '＋ 新建').dispatch('click')
  await settle(dom)
  const gallery = dom.body.querySelector('.dsh-au-modal-backdrop')
  assert.ok(gallery.textContent.includes('从模板开始'))
  gallery.querySelector('.dsh-au-tpl').dispatch('click')
  await settle(dom)
  const editor = dom.body.querySelector('.dsh-au-modal-backdrop')
  assert.ok(editor.textContent.includes('新建自动化'))
  // The template filled the form, and the host answered the schedule preview.
  assert.equal(editor.querySelectorAll('input').find((input) => input.value === '每日测试回归') !== undefined, true)
  assert.ok(editor.textContent.includes('每个工作日 09:00'))
  buttonNamed(editor.querySelector('.dsh-au-modal-foot'), '创建').dispatch('click')
  await settle(dom)
  const created = posts.at(-1)
  assert.equal(created.path, PREFIX + '/automations')
  assert.equal(created.body.draft.name, '每日测试回归')
  assert.equal(created.body.draft.schedule.cron, '0 9 * * 1-5')
  assert.equal(created.body.draft.action.kind, 'headless')
  assert.equal(created.body.draft.usePreamble, true)
  assert.equal(created.body.draft.workspaceId, 'ws-1')
})

test('切到「仅手动」与「投递到看板」时表单跟着变，缺项目会被当场拦下', async () => {
  const { dom, posts } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  buttonNamed(cardsOf(dom)[0], '编辑').dispatch('click')
  await settle(dom)
  const editor = dom.body.querySelector('.dsh-au-modal-backdrop')
  const pill = (label) => editor.querySelectorAll('.dsh-au-pill').find((node) => node.textContent === label)

  pill('仅手动触发').dispatch('click')
  await settle(dom)
  assert.ok(editor.textContent.includes('不会自己触发'))

  pill('固定间隔').dispatch('click')
  await settle(dom)
  assert.ok(editor.querySelectorAll('select').some((node) => node.querySelectorAll('option').length > 5))

  pill('投递到任务看板').dispatch('click')
  await settle(dom)
  assert.ok(editor.textContent.includes('需要装 dsh-plugin-taskboard'))
  // Timeout only belongs to a run that can time out.
  assert.equal(editor.textContent.includes('超时（分钟）'), false)

  // Empty the project and the save is refused locally, before any request.
  const before = posts.length
  editor.querySelectorAll('select').find((node) => node.querySelectorAll('option').length === 2).value = ''
  editor.querySelectorAll('select').find((node) => node.querySelectorAll('option').length === 2).dispatch('change')
  buttonNamed(editor.querySelector('.dsh-au-modal-foot'), '保存').dispatch('click')
  await settle(dom)
  assert.equal(posts.length, before)
  assert.ok(editor.querySelector('.dsh-au-modal-foot').textContent.includes('投递到任务看板必须选一个项目'))
})

test('引擎不可用与总开关暂停都在列表顶部说清楚', async () => {
  const { dom } = await boot({
    state: {
      engine: { running: [], cliAvailable: false },
      settings: { enabled: false, maxConcurrentRuns: 2, defaultTimeoutMinutes: 30, keepRunsPerAutomation: 20, autoDisableAfterFailures: 5, preamble: '' },
    },
  })
  entryOf(dom).dispatch('click')
  await settle(dom)
  const warnings = dom.html.querySelectorAll('.dsh-au-warn').map((node) => node.textContent).join('\n')
  assert.match(warnings, /找不到 dsh 启动器/)
  assert.match(warnings, /总开关暂停/)
  assert.ok(dom.html.querySelector('.dsh-au-head').textContent.includes('定时触发：已暂停'))
})

test('一条都没有时给出空状态与两个入口', async () => {
  const { dom } = await boot({ state: { automations: [], runs: [] } })
  entryOf(dom).dispatch('click')
  await settle(dom)
  const empty = dom.html.querySelector('.dsh-au-empty')
  assert.ok(empty !== null)
  assert.ok(empty.textContent.includes('还没有自动化'))
  assert.ok(buttonNamed(empty, '从模板开始') !== undefined)
  assert.ok(buttonNamed(empty, '手动新建') !== undefined)
})

test('正在运行时行上换成「终止本次」，并且发出取消请求', async () => {
  const { dom, posts } = await boot({
    state: {
      engine: { running: [{ automationId: 'auto_1', runId: 'run_live', startedAt: Date.now() - 60000, pid: 42 }], cliAvailable: true },
    },
  })
  entryOf(dom).dispatch('click')
  await settle(dom)
  const card = cardsOf(dom)[0]
  assert.equal(buttonNamed(card, '立即运行'), undefined, '在跑的时候不该还提供「立即运行」')
  assert.equal(card.querySelector('.dsh-au-dot').getAttribute('data-live'), 'true')
  buttonNamed(card, '终止本次').dispatch('click')
  await settle(dom)
  assert.deepEqual(posts.at(-1), { path: PREFIX + '/runs/cancel', body: { runId: 'run_live' } })
})

test('SSE 推来新 revision 时会重新拉取状态', async () => {
  const { dom } = await boot()
  entryOf(dom).dispatch('click')
  await settle(dom)
  const before = dom.calls.filter((call) => call.kind === 'fetch' && call.path.startsWith(PREFIX + '/state')).length
  dom.window.__lastEventSource.emit('change', { revision: 2, kind: 'runs-changed' })
  await settle(dom)
  const after = dom.calls.filter((call) => call.kind === 'fetch' && call.path.startsWith(PREFIX + '/state')).length
  assert.ok(after > before, 'change 帧没有触发重新拉取')
})

test('筛选与项目下拉都真的过滤行', async () => {
  const other = { ...AUTOMATION, id: 'auto_2', name: '另一条', enabled: false, workspaceId: 'ws-2', consecutiveFailures: 2 }
  const { dom } = await boot({
    state: {
      automations: [AUTOMATION, other],
      workspaces: [{ id: 'ws-1', path: 'D:/a', title: '项目一' }, { id: 'ws-2', path: 'D:/b', title: '项目二' }],
    },
  })
  entryOf(dom).dispatch('click')
  await settle(dom)
  assert.equal(cardsOf(dom).length, 2)
  const pill = (label) => dom.html.querySelector('.dsh-au-row2').querySelectorAll('.dsh-au-pill')
    .find((node) => node.textContent === label)
  pill('已暂停').dispatch('click')
  await settle(dom)
  assert.deepEqual(cardsOf(dom).map((card) => card.querySelector('.dsh-au-card-name').textContent), ['另一条'])
  pill('最近失败').dispatch('click')
  await settle(dom)
  assert.equal(cardsOf(dom).length, 1)
  pill('全部').dispatch('click')
  await settle(dom)
  assert.equal(cardsOf(dom).length, 2)
})
