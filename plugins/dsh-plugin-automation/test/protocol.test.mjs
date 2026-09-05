/**
 * Domain tests for the pure core: what a draft must contain, what the scheduler
 * reads off a record, how a run settles onto its automation, and the prompt
 * composition. No disk, no webserver, no clock of its own.
 *
 * @module dsh-plugin-automation/test/protocol
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTION_KINDS,
  DEFAULT_PREAMBLE,
  MAX_PROMPT_CHARS,
  applyDraft,
  applyRunOutcome,
  composePrompt,
  computeNextRun,
  createAutomation,
  createRun,
  createSkippedRun,
  decorateAutomation,
  defaultSettings,
  dueAutomations,
  emptyLedger,
  isPlausibleAutomation,
  isPlausibleRun,
  listAutomations,
  makeId,
  normalizeDraft,
  normalizeSettings,
  pruneRuns,
  reviveInterruptedRun,
  settleRun,
  tailCap,
  taskTitle,
} from '../src/shared/protocol.js'

/** 2026-09-05 10:00 local, a Saturday. */
const NOW = new Date(2026, 8, 5, 10, 0, 0).getTime()

const draftOf = (patch) => normalizeDraft({
  name: '每日测试',
  prompt: '跑测试',
  schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
  action: { kind: 'headless' },
  ...patch,
}, defaultSettings())

const recordOf = (patch) => createAutomation(draftOf(patch), { now: NOW, id: 'auto_1' })

test('草稿的必填项与默认值', () => {
  const draft = draftOf({})
  assert.equal(draft.enabled, true)
  assert.equal(draft.usePreamble, true)
  assert.equal(draft.catchUp, false)
  assert.equal(draft.overlap, 'skip')
  assert.equal(draft.action.timeoutMinutes, 30)
  assert.equal(draft.note, undefined)
  assert.equal(draft.workspaceId, undefined)
  // Whitespace-only text is empty, not a value.
  assert.throws(() => draftOf({ name: '   ' }), (error) => error.code === 'invalid_input')
  assert.throws(() => draftOf({ prompt: '\n\n' }), (error) => error.code === 'invalid_input')
  assert.throws(() => draftOf({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }), (error) => error.code === 'invalid_input')
  assert.throws(() => draftOf({ schedule: { kind: 'nope' } }), (error) => error.code === 'invalid_input')
  assert.throws(() => draftOf({ action: { kind: 'nope' } }), (error) => error.code === 'invalid_input')
  // A card nobody can claim is worse than a rejected form.
  assert.throws(() => draftOf({ action: { kind: 'taskboard' } }), (error) => /项目/.test(error.message))
  assert.equal(draftOf({ action: { kind: 'taskboard' }, workspaceId: 'ws1' }).action.timeoutMinutes, undefined)
  // Out-of-range timeouts clamp rather than fail: the form ships a number input.
  assert.equal(draftOf({ action: { kind: 'headless', timeoutMinutes: 99999 } }).action.timeoutMinutes, 720)
  assert.equal(draftOf({ schedule: { kind: 'interval', intervalMinutes: 45 } }).schedule.intervalMinutes, 45)
  assert.throws(() => draftOf({ schedule: { kind: 'interval', intervalMinutes: 0 } }), (error) => error.code === 'invalid_input')
})

test('新建记录带上计数器与下一次时间；改草稿不动历史', () => {
  const record = recordOf({})
  assert.equal(record.version, 1)
  assert.equal(record.runCount, 0)
  assert.ok(record.nextRunAt > NOW)
  assert.equal(decorateAutomation(record).scheduleText, '每个工作日 09:00')

  const busy = { ...record, runCount: 7, failureCount: 2, consecutiveFailures: 2, enabled: false, pausedReason: '连续失败 2 次，已自动暂停' }
  const updated = applyDraft(busy, draftOf({ name: '改过名' }), NOW + 1000)
  assert.equal(updated.name, '改过名')
  assert.equal(updated.version, 2)
  assert.equal(updated.runCount, 7)
  assert.equal(updated.failureCount, 2)
  // Re-enabling by hand forgives the streak that parked it.
  assert.equal(updated.consecutiveFailures, 0)
  assert.equal(updated.pausedReason, undefined)
  // Dropping an optional field must actually remove it, not leave the old value.
  const noted = applyDraft(record, draftOf({ note: '说明' }), NOW)
  assert.equal(noted.note, '说明')
  assert.equal(applyDraft(noted, draftOf({}), NOW).note, undefined)
})

