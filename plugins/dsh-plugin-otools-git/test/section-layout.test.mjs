/**
 * 工作区 sections 布局守卫。
 *
 * 回归背景：.dsh-og-status-sections 是固定高的滚动容器（flex 列 + overflow），
 * .dsh-og-section 若允许收缩（默认 flex-shrink:1 + min-height:0），大仓库里
 * 未暂存区会被压扁，其行溢出画进未跟踪区，两列表交错呈现「两行一对」的样式
 * 异常。必须保持 flex:none。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('status sections must not be flex-shrinkable', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const styles = await readFile(`${root}/src/client/styles.js`, 'utf8')
  const rule = styles.match(/\.dsh-og-section \{[^}]*\}/)
  assert.ok(rule !== null, '找不到 .dsh-og-section 规则')
  assert.match(rule[0], /flex:\s*none/, '.dsh-og-section 必须是 flex:none，否则大仓库下 sections 会被压缩、行溢出交错')
  assert.doesNotMatch(rule[0], /min-height:\s*0/, '.dsh-og-section 不应带 min-height:0（那是允许收缩的写法）')
})
