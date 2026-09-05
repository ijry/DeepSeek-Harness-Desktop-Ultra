/**
 * 剧场层是这个插件的伪装本体，它必须**可重放**：同一章重开一次，工具调用不能
 * 换一批 —— 否则读者一眼看出这是编的，而且续读时前后文会对不上。
 *
 * 另外钉住工具名与结果串：它们是 dsh 真实工具的原话（read/edit/bash/grep/glob/
 * todo_write、`(End of file - total N lines)` …）。伪装的全部价值就在这儿，
 * 一旦有人把它们改成好看但假的字样，这些断言要红。
 *
 * @module dsh-plugin-longread/test/theater
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FALLBACK_FILES, groupTurns, hashString, makeRandom, planChapter } from '../src/shared/theater.js'
import { defaultSettings } from '../src/shared/protocol.js'

const PARAGRAPHS = Array.from({ length: 24 }, (_unused, i) => `第 ${i} 段。`.repeat(14))
const FILES = ['src/a/one.ts', 'src/b/two.rs', 'docs/readme.md', 'tests/x.spec.ts']

function plan(overrides) {
  return planChapter({
    bookId: 'bk_test',
    bookTitle: '测试书',
    chapterIndex: 1,
    chapterTitle: '第二章 测试',
    paragraphs: PARAGRAPHS,
    settings: { ...defaultSettings(), ...(overrides ?? {}) },
    files: FILES,
  })
}

test('同样的输入产生逐字节相同的计划', () => {
  assert.deepEqual(plan(), plan())
})

test('换一章就换一套伪装（种子里带章号）', () => {
  const first = planChapter({
    bookId: 'bk_test', chapterIndex: 0, chapterTitle: 'a', paragraphs: PARAGRAPHS,
    settings: defaultSettings(), files: FILES,
  })
  const second = planChapter({
    bookId: 'bk_test', chapterIndex: 1, chapterTitle: 'b', paragraphs: PARAGRAPHS,
    settings: defaultSettings(), files: FILES,
  })
  assert.notDeepEqual(first.turns[0].calls, second.turns[0].calls)
})

test('段落被原样搬进各轮，不切段、不丢段、不改字', () => {
  const result = plan()
  const flat = result.turns.flatMap((turn) => turn.paragraphs)
  assert.deepEqual(flat, PARAGRAPHS)
  for (const turn of result.turns) {
    assert.equal(turn.chars, turn.paragraphs.reduce((sum, p) => sum + p.length, 0))
  }
})

test('每轮字数大致按 turnChars 走，且段落数有上限', () => {
  const groups = groupTurns(PARAGRAPHS, 200)
  assert.ok(groups.length > 1)
  for (const group of groups) assert.ok(group.length <= 6, '一轮最多 6 段')
  const wide = groupTurns(PARAGRAPHS, 2400)
  assert.ok(wide.length < groups.length, 'turnChars 越大轮数越少')
})

test('工具密度 off 时一条工具调用都没有，也没有思考块', () => {
  const result = plan({ toolDensity: 'off' })
  for (const turn of result.turns) {
    assert.deepEqual(turn.calls, [])
    assert.equal(turn.thinking, null)
  }
})

test('showThinking 关掉就没有思考块，但工具调用还在', () => {
  const result = plan({ showThinking: false, toolDensity: 'high' })
  assert.ok(result.turns.some((turn) => turn.calls.length > 0))
  for (const turn of result.turns) assert.equal(turn.thinking, null)
})

const REAL_TOOL_NAMES = new Set(['read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo_write'])

test('工具名只用 dsh 真实存在的那几个', () => {
  for (const persona of ['refactor', 'debug', 'review', 'docs']) {
    for (const turn of plan({ persona, toolDensity: 'high' }).turns) {
      for (const call of turn.calls) {
        assert.ok(REAL_TOOL_NAMES.has(call.name), '不认识的工具名：' + call.name)
        assert.equal(typeof call.id, 'string')
        assert.ok(call.ms > 0)
        assert.equal(typeof call.result, 'string')
        assert.ok(Array.isArray(call.resultLines))
      }
    }
  }
})

test('结果串是 dsh 工具的原话', () => {
  const results = []
  for (const chapterIndex of [0, 1, 2, 3, 4, 5]) {
    const result = planChapter({
      bookId: 'bk_real', chapterIndex, chapterTitle: 'x', paragraphs: PARAGRAPHS,
      settings: { ...defaultSettings(), toolDensity: 'high' }, files: FILES,
    })
    for (const turn of result.turns) for (const call of turn.calls) results.push(call.name + '|' + call.result)
  }
  const has = (needle) => results.some((line) => line.includes(needle))
  assert.ok(has('(End of file - total ') || has('Use offset='), 'read 的分页脚注')
  assert.ok(has('has been updated successfully.') || has('Created file') || has('Updated file'), 'edit/write 的回执')
  assert.ok(has('Updated todo list: ') || has('退出码 0') || has('No matches found') || has('处匹配'), '其余工具的回执')
})

test('工具调用引用的是给进来的真实路径，不是内置兜底表', () => {
  const pool = new Set(FILES)
  for (const turn of plan({ toolDensity: 'high' }).turns) {
    for (const call of turn.calls) {
      const summary = String(call.summary ?? '')
      if (!summary.includes('/') || summary.includes('*')) continue
      assert.ok(pool.has(summary), summary + ' 不在给定的文件池里')
    }
  }
})

test('没有工作区文件时退回内置路径表，而不是空着', () => {
  const result = planChapter({
    bookId: 'bk_fallback', chapterIndex: 0, chapterTitle: 'x', paragraphs: PARAGRAPHS,
    settings: { ...defaultSettings(), toolDensity: 'high' }, files: [],
  })
  const summaries = result.turns.flatMap((turn) => turn.calls.map((call) => String(call.summary)))
  assert.ok(summaries.some((summary) => FALLBACK_FILES.includes(summary)))
})

test('空章不产生任何轮次', () => {
  const result = planChapter({
    bookId: 'b', chapterIndex: 0, chapterTitle: 'x', paragraphs: [],
    settings: defaultSettings(), files: FILES,
  })
  assert.equal(result.turnCount, 0)
  assert.deepEqual(result.turns, [])
})

test('第一轮的提示词带上文件名，后面的轮次多是短续话', () => {
  const result = plan()
  assert.match(result.turns[0].prompt, /[a-z]+\.(ts|rs|md)/)
  const shorties = result.turns.slice(1).filter((turn) => turn.prompt.length <= 12)
  assert.ok(shorties.length > 0, '后续轮次应该多是「继续」这类短句')
  assert.equal(result.persona, '重构')
})

test('PRNG 与散列固定住：改了它们就等于改了所有人的伪装', () => {
  assert.equal(hashString('dsh-plugin-longread'), 3678329573)
  const random = makeRandom(hashString('bk|0|0|refactor'))
  assert.deepEqual(
    [random(), random(), random()].map((value) => Number(value.toFixed(6))),
    [0.851794, 0.475845, 0.167816],
  )
})

