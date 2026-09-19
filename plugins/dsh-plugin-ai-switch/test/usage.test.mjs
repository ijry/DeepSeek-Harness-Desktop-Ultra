/**
 * The two counting rules, the path guard, and the merge — the four things in this
 * subsystem that are expensive to get wrong.
 *
 * Every case builds a real transcript corpus in a temporary directory and points `HOME`,
 * `CODEX_HOME` and `CLAUDE_CONFIG_DIR` at it, so the scan exercises the same root
 * resolution and directory walk the panel uses without ever reading the developer's own
 * `~/.claude`. The parse cache is cleared around each case because fixtures are written
 * fresh at paths a previous case may have used.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { getSessionMessages, listSessions } from '../src/host/sessions.js'
import {
  costMicros,
  getSessionUsageStats,
  getUsageOverview,
  loadPriceTable,
  priceFor,
  resetUsageCache,
  scanSessionUsage,
} from '../src/host/usage.js'

const temporaryHomes = []

after(async () => {
  for (const home of temporaryHomes) {
    await rm(home, { recursive: true, force: true })
  }
})

/** Run `body` against a hermetic home directory, restoring the environment after. */
async function withTempHome(body) {
  const home = await mkdtemp(join(tmpdir(), 'ai-switch-usage-'))
  temporaryHomes.push(home)
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  resetUsageCache()
  try {
    return await body(home)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    resetUsageCache()
  }
}

async function writeJsonl(path, lines) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function claudePath(home, name) {
  return join(home, '.claude', 'projects', 'D--repo-app', name)
}

function codexPath(home, name) {
  return join(home, '.codex', 'sessions', '2026', '08', '19', name)
}

function claudeLine(id, model, input, output, timestamp = '2026-08-19T14:04:50.011Z') {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

function codexTokenCount(timestamp, input, cached, output) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  })
}

function codexTurnContext(timestamp, model) {
  return JSON.stringify({ timestamp, type: 'turn_context', payload: { model } })
}

test('codex token_count totals are cumulative, so each turn is a delta', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'rollout.jsonl'), [
      codexTurnContext('2026-08-19T03:41:50.476Z', 'gpt-5.6-sol'),
      codexTokenCount('2026-08-19T03:42:00.000Z', 100, 0, 10),
      codexTokenCount('2026-08-19T03:43:00.000Z', 300, 0, 30),
      codexTokenCount('2026-08-19T03:44:00.000Z', 1000, 200, 50),
    ])

    const stats = await getSessionUsageStats({})

    // Three turns, not one file-level row and not a triple-counted sum: summing the
    // snapshots would report 1400 input where the session's own final figure is 1000.
    assert.equal(stats.totals.request_count, 3)
    assert.equal(stats.totals.input_tokens, 800)
    assert.equal(stats.totals.cache_read_tokens, 200)
    assert.equal(stats.totals.output_tokens, 50)
    assert.equal(stats.by_model[0].model, 'gpt-5.6-sol')
    assert.equal(stats.by_provider[0].provider, 'codex')
    assert.equal(stats.by_provider[0].model, '')
  })
})

test('codex repeats the same cumulative value 2-3 times and only the first is a turn', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'rollout.jsonl'), [
      codexTurnContext('2026-08-19T03:41:50.476Z', 'gpt-5.6-sol'),
      codexTokenCount('2026-08-19T03:42:00.000Z', 100, 0, 10),
      codexTokenCount('2026-08-19T03:42:01.000Z', 100, 0, 10),
      codexTokenCount('2026-08-19T03:42:02.000Z', 100, 0, 10),
      codexTokenCount('2026-08-19T03:43:00.000Z', 300, 0, 30),
    ])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.request_count, 2)
    assert.equal(stats.totals.input_tokens, 300)
    assert.equal(stats.totals.output_tokens, 30)
  })
})

test('a codex counter reset restarts the running total instead of going negative', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'rollout.jsonl'), [
      codexTurnContext('2026-08-19T03:41:50.476Z', 'gpt-5.6-sol'),
      codexTokenCount('2026-08-19T03:42:00.000Z', 1000, 0, 100),
      codexTokenCount('2026-08-19T03:43:00.000Z', 50, 0, 5),
      codexTokenCount('2026-08-19T03:44:00.000Z', 120, 0, 12),
    ])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.request_count, 3)
    // 1000 (first) + 50 (restart) + 70 (delta), and 100 + 5 + 7 out.
    assert.equal(stats.totals.input_tokens, 1120)
    assert.equal(stats.totals.output_tokens, 112)
  })
})

