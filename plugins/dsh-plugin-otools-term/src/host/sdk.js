/**
 * Self-contained replacements for the @deepseek-ai runtime imports a host plugin
 * would otherwise take from an SDK package. A published dsh plugin must never
 * resolve @deepseek-ai/* from the profile's node_modules at runtime (an
 * npm-mirror copy shadows the CLI-internal build and can break the agent loop),
 * so this file re-implements the two behaviours needed:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 * - writePrivate() writes a 0600 file, the way the credential stores do
 *
 * The same rule is why host/ai.js hand-builds its LLM request instead of
 * importing `BlockAssembler` and `createUserMessage` from @deepseek-ai/dsh-llm.
 *
 * There is no defineTool() here on purpose: this plugin contributes a panel, not
 * agent tools — the agent should not gain an SSH client because the user opened a
 * terminal.
 *
 * @module dsh-plugin-otools-term/host/sdk
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** This plugin's own data directory: <DSH home>/plugins/dsh-plugin-otools-term/。 */
export function pluginDataPath(...segments) {
  return dshHomePath('plugins', 'dsh-plugin-otools-term', ...segments)
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
    console.warn(`[dsh-plugin-otools-term] 迁移旧数据 ${from} 失败，已跳过:`, error?.message ?? error)
  }
}

/**
 * Write a file only the current user can read, atomically.
 *
 * The mode is applied to the temporary file BEFORE the rename, so the content is
 * never visible through a world-readable inode even briefly. On Windows the mode
 * is a no-op and the file inherits the directory ACL — same caveat every
 * credential store on this platform carries.
 */
export async function writePrivate(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(temp, 0o600)
  } catch { /* Windows, or a filesystem without modes */ }
  await rename(temp, file)
}
