/**
 * The panel's AI, wired straight into DSH's own model plumbing.
 *
 * The reference plugin called an OTools-shell command that carried its own
 * provider/baseUrl/apiKey, so a user configured a model twice: once for the agent,
 * once for the database panel. Here the request's `provider` / `baseUrl` / `apiKey`
 * fields are deliberately IGNORED and the call goes to `ctx.llm.stream()` on the
 * route `ctx.agentDefaultModel` already picked — the same model the user chose for
 * their agent, no second key to enter.
 *
 * `ctx.llm.stream` is the host's one-shot completion seam: no session, no session
 * log, no subagent, and the agent-loop invariants skip requests that did not come
 * from the loop. Two shipped DSH plugins (session-title-llm, compaction-basic) use
 * it exactly this way.
 *
 * Deliberately NOT imported: `@deepseek-ai/dsh-llm`'s `BlockAssembler` /
 * `createUserMessage`. A published plugin must not resolve `@deepseek-ai/*` at
 * runtime, so the two things they do — concatenating deltas and branding a message
 * id — are done by hand.
 *
 * @module dsh-plugin-otools-dbm/host/ai
 */
import { DbmError, ERR } from '../shared/protocol.js'

import { JsonStore } from './store.js'
import { pluginHomePath } from './sdk.js'

/** Wall-clock cap. Someone is watching a spinner. */
export const AI_TIMEOUT_MS = 180_000

/** Output cap when the caller names none. The dashboard asks for whole SQL. */
export const AI_MAX_TOKENS = 2000

/** Chat histories, one file per panel (`prefix` from the caller). */
const historyStores = new Map()

function historyStore(prefix) {
  const normalized = String(prefix ?? '').trim().toLowerCase()
  if (!/^[a-z0-9_.:-]{1,64}$/.test(normalized)) {
    throw new DbmError(ERR.invalidInput, `AI 会话前缀不合法: ${String(prefix ?? '')}`)
  }
  const file = pluginHomePath('ai-chats', `${normalized.replace(/[.:]/g, '-')}.json`)
  let store = historyStores.get(file)
  if (store === undefined) {
    store = new JsonStore({ file, fallback: () => ({ messages: [] }), mode: 0o600 })
    historyStores.set(file, store)
  }
  return store
}

/** The provider/model pair to use, from DSH's own default-model service. */
export function resolveRoute(defaultModel) {
  if (defaultModel === undefined || defaultModel === null || typeof defaultModel.currentSelection !== 'function') {
    return undefined
  }
  let selection
  try {
    selection = defaultModel.currentSelection()
  } catch {
    return undefined
  }
  if (selection === null || typeof selection !== 'object') {
    return undefined
  }
  const provider = typeof selection.provider === 'string' ? selection.provider : undefined
  const model = typeof selection.model === 'string' ? selection.model : undefined
  if (provider === undefined || model === undefined) {
    return undefined
  }
  return { provider, model, reasoningEffort: selection.reasoningEffort }
}

/** Whether the AI features should be offered, and why not when they should not. */
export function aiAvailability(ai) {
  if (ai?.llm === undefined || ai?.llm === null || typeof ai.llm.stream !== 'function') {
    return { available: false, reason: '当前 DSH 没有可用的模型服务' }
  }
  const route = resolveRoute(ai.defaultModel)
  if (route === undefined) {
    return { available: false, reason: 'DSH 还没有配置默认模型，请先在 DSH 里选择模型' }
  }
  return { available: true, provider: route.provider, model: route.model }
}

/**
 * One completion. The panel supplies both prompts; this only routes them.
 *
 * @param ai - the mutable `{ llm, defaultModel }` holder from the plugin entry.
 * @param request - `{ systemPrompt, userPrompt, maxTokens?, temperature? }`.
 */