test('a forked codex rollout does not re-count its replayed parent history', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'forked.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-19T03:41:50.400Z',
        type: 'session_meta',
        payload: { id: '019fd099', forked_from_id: '019fcbb9', parent_thread_id: '019fcbb9' },
      }),
      // The parent's history, dumped at the fork instant.
      JSON.stringify({
        timestamp: '2026-08-19T03:41:50.410Z',
        type: 'response_item',
        payload: { type: 'reasoning', id: 'rs_parent-turn' },
      }),
      codexTokenCount('2026-08-19T03:41:50.410Z', 1000, 200, 100),
      codexTokenCount('2026-08-19T03:41:50.411Z', 1600, 400, 160),
      // This thread's own work starts here.
      codexTurnContext('2026-08-19T03:41:50.500Z', 'gpt-5.6-sol'),
      codexTokenCount('2026-08-19T03:42:00.000Z', 1900, 500, 200),
    ])

    const { entries } = await scanSessionUsage({})

    // One turn, and its tokens are the delta from the inherited running total — not the
    // 1900 the cumulative figure would have charged, and not the parent's 1600 again.
    assert.equal(entries.length, 1)
    assert.equal(entries[0].model, 'gpt-5.6-sol')
    assert.equal(entries[0].usage.inputTokens, 200)
    assert.equal(entries[0].usage.cacheReadTokens, 100)
    assert.equal(entries[0].usage.outputTokens, 40)
    // The parent's trailing response id stays with the parent's entry.
    assert.equal(entries[0].responseId, null)
  })
})

test('an unforked rollout still counts usage recorded before its first turn_context', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'plain.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-19T03:41:50.400Z',
        type: 'session_meta',
        payload: { id: '019fd099' },
      }),
      codexTokenCount('2026-08-19T03:42:00.000Z', 100, 0, 10),
      codexTurnContext('2026-08-19T03:42:30.000Z', 'gpt-5.6-sol'),
      codexTokenCount('2026-08-19T03:43:00.000Z', 300, 0, 30),
    ])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.request_count, 2)
    assert.equal(stats.totals.input_tokens, 300)
  })
})

test('a codex rollout with no recorded model is counted but unpriced', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(codexPath(home, 'nameless.jsonl'), [
      codexTokenCount('2026-08-19T03:42:00.000Z', 100, 0, 10),
    ])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.input_tokens, 100)
    assert.equal(stats.totals.cost_micros, 0)
    assert.equal(stats.totals.unpriced_request_count, 1)
    assert.equal(stats.by_model[0].priced, false)
    assert.equal(stats.by_model[0].model, 'unknown')
  })
})

test('claude rows are deduplicated by message.id, within a file and across files', async () => {
  await withTempHome(async (home) => {
    // The same id three times, as resume and compaction produce.
    await writeJsonl(claudePath(home, 'a.jsonl'), [
      claudeLine('msg_1', 'claude-opus-5', 1000000, 0),
      claudeLine('msg_1', 'claude-opus-5', 1000000, 0),
      claudeLine('msg_2', 'claude-opus-5', 0, 1000000),
    ])
    // A second file re-serializing the first message, as a resumed session produces.
    await writeJsonl(claudePath(home, 'b.jsonl'), [claudeLine('msg_1', 'claude-opus-5', 1000000, 0)])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.request_count, 2, 'duplicate ids must be dropped')
    assert.equal(stats.totals.input_tokens, 1000000)
    assert.equal(stats.totals.output_tokens, 1000000)
    // 1M input at $5 + 1M output at $25.
    assert.equal(stats.totals.cost_micros, 30000000)
    assert.equal(stats.scanned_file_count, 2)
    assert.equal(stats.truncated, false)
  })
})

