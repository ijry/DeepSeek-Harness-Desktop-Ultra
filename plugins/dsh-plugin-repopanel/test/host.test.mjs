/**
 * Host-layer tests: ledger durability and the task-board bridge's loopback
 * fence. Real files in a temp dir — the write path (temp file + rename, serial
 * queue, quarantine) is the part worth testing against an actual filesystem.
 *
 * @module dsh-plugin-repopanel/test/host
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PanelStore } from '../src/host/store.js'
import { indexBoard, taskboardBaseFrom, taskboardClient } from '../src/host/taskboard.js'
import { createLink, defaultPanelSettings } from '../src/shared/protocol.js'

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rp-'))
  return { dir, file: join(dir, 'ledger.json'), store: new PanelStore({ file: join(dir, 'ledger.json') }) }
}

const sampleLink = (overrides = {}) => createLink({
  sourceKey: 'github:github.com:o/r:issue:1',
  taskId: 'task_abc123',
  provider: 'github',
  host: 'GitHub.com',
  ownerRepo: 'O/R.git',
  kind: 'issue',
  number: 1,
  url: 'https://github.com/o/r/issues/1',
  title: '登录失败',
  scenario: 'fix',
  writeback: true,
  now: 1700000000000,
  ...overrides,
})

test('缺文件时从空账本起步，并且不创建文件', async () => {
  const { dir, store } = await freshStore()
  await store.load()
  assert.equal(store.revision, 0)
  assert.deepEqual(store.settings().global, defaultPanelSettings())
  assert.deepEqual(await readdir(dir), [], '只读不该落盘')
})

test('写设置：原子落盘、revision 自增、快照不可变', async () => {
  const { file, store } = await freshStore()
  const saved = await store.saveSettings(undefined, { ...defaultPanelSettings(), writebackDefault: true })
  assert.equal(saved.global.writebackDefault, true)
  assert.equal(store.revision, 1)

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.settings.global.writebackDefault, true)
  assert.equal(onDisk.revision, 1)

  assert.throws(() => { saved.global.writebackDefault = false }, TypeError, '交出去的快照必须冻住')
})

test('scope 覆盖写入后可删除，删除等于跟随全局', async () => {
  const { store } = await freshStore()
  await store.saveSettings('ws-1', { ...defaultPanelSettings(), defaultIssueScenario: 'plan_first' })
  assert.equal(store.ownSettings('ws-1').defaultIssueScenario, 'plan_first')
  assert.equal(store.effectiveSettings('ws-1').defaultIssueScenario, 'plan_first')

  await store.saveSettings('ws-1', undefined)
  assert.equal(store.ownSettings('ws-1'), undefined)
  assert.equal(store.effectiveSettings('ws-1').defaultIssueScenario, 'fix')
})

test('link 的增删与按键批量取用', async () => {
  const { store } = await freshStore()
  const link = await store.putLink(sampleLink())
  assert.equal(link.taskId, 'task_abc123')
  assert.equal(link.host, 'github.com', 'host 要归一化，否则 chip 认不出自己的任务')
  assert.equal(link.ownerRepo, 'o/r')

  const batch = store.linksFor(['github:github.com:o/r:issue:1', 'github:github.com:o/r:issue:2'])
  assert.deepEqual(Object.keys(batch), ['github:github.com:o/r:issue:1'], '不存在的键不要编一个空对象出来')

  assert.equal(await store.removeLink('github:github.com:o/r:issue:1'), true)
  assert.equal(await store.removeLink('github:github.com:o/r:issue:1'), false, '删第二次不算改动')
})

test('删一个不存在的 link 不写盘、不动 revision', async () => {
  const { file, store } = await freshStore()
  await store.load()
  assert.equal(await store.removeLink('nope'), false)
  assert.equal(store.revision, 0)
  await assert.rejects(() => readFile(file, 'utf8'), /ENOENT/, '空操作不该落盘')
})

test('坏账本被隔离而不是让面板起不来', async () => {
  const { dir, file, store } = await freshStore()
  await writeFile(file, '这不是 JSON', 'utf8')
  await store.load()
  assert.equal(store.revision, 0)
  assert.deepEqual(store.settings().global, defaultPanelSettings())
  const files = await readdir(dir)
  assert.ok(files.some((name) => name.includes('.corrupt-')), `应留下隔离副本：${files.join(', ')}`)
})

test('坏的 link 与坏的 settings 行被逐条丢掉，其余照常读出来', async () => {
  const { file } = await freshStore()
  await writeFile(file, JSON.stringify({
    revision: 7,
    settings: { global: { defaultIssueScenario: 'plan_first' }, folders: { 'ws-1': 'not an object' } },
    links: {
      good: sampleLink({ sourceKey: 'good' }),
      bad: { sourceKey: 'bad', taskId: 12, kind: 'issue', number: 1, createdAt: 1 },
    },
  }), 'utf8')
  const store = new PanelStore({ file })
  await store.load()
  assert.equal(store.revision, 7)
  assert.equal(store.settings().global.defaultIssueScenario, 'plan_first')
  assert.equal(store.ownSettings('ws-1'), undefined, '坏的覆盖行丢掉，退回全局')
  assert.notEqual(store.link('good'), undefined)
  assert.equal(store.link('bad'), undefined)
})

test('并发写串行化：每次提交都拿到唯一的 revision', async () => {
  const { file, store } = await freshStore()
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.putLink(sampleLink({ sourceKey: `k${i}`, number: i + 1 }))),
  )
  assert.equal(store.revision, 12)
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(Object.keys(onDisk.links).length, 12, '串行队列不能让任何一次写丢掉')
  assert.equal(onDisk.revision, 12)
})

test('订阅者拿到每一次提交，并且一个抛错的订阅者不影响其他人', async () => {
  const { store } = await freshStore()
  const seen = []
  store.subscribe(() => { throw new Error('boom') })
  const off = store.subscribe((change) => seen.push(change.kind))
  await store.saveSettings(undefined, defaultPanelSettings())
  await store.putLink(sampleLink())
  off()
  await store.removeLink(sampleLink().sourceKey)
  assert.deepEqual(seen, ['settings-changed', 'links-changed'])
})

test('taskboardBaseFrom 只认回环地址', async (t) => {
  // Host 头是客户端说的话。放过一个任意 host 就等于把这里变成请求伪造的跳板，
  // 而 dsh 本来只监听 127.0.0.1，所以严格些什么都不损失。
  for (const host of ['127.0.0.1:41234', 'localhost:8080', '[::1]:3000', '127.0.0.1']) {
    assert.equal(taskboardBaseFrom({ headers: { host } }), `http://${host}`, host)
  }
  for (const host of ['evil.example.com', '10.0.0.5:80', '127.0.0.1.evil.com', 'localhost.evil.com', '']) {
    assert.equal(taskboardBaseFrom({ headers: { host } }), undefined, host)
  }
  assert.equal(taskboardBaseFrom({}), undefined)
  assert.equal(taskboardBaseFrom(undefined), undefined)

  await t.test('环境变量可以覆盖，并且去掉尾斜杠', () => {
    const previous = process.env.DSH_PLUGIN_REPOPANEL_TASKBOARD_BASE
    process.env.DSH_PLUGIN_REPOPANEL_TASKBOARD_BASE = 'http://127.0.0.1:9/'
    try {
      assert.equal(taskboardBaseFrom({ headers: { host: 'evil.example.com' } }), 'http://127.0.0.1:9')
    } finally {
      if (previous === undefined) delete process.env.DSH_PLUGIN_REPOPANEL_TASKBOARD_BASE
      else process.env.DSH_PLUGIN_REPOPANEL_TASKBOARD_BASE = previous
    }
  })
})

test('taskboard 客户端：404 说的是「没装任务板」，不是内部错误', async () => {
  const client = taskboardClient({
    base: 'http://127.0.0.1:1',
    fetchImpl: async () => new Response('', { status: 404 }),
  })
  await assert.rejects(() => client.state(), (error) => {
    assert.equal(error.code, 'not_found')
    assert.match(error.message, /dsh-plugin-taskboard/)
    return true
  })
})

test('taskboard 客户端：只把用户填过的字段发过去', async () => {
  let sent
  const client = taskboardClient({
    base: 'http://127.0.0.1:1',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) }
      return Response.json({ ok: true, value: { id: 'task_1' } })
    },
  })
  const task = await client.createTask({ title: 't', prompt: 'p', workspaceId: 'ws' })
  assert.equal(task.id, 'task_1')
  assert.equal(sent.url, 'http://127.0.0.1:1/dsh-plugin-taskboard/tasks')
  assert.deepEqual(sent.body, { title: 't', prompt: 'p', workspaceId: 'ws' }, 'description 没填就不要发一个 undefined')
})

test('taskboard 客户端：把 { ok: false } 信封翻译成带原因的错误', async () => {
  const client = taskboardClient({
    base: 'http://127.0.0.1:1',
    fetchImpl: async () => Response.json(
      { ok: false, error: { code: 'invalid_input', message: 'title is required' } },
      { status: 400 },
    ),
  })
  await assert.rejects(() => client.createTask({ title: '' }), /title is required/)
})

test('indexBoard 只收下真正的任务记录', () => {
  const byId = indexBoard({ tasks: [{ id: 'a', status: 'todo' }, null, { status: 'todo' }, 'x'] })
  assert.equal(byId.size, 1)
  assert.equal(byId.get('a').status, 'todo')
  assert.equal(indexBoard(undefined).size, 0)
  assert.equal(indexBoard({ tasks: 'nope' }).size, 0)
})
