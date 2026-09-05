/**
 * Scheduled backups: the plan ledger, the 30-second scheduler, and the storage
 * estimate the panel draws above the plan list.
 *
 * Three things here are deliberately not the reference's:
 *
 * 1. **The storage panel works on Windows.** The reference read the disk through a
 *    unix-only syscall, so the whole 存储空间 section of the backup centre threw on
 *    every Windows install and the user got an error with nothing to do about it.
 *    `statfs` from node:fs/promises answers the same question on all three
 *    platforms.
 * 2. **A dead run cannot block a plan forever.** The reference skipped any plan
 *    whose last status was Pending or Running. Tasks live in memory only, so a
 *    process that died mid-backup left a plan Running for good: the backup silently
 *    stopped happening and nothing anywhere said so. Here a run whose task no longer
 *    exists — or whose trigger is more than a day old — is treated as dead.
 * 3. **Retention never recurses.** A plan's directory is swept for the two
 *    extensions this plugin writes and nothing else, one level deep. A user is free
 *    to point a plan at their source tree, and a recursive sweep would take their
 *    migrations with it.
 *
 * @module dsh-plugin-otools-dbm/host/backup
 */
import { mkdir, readdir, stat, statfs, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { DbmError, ERR } from '../shared/protocol.js'

import { backupDatabase } from './exporter.js'
import { pluginHomePath } from './sdk.js'
import { messageOf } from './tasks.js'

/** Event name the panel listens for; it replaces its whole plan list from it. */
export const BACKUP_PLANS_EVENT = 'dbm-backup-plans-updated'

/** How often the scheduler looks at the plans. */
const TICK_MS = 30_000

/** Assumed size of one backup while there is no real one to measure. */
const DEFAULT_BACKUP_BYTES = 256 * 1024 * 1024

/** A run still Pending/Running after this long is a corpse, not a backup. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

// -------------------------------------------------------------------- the plans
/** Every saved plan, normalized, newest first. */
export async function getBackupPlans(context) {
  return sortPlans(normalizePlans(await context.plans.list()))
}

/**
 * Replace the plan list.
 *
 * The panel sends its whole list on every edit, so this is also where a plan the
 * panel could not have meant is dropped: without an id it can never be found again,
 * and without a connection it can never be run.
 */
export async function saveBackupPlans(context, plans) {
  const normalized = sortPlans(normalizePlans(plans))
  await context.plans.replaceAll(normalized)
  context.emit(BACKUP_PLANS_EVENT, normalized)
  return normalized
}

/**
 * Run one plan now: the schedule's own path, and the panel's 立即执行 button.
 *
 * Retention runs BEFORE the backup starts. That is the whole point of it — making
 * room for the file about to be written — and a sweep afterwards can only ever
 * delete the backup that just succeeded.
 */
export async function triggerBackupPlan(context, planId) {
  const wanted = String(planId ?? '').trim()
  const plan = (await getBackupPlans(context)).find((item) => item.id === wanted)
  if (plan === undefined) {
    throw new DbmError(ERR.notFound, `备份计划不存在: ${wanted}`)
  }

  const connection = await context.store.require(plan.connectionId)
  const databaseName = plan.databaseName.length > 0 ? plan.databaseName : String(connection.database ?? '').trim()
  const tableNames = await context.connections.with(plan.connectionId, (engine) =>
    engine.listTables(databaseName))
  if (tableNames.length === 0) {
    throw new DbmError(ERR.invalidInput, `数据库 ${databaseName} 里没有可备份的表，备份计划未执行`)
  }

  if (plan.retentionDays > 0 && plan.exportPath.length > 0) {
    await pruneBackups(plan.exportPath, plan.retentionDays)
  }

  const taskId = await backupDatabase(context, {
    connectionId: plan.connectionId,
    databaseName,
    tableNames,
    exportPath: plan.exportPath.length > 0 ? plan.exportPath : undefined,
  })

  await patchPlan(context, plan.id, {
    lastTaskId: taskId,
    lastTriggeredAt: new Date().toISOString(),
    lastRunStatus: 'Pending',
    lastErrorMessage: null,
  })
  return taskId
}

/** Apply a partial change to one plan and broadcast the new list. */
async function patchPlan(context, planId, changes) {
  const plans = normalizePlans(await context.plans.list())
  return saveBackupPlans(
    context,
    plans.map((plan) => (plan.id === planId ? { ...plan, ...changes } : plan)),
  )
}

const normalizePlans = (plans) =>
  (Array.isArray(plans) ? plans : []).map((plan) => normalizePlan(plan)).filter((plan) => plan !== undefined)

/** Newest first, the order the panel's table expects. */
const sortPlans = (plans) =>
  plans.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))

