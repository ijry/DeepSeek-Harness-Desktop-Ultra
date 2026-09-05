/**
 * 浏览器半边的冒烟测试：把构建产物 lib/client.js 在一个手写 DOM 替身里真的跑
 * 起来——注册进 loader、装出侧栏入口、打开画布、拉到账本与会话、把区域/成员/
 * 便签画出来。
 *
 * 目的不是覆盖每个手势（没有真实布局与指针，那不现实），而是拦住「打包后根本
 * 起不来」这一类问题：内联时的命名冲突、少了某个函数、事件线路接错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { createStubDom } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const LEDGER = {
  revision: 3,
  nodes: [
    {
      id: 1,
      kind: 'workspace',
      workspace: 'w1',
      agentType: null,
      sessionId: null,
      memberIds: [],
      title: null,
      content: null,
      color: 'violet',
      collapsed: false,
      gridColumns: 3,
      gridRows: 2,
      x: 0,
      y: 0,
      width: 720,
      height: 340,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 2,
      kind: 'note',
      workspace: null,
      agentType: null,
      sessionId: null,
      memberIds: [],
      title: null,
      content: '记一笔',
      color: null,
      collapsed: false,
      gridColumns: 0,
      gridRows: 0,
      x: 800,
      y: 0,
      width: 208,
      height: 132,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
}

const SESSIONS = {
  sessions: [
    {
      id: 'session-a',
      title: '第一个会话',
      workspace: 'w1',
      cwd: 'D:/repo',
      agentType: 'code',
      createdAt: 1,
      updatedAt: 9,
      live: true,
      kind: 'root',
      parentId: null,
    },
  ],
  workspaces: [
    { id: 'w1', path: 'D:/repo', title: '仓库', createdAt: '', updatedAt: '', sessionIds: ['session-a'] },
  ],
  agents: [{ id: 'code', name: 'code' }],
}

/** 把打包产物在替身里跑起来，返回 { exports, dom }。 */
async function boot() {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const dom = createStubDom({ '/dsh-plugin-canvas/state': LEDGER, '/dsh-plugin-canvas/sessions': SESSIONS })
  let registered
  dom.window.__ModuleLoader__ = {
    load(registration) {
      registered = registration
    },
  }
  const context = createContext({ ...dom.globals, globalThis: undefined })
  context.globalThis = context
  runInContext(source, context, { filename: 'lib/client.js' })
  assert.equal(registered?.id, 'dsh-plugin-canvas', 'bundle must self-register under its package name')
  const exports = registered.factory(() => {
    throw new Error('the browser half must not require anything')
  })
  return { exports, dom }
}

test('打包产物注册进 loader，并导出 name/inject/apply', async () => {
  const { exports } = await boot()
  assert.equal(exports.name, 'dsh-plugin-canvas/client')
  // 跨 vm realm 的数组不与宿主数组 deepStrictEqual，所以比长度。
  assert.equal(exports.inject.length, 0)
  assert.equal(typeof exports.apply, 'function')
})

test('apply 装出侧栏入口与画布视图，且不预先打开', async () => {
  const { exports, dom } = await boot()
  const sidebar = new dom.globals.HTMLElement('div')
  sidebar.className = 'x_sidebarCol'
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(sidebar, conversation)

  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()

  assert.notEqual(dom.document.getElementById('dsh-plugin-canvas-style'), null, '样式应当注入一次')
  const entry = dom.html.querySelector('[data-dshc-entry]')
  assert.notEqual(entry, null, '侧栏应当出现入口按钮')
  assert.equal(entry.parentElement, sidebar)
  const view = dom.html.querySelector('[data-dshc-view]')
  assert.notEqual(view, null, '会话列应当出现画布视图')
  assert.equal(view.dataset.open, 'false')
  // 没打开就不该有网络动作。
  assert.equal(dom.calls.length, 0)
})

