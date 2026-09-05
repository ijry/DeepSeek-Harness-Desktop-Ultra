/**
 * Schedule arithmetic for dsh-plugin-automation: a 5-field cron parser, the
 * next-fire computation, fixed-interval schedules, and a Chinese description of
 * a schedule. Pure — no I/O, no imports, no clock of its own (every entry point
 * takes `now` as a parameter), so every rule here is testable without a
 * scheduler, a disk or a fake timer.
 *
 * Why hand-written: codeg-plus gets this from a Rust cron crate, and a published
 * dsh plugin carries zero runtime dependencies. The dialect implemented is the
 * common Vixie one, which is also what the reference expressions in the template
 * gallery are written in:
 *
 *   minute hour day-of-month month day-of-week
 *   *  a  a-b  a-b/n  * /n  a,b,c   names for month (jan..dec) and dow (sun..sat)
 *
 * Two Vixie behaviours are deliberately kept, because a schedule that silently
 * means something else than the same string does in crontab would be worse than
 * one that refuses to parse:
 *
 * - day-of-month and day-of-week are OR-ed when BOTH are restricted, AND-ed with
 *   the month either way. `0 9 13 * 5` is "the 13th, and every Friday".
 * - `?` is accepted as a synonym of `*` (Quartz spelling) so pasted expressions
 *   from other tools work.
 *
 * Time zone: schedules run in the host's LOCAL time, deliberately. An automation
 * is something a person schedules for their own working day ("每天 09:00"), and
 * the host process is on their machine. The consequence is written down rather
 * than hidden: a local time that does not exist on a spring-forward day is
 * skipped that day, and an ambiguous autumn hour fires on its first occurrence.
 *
 * @module dsh-plugin-automation/shared/cron
 */

/** A schedule string that cannot be parsed. Carries no code — callers wrap it. */
export class CronError extends Error {}

/** Non-standard shorthands, expanded before parsing. */
export const CRON_MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/** How far ahead a next-fire search gives up (a little over four years). */
export const CRON_HORIZON_DAYS = 1500

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Chinese month words, and weekday words in both the standalone and `每周X` form. */
const MONTH_LABELS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月']
const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六']

/** Field definitions in cron order. */
const FIELDS = [
  { key: 'minutes', label: '分钟', min: 0, max: 59 },
  { key: 'hours', label: '小时', min: 0, max: 23 },
  { key: 'doms', label: '日', min: 1, max: 31 },
  { key: 'months', label: '月', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { key: 'dows', label: '星期', min: 0, max: 6, names: DOW_NAMES, nameBase: 0 },
]

/** Two-digit clock component. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Resolve one term of a list: a number, a name, or `*`-relative bound. */
function termValue(text, field) {
  const lowered = text.trim().toLowerCase()
  if (lowered.length === 0) throw new CronError('表达式里有空字段')
  if (field.names !== undefined) {
    const index = field.names.indexOf(lowered.slice(0, 3))
    if (index >= 0 && /^[a-z]+$/.test(lowered)) return index + field.nameBase
  }
  if (!/^\d{1,4}$/.test(lowered)) throw new CronError(`${field.label}字段无法识别：${text.trim()}`)
  const value = Number.parseInt(lowered, 10)
  // Vixie accepts 7 for Sunday; both spellings must mean the same day.
  if (field.key === 'dows' && value === 7) return 0
  if (value < field.min || value > field.max) {
    throw new CronError(`${field.label}字段超出 ${field.min}-${field.max}：${text.trim()}`)
  }
  return value
}

/**
 * One cron field into the sorted list of values it allows, plus whether it
 * restricts anything at all (`*` and `?` do not — that distinction is what the
 * day-of-month / day-of-week OR rule is built on).
 */
export function parseCronField(text, field) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) throw new CronError(`${field.label}字段为空`)
  const restricted = raw !== '*' && raw !== '?'
  const allowed = new Set()
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (piece.length === 0) throw new CronError(`${field.label}字段里有空的列表项`)
    const [rangeText, stepText, ...rest] = piece.split('/')
    if (rest.length > 0) throw new CronError(`${field.label}字段里的步长写了两次：${piece}`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d{1,4}$/.test(stepText.trim())) throw new CronError(`${field.label}字段的步长不是正整数：${piece}`)
      step = Number.parseInt(stepText.trim(), 10)
      if (step < 1) throw new CronError(`${field.label}字段的步长必须 ≥ 1：${piece}`)
    }
    let from = field.min
    let to = field.max
    const range = rangeText.trim()
    if (range !== '*' && range !== '?') {
      const bounds = range.split('-')
      if (bounds.length > 2) throw new CronError(`${field.label}字段的区间写坏了：${piece}`)
      from = termValue(bounds[0], field)
      // `5/15` means "from 5 to the end of the field, every 15" — the same as
      // crontab; a bare `5` with no step is just the single value 5.
      to = bounds.length === 2 ? termValue(bounds[1], field) : (stepText === undefined ? from : field.max)
    }
    if (from <= to) {
      for (let value = from; value <= to; value += step) allowed.add(value)
    } else {
      // A wrapping range (`fri-mon`, `22-2`) walks through the field's end.
      for (let value = from; value <= field.max; value += step) allowed.add(value)
      const carry = (field.max - from + 1) % step
      for (let value = field.min + (carry === 0 ? 0 : step - carry); value <= to; value += step) allowed.add(value)
    }
  }
  if (allowed.size === 0) throw new CronError(`${field.label}字段没有匹配到任何值`)
  return { values: [...allowed].sort((a, b) => a - b), restricted }
}

