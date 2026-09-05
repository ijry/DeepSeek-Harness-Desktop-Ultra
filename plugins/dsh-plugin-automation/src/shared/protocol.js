/**
 * Pure domain core for dsh-plugin-automation, shared by the host half and the
 * tests. No I/O, no clock of its own, no imports beyond the sibling cron module
 * — every rule here is a total function over plain data, so the scheduling
 * semantics can be tested without a disk, a webserver or a child process.
 *
 * The vocabulary mirrors codeg-plus's 自动化 feature: a saved job carries the
 * prompt, the project it runs in, its schedule and its action, and every firing
 * is recorded as a run with a terminal status. Two things are deliberately
 * different, because the hosts are different:
 *
 * - codeg-plus fires into its own task engine, which owns per-run git worktrees.
 *   dsh has no such engine, so an automation fires either a real one-shot agent
 *   session (`dsh --profile headless`) in the project directory, or a card on
 *   the sibling task board. Both are honest deliveries; neither invents a
 *   worktree behind the user's back.
 * - schedules run in the host's LOCAL time (see ./cron.js) rather than carrying
 *   an IANA zone per automation. The host process is on the user's own machine.
 *
 * IMPORTANT: the browser half cannot import this module (it is bundled as a
 * standalone loader script with no module resolution), so it keeps its own copy
 * of the presentation-facing vocabulary. Change both together — the same
 * constraint the sibling taskboard and repopanel plugins document.
 *
 * @module dsh-plugin-automation/shared/protocol
 */
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  describeSchedule,
  formatStamp,
  isValidCron,
  nextFireAt,
  parseCron,
} from './cron.js'

/** Ledger schema version (bump on breaking record changes). */
export const LEDGER_SCHEMA_VERSION = 1

/** Schedule kinds. `manual` never fires on its own — it is a saved one-click job. */
export const SCHEDULE_KINDS = ['cron', 'interval', 'manual']

/**
 * What a firing actually does.
 * - `headless` runs the prompt as one fresh agent session in the project
 *   directory (`dsh --profile headless "<prompt>"`) and records its answer.
 * - `taskboard` only files a card on dsh-plugin-taskboard for a human or an
 *   agent to pick up later. Nothing is executed.
 */
export const ACTION_KINDS = ['headless', 'taskboard']

/** Run statuses. `running` is the only non-terminal one. */
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'canceled', 'timeout', 'skipped']
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'canceled', 'timeout', 'skipped']

/** What a firing does when the previous run of the SAME automation is still up. */
export const OVERLAP_POLICIES = ['skip', 'cancel']

/** Trigger provenance of a run. */
export const RUN_TRIGGERS = ['schedule', 'manual', 'catchup']

/** Hard caps. A prompt is prose, not a payload; an output tail is evidence, not a log. */
export const MAX_NAME_CHARS = 120
export const MAX_NOTE_CHARS = 2000
export const MAX_PROMPT_CHARS = 20_000
export const MAX_PREAMBLE_CHARS = 4000
export const MAX_OUTPUT_CHARS = 20_000
export const MAX_ERROR_CHARS = 4000
export const MAX_AUTOMATIONS = 200

/** Timeout bounds for one headless run, in minutes. */
export const DEFAULT_TIMEOUT_MINUTES = 30
export const MIN_TIMEOUT_MINUTES = 1
export const MAX_TIMEOUT_MINUTES = 720

/** How many runs are kept per automation, and the bound the setting accepts. */
export const DEFAULT_KEEP_RUNS = 20
export const MAX_KEEP_RUNS = 200

/** How many headless runs may be up at once across all automations. */
export const DEFAULT_MAX_CONCURRENT = 2
export const MAX_MAX_CONCURRENT = 8

/** Consecutive failures that park an automation; 0 disables the guard. */
export const DEFAULT_AUTO_DISABLE_AFTER = 5
export const MAX_AUTO_DISABLE_AFTER = 100

/**
 * The standing note prepended to a headless prompt. An unattended run has nobody
 * to answer a clarifying question, and saying so once is far cheaper than a run
 * that burns its timeout waiting for an answer that will never come.
 */
export const DEFAULT_PREAMBLE = [
  '这是一次由「自动化」计划触发的无人值守运行：没有人在旁边看着，也没有人能回答你的提问。',
  '遇到需要决策的地方，选一个可逆、影响最小的做法继续，并在最后说明你选了什么、为什么。',
  '不要执行破坏性或对外的操作（删数据、强推、部署、发消息）；需要这类操作时停下来，写清建议即可。',
  '结束时用几句话总结你做了什么、验证了什么、还剩什么没做。',
].join('\n')

