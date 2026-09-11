/**
 * 发起会话：把一个看板任务变成一场真实的 DSH 会话。
 *
 * dsh 的 apiProxy 提供 sessions.create / sessions.prompt（mobile-bridge 验证过
 * 的调用形状）。这里只开放这两个调用——没有通用 invoke，桥面窄到不能再窄，
 * apiProxy 环栏保护的其他方法一概不可达。
 *
 * apiProxy 是可选服务：没有它的 dsh 组合里，launch 路由会明确报 unavailable，
 * 而不是让整个插件起不来（与 mobile-bridge 的嵌套注入策略一致）。
 *
 * @module dsh-plugin-taskboard/host/launcher
 */
import { randomUUID } from 'node:crypto'
import { hostLang } from '../shared/lang.js'

/** Mint one RPC correlation id. dsh requires it on every request envelope. */
function rpcId() {
  return randomUUID()
}

/** Unwrap an RpcResponse; a business failure becomes an Error with dshCode. */
function unwrap(response) {
  const result = response?.result
  if (result?.ok === true) return result.value
  const error = result?.error ?? { code: 'internal', message: 'dsh 未返回结果' }
  const failure = new Error(String(error.message ?? error.code ?? 'internal'))
  failure.dshCode = String(error.code ?? 'internal')
  throw failure
}

/**
 * Bind the launch surface to one `ctx.apiProxy`.
 * @param {object} apiProxy - the dsh apiProxy service (may be undefined).
 * @returns {object|undefined} `{ createSession, prompt }`, or undefined when
 *   the composition has no apiProxy.
 */
export function createLauncher(apiProxy) {
  if (apiProxy === undefined || apiProxy === null) return undefined
  return {
    /** `session.create` — a real session plus its idle agent. */
    async createSession(payload) {
      return unwrap(await apiProxy.sessions.create({ rpcId: rpcId(), payload }))
    },
    /** `session.prompt` — queue the first message into the new session. */
    async prompt(payload) {
      return unwrap(await apiProxy.sessions.prompt({ rpcId: rpcId(), payload }))
    },
  }
}

/** Only untouched work is worth a fresh session. */
export const LAUNCHABLE_STATUSES = ['todo', 'queued']

/**
 * The first message the new session receives: point the agent at the board
 * task, restate the claim discipline, and carry the task's own prompt
 * (falling back to its description) so the session can start immediately.
 *
 * @param {object} task - a live task record.
 * @param {string} lang - 'zh' | 'en' (host language).
 * @returns {string}
 */
export function buildLaunchMessage(task, lang = hostLang()) {
  const zh = lang !== 'en'
  const lines = []
  lines.push(zh
    ? `请处理任务看板中的待办任务：「${task.title}」（${task.id}）。`
    : `Please work on the board task "${task.title}" (${task.id}).`)
  lines.push(zh
    ? '先用 taskboard_get 查看任务详情，再用 taskboard_move 认领（→ preparing），之后按看板协议推进、交验。'
    : 'First inspect it with taskboard_get, claim it with taskboard_move (→ preparing), then follow the board protocol.')
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
  const description = typeof task.description === 'string' ? task.description.trim() : ''
  if (prompt !== '') {
    lines.push('')
    lines.push(zh ? '执行 Prompt：' : 'Prompt:')
    lines.push(prompt)
  } else if (description !== '') {
    lines.push('')
    lines.push(zh ? '任务描述：' : 'Task description:')
    lines.push(description)
  }
  return lines.join('\n')
}

/**
 * Pull the session id out of a sessions.create result. The exact envelope
 * shape is upstream's to change, so every plausible field is tolerated before
 * giving up.
 * @param {unknown} created
 * @returns {string|undefined}
 */
export function sessionIdOf(created) {
  const candidates = [created?.sessionId, created?.id, created?.session?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}
