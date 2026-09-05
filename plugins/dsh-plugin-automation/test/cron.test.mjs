/**
 * Cron tests: the dialect (what parses, what must not), the next-fire walk
 * (including the Vixie day-of-month/day-of-week OR rule and the DST gap), and the
 * Chinese descriptions the list rows show. Pure — a fixed `from` timestamp stands
 * in for the clock.
 *
 * @module dsh-plugin-automation/test/cron
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CronError,
  describeCron,
  describeInterval,
  describeSchedule,
  formatStamp,
  isValidCron,
  nextCronTime,
  nextCronTimes,
  nextFireAt,
  nextIntervalTime,
  parseCron,
} from '../src/shared/cron.js'

/** 2026-09-05 10:17:30 local — a Saturday, deliberately mid-minute. */
const SAT = new Date(2026, 8, 5, 10, 17, 30).getTime()

/** `nextCronTime` as a readable local stamp. */
const at = (expression, from = SAT) => formatStamp(nextCronTime(expression, from))

test('五字段表达式按 crontab 语义解析', () => {
  assert.deepEqual(parseCron('0 9 * * *').hours, [9])
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45])
  assert.deepEqual(parseCron('0 9-11 * * *').hours, [9, 10, 11])
  assert.deepEqual(parseCron('0 0 * * mon,wed').dows, [1, 3])
  assert.deepEqual(parseCron('0 0 1 jan,jul *').months, [1, 7])
  // 7 and 0 are both Sunday.
  assert.deepEqual(parseCron('0 0 * * 7').dows, [0])
  // `?` is the Quartz spelling of `*` and must not restrict anything.
  assert.equal(parseCron('0 0 ? * ?').domRestricted, false)
  // A wrapping range walks through the end of the field.
  assert.deepEqual(parseCron('0 0 * * fri-mon').dows, [0, 1, 5, 6])
  // `5/15` is "from 5 to the end of the field", a bare `5` is just 5.
  assert.deepEqual(parseCron('5/15 * * * *').minutes, [5, 20, 35, 50])
  assert.deepEqual(parseCron('5 * * * *').minutes, [5])
})

test('@ 简写展开为等价表达式', () => {
  assert.equal(parseCron('@daily').normalized, '0 0 * * *')
  assert.equal(parseCron('@weekly').normalized, '0 0 * * 0')
  assert.equal(parseCron('@hourly').normalized, '0 * * * *')
  assert.throws(() => parseCron('@fortnightly'), CronError)
})

test('坏表达式带着能直接显示给用户的中文原因被拒绝', () => {
  const reasons = ['', '0 9 * *', '0 9 * * * *', '61 * * * *', '0 24 * * *',
    '0 9 32 * *', '0 9 * 13 *', '0 9 * * 8', 'a b c d e', '*/0 * * * *', '0 9 5-1-3 * *']
  for (const bad of reasons) {
    assert.equal(isValidCron(bad), false, `应当拒绝：${JSON.stringify(bad)}`)
    assert.throws(() => parseCron(bad), (error) => error instanceof CronError && /[一-龥]/.test(error.message))
  }
})

test('下一次触发严格晚于起点，并且忽略秒', () => {
  assert.equal(at('0 9 * * *'), '2026-09-06 09:00')
  assert.equal(at('*/15 * * * *'), '2026-09-05 10:30')
  // 10:17:30 → the 10:18 slot is still ahead, seconds are not a reason to skip it.
  assert.equal(at('18 10 * * *'), '2026-09-05 10:18')
  // Exactly on the minute counts as past: the slot already fired.
  const onTheMinute = new Date(2026, 8, 5, 10, 18, 0).getTime()
  assert.equal(formatStamp(nextCronTime('18 10 * * *', onTheMinute)), '2026-09-06 10:18')
})

test('日与星期都限定时按 OR 匹配（Vixie 规则）', () => {
  // The 13th, and every Friday: Friday the 11th comes before the 13th.
  assert.deepEqual(nextCronTimes('0 9 13 * 5', SAT, 3).map(formatStamp),
    ['2026-09-11 09:00', '2026-09-13 09:00', '2026-09-18 09:00'])
  // Only the day of month is restricted: Fridays are irrelevant.
  assert.equal(at('0 9 13 * *'), '2026-09-13 09:00')
  // Only the weekday is restricted.
  assert.equal(at('0 9 * * 5'), '2026-09-11 09:00')
})