/**
 * Parse a cron expression into the shape `nextCronTime` walks. Throws
 * {@link CronError} with a Chinese message a form can show verbatim.
 *
 * @param expression - a 5-field expression or one of {@link CRON_MACROS}.
 * @returns { minutes, hours, doms, months, dows, domRestricted, dowRestricted, normalized }
 */
export function parseCron(expression) {
  const text = String(expression ?? '').trim().replace(/\s+/g, ' ')
  if (text.length === 0) throw new CronError('请填写 cron 表达式')
  if (text.length > 200) throw new CronError('cron 表达式过长')
  const expanded = text.startsWith('@')
    ? CRON_MACROS[text.toLowerCase()]
    : text
  if (expanded === undefined) throw new CronError(`不认识的简写：${text}`)
  const parts = expanded.split(' ')
  if (parts.length !== 5) throw new CronError(`cron 需要 5 个字段（分 时 日 月 周），收到 ${parts.length} 个`)
  const spec = { normalized: expanded }
  FIELDS.forEach((field, index) => {
    const parsed = parseCronField(parts[index], field)
    spec[field.key] = parsed.values
    if (field.key === 'doms') spec.domRestricted = parsed.restricted
    if (field.key === 'dows') spec.dowRestricted = parsed.restricted
  })
  return spec
}

/** Whether a cron expression parses. Never throws. */
export function isValidCron(expression) {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a calendar day satisfies the month/day fields. The OR between
 * day-of-month and day-of-week when both are restricted is the Vixie rule.
 */
function matchesDate(spec, date) {
  if (!spec.months.includes(date.getMonth() + 1)) return false
  const domHit = spec.doms.includes(date.getDate())
  const dowHit = spec.dows.includes(date.getDay())
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit
  if (spec.domRestricted) return domHit
  if (spec.dowRestricted) return dowHit
  return true
}

/**
 * The first minute strictly after `fromMs` that the expression matches, in local
 * time, or undefined when nothing matches inside {@link CRON_HORIZON_DAYS}
 * (`0 0 30 2 *` — February 30th — is the honest example).
 *
 * Candidates are minute-aligned: seconds and milliseconds of `fromMs` are
 * discarded, so a tick that runs at 09:00:03 still sees the 09:00 slot as past.
 *
 * @param expression - a cron string or an already-parsed spec.
 * @param fromMs - exclusive lower bound, epoch milliseconds.
 */
export function nextCronTime(expression, fromMs) {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression
  if (!Number.isFinite(fromMs)) throw new CronError('起始时间必须是毫秒时间戳')
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  let cursor = new Date(start)
  for (let day = 0; day <= CRON_HORIZON_DAYS; day += 1) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const date = cursor.getDate()
    if (matchesDate(spec, cursor)) {
      for (const hour of spec.hours) {
        if (hour < cursor.getHours()) continue
        const minuteFloor = hour === cursor.getHours() ? cursor.getMinutes() : 0
        for (const minute of spec.minutes) {
          if (minute < minuteFloor) continue
          const at = new Date(year, month, date, hour, minute, 0, 0)
          // A local wall-clock time that does not exist (spring-forward gap) is
          // normalized by the Date constructor into a different hour; skip it
          // rather than firing at a time the user did not ask for.
          if (at.getHours() !== hour || at.getMinutes() !== minute || at.getDate() !== date) continue
          if (at.getTime() >= start) return at.getTime()
        }
      }
    }
    cursor = new Date(year, month, date + 1, 0, 0, 0, 0)
  }
  return undefined
}

