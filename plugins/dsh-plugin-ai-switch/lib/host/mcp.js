/**
 * One MCP server definition, written into eleven different CLIs' config files.
 *
 * The panel's MCP screen is a matrix: rows are servers, columns are the eleven clients that
 * can host them, and a checkbox means "this server is in that client's config". There is no
 * database behind it — the state IS the eleven files, so every read is a scan and every
 * write is a read-modify-write of somebody else's hand-maintained config. That is the whole
 * reason this module exists as a port of `src-tauri/src/mcp/**` rather than a thin wrapper:
 * the per-client quirks (Cline spells streamable HTTP `streamableHttp`, Codex calls headers
 * `http_headers`, Kimi duplicates the transport into `transport`, OpenCode has an old and a
 * new key shape) are the actual content.
 *
 * Three deliberate deviations from the reference, all of them because it re-serializes
 * whole documents through serde and we refuse to:
 *
 * 1. **TOML and YAML writes are surgical.** `configwrite/toml.js` and `configwrite/yaml.js`
 *    rewrite only the lines they own, so comments in `~/.codex/config.toml` and
 *    `~/.hermes/config.yaml` survive a checkbox click. The reference loses every one of
 *    them. The cost is stated at each call site: those editors do not parse values, so a
 *    server entry using a multi-line string or an inline table spanning lines is read as
 *    opaque text. We detect that case and refuse rather than mangle it.
 * 2. **JSON writes go through `JSON.parse`/`stringify` like the reference**, because a JSON
 *    config has no comments to lose and the reference's own pretty-print is what the CLIs
 *    already see. Sibling keys survive because we mutate the parsed tree in place.
 * 3. **Every marketplace field is untrusted input.** Same as the reference in effect, but
 *    said out loud: a fetched name/url/arg is only ever stored as a string in a config
 *    file. Nothing here spawns a process, and the spec we write is filtered to a known key
 *    set per client, so a hostile registry entry cannot inject an extra config directive.
 *
 * @module dsh-plugin-ai-switch/host/mcp
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ApiError, boundedInt, optionalText, requireText, validation } from '../shared/protocol.js'

import { edit as tomlEdit, hasTable } from './configwrite/toml.js'
import { readBlock, removeBlock, scalar as yamlScalar, setBlock } from './configwrite/yaml.js'
import { writeFileAtomic, userHome } from './sdk.js'
import { envPath } from './sessions.js'

/**
 * The eleven client ids, in `McpAppType::ALL` order.
 *
 * The panel renders columns in this order and sends these exact strings back, so the order
 * is part of the wire contract, not a detail.
 */
export const MCP_APPS = [
  'claude_code',
  'codex',
  'gemini',
  'open_claw',
  'open_code',
  'hermes',
  'cline',
  'cursor',
  'kimi_code',
  'code_buddy',
  'grok',
]

/** `McpAppType::display_name`, for the column headers. */
const APP_DISPLAY_NAMES = {
  claude_code: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  open_claw: 'OpenClaw',
  open_code: 'OpenCode',
  hermes: 'Hermes Agent',
  cline: 'Cline',
  cursor: 'Cursor',
  kimi_code: 'Kimi Code',
  code_buddy: 'CodeBuddy',
  grok: 'Grok',
}

/** The two fixed marketplace providers. */
const OFFICIAL = 'official_registry'
const SMITHERY = 'smithery'
const OFFICIAL_SERVERS_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const SMITHERY_SERVERS_URL = 'https://api.smithery.ai/servers'

/** The reference's reqwest client settings, as one AbortSignal budget. */
const MARKETPLACE_TIMEOUT_MS = 25_000
const MARKETPLACE_USER_AGENT = 'ai-switch-mcp-market/1.0'

/** A hostile registry should not be able to make us hold a response in memory. */
const MARKETPLACE_MAX_BYTES = 8 * 1024 * 1024

const invalidSpec = (message) => validation('mcp.invalid_spec', message)
const configInvalid = (message, details) => validation('mcp.config_invalid', message, details)
const marketplaceInvalid = (message) => validation('mcp.marketplace_invalid', message)
const marketplaceNetwork = (message) => validation('mcp.marketplace_network', message)
const marketplaceNotFound = (message) => validation('mcp.marketplace_not_found', message)

const configIo = (message, details) =>
  new ApiError('mcp.config_io', message, { details, recoverable: true })

/** Is this a plain JSON object (not an array, not null)? */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A trimmed string, or null for anything else (including a blank string). */
function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length === 0 ? null : text
}

/** Structural clone that drops `undefined` — every spec we hand out is JSON-safe. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// normalize.rs
// ---------------------------------------------------------------------------

/**
 * The reference's `normalize_mcp_type`: every spelling the eleven CLIs use for the three
 * transports, collapsed to `stdio` / `sse` / `http`.
 */
export function normalizeMcpType(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-_ ]/g, '')
  switch (key) {
    case 'stdio':
    case 'command':
      return 'stdio'
    case 'sse':
    case 'serversentevents':
      return 'sse'
    case 'http':
    case 'streamablehttp':
    case 'streamable':
      return 'http'
    default:
      return null
  }
}

/**
 * Canonicalize one spec: `{type: 'stdio'|'sse'|'http', ...}` with the transport-defining
 * field trimmed and validated.
 *
 * Unknown keys are PRESERVED, exactly as the reference does — a user who hand-added
 * `disabled: true` or `autoApprove: [...]` to a Cline entry keeps it through a round trip.
 * `transport` is dropped because it is an alias for `type` that only some clients use.
 *
 * @param spec - the raw entry from a config file, a marketplace option, or the panel.
 * @param source - what to name in the error message; the UI prints it verbatim.
 */
export function normalizeSpec(spec, source = 'MCP spec') {
  if (!isObject(spec)) {
    throw invalidSpec(`${source}: MCP spec must be a JSON object`)
  }
  const output = cloneJson(spec)

  const explicit = normalizeMcpType(
    typeof output.type === 'string' ? output.type : typeof output.transport === 'string' ? output.transport : '',
  )
  const inferred =
    typeof output.command === 'string' ? 'stdio' : typeof output.url === 'string' ? 'http' : null
  const type = explicit ?? inferred
  if (type === null) {
    throw invalidSpec(`${source}: MCP spec needs type, command, or url`)
  }
  output.type = type
  delete output.transport

  if (type === 'stdio') {
    const command = cleanText(output.command)
    if (command === null) {
      throw invalidSpec(`${source}: stdio MCP spec needs command`)
    }
    output.command = command
    if (output.args !== undefined) {
      if (!Array.isArray(output.args)) {
        throw invalidSpec(`${source}: args must be an array`)
      }
      // Blank and non-string arguments are dropped, the rest trimmed — same as the
      // reference's retain + trim pass. An arg list is data, never a shell string.
      output.args = output.args
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    }
  } else {
    const url = cleanText(output.url)
    if (url === null) {
      throw invalidSpec(`${source}: remote MCP spec needs url`)
    }
    output.url = url
  }
  return output
}

/**
 * Can this client host this transport?
 *
 * Codex is the one exception in the whole matrix: its config has no SSE transport at all,
 * so an SSE server simply cannot be written there.
 */
export function appCanHostSpec(app, spec) {
  return !(app === 'codex' && isObject(spec) && spec.type === 'sse')
}

/** Normalize a client id, or throw the code the panel knows. */
function requireApp(value) {
  const id = String(value ?? '').trim()
  if (!MCP_APPS.includes(id)) {
    throw validation('mcp.unknown_app', `Unknown MCP client: ${id || '(blank)'}`, id)
  }
  return id
}

/** Normalize a client id list, preserving MCP_APPS order and dropping duplicates. */
function requireApps(value) {
  const list = Array.isArray(value) ? value.map(requireApp) : []
  return MCP_APPS.filter((app) => list.includes(app))
}

// ---------------------------------------------------------------------------
// clients/common.rs — file IO
// ---------------------------------------------------------------------------

/** Read a text file, or `null` when it does not exist. */
async function readTextFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw configIo(`Could not read MCP configuration at ${path}`, String(error?.code ?? error))
  }
}