test('claude synthetic messages and malformed lines are skipped, not counted', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(claudePath(home, 'a.jsonl'), [
      'not json at all',
      claudeLine('msg_synthetic', '<synthetic>', 999, 999),
      JSON.stringify({ message: { id: 'no_usage', model: 'claude-opus-5' } }),
      claudeLine('msg_ok', 'anthropic/claude-opus-5-aws', 1000000, 0),
      '{"truncated": ',
    ])

    const stats = await getSessionUsageStats({})

    assert.equal(stats.totals.request_count, 1)
    // The vendor prefix and the `-aws` suffix must still resolve to the Opus rate.
    assert.equal(stats.totals.cost_micros, 5000000)
    assert.equal(stats.totals.unpriced_request_count, 0)
  })
})

test('a since window excludes entries before it and rejects a non-timestamp', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(claudePath(home, 'a.jsonl'), [
      claudeLine('old', 'claude-opus-5', 5, 0, '2026-08-01T00:00:00.000Z'),
      claudeLine('new', 'claude-opus-5', 7, 0, '2026-08-20T00:00:00.000Z'),
    ])

    const stats = await getSessionUsageStats({ since: '2026-08-10T00:00:00Z' })
    assert.equal(stats.totals.request_count, 1)
    assert.equal(stats.totals.input_tokens, 7)

    // Silently widening a bad timestamp to "all time" would inflate the figures shown
    // for a narrow period.
    await assert.rejects(getSessionUsageStats({ since: 'last tuesday' }), {
      code: 'validation.invalid_timestamp',
    })
  })
})

test('the price table prices cache tokens at their own multipliers', async () => {
  const opus = priceFor(null, 'claude-opus-5')
  assert.deepEqual(opus, {
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
  })
  // 1M uncached input at $5 + 1M cache writes at 1.25x + 1M cache reads at 0.1x +
  // 1M output at $25 = $36.75.
  assert.equal(
    costMicros(
      { inputTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 1000000, cacheReadTokens: 1000000 },
      opus,
    ),
    36750000,
  )
  // Ordering in the family table matters: a broader pattern must not win.
  assert.equal(priceFor(null, 'claude-haiku-4-5').outputPerMtok, 5)
  assert.equal(priceFor(null, 'claude-3-5-haiku').outputPerMtok, 5)
  assert.equal(priceFor(null, 'gpt-4o-mini').inputPerMtok, 0.15)
  assert.equal(priceFor(null, 'gpt-5.6-sol').inputPerMtok, 1.25)
  // Unbillable and unrecognized ids have no rate, so a caller must report them as
  // unpriced rather than as free.
  assert.equal(priceFor(null, '<synthetic>'), null)
  assert.equal(priceFor(null, 'some-unreleased-model'), null)
})

test('a model-prices.json override wins, and a malformed entry degrades to the table', async () => {
  const table = loadPriceTable({
    'claude-opus-5': { display_name: '', input_per_mtok: 2, output_per_mtok: 4 },
    'gpt-5': { input_per_mtok: -1, output_per_mtok: 4 },
    'claude-sonnet-5': { input_per_mtok: 1, output_per_mtok: 2, cache_read_per_mtok: 'free' },
  })

  const overridden = priceFor(table, 'anthropic/claude-opus-5')
  assert.equal(overridden.inputPerMtok, 2)
  // Absent cache rates fall back to Anthropic's published multipliers.
  assert.equal(overridden.cacheReadPerMtok, 0.2)
  assert.equal(overridden.cacheWritePerMtok, 2.5)
  // A negative rate and a non-numeric cache rate each drop only their own entry.
  assert.equal(priceFor(table, 'gpt-5.6-sol').inputPerMtok, 1.25)
  assert.equal(priceFor(table, 'claude-sonnet-5').inputPerMtok, 3)
})