/** The next `count` fire times, for the preview strip under a cron field. */
export function nextCronTimes(expression, fromMs, count) {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression
  const wanted = Number.isInteger(count) && count > 0 ? Math.min(count, 20) : 5
  const out = []
  let cursor = fromMs
  for (let index = 0; index < wanted; index += 1) {
    const at = nextCronTime(spec, cursor)
    if (at === undefined) break
    out.push(at)
    cursor = at
  }
  return out
}

/** Minutes an interval schedule may be set to, and the default the form starts on. */
export const INTERVAL_CHOICES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
export const DEFAULT_INTERVAL_MINUTES = 60
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 60 * 24 * 30

/**
 * The first `anchor + k * step` strictly after `fromMs`. Anchoring (rather than
 * "now + step") keeps the phase stable across restarts, so "每 15 分钟" keeps
 * landing on the same quarter-hours instead of drifting a little on every boot.
 */
export function nextIntervalTime(anchorMs, minutes, fromMs) {
  const step = Math.round(minutes) * 60_000
  if (!Number.isFinite(step) || step <= 0) throw new CronError('间隔必须是正整数分钟')
  const anchor = Number.isFinite(anchorMs) ? anchorMs : fromMs
  if (anchor > fromMs) return anchor
  const elapsed = fromMs - anchor
  return anchor + (Math.floor(elapsed / step) + 1) * step
}

/**
 * The next fire time of any schedule, or undefined for one that never fires on
 * its own (`manual`, or an unparseable cron — an invalid expression must not
 * take the whole tick down).
 *
 * @param schedule - { kind, cron?, intervalMinutes? }
 * @param options - { now, anchorMs }: the clock, and the interval phase anchor
 *   (the automation's last run, falling back to its creation time).
 */
