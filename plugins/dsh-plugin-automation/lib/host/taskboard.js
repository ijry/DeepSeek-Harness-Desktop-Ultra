/**
 * Bridge to the sibling dsh-plugin-taskboard, over its own HTTP API.
 *
 * Why HTTP and not a direct call: cordis plugins meet through injected services,
 * and the task board deliberately registers none — its ledger is a closure-local
 * `const` inside `apply`. Its JSON routes are the only public face it has, and
 * using them means this plugin needs no change to the task board and no shared
 * build. If the board is not installed the routes 404 and a `taskboard` delivery
 * fails with exactly that reason.
 *
 * Why the base URL is resolved differently from the repopanel plugin's copy: a
 * scheduled firing has no incoming request to read a `Host` header from — it
 * happens at 03:00 with no browser open. The webserver service knows its own bound
 * port, so that is the primary source; the last loopback `Host` header seen is
 * kept only as a fallback for a dsh whose webServer does not expose it.
 *
 * @module dsh-plugin-automation/host/taskboard
 */
import { AutomationError, ERR, taskTitle } from '../shared/protocol.js'

/** The sibling plugin's route prefix. */
export const TASKBOARD_PREFIX = '/dsh-plugin-taskboard'

/** Escape hatch for deployments where neither source works. */
export const BASE_ENV = 'DSH_PLUGIN_AUTOMATION_TASKBOARD_BASE'

/** Patience for a same-origin call to a plugin in this very process. */
const TIMEOUT_MS = 10_000

/** Loopback hosts, with or without a port. */
const LOOPBACK_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i

/**
 * The board's own prompt cap, mirrored rather than imported (the sibling plugin's
 * protocol module is not a dependency of this one). A composed prompt can exceed
 * it once the standing preamble is prepended, and having the whole delivery
 * rejected over the preamble would be absurd — so the preamble is what gives way.
 */
export const TASKBOARD_PROMPT_CAP = 20_000

/**
 * A resolver for the base URL the sibling plugin is reachable at, plus the
 * `observe(req)` hook the routes feed request headers into.
 */
export function taskboardBase(options) {
  const env = options?.env ?? process.env
  let seen
  return {
    /** Remember a loopback Host header. Never trusted beyond the regexp. */
    observe(req) {
      const host = req?.headers?.host
      if (typeof host === 'string' && LOOPBACK_RE.test(host)) seen = `http://${host}`
    },
    resolve() {
      const override = env[BASE_ENV]
      if (typeof override === 'string' && override.trim().length > 0) return override.trim().replace(/\/+$/, '')
      // A function, because the webserver may mount after this resolver is built.
      const server = typeof options?.webServer === 'function' ? options.webServer() : options?.webServer
      const port = typeof server?.port === 'number' && server.port > 0 ? server.port : undefined
      if (port !== undefined) {
        // 0.0.0.0 is a bind address, not a destination.
        const host = server.host === '0.0.0.0' ? '127.0.0.1' : (server.host ?? '127.0.0.1')
        return `http://${host}:${port}`
      }
      return seen
    },
  }
}

/** Read the `{ ok }` envelope the task board answers with. */
async function envelope(response, what) {
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new AutomationError(ERR.internal, `任务看板对 ${what} 返回了非 JSON 响应`)
  }
  if (payload?.ok === true) return payload.value
  const detail = payload?.error?.message ?? `HTTP ${response.status}`
  throw new AutomationError(ERR.internal, `任务看板拒绝了 ${what}：${detail}`)
}

/**
 * File one card for an automation firing. Returns the created task record; the
 * caller records its id on the run so the history links to the card.
 *
 * @param spec - { base, automation, prompt, now, fetchImpl? }
 */
export async function fileTaskCard(spec) {
  const base = spec.base
  if (base === undefined) {
    throw new AutomationError(ERR.noTaskboard, '无法确定本机 dsh 的地址，请设置 ' + BASE_ENV)
  }
  const fetchImpl = spec.fetchImpl ?? fetch
  const prompt = spec.prompt.length <= TASKBOARD_PROMPT_CAP ? spec.prompt : spec.automation.prompt
  const body = {
    title: taskTitle(spec.automation, spec.now),
    description: `由自动化「${spec.automation.name}」在计划时间创建`,
    prompt,
  }
  if (spec.automation.workspaceId !== undefined) body.workspaceId = spec.automation.workspaceId
  let response
  try {
    response = await fetchImpl(`${base}${TASKBOARD_PREFIX}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new AutomationError(ERR.noTaskboard, `联系不上任务看板：${error?.message ?? error}`)
  }
  if (response.status === 404) {
    throw new AutomationError(ERR.noTaskboard, '没有装任务看板插件（dsh-plugin-taskboard）')
  }
  return envelope(response, 'POST /tasks')
}