/** Read a JSON config; a missing or blank file is an empty document. */
async function readJsonFile(path) {
  const raw = await readTextFile(path)
  if (raw === null || raw.trim().length === 0) {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw configInvalid(`Invalid JSON configuration at ${path}`, String(error?.message ?? error))
  }
  if (!isObject(parsed)) {
    throw configInvalid(`Invalid JSON root at ${path}`, path)
  }
  return parsed
}

/**
 * Write a JSON config, pretty-printed with a trailing newline.
 *
 * Same shape the reference emits (`to_string_pretty` + `\n`), so a file this plugin and the
 * desktop app both touch does not churn. 0o644 rather than the 0o600 default: these are
 * CLI configs the user reads and edits, not our own key store.
 */
async function writeJsonFile(path, value) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o644)
}

/** Does this path exist? */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Ensure `root[key]` is an object and return it. */
function ensureObject(root, key, label) {
  if (!isObject(root[key])) {
    root[key] = {}
  }
  const value = root[key]
  if (!isObject(value)) {
    throw configInvalid(`${label} must be an object`, key)
  }
  return value
}

/**
 * Read servers out of a JSON config at one key path, skipping malformed entries.
 *
 * A skip is deliberate and matches the reference: one bad entry in `~/.claude.json` must
 * not blank the whole MCP screen. The entry is left untouched on disk.
 */
async function readJsonServers(path, keyPath, source) {
  const root = await readJsonFile(path)
  let node = root
  for (const key of keyPath) {
    if (!isObject(node?.[key])) {
      return {}
    }
    node = node[key]
  }
  const result = {}
  for (const [id, spec] of Object.entries(node)) {
    try {
      result[id] = normalizeSpec(spec, `${source} MCP entry ${id}`)
    } catch {
      // Skipped, not fatal. No console noise: the panel shows what it could read.
    }
  }
  return result
}

/** Upsert one server into a JSON config at a key path. */
async function upsertJsonServer(path, keyPath, id, spec, source, shape = normalizeSpec) {
  const root = await readJsonFile(path)
  let node = root
  for (const key of keyPath) {
    node = ensureObject(node, key, `${source} ${keyPath.join('.')}`)
  }
  node[id] = shape(spec, `${source} write`)
  await writeJsonFile(path, root)
}

/** Remove one server from a JSON config at a key path; `false` when it was not there. */
async function removeJsonServer(path, keyPath, id, { pruneEmptyParents = false } = {}) {
  if (!(await pathExists(path))) {
    return false
  }
  const root = await readJsonFile(path)
  const chain = [root]
  let node = root
  for (const key of keyPath) {
    if (!isObject(node?.[key])) {
      return false
    }
    node = node[key]
    chain.push(node)
  }
  if (!Object.hasOwn(node, id)) {
    return false
  }
  delete node[id]
  if (pruneEmptyParents) {
    // OpenClaw's adapter drops `mcp.servers` and then `mcp` once they are empty, so the
    // file goes back to exactly the shape it had before we ever touched it.
    for (let depth = keyPath.length - 1; depth >= 0; depth -= 1) {
      if (Object.keys(chain[depth + 1]).length === 0) {
        delete chain[depth][keyPath[depth]]
      }
    }
  }
  await writeJsonFile(path, root)
  return true
}

/**
 * Claude Code and CodeBuddy also flip `enabledPlugins['<id>@local']` in their settings file.
 *
 * Best-effort on removal in the reference too: a missing settings file must not fail the
 * removal of the server itself.
 */
async function setLocalPlugin(path, id, enabled) {
  const root = await readJsonFile(path)
  const plugins = ensureObject(root, 'enabledPlugins', 'enabledPlugins')
  const key = `${id}@local`
  if (enabled) {
    plugins[key] = true
  } else if (!Object.hasOwn(plugins, key)) {
    return
  } else {
    delete plugins[key]
  }
  await writeJsonFile(path, root)
}

// ---------------------------------------------------------------------------
// TOML clients: codex, grok
// ---------------------------------------------------------------------------

/** A TOML literal for a JSON value, or `null` when TOML cannot express it. */
function tomlLiteral(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }
  if (Array.isArray(value)) {
    const items = value.map(tomlLiteral).filter((item) => item !== null)
    return `[${items.join(', ')}]`
  }
  if (isObject(value)) {
    // An inline table. Only ever used for `env` / `headers`, which are flat string maps.
    const pairs = []
    for (const [key, item] of Object.entries(value)) {
      const literal = tomlLiteral(item)
      if (literal !== null) {
        pairs.push(`${tomlKey(key)} = ${literal}`)
      }
    }
    return `{ ${pairs.join(', ')} }`
  }
  return null
}

/** A TOML key: bare when it can be, quoted when it cannot. */
function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/**
 * Parse the value literals of one `[table]` out of a TOML file.
 *
 * This is a READER for the line-oriented editor's world view: a `key = value` line whose
 * value is JSON-compatible (string, number, bool, flat array, flat inline table). That is
 * everything the eleven CLIs actually write for an MCP entry.
 *
 * The honest gap, and why it is safe: a value this cannot parse (a multi-line string, an
 * inline table spanning lines, a datetime) makes the entry UNREADABLE, so the server is
 * simply not reported for that client, and `configwrite/toml.js` will refuse to touch a
 * table it cannot locate cleanly. We never rewrite what we could not read.
 */
function parseTomlTable(text, table) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const header = new RegExp(`^\\[\\[?${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]?\\s*$`)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (header.test(lines[index].trim())) {
      start = index + 1
      break
    }
  }
  if (start === -1) {
    return null
  }
  const entries = {}
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith('[')) {
      break
    }
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }
    const at = trimmed.indexOf('=')
    if (at === -1) {
      continue
    }
    const key = trimmed.slice(0, at).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    const parsed = parseTomlValue(trimmed.slice(at + 1).trim())
    if (parsed !== undefined) {
      entries[key] = parsed
    }
  }
  return entries
}

/** Every `[prefix.*]` table name present in a TOML file, in file order. */
function tomlTableNames(text, prefix) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const names = []
  for (const line of lines) {
    const match = /^\[\[?([^\]]+)\]\]?\s*$/.exec(line.trim())
    if (match === null) {
      continue
    }
    const name = match[1].trim()
    if (name.startsWith(`${prefix}.`) && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

/** The bare id in `[mcp_servers."my.server"]` -> `my.server`. */
function tomlTableLeaf(name, prefix) {
  const leaf = name.slice(prefix.length + 1)
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(leaf)
  return quoted === null ? leaf : (quoted[1] ?? quoted[2] ?? '')
}

/** A TOML scalar/array/inline-table literal as JSON, or `undefined` when unparseable. */
function parseTomlValue(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) {
    return undefined
  }
  if (text === 'true' || text === 'false') {
    return text === 'true'
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number.parseInt(text, 10)
  }
  if (/^[+-]?\d*\.\d+$/.test(text)) {
    return Number.parseFloat(text)
  }
  if (text.startsWith('"""') || text.startsWith("'''")) {
    // A multi-line string. Unreadable by design; see parseTomlTable's header comment.
    return undefined
  }
  if (text.startsWith('"')) {
    try {
      // A TOML basic string is a JSON string for every escape these files use.
      const parsed = JSON.parse(text)
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (text.startsWith("'")) {
    const match = /^'([^']*)'$/.exec(text)
    return match === null ? undefined : match[1]
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitTomlList(text.slice(1, -1)).map(parseTomlValue).filter((item) => item !== undefined)
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const object = {}
    for (const pair of splitTomlList(text.slice(1, -1))) {
      const at = pair.indexOf('=')
      if (at === -1) {
        continue
      }
      const key = pair.slice(0, at).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      const value = parseTomlValue(pair.slice(at + 1))
      if (value !== undefined) {
        object[key] = value
      }
    }
    return object
  }
  return undefined
}

/** Split a comma-separated TOML list body, respecting quotes and one nesting level. */
function splitTomlList(body) {
  const parts = []
  let current = ''
  let quote = null
  let depth = 0
  for (const char of String(body ?? '')) {
    if (quote !== null) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') {
      depth += 1
    } else if (char === ']' || char === '}') {
      depth -= 1
    }
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) {
    parts.push(current)
  }
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * Rewrite one `[<prefix>.<id>]` table, keeping every other line of the file byte for byte.
 *
 * `entries` is `{key: jsonValue}`; a key absent from it that the table currently has is
 * DELETED, because the caller passes the complete new entry. That is what makes switching a
 * server from stdio to http not leave a stale `command` behind.
 */
