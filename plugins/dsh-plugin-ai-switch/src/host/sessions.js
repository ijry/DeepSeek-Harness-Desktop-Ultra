/**
 * The read-only session list: scan the agent CLIs' own transcript files on disk.
 *
 * The panel's session picker and its resume launcher both come from here. Nothing in
 * this module writes anything: it walks each CLI's transcript directory, reads the
 * head of every file it recognizes, and reports just enough to name a session and
 * resume it. Pure `node:fs` + JSON, no network.
 *
 * Transcribed from the reference's `session_manager.rs`. The panel is that app's React
 * front end unmodified, so `SessionMeta` is the one **camelCase** payload in this whole
 * domain (`providerId`, `sourcePath`, `lastActiveAt`, …) while every usage shape next
 * door in `usage.js` is snake_case. Getting the casing wrong blanks the picker with no
 * error to show.
 *
 * Three deliberate departures from the Rust, each commented where it happens:
 * `getSessionMessages` validates `sourcePath` against the scan roots (the reference
 * reads any absolute path it is handed — an arbitrary-file-read); `timestampFromValue`
 * checks all four timestamp keys instead of giving up when the first is absent; and the
 * per-file reads are collapsed into one bounded pass instead of four.
 *
 * @module dsh-plugin-ai-switch/host/sessions
 */
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { ApiError, requireText } from '../shared/protocol.js'

import { userHome } from './sdk.js'

/**
 * File cap for the session *list*, per root. Listing only needs enough recent
 * sessions to populate the picker, so a bound keeps a huge history from stalling the
 * UI. `usage.js` passes a far higher cap because a truncated scan there would
 * under-report real spend.
 */
const SESSION_LIST_FILE_LIMIT = 1000

/** Directory depth for the list walk. */
const SESSION_LIST_DEPTH = 6

/** Sessions returned after sorting; the picker never shows more. */
const SESSION_LIST_MAX = 500

/** Lines read from each file to derive a title, a timestamp and the subagent flag. */
const PREVIEW_LINE_LIMIT = 80

/** Lines searched for the session id and the project directory. */
const HEADER_LINE_LIMIT = 20

/** Lines returned by `getSessionMessages`. */
const MESSAGE_LINE_LIMIT = 2000

/** Read buffer for the line reader; big enough that a long line rarely spans chunks. */
const READ_CHUNK_BYTES = 262144

/**
 * How many transcript heads to read at once.
 *
 * Chosen for the file-descriptor table rather than for throughput: 32 open handles is
 * nothing, and past roughly this point the disk is the limit anyway.
 */
const HEAD_READ_CONCURRENCY = 32

/** Longest title the picker renders, in code points. */
const TITLE_MAX_CHARS = 72

/**
 * Resolve an env var that may hold a path, expanding a leading `~`.
 *
 * Mirrors the reference's `env_path`, used there by the Codex/Grok/Hermes/Kimi MCP
 * clients, the skills scanner and the usage scan. Shared with `usage.js`.
 */
export function envPath(name, fallback) {
  const value = String(process.env[name] ?? '').trim()
  if (value.length === 0) {
    return fallback
  }
  if (value === '~') {
    return userHome()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(userHome(), value.slice(2))
  }
  return value
}

/**
 * Every CLI transcript root, per provider id, exactly as the reference's
 * `provider_specs()` defines them — same providers, same order, same extensions.
 *
 * The env overrides are the ones the reference honours for these directories:
 * `CODEX_HOME` (`~/.codex`), `CLAUDE_CONFIG_DIR` (`~/.claude`), `GROK_HOME`
 * (`~/.grok`) and `HERMES_HOME` (`~/.hermes`). `KIMI_CODE_HOME` is honoured by the
 * reference for MCP config and skills directories only — Kimi Code writes no
 * transcripts the reference scans, so there is no root here to point at it, and
 * inventing a `kimi` provider would put a provider id in the picker that the panel's
 * platform catalog does not know.
 *
 * Resolved on call rather than frozen at import so a changed env var is honoured
 * (which is also what makes the scans testable against a temporary home).
 */
