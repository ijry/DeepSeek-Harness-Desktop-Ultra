/**
 * 把打好的浏览器产物塞进自制 DOM 真跑一遍。这是唯一能验证「读起来像一场会话」
 * 的地方：座位挂载、工具行从运行中翻成完成、正文逐段出现、Esc 立刻收摊。
 *
 * 这里的 client 是单文件 IIFE，所以不需要像 canvas 那样查重名声明；要查的是
 * 它对宿主 DOM 的假设 —— 那些假设一旦错了，用户看到的是一个空白面板。
 *
 * @module dsh-plugin-longread/test/client
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { StubElement, createStubDom } from './dom-stub.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PREFIX = '/dsh-plugin-longread'

const PARAGRAPH_A = '雪从傍晚落起，到二更时分，已经把石板路埋平了。'
const PARAGRAPH_B = '门被叩了三下。不重，像是用手背蹭上去的。'

const SETTINGS = {
  // 600 = 立即显示：测试里不该为了等打字机而 flush 上千次。
  speed: 600, turnChars: 420, toolDensity: 'medium', persona: 'refactor',
  useRealPaths: true, showThinking: true, autoPlay: false, fontScale: 100,
}

const STATE = {
  revision: 3,
  settings: SETTINGS,
  progress: {},
  books: [
    {
      id: 'bk1',
      title: '九阴真经',
      author: '佚名',
      format: 'txt',
      chars: 15000,
      builtin: true,
      addedAt: 1,
      updatedAt: 2,
      chapters: [
        { index: 0, title: '第一章 雪夜抄经', chars: 1500 },
        { index: 1, title: '第二章 药铺的第九味', chars: 1600 },
      ],
    },
  ],
}

const PLAN = {
  bookId: 'bk1',
  bookTitle: '九阴真经',
  chapterIndex: 0,
  chapterTitle: '第一章 雪夜抄经',
  chapterCount: 2,
  chapterChars: 1500,
  persona: '重构',
  turnCount: 2,
  turns: [
    {
      index: 0,
      prompt: '继续上一轮：把 src/lib/retry.ts 里的重试逻辑抽成独立函数',
      thinking: { text: '先确认调用点，再改签名。', seconds: 3.4 },
      calls: [
        {
          id: 'call_a', name: 'read', ms: 180, status: 'ok', summary: 'src/lib/retry.ts',
          args: { file_path: 'src/lib/retry.ts' },
          result: '(End of file - total 412 lines)',
          resultLines: ['<path>src/lib/retry.ts</path>'],
        },
        {
          id: 'call_b', name: 'bash', ms: 900, status: 'ok', summary: 'npm test -- --reporter=dot',
          args: { command: 'npm test -- --reporter=dot' },
          result: '退出码 0',
          resultLines: ['  84 passing (2.1s)'],
        },
      ],
      paragraphs: [PARAGRAPH_A],
      chars: PARAGRAPH_A.length,
    },
    {
      index: 1,
      prompt: '继续',
      thinking: null,
      calls: [],
      paragraphs: [PARAGRAPH_B],
      chars: PARAGRAPH_B.length,
    },
  ],
}

/** Boot the built bundle against a stub DOM with the seats the client expects. */
async function boot(routes) {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  // structuredClone per boot: the client writes progress back into what it read,
  // and a shared fixture would leak one test's position into the next.
  const dom = createStubDom({
    [PREFIX + '/state']: structuredClone(STATE),
    [PREFIX + '/books/bk1/plan']: structuredClone(PLAN),
    [PREFIX + '/progress']: { chapterIndex: 0, turnIndex: 1, updatedAt: 9 },
    [PREFIX + '/settings']: structuredClone(SETTINGS),
    ...(routes ?? {}),
  })
  let registered
  dom.window.__ModuleLoader__ = { load: (entry) => { registered = entry } }
  const context = createContext({ ...dom.globals, globalThis: undefined })
  context.globalThis = context
  runInContext(source, context, { filename: 'lib/client.js' })
  assert.equal(registered?.id, 'dsh-plugin-longread')
  const exports = registered.factory(() => {
    throw new Error('the browser half must not require anything')
  })

  const sidebar = new StubElement('div')
  sidebar.className = 'pI_x6G_sidebarCol'
  const sidebarInner = new StubElement('div')
  sidebar.append(sidebarInner)
  const column = new StubElement('div')
  column.className = 'pI_x6G_centerCol'
  const existing = new StubElement('div')
  existing.className = 'realConversation'
  column.append(existing)
  dom.body.append(sidebar, column)

  let dispose
  exports.apply({ inject() {}, effect(factory) { dispose = factory() } })
  return { dom, exports, sidebar, column, dispose: () => { if (typeof dispose === 'function') dispose() } }
}

