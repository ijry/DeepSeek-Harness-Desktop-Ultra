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

/** Turns kept, newest-biased: a card is a preview, not an archive. */
const MAX_TURNS = 60

/** Per-turn text cap. A single tool result can be megabytes. */
const MAX_TEXT = 4000

function clip(text) {
  const value = String(text)
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…`
}

/** Visible text of one content-block array. */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'tool-call':
        parts.push(`[工具调用 ${block.name ?? ''}]`.trim())
        break
      case 'tool-result':
        // The model-facing result may itself be blocks or a plain string.
        parts.push(
          typeof block.content === 'string' ? block.content : blocksToText(block.content)
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
function eventToTurn(event) {
  const data = event?.data
  if (data === null || data === undefined) return null
  if (event.type === 'user/message') {
    const text = blocksToText(data.content)
    if (text === '') return null
    // A synthetic injection is still a user-role message; the source tells them
    // apart, and labelling it honestly beats pretending the human typed it.
    const injected = data.source?.kind !== undefined && data.source.kind !== 'user'
    return { role: 'user', label: injected ? `注入 · ${data.source.kind}` : '你', text: clip(text) }
  }
  if (event.type === 'assistant/message') {
    const text = blocksToText(data.message?.content ?? data.content)
    if (text === '') return null
    return {
      role: 'assistant',
      label: data.interrupted === true ? '助手（已中断）' : '助手',
      text: clip(text),
    }
  }
  if (event.type === 'tool/result') {
    const text = blocksToText(data.message?.content ?? data.content ?? data.result?.content)
    if (text === '') return null
    return { role: 'tool', label: `工具 ${data.name ?? ''}`.trim(), text: clip(text) }
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
  const turns = []
  for (const event of snapshot?.events ?? []) {
    const turn = eventToTurn(event)
    if (turn !== null) turns.push(turn)
  }
  const truncated = turns.length > MAX_TURNS
  return { turns: truncated ? turns.slice(-MAX_TURNS) : turns, truncated }
}
