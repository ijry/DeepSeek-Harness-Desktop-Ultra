/**
 * 客户端词典 zh / en 键位对齐守卫。
 *
 * `t()` 的兜底是 `return value === undefined ? key : value` —— 缺键不会报错，
 * 而是**把键名当文案直接渲染**（中文界面冒出 "toast.launched"、"detail.launch"
 * 这种原始键）。这类破相只在运行时、只在某一种语言下才看得见，所以在这里静态
 * 比一份 `src/client/index.js` 里的 STRINGS 字面量。
 *
 * 只比较**带引号的扁平键**；嵌套的 column/status 用的是无引号键，两边一致地
 * 被排除在外，不影响结论。
 *
 * @module dsh-plugin-taskboard/test/i18n
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SOURCE = new URL('../src/client/index.js', import.meta.url)

/** 取出一个词典片段里的所有 'a.b' 形式键。 */
function keysOf(segment) {
  const out = []
  const re = /'([A-Za-z][A-Za-z0-9.]*)':/g
  let match
  while ((match = re.exec(segment)) !== null) out.push(match[1])
  return out
}

/** 切出 zh / en 两个词典并返回各自的键。 */
async function dictionaries() {
  const text = await readFile(SOURCE, 'utf8')
  const zhStart = text.indexOf('zh: {')
  const enStart = text.indexOf('en: {')
  assert.ok(zhStart >= 0 && enStart > zhStart, 'STRINGS 里应能找到 zh / en 两个词典')
  const enEnd = text.indexOf('\n    }', enStart)
  return {
    zh: keysOf(text.slice(zhStart, enStart)),
    en: keysOf(text.slice(enStart, enEnd < 0 ? text.length : enEnd)),
  }
}

test('客户端词典：en 与 zh 的键位必须一一对应', async () => {
  const { zh, en } = await dictionaries()
  const zhSet = new Set(zh)
  const enSet = new Set(en)
  assert.deepEqual([...enSet].filter((key) => !zhSet.has(key)), [], 'zh 缺这些键')
  assert.deepEqual([...zhSet].filter((key) => !enSet.has(key)), [], 'en 缺这些键')
})

test('客户端词典：同一语言内不得有重复键（后者会静默覆盖前者）', async () => {
  const { zh, en } = await dictionaries()
  for (const [name, keys] of [['zh', zh], ['en', en]]) {
    const seen = new Set()
    const duplicates = new Set()
    for (const key of keys) {
      if (seen.has(key)) duplicates.add(key)
      seen.add(key)
    }
    assert.deepEqual([...duplicates], [], `${name} 词典有重复键`)
  }
})