/** Drain queued frames/timeouts and let promises settle. */
async function pump(dom, rounds) {
  for (let i = 0; i < (rounds ?? 14); i++) {
    dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Open the panel and let the library load. */
async function open(env) {
  const entry = env.dom.html.querySelector('[data-dsh-lr-entry]')
  assert.ok(entry !== null, '侧栏入口没挂上')
  entry.dispatch('click')
  await pump(env.dom)
  return entry
}

test('挂载：侧栏多一个入口，会话列多一个面板容器，样式注入一次', async () => {
  const env = await boot()
  const entry = env.dom.html.querySelector('[data-dsh-lr-entry]')
  assert.ok(entry !== null)
  assert.ok(entry.textContent.includes('长文'))
  const view = env.dom.html.querySelector('[data-dsh-lr-view]')
  assert.ok(view !== null, '面板容器要挂在会话列里')
  assert.equal(view.parentElement, env.column)
  assert.ok(env.dom.document.getElementById('dsh-plugin-longread-style') !== null)
  // 关着的时候不该发任何请求：打开才拉书架。
  assert.deepEqual(env.dom.calls, [])
})

test('打开面板：拉一次书架，落到上次读的书，并画出会话形状的头部', async () => {
  const env = await boot()
  await open(env)
  assert.ok(env.dom.html.getAttribute('data-dsh-lr-open') !== null, '根元素要打开标记')
  const fetched = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.ok(fetched.includes(PREFIX + '/state'))
  assert.ok(fetched.some((path) => path.startsWith(PREFIX + '/books/bk1/plan')))
  const head = env.dom.html.querySelector('.dsh-lr-head-title')
  assert.ok(head.textContent.startsWith('重构'), '头部写的是伪装身份，不是书名：' + head.textContent)
  assert.equal(head.textContent.includes('九阴'), false, '书名绝不能出现在头部')
  const sub = env.dom.html.querySelector('.dsh-lr-head-sub')
  assert.ok(/1\/2/.test(sub.textContent), '右侧像上下文计量：' + sub.textContent)
  assert.ok(/tokens/.test(sub.textContent))
})

test('推进一轮：先出用户消息与工具行，工具行从运行中翻成完成，然后正文出现', async () => {
  const env = await boot()
  await open(env)
  const send = env.dom.html.querySelectorAll('.dsh-lr-btn').find((node) => node.textContent === '发送')
  assert.ok(send !== undefined)
  send.dispatch('click')
  // 一步一步 flush 到第一条工具行出现：那一刻它必须还是「运行中」。
  let running = []
  for (let i = 0; i < 6 && running.length === 0; i++) {
    env.dom.flush()
    await new Promise((resolve) => setImmediate(resolve))
    running = env.dom.html.querySelectorAll('[data-dsh-lr-call]')
  }
  assert.ok(running.length >= 1, '第一条工具行应该在正文之前出现')
  assert.equal(running[0].getAttribute('data-status'), 'run')
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-p').length, 0, '工具还没跑完就不该有正文')

  await pump(env.dom)
  const calls = env.dom.html.querySelectorAll('[data-dsh-lr-call]')
  assert.equal(calls.length, 2)
  for (const call of calls) assert.equal(call.getAttribute('data-status'), 'ok')
  assert.ok(calls[0].textContent.includes('read'))
  assert.ok(calls[0].textContent.includes('src/lib/retry.ts'))
  assert.ok(calls[0].textContent.includes('(End of file - total 412 lines)'))
  const user = env.dom.html.querySelector('.dsh-lr-user')
  assert.ok(user.textContent.includes('retry.ts'))
  assert.ok(env.dom.html.querySelector('.dsh-lr-think').textContent.includes('3.4s'))
  const paragraphs = env.dom.html.querySelectorAll('.dsh-lr-p')
  assert.equal(paragraphs.length, 1)
  assert.equal(paragraphs[0].textContent, PARAGRAPH_A, '正文必须一字不差')
})

test('自己敲的字就是那一轮的用户消息 —— 旁人看到的是你在提需求', async () => {
  const env = await boot()
  await open(env)
  const input = env.dom.html.querySelector('.dsh-lr-input')
  input.value = '继续，注意别动对外签名'
  input.dispatch('keydown', { key: 'Enter' })
  await pump(env.dom)
  const user = env.dom.html.querySelector('.dsh-lr-user')
  assert.equal(user.textContent, '继续，注意别动对外签名')
  assert.equal(input.value, '', '发出去之后输入框清空')
})

test('斜杠命令不进正文：/toc 开目录，/goto 跳章', async () => {
  const env = await boot()
  await open(env)
  const input = env.dom.html.querySelector('.dsh-lr-input')
  input.value = '/toc'
  input.dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 2)
  const modal = env.dom.html.querySelector('[data-dsh-lr-modal]')
  assert.ok(modal !== null, '/toc 应该开出目录')
  assert.ok(modal.textContent.includes('第二章 药铺的第九味'))
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-user').length, 0, '命令不该变成用户消息')

  input.value = '/goto 2'
  input.dispatch('keydown', { key: 'Enter' })
  await pump(env.dom)
  const asked = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.ok(asked.some((path) => path.includes('/plan?chapter=1')), '/goto 2 应该请求第 2 章')
})

test('一轮读完就记进度（防抖之后只写一次）', async () => {
  const env = await boot()
  await open(env)
  env.dom.html.querySelector('.dsh-lr-input').dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 20)
  const posts = env.dom.calls.filter((call) => call.path === PREFIX + '/progress')
  assert.equal(posts.length, 1, '进度写一次就够，不该每帧都写')
})