test('getSessionMessages refuses any path outside the scanned transcript roots', async () => {
  await withTempHome(async (home) => {
    const inside = await writeJsonl(claudePath(home, 'session.jsonl'), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-19T14:04:50.011Z',
        message: { role: 'user', content: '<command-name>/clear</command-name>' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-19T14:05:00.000Z',
        message: { role: 'user', content: 'fix the tiling mode' },
      }),
    ])
    // A sibling directory whose name merely starts with a root's name. A bare
    // `startsWith` check would accept it.
    const sibling = await writeJsonl(join(home, '.claude', 'projects-secrets', 'keys.jsonl'), [
      JSON.stringify({ message: { role: 'user', content: 'sk-secret' } }),
    ])
    const outside = await writeJsonl(join(home, 'elsewhere', 'keys.jsonl'), [
      JSON.stringify({ message: { role: 'user', content: 'sk-secret' } }),
    ])

    const messages = await getSessionMessages({ providerId: 'claude', sourcePath: inside })
    assert.equal(messages.length, 2)
    assert.equal(messages[1].content, 'fix the tiling mode')
    assert.equal(messages[1].role, 'user')

    for (const path of [sibling, outside, join(home, '.claude', 'projects', '..', 'x.jsonl')]) {
      await assert.rejects(
        getSessionMessages({ providerId: 'claude', sourcePath: path }),
        (error) => {
          assert.equal(error.code, 'validation.session_path')
          return true
        },
        `must refuse ${path}`,
      )
    }
    await assert.rejects(getSessionMessages({ providerId: 'claude', sourcePath: '  ' }), {
      code: 'validation.required',
    })

    // The list side is the other half of the guard: it only ever hands back paths that
    // are inside a root, and skips the bookkeeping line when titling.
    const sessions = await listSessions({ platform: 'claude' })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].providerId, 'claude')
    assert.equal(sessions[0].sourcePath, inside)
    assert.equal(sessions[0].title, 'fix the tiling mode')
    assert.equal(sessions[0].resumeCommand, `claude --resume ${sessions[0].sessionId}`)
  })
})

/** One ledger row in the shape `getUsageOverview` documents. */
function proxyEvent(overrides) {
  return {
    id: 'proxy-1',
    occurred_at: '2026-08-19T14:05:00+00:00',
    platform: 'claude',
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    account_id: 'cred-1',
    account_name: 'main account',
    source_label: 'Claude Code',
    path: '/v1/messages',
    status: '200',
    success: true,
    input_tokens: 1000,
    output_tokens: 100,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    price_usd_micros: 9999,
    price_source: 'upstream',
    upstream_response_id: 'msg_a',
    ...overrides,
  }
}

test('the overview merges the two sides into matched, session_only and proxy_only rows', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(claudePath(home, 'a.jsonl'), [
      claudeLine('msg_a', 'claude-opus-5', 1000, 100),
      claudeLine('msg_b', 'claude-opus-5', 2000, 200),
    ])

    const overview = await getUsageOverview({
      utcOffsetMinutes: 8 * 60,
      proxyEvents: [
        proxyEvent({}),
        proxyEvent({ id: 'proxy-2', upstream_response_id: 'msg_never_seen', price_source: 'estimated' }),
        // No id at all, and successful: the row the panel has to warn about, because a
        // transcript entry for the same request is still counted separately.
        proxyEvent({ id: 'proxy-3', upstream_response_id: null, price_source: null }),
      ],
    })

    const bySource = new Map(overview.rows.map((row) => [row.source, row]))
    assert.equal(overview.row_count, 4)
    assert.equal(overview.rows.length, 4)
    assert.equal(overview.rows.filter((row) => row.source === 'proxy_only').length, 2)
    assert.equal(overview.totals.request_count, 4)
    assert.equal(overview.page, 1)
    assert.equal(overview.page_size, 20)

    const matched = bySource.get('matched')
    assert.equal(matched.id, 'proxy-1')
    assert.equal(matched.account_name, 'main account')
    assert.equal(matched.status, '200')
    // The upstream's own price wins over a local estimate, and the transcript's token
    // split wins over the proxy's.
    assert.equal(matched.cost_micros, 9999)
    assert.equal(matched.price_source, 'upstream')
    assert.equal(matched.input_tokens, 1000)
    assert.equal(matched.upstream_response_id, 'msg_a')

    const sessionOnly = bySource.get('session_only')
    assert.equal(sessionOnly.id, 'msg_b')
    assert.equal(sessionOnly.account_name, null)
    assert.equal(sessionOnly.status, null)
    assert.equal(sessionOnly.price_source, 'estimated')
    // 2000 input at $5/MTok + 200 output at $25/MTok = 15_000 micros.
    assert.equal(sessionOnly.cost_micros, 15000)
    assert.equal(sessionOnly.occurred_at, '2026-08-19T14:04:50.011+00:00')

    assert.equal(overview.integrity.unmatchable_proxy_row_count, 1)
    assert.equal(overview.integrity.scanned_file_count, 1)
    assert.equal(overview.integrity.truncated, false)
    assert.equal(overview.integrity.unpriced_request_count, 0)
    // Everything but the one upstream-priced row: a ledger price that is itself only an
    // estimate is recomputed from the local table rather than trusted.
    assert.equal(overview.integrity.estimated_price_request_count, 3)

    assert.deepEqual(
      overview.groups.by_source.map((row) => row.key).sort(),
      ['仅代理', '仅会话', '匹配'],
    )
    assert.deepEqual(overview.groups.by_platform.map((row) => row.key), ['claude'])
    assert.equal(
      overview.groups.by_account.map((row) => row.key).includes('未经代理'),
      true,
      'a transcript-only row has no account and needs a labelled bucket',
    )

    // The chart is sliced at the caller's midnight, not the host's.
    assert.equal(overview.series.buckets.length > 0, true)
    assert.equal(overview.series.buckets[0].start.endsWith('+08:00'), true)
    assert.equal(
      overview.series.buckets.reduce((sum, bucket) => sum + bucket.request_count, 0),
      4,
    )
    assert.equal(overview.series.undated_request_count, 0)

    const page2 = await getUsageOverview({ page: 2, pageSize: 3, proxyEvents: [proxyEvent({})] })
    assert.equal(page2.row_count, 2)
    assert.equal(page2.rows.length, 0, 'a page past the end is empty, not an error')
  })
})