/** Stable error codes; the route layer maps these onto HTTP statuses. */
export const ERR = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  conflict: 'conflict',
  engineDisabled: 'engine_disabled',
  noTaskboard: 'no_taskboard',
  internal: 'internal',
}

/** Error carrying a stable code; message renders `Error: <code>: <detail>`. */
export class AutomationError extends Error {
  constructor(code, detail) {
    super(`Error: ${code}: ${detail}`)
    this.code = code
  }
}

// ------------------------------------------------------------------ scalars

/** Clamp an integer into a range, falling back when it is not a number at all. */
export function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** A required single-line text field, trimmed and length-checked. */
export function normalizeName(value, cap = MAX_NAME_CHARS) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  if (text.length === 0) throw new AutomationError(ERR.invalidInput, '名称不能为空')
  if (text.length > cap) throw new AutomationError(ERR.invalidInput, `名称最多 ${cap} 个字符`)
  return text
}

/** An optional multi-line text field; empty becomes undefined. */
export function normalizeText(value, label, cap) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AutomationError(ERR.invalidInput, `${label}必须是字符串`)
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > cap) throw new AutomationError(ERR.invalidInput, `${label}最多 ${cap} 个字符`)
  return text
}

/** The prompt: required, and the one field that carries the whole job. */
export function normalizePrompt(value) {
  const text = normalizeText(value, '提示词', MAX_PROMPT_CHARS)
  if (text === undefined) throw new AutomationError(ERR.invalidInput, '提示词不能为空')
  return text
}

/** Keep the LAST `cap` characters — the tail of an agent answer is the answer. */
export function tailCap(value, cap) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length <= cap) return text
  return `…（已截断，仅保留最后 ${cap} 字）\n${text.slice(text.length - cap)}`
}

// ----------------------------------------------------------------- settings

/** The settings a fresh install behaves by. */
export function defaultSettings() {
  return {
    // The master switch. Off means the tick loop still runs but fires nothing —
    // one place to stop every automation without editing any of them.
    enabled: true,
    maxConcurrentRuns: DEFAULT_MAX_CONCURRENT,
    defaultTimeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    keepRunsPerAutomation: DEFAULT_KEEP_RUNS,
    autoDisableAfterFailures: DEFAULT_AUTO_DISABLE_AFTER,
    preamble: DEFAULT_PREAMBLE,
  }
}

/** Read a settings row defensively; unknown keys are dropped, bad values clamped. */
export function normalizeSettings(raw) {
  const defaults = defaultSettings()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const preamble = typeof raw.preamble === 'string' ? raw.preamble.slice(0, MAX_PREAMBLE_CHARS) : defaults.preamble
  return {
    enabled: raw.enabled !== false,
    maxConcurrentRuns: clampInt(raw.maxConcurrentRuns, 1, MAX_MAX_CONCURRENT, defaults.maxConcurrentRuns),
    defaultTimeoutMinutes: clampInt(
      raw.defaultTimeoutMinutes, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, defaults.defaultTimeoutMinutes,
    ),
    keepRunsPerAutomation: clampInt(raw.keepRunsPerAutomation, 1, MAX_KEEP_RUNS, defaults.keepRunsPerAutomation),
    autoDisableAfterFailures: clampInt(
      raw.autoDisableAfterFailures, 0, MAX_AUTO_DISABLE_AFTER, defaults.autoDisableAfterFailures,
    ),
    preamble,
  }
}

/** An empty ledger — what a missing or quarantined file starts from. */
export function emptyLedger() {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    revision: 0,
    settings: defaultSettings(),
    automations: {},
    runs: {},
  }
}

// ----------------------------------------------------------------- schedules

/**
 * Validate one schedule. A cron expression is parsed HERE rather than at fire
 * time: an automation whose schedule cannot be parsed would sit in the list
 * looking armed and never fire, which is the worst possible failure for a
 * scheduler.
 */
export function normalizeSchedule(raw) {
  const kind = raw === null || typeof raw !== 'object' ? undefined : raw.kind
  if (!SCHEDULE_KINDS.includes(kind)) {
    throw new AutomationError(ERR.invalidInput, `触发方式必须是 ${SCHEDULE_KINDS.join(' / ')}`)
  }
  if (kind === 'manual') return { kind: 'manual' }
  if (kind === 'interval') {
    // Rejected rather than clamped: clamping a 0 up to "every minute" would arm a
    // scheduler far more aggressively than anyone asked for.
    const raw2 = raw.intervalMinutes
    const minutes = typeof raw2 === 'number' ? Math.round(raw2) : Number.parseInt(String(raw2 ?? ''), 10)
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new AutomationError(ERR.invalidInput, '间隔必须是 1 分钟到 30 天之间的整数分钟')
    }
    return { kind: 'interval', intervalMinutes: minutes }
  }
  const cron = String(raw.cron ?? '').trim().replace(/\s+/g, ' ')
  try {
    parseCron(cron)
  } catch (error) {
    throw new AutomationError(ERR.invalidInput, error.message)
  }
  return { kind: 'cron', cron }
}