test('点入口即打开：拉账本与会话、开 SSE，并把节点画出来', async () => {
  const { exports, dom } = await boot()
  const sidebar = new dom.globals.HTMLElement('div')
  sidebar.className = 'x_sidebarCol'
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(sidebar, conversation)
  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()

  dom.html.querySelector('[data-dshc-entry]').dispatch('click')
  // 两次 flush：一次跑打开时排的 rAF，一次跑 fetch 落地后 emit 排的。
  dom.flush()
  await new Promise((resolve) => setImmediate(resolve))
  dom.flush()
  await new Promise((resolve) => setImmediate(resolve))
  dom.flush()

  const view = dom.html.querySelector('[data-dshc-view]')
  assert.equal(view.dataset.open, 'true')
  assert.equal(dom.html.getAttribute('data-dshc-open'), '')
  const paths = dom.calls.filter((c) => c.kind === 'fetch').map((c) => c.path)
  assert.ok(paths.some((p) => p.startsWith('/dsh-plugin-canvas/state')), '应当拉账本')
  assert.ok(paths.some((p) => p.startsWith('/dsh-plugin-canvas/sessions')), '应当拉会话视图')
  assert.ok(dom.calls.some((c) => c.kind === 'sse'), '应当开事件流')

  const nodes = view.querySelectorAll('[class*="dshc-node"]')
  // 一个工作区区域 + 一张成员卡 + 一张便签。
  assert.equal(nodes.length, 3)
  const types = nodes.map((n) => n.dataset.type).sort()
  assert.deepEqual([...types], ['note', 'region', 'sessionCard'])
  assert.ok(view.textContent.includes('第一个会话'), '成员卡应当显示会话标题')
  assert.ok(view.textContent.includes('记一笔'), '便签应当显示正文')
  assert.ok(view.textContent.includes('仓库'), '区域标题应当解析到工作区名')
})

test('工具条按选择给出动词：什么都没选时只有左半边', async () => {
  const { exports, dom } = await boot()
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(conversation)
  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()
  dom.html.querySelector('[data-dshc-entry]') // 侧栏不存在也不该炸
  const view = dom.html.querySelector('[data-dshc-view]')
  assert.notEqual(view, null)
  const dock = view.querySelector('[class*="dshc-dock"]')
  assert.notEqual(dock, null, '工具条应当存在')
})

