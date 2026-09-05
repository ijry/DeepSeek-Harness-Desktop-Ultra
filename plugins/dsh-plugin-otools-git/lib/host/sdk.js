/**
 * Self-contained replacement for the one @deepseek-ai runtime import a host
 * plugin would otherwise take from an SDK package (dsh-home-paths). A published
 * dsh plugin must never resolve @deepseek-ai/* packages from the profile's
 * node_modules at runtime (an npm-mirror copy shadows the CLI-internal build and
 * can break the agent loop), so this file re-implements the one behavior needed:
 *
 * - dshHomePath() mirrors join(resolve(DSH_HOME ?? ~/.dsh), ...segments)
 *
 * The same rule is why host/ai.js hand-builds its LLM request instead of
 * importing `BlockAssembler` and `createUserMessage` from @deepseek-ai/dsh-llm.
 *
 * There is no defineTool() here on purpose: this plugin contributes a panel, not
 * agent tools — a Git GUI should not change how the agent behaves.
 *
 * @module dsh-plugin-otools-git/host/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides ~/.dsh). */
export function dshHomePath(...segments) {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}