export function providerSpecs() {
  const home = userHome()
  const codexHome = envPath('CODEX_HOME', join(home, '.codex'))
  const claudeHome = envPath('CLAUDE_CONFIG_DIR', join(home, '.claude'))
  const grokHome = envPath('GROK_HOME', join(home, '.grok'))
  const hermesHome = envPath('HERMES_HOME', join(home, '.hermes'))
  return [
    { id: 'codex', roots: [join(codexHome, 'sessions'), codexHome], extensions: ['jsonl'] },
    {
      id: 'claude',
      roots: [join(claudeHome, 'projects'), join(home, '.cache', 'claude', 'projects')],
      extensions: ['jsonl'],
    },
    {
      id: 'grok',
      roots: [
        join(grokHome, 'sessions'),
        join(home, '.xai', 'sessions'),
        join(home, '.cache', 'grok', 'sessions'),
      ],
      extensions: ['json', 'jsonl'],
    },
    {
      id: 'gemini',
      roots: [join(home, '.gemini', 'tmp'), join(home, '.cache', 'gemini', 'tmp')],
      extensions: ['json', 'jsonl'],
    },
    {
      id: 'opencode',
      roots: [
        join(home, '.local', 'share', 'opencode'),
        join(home, 'AppData', 'Local', 'opencode'),
      ],
      extensions: ['json', 'jsonl'],
    },
    { id: 'openclaw', roots: [join(home, '.openclaw', 'agents')], extensions: ['jsonl'] },
    { id: 'hermes', roots: [join(hermesHome, 'sessions')], extensions: ['json', 'jsonl'] },
  ]
}

/**
 * Yield a file's lines without holding the file in memory.
 *
 * Stands in for Rust's `BufReader::lines()`: the trailing newline and a preceding
 * carriage return are stripped, a final line without a newline is still yielded, and a
 * file that cannot be opened yields nothing. Transcripts run to gigabytes, so callers
 * that need only the head `break` out and the `finally` closes the handle.
 *
 * Shared with `usage.js`.
 */
export async function* readLines(path) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return
  }
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  const decoder = new TextDecoder()
  let pending = ''
  // Where the next newline search starts, so a line spanning many chunks is not
  // rescanned from the top for every chunk.
  let searchFrom = 0
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) {
        break
      }
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      let index = pending.indexOf('\n', searchFrom)
      while (index >= 0) {
        yield stripCarriageReturn(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
      searchFrom = pending.length
    }
    pending += decoder.decode()
    if (pending.length > 0) {
      yield stripCarriageReturn(pending)
    }
  } finally {
    await handle.close()
  }
}

function stripCarriageReturn(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** The first `limit` lines of a file, or fewer. */
async function readHeadLines(path, limit) {
  const lines = []
  for await (const line of readLines(path)) {
    lines.push(line)
    if (lines.length >= limit) {
      break
    }
  }
  return lines
}

/** `JSON.parse` that yields `null` instead of throwing, for a line-per-object file. */
function parseLine(line) {
  if (line.trim().length === 0) {
    return null
  }
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Recursively collect session files under `dir`, stopping at `depth` levels or once
 * `limit` files have been gathered. Shared with `usage.js`.
 *
 * Directory symlinks below the root are not followed, where the reference's
 * `path.is_dir()` would: `getSessionMessages` validates a real path against these
 * roots, so following a link out of the tree would list files it then refuses to open.
 * The root itself is still followed, so a relocated `~/.claude` symlink works.
 */
export async function collectSessionFiles(dir, extensions, depth, limit, files) {
  if (depth === 0 || files.length >= limit) {
    return files
  }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionFiles(path, extensions, depth - 1, limit, files)
      continue
    }
    const extension = extname(path).slice(1).toLowerCase()
    if (extension.length > 0 && extensions.includes(extension)) {
      files.push(path)
    }
  }
  return files
}

