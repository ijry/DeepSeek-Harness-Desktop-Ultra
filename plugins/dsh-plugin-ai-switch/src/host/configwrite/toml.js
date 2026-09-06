/**
 * A format-preserving TOML editor, big enough for `~/.codex/config.toml` and no bigger.
 *
 * The reference uses `toml_edit`, whose whole point is that editing three keys leaves
 * every comment, blank line and quote style in the file exactly as the user typed it. No
 * mainstream JS TOML library round-trips like that, and this plugin takes no runtime
 * dependencies, so this is a line-oriented editor: it finds the table a key belongs to,
 * rewrites that one line, and never re-emits anything it did not have to.
 *
 * Scope, stated plainly so nobody mistakes it for a TOML implementation: it understands
 * `key = value` lines, `[table]` / `[[array]]` headers and `#` comments. It does not parse
 * values (it treats them as opaque text), does not handle multi-line strings or inline
 * tables spanning lines, and does not know that a `[` inside a string is not a header.
 * Codex's config has never contained any of those in the keys we touch, and a file that
 * does will only see the keys we write reordered — never corrupted, because every other
 * line is passed through byte for byte.
 *
 * @module dsh-plugin-ai-switch/host/configwrite/toml
 */

/** A TOML basic string, escaped. */
export function tomlString(value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** Is this line a `[table]` or `[[array]]` header? */
function headerName(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[')) {
    return null
  }
  const match = /^\[\[?([^\]]+)\]\]?/.exec(trimmed)
  return match === null ? null : match[1].trim()
}

/** Does this line assign `key`? */
function assignsKey(line, key) {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) {
    return false
  }
  const match = /^("?)([A-Za-z0-9_.-]+)\1\s*=/.exec(trimmed)
  return match !== null && match[2] === key
}

/** Line range `[start, end)` of one table's body; `null` when the table is absent. */
function tableRange(lines, table) {
  const start = lines.findIndex((line) => headerName(line) === table)
  if (start === -1) {
    return null
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (headerName(lines[index]) !== null) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Line range of the root table: everything before the first header. */
function rootRange(lines) {
  const first = lines.findIndex((line) => headerName(line) !== null)
  return { start: 0, end: first === -1 ? lines.length : first }
}

/** The raw text a key is assigned in one range, or null. */
function valueIn(lines, range, key) {
  for (let index = range.start; index < range.end; index += 1) {
    if (assignsKey(lines[index], key)) {
      return lines[index].slice(lines[index].indexOf('=') + 1).trim()
    }
  }
  return null
}

/** A root-level string value with its quotes removed, or null. */
export function rootString(text, key) {
  const lines = String(text ?? '').split('\n')
  const raw = valueIn(lines, rootRange(lines), key)
  if (raw === null) {
    return null
  }
  const match = /^"(.*)"$|^'(.*)'$/.exec(raw)
  return match === null ? raw : (match[1] ?? match[2] ?? '')
}

/** Does the file declare `[table]`? */
export function hasTable(text, table) {
  return tableRange(String(text ?? '').split('\n'), table) !== null
}

/** Set or delete keys in one range. Returns the mutated line array. */
function applyEntries(lines, range, entries) {
  let end = range.end
  for (const [key, literal] of Object.entries(entries)) {
    let found = -1
    for (let index = range.start; index < end; index += 1) {
      if (assignsKey(lines[index], key)) {
        found = index
        break
      }
    }
    if (literal === null) {
      if (found !== -1) {
        lines.splice(found, 1)
        end -= 1
      }
      continue
    }
    if (found !== -1) {
      lines[found] = `${key} = ${literal}`
      continue
    }
    // Insert after the last non-blank line of the range so a trailing blank line that
    // separates this table from the next one stays where it is.
    let at = end
    while (at > range.start && lines[at - 1].trim().length === 0) {
      at -= 1
    }
    lines.splice(at, 0, `${key} = ${literal}`)
    end += 1
  }
  return lines
}

/**
 * Set root keys and one table's keys in a single pass.
 *
 * @param text - the existing file, or '' for a new one.
 * @param root - `{key: literal|null}` at the top level.
 * @param table - `{name, entries}`; entries with a `null` literal are deleted. The table
 *   is appended when absent, which is the only case where this function adds a header.
 */
export function edit(text, { root = {}, table = null } = {}) {
  const original = String(text ?? '')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  let lines = original.replace(/\r\n/g, '\n').split('\n')
  // A file that ends with a newline splits into a trailing empty element; keep track so
  // the result ends the same way it started.
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailingNewline) {
    lines.pop()
  }

  lines = applyEntries(lines, rootRange(lines), root)

  if (table !== null) {
    const range = tableRange(lines, table.name)
    if (range === null) {
      if (lines.length > 0 && lines[lines.length - 1].trim().length > 0) {
        lines.push('')
      }
      lines.push(`[${table.name}]`)
      for (const [key, literal] of Object.entries(table.entries)) {
        if (literal !== null) {
          lines.push(`${key} = ${literal}`)
        }
      }
    } else {
      lines = applyEntries(lines, range, table.entries)
    }
  }

  const body = lines.join(newline)
  return trailingNewline || body.length === 0 ? `${body}${newline}` : body
}