export function nextFireAt(schedule, options) {
  const now = options?.now ?? Date.now()
  if (schedule === null || typeof schedule !== 'object') return undefined
  if (schedule.kind === 'cron') {
    try {
      return nextCronTime(schedule.cron, now)
    } catch {
      return undefined
    }
  }
  if (schedule.kind === 'interval') {
    try {
      return nextIntervalTime(options?.anchorMs ?? now, schedule.intervalMinutes, now)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The step of a field that is exactly `min, min+step, …` up to its own end, or
 * undefined when the values are an arbitrary list. This is what turns `* /15`
 * back into "每 15 分钟" instead of listing four minutes.
 */
function uniformStep(values, min, max) {
  if (values.length < 2 || values[0] !== min) return undefined
  const step = values[1] - values[0]
  if (step <= 0) return undefined
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) return undefined
  }
  // The last value must be the last one that fits, otherwise this is a range
  // (`0-30/15`), not a whole-field step.
  return values[values.length - 1] + step > max ? step : undefined
}

/** `HH:MM`, `HH:MM、HH:MM`, capped so a 24-entry list stays readable. */
function clockList(hours, minutes) {
  const stamps = []
  for (const hour of hours) {
    for (const minute of minutes) {
      stamps.push(`${pad2(hour)}:${pad2(minute)}`)
      if (stamps.length > 4) return `${stamps.slice(0, 4).join('、')} 等 ${hours.length * minutes.length} 个时间点`
    }
  }
  return stamps.join('、')
}

/** The "when in the day" half of a description. */
function timeText(spec) {
  const minuteStep = uniformStep(spec.minutes, 0, 59)
  const everyHour = spec.hours.length === 24
  if (spec.minutes.length === 60 && everyHour) return '每分钟'
  if (minuteStep !== undefined && everyHour) return `每 ${minuteStep} 分钟`
  if (spec.minutes.length === 1 && everyHour) return `每小时的第 ${spec.minutes[0]} 分钟`
  const hourStep = uniformStep(spec.hours, 0, 23)
  if (hourStep !== undefined && hourStep > 1 && spec.minutes.length === 1) {
    return spec.minutes[0] === 0 ? `每 ${hourStep} 小时` : `每 ${hourStep} 小时的第 ${spec.minutes[0]} 分钟`
  }
  if (minuteStep !== undefined) return `${hourText(spec.hours)}内每 ${minuteStep} 分钟`
  return clockList(spec.hours, spec.minutes)
}

/** `9-17 点` for a contiguous run of hours, `9、13 点` for a list. */
function hourText(hours) {
  if (hours.length === 1) return `${hours[0]} 点`
  const contiguous = hours.every((hour, index) => index === 0 || hour - hours[index - 1] === 1)
  if (contiguous) return `${hours[0]}-${hours[hours.length - 1]} 点`
  if (hours.length > 6) return `${hours.slice(0, 6).join('、')} 等 ${hours.length} 个小时`
  return `${hours.join('、')} 点`
}

/**
 * A weekday set as Chinese prose: the two sets people actually schedule by get
 * their own words, a contiguous run becomes a range, everything else is a list.
 */
function dowText(dows) {
  const key = dows.join(',')
  if (key === '1,2,3,4,5') return '每个工作日'
  if (key === '0,6') return '每周末'
  if (dows.length === 7) return '每天'
  if (dows.length > 1 && dows.every((dow, index) => index === 0 || dow - dows[index - 1] === 1)) {
    return `每周${DOW_SHORT[dows[0]]}至${DOW_LABELS[dows[dows.length - 1]]}`
  }
  return `每${dows.map((dow) => DOW_LABELS[dow]).join('、')}`
}

/** The "which days" half of a description; "每天" when nothing is restricted. */
function dateText(spec) {
  let months
  if (spec.months.length !== 12) {
    months = spec.months.length > 4
      ? `${spec.months.slice(0, 4).map((month) => MONTH_LABELS[month - 1]).join('、')} 等 ${spec.months.length} 个月`
      : spec.months.map((month) => MONTH_LABELS[month - 1]).join('、')
  }
  let doms
  if (spec.domRestricted) {
    const list = spec.doms.length > 6
      ? `${spec.doms.slice(0, 6).join('、')} 等 ${spec.doms.length} 天`
      : spec.doms.join('、')
    // "每月 13 日" reads wrong once a month is named — then it is "1 月 13 日".
    doms = months === undefined ? `每月 ${list} 日` : `${months} ${list} 日`
  }
  const dows = spec.dowRestricted ? dowText(spec.dows) : undefined
  if (doms !== undefined && dows !== undefined) return `${doms}或${dows}`
  if (doms !== undefined) return doms
  if (dows !== undefined) return months === undefined ? dows : `${months}${dows}`
  return months === undefined ? '每天' : `${months}每天`
}

/**
 * A cron expression as Chinese prose ("每天 09:00", "每周一、周四 18:30",
 * "每 15 分钟"). An expression that does not parse is returned verbatim — the
 * caller is showing it next to the field the user is typing in.
 */
export function describeCron(expression) {
  let spec
  try {
    spec = parseCron(expression)
  } catch {
    return String(expression ?? '')
  }
  const time = timeText(spec)
  // A sub-hour or per-hour cadence is continuous: prefixing it with "每天" would
  // be noise, unless the days really are restricted.
  const continuous = time.startsWith('每分钟') || time.startsWith('每 ') ||
    time.startsWith('每小时') || time.includes('内每 ')
  const date = dateText(spec)
  if (continuous && date === '每天') return time
  return `${date} ${time}`
}

/** An interval in minutes as Chinese prose ("每 30 分钟", "每 2 小时", "每天"). */
export function describeInterval(minutes) {
  const value = Math.round(Number(minutes))
  if (!Number.isFinite(value) || value <= 0) return '间隔无效'
  if (value % 1440 === 0) return value === 1440 ? '每天一次' : `每 ${value / 1440} 天`
  if (value % 60 === 0) return value === 60 ? '每小时' : `每 ${value / 60} 小时`
  return `每 ${value} 分钟`
}

/** Any schedule as Chinese prose, for the list row and the editor preview. */
export function describeSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object') return '未设置'
  if (schedule.kind === 'manual') return '仅手动触发'
  if (schedule.kind === 'interval') return describeInterval(schedule.intervalMinutes)
  if (schedule.kind === 'cron') return describeCron(schedule.cron)
  return '未设置'
}

/** `2026-09-05 09:00`, in local time — the only stamp format the UI shows. */
export function formatStamp(ms) {
  if (!Number.isFinite(ms)) return ''
  const at = new Date(ms)
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ` +
    `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}