/**
 * Every session the recognized CLIs have on disk, newest first.
 *
 * `platform` filters to one provider id; blank and absent both mean "all". An
 * unrecognized id yields an empty list rather than an error, matching the reference.
 *
 * @returns SessionMeta[] — camelCase, see the module header.
 */
export async function listSessions({ platform = null } = {}) {
  const wanted = String(platform ?? '').trim().toLowerCase()
  const seen = new Set()
  const jobs = []

  for (const spec of providerSpecs()) {
    if (wanted.length > 0 && wanted !== spec.id) {
      continue
    }
    for (const root of spec.roots) {
      // The cap is per root, as in the reference: a huge `~/.codex/sessions` must not
      // starve the Claude roots that come after it.
      const files = await collectSessionFiles(root, spec.extensions, SESSION_LIST_DEPTH, SESSION_LIST_FILE_LIMIT, [])
      for (const path of files) {
        if (seen.has(path)) {
          continue
        }
        seen.add(path)
        jobs.push({ providerId: spec.id, path })
      }
    }
  }

  // Read the heads concurrently. The reference does this sequentially, and on a real
  // machine (1800 transcripts) that is ~50 seconds — long enough that the sessions screen
  // looks broken. These are independent bounded reads of at most 80 lines each, so the only
  // resource at risk is the file-descriptor table, which the window below bounds.
  const sessions = (await mapConcurrent(jobs, HEAD_READ_CONCURRENCY, (job) => sessionFromFile(job.providerId, job.path)))
    .filter((session) => session !== null)

  sessions.sort((left, right) => sortKey(right) - sortKey(left))
  return sessions.slice(0, SESSION_LIST_MAX)
}

/** Run `task` over `items` with at most `limit` in flight, preserving input order. */
async function mapConcurrent(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) {
        return
      }
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function sortKey(session) {
  return session.lastActiveAt ?? session.createdAt ?? 0
}

/**
 * One session's metadata, from a single bounded pass over the file.
 *
 * The reference opens the same file four times (subagent flag, preview, session id,
 * project dir); the head it reads is identical each time, so this reads it once. The
 * per-derivation quirks are preserved individually below — they are not the same rule.
 */
async function sessionFromFile(providerId, path) {
  const lines = await readHeadLines(path, PREVIEW_LINE_LIMIT)
  const parsed = lines.map(parseLine)

  if (isSubagentSession(providerId, parsed)) {
    // Subagent transcripts are hidden from the *list* only; `usage.js` still counts
    // their tokens, because that spend is real.
    return null
  }

  const modifiedAt = await modifiedAtSeconds(path)
  const messages = []
  for (const value of parsed) {
    // A malformed line is skipped and the scan continues, unlike the header lookups.
    if (value === null) {
      continue
    }
    const message = messageFromValue(value)
    if (message !== null) {
      messages.push(message)
    }
  }

  const sessionId = extractHeaderString(parsed, SESSION_ID_KEYS) ?? fileStem(path)
  return {
    providerId,
    sessionId,
    title: titleFromMessages(messages),
    projectDir: extractHeaderString(parsed, PROJECT_DIR_KEYS) ?? basename(dirname(path)),
    createdAt: messages[0]?.ts ?? modifiedAt,
    lastActiveAt: messages[messages.length - 1]?.ts ?? modifiedAt,
    sourcePath: path,
    resumeCommand: resumeCommandFor(providerId, sessionId),
  }
}

/** Whole seconds, matching the reference's `duration_since(UNIX_EPOCH).as_secs()`. */
async function modifiedAtSeconds(path) {
  try {
    const info = await stat(path)
    return Math.floor(info.mtimeMs / 1000)
  } catch {
    return null
  }
}