/**
 * Validate one action.
 *
 * There is deliberately no per-automation agent preset or model here: the public
 * one-shot surface is `dsh --profile headless "<task>"`, which takes the task and
 * nothing else, so a run uses the headless profile's own agent configuration.
 * Shipping a preset field that silently did nothing would be worse than not
 * offering one.
 */
export function normalizeAction(raw, settings) {
  const kind = raw === null || typeof raw !== 'object' ? undefined : raw.kind
  if (!ACTION_KINDS.includes(kind)) {
    throw new AutomationError(ERR.invalidInput, `执行方式必须是 ${ACTION_KINDS.join(' / ')}`)
  }
  const action = { kind }
  if (kind === 'headless') {
    action.timeoutMinutes = clampInt(
      raw.timeoutMinutes, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES,
      settings?.defaultTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
    )
  }
  return action
}

// ---------------------------------------------------------------- automations

/** Validate a whole draft coming off the wire. Throws on the first problem. */
export function normalizeDraft(raw, settings) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AutomationError(ERR.invalidInput, '自动化必须是一个对象')
  }
  const draft = {
    name: normalizeName(raw.name),
    prompt: normalizePrompt(raw.prompt),
    schedule: normalizeSchedule(raw.schedule),
    action: normalizeAction(raw.action, settings),
    enabled: raw.enabled !== false,
    usePreamble: raw.usePreamble !== false,
    catchUp: raw.catchUp === true,
    overlap: OVERLAP_POLICIES.includes(raw.overlap) ? raw.overlap : 'skip',
  }
  const note = normalizeText(raw.note, '说明', MAX_NOTE_CHARS)
  if (note !== undefined) draft.note = note
  const workspaceId = normalizeText(raw.workspaceId, '项目', 200)
  if (workspaceId !== undefined) draft.workspaceId = workspaceId
  // A card on the task board must land in a project, or nobody can claim it:
  // the board itself scopes claiming by workspace.
  if (draft.action.kind === 'taskboard' && draft.workspaceId === undefined) {
    throw new AutomationError(ERR.invalidInput, '投递到任务看板必须选一个项目')
  }
  return draft
}

/** Short random id with a readable prefix. */
export function makeId(prefix, random = Math.random) {
  const noise = () => Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')
  return `${prefix}_${noise()}${noise()}`
}

/** A fresh automation record from a validated draft. */
export function createAutomation(draft, options) {
  const now = options.now
  const record = {
    id: options.id ?? makeId('auto', options.random),
    ...draft,
    version: 1,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
  }
  record.nextRunAt = computeNextRun(record, { now })
  return record
}

/**
 * Apply a validated draft over an existing record. Counters and timestamps are
 * NOT part of a draft — a rename must never reset the run history — and the
 * next fire time is recomputed from `now`, so editing a schedule re-arms it
 * rather than keeping a slot the user can no longer see.
 */
export function applyDraft(record, draft, now) {
  const next = {
    ...record,
    ...draft,
    version: record.version + 1,
    updatedAt: now,
  }
  // Re-enabling by hand is the user forgiving the failures; keep the totals but
  // clear the streak that parked it.
  if (draft.enabled && record.enabled === false) {
    next.consecutiveFailures = 0
    delete next.pausedReason
  }
  if (draft.note === undefined) delete next.note
  if (draft.workspaceId === undefined) delete next.workspaceId
  next.nextRunAt = computeNextRun(next, { now })
  return next
}

/** The next fire time of a record, or undefined when it is off or manual-only. */
export function computeNextRun(record, options) {
  if (record === null || typeof record !== 'object') return undefined
  if (record.enabled !== true) return undefined
  return nextFireAt(record.schedule, {
    now: options.now,
    // Interval phase is anchored on the last run so "每 30 分钟" means 30 minutes
    // after the previous one, not 30 minutes after an arbitrary epoch.
    anchorMs: record.lastRunAt ?? record.createdAt ?? options.now,
  })
}

/**
 * How late a slot may be and still count as "now". Anything later was missed
 * while the host was not running, which is a different event: the user decides
 * per automation whether a missed slot is caught up or dropped.
 */
export const MISSED_GRACE_MS = 5 * 60_000

