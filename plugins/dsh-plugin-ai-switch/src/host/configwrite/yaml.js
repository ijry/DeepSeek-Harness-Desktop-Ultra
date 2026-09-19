/**
 * Indentation-aware YAML block surgery. No parser, no emitter, no dependency.
 *
 * Two files need editing and both are hand-maintained: `~/.hermes/config.yaml` and dsh's
 * own `~/.dsh/settings.yaml`. The reference re-serializes the second one through
 * serde_yaml, which silently deletes every comment in it — for dsh's settings that is a
 * real cost, since it is a file people edit by hand. So this module does what the
 * reference's Hermes adapter does for both: find the block a key owns, replace exactly
 * those lines, and pass everything else through byte for byte.
 *
 * A "block" is the `key:` line plus every following line indented deeper than it (blank
 * lines included, so a paragraph break inside a block survives). That rule is enough for
 * mappings and block sequences, which is all either file contains. It does NOT understand
 * flow mappings (`{a: 1}`), multi-line scalars (`|`, `>`) or anchors — none of which
 * appear in the blocks we own. Everything outside our own block is untouched text, so a
 * file using those elsewhere is still safe.
 *
 * @module dsh-plugin-ai-switch/host/configwrite/yaml
 */

/** Characters that force a quoted scalar. Model ids can be CJK, so this matters. */
const NEEDS_QUOTES = /^$|^[-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^\s|^(true|false|null|yes|no|on|off|~)$/i

/** One scalar, quoted only when it has to be. */
export function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  const text = String(value ?? '')
  if (NEEDS_QUOTES.test(text) || /^-?\d+(\.\d+)?$/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`
  }
  return text
}

/** Indentation width of a line, or -1 for a blank line. */
function indentOf(line) {
  if (line.trim().length === 0) {
    return -1
  }
  return line.length - line.trimStart().length
}

/** The key a line declares at `indent`, or null. */
function keyOf(line, indent) {
  if (indentOf(line) !== indent) {
    return null
  }
  const trimmed = line.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith('-')) {
    return null
  }
  const match = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):(\s|$)/.exec(trimmed)
  if (match === null) {
    return null
  }
  return (match[1] ?? match[2] ?? match[3]).trim()
}

/** Where one key's block lives: `{keyLine, start, end, indent, childIndent}`. */
function findBlock(lines, key, range, indent) {
  for (let index = range.start; index < range.end; index += 1) {
    if (keyOf(lines[index], indent) !== key) {
      continue
    }
    let end = index + 1
    while (end < range.end) {
      const width = indentOf(lines[end])
      if (width !== -1 && width <= indent) {
        break
      }
      end += 1
    }
    // A trailing run of blank lines belongs to whatever comes next, not to this block.
    let body = end
    while (body > index + 1 && indentOf(lines[body - 1]) === -1) {
      body -= 1
    }
    let childIndent = indent + 2
    for (let scan = index + 1; scan < body; scan += 1) {
      const width = indentOf(lines[scan])
      if (width > indent) {
        childIndent = width
        break
      }
    }
    return { keyLine: index, start: index, end: body, indent, childIndent }
  }
  return null
}

/** Split text into lines, remembering how it ended so the result matches. */
function split(text) {
  const original = String(text ?? '')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  const trailing = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailing) {
    lines.pop()
  }
  return { lines, newline, trailing }
}

function joinLines({ lines, newline, trailing }) {
  const body = lines.join(newline)
  return trailing || body.length === 0 ? `${body}${newline}` : body
}

/**
 * The block for `path`, as raw lines (the `key:` line first), or null.
 *
 * Used by `inspect`: "is there an `ai-switch` provider in here and is it ours".
 */
export function readBlock(text, path) {
  const { lines } = split(text)
  let range = { start: 0, end: lines.length }
  let indent = 0
  let found = null
  for (const key of path) {
    found = findBlock(lines, key, range, indent)
    if (found === null) {
      return null
    }
    range = { start: found.keyLine + 1, end: found.end }
    indent = found.childIndent
  }
  return lines.slice(found.start, found.end)
}

/** Is there a block at `path`? */
export function hasPath(text, path) {
  return readBlock(text, path) !== null
}

/**
 * Replace (or create) the block at `path` with `body`.
 *
 * `body` is the block's CHILD lines, already indented relative to column 0; this function
 * re-indents them to sit under the key. Missing parents are created. Nothing outside the
 * replaced range is rewritten — that is the entire point of this module.
 */
export function setBlock(text, path, body) {
  const document = split(text)
  const { lines } = document
  let range = { start: 0, end: lines.length }
  let indent = 0
  let target = null

  for (let depth = 0; depth < path.length; depth += 1) {
    const key = path[depth]
    const found = findBlock(lines, key, range, indent)
    if (found === null) {
      // Create this key and everything below it, then we are done.
      const insertAt = lastMeaningful(lines, range)
      const created = []
      for (let level = depth; level < path.length; level += 1) {
        created.push(`${' '.repeat(indent + (level - depth) * 2)}${path[level]}:`)
      }
      const bodyIndent = indent + (path.length - depth) * 2
      created.push(...reindent(body, bodyIndent))
      lines.splice(insertAt, 0, ...created)
      return joinLines(document)
    }
    if (depth === path.length - 1) {
      target = found
      break
    }
    range = { start: found.keyLine + 1, end: found.end }
    indent = found.childIndent
  }

  const replacement = [lines[target.keyLine], ...reindent(body, target.childIndent)]
  lines.splice(target.start, target.end - target.start, ...replacement)
  return joinLines(document)
}

/** Drop the block at `path` if present. */
export function removeBlock(text, path) {
  const document = split(text)
  const { lines } = document
  let range = { start: 0, end: lines.length }
  let indent = 0
  let target = null
  for (let depth = 0; depth < path.length; depth += 1) {
    const found = findBlock(lines, path[depth], range, indent)
    if (found === null) {
      return joinLines(document)
    }
    if (depth === path.length - 1) {
      target = found
      break
    }
    range = { start: found.keyLine + 1, end: found.end }
    indent = found.childIndent
  }
  lines.splice(target.start, target.end - target.start)
  return joinLines(document)
}

/** Index just past the last non-blank line of a range — where an insert should land. */
function lastMeaningful(lines, range) {
  let at = range.end
  while (at > range.start && indentOf(lines[at - 1]) === -1) {
    at -= 1
  }
  return at
}

/** Re-indent a body written at its own relative depth to sit at `indent`. */
function reindent(body, indent) {
  const list = Array.isArray(body) ? body : String(body ?? '').split('\n')
  const base = list.reduce((min, line) => {
    const width = indentOf(line)
    return width === -1 ? min : Math.min(min, width)
  }, Number.POSITIVE_INFINITY)
  const shift = Number.isFinite(base) ? indent - base : indent
  return list.map((line) => {
    if (line.trim().length === 0) {
      return ''
    }
    const width = indentOf(line)
    return `${' '.repeat(Math.max(0, width + shift))}${line.trimStart()}`
  })
}