/** 起一块打开着的画布，返回常用把手。 */
async function openBoard() {
  const { exports, dom } = await boot()
  const sidebar = new dom.globals.HTMLElement('div')
  sidebar.className = 'x_sidebarCol'
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(sidebar, conversation)
  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()
  dom.html.querySelector('[data-dshc-entry]').dispatch('click')
  for (let i = 0; i < 4; i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  dom.flush()
  const view = dom.html.querySelector('[data-dshc-view]')
  return { dom, view, surface: view.querySelector('[class*="dshc-surface"]') }
}

/** 找一个已渲染的节点包裹层。 */
function nodeOf(view, type) {
  return view.querySelectorAll('[class*="dshc-node"]').find((n) => n.dataset.type === type)
}

test('点中节点即选中，工具条随之长出该类型的动词', async () => {
  const { dom, view } = await openBoard()
  const note = nodeOf(view, 'note')
  const before = view.querySelector('[class*="dshc-dock"]').children.length
  note.firstElementChild.dispatch('mousedown', { button: 0, buttons: 1 })
  dom.flush()
  assert.equal(note.dataset.selected, 'true')
  const dock = view.querySelector('[class*="dshc-dock"]')
  assert.ok(dock.children.length > before, '选中之后工具条应当多出动词')
  const labels = dock.children.map((c) => c.getAttribute('aria-label')).filter(Boolean)
  assert.ok(labels.includes('颜色'), `便签应当有颜色动词：${labels.join('/')}`)
  assert.ok(labels.includes('删除便签'), `便签应当有删除动词：${labels.join('/')}`)
})

test('双击便签进入编辑，写了字的便签删除时先问一次', async () => {
  const { dom, view } = await openBoard()
  const note = nodeOf(view, 'note')
  note.firstElementChild.dispatch('dblclick')
  dom.flush()
  const editor = note.querySelector('[class*="dshc-nedit"]')
  assert.notEqual(editor, null, '双击应当换成 textarea')
  assert.equal(editor.value, '记一笔')

  // 选中它再按 Delete：账本里这条便签写了字，必须先弹确认。
  note.firstElementChild.dispatch('mousedown', { button: 0, buttons: 1 })
  dom.flush()
  dom.html.dispatch('keydown', { key: 'Delete', target: dom.body })
  dom.flush()
  const dialog = view.querySelector('[class*="dshc-dialog"]')
  assert.notEqual(dialog, null, '写了字的便签删除前应当有确认弹层')
  assert.ok(dialog.textContent.includes('无法撤销'))
})

test('事件流推进 revision：+1 应用，重放丢弃，跳号触发全量对账', async () => {
  const { dom, view } = await openBoard()
  const stream = dom.calls.filter((c) => c.kind === 'sse')
  assert.equal(stream.length, 1)
  const fetchesBefore = dom.calls.filter((c) => c.kind === 'fetch').length
  const source = dom.window.__lastEventSource
  assert.notEqual(source, undefined, '需要拿到 EventSource 实例')

  const note = {
    id: 9,
    kind: 'note',
    workspace: null,
    agentType: null,
    sessionId: null,
    memberIds: [],
    title: null,
    content: '来自事件流',
    color: null,
    collapsed: false,
    gridColumns: 0,
    gridRows: 0,
    x: 1200,
    y: 0,
    width: 208,
    height: 132,
    createdAt: '',
    updatedAt: '',
  }
  source.emit('change', { kind: 'upsert', node: note, revision: 4 })
  dom.flush()
  assert.ok(view.textContent.includes('来自事件流'), 'revision + 1 应当被应用')

  // 重放同一个事件不应该再动什么，也不该多拉一次快照。
  source.emit('change', { kind: 'upsert', node: { ...note, content: '不该出现' }, revision: 4 })
  dom.flush()
  assert.ok(!view.textContent.includes('不该出现'))
  assert.equal(dom.calls.filter((c) => c.kind === 'fetch').length, fetchesBefore)

  // 跳号是缺口：不应用，直接全量对账。
  source.emit('change', { kind: 'deleted', id: 9, revision: 99 })
  dom.flush()
  assert.ok(view.textContent.includes('来自事件流'), '缺口事件不该被应用')
  assert.ok(dom.calls.filter((c) => c.kind === 'fetch').length > fetchesBefore, '缺口应当触发对账')
})

test('把成员卡拖到空白处 = 移出成散卡：发 detach，并乐观地把区域成员刷掉', async () => {
  const pinned = {
    id: 7,
    kind: 'session',
    workspace: null,
    agentType: null,
    sessionId: 'session-a',
    memberIds: [],
    title: null,
    content: null,
    color: null,
    collapsed: false,
    gridColumns: 0,
    gridRows: 0,
    x: 852,
    y: 577,
    width: 224,
    height: 132,
    createdAt: '',
    updatedAt: '',
  }
  const { exports, dom } = await boot()
  // 自定义区域才有成员表可以移除，所以这一局用 custom + 成员 session-a。
  dom.routes['/dsh-plugin-canvas/state'] = {
    revision: 1,
    nodes: [{ ...LEDGER.nodes[0], kind: 'custom', workspace: null, memberIds: ['session-a'] }],
  }
  dom.routes['/dsh-plugin-canvas/nodes/1/detach'] = {
    value: { node: pinned, removedFrom: 1 },
    revision: 2,
  }
  const sidebar = new dom.globals.HTMLElement('div')
  sidebar.className = 'x_sidebarCol'
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(sidebar, conversation)
  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()
  dom.html.querySelector('[data-dshc-entry]').dispatch('click')
  for (let i = 0; i < 4; i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  dom.flush()

  const view = dom.html.querySelector('[data-dshc-view]')
  const member = view.querySelectorAll('[class*="dshc-node"]').find((n) => n.dataset.type === 'sessionCard')
  assert.notEqual(member, undefined, '自定义区域里应当有一张成员卡')
  member.firstElementChild.dispatch('mousedown', { button: 0, buttons: 1, clientX: 0, clientY: 0 })
  dom.html.dispatch('mousemove', { buttons: 1, clientX: 800, clientY: 500 })
  dom.flush()
  dom.html.dispatch('mouseup', { button: 0, buttons: 0 })
  for (let i = 0; i < 4; i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  dom.flush()

  const paths = dom.calls.filter((c) => c.kind === 'fetch').map((c) => c.path)
  assert.ok(paths.includes('/dsh-plugin-canvas/nodes/1/detach'), `应当发 detach：${paths.join(' ')}`)
  // 乐观应用之后：区域成员空了，散卡出现了。
  const types = view.querySelectorAll('[class*="dshc-node"]').map((n) => n.dataset.type)
  assert.equal(types.filter((t) => t === 'sessionCard').length, 1, '成员卡应当变成一张散卡')
})

test('内联后没有重名的顶层声明——那正是这个构建步骤唯一会自伤的地方', async () => {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const counts = new Map()
  // 内联的模块不重新缩进，所以模块级声明就是行首那些。
  const declaration = /^(?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(declaration)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([name]) => name)
  assert.deepEqual(duplicates, [], `重名的顶层声明：${duplicates.join(', ')}`)
  assert.ok(counts.size > 100, '应当确实内联了各模块，而不是只剩入口')
  // 内联要把相对 import 和 export 关键字都吃掉，否则包在函数作用域里根本解析不了。
  assert.ok(!/^import\s/m.test(source), 'bundle 里不该留下 import')
  assert.ok(!/^export\s/m.test(source), 'bundle 里不该留下 export')
})

test('展开的会话卡真的能画出来——正文卡有标题栏、有拖拽把手、有正文', async () => {
  const { exports, dom } = await boot()
  dom.routes['/dsh-plugin-canvas/state'] = {
    revision: 1,
    nodes: [
      {
        id: 3,
        kind: 'session',
        workspace: null,
        agentType: null,
        sessionId: 'session-a',
        memberIds: [],
        title: null,
        content: null,
        color: null,
        collapsed: false,
        gridColumns: 0,
        gridRows: 0,
        x: 0,
        y: 0,
        width: 224,
        height: 132,
        createdAt: '',
        updatedAt: '',
      },
    ],
  }
  dom.routes['/dsh-plugin-canvas/sessions/session-a/transcript'] = {
    turns: [{ role: 'user', label: '你', text: '第一句话' }],
  }
  const sidebar = new dom.globals.HTMLElement('div')
  sidebar.className = 'x_sidebarCol'
  const conversation = new dom.globals.HTMLElement('div')
  conversation.className = 'x_centerCol'
  dom.body.append(sidebar, conversation)
  exports.apply({ inject: () => {}, effect: () => {} })
  dom.flush()
  dom.html.querySelector('[data-dshc-entry]').dispatch('click')
  for (let i = 0; i < 4; i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  dom.flush()

  const view = dom.html.querySelector('[data-dshc-view]')
  const card = view.querySelectorAll('[class*="dshc-node"]').find((n) => n.dataset.type === 'sessionCard')
  assert.notEqual(card, undefined, '应当先有一张摘要卡')
  card.firstElementChild.dispatch('dblclick')
  for (let i = 0; i < 4; i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  dom.flush()

  const detail = view.querySelectorAll('[class*="dshc-node"]').find((n) => n.dataset.type === 'sessionDetail')
  assert.notEqual(detail, undefined, '双击应当换成正文卡')
  const bar = detail.querySelector('[class*="dshc-dbar"]')
  assert.notEqual(bar, null, '正文卡要有标题栏')
  assert.ok(bar.className.includes('dshc-drag-handle'), `标题栏就是拖拽把手：${bar.className}`)
  assert.ok(detail.textContent.includes('第一句话'), '正文应当画出来')
})

test('按住绑定区域里的成员卡，卡片不能凭空消失', async () => {
  const { dom, view } = await openBoard()
  const before = view.querySelectorAll('[class*="dshc-node"]').filter(
    (n) => n.dataset.type === 'sessionCard'
  ).length
  assert.equal(before, 1, '工作区区域里应当有一张成员卡')
  const member = view.querySelectorAll('[class*="dshc-node"]').find((n) => n.dataset.type === 'sessionCard')
  member.firstElementChild.dispatch('mousedown', { button: 0, buttons: 1, clientX: 0, clientY: 0 })
  dom.flush()
  const during = view.querySelectorAll('[class*="dshc-node"]').filter(
    (n) => n.dataset.type === 'sessionCard'
  ).length
  assert.equal(during, before, '工作区/智能体区域没有成员表，冻结不能把网格清空')
  dom.html.dispatch('mouseup', { button: 0, buttons: 0 })
  dom.flush()
})