test('Esc 立刻收摊：面板关掉、正在打的字停住', async () => {
  const env = await boot()
  await open(env)
  env.dom.html.querySelector('.dsh-lr-input').dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 2)
  env.dom.html.dispatch('keydown', { key: 'Escape' })
  assert.equal(env.dom.html.getAttribute('data-dsh-lr-open'), null, '打开标记必须立刻消失')
  const before = env.dom.html.querySelectorAll('.dsh-lr-p').length
  await pump(env.dom, 10)
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-p').length, before, '收起之后不该继续往里写字')
})

test('续读：上次停在第 2 轮，打开时把已读的那轮瞬间补回来，不重新打字', async () => {
  const state = structuredClone(STATE)
  state.progress = { bk1: { chapterIndex: 0, turnIndex: 1, updatedAt: 99 } }
  const env = await boot({ [PREFIX + '/state']: state })
  await open(env)
  const users = env.dom.html.querySelectorAll('.dsh-lr-user')
  assert.equal(users.length, 1, '第 1 轮应该已经在屏幕上了')
  assert.ok(users[0].textContent.includes('retry.ts'))
  const paragraphs = env.dom.html.querySelectorAll('.dsh-lr-p')
  assert.equal(paragraphs.length, 1)
  assert.equal(paragraphs[0].textContent, PARAGRAPH_A)
  // 补回来的工具行是完成态：它们不该再演一遍「运行中」。
  for (const call of env.dom.html.querySelectorAll('[data-dsh-lr-call]')) {
    assert.equal(call.getAttribute('data-status'), 'ok')
  }
  env.dom.html.querySelector('.dsh-lr-input').dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 20)
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-p').length, 2, '接着读的是第 2 轮')
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-p')[1].textContent, PARAGRAPH_B)
})

const PARAGRAPH_C = '陈九把那半页纸缝进他的衣领，说这不是武功。'

test('自动播放：起一轮之后自己往下读，读到章末换章，分隔线伪装成上下文压缩', async () => {
  const state = structuredClone(STATE)
  state.settings = { ...SETTINGS, autoPlay: true }
  const second = structuredClone(PLAN)
  second.chapterIndex = 1
  second.chapterTitle = '第二章 药铺的第九味'
  second.turnCount = 1
  second.turns = [{ index: 0, prompt: '继续', thinking: null, calls: [], paragraphs: [PARAGRAPH_C], chars: PARAGRAPH_C.length }]
  const env = await boot({
    [PREFIX + '/state']: state,
    [PREFIX + '/books/bk1/plan?chapter=1']: second,
  })
  await open(env)
  // 打开面板本身是安静的（不会突然开始刷字）；起了第一轮之后才自己往下走。
  assert.equal(env.dom.html.querySelectorAll('.dsh-lr-p').length, 0)
  env.dom.html.querySelector('.dsh-lr-input').dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 60)
  const paragraphs = env.dom.html.querySelectorAll('.dsh-lr-p').map((node) => node.textContent)
  assert.ok(paragraphs.includes(PARAGRAPH_A), '第一轮')
  assert.ok(paragraphs.includes(PARAGRAPH_B), '第二轮应该不用再按一次')
  assert.ok(paragraphs.includes(PARAGRAPH_C), '换章之后接着读下一章')
  const dividers = env.dom.html.querySelectorAll('.dsh-lr-divider').map((node) => node.textContent)
  assert.ok(dividers.some((text) => text.includes('上下文已压缩')), '换章的分隔线要留在原地：' + dividers.join(' / '))
  assert.ok(dividers.some((text) => text.includes('任务完成')), '读完最后一章要收尾')
  const asked = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.ok(asked.some((path) => path.includes('/plan?chapter=1')))
})