async function writeTomlEntry(path, prefix, id, entries) {
  const text = (await readTextFile(path)) ?? ''
  const table = `${prefix}.${tomlKey(id)}`
  const existing = parseTomlTable(text, table) ?? {}
  const patch = {}
  for (const key of Object.keys(existing)) {
    patch[key] = null
  }
  for (const [key, value] of Object.entries(entries)) {
    const literal = tomlLiteral(value)
    if (literal === null) {
      throw configInvalid('Could not convert MCP entry to TOML', `${table}.${key}`)
    }
    patch[tomlKey(key)] = literal
  }
  await writeTomlText(path, tomlEdit(text, { table: { name: table, entries: patch } }))
}

/** Delete a `[<prefix>.<id>]` table, header included, leaving the rest untouched. */
async function removeTomlEntry(path, prefix, id) {
  const text = await readTextFile(path)
  if (text === null) {
    return false
  }
  const table = `${prefix}.${tomlKey(id)}`
  if (!hasTable(text, table)) {
    // The id may be spelled unquoted in the file even though it needs quoting, or the other
    // way round; try the alternate spelling before giving up.
    const alternate = `${prefix}.${table.endsWith('"') ? id : JSON.stringify(id)}`
    if (!hasTable(text, alternate)) {
      return false
    }
    await writeTomlText(path, removeTomlTable(text, alternate))
    return true
  }
  await writeTomlText(path, removeTomlTable(text, table))
  return true
}

/**
 * Drop a whole `[table]` block: its header, its keys, the comment lines that introduce it,
 * and the blank line that separated it from what follows.
 *
 * `configwrite/toml.js` can delete keys but not a header, because nothing else in this
 * plugin ever removes a table; that file is another agent's and not mine to extend, so the
 * one extra operation MCP needs lives here.
 *
 * The block's boundaries are drawn the way a person reads the file:
 *
 * - a run of `#` comments directly above the header introduces THIS table, so it goes;
 * - a run of `#` comments directly above the NEXT header introduces that one, so it stays,
 *   which is why the end is pulled back over it;
 * - the blank lines inside the deleted range go with it, leaving the surviving blocks
 *   separated by exactly the one blank line that was already above this block.
 */
function removeTomlTable(text, table) {
  const original = String(text ?? '')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  const trailing = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailing) {
    lines.pop()
  }
  const headerName = (line) => {
    const match = /^\[\[?([^\]]+)\]\]?/.exec(line.trim())
    return match === null ? null : match[1].trim()
  }
  const start = lines.findIndex((line) => headerName(line) === table)
  if (start === -1) {
    return original
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (headerName(lines[index]) !== null) {
      end = index
      break
    }
  }
  let from = start
  while (from > 0 && lines[from - 1].trim().startsWith('#')) {
    from -= 1
  }
  if (end < lines.length) {
    while (end > start + 1 && lines[end - 1].trim().startsWith('#')) {
      end -= 1
    }
  } else {
    // Last block in the file: also take the blank line above it, so the file does not end
    // with a gap where the entry used to be.
    while (from > 0 && lines[from - 1].trim().length === 0) {
      from -= 1
    }
  }
  lines.splice(from, end - from)
  const body = lines.join(newline)
  return trailing || body.length === 0 ? `${body}${newline}` : body
}

/** A TOML config is 0o644: the user reads and edits these by hand. */
async function writeTomlText(path, text) {
  await writeFileAtomic(path, text, 0o644)
}

// ---------------------------------------------------------------------------
// YAML client: hermes
// ---------------------------------------------------------------------------

/**
 * The `mcp_servers` mapping of a Hermes config, read from raw block lines.
 *
 * Same trade as the TOML reader: a flat `key: value` / `key:` + `- item` shape is
 * understood, anything else makes the entry unreadable rather than corrupt.
 */
function parseYamlServers(text) {
  const block = readBlock(text, ['mcp_servers'])
  if (block === null) {
    return {}
  }
  const body = block.slice(1)
  const indentOf = (line) => (line.trim().length === 0 ? -1 : line.length - line.trimStart().length)
  const widths = body.map(indentOf).filter((width) => width !== -1)
  if (widths.length === 0) {
    return {}
  }
  const idIndent = Math.min(...widths)
  const servers = {}
  let currentId = null
  let currentLines = []
  const flush = () => {
    if (currentId !== null) {
      servers[currentId] = parseYamlMapping(currentLines)
    }
    currentId = null
    currentLines = []
  }
  for (const line of body) {
    const width = indentOf(line)
    if (width === idIndent) {
      const match = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):\s*$/.exec(line.trim())
      flush()
      currentId = match === null ? null : (match[1] ?? match[2] ?? match[3]).trim()
      continue
    }
    if (currentId !== null) {
      currentLines.push(line)
    }
  }
  flush()
  return servers
}

/** A flat YAML mapping (scalars, block sequences, one nested mapping level) as JSON. */
function parseYamlMapping(lines) {
  const indentOf = (line) => (line.trim().length === 0 ? -1 : line.length - line.trimStart().length)
  const widths = lines.map(indentOf).filter((width) => width !== -1)
  if (widths.length === 0) {
    return {}
  }
  const base = Math.min(...widths)
  const result = {}
  let key = null
  let list = null
  let nested = null
  const flush = () => {
    if (key !== null) {
      if (list !== null) {
        result[key] = list
      } else if (nested !== null) {
        result[key] = nested
      }
    }
    list = null
    nested = null
  }
  for (const line of lines) {
    const width = indentOf(line)
    if (width === -1) {
      continue
    }
    if (width === base) {
      flush()
      const match = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):(.*)$/.exec(line.trim())
      if (match === null) {
        key = null
        continue
      }
      key = (match[1] ?? match[2] ?? match[3]).trim()
      const rest = match[4].trim()
      if (rest.length === 0) {
        // A block sequence or a nested mapping follows.
        continue
      }
      result[key] = parseYamlScalar(rest)
      key = null
      continue
    }
    if (key === null) {
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      list = list ?? []
      list.push(parseYamlScalar(trimmed.slice(2)))
      continue
    }
    const match = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):(.*)$/.exec(trimmed)
    if (match !== null) {
      nested = nested ?? {}
      nested[(match[1] ?? match[2] ?? match[3]).trim()] = parseYamlScalar(match[4].trim())
    }
  }
  flush()
  return result
}

/** One YAML scalar as JSON. Unquoted `true`/`false`/numbers are typed. */
function parseYamlScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.replace(/^"|"$/g, '')
    }
  }
  if (text.startsWith("'")) {
    return text.replace(/^'|'$/g, '').replace(/''/g, "'")
  }
  if (text === 'true' || text === 'false') {
    return text === 'true'
  }
  if (text === 'null' || text === '~' || text.length === 0) {
    return null
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number.parseInt(text, 10)
  }
  if (/^[+-]?\d*\.\d+$/.test(text)) {
    return Number.parseFloat(text)
  }
  return text
}