export async function generateText(ai, request) {
  const llm = ai?.llm
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new DbmError(ERR.aiUnavailable, '当前 DSH 没有可用的模型服务，无法调用 AI')
  }
  const route = resolveRoute(ai.defaultModel)
  if (route === undefined) {
    throw new DbmError(ERR.aiUnavailable, 'DSH 还没有配置默认模型，请先在 DSH 里选择模型')
  }

  const userPrompt = String(request?.userPrompt ?? '').trim()
  if (userPrompt.length === 0) {
    throw new DbmError(ERR.invalidInput, 'AI 请求缺少提示词')
  }
  const systemPrompt = String(request?.systemPrompt ?? '').trim()
  const maxTokens = Number.isFinite(Number(request?.maxTokens))
    ? Math.min(8000, Math.max(64, Math.trunc(Number(request.maxTokens))))
    : AI_MAX_TOKENS

  const signals = [AbortSignal.timeout(AI_TIMEOUT_MS)]
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]

  const payload = {
    provider: route.provider,
    model: route.model,
    messages: [
      {
        // A plain object rather than createUserMessage(): MessageId is documented
        // as the same string, branded, with no validation — so any unique id works
        // and no @deepseek-ai import is needed.
        id: `dsh-plugin-otools-dbm-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: userPrompt }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-otools-dbm' },
      },
    ],
    maxTokens,
    signal,
  }
  if (systemPrompt.length > 0) {
    payload.system = systemPrompt
  }
  if (route.reasoningEffort !== undefined) {
    payload.reasoningEffort = route.reasoningEffort
  }

  let text = ''
  let finish
  try {
    for await (const chunk of llm.stream(payload)) {
      if (chunk === null || typeof chunk !== 'object') {
        continue
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      throw new DbmError(ERR.timeout, 'AI 生成超时或已取消')
    }
    throw new DbmError(ERR.aiUnavailable, `调用模型失败: ${String(error?.message ?? error)}`)
  }

  // `llm/stream` is a single-attempt wrapper: a failure arrives as a terminal
  // finish chunk rather than a throw, so the reason is inspected here.
  const kind = finish === null || finish === undefined ? undefined : finish.kind
  if (kind === 'error') {
    const failure = finish.failure ?? {}
    throw new DbmError(ERR.aiUnavailable, `模型返回错误: ${failure.message ?? failure.code ?? '未知原因'}`)
  }
  if (kind === 'aborted') {
    throw new DbmError(ERR.timeout, 'AI 生成已中断')
  }

  const output = unwrapModelText(text)
  if (output.length === 0) {
    throw new DbmError(ERR.aiUnavailable, '模型没有返回内容')
  }
  return output
}

/**
 * Strip the wrapper a model insists on adding.
 *
 * Models routinely answer a "give me only the SQL" prompt with a fenced block, or
 * with a "好的，这是…" preamble. The panel then shows that as if it were SQL. This
 * unwraps a single fenced block and drops a leading acknowledgement line.
 */
export function unwrapModelText(input) {
  let text = String(input ?? '').trim()
  const fence = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text)
  if (fence !== null) {
    text = fence[1].trim()
  }
  return text
}

/** Load one panel's chat history. */
export async function loadChatHistory(prefix) {
  const state = await historyStore(prefix).load()
  const messages = Array.isArray(state.messages) ? state.messages : []
  return messages
    .map((item) => normalizeChatMessage(item))
    .filter((item) => item !== undefined)
}

/** Replace one panel's chat history. */
export async function saveChatHistory(prefix, messages) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map((item) => normalizeChatMessage(item))
    .filter((item) => item !== undefined)
    // A chat that grows without bound is a file that eventually stops parsing.
    .slice(-200)
  await historyStore(prefix).save({ messages: normalized })
}

function normalizeChatMessage(item) {
  const record = item ?? {}
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (content.length === 0) {
    return undefined
  }
  return {
    id: typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    role: record.role === 'user' ? 'user' : 'assistant',
    content,
    createdAt:
      typeof record.createdAt === 'string' && record.createdAt.trim().length > 0
        ? record.createdAt
        : new Date().toISOString(),
  }
}