test('停用的、手动的、以及总开关关掉的都不会被判定为到点', () => {
  const armed = recordOf({})
  const manual = { ...recordOf({ schedule: { kind: 'manual' } }), id: 'auto_manual' }
  const off = { ...recordOf({ enabled: false }), id: 'auto_off' }
  assert.equal(computeNextRun(manual, { now: NOW }), undefined)
  assert.equal(computeNextRun(off, { now: NOW }), undefined)

  const ledger = { ...emptyLedger(), automations: { auto_1: armed, auto_manual: manual, auto_off: off } }
  assert.deepEqual(dueAutomations(ledger, { now: NOW }), [])
  const due = dueAutomations(ledger, { now: armed.nextRunAt + 1000 })
  assert.deepEqual(due.map((row) => row.id), ['auto_1'])
  assert.equal(due[0].missed, false)
  // Late by more than the grace window means the host was not running.
  assert.equal(dueAutomations(ledger, { now: armed.nextRunAt + 3600_000 })[0].missed, true)
  // The master switch stops the clock without touching any record.
  const paused = { ...ledger, settings: { ...ledger.settings, enabled: false } }
  assert.deepEqual(dueAutomations(paused, { now: armed.nextRunAt + 1000 }), [])
})

test('结算是幂等的，并把结果折回自动化', () => {
  const record = recordOf({})
  const run = createRun(record, { now: NOW, trigger: 'schedule', scheduledFor: NOW, cwd: 'C:/x' })
  assert.equal(run.status, 'running')
  assert.equal(run.cwd, 'C:/x')
  const settled = settleRun(run, { status: 'failed', now: NOW + 5000, exitCode: 1, error: '炸了', output: '半截输出' })
  assert.equal(settled.status, 'failed')
  assert.equal(settled.durationMs, 5000)
  assert.equal(settled.exitCode, 1)
  // A settled run is settled: the timeout and the exit race, and the loser is a
  // no-op rather than a second write.
  assert.equal(settleRun(settled, { status: 'succeeded', now: NOW + 9000 }), undefined)
  assert.throws(() => settleRun(run, { status: 'nonsense', now: NOW }))

  const after = applyRunOutcome(record, settled, { now: NOW + 5000, autoDisableAfterFailures: 2 })
  assert.equal(after.runCount, 1)
  assert.equal(after.failureCount, 1)
  assert.equal(after.consecutiveFailures, 1)
  assert.equal(after.enabled, true)
  const parked = applyRunOutcome(after, settled, { now: NOW + 6000, autoDisableAfterFailures: 2 })
  assert.equal(parked.enabled, false)
  assert.match(parked.pausedReason, /连续失败 2 次/)
  assert.equal(parked.nextRunAt, undefined)
  // One success clears the streak.
  const ok = settleRun(createRun(record, { now: NOW, trigger: 'manual' }), { status: 'succeeded', now: NOW + 1000 })
  assert.equal(applyRunOutcome(after, ok, { now: NOW + 1000, autoDisableAfterFailures: 2 }).consecutiveFailures, 0)
})

test('跳过的运行落终态、不计入成功率', () => {
  const record = recordOf({})
  const skipped = createSkippedRun(record, { now: NOW, trigger: 'schedule', reason: '上一次运行还没结束，这次跳过' })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.startedAt, undefined)
  assert.equal(skipped.finishedAt, NOW)
  const after = applyRunOutcome(record, skipped, { now: NOW })
  assert.equal(after.runCount, 0)
  assert.equal(after.failureCount, 0)
  assert.equal(after.lastStatus, 'skipped')
})

test('无人值守说明加在提示词前面，可以逐条关掉', () => {
  const settings = defaultSettings()
  const composed = composePrompt(recordOf({}), settings)
  assert.ok(composed.startsWith(DEFAULT_PREAMBLE))
  assert.ok(composed.endsWith('跑测试'))
  assert.equal(composePrompt(recordOf({ usePreamble: false }), settings), '跑测试')
  // An emptied preamble is the same as no preamble.
  assert.equal(composePrompt(recordOf({}), { ...settings, preamble: '   ' }), '跑测试')
})

