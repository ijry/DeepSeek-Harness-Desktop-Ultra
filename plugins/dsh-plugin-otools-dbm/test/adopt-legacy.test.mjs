/**
 * 数据目录收编（adoptLegacyDir）的语义测试。
 *
 * 0.1.x 早期本插件的数据目录直接放在 DSH home 根部；现在的布局是
 * <DSH home>/plugins/dsh-plugin-otools-dbm/。目录收编是逐条搬：
 * 目标已存在的条目绝不动，其余 rename 进来。
 *
 * @module dsh-plugin-otools-dbm/test/adopt-legacy.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adoptLegacyDir, dshHomePath, pluginHomePath } from '../src/host/sdk.js'

/** 每个用例独享一个 DSH home。 */
async function isolateHome() {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-dbm-adopt-'))
  process.env.DSH_HOME = home
  return async () => {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('旧目录的内容逐条搬进插件目录', async () => {
  const cleanup = await isolateHome()
  try {
    const legacy = dshHomePath('dsh-plugin-otools-dbm')
    await mkdir(join(legacy, 'ai-chats'), { recursive: true })
    await writeFile(join(legacy, 'connections.json'), '{"connections":[]}', 'utf8')
    await writeFile(join(legacy, 'ai-chats', 'foo.json'), '{}', 'utf8')
    adoptLegacyDir('dsh-plugin-otools-dbm')
    assert.equal(existsSync(legacy), false, '旧目录应已搬空')
    assert.equal(
      await readFile(pluginHomePath('connections.json'), 'utf8'),
      '{"connections":[]}',
    )
    assert.equal(await readFile(pluginHomePath('ai-chats', 'foo.json'), 'utf8'), '{}')
  } finally {
    await cleanup()
  }
})

test('目标已存在的条目保留现状，不覆盖', async () => {
  const cleanup = await isolateHome()
  try {
    const legacy = dshHomePath('dsh-plugin-otools-dbm')
    await mkdir(legacy, { recursive: true })
    await mkdir(pluginHomePath(), { recursive: true })
    await writeFile(join(legacy, 'connections.json'), '{"from":"legacy"}', 'utf8')
    await writeFile(pluginHomePath('connections.json'), '{"from":"current"}', 'utf8')
    await writeFile(join(legacy, 'sync-logs.json'), '{}', 'utf8')
    adoptLegacyDir('dsh-plugin-otools-dbm')
    assert.equal(
      await readFile(pluginHomePath('connections.json'), 'utf8'),
      '{"from":"current"}',
      '新位置已有的文件绝不被旧数据覆盖',
    )
    assert.equal(existsSync(join(legacy, 'connections.json')), true)
    assert.equal(
      await readFile(pluginHomePath('sync-logs.json'), 'utf8'),
      '{}',
      '新位置没有的条目照常收编',
    )
  } finally {
    await cleanup()
  }
})
