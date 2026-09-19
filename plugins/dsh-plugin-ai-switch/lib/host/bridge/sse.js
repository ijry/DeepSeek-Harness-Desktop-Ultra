/**
 * The SSE line parser and encoder every bridge hop shares.
 *
 * A stream bridge is two halves that both need this: the upstream half re-assembles
 * frames out of arbitrarily-cut socket chunks, the local half writes frames back out.
 * Keeping it in one dependency-free file is what makes the whole `bridge/` directory
 * unit-testable without a socket.
 *
 * The parsing rules are the WHATWG `text/event-stream` ones, and the two that bite in
 * practice are:
 *
 * - A `\r\n` can be cut in half between two chunks. A trailing `\r` is therefore held
 *   back in the buffer instead of being treated as a line end, or the next chunk's
 *   leading `\n` dispatches a phantom empty event and every frame after it is off by one.
 * - `data: [DONE]` is not a protocol concept, it is OpenAI's sentinel. It comes through
 *   as ordinary frame data (`{event: null, data: '[DONE]'}`) and each protocol module
 *   decides whether it means anything — Anthropic and Gemini never send it.
 *
 * @module dsh-plugin-ai-switch/host/bridge/sse
 */

/** OpenAI's end-of-stream sentinel, carried as frame data rather than a frame kind. */
export const SSE_DONE = '[DONE]'

/**
 * A stateful SSE reader.
 *
 * @returns {{push(chunk:string):Array<{event:string|null,data:string}>, end():Array<{event:string|null,data:string}>}}
 */
export function createSseParser() {
  let buffer = ''
  let eventName = null
  let dataLines = []
  let pending = false

  /** Emit the accumulated frame. Per spec a frame with no `data` and no `event` is nothing. */
  const dispatch = (out) => {
    if (!pending) {
      return
    }
    out.push({ event: eventName, data: dataLines.join('\n') })
    eventName = null
    dataLines = []
    pending = false
  }

  const consumeLine = (text, out) => {
    if (text.length === 0) {
      dispatch(out)
      return
    }
    // ':' in column zero is a comment; upstreams use it as a keep-alive heartbeat.
    if (text.charCodeAt(0) === 58) {
      return
    }
    const colon = text.indexOf(':')
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? '' : text.slice(colon + 1)
    // Exactly one leading space is part of the framing, not of the value.
    if (value.charCodeAt(0) === 32) {
      value = value.slice(1)
    }
    if (field === 'data') {
      dataLines.push(value)
      pending = true
      return
    }
    if (field === 'event') {
      eventName = value
      pending = true
    }
    // `id:` and `retry:` are reconnection bookkeeping; a proxy has nothing to do with them.
  }

  return {
    push(chunk) {
      const out = []
      if (typeof chunk !== 'string' || chunk.length === 0) {
        return out
      }
      buffer += chunk
      let start = 0
      for (let index = 0; index < buffer.length; index += 1) {
        const code = buffer.charCodeAt(index)
        if (code !== 10 && code !== 13) {
          continue
        }
        if (code === 13 && index === buffer.length - 1) {
          // Could be the first half of a split '\r\n' — wait for the next chunk.
          break
        }
        consumeLine(buffer.slice(start, index), out)
        if (code === 13 && buffer.charCodeAt(index + 1) === 10) {
          index += 1
        }
        start = index + 1
      }
      buffer = buffer.slice(start)
      return out
    },

    /** Flush a stream that ended without its final blank line. */
    end() {
      const out = []
      if (buffer.length > 0) {
        const rest = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        buffer = ''
        if (rest.length > 0) {
          consumeLine(rest, out)
        }
      }
      dispatch(out)
      return out
    },
  }
}

/**
 * Encode one frame. Embedded newlines become extra `data:` lines, which is the only
 * way the wire format can carry them and what the parser above rejoins with `'\n'`.
 *
 * @param frame - `{event?: string|null, data: string}`
 */
export function encodeSseFrame(frame) {
  const parts = []
  if (typeof frame?.event === 'string' && frame.event.length > 0) {
    parts.push(`event: ${frame.event}\n`)
  }
  const data = typeof frame?.data === 'string' ? frame.data : ''
  for (const line of data.split('\n')) {
    parts.push(`data: ${line}\n`)
  }
  parts.push('\n')
  return parts.join('')
}

/** Encode a list of frames into one writable string. */
export function encodeSseFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return ''
  }
  let out = ''
  for (const frame of frames) {
    out += encodeSseFrame(frame)
  }
  return out
}