test('看板卡片标题带上时间，并且不超过看板的上限', () => {
  // The name is already capped at 120 by validation; the title adds the slot.
  const long = recordOf({ name: '很长的名字'.repeat(24) })
  const title = taskTitle(long, NOW)
  assert.ok(title.length <= 200)
  assert.match(title, /2026-09-05 10:00$/)
  // A cap tighter than the name forces the name to give way, not the stamp.
  const tight = taskTitle(long, NOW, 40)
  assert.ok(tight.length <= 40)
  assert.match(tight, /2026-09-05 10:00$/)
})

test('设置越界会被夹住而不是拒绝', () => {
  const settings = normalizeSettings({
    enabled: false, maxConcurrentRuns: 999, defaultTimeoutMinutes: 0,
    keepRunsPerAutomation: -3, autoDisableAfterFailures: 1000, preamble: 42, unknown: 'x',
  })
  assert.equal(settings.enabled, false)
  assert.equal(settings.maxConcurrentRuns, 8)
  assert.equal(settings.defaultTimeoutMinutes, 1)
  assert.equal(settings.keepRunsPerAutomation, 1)
  assert.equal(settings.autoDisableAfterFailures, 100)
  assert.equal(settings.preamble, DEFAULT_PREAMBLE)
  assert.equal(settings.unknown, undefined)
  assert.deepEqual(normalizeSettings(null), defaultSettings())
})

test('加载守卫认出不可用的行，被中断的运行只能是失败', () => {
  assert.equal(isPlausibleAutomation(recordOf({})), true)
  assert.equal(isPlausibleAutomation(null), false)
  assert.equal(isPlausibleAutomation({ ...recordOf({}), prompt: '' }), false)
  assert.equal(isPlausibleAutomation({ ...recordOf({}), schedule: { kind: 'cron', cron: '99 * * * *' } }), false)
  assert.equal(isPlausibleAutomation({ ...recordOf({}), createdAt: 'yesterday' }), false)
  assert.equal(isPlausibleRun({ id: 'r', automationId: 'a', status: 'succeeded', createdAt: NOW }), true)
  assert.equal(isPlausibleRun({ id: 'r', automationId: 'a', status: 'weird', createdAt: NOW }), false)

  const revived = reviveInterruptedRun({ id: 'r', automationId: 'a', status: 'running', startedAt: NOW }, NOW + 1000)
  assert.equal(revived.status, 'failed')
  assert.match(revived.error, /重启/)
})

test('列表排序把最快触发的排在前面，停用的排在后面', () => {
  const soon = { ...recordOf({}), id: 'soon', nextRunAt: NOW + 1000 }
  const later = { ...recordOf({}), id: 'later', nextRunAt: NOW + 90_000 }
  const off = { ...recordOf({}), id: 'off', enabled: false, nextRunAt: undefined, createdAt: NOW + 5 }
  const ledger = { ...emptyLedger(), automations: { later, off, soon } }
  assert.deepEqual(listAutomations(ledger).map((row) => row.id), ['soon', 'later', 'off'])
})

test('输出只保留尾部，id 有可读前缀', () => {
  assert.equal(tailCap('  ', 10), undefined)
  assert.equal(tailCap('abc', 10), 'abc')
  const capped = tailCap('x'.repeat(50), 10)
  assert.match(capped, /已截断/)
  assert.ok(capped.endsWith('x'.repeat(10)))
  assert.match(makeId('auto', () => 0.5), /^auto_[0-9a-z]{12}$/)
})

test('修剪按上限保留最新的，正在跑的不算在内', () => {
  const ledger = { ...emptyLedger(), automations: { auto_1: recordOf({}) }, runs: {} }
  for (let index = 0; index < 5; index += 1) {
    ledger.runs['r' + index] = { id: 'r' + index, automationId: 'auto_1', status: 'succeeded', createdAt: NOW + index }
  }
  ledger.runs.live = { id: 'live', automationId: 'auto_1', status: 'running', createdAt: NOW - 1000 }
  assert.equal(pruneRuns(ledger, 2), 3)
  assert.deepEqual(Object.keys(ledger.runs).sort(), ['live', 'r3', 'r4'])
})

test('执行方式的取值集合是稳定的线协议', () => {
  assert.deepEqual([...ACTION_KINDS], ['headless', 'taskboard'])
})