test('书架列出书与进度，内置示例也在里面', async () => {
  const env = await boot()
  await open(env)
  const shelf = env.dom.html.querySelectorAll('.dsh-lr-btn').find((node) => node.textContent === '书架')
  shelf.dispatch('click')
  await pump(env.dom, 2)
  const modal = env.dom.html.querySelector('[data-dsh-lr-modal]')
  assert.ok(modal !== null)
  assert.ok(modal.textContent.includes('九阴真经'))
  assert.ok(modal.textContent.includes('TXT'))
  assert.ok(modal.textContent.includes('2 章'))
  assert.ok(modal.textContent.includes('导入文件'))
})

test('书架空着时给一句能照做的话，而不是空白面板', async () => {
  const state = structuredClone(STATE)
  state.books = []
  const env = await boot({ [PREFIX + '/state']: state })
  await open(env)
  const empty = env.dom.html.querySelector('.dsh-lr-empty')
  assert.ok(empty !== null)
  assert.ok(empty.textContent.includes('.txt'))
  const asked = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.equal(asked.some((path) => path.includes('/plan')), false, '没有书就不该去要计划')
})

test('设置弹层能开、改一项就写回 host，而且不碰正在读的那一章', async () => {
  const env = await boot()
  await open(env)
  const settingsBtn = env.dom.html.querySelectorAll('.dsh-lr-btn').find((node) => node.textContent === '设置')
  settingsBtn.dispatch('click')
  await pump(env.dom, 2)
  const modal = env.dom.html.querySelector('[data-dsh-lr-modal]')
  assert.ok(modal !== null)
  for (const label of ['速度', '每轮字数', '字号', '伪装', '工具调用', '思考块', '自动播放', '真实路径']) {
    assert.ok(modal.textContent.includes(label), '设置项缺了：' + label)
  }
  const number = modal.querySelectorAll('.dsh-lr-number')[0]
  number.value = '80'
  number.dispatch('change')
  await pump(env.dom, 4)
  const posts = env.dom.calls.filter((call) => call.path === PREFIX + '/settings')
  assert.equal(posts.length, 1, '改一项写一次')
  const dropdown = modal.querySelectorAll('.dsh-lr-select')[0]
  dropdown.value = 'debug'
  dropdown.dispatch('change')
  await pump(env.dom, 4)
  assert.equal(env.dom.calls.filter((call) => call.path === PREFIX + '/settings').length, 2)
})

test('书架里点一本就切过去，点导入不炸（没有文件选择器也是一种环境）', async () => {
  const env = await boot()
  await open(env)
  env.dom.html.querySelectorAll('.dsh-lr-btn').find((node) => node.textContent === '书架').dispatch('click')
  await pump(env.dom, 2)
  const modal = env.dom.html.querySelector('[data-dsh-lr-modal]')
  assert.doesNotThrow(() => {
    modal.querySelectorAll('.dsh-lr-btn').find((node) => node.textContent === '导入文件…').dispatch('click')
  })
  modal.querySelectorAll('.dsh-lr-row')[0].dispatch('click')
  await pump(env.dom)
  assert.equal(env.dom.html.querySelector('[data-dsh-lr-modal]'), null, '选完书要关掉弹层')
  const asked = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.ok(asked.some((path) => path.startsWith(PREFIX + '/books/bk1/plan')))
})

test('章节跳转与上一章：第一章时按上一章只提示，不去要不存在的第 0 章', async () => {
  const env = await boot()
  await open(env)
  env.dom.html.dispatch('keydown', { key: '[' })
  // 不能 pump：替身的 setTimeout 在 flush 时就跑，一 flush 提示就被自己撤掉了。
  const toast = env.dom.html.querySelector('.dsh-lr-toast')
  assert.ok(toast !== null && toast.textContent.includes('第一章'), '应该有一句提示：' + (toast?.textContent ?? 'null'))
  env.dom.html.dispatch('keydown', { key: ']' })
  await pump(env.dom, 6)
  const asked = env.dom.calls.filter((call) => call.kind === 'fetch').map((call) => call.path)
  assert.ok(asked.some((path) => path.includes('/plan?chapter=1')))
  assert.equal(asked.some((path) => path.includes('chapter=-1')), false)
})

test('dispose 收干净：入口、面板、样式全撤，之后不再有 DOM 变化', async () => {
  const env = await boot()
  await open(env)
  env.dom.html.querySelector('.dsh-lr-input').dispatch('keydown', { key: 'Enter' })
  await pump(env.dom, 2)
  env.dispose()
  assert.equal(env.dom.html.querySelector('[data-dsh-lr-entry]'), null)
  assert.equal(env.dom.html.querySelector('[data-dsh-lr-view]'), null)
  assert.equal(env.dom.document.getElementById('dsh-plugin-longread-style'), null)
  assert.equal(env.dom.html.getAttribute('data-dsh-lr-open'), null)
  const snapshot = env.dom.html.descendants().length
  await pump(env.dom, 10)
  assert.equal(env.dom.html.descendants().length, snapshot, 'dispose 之后不该再有异步写入')
})
