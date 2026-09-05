/**
 * GitHub client tests, against a stubbed fetch. The interesting parts are the
 * ones that only exist because a forge is inconsistent: a merged pull request
 * that reports itself as closed, colours without a `#`, a search API that caps
 * pagination, and the error-code mapping the panel renders messages from.
 *
 * @module dsh-plugin-repopanel/test/github
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SEARCH_RESULT_CAP, githubClient } from '../src/host/github.js'

/** A client whose every request is recorded and answered by `reply`. */
function stub(reply, options = {}) {
  const calls = []
  const client = githubClient({
    host: options.host ?? 'github.com',
    ownerRepo: options.ownerRepo ?? 'o/r',
    token: 'token' in options ? options.token : 'ghp_x',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(String(url)), init })
      return reply(String(url), init)
    },
  })
  return { client, calls }
}

const searchReply = (items, extra = {}) => () => Response.json({
  total_count: items.length,
  incomplete_results: false,
  items,
  ...extra,
})

test('搜索里的自由文本按词加引号，不能变成 qualifier', async () => {
  const { client, calls } = stub(searchReply([]))
  await client.list({
    tab: 'issues',
    state: 'open',
    search: 'repo:evil/other crash',
    labels: ['needs "quotes"'],
    assignedToMe: true,
    sort: 'newest',
    page: 1,
    perPage: 20,
  })
  const q = calls[0].url.searchParams.get('q')
  // 关键断言：注入进来的 repo: 只是一个被引号包住的词，不是第二个 repo 限定符。
  // GitHub 会把多个 repo: 按 OR 处理，那样列表里就会混进别的仓库的行，而这个插件
  // 的 source key 是按「选中的远端」算的，一触发就把任务挂到错的仓库上。
  assert.ok(q.includes('repo:o/r'), q)
  assert.ok(q.includes('"repo:evil/other"'), q)
  assert.ok(!/\srepo:evil/.test(q), `注入的 repo: 必须被引号裹住：${q}`)
  assert.ok(q.includes('"crash"'), q)
  assert.ok(q.includes('is:issue') && q.includes('state:open') && q.includes('assignee:@me'), q)
  assert.ok(q.includes('label:"needs \\"quotes\\""'), `标签里的引号要转义：${q}`)
})

test('已合并的 PR 报成 merged，未合并的关闭仍是 closed', async () => {
  const { client } = stub(searchReply([
    { number: 1, title: 'a', state: 'closed', html_url: 'u', pull_request: { merged_at: '2026-01-01T00:00:00Z' } },
    { number: 2, title: 'b', state: 'closed', html_url: 'u', pull_request: {} },
  ]))
  const page = await client.list({ tab: 'prs', state: 'all', search: '', labels: [], sort: 'newest', page: 1, perPage: 20 })
  assert.equal(page.rows[0].state, 'merged', 'GitHub 把合并了的 PR 也报成 closed，得自己推出来')
  assert.equal(page.rows[1].state, 'closed')
  assert.equal(page.rows[0].isPr, true)
})

test('标签颜色补成 #rrggbb，认不出来的给 null', async () => {
  const { client } = stub(searchReply([{
    number: 1,
    title: 'a',
    state: 'open',
    html_url: 'u',
    labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'x', color: 'abc' }, { name: 'y', color: 'rebeccapurple' }],
  }]))
  const page = await client.list({ tab: 'issues', state: 'open', search: '', labels: [], sort: 'newest', page: 1, perPage: 20 })
  assert.deepEqual(page.rows[0].labels, [
    { name: 'bug', color: '#d73a4a' },
    { name: 'x', color: '#aabbcc' },
    { name: 'y', color: null },
  ])
})

test('分页被搜索上限夹住，而不是让深链接页码变成 422', async () => {
  const { client, calls } = stub(searchReply([], { total_count: 5000 }))
  const page = await client.list({ tab: 'issues', state: 'open', search: '', labels: [], sort: 'newest', page: 999, perPage: 30 })
  assert.equal(page.reachableCount, SEARCH_RESULT_CAP)
  assert.equal(page.page, Math.floor(SEARCH_RESULT_CAP / 30))
  assert.equal(calls[0].url.searchParams.get('page'), String(page.page))
})

test('count 读不到就返回 undefined —— 计数徽标可以未知，但不能是错的', async () => {
  const { client } = stub(() => new Response('nope', { status: 503 }))
  assert.equal(await client.count({ tab: 'issues', state: 'open', search: '', labels: [], sort: 'newest' }), undefined)
})

test('错误映射：404 / 401 / 限流 / 其他各自成码', async () => {
  const cases = [
    [404, {}, 'not_found'],
    [401, {}, 'forbidden'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [500, {}, 'forge_error'],
  ]
  for (const [status, headers, code] of cases) {
    const { client } = stub(() => Response.json({ message: 'boom' }, { status, headers }))
    await assert.rejects(() => client.item({ kind: 'issue', number: 1 }), (error) => {
      assert.equal(error.code, code, `HTTP ${status}`)
      assert.match(error.message, /boom/, 'forge 说的原因要带出来，否则用户只看到一个状态码')
      // 我们自己不能把令牌拼进错误消息 —— 它会进日志、进诊断、进 issue 截图
      assert.ok(!error.message.includes('ghp_x'), error.message)
      return true
    })
  }
})

test('没有令牌时不发 Authorization 头', async () => {
  const { client, calls } = stub(searchReply([]), { token: undefined })
  await client.list({ tab: 'issues', state: 'open', search: '', labels: [], sort: 'newest', page: 1, perPage: 20 })
  const headers = calls[0].init.headers
  assert.equal(headers.Authorization ?? headers.authorization, undefined)
  assert.equal(headers.Accept, 'application/vnd.github+json')
})

test('GitHub Enterprise 走 /api/v3', async () => {
  const { client, calls } = stub(searchReply([]), { host: 'ghe.example.com' })
  await client.list({ tab: 'issues', state: 'open', search: '', labels: [], sort: 'newest', page: 1, perPage: 20 })
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://ghe.example.com/api/v3/search/issues')
})