function fileStem(path) {
  const name = basename(path)
  const extension = extname(name)
  return extension.length > 0 ? name.slice(0, -extension.length) : name
}

/** Where each CLI records the id it would resume, most authoritative first. */
const SESSION_ID_KEYS = [['session_id'], ['sessionId'], ['id'], ['payload', 'id']]

/** Where each CLI records the directory it was launched in. */
const PROJECT_DIR_KEYS = [
  ['cwd'],
  ['project_dir'],
  ['projectDir'],
  ['payload', 'cwd'],
  ['payload', 'project_dir'],
]

/**
 * The first string any of `paths` points at, within the file's header lines.
 *
 * A malformed line stops the search, as in the reference: its `from_str(&line).ok()?`
 * returns from the whole function, so a file whose first line is not JSON has no
 * recorded session id and falls back to the file name.
 */
function extractHeaderString(parsed, paths) {
  const limit = Math.min(parsed.length, HEADER_LINE_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    const value = parsed[index]
    if (value === null) {
      return null
    }
    for (const path of paths) {
      const found = pointer(value, path)
      if (typeof found === 'string') {
        return found
      }
    }
  }
  return null
}

/** Walk a path of object keys; anything non-object on the way yields `undefined`. */
function pointer(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = current[key]
  }
  return current
}

/**
 * True when the file is a subagent's own transcript rather than a user session.
 *
 * Only Codex and Claude Code mark these; every other provider's files are taken at
 * face value, so an unrelated `isSidechain` field cannot hide a real session.
 */
function isSubagentSession(providerId, parsed) {
  if (providerId !== 'codex' && providerId !== 'claude') {
    return false
  }
  for (const value of parsed) {
    if (value === null) {
      continue
    }
    if (providerId === 'claude' && value.isSidechain === true) {
      return true
    }
    if (providerId === 'codex' && codexSubagentMeta(value)) {
      return true
    }
  }
  return false
}

function codexSubagentMeta(value) {
  const payload = pointer(value, ['payload'])
  if (payload === null || typeof payload !== 'object') {
    return false
  }
  const source = payload.thread_source
  if (typeof source === 'string' && source.toLowerCase() === 'subagent') {
    return true
  }
  const spawn = pointer(payload, ['source', 'subagent', 'thread_spawn'])
  return spawn !== null && typeof spawn === 'object' && !Array.isArray(spawn)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const CONTENT_KEYS = ['content', 'text', 'message']
const ROLE_KEYS = ['role', 'author', 'type']

/**
 * One `SessionMessage`, from whichever of the four envelope shapes the line uses.
 *
 * Every CLI nests its message differently — at the top level, under `payload`, under
 * `message`, or under `payload.message` — so all four are tried in the reference's
 * order and the first that yields content wins.
 */
function messageFromValue(value) {
  const candidates = [
    value,
    pointer(value, ['payload']),
    pointer(value, ['message']),
    pointer(value, ['payload', 'message']),
  ]
  for (const candidate of candidates) {
    const content =
      textField(candidate, CONTENT_KEYS) ?? contentArray(pointer(candidate, ['content']))
    if (content === null) {
      continue
    }
    const role = textField(candidate, ROLE_KEYS) ?? 'message'
    return {
      role: normalizeRole(role),
      content,
      ts: timestampFromValue(value) ?? timestampFromValue(candidate),
    }
  }
  return null
}

/**
 * The first of `keys` whose value is a string, or `null` when that string is blank.
 *
 * The blank check deliberately applies *after* the search, as in the reference: a
 * present-but-empty `content` reads as "no content" rather than falling through to
 * `text`, which is what keeps an empty assistant frame from being titled by its type.
 */
function textField(value, keys) {
  if (!isObject(value)) {
    return null
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    const candidate = value[key]
    if (typeof candidate !== 'string') {
      continue
    }
    return candidate.trim().length > 0 ? candidate : null
  }
  return null
}

/** The text parts of an Anthropic/OpenAI-style content array, newline joined. */
function contentArray(value) {
  if (!Array.isArray(value)) {
    return null
  }
  const parts = []
  for (const item of value) {
    const text = textField(item, ['text', 'content'])
    if (text !== null) {
      parts.push(text)
    }
  }
  const text = parts.join('\n')
  return text.trim().length > 0 ? text : null
}

/**
 * Epoch **seconds** for a transcript line, or `null`.
 *
 * Seconds, not milliseconds: `SessionMeta.createdAt` is compared against the file's
 * mtime in seconds. `usage.js` has its own millisecond version for the time window.
 *
 * Deviation from the reference: it checks only `timestamp`, because its `value.get(key)?`
 * returns from the whole function the moment a key is absent, leaving the other three
 * unreachable. Checking all four can only add a timestamp where the reference dropped
 * one, which is strictly better for the sort order and the title.
 */
export function timestampFromValue(value) {
  if (!isObject(value)) {
    return null
  }
  for (const key of ['timestamp', 'created_at', 'createdAt', 'ts']) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate
    }
    if (typeof candidate !== 'string') {
      continue
    }
    if (/^[+-]?\d+$/.test(candidate.trim())) {
      return Number.parseInt(candidate.trim(), 10)
    }
    const millis = parseRfc3339Millis(candidate)
    if (millis !== null) {
      return Math.floor(millis / 1000)
    }
  }
  return null
}

