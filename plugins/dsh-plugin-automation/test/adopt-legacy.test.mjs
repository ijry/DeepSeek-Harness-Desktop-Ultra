/**
 * 数据目录收编（adoptLegacyData）的语义测试。
 *
 * 0.1.x 早期把数据文件直接散在 DSH home 根部；现在的布局是
 * <DSH home>/plugins/dsh-plugin-automation/。收编必须满足三条：
 * 旧有新无 → 搬；新已有 → 绝不动旧数据；两边都没有 → 什么都不发生。
 *
 * @module dsh-plugin-automation/test/adopt-legacy.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adoptLegacyData, dshHomePath, pluginDataPath } from '../src/host/sdk.js'

/** 每个用例独享一个 DSH home。 */
async function isolateHome() {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-auto-adopt-'))
  process.env.DSH_HOME = home
  return async () => {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('旧位置有数据、新位置为空 → 整体搬进插件目录', async () => {
  const cleanup = await isolateHome()
  try {
    const legacy = dshHomePath('dsh-plugin-automation.json')
    await writeFile(legacy, JSON.stringify({ settings: { enabled: true } }), 'utf8')
    adoptLegacyData('dsh-plugin-automation.json', 'ledger.json')
    assert.equal(existsSync(legacy), false, '旧文件应已搬走')
    const moved = JSON.parse(await readFile(pluginDataPath('ledger.json'), 'utf8'))
    assert.equal(moved.settings.enabled, true)
  } finally {
    await cleanup()
  }
})

test('新位置已有数据 → 绝不动旧数据', async () => {
  const cleanup = await isolateHome()
  try {
    await mkdir(pluginDataPath(), { recursive: true })
    await writeFile(dshHomePath('dsh-plugin-automation.json'), '{"from":"legacy"}', 'utf8')
    await writeFile(pluginDataPath('ledger.json'), '{"from":"current"}', 'utf8')
    adoptLegacyData('dsh-plugin-automation.json', 'ledger.json')
    assert.equal(await readFile(pluginDataPath('ledger.json'), 'utf8'), '{"from":"current"}')
    assert.equal(existsSync(dshHomePath('dsh-plugin-automation.json')), true)
  } finally {
    await cleanup()
  }
})

test('两边都没有 → 不创建任何东西', async () => {
  const cleanup = await isolateHome()
  try {
    adoptLegacyData('dsh-plugin-automation.json', 'ledger.json')
    assert.equal(existsSync(pluginDataPath()), false, '不应凭空创建插件目录')
  } finally {
    await cleanup()
  }
})