/**
 * The automations whose slot has come, newest slot last. Pure selection over a
 * ledger snapshot — the engine owns what to DO with each entry.
 *
 * @returns [{ id, scheduledFor, missed }] where `missed` marks a slot that came
 *   due while the host was down.
 */
export function dueAutomations(ledger, options) {
  const now = options.now
  if (ledger?.settings?.enabled === false) return []
  const out = []
  for (const record of Object.values(ledger?.automations ?? {})) {
    if (record.enabled !== true) continue
    const slot = record.nextRunAt
    if (!Number.isFinite(slot) || slot > now) continue
    out.push({ id: record.id, scheduledFor: slot, missed: now - slot > MISSED_GRACE_MS })
  }
  return out.sort((left, right) => left.scheduledFor - right.scheduledFor)
}

/** A fresh run record in the `running` state. */
export function createRun(automation, options) {
  const run = {
    id: options.id ?? makeId('run', options.random),
    automationId: automation.id,
    automationName: automation.name,
    status: 'running',
    trigger: RUN_TRIGGERS.includes(options.trigger) ? options.trigger : 'manual',
    action: automation.action.kind,
    startedAt: options.now,
    createdAt: options.now,
  }
  if (Number.isFinite(options.scheduledFor)) run.scheduledFor = options.scheduledFor
  if (automation.workspaceId !== undefined) run.workspaceId = automation.workspaceId
  if (options.cwd !== undefined) run.cwd = options.cwd
  return run
}

/** A run that never started, recorded so the reason is visible in the history. */
export function createSkippedRun(automation, options) {
  const run = createRun(automation, options)
  run.status = 'skipped'
  run.finishedAt = options.now
  run.durationMs = 0
  run.error = options.reason
  delete run.startedAt
  return run
}

/**
 * Fold a terminal outcome onto a `running` run. Returns the settled record, or
 * undefined when the run is already terminal — settling twice must be a no-op,
 * because the child's exit and the timeout can race.
 */
export function settleRun(run, outcome) {
  if (run === undefined || run.status !== 'running') return undefined
  if (!TERMINAL_RUN_STATUSES.includes(outcome.status)) {
    throw new AutomationError(ERR.invalidInput, `未知的结束状态：${outcome.status}`)
  }
  const settled = { ...run, status: outcome.status, finishedAt: outcome.now }
  settled.durationMs = Math.max(0, outcome.now - (run.startedAt ?? outcome.now))
  if (Number.isFinite(outcome.exitCode)) settled.exitCode = outcome.exitCode
  const output = tailCap(outcome.output, MAX_OUTPUT_CHARS)
  if (output !== undefined) settled.output = output
  const error = tailCap(outcome.error, MAX_ERROR_CHARS)
  if (error !== undefined) settled.error = error
  if (typeof outcome.sessionId === 'string' && outcome.sessionId.length > 0) settled.sessionId = outcome.sessionId
  if (typeof outcome.taskId === 'string' && outcome.taskId.length > 0) settled.taskId = outcome.taskId
  return settled
}

/**
 * Fold a settled run back onto its automation: the denormalized "last run"
 * fields the list row reads, the counters, and the failure streak that parks a
 * job which keeps failing. Returns a new record; never mutates.
 */
export function applyRunOutcome(record, run, options) {
  const next = { ...record, lastRunAt: run.startedAt ?? run.createdAt, lastStatus: run.status }
  if (run.status === 'skipped') return next
  next.runCount = (record.runCount ?? 0) + 1
  const failed = run.status !== 'succeeded'
  next.failureCount = (record.failureCount ?? 0) + (failed ? 1 : 0)
  next.consecutiveFailures = failed ? (record.consecutiveFailures ?? 0) + 1 : 0
  const limit = options?.autoDisableAfterFailures ?? 0
  if (limit > 0 && next.consecutiveFailures >= limit) {
    next.enabled = false
    next.pausedReason = `连续失败 ${next.consecutiveFailures} 次，已自动暂停`
  }
  next.nextRunAt = computeNextRun(next, { now: options?.now ?? run.finishedAt ?? Date.now() })
  return next
}

// ---------------------------------------------------------------------- runs

/** One automation's runs, newest first. */
export function runsFor(ledger, automationId, limit) {
  const rows = Object.values(ledger?.runs ?? {})
    .filter((run) => run.automationId === automationId)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  return Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows
}

/**
 * Drop old runs, keeping the newest `keep` per automation and everything still
 * `running`. A running row is never pruned: it is the only handle on a live
 * child, and losing it would strand the process.
 */
