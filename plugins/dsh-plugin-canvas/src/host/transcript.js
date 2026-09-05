/**
 * A session's folded surface, rendered down to the plain turns an expanded card
 * shows.
 *
 * Read-only by design. codeg-plus's expanded card is a LIVE conversation with a
 * composer, because that board and its chat view are the same React app. dsh's
 * GUI is a separate compiled bundle whose conversation surface a DOM plugin
 * cannot mount, so the canvas shows the transcript and hands the session to the
 * GUI's own view for anything you want to type (the card's ↗ button).
 *
 * Event shapes come from `@deepseek-ai/dsh-session`'s declarations: a surface
 * event is `{type, seq, time, data}`, `user/message`'s data IS the message, and
 * `assistant/message`'s data wraps one under `.message`. Everything is read
 * defensively — an unknown block contributes nothing rather than throwing.
 *
 * @module dsh-plugin-canvas/host/transcript
 */
import { hostLang } from '../shared/lang.js'

/** Turns kept, newest-biased: a card is a preview, not an archive. */
const MAX_TURNS = 60

/** Per-turn text cap. A single tool result can be megabytes. */
const MAX_TEXT = 4000

/** Everything a turn shows that is not the session's own text, per language. The
 *  whitespace matters: `tool` trims because an unnamed tool must not read as
 *  "Tool ". */
const STRINGS = {
  zh: {
    image: '[图片]',
    toolCall: (name) => `[工具调用 ${name}]`,
    you: '你',
    injected: (kind) => `注入 · ${kind}`,
    assistant: '助手',
    assistantInterrupted: '助手（已中断）',
    tool: (name) => `工具 ${name}`.trim(),
  },
  en: {
    image: '[image]',
    toolCall: (name) => `[tool call ${name}]`,
    you: 'You',
    injected: (kind) => `Injected · ${kind}`,
    assistant: 'Assistant',
    assistantInterrupted: 'Assistant (interrupted)',
    tool: (name) => `Tool ${name}`.trim(),
  },
}

function clip(text) {
  const value = String(text)
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…`
}

/** Visible text of one content-block array. */
function blocksToText(blocks, t) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(t.image)
        break
      case 'tool-call':
        parts.push(t.toolCall(block.name ?? ''))
        break
      case 'tool-result':
        // The model-facing result may itself be blocks or a plain string.
        parts.push(
          typeof block.content === 'string' ? block.content : blocksToText(block.content, t)
        )
        break
      default:
        // `reasoning` and anything a plugin added are deliberately not shown.
        break
    }
  }
  return parts.join('\n').trim()
}

/** One surface event → a turn, or null when it carries nothing to show. */
function eventToTurn(event, t) {
  const data = event?.data
  if (data === null || data === undefined) return null
  if (event.type === 'user/message') {
    const text = blocksToText(data.content, t)
    if (text === '') return null
    // A synthetic injection is still a user-role message; the source tells them
    // apart, and labelling it honestly beats pretending the human typed it.
    const injected = data.source?.kind !== undefined && data.source.kind !== 'user'
    return {
      role: 'user',
      label: injected ? t.injected(data.source.kind) : t.you,
      text: clip(text),
    }
  }
  if (event.type === 'assistant/message') {
    const text = blocksToText(data.message?.content ?? data.content, t)
    if (text === '') return null
    return {
      role: 'assistant',
      label: data.interrupted === true ? t.assistantInterrupted : t.assistant,
      text: clip(text),
    }
  }
  if (event.type === 'tool/result') {
    const text = blocksToText(data.message?.content ?? data.content ?? data.result?.content, t)
    if (text === '') return null
    return { role: 'tool', label: t.tool(data.name ?? ''), text: clip(text) }
  }
  return null
}

/**
 * Read one session's transcript.
 *
 * Returns `{turns, truncated}`. A harness without `sessionQuery` — or a session
 * whose log cannot be folded — yields an empty transcript rather than an error:
 * the card still shows its title and its "open in the session view" button.
 */
export async function readTranscript(query, sessionId) {
  if (query === undefined || query === null || typeof query.readSurface !== 'function') {
    return { turns: [], truncated: false }
  }
  let snapshot
  try {
    snapshot = await query.readSurface(sessionId)
  } catch (error) {
    console.warn('[dsh-plugin-canvas] surface read failed:', error?.message ?? error)
    return { turns: [], truncated: false }
  }
  const t = STRINGS[hostLang()]
  const turns = []
  for (const event of snapshot?.events ?? []) {
    const turn = eventToTurn(event, t)
    if (turn !== null) turns.push(turn)
  }
  const truncated = turns.length > MAX_TURNS
  return { turns: truncated ? turns.slice(-MAX_TURNS) : turns, truncated }
}