/**
 * Epoch milliseconds for an RFC 3339 timestamp, or `null`.
 *
 * Strict where `Date.parse` is not: chrono's `parse_from_rfc3339` requires a date, a
 * time and an offset, so `2026-08` and `last tuesday` must both fail. Shared with
 * `usage.js`, which validates the `since` window with it.
 */
export function parseRfc3339Millis(text) {
  const raw = String(text ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(raw)) {
    return null
  }
  const millis = Date.parse(raw.replace(/^(\d{4}-\d{2}-\d{2})[Tt ]/, '$1T').replace(/z$/, 'Z'))
  return Number.isFinite(millis) ? millis : null
}

/** Collapse the roles every CLI spells differently onto the four the panel styles. */
function normalizeRole(role) {
  const value = role.toLowerCase()
  switch (value) {
    case 'human':
    case 'user_message':
      return 'user'
    case 'assistant_message':
    case 'ai':
      return 'assistant'
    case 'tool':
    case 'tool_result':
    case 'function_call':
      return 'tool'
    default:
      return value
  }
}

/** The first message that reads like something a human typed, as the session title. */
function titleFromMessages(messages) {
  const found = messages.find(isTitleCandidate)
  return found === undefined ? null : titleFromContent(found.content)
}

function titleFromContent(content) {
  const singleLine = content.split(/\s+/).filter((part) => part.length > 0).join(' ')
  const characters = [...singleLine]
  return characters.length > TITLE_MAX_CHARS
    ? `${characters.slice(0, TITLE_MAX_CHARS).join('')}...`
    : singleLine
}

function isTitleCandidate(message) {
  if (['assistant', 'developer', 'system', 'tool'].includes(message.role)) {
    return false
  }
  const trimmed = message.content.trim()
  return trimmed.length > 0 && !isContextBlob(trimmed)
}

/**
 * True for the boilerplate both CLIs inject as a user turn.
 *
 * Codex prepends its sandbox permissions, the environment context and AGENTS.md;
 * Claude Code records local slash-command bookkeeping wrapped in `<local-command-*>`
 * or `<command-*>`. None of it is ever a useful title.
 */
function isContextBlob(content) {
  const lower = content.toLowerCase()
  return (
    lower.startsWith('<permissions instructions>') ||
    lower.startsWith('<skills_instructions>') ||
    lower.startsWith('<environment_context>') ||
    lower.startsWith('# agents.md instructions') ||
    lower.startsWith('<instructions>') ||
    lower.includes('<local-command-') ||
    lower.startsWith('<command-name') ||
    lower.startsWith('<command-message') ||
    lower.startsWith('<command-args')
  )
}

