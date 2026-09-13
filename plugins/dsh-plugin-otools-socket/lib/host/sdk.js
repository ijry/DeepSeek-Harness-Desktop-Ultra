import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export function dshHomePath(...segments) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...segments)
}

/** This plugin's own data directory: <DSH home>/plugins/dsh-plugin-otools-socket/。 */
export function pluginDataPath(...segments) {
  return dshHomePath('plugins', 'dsh-plugin-otools-socket', ...segments)
}

/**
 * 一次性收编旧布局的数据。
 *
 * 早期版本把数据文件直接散在 DSH home 根部，与 dsh 本体的 sessions/、
 * settings.yaml 等混居。首次遇到「旧位置有数据、新位置还没有」时把旧条目
 * 整体挪进插件目录；目标已存在则绝不动旧数据，留给用户手动处理。只在插件
 * 激活路径上跑一次，量级是几个小文件，所以用同步 IO 换取确定性。
 */
export function adoptLegacyData(legacyRelative, ...target) {
  const from = dshHomePath(legacyRelative)
  const to = pluginDataPath(...target)
  if (!existsSync(from) || existsSync(to)) return
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  } catch (error) {
    console.warn(`[dsh-plugin-otools-socket] 迁移旧数据 ${from} 失败，已跳过:`, error?.message ?? error)
  }
}