/** Render a flat JSON object as YAML body lines at column 0. */
function yamlBodyLines(value) {
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) {
      continue
    }
    if (Array.isArray(item)) {
      lines.push(`${key}:`)
      for (const element of item) {
        lines.push(`  - ${yamlScalar(element)}`)
      }
      continue
    }
    if (isObject(item)) {
      lines.push(`${key}:`)
      for (const [nestedKey, nestedValue] of Object.entries(item)) {
        lines.push(`  ${nestedKey}: ${yamlScalar(nestedValue)}`)
      }
      continue
    }
    lines.push(`${key}: ${yamlScalar(item)}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// clients/*.rs — the eleven adapters
// ---------------------------------------------------------------------------

/** Every client's config file paths, resolved on call so a changed env var is honoured. */
function clientPaths() {
  const home = userHome()
  return {
    claude_code: {
      path: join(home, '.claude.json'),
      settingsPath: join(home, '.claude', 'settings.json'),
    },
    codex: { path: join(envPath('CODEX_HOME', join(home, '.codex')), 'config.toml') },
    gemini: { path: join(home, '.gemini', 'settings.json') },
    open_claw: { path: join(home, '.openclaw', 'openclaw.json') },
    open_code: { path: join(home, '.config', 'opencode', 'opencode.json') },
    hermes: { path: join(envPath('HERMES_HOME', join(home, '.hermes')), 'config.yaml') },
    cline: {
      path: join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    },
    cursor: { path: join(home, '.cursor', 'mcp.json') },
    kimi_code: { path: join(envPath('KIMI_CODE_HOME', join(home, '.kimi-code')), 'mcp.json') },
    code_buddy: {
      path: join(home, '.codebuddy.json'),
      settingsPath: join(home, '.codebuddy', 'settings.json'),
    },
    grok: { path: join(envPath('GROK_HOME', join(home, '.grok')), 'config.toml') },
  }
}

/** Keep only the listed keys of a canonical spec, in the listed order. */
function pickKeys(spec, keys) {
  const output = {}
  for (const key of keys) {
    if (spec[key] !== undefined) {
      output[key] = cloneJson(spec[key])
    }
  }
  return output
}

/** Everything in `spec` that is not one of `keys` — the reference's "keep the extras" pass. */
function restKeys(spec, keys) {
  const output = {}
  for (const [key, value] of Object.entries(spec)) {
    if (!keys.includes(key) && value !== null && value !== undefined) {
      output[key] = cloneJson(value)
    }
  }
  return output
}

/**
 * The eleven adapters. Each is `{read, upsert, remove}` over one file.
 *
 * `read` returns `{id: canonicalSpec}`; `upsert` writes one entry in that client's own
 * dialect; `remove` returns whether anything was actually deleted.
 */
const ADAPTERS = {
  /** `~/.claude.json` -> `mcpServers`, plus the `enabledPlugins` flag in settings.json. */
  claude_code: {
    read: ({ path }) => readJsonServers(path, ['mcpServers'], 'Claude Code'),
    upsert: async ({ path, settingsPath }, id, spec) => {
      await upsertJsonServer(path, ['mcpServers'], id, spec, 'Claude Code')
      await setLocalPlugin(settingsPath, id, true)
    },
    remove: async ({ path, settingsPath }, id) => {
      const removed = await removeJsonServer(path, ['mcpServers'], id)
      // Best-effort, as in the reference: a broken settings.json must not block removal.
      await setLocalPlugin(settingsPath, id, false).catch(() => {})
      return removed
    },
  },

  /**
   * `$CODEX_HOME/config.toml` -> `[mcp_servers.<id>]`, headers spelled `http_headers`.
   *
   * Codex also still reads the older `[mcp.servers.<id>]`; we read both (new wins) and, like
   * the reference, drop the old entry when we write the new one.
   */
  codex: {
    read: async ({ path }) => {
      const text = await readTextFile(path)
      if (text === null) {
        return {}
      }
      const result = {}
      for (const prefix of ['mcp_servers', 'mcp.servers']) {
        for (const table of tomlTableNames(text, prefix)) {
          const id = tomlTableLeaf(table, prefix)
          if (id.length === 0 || Object.hasOwn(result, id)) {
            continue
          }
          const entry = parseTomlTable(text, table)
          if (entry === null) {
            continue
          }
          const spec = { ...entry }
          if (spec.http_headers !== undefined) {
            spec.headers = spec.http_headers
            delete spec.http_headers
          }
          if (spec.type === undefined) {
            spec.type = spec.command === undefined ? 'http' : 'stdio'
          }
          try {
            result[id] = normalizeSpec(spec, `Codex ${id}`)
          } catch {
            // Unreadable entry; leave it alone rather than report a half-parsed server.
          }
        }
      }
      return result
    },
    upsert: async ({ path }, id, spec) => {
      const canonical = normalizeSpec(spec, 'Codex write')
      if (canonical.type === 'sse') {
        throw validation('mcp.unsupported_transport', 'Codex does not support SSE MCP servers', id)
      }
      const entry =
        canonical.type === 'stdio'
          ? pickKeys(canonical, ['command', 'args', 'env', 'cwd'])
          : { ...pickKeys(canonical, ['url']), ...(canonical.headers === undefined ? {} : { http_headers: cloneJson(canonical.headers) }) }
      await writeTomlEntry(path, 'mcp_servers', id, entry)
      await removeTomlEntry(path, 'mcp.servers', id)
    },
    remove: async ({ path }, id) => {
      const fromNew = await removeTomlEntry(path, 'mcp_servers', id)
      const fromOld = await removeTomlEntry(path, 'mcp.servers', id)
      return fromNew || fromOld
    },
  },

  /** `~/.gemini/settings.json` -> `mcpServers`. The plain case. */
  gemini: {
    read: ({ path }) => readJsonServers(path, ['mcpServers'], 'Gemini'),
    upsert: ({ path }, id, spec) => upsertJsonServer(path, ['mcpServers'], id, spec, 'Gemini'),
    remove: ({ path }, id) => removeJsonServer(path, ['mcpServers'], id),
  },

  /** `~/.openclaw/openclaw.json` -> `mcp.servers`, pruned back to nothing when emptied. */
  open_claw: {
    read: ({ path }) => readJsonServers(path, ['mcp', 'servers'], 'OpenClaw'),
    upsert: ({ path }, id, spec) => upsertJsonServer(path, ['mcp', 'servers'], id, spec, 'OpenClaw'),
    remove: ({ path }, id) => removeJsonServer(path, ['mcp', 'servers'], id, { pruneEmptyParents: true }),
  },

  /**
   * `~/.config/opencode/opencode.json` — the one client with two shapes.
   *
   * New: `mcpServers` with canonical specs. Old: `mcp` with `{type:'local', command:[argv]}`.
   * We read both (new wins) and write whichever the file already uses, exactly as the
   * reference does, so we never migrate a user's config out from under their OpenCode.
   */
  open_code: {
    read: async ({ path }) => {
      const result = await readJsonServers(path, ['mcpServers'], 'OpenCode')
      const root = await readJsonFile(path)
      if (isObject(root.mcp)) {
        for (const [id, raw] of Object.entries(root.mcp)) {
          if (Object.hasOwn(result, id) || !isObject(raw)) {
            continue
          }
          try {
            result[id] = openCodeOldToCanonical(raw)
          } catch {
            // Skipped, same as every other malformed entry.
          }
        }
      }
      return result
    },
    upsert: async ({ path }, id, spec) => {
      const root = await readJsonFile(path)
      const canonical = normalizeSpec(spec, 'OpenCode write')
      if (isObject(root.mcpServers)) {
        root.mcpServers[id] = canonical
      } else {
        const servers = ensureObject(root, 'mcp', 'OpenCode mcp')
        servers[id] = openCodeCanonicalToOld(canonical)
      }
      await writeJsonFile(path, root)
    },
    remove: async ({ path }, id) => {
      let removed = await removeJsonServer(path, ['mcpServers'], id)
      if (await pathExists(path)) {
        const root = await readJsonFile(path)
        if (isObject(root.mcp) && Object.hasOwn(root.mcp, id)) {
          delete root.mcp[id]
          await writeJsonFile(path, root)
          removed = true
        }
      }
      return removed
    },
  },

  /** `$HERMES_HOME/config.yaml` -> `mcp_servers`, SSE spelled `transport: sse`. */
  hermes: {
    read: async ({ path }) => {
      const text = await readTextFile(path)
      if (text === null) {
        return {}
      }
      const result = {}
      for (const [id, raw] of Object.entries(parseYamlServers(text))) {
        const spec = { ...raw }
        const type =
          spec.command !== undefined
            ? 'stdio'
            : String(spec.transport ?? '').toLowerCase() === 'sse'
              ? 'sse'
              : 'http'
        spec.type = type
        delete spec.transport
        try {
          result[id] = normalizeSpec(spec, `Hermes ${id}`)
        } catch {
          // Skipped.
        }
      }
      return result
    },
    upsert: async ({ path }, id, spec) => {
      const canonical = normalizeSpec(spec, 'Hermes write')
      const owned = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'transport']
      const entry =
        canonical.type === 'stdio'
          ? pickKeys(canonical, ['command', 'args', 'env', 'enabled', 'required'])
          : {
              ...pickKeys(canonical, ['url']),
              ...(canonical.type === 'sse' ? { transport: 'sse' } : {}),
              ...(canonical.headers === undefined ? {} : { headers: cloneJson(canonical.headers) }),
            }
      const text = (await readTextFile(path)) ?? ''
      const body = yamlBodyLines({ ...entry, ...restKeys(canonical, owned) })
      await writeFileAtomic(path, setBlock(text, ['mcp_servers', id], body), 0o644)
    },
    remove: async ({ path }, id) => {
      const text = await readTextFile(path)
      if (text === null || readBlock(text, ['mcp_servers', id]) === null) {
        return false
      }
      await writeFileAtomic(path, removeBlock(text, ['mcp_servers', id]), 0o644)
      return true
    },
  },

  /** `~/.cline/data/settings/cline_mcp_settings.json`; Cline calls http `streamableHttp`. */
  cline: {
    read: ({ path }) => readJsonServers(path, ['mcpServers'], 'Cline'),
    upsert: ({ path }, id, spec) =>
      upsertJsonServer(path, ['mcpServers'], id, spec, 'Cline', (raw, source) => {
        const canonical = normalizeSpec(raw, source)
        if (canonical.type === 'http') {
          canonical.type = 'streamableHttp'
        }
        return canonical
      }),
    remove: ({ path }, id) => removeJsonServer(path, ['mcpServers'], id),
  },

  /**
   * `~/.cursor/mcp.json` — Cursor infers the transport and chokes on an explicit `type`, so
   * the entry is written without one and read with any existing one discarded.
   */
  cursor: {
    read: async ({ path }) => {
      const result = {}
      for (const [id, spec] of Object.entries(await readJsonServers(path, ['mcpServers'], 'Cursor'))) {
        const stripped = { ...spec }
        delete stripped.type
        try {
          result[id] = normalizeSpec(stripped, `Cursor ${id}`)
        } catch {
          // Skipped.
        }
      }
      return result
    },
    upsert: ({ path }, id, spec) =>
      upsertJsonServer(path, ['mcpServers'], id, spec, 'Cursor', (raw, source) =>
        pickKeys(normalizeSpec(raw, source), ['command', 'args', 'env', 'cwd', 'url', 'headers']),
      ),
    remove: ({ path }, id) => removeJsonServer(path, ['mcpServers'], id),
  },

  /** `$KIMI_CODE_HOME/mcp.json`; a remote entry carries the transport twice. */
  kimi_code: {
    read: async ({ path }) => {
      const root = await readJsonFile(path)
      if (!isObject(root.mcpServers)) {
        return {}
      }
      const result = {}
      for (const [id, raw] of Object.entries(root.mcpServers)) {
        if (!isObject(raw)) {
          continue
        }
        const spec = { ...raw }
        const transport = typeof spec.transport === 'string' ? spec.transport : null
        delete spec.transport
        delete spec.type
        if (transport !== null) {
          spec.type = transport
        }
        try {
          result[id] = normalizeSpec(spec, `Kimi Code ${id}`)
        } catch {
          // Skipped.
        }
      }
      return result
    },
    upsert: ({ path }, id, spec) =>
      upsertJsonServer(path, ['mcpServers'], id, spec, 'Kimi Code', (raw, source) => {
        const canonical = normalizeSpec(raw, source)
        const entry = pickKeys(canonical, ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'enabled'])
        if (canonical.type === 'http' || canonical.type === 'sse') {
          entry.transport = canonical.type
        }
        return entry
      }),
    remove: ({ path }, id) => removeJsonServer(path, ['mcpServers'], id),
  },

  /** `~/.codebuddy.json` -> `mcpServers`, plus the settings.json plugin flag. */
  code_buddy: {
    read: ({ path }) => readJsonServers(path, ['mcpServers'], 'CodeBuddy'),
    upsert: async ({ path, settingsPath }, id, spec) => {
      await upsertJsonServer(path, ['mcpServers'], id, spec, 'CodeBuddy')
      await setLocalPlugin(settingsPath, id, true)
    },
    remove: async ({ path, settingsPath }, id) => {
      const removed = await removeJsonServer(path, ['mcpServers'], id)
      await setLocalPlugin(settingsPath, id, false).catch(() => {})
      return removed
    },
  },

  /** `$GROK_HOME/config.toml` -> `[mcp_servers.<id>]`; http is implied by `url`. */
  grok: {
    read: async ({ path }) => {
      const text = await readTextFile(path)
      if (text === null) {
        return {}
      }
      const result = {}
      for (const table of tomlTableNames(text, 'mcp_servers')) {
        const id = tomlTableLeaf(table, 'mcp_servers')
        const entry = parseTomlTable(text, table)
        if (id.length === 0 || entry === null) {
          continue
        }
        const spec = { ...entry }
        spec.type =
          typeof spec.type === 'string' ? spec.type : spec.url === undefined ? 'stdio' : 'http'
        try {
          result[id] = normalizeSpec(spec, `Grok ${id}`)
        } catch {
          // Skipped.
        }
      }
      return result
    },
    upsert: async ({ path }, id, spec) => {
      const canonical = normalizeSpec(spec, 'Grok write')
      const owned = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers']
      const entry =
        canonical.type === 'stdio'
          ? pickKeys(canonical, ['command', 'args', 'env', 'cwd', 'enabled', 'required'])
          : {
              ...pickKeys(canonical, ['url']),
              ...(canonical.type === 'sse' ? { type: 'sse' } : {}),
              ...(canonical.headers === undefined ? {} : { headers: cloneJson(canonical.headers) }),
            }
      await writeTomlEntry(path, 'mcp_servers', id, { ...entry, ...restKeys(canonical, owned) })
    },
    remove: ({ path }, id) => removeTomlEntry(path, 'mcp_servers', id),
  },
}

/** OpenCode's old `{type:'local', command:[argv], environment}` shape as a canonical spec. */
function openCodeOldToCanonical(raw) {
  const type = typeof raw.type === 'string' ? raw.type : 'local'
  if (type === 'local') {
    const argv = Array.isArray(raw.command) ? raw.command : []
    const spec = {
      type: 'stdio',
      command: typeof argv[0] === 'string' ? argv[0] : '',
      args: argv.slice(1),
    }
    if (raw.environment !== undefined) {
      spec.env = cloneJson(raw.environment)
    }
    return normalizeSpec(spec, 'OpenCode')
  }
  return normalizeSpec({ ...raw, type: type === 'sse' ? 'sse' : 'http' }, 'OpenCode')
}

/** The inverse: a canonical spec as OpenCode's old shape. */
function openCodeCanonicalToOld(canonical) {
  if (canonical.type === 'stdio') {
    const entry = {
      type: 'local',
      command: [canonical.command ?? '', ...(Array.isArray(canonical.args) ? canonical.args : [])],
    }
    if (canonical.env !== undefined) {
      entry.environment = cloneJson(canonical.env)
    }
    return entry
  }
  const entry = { type: canonical.type }
  if (canonical.url !== undefined) {
    entry.url = canonical.url
  }
  if (canonical.headers !== undefined) {
    entry.headers = cloneJson(canonical.headers)
  }
  return entry
}

/** `[{app, paths, adapter}]` in MCP_APPS order, resolved fresh so env changes are honoured. */
function adapters() {
  const paths = clientPaths()
  return MCP_APPS.map((app) => ({ app, paths: paths[app], adapter: ADAPTERS[app] }))
}

/** The eleven clients with their display names and config paths, for the panel's columns. */
export function listApps() {
  const paths = clientPaths()
  return MCP_APPS.map((app) => ({
    app_type: app,
    display_name: APP_DISPLAY_NAMES[app],
    config_path: paths[app].path,
  }))
}

// ---------------------------------------------------------------------------
// service.rs
// ---------------------------------------------------------------------------

/**
 * Every MCP server configured in any of the eleven clients, grouped by id.
 *
 * The FIRST client (in MCP_APPS order) that declares an id owns the spec shown in the UI;
 * `apps` lists everyone who has it. Two clients with genuinely different specs under one id
 * is a state the reference cannot represent either — the matrix has one row per id.
 *
 * A client whose config file is unreadable is reported as having nothing rather than
 * failing the scan, so one corrupt file does not blank the screen.
 */
export async function scanLocal() {
  const grouped = new Map()
  for (const { app, paths, adapter } of adapters()) {
    let entries
    try {
      entries = await adapter.read(paths)
    } catch {
      continue
    }
    for (const [id, spec] of Object.entries(entries)) {
      const existing = grouped.get(id)
      if (existing === undefined) {
        grouped.set(id, { id, spec, apps: [app] })
      } else if (!existing.apps.includes(app)) {
        existing.apps.push(app)
      }
    }
  }
  return Array.from(grouped.values())
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((server) => ({
      id: server.id,
      spec: server.spec,
      apps: MCP_APPS.filter((app) => server.apps.includes(app)),
    }))
}

/**
 * The subset of `apps` that can host `spec`, or a refusal when that subset is empty.
 *
 * Refusing beats silently writing fewer clients than the user ticked: an "add to Codex"
 * that reports success without writing anything is the bug this exists to prevent.
 */
function preflightApps(apps, spec) {
  const compatible = apps.filter((app) => appCanHostSpec(app, spec))
  if (compatible.length === 0) {
    throw validation(
      'mcp.no_compatible_client',
      'None of the selected clients can host this MCP transport',
      String(spec?.type ?? ''),
    )
  }
  return compatible
}

/**
 * Write one server to the selected clients and REMOVE it from the others.
 *
 * The removal half is not a bonus: the panel's checkboxes are a complete statement of where
 * the server should live, so unticking Cursor has to actually delete it from
 * `~/.cursor/mcp.json`. The reference does the same.
 */
export async function upsertLocalServer({ serverId, spec, apps } = {}) {
  const id = requireText(serverId, 'server_id', 200)
  const canonical = normalizeSpec(spec, 'MCP save')
  const selected = preflightApps(requireApps(apps), canonical)
  for (const { app, paths, adapter } of adapters()) {
    if (selected.includes(app)) {
      await adapter.upsert(paths, id, canonical)
    } else {
      await adapter.remove(paths, id).catch(() => false)
    }
  }
  const server = (await scanLocal()).find((item) => item.id === id)
  if (server === undefined) {
    throw configInvalid('MCP server was written but could not be reloaded', id)
  }
  return server
}

/**
 * Re-target an existing server: same spec, different set of clients.
 *
 * An empty `apps` means "nowhere", which removes it everywhere and returns `null` — that is
 * how the panel's "remove from all" path works.
 */
export async function setServerApps({ serverId, apps } = {}) {
  const id = requireText(serverId, 'server_id', 200)
  const current = (await scanLocal()).find((item) => item.id === id)
  if (current === undefined) {
    throw validation('mcp.server_not_found', 'MCP server was not found', id)
  }
  const requested = requireApps(apps)
  const selected = requested.length === 0 ? [] : preflightApps(requested, current.spec)
  for (const { app, paths, adapter } of adapters()) {
    if (selected.includes(app)) {
      await adapter.upsert(paths, id, current.spec)
    } else {
      await adapter.remove(paths, id).catch(() => false)
    }
  }
  return (await scanLocal()).find((item) => item.id === id) ?? null
}

/** Remove a server from the named clients, or from all eleven when `apps` is absent. */
export async function removeServer({ serverId, apps } = {}) {
  const id = requireText(serverId, 'server_id', 200)
  const selected = apps === undefined || apps === null ? MCP_APPS : requireApps(apps)
  let removed = false
  for (const { app, paths, adapter } of adapters()) {
    if (selected.includes(app)) {
      removed = (await adapter.remove(paths, id).catch(() => false)) || removed
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// marketplace.rs
// ---------------------------------------------------------------------------

/** The two providers, fixed. No discovery, no user-added registries. */
export async function listMarketplaces() {
  return [
    {
      id: OFFICIAL,
      name: 'Official MCP Registry',
      description: 'registry.modelcontextprotocol.io official MCP server registry',
    },
    { id: SMITHERY, name: 'Smithery', description: 'smithery.ai MCP server marketplace' },
  ]
}

/** Normalize a provider id, or refuse. */
function requireProvider(value) {
  const id = String(value ?? '').trim().toLowerCase()
  if (id !== OFFICIAL && id !== SMITHERY) {
    throw marketplaceInvalid(`unsupported marketplace provider: ${id || '(blank)'}`)
  }
  return id
}

/**
 * GET a marketplace URL and parse JSON, with everything a hostile endpoint could do to us
 * bounded: a 25s deadline, a byte cap, and a parse that throws rather than eval'ing.
 */
async function fetchJson(url, context) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MARKETPLACE_TIMEOUT_MS)
  let response
  try {
    response = await globalThis.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': MARKETPLACE_USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch (error) {
    clearTimeout(timer)
    throw marketplaceNetwork(`${context}: ${String(error?.message ?? error)}`)
  }
  let body
  try {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MARKETPLACE_MAX_BYTES) {
      throw marketplaceNetwork(`${context}: response is too large`)
    }
    body = new TextDecoder().decode(buffer)
  } catch (error) {
    if (error instanceof ApiError) {
      throw error
    }
    throw marketplaceNetwork(`${context}: could not read response: ${String(error?.message ?? error)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw marketplaceNetwork(`${context}: HTTP ${response.status}`)
  }
  try {
    return JSON.parse(body)
  } catch (error) {
    throw marketplaceNetwork(`${context}: invalid JSON response: ${String(error?.message ?? error)}`)
  }
}