export function pruneRuns(ledger, keep) {
  const byAutomation = new Map()
  for (const run of Object.values(ledger.runs ?? {})) {
    if (!byAutomation.has(run.automationId)) byAutomation.set(run.automationId, [])
    byAutomation.get(run.automationId).push(run)
  }
  let removed = 0
  for (const rows of byAutomation.values()) {
    rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    let kept = 0
    for (const run of rows) {
      if (run.status === 'running') continue
      kept += 1
      if (kept > keep) {
        delete ledger.runs[run.id]
        removed += 1
      }
    }
  }
  return removed
}

/** Forget an automation's runs along with it. */
export function dropRunsOf(ledger, automationId) {
  let removed = 0
  for (const run of Object.values(ledger.runs ?? {})) {
    if (run.automationId !== automationId) continue
    delete ledger.runs[run.id]
    removed += 1
  }
  return removed
}

// ------------------------------------------------------------- load guards

/**
 * Whether a parsed automation row is worth keeping. A row the user hand-edited
 * into nonsense is dropped one by one on load rather than failing the whole
 * ledger — losing one job is recoverable, refusing to boot the scheduler is not.
 */
export function isPlausibleAutomation(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || row.id.length === 0) return false
  if (typeof row.name !== 'string' || row.name.length === 0) return false
  if (typeof row.prompt !== 'string' || row.prompt.length === 0) return false
  if (row.schedule === null || typeof row.schedule !== 'object') return false
  if (!SCHEDULE_KINDS.includes(row.schedule.kind)) return false
  if (row.schedule.kind === 'cron' && !isValidCron(row.schedule.cron)) return false
  if (row.action === null || typeof row.action !== 'object') return false
  if (!ACTION_KINDS.includes(row.action.kind)) return false
  return Number.isFinite(row.createdAt)
}

/** Whether a parsed run row is worth keeping. */
export function isPlausibleRun(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || row.id.length === 0) return false
  if (typeof row.automationId !== 'string' || row.automationId.length === 0) return false
  if (!RUN_STATUSES.includes(row.status)) return false
  return Number.isFinite(row.createdAt)
}

/**
 * A `running` run loaded from disk cannot be live: the child belonged to a
 * process that is gone. Recording it as interrupted is the only honest outcome —
 * it must never be reported as success, and it must never be silently re-run.
 */
export function reviveInterruptedRun(run, now) {
  return {
    ...run,
    status: 'failed',
    finishedAt: now,
    durationMs: Math.max(0, now - (run.startedAt ?? now)),
    error: '宿主进程重启，这次运行被中断',
  }
}

// ------------------------------------------------------------------ delivery

/**
 * The text one headless run submits. The standing preamble is prepended HERE,
 * not in the browser, so an unattended run always carries it in the same place
 * and a caller cannot forget it.
 */
export function composePrompt(automation, settings) {
  const preamble = automation.usePreamble === false ? undefined : normalizeText(settings?.preamble, '前置说明', MAX_PREAMBLE_CHARS)
  const body = automation.prompt
  return preamble === undefined ? body : `${preamble}\n\n---\n\n${body}`
}

/** The title one task-board card gets: the automation's name plus its slot. */
export function taskTitle(automation, now, cap = 200) {
  const stamp = formatStamp(now)
  const suffix = ` · ${stamp}`
  const room = Math.max(1, cap - suffix.length)
  const name = automation.name.length > room ? `${automation.name.slice(0, room - 1)}…` : automation.name
  return `${name}${suffix}`
}

// ---------------------------------------------------------------- projection

/**
 * The wire form of one automation: the record plus the derived text the browser
 * would otherwise need its own cron implementation to produce. There is exactly
 * ONE schedule implementation in this plugin, and it lives on the host.
 */
export function decorateAutomation(record) {
  return {
    ...record,
    scheduleText: describeSchedule(record.schedule),
  }
}

/** Every automation, ordered the way the list shows them. */
export function listAutomations(ledger) {
  return Object.values(ledger?.automations ?? {})
    .map(decorateAutomation)
    .sort((left, right) => {
      // Armed jobs first, then by how soon they fire, then newest first.
      const leftNext = left.enabled && Number.isFinite(left.nextRunAt) ? left.nextRunAt : Infinity
      const rightNext = right.enabled && Number.isFinite(right.nextRunAt) ? right.nextRunAt : Infinity
      if (leftNext !== rightNext) return leftNext - rightNext
      return (right.createdAt ?? 0) - (left.createdAt ?? 0)
    })
}

export {
  describeCron,
  describeInterval,
  describeSchedule,
  formatStamp,
  isValidCron,
  nextCronTimes,
  nextIntervalTime,
} from './cron.js'
