/**
 * 发起会话：把一个看板任务变成一场真实的 DSH 会话。
 *
 * dsh 0.1.5 起，web 组合用 `sessionController` 服务（Remote namespace `session`）
 * 取代了旧的 `apiProxy`：`create(request)` 返回 `{ sessionId, agentPreset? }`，
 * `prompt(request)` 把首条消息排进新会话。这里只开放这两个调用——没有通用
 * invoke，桥面窄到不能再窄。
 *
 * `sessionController` 是可选服务：没有它的组合里，launch 路由会明确报
 * unavailable，而不是让整个插件起不来。
 *
 * @module dsh-plugin-taskboard/host/launcher
 */
import { randomUUID } from 'node:crypto'
import { hostLang } from '../shared/lang.js'

/**
 * Bind the launch surface to one `ctx.sessionController`.
 * @param {object} sessionController - the dsh session-controller service (may be undefined).
 * @returns {object|undefined} `{ createSession, prompt }`, or undefined when the
 *   composition has no sessionController.
 */
export function createLauncher(sessionController) {
  if (sessionController === undefined || sessionController === null) return undefined
  return {
    /** `session.create` — a real session plus its idle agent. */
    async createSession(payload) {
      return sessionController.create(payload)
    },
    /**
     * `session.prompt` — queue the first message into the new session.
     *
     * 两处不可省：
     * - `requestId`：`SessionPromptRequest.requestId` 是必填的会话请求 id，
     *   上游拿它做 `source.rpcId`、去重与附件绑定。缺了它内层会在建消息/绑定时
     *   抛错，被上游包成 `session/agent-busy: prompt rejected`（真正原因藏在
     *   `details.reason` 里）。
     * - `signal`：`SessionController.prompt(request, signal)` 首行即
     *   `signal.throwIfAborted()`，以宿主身份直接调用必须自带未中止的 AbortSignal。
     */
    async prompt(payload) {
      return sessionController.prompt(
        { requestId: randomUUID(), ...payload },
        new AbortController().signal,
      )
    },
  }
}

/**
 * Only a task with no session behind it may launch one. Launching moves the card
 * `todo -> queued` (see the launch route), so `queued` MUST stay out of this list:
 * otherwise a second click would queue a second session onto the same card and two
 * sessions would race to claim it. Recovery stays explicit — move the card back to
 * `todo` (queued -> todo is allowed) and launch again.
 */
export const LAUNCHABLE_STATUSES = ['todo']

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
 * The comment body recording that a DSH session now works on a task. Written by
 * whoever actually created the session (the queue dispatcher for launched
 * cards), so the card's history shows when the wait ended.
 * @param {string} sessionId
 * @param {string} lang - 'zh' | 'en' (host language).
 * @returns {string}
 */
export function launchedComment(sessionId, lang = hostLang()) {
  return lang === 'en'
    ? `Launched DSH session ${sessionId} for this task.`
    : `已发起 DSH 会话执行此任务（session ${sessionId}）。`
}

/**
 * The comment body recording that a task was started and joined the execution
 * queue — 「启动任务」. Written at enqueue time, **before** the dispatcher has
 * decided anything, so it must not claim a session exists. It does say which of
 * the two things happens next, because that is exactly what the user wants to
 * know after clicking 启动: 有空位 = 马上开会话 / 没空位 = 排队等空位。
 * @param {number} active - slots in use at the moment of the click.
 * @param {number} max - settings.maxParallel.
 * @param {string} lang - 'zh' | 'en' (host language).
 * @returns {string}
 */
export function queuedComment(active, max, lang = hostLang()) {
  const waiting = active >= max
  if (lang === 'en') {
    return waiting
      ? `Started; waiting for a free session slot (${active}/${max} in flight).`
      : `Started; launching a DSH session shortly (${active}/${max} in flight).`
  }
  return waiting
    ? `已启动，正在排队等待空位（当前并行 ${active}/${max}）。`
    : `已启动，正在发起 DSH 会话（当前并行 ${active}/${max}）。`
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
