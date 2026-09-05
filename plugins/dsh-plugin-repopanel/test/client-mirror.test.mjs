/**
 * The browser bundle cannot import `shared/protocol.js` — it is a standalone
 * loader script with no module resolution — so it keeps a hand-written COPY of
 * the wire vocabulary. That copy drifting is the nastiest failure this plugin
 * has: nothing throws, no request fails, a row's chip just silently never
 * matches its task again.
 *
 * This test lifts the client's mirror section out of the source, evaluates it,
 * and holds it against the host's real implementation — including a fuzz over
 * `buildSourceKey`, which is the actual join key.
 *
 * @module dsh-plugin-repopanel/test/client-mirror
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as protocol from '../src/shared/protocol.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const START = '  // ------------------------------------------------------------- vocabulary'
const END = '  // ---------------------------------------------------------------- helpers'

/**
 * Evaluate the client's mirror section on its own and hand back its symbols.
 * Slicing on the section banners is deliberate: if someone renames or moves a
 * banner this test fails loudly, which is the correct outcome — the mirror needs
 * a reviewer's eye either way.
 */
async function mirror() {
  const source = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')
  const from = source.indexOf(START)
  const to = source.indexOf(END)
  assert.ok(from > -1 && to > from, '找不到 client 里的 vocabulary 段落 —— 段落标记被改过了')
  const section = source.slice(from, to)
  const expose = [
    'TABS', 'GLOBAL_SCOPE', 'SCENARIO_PROMPT_ALL', 'PAGE_SIZES', 'DEFAULT_PAGE_SIZE',
    'PROMPT_CAP', 'MAX_ISSUE_TITLE_CHARS', 'MAX_LABELS', 'TERMINAL_TASK_STATUSES',
    'STATE_FILTERS', 'SORTS', 'SCENARIOS', 'PROMPT_TABS', 'TASK_STATUS_LABELS',
    'scenariosForKind', 'chipStateForLink', 'normalizeRepo', 'buildSourceKey',
    'pageCount', 'pageSlots',
  ]
  // eslint-disable-next-line no-new-func -- the input is this repo's own source
  return new Function(`${section}\nreturn { ${expose.join(', ')} }`)()
}

test('常量镜像与 shared/protocol.js 一致', async () => {
  const client = await mirror()
  assert.deepEqual(client.TABS, protocol.TABS)
  assert.deepEqual(client.PAGE_SIZES, protocol.PAGE_SIZES)
  assert.deepEqual(client.TERMINAL_TASK_STATUSES, protocol.TERMINAL_TASK_STATUSES)
  assert.equal(client.GLOBAL_SCOPE, protocol.GLOBAL_SCOPE)
  assert.equal(client.SCENARIO_PROMPT_ALL, protocol.SCENARIO_PROMPT_ALL)
  assert.equal(client.DEFAULT_PAGE_SIZE, protocol.DEFAULT_PAGE_SIZE)
  assert.equal(client.PROMPT_CAP, protocol.PROMPT_CAP)
  assert.equal(client.MAX_ISSUE_TITLE_CHARS, protocol.MAX_ISSUE_TITLE_CHARS)
  assert.equal(client.MAX_LABELS, protocol.MAX_LABELS)
})

test('下拉选项与场景表覆盖协议里的全部取值，一个不多一个不少', async () => {
  const client = await mirror()
  assert.deepEqual(client.STATE_FILTERS.map((row) => row.id), protocol.STATE_FILTERS)
  assert.deepEqual(client.SORTS.map((row) => row.id), protocol.SORTS)
  assert.deepEqual(Object.keys(client.SCENARIOS).sort(), [...protocol.SCENARIO_IDS].sort())
  assert.deepEqual(
    client.PROMPT_TABS.map((row) => row.id),
    [protocol.SCENARIO_PROMPT_ALL, ...protocol.SCENARIO_IDS],
    '常驻指令的分页要与 all + 全部场景一一对应',
  )
  // 场景选项缺一个提示文案，用户就只看到一个没有解释的单选项
  for (const [id, row] of Object.entries(client.SCENARIOS)) {
    assert.ok(row.label.length > 0, id)
    assert.ok(row.hint.length > 0, id)
  }
})

test('scenariosForKind / chipStateForLink 与宿主同解', async () => {
  const client = await mirror()
  for (const kind of ['issue', 'pr']) {
    assert.deepEqual(client.scenariosForKind(kind), protocol.scenariosForKind(kind), kind)
  }
  const statuses = [
    'todo', 'queued', 'preparing', 'running', 'awaiting_input',
    'review', 'merging', 'failed', 'done', 'canceled',
  ]
  for (const status of statuses) {
    assert.equal(client.chipStateForLink({ status }), protocol.chipStateForLink({ status }), status)
  }
  assert.equal(client.chipStateForLink(undefined), protocol.chipStateForLink(undefined))
  assert.equal(client.chipStateForLink(null), protocol.chipStateForLink(null))
  assert.equal(client.chipStateForLink({}), protocol.chipStateForLink({}))
})

test('每个任务状态都有中文文案 —— 缺一个，chip 上就出现一个英文原状态', async () => {
  const client = await mirror()
  const covered = Object.keys(client.TASK_STATUS_LABELS).sort()
  assert.deepEqual(covered, [
    'awaiting_input', 'canceled', 'done', 'failed', 'merging',
    'preparing', 'queued', 'review', 'running', 'todo',
  ])
})

test('buildSourceKey 在两侧逐字节相同（模糊测试）', async () => {
  const client = await mirror()
  const hosts = ['github.com', 'GitHub.COM', ' github.com ', 'ghe.example.com']
  const repos = ['o/r', 'O/R', 'o/r.git', '/o/r/', 'group/sub/proj.git', 'O/R.GIT']
  for (const provider of protocol.PROVIDER_IDS) {
    for (const host of hosts) {
      for (const ownerRepo of repos) {
        for (const kind of ['issue', 'pr']) {
          for (const number of [1, 42, 99999]) {
            const fromClient = client.buildSourceKey(provider, host, ownerRepo, kind, number)
            const fromHost = protocol.buildSourceKey({ provider, host, ownerRepo, kind, number })
            assert.equal(fromClient, fromHost, `${provider} ${host} ${ownerRepo} ${kind} ${number}`)
          }
        }
      }
    }
  }
})

test('pageCount / pageSlots 在两侧给出同一个分页条', async () => {
  const client = await mirror()
  for (const total of [0, 1, 19, 20, 21, 199, 1000, undefined, null]) {
    for (const perPage of protocol.PAGE_SIZES) {
      assert.equal(client.pageCount(total, perPage), protocol.pageCount(total, perPage), `${total}/${perPage}`)
    }
  }
  for (const count of [0, 1, 5, 7, 8, 20, 137]) {
    for (const current of [1, 2, 4, Math.max(1, count - 1), count]) {
      for (const slots of [5, 7]) {
        assert.deepEqual(
          client.pageSlots(current, count, slots),
          protocol.pageSlots(current, count, slots),
          `current=${current} count=${count} slots=${slots}`,
        )
      }
    }
  }
})
