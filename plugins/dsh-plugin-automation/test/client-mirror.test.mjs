/**
 * The browser bundle cannot import `shared/*.js` — it is a standalone loader script
 * with no module resolution — so it keeps a hand-written COPY of the presentation
 * vocabulary. That copy drifting is a quiet failure: nothing throws, a label just
 * goes missing or a form default stops matching what the host accepts.
 *
 * This test lifts the client's mirror section out of the source, evaluates it, and
 * holds it against the host's real vocabulary.
 *
 * @module dsh-plugin-automation/test/client-mirror
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as cron from '../src/shared/cron.js'
import * as protocol from '../src/shared/protocol.js'
import { AUTOMATION_TEMPLATES } from '../src/shared/templates.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const START = '  // ------------------------------------------------------------- vocabulary'
const END = '  // ---------------------------------------------------------------- helpers'

/**
 * Evaluate the client's mirror section on its own and hand back its symbols.
 * Slicing on the section banners is deliberate: if someone renames or moves a
 * banner this test fails loudly, which is the correct outcome — the mirror needs a
 * reviewer's eye either way.
 */
async function mirror() {
  const source = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')
  const from = source.indexOf(START)
  const to = source.indexOf(END)
  assert.ok(from > -1 && to > from, '找不到 client 里的 vocabulary 段落 —— 段落标记被改过了')
  const expose = [
    'MAX_NAME_CHARS', 'MAX_NOTE_CHARS', 'MAX_PROMPT_CHARS',
    'MIN_TIMEOUT_MINUTES', 'MAX_TIMEOUT_MINUTES', 'INTERVAL_CHOICES',
    'SCHEDULE_LABELS', 'ACTION_LABELS', 'ACTION_HINTS', 'OVERLAP_LABELS',
    'STATUS_LABELS', 'TRIGGER_LABELS', 'FILTERS', 'CRON_PRESETS',
  ]
  // eslint-disable-next-line no-new-func -- the input is this repo's own source
  return new Function(`${source.slice(from, to)}\nreturn { ${expose.join(', ')} }`)()
}

test('上限与选项镜像与 shared 一致', async () => {
  const client = await mirror()
  assert.equal(client.MAX_NAME_CHARS, protocol.MAX_NAME_CHARS)
  assert.equal(client.MAX_NOTE_CHARS, protocol.MAX_NOTE_CHARS)
  assert.equal(client.MAX_PROMPT_CHARS, protocol.MAX_PROMPT_CHARS)
  assert.equal(client.MIN_TIMEOUT_MINUTES, protocol.MIN_TIMEOUT_MINUTES)
  assert.equal(client.MAX_TIMEOUT_MINUTES, protocol.MAX_TIMEOUT_MINUTES)
  assert.deepEqual(client.INTERVAL_CHOICES, cron.INTERVAL_CHOICES)
})

test('每个枚举都有中文标签，且没有多出宿主不认的键', async () => {
  const client = await mirror()
  const pairs = [
    [client.SCHEDULE_LABELS, protocol.SCHEDULE_KINDS, 'SCHEDULE_LABELS'],
    [client.ACTION_LABELS, protocol.ACTION_KINDS, 'ACTION_LABELS'],
    [client.ACTION_HINTS, protocol.ACTION_KINDS, 'ACTION_HINTS'],
    [client.OVERLAP_LABELS, protocol.OVERLAP_POLICIES, 'OVERLAP_LABELS'],
    [client.STATUS_LABELS, protocol.RUN_STATUSES, 'STATUS_LABELS'],
    [client.TRIGGER_LABELS, protocol.RUN_TRIGGERS, 'TRIGGER_LABELS'],
  ]
  for (const [labels, keys, label] of pairs) {
    assert.deepEqual(Object.keys(labels).sort(), [...keys].sort(), `${label} 与宿主枚举不一致`)
    for (const [key, text] of Object.entries(labels)) {
      assert.ok(typeof text === 'string' && text.length > 0, `${label}.${key} 是空的`)
    }
  }
})

test('cron 预设都能被宿主解析，并且真的会触发', async () => {
  const client = await mirror()
  const now = Date.now()
  for (const preset of client.CRON_PRESETS) {
    assert.ok(cron.isValidCron(preset.cron), `预设无法解析：${preset.cron}`)
    assert.ok(Number.isFinite(cron.nextCronTime(preset.cron, now)), `预设永不触发：${preset.cron}`)
    // The pill label is what the user picks by; it must describe the expression it
    // sets, not something else.
    assert.ok(preset.label.length > 0)
  }
})

test('筛选器的 id 与 client 的筛选实现一致', async () => {
  const client = await mirror()
  assert.deepEqual(client.FILTERS.map((row) => row.id), ['all', 'enabled', 'paused', 'failing'])
})

test('内置模板都能通过宿主的校验，并且提示词里没有破坏性动作', () => {
  const banned = /\b(git\s+push|git\s+commit|rm\s+-rf|npm\s+publish|deploy)\b/i
  for (const template of AUTOMATION_TEMPLATES) {
    const draft = protocol.normalizeDraft({
      name: template.name,
      note: template.note,
      prompt: template.prompt,
      schedule: template.schedule,
      action: { kind: template.action },
      // Every template must survive with a project attached; the taskboard one
      // requires it.
      workspaceId: 'ws_test',
    }, protocol.defaultSettings())
    assert.equal(draft.action.kind, template.action)
    assert.ok(protocol.ACTION_KINDS.includes(template.action))
    assert.ok(template.group.length > 0, `${template.id} 没有分组`)
    assert.equal(banned.test(template.prompt), false, `${template.id} 的提示词里有破坏性动作`)
  }
})
