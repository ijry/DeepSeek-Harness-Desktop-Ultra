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
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
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