test('a proxy row written before the id column existed is matched from its body preview', async () => {
  await withTempHome(async (home) => {
    await writeJsonl(claudePath(home, 'a.jsonl'), [claudeLine('msg_sse', 'claude-opus-5', 10, 1)])

    const overview = await getUsageOverview({
      proxyEvents: [
        proxyEvent({
          upstream_response_id: null,
          metadata_json: JSON.stringify({
            path: '/v1/messages',
            success: true,
            response_body:
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_sse"}}\n\n',
          }),
        }),
      ],
    })

    assert.equal(overview.row_count, 1)
    assert.equal(overview.rows[0].source, 'matched')
    // Recovered, so it is not one of the rows the panel warns could double count.
    assert.equal(overview.integrity.unmatchable_proxy_row_count, 0)
  })
})

test('the parse cache is reused for an unchanged file and dropped when one changes', async () => {
  await withTempHome(async (home) => {
    const path = claudePath(home, 'a.jsonl')
    await writeJsonl(path, [claudeLine('msg_1', 'claude-opus-5', 100, 0)])

    const first = await scanSessionUsage({})
    const second = await scanSessionUsage({})
    assert.equal(first.entries.length, 1)
    assert.equal(second.entries.length, 1)

    // Rewriting changes size and mtime, so the cache must re-parse rather than serve the
    // stale entry list.
    await writeJsonl(path, [
      claudeLine('msg_1', 'claude-opus-5', 100, 0),
      claudeLine('msg_2', 'claude-opus-5', 200, 0),
    ])
    const third = await scanSessionUsage({})
    assert.equal(third.entries.length, 2)
  })
})

test('several proxy rows sharing one synthesized id do not collapse into one', async () => {
  await withTempHome(async (home) => {
    // A protocol bridge that cannot read a real id writes the same constant on every row.
    await writeJsonl(claudePath(home, 'a.jsonl'), [
      claudeLine('bridge-const', 'claude-opus-5', 10, 1),
    ])

    const overview = await getUsageOverview({
      proxyEvents: [
        proxyEvent({ id: 'proxy-1', upstream_response_id: 'bridge-const' }),
        proxyEvent({ id: 'proxy-2', upstream_response_id: 'bridge-const' }),
        proxyEvent({ id: 'proxy-3', upstream_response_id: 'bridge-const' }),
      ],
    })

    // One entry claims one row; the other two stay visible as proxy-only rather than
    // vanishing from every total.
    assert.equal(overview.row_count, 3)
    assert.equal(overview.rows.filter((row) => row.source === 'matched').length, 1)
    assert.equal(overview.rows.filter((row) => row.source === 'proxy_only').length, 2)
    assert.equal(overview.totals.request_count, 3)
  })
})