/** One plan as this file will only ever see it, or undefined when it is unusable. */
function normalizePlan(input) {
  const record = input ?? {}
  const id = trimmed(record.id)
  const connectionId = trimmed(record.connectionId)
  if (id.length === 0 || connectionId.length === 0) {
    return undefined
  }
  const createdAt = trimmed(record.createdAt)
  return {
    id,
    name: trimmed(record.name),
    connectionId,
    databaseName: trimmed(record.databaseName),
    exportPath: trimmed(record.exportPath),
    scheduleType: record.scheduleType === 'interval' ? 'interval' : 'daily',
    dailyTime: normalizeDailyTime(record.dailyTime),
    // An interval of 0 hours is a backup loop; a negative retention is a date in the
    // future, which would delete every file in the directory.
    intervalHours: clampInt(record.intervalHours, 24, 1),
    enabled: record.enabled !== false,
    retentionDays: clampInt(record.retentionDays, 0, 0),
    createdAt: createdAt.length > 0 ? createdAt : new Date().toISOString(),
    lastTriggeredAt: optionalText(record.lastTriggeredAt),
    lastTaskId: optionalText(record.lastTaskId),
    lastRunStatus: optionalText(record.lastRunStatus),
    lastSuccessAt: optionalText(record.lastSuccessAt),
    lastErrorMessage: optionalText(record.lastErrorMessage),
  }
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')

const optionalText = (value) => {
  const text = trimmed(value)
  return text.length === 0 ? null : text
}

/** `HH:MM`, or the 02:00 the panel's own form defaults to. */
function normalizeDailyTime(value) {
  const text = trimmed(value)
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(text) ? text : '02:00'
}

function clampInt(value, fallback, minimum) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.trunc(number)) : fallback
}

// ------------------------------------------------------------------ the storage
/**
 * Disk figures and a backup-count estimate for one directory.
 *
 * @param _context - unused; the route passes it to every helper in this file.
 * @param path - the directory the panel's form is pointing at, or nothing for the
 *   plugin's own backup directory.
 */
export async function getBackupStorageInfo(_context, path) {
  const directory = trimmed(path).length > 0 ? resolve(trimmed(path)) : pluginHomePath('backup')
  // Created rather than reported missing: the panel asks about a path its form has
  // only just proposed, and an estimate for a directory that does not exist yet is
  // the estimate the user actually wants.
  await mkdir(directory, { recursive: true })

  let disk
  try {
    disk = await statfs(directory)
  } catch (error) {
    throw new DbmError(ERR.internal, `读取磁盘信息失败: ${messageOf(error)}`)
  }

  const blockSize = Number(disk.bsize) || 0
  const totalBytes = Number(disk.blocks) * blockSize
  const availableBytes = Number(disk.bavail) * blockSize
  const usedBytes = Math.max(0, totalBytes - availableBytes)
  const { count, average } = await sampleBackups(directory)
  const averageBackupBytes = count > 0 && average > 0 ? average : DEFAULT_BACKUP_BYTES

  return {
    path: directory,
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    sampleBackupCount: count,
    averageBackupBytes,
    estimatedBackupCount: Math.max(0, Math.floor(availableBytes / averageBackupBytes)),
  }
}

/** How big this directory's existing .sql backups are, on average. */
async function sampleBackups(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { count: 0, average: 0 }
  }
  let count = 0
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.sql')) {
      continue
    }
    try {
      const info = await stat(join(directory, entry.name))
      count += 1
      total += info.size
    } catch {
      // A file that vanished between the listing and the stat is simply not a sample.
    }
  }
  return { count, average: count > 0 ? Math.round(total / count) : 0 }
}

/**
 * Delete one plan's own expired backups.
 *
 * Only files sitting directly in `directory`, only `.sql` and `.sql.gz`, and never a
 * recursive walk — see the note at the top of this file about a plan pointed at a
 * source tree. A file that cannot be deleted is logged and skipped: retention is
 * housekeeping, and housekeeping must not fail a backup.
 */
async function pruneBackups(directory, retentionDays) {
  const target = resolve(directory)
  const cutoff = Date.now() - retentionDays * DAY_MS
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    // Nothing to prune in a directory the first backup has not created yet.
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !isBackupFile(entry.name)) {
      continue
    }
    const file = join(target, entry.name)
    try {
      const info = await stat(file)
      if (info.mtimeMs >= cutoff) {
        continue
      }
      await unlink(file)
      removed += 1
    } catch (error) {
      console.warn(`[dsh-plugin-otools-dbm] 清理旧备份失败 ${file}:`, messageOf(error))
    }
  }
  return removed
}

function isBackupFile(name) {
  const lower = String(name).toLowerCase()
  return lower.endsWith('.sql') || lower.endsWith('.sql.gz')
}

// ---------------------------------------------------------------- the scheduler
/**
 * The tick behind 每日 HH:MM and 每隔 N 小时.
 *
 * Thirty seconds is short enough that a daily plan fires within half a minute of its
 * time and long enough to cost nothing. The interval is `unref`ed: a plugin nobody is
 * looking at must not be the reason the dsh process refuses to exit.
 */
export class BackupScheduler {
  /** @param context - the route context; needs `plans`, `tasks`, `store`, `emit`. */
  constructor(context) {
    this.context = context
    this.timer = undefined
    this.busy = false
  }