/** The command that reopens a session in its own CLI, or `null` for an unknown id. */
export function resumeCommandFor(providerId, sessionId) {
  switch (providerId) {
    case 'codex':
      return `codex resume ${sessionId}`
    case 'claude':
      return `claude --resume ${sessionId}`
    case 'grok':
      return `grok resume ${sessionId}`
    case 'gemini':
      return `gemini --resume ${sessionId}`
    case 'opencode':
      return `opencode session ${sessionId}`
    case 'openclaw':
      return `openclaw resume ${sessionId}`
    case 'hermes':
      return `hermes resume ${sessionId}`
    default:
      return null
  }
}

/** Every scan root that exists on disk, canonicalized and deduplicated. */
export async function scanRootRealPaths() {
  const roots = []
  for (const spec of providerSpecs()) {
    for (const root of spec.roots) {
      const real = await realpathOrNull(root)
      if (real !== null && !roots.includes(real)) {
        roots.push(real)
      }
    }
  }
  return roots
}

async function realpathOrNull(path) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * Windows compares paths case-insensitively and `realpath` there also expands 8.3
 * short names, so both sides go through this before a prefix test. Without the fold, a
 * root discovered as `C:\Users\Admin\...` and a request spelled `c:\users\admin\...`
 * would read as different trees and every session would be refused.
 */
function comparablePath(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * True when `real` is `root` itself or sits beneath it.
 *
 * The separator is part of the comparison on purpose: a bare `startsWith` would accept
 * `<root>-secrets` as being inside `<root>`.
 */
function isInsideRoot(real, root) {
  const candidate = comparablePath(real)
  const prefix = comparablePath(root)
  if (candidate === prefix) {
    return true
  }
  return candidate.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`)
}

/**
 * The messages of one transcript file.
 *
 * `sourcePath` is validated against the scan roots, which the reference does not do:
 * `load_messages` opens whatever absolute path it is handed, and this panel is served
 * over dsh's web GUI rather than through a Tauri IPC boundary — an unvalidated path is
 * an arbitrary-file-read for anyone who can reach the origin. The check compares the
 * *real* path (symlinks and 8.3 names resolved) of both sides so neither a link inside
 * a root nor `..` in the request can walk out of the tree.
 *
 * `providerId` is only validated: the file's own shape says how to read it, exactly as
 * in the reference, where the parameter is `_provider_id`.
 *
 * @returns SessionMessage[]
 */
export async function getSessionMessages({ providerId, sourcePath } = {}) {
  requireText(providerId, 'providerId', 128)
  const requested = requireText(sourcePath, 'sourcePath')

  const real = await realpathOrNull(resolve(requested))
  if (real === null) {
    throw new ApiError('validation.session_path', `Session source not found: ${requested}`, {
      details: requested,
    })
  }
  const roots = await scanRootRealPaths()
  if (!roots.some((root) => isInsideRoot(real, root))) {
    throw new ApiError(
      'validation.session_path',
      'Session source is outside the scanned transcript roots',
      { details: requested },
    )
  }

  const messages = []
  try {
    let lineCount = 0
    for await (const line of readLines(real)) {
      // The cap counts lines, not messages, as the reference's `.take(2_000)` does: a
      // transcript is mostly tool traffic, so a message-based cap would read far more
      // of a huge file than the picker's preview pane can use.
      lineCount += 1
      if (lineCount > MESSAGE_LINE_LIMIT) {
        break
      }
      const value = parseLine(line)
      if (value === null) {
        continue
      }
      const message = messageFromValue(value)
      if (message !== null) {
        messages.push(message)
      }
    }
  } catch (error) {
    throw new ApiError('filesystem.session_read', `Could not read ${requested}`, {
      details: String(error?.message ?? error),
    })
  }
  return messages
}
