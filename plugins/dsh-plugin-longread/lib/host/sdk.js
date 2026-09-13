/**
 * Self-contained replacement for the one @deepseek-ai runtime helper this
 * plugin would otherwise import. A published dsh plugin must never resolve
 * @deepseek-ai/* from the profile's node_modules at runtime — an npm-mirror copy
 * shadows the CLI-internal build and can break the agent loop — so the behavior
 * is re-implemented here:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 *
 * This plugin registers no tools and contributes no prompt section, so unlike
 * the sibling plugins it needs no defineTool().
 *
 * @module dsh-plugin-longread/host/sdk
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** This plugin's own data directory: <DSH home>/plugins/dsh-plugin-longread/。 */
export function pluginDataPath(...segments) {
  return dshHomePath('plugins', 'dsh-plugin-longread', ...segments)
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
    console.warn(`[dsh-plugin-longread] 迁移旧数据 ${from} 失败，已跳过:`, error?.message ?? error)
  }
}