test('永远不会命中的表达式给出 undefined 而不是死循环', () => {
  assert.equal(nextCronTime('0 0 30 2 *', SAT), undefined)
  assert.deepEqual(nextCronTimes('0 0 30 2 *', SAT, 3), [])
})

test('工作日与月度表达式跨月、跨年推进', () => {
  assert.deepEqual(nextCronTimes('0 9 * * 1-5', SAT, 3).map(formatStamp),
    ['2026-09-07 09:00', '2026-09-08 09:00', '2026-09-09 09:00'])
  assert.deepEqual(nextCronTimes('0 9 1 * *', SAT, 2).map(formatStamp),
    ['2026-10-01 09:00', '2026-11-01 09:00'])
  assert.deepEqual(nextCronTimes('0 0 1 1 *', SAT, 2).map(formatStamp),
    ['2027-01-01 00:00', '2028-01-01 00:00'])
})

test('固定间隔以锚点定相位，重启不会漂移', () => {
  const anchor = new Date(2026, 8, 5, 10, 0, 0).getTime()
  assert.equal(formatStamp(nextIntervalTime(anchor, 15, SAT)), '2026-09-05 10:30')
  // An anchor in the future is itself the next fire.
  assert.equal(nextIntervalTime(SAT + 60_000, 15, SAT), SAT + 60_000)
  assert.throws(() => nextIntervalTime(anchor, 0, SAT), CronError)
})

test('nextFireAt 分派三种触发方式，坏表达式不抛异常', () => {
  assert.equal(formatStamp(nextFireAt({ kind: 'cron', cron: '0 9 * * *' }, { now: SAT })), '2026-09-06 09:00')
  assert.equal(formatStamp(nextFireAt({ kind: 'interval', intervalMinutes: 30 }, { now: SAT, anchorMs: SAT })),
    '2026-09-05 10:47')
  assert.equal(nextFireAt({ kind: 'manual' }, { now: SAT }), undefined)
  // A scheduler must not die on one broken row.
  assert.equal(nextFireAt({ kind: 'cron', cron: 'nonsense' }, { now: SAT }), undefined)
})

test('中文描述覆盖常见形状，无法解析时原样回显', () => {
  assert.equal(describeCron('0 9 * * *'), '每天 09:00')
  assert.equal(describeCron('*/15 * * * *'), '每 15 分钟')
  assert.equal(describeCron('0 */3 * * *'), '每 3 小时')
  assert.equal(describeCron('5 * * * *'), '每小时的第 5 分钟')
  assert.equal(describeCron('0 8 * * 1-5'), '每个工作日 08:00')
  assert.equal(describeCron('0 10 * * 0,6'), '每周末 10:00')
  assert.equal(describeCron('30 18 * * 1,4'), '每周一、周四 18:30')
  assert.equal(describeCron('0 9 * * 2-4'), '每周二至周四 09:00')
  assert.equal(describeCron('0 9 1 * *'), '每月 1 日 09:00')
  assert.equal(describeCron('0 0 1 1 *'), '1 月 1 日 00:00')
  assert.equal(describeCron('0 9 13 * 5'), '每月 13 日或每周五 09:00')
  assert.equal(describeCron('0 9,13,17 * * *'), '每天 09:00、13:00、17:00')
  assert.equal(describeCron('还没写完'), '还没写完')
})

test('间隔与整体描述', () => {
  assert.equal(describeInterval(30), '每 30 分钟')
  assert.equal(describeInterval(60), '每小时')
  assert.equal(describeInterval(180), '每 3 小时')
  assert.equal(describeInterval(1440), '每天一次')
  assert.equal(describeInterval(0), '间隔无效')
  assert.equal(describeSchedule({ kind: 'manual' }), '仅手动触发')
  assert.equal(describeSchedule({ kind: 'interval', intervalMinutes: 45 }), '每 45 分钟')
  assert.equal(describeSchedule({ kind: 'cron', cron: '0 9 * * *' }), '每天 09:00')
  assert.equal(describeSchedule(undefined), '未设置')
})