  /** Idempotent: a second call keeps the first interval rather than adding one. */
  start() {
    if (this.timer !== undefined) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  stop() {
    if (this.timer === undefined) {
      return
    }
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** One pass: mirror every plan's status from its task, then fire what is due. */
  async tick() {
    // Passes never overlap. A plan whose engine takes longer than 30 s to connect
    // would otherwise be started twice.
    if (this.busy) {
      return
    }
    this.busy = true
    try {
      const plans = await mirrorTaskStatus(this.context)
      const now = Date.now()
      for (const plan of plans) {
        if (!isDue(this.context, plan, now)) {
          continue
        }
        await this.fire(plan)
      }
    } catch (error) {
      // Anything thrown out of an interval callback would end the scheduler; a bad
      // plan file must not stop the other plans from ever running again.
      console.warn('[dsh-plugin-otools-dbm] 备份调度失败:', messageOf(error))
    } finally {
      this.busy = false
    }
  }

  /** Start one plan, sequentially, recording a refusal on the plan itself. */
  async fire(plan) {
    try {
      // One at a time: every trigger rewrites the plan file, and two concurrent
      // read-modify-writes lose one of the two.
      await triggerBackupPlan(this.context, plan.id)
    } catch (error) {
      // `lastTriggeredAt` moves even on a refusal, so a plan whose server is down
      // reports one failure rather than retrying every thirty seconds all day.
      await patchPlan(this.context, plan.id, {
        lastRunStatus: 'Failed',
        lastTriggeredAt: new Date().toISOString(),
        lastErrorMessage: messageOf(error),
      })
      console.warn(
        `[dsh-plugin-otools-dbm] 备份计划 ${plan.name.length > 0 ? plan.name : plan.id} 触发失败:`,
        messageOf(error),
      )
    }
  }
}

/**
 * Copy each plan's task status onto the plan.
 *
 * This is what lets the panel show 最近成功 / 最近失败 for a backup that ran while
 * nobody had the dialog open — the panel does the same walk when it is open, and the
 * two agree because both read the task record.
 */
async function mirrorTaskStatus(context) {
  const plans = await getBackupPlans(context)
  let changed = false

  const next = plans.map((plan) => {
    if (plan.lastTaskId === null) {
      return plan
    }
    const task = context.tasks?.get?.(plan.lastTaskId)
    if (task === undefined) {
      return plan
    }
    const patch = {}
    if (plan.lastRunStatus !== task.status) {
      patch.lastRunStatus = task.status
    }
    if (task.status === 'Completed' && plan.lastSuccessAt !== task.updated_at) {
      patch.lastSuccessAt = task.updated_at
      patch.lastErrorMessage = null
    }
    if (task.status === 'Failed' && plan.lastErrorMessage !== (task.error_message ?? null)) {
      patch.lastErrorMessage = task.error_message ?? null
    }
    if (Object.keys(patch).length === 0) {
      return plan
    }
    changed = true
    return { ...plan, ...patch }
  })

  return changed ? saveBackupPlans(context, next) : plans
}

/** Whether a plan should be started right now. */
function isDue(context, plan, now) {
  if (!plan.enabled || isStillRunning(context, plan, now)) {
    return false
  }
  // A plan that has never run counts from when it was created, so a 6-hour plan added
  // at noon does not fire the moment it is saved.
  const last = timeOf(plan.lastTriggeredAt) ?? timeOf(plan.createdAt)

  if (plan.scheduleType === 'interval') {
    return last === undefined || now - last >= plan.intervalHours * 60 * 60 * 1000
  }
  const dueAt = dailyDueAt(plan.dailyTime, now)
  if (now < dueAt) {
    return false
  }
  return last === undefined || last < dueAt
}

/**
 * Whether the previous run is still going — and whether that claim can be believed.
 *
 * Tasks are in-memory only, so a Pending/Running status with no task behind it is the
 * record of a process that died mid-backup rather than of a backup in flight. Same for
 * a run that started more than a day ago: that is a hang, and the reference's version
 * of this check is why such a plan never fired again.
 */
function isStillRunning(context, plan, now) {
  if (plan.lastRunStatus !== 'Pending' && plan.lastRunStatus !== 'Running') {
    return false
  }
  const task = plan.lastTaskId === null ? undefined : context.tasks?.get?.(plan.lastTaskId)
  if (task === undefined || (task.status !== 'Pending' && task.status !== 'Running')) {
    return false
  }
  const startedAt = timeOf(plan.lastTriggeredAt)
  return startedAt === undefined || now - startedAt < STALE_RUN_MS
}

/** Today's `HH:MM` as a timestamp. */
function dailyDueAt(dailyTime, now) {
  const [hour, minute] = normalizeDailyTime(dailyTime).split(':')
  const due = new Date(now)
  due.setHours(Number(hour), Number(minute), 0, 0)
  return due.getTime()
}

function timeOf(value) {
  const text = trimmed(value)
  if (text.length === 0) {
    return undefined
  }
  const time = new Date(text).getTime()
  return Number.isFinite(time) ? time : undefined
}