/** A JSON value as display text, or null. Objects/arrays are re-serialized. */
function valueText(value) {
  if (typeof value === 'string') {
    return cleanText(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null || value === undefined) {
    return null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** The reference's five parameter kinds, from a JSON-schema-ish `format`/`type`. */
function parameterKind(format) {
  switch (String(format ?? 'string').trim()) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'object':
    case 'array':
      return 'json'
    default:
      return 'string'
  }
}

/** Does this parameter name look like a credential? Drives the `secret` flag. */
function secretName(key) {
  const name = String(key ?? '').toLowerCase()
  return (
    name.includes('token') ||
    name.includes('secret') ||
    name.includes('password') ||
    name.includes('api_key') ||
    name.endsWith('key')
  )
}

/** stdio first, then http, then sse — the reference's default-option ranking. */
function protocolPriority(protocol) {
  switch (normalizeMcpType(protocol)) {
    case 'stdio':
      return 0
    case 'http':
      return 1
    case 'sse':
      return 2
    default:
      return 3
  }
}

/** The best install option by that ranking, ties broken by list order. */
function defaultOption(options) {
  let best = null
  let bestRank = null
  for (let index = 0; index < options.length; index += 1) {
    const rank = protocolPriority(options[index].protocol)
    if (bestRank === null || rank < bestRank) {
      best = options[index]
      bestRank = rank
    }
  }
  return best
}

const optionId = (source, index, protocol) => `${source}:${index}:${protocol}`

/** An array of untrusted values, or `[]`. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** A string field of an untrusted object, or null. */
function asText(value) {
  return typeof value === 'string' ? cleanText(value) : null
}

/** A finite number field of an untrusted object, or null. */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A boolean field of an untrusted object; `fallback` for anything else. */
function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

/** `_meta` status `active` is what the official registry means by verified. */
function officialVerified(entry) {
  const meta = entry?._meta
  const official = isObject(meta) ? meta['io.modelcontextprotocol.registry/official'] : null
  const status = isObject(official) ? official.status : null
  return typeof status === 'string' && status.toLowerCase() === 'active'
}

/** One official-registry entry as an `McpMarketplaceItem`. */
function officialItem(entry) {
  const server = isObject(entry?.server) ? entry.server : {}
  const repository = isObject(server.repository) ? server.repository : {}
  const remotes = asArray(server.remotes)
  const packages = asArray(server.packages)
  const protocols = new Set()
  for (const transport of remotes) {
    const kind = normalizeMcpType(isObject(transport) ? transport.type : '')
    if (kind !== null) {
      protocols.add(kind)
    }
  }
  for (const item of packages) {
    const kind = normalizeMcpType(isObject(item?.transport) ? item.transport.type : '')
    if (kind !== null) {
      protocols.add(kind)
    }
  }
  const name = asText(server.name) ?? ''
  return {
    provider_id: OFFICIAL,
    server_id: name,
    name: asText(server.title) ?? name,
    description: asText(server.description) ?? 'No description',
    homepage: asText(server.websiteUrl) ?? asText(repository.url),
    remote: remotes.length > 0,
    verified: officialVerified(entry),
    icon_url:
      asArray(server.icons)
        .map((icon) => (isObject(icon) ? asText(icon.src) : null))
        .find((src) => src !== null) ?? null,
    latest_version: asText(server.version),
    // Sorted, because the reference collects into a BTreeSet.
    protocols: Array.from(protocols).sort(),
    owner: null,
    namespace: null,
    downloads: null,
    score: null,
    is_deployed: null,
  }
}

/** An `environmentVariables` entry as an install parameter. */
function officialParameter(key, parameter) {
  const raw = isObject(parameter) ? parameter : {}
  const literal = asText(raw.value) ?? asText(raw.default)
  let defaultValue = null
  if (literal !== null) {
    try {
      defaultValue = JSON.parse(literal)
    } catch {
      defaultValue = literal
    }
  }
  return {
    key,
    label: key,
    description: asText(raw.description),
    required: asBool(raw.isRequired),
    secret: asBool(raw.isSecret) || secretName(asText(raw.name) ?? ''),
    kind: parameterKind(asText(raw.format)),
    default_value: defaultValue,
    placeholder: asText(raw.valueHint),
    enum_values: [],
    location: null,
  }
}

/** A `runtimeArguments`/`packageArguments` entry as an install parameter. */
function argumentParameter(key, argument) {
  const raw = isObject(argument) ? argument : {}
  const literal = asText(raw.value) ?? asText(raw.default)
  return {
    key,
    label: key,
    description: asText(raw.description),
    required: asBool(raw.isRequired),
    secret: false,
    kind: parameterKind(asText(raw.format)),
    default_value: literal,
    placeholder: asText(raw.valueHint),
    enum_values: [],
    location: null,
  }
}

/** Header/variable declarations, which arrive as either an array or an object. */
function parameterEntries(value, location) {
  const result = []
  const push = (key, raw) => {
    const object = isObject(raw) ? raw : null
    const fallbackDefault =
      object === null ? (raw === null || raw === undefined ? null : cloneJson(raw)) : (cloneJson(object.default) ?? cloneJson(object.value) ?? null)
    result.push({
      key,
      label: key,
      description: object === null ? null : asText(object.description),
      required: object === null ? false : asBool(object.isRequired),
      secret: (object !== null && asBool(object.isSecret)) || secretName(key),
      kind: 'string',
      default_value: fallbackDefault,
      placeholder: null,
      enum_values: [],
      location,
    })
  }
  if (Array.isArray(value)) {
    value.forEach((raw, index) => {
      const key = (isObject(raw) ? asText(raw.name) : null) ?? `${location}.${index}`
      push(key, raw)
    })
  } else if (isObject(value)) {
    for (const [key, raw] of Object.entries(value)) {
      push(key, raw)
    }
  }
  return result
}

/** The command an npm/pypi package is launched with; `null` when we cannot tell. */
function packageRuntime(item) {
  const hint = asText(item.runtimeHint)
  if (hint !== null) {
    return hint
  }
  switch (asText(item.registryType)) {
    case 'npm':
      return 'npx'
    case 'pypi':
      return 'uvx'
    default:
      return null
  }
}

/** `identifier@version`, or just the identifier. */
function packageIdentifier(item) {
  const identifier = asText(item.identifier) ?? ''
  const version = asText(item.version)
  return version === null ? identifier : `${identifier}@${version}`
}

/** The install options an official-registry server exposes: remotes, then stdio packages. */
function officialOptions(server) {
  const options = []
  asArray(server?.remotes).forEach((raw, index) => {
    const transport = isObject(raw) ? raw : {}
    const protocol = normalizeMcpType(transport.type)
    const url = asText(transport.url)
    if (protocol === null || url === null) {
      return
    }
    const parameters = parameterEntries(transport.headers, 'header')
    for (const candidate of parameterEntries(transport.variables, 'query')) {
      if (!parameters.some((item) => item.key === candidate.key)) {
        parameters.push(candidate)
      }
    }
    options.push({
      id: optionId('official:remote', index, protocol),
      protocol,
      label: 'Remote transport',
      description: null,
      spec: { type: protocol, url },
      parameters,
    })
  })
  asArray(server?.packages).forEach((raw, index) => {
    const item = isObject(raw) ? raw : {}
    if (normalizeMcpType(isObject(item.transport) ? item.transport.type : '') !== 'stdio') {
      return
    }
    const runtime = packageRuntime(item)
    if (runtime === null) {
      return
    }
    const runtimeArguments = asArray(item.runtimeArguments)
    const packageArguments = asArray(item.packageArguments)
    const parameters = [
      ...runtimeArguments.map((argument, at) => argumentParameter(`runtime_arguments.${at}`, argument)),
      ...packageArguments.map((argument, at) => argumentParameter(`package_arguments.${at}`, argument)),
      ...asArray(item.environmentVariables).map((variable) =>
        officialParameter(`env.${(isObject(variable) ? asText(variable.name) : null) ?? ''}`, variable),
      ),
    ]
    const literalArg = (argument) => {
      const raw2 = isObject(argument) ? argument : {}
      return asText(raw2.value) ?? asText(raw2.default) ?? ''
    }
    options.push({
      id: optionId('official:package', index, 'stdio'),
      protocol: 'stdio',
      label: `${asText(item.registryType) ?? 'package'} package`,
      description: null,
      spec: {
        type: 'stdio',
        command: runtime,
        args: [
          ...runtimeArguments.map(literalArg),
          packageIdentifier(item),
          ...packageArguments.map(literalArg),
        ],
      },
      parameters,
    })
  })
  return options
}

/**
 * A registry server id is ONE path segment even when it contains slashes.
 *
 * `com.example/my-server` has to reach the API as `com.example%2Fmy-server`; letting it
 * through as a slash would address a different resource entirely.
 */
function officialDetailUrl(serverId) {
  return `${OFFICIAL_SERVERS_URL}/${encodeURIComponent(serverId)}/versions/latest`
}

function smitheryDetailUrl(serverId) {
  return `${SMITHERY_SERVERS_URL}/${encodeURIComponent(serverId)}`
}

/** Smithery's connection kinds collapse to sse or http; there is no stdio there. */
function smitheryProtocol(connection) {
  return normalizeMcpType(isObject(connection) ? connection.type : '') === 'sse' ? 'sse' : 'http'
}

/** A Smithery `configSchema` as install parameters. */
function smitheryParameters(connection) {
  const schema = isObject(connection?.configSchema) ? connection.configSchema : null
  const properties = isObject(schema?.properties) ? schema.properties : null
  if (properties === null) {
    return []
  }
  const required = new Set(asArray(schema.required).filter((item) => typeof item === 'string'))
  return Object.entries(properties).map(([key, value]) => {
    const property = isObject(value) ? value : {}
    const secret = asBool(property.writeOnly) || secretName(key)
    const fromHeader = String(property['x-from'] ?? '').toLowerCase() === 'header'
    return {
      key,
      label: key,
      description: asText(property.description),
      required: required.has(key),
      secret,
      kind: parameterKind(asText(property.type)),
      default_value: property.default === undefined ? null : cloneJson(property.default),
      placeholder: null,
      enum_values: asArray(property.enum).filter((item) => typeof item === 'string'),
      location: fromHeader || secret ? 'header' : 'query',
    }
  })
}

/** The install options a Smithery server exposes. */
function smitheryOptions(detail) {
  const options = []
  asArray(detail?.connections).forEach((raw, index) => {
    const connection = isObject(raw) ? raw : {}
    const url = asText(connection.deploymentUrl) ?? asText(detail?.deploymentUrl)
    if (url === null) {
      return
    }
    const protocol = smitheryProtocol(connection)
    let spec
    try {
      spec = normalizeSpec({ type: protocol, url }, 'Smithery connection')
    } catch {
      return
    }
    options.push({
      id: optionId('smithery:connection', index, protocol),
      protocol,
      label: `${protocol} connection ${index + 1}`,
      description: asText(connection.deploymentUrl),
      spec,
      parameters: smitheryParameters(connection),
    })
  })
  return options
}

/** Search one provider. `query` and `limit` are optional; limit is clamped to [1, 100]. */
export async function searchMarketplace({ providerId, query, limit } = {}) {
  const provider = requireProvider(providerId)
  const search = optionalText(query, 200)
  const size = boundedInt(limit, 1, 100, 30)
  if (provider === OFFICIAL) {
    const url = new URL(OFFICIAL_SERVERS_URL)
    url.searchParams.set('limit', String(size))
    url.searchParams.set('version', 'latest')
    url.searchParams.set('search', search)
    const payload = await fetchJson(url.toString(), 'official registry response')
    return asArray(payload?.servers)
      .map((entry) => {
        try {
          return officialItem(entry)
        } catch {
          return null
        }
      })
      .filter((item) => item !== null && item.server_id.length > 0)
  }
  const url = new URL(SMITHERY_SERVERS_URL)
  url.searchParams.set('q', search)
  url.searchParams.set('limit', String(size))
  const payload = await fetchJson(url.toString(), 'Smithery response')
  return asArray(payload?.servers)
    .map((raw) => {
      const item = isObject(raw) ? raw : {}
      const serverId = asText(item.qualifiedName)
      if (serverId === null) {
        return null
      }
      return {
        provider_id: SMITHERY,
        server_id: serverId,
        name: asText(item.displayName) ?? serverId,
        description: asText(item.description) ?? 'No description',
        homepage: asText(item.homepage),
        remote: asBool(item.remote),
        verified: asBool(item.verified),
        icon_url: asText(item.iconUrl),
        latest_version: null,
        protocols: asBool(item.remote) ? ['http'] : ['stdio'],
        owner: asText(item.owner),
        namespace: asText(item.namespace),
        downloads: asNumber(item.useCount),
        score: asNumber(item.score),
        is_deployed: typeof item.isDeployed === 'boolean' ? item.isDeployed : null,
      }
    })
    .filter((item) => item !== null)
}

/** One server's full detail, including every install option and the default choice. */
export async function getMarketplaceServerDetail({ providerId, serverId } = {}) {
  const provider = requireProvider(providerId)
  const id = requireText(serverId, 'server_id', 400)
  if (provider === OFFICIAL) {
    const entry = await fetchJson(officialDetailUrl(id), 'official detail response')
    const server = isObject(entry?.server) ? entry.server : {}
    const options = officialOptions(server)
    const selected = defaultOption(options)
    if (selected === null) {
      throw marketplaceNotFound('official server has no installable transport')
    }
    return {
      ...officialItem(entry),
      default_option_id: selected.id,
      install_options: options,
      spec: cloneJson(selected.spec),
    }
  }
  const detail = await fetchJson(smitheryDetailUrl(id), 'Smithery detail response')
  const raw = isObject(detail) ? detail : {}
  const options = smitheryOptions(raw)
  const selected = defaultOption(options)
  if (selected === null) {
    throw marketplaceNotFound('Smithery server has no installable connection')
  }
  const qualified = asText(raw.qualifiedName) ?? id
  return {
    provider_id: SMITHERY,
    server_id: qualified,
    name: asText(raw.displayName) ?? qualified,
    description: asText(raw.description) ?? 'No description',
    homepage: asText(raw.homepage),
    remote: asBool(raw.remote),
    verified: asBool(raw.verified),
    icon_url: asText(raw.iconUrl),
    latest_version: null,
    protocols: options.map((option) => option.protocol),
    owner: asText(raw.owner),
    namespace: asText(raw.namespace),
    downloads: asNumber(raw.useCount),
    score: asNumber(raw.score),
    is_deployed: typeof raw.isDeployed === 'boolean' ? raw.isDeployed : null,
    default_option_id: selected.id,
    install_options: options,
    spec: cloneJson(selected.spec),
  }
}

/** Pick the install option: by explicit id, else by protocol, else the first one. */
function selectOption(options, optionIdValue, protocol) {
  const wanted = cleanText(optionIdValue)
  if (wanted !== null) {
    const found = options.find((option) => option.id === wanted)
    if (found === undefined) {
      throw marketplaceNotFound(`install option not found: ${wanted}`)
    }
    return found
  }
  const kind = normalizeMcpType(protocol ?? '')
  if (kind !== null) {
    const found = options.find((option) => option.protocol === kind)
    if (found === undefined) {
      throw marketplaceNotFound(`no install option for protocol ${kind}`)
    }
    return found
  }
  if (options.length === 0) {
    throw marketplaceNotFound('server does not expose an installable transport')
  }
  return options[0]
}

/**
 * Fold the user's parameter values into the option's spec.
 *
 * Four destinations, per the reference: `env.*` into `env`, `runtime_arguments.N` /
 * `package_arguments.N` into the argv array by index, `location: 'header'` into `headers`,
 * `location: 'query'` onto the URL's query string. Every value lands as a STRING in a
 * config file; nothing is interpolated into a command line.
 */
function applyParameterValues(spec, option, values) {
  if (values !== undefined && values !== null && !isObject(values)) {
    throw marketplaceInvalid('parameter_values must be a JSON object')
  }
  const provided = isObject(values) ? values : {}
  const output = cloneJson(spec)
  const runtimeCount = option.parameters.filter((item) => item.key.startsWith('runtime_arguments.')).length
  for (const parameter of option.parameters) {
    const value = Object.hasOwn(provided, parameter.key) ? provided[parameter.key] : parameter.default_value
    if (value === undefined || value === null) {
      if (parameter.required) {
        throw marketplaceInvalid(`missing required parameter ${parameter.key}`)
      }
      continue
    }
    const text = valueText(value)
    if (text === null) {
      continue
    }
    if (parameter.key.startsWith('env.')) {
      const name = parameter.key.slice('env.'.length)
      if (name.length === 0) {
        continue
      }
      output.env = isObject(output.env) ? output.env : {}
      output.env[name] = text
      continue
    }
    const dot = parameter.key.indexOf('.')
    const prefix = dot === -1 ? '' : parameter.key.slice(0, dot)
    if (prefix === 'runtime_arguments' || prefix === 'package_arguments') {
      const parsed = Number.parseInt(parameter.key.slice(dot + 1), 10)
      if (!Number.isFinite(parsed) || !Array.isArray(output.args)) {
        continue
      }
      // A package argument sits after the runtime args AND the package identifier.
      const index = parsed + (prefix === 'package_arguments' ? runtimeCount + 1 : 0)
      if (index < output.args.length) {
        output.args[index] = text
      } else {
        output.args.push(text)
      }
      continue
    }
    if (parameter.location === 'header') {
      output.headers = isObject(output.headers) ? output.headers : {}
      output.headers[parameter.key] = text
      continue
    }
    if (parameter.location === 'query') {
      const url = typeof output.url === 'string' ? output.url : ''
      const separator = url.includes('?') ? '&' : '?'
      output.url = `${url}${separator}${encodeURIComponent(parameter.key)}=${encodeURIComponent(text)}`
    }
  }
  return normalizeSpec(output, 'marketplace install')
}

/**
 * Fetch a marketplace server, build its spec, and write it to the selected clients.
 *
 * The server keeps the marketplace's id as its local id, which is what makes a second
 * install of the same server update the existing row instead of adding a duplicate.
 */
export async function installFromMarketplace({
  providerId,
  serverId,
  apps,
  optionId: optionIdValue,
  protocol,
  parameterValues,
} = {}) {
  const selected = requireApps(apps)
  if (selected.length === 0) {
    throw marketplaceInvalid('at least one target client is required')
  }
  const detail = await getMarketplaceServerDetail({ providerId, serverId })
  const option = selectOption(detail.install_options, optionIdValue, protocol)
  const spec = applyParameterValues(option.spec, option, parameterValues)
  return upsertLocalServer({ serverId: detail.server_id, spec, apps: selected })
}
