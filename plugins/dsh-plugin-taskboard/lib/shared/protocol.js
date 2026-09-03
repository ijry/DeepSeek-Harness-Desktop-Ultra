/**
 * dsh-plugin-taskboard — shared domain core (statuses, columns, transitions).
 *
 * Pure functions over plain data, no I/O and no imports. Mirrors codeg-plus's
 * 任务看板 semantics (see codeg-plus src/components/tasks/board-columns.ts and
 * task-acceptance.ts):
 *
 *   todo       ← todo, queued
 *   inProgress ← preparing, running
 *   attention  ← awaiting_input, review, merging, failed
 *   done       ← done, canceled        (canceled hidden unless showCanceled)
 *
 * Board columns read freshest-first (updatedAt desc) exactly like codeg-plus;
 * moving a task to `done` is a HUMAN-only acceptance action — agents may never
 * mark a task done or canceled, only the GUI user may.
 *
 * The browser half keeps its own copy of the column table (client/index.js)
 * — change both when the vocabulary changes. A protocol test locks the mapping
 * (test/protocol.test.mjs).
 *
 * @module dsh-plugin-taskboard/shared/protocol
 */

/** The four board columns, in order (codeg-plus BOARD_COLUMN_IDS). */
export const BOARD_COLUMN_IDS = ['todo', 'inProgress', 'attention', 'done']

/** The exact statuses behind each column (codeg-plus STATUSES_BY_COLUMN). */
export const STATUSES_BY_COLUMN = {
  todo: ['todo', 'queued'],
  inProgress: ['preparing', 'running'],
  attention: ['awaiting_input', 'review', 'merging', 'failed'],
  done: ['done', 'canceled'],
}

/** Every valid status, column order. */
export const ALL_STATUSES = [
  ...new Set(BOARD_COLUMN_IDS.flatMap((column) => STATUSES_BY_COLUMN[column])),
]

/**
 * DB status → board column. `canceled` lives in the Done column but is hidden
 * unless the "show canceled" toggle is on (groupTasksByColumn).
 * @param {string} status
 * @returns {string}
 */
export function columnForStatus(status) {
  switch (status) {
    case 'todo':
    case 'queued':
      return 'todo'
    case 'preparing':
    case 'running':
      return 'inProgress'
    case 'awaiting_input':
    case 'review':
    case 'merging':
    case 'failed':
      return 'attention'
    case 'done':
    case 'canceled':
      return 'done'
    default:
      return 'todo'
  }
}

/** Whether a raw value is a valid status. */
export function isValidStatus(value) {
  return ALL_STATUSES.includes(value)
}

/**
 * Bucket tasks into the four columns; canceled tasks are dropped unless
 * `showCanceled`. Every column sorts freshest-first (updatedAt desc), tie-
 * broken by createdAt asc then id for stable ordering — the codeg-plus rule.
 * @param {Array<object>} tasks
 * @param {boolean} showCanceled
 * @returns {Record<string, Array<object>>}
 */
export function groupTasksByColumn(tasks, showCanceled) {
  const grouped = { todo: [], inProgress: [], attention: [], done: [] }
  for (const task of tasks) {
    if (task.status === 'canceled' && !showCanceled) continue
    grouped[columnForStatus(task.status)].push(task)
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(byFreshest)
  }
  return grouped
}

/** Freshest-first comparator (codeg-plus byFreshest). */
function byFreshest(a, b) {
  return (
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Statuses that count as "a session is actively working on this task" — used
 * for the claim-hold rule (a held task may only be moved by its holder or by
 * the user, mirroring dsh-taskboard's claim discipline).
 */
export const HOLD_STATUSES = ['preparing', 'running', 'awaiting_input', 'merging']

/**
 * Moves an agent session may perform with taskboard_move. Everything else is
 * rejected — most importantly `done`/`canceled` (human-only acceptance) and
 * `merging` (reserved for an execution engine). Kept close to the codeg-plus
 * lifecycle: todo → queued → preparing → running ⇄ awaiting_input → review.
 */
export const AGENT_TRANSITIONS = {
  todo: ['queued', 'preparing'],
  queued: ['preparing', 'todo'],
  preparing: ['running', 'failed', 'todo'],
  running: ['awaiting_input', 'review', 'failed', 'todo'],
  awaiting_input: ['running', 'review', 'failed'],
  review: ['running', 'failed', 'todo'],
  failed: ['todo', 'queued'],
  merging: [],
  done: [],
  canceled: [],
}

/** Whether an agent may move a task from one status to another. */
export function agentCanMove(from, to) {
  return (AGENT_TRANSITIONS[from] ?? []).includes(to)
}

/** A claim: leaving the queue and starting to work. */
export function isClaim(from, to) {
  return from === 'todo' || from === 'queued' ? to === 'preparing' : false
}

/** Human acceptance gate: only `review` may be accepted (codeg-plus). */
export function canUserAccept(status) {
  return status === 'review'
}

/** Human reject gate: only `review` may be sent back to work. */
export function canUserReject(status) {
  return status === 'review'
}

/**
 * Whether the GUI user may move a task to `to`. Users may move anywhere except
 * into `merging` (engine-reserved); terminal tasks may only be reopened to
 * `todo`.
 */
export function userCanMove(from, to) {
  if (to === 'merging') return false
  if (from === 'done' || from === 'canceled') return to === 'todo'
  return true
}

/** Whether the task is currently claimed by an agent session. */
export function isClaimedBy(task) {
  return typeof task.claimedBy === 'string' && task.claimedBy.length > 0
    ? task.claimedBy
    : undefined
}

// ---------------------------------------------------------------------------
// Record shape + construction
// ---------------------------------------------------------------------------

/** Ledger file schema version (bump on breaking record changes). */
export const LEDGER_SCHEMA_VERSION = 1

/** A brand-new empty ledger. */
export function emptyLedger() {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, tasks: [] }
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ID_LENGTH = 10

/** Short random-ish id (crypto when available, Math.random fallback). */
function randomId() {
  let out = ''
  const globalCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  const randomValues = globalCrypto !== undefined && typeof globalCrypto.getRandomValues === 'function'
    ? (array) => globalCrypto.getRandomValues(array)
    : (array) => {
      for (let i = 0; i < array.length; i++) array[i] = Math.floor(Math.random() * 256)
      return array
    }
  const bytes = new Uint8Array(ID_LENGTH)
  randomValues(bytes)
  for (let i = 0; i < bytes.length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return out
}

/** Mint a task id. */
export function newTaskId() {
  return `task_${randomId()}`
}

/** Mint a comment id. */
export function newCommentId() {
  return `c_${randomId()}`
}

/** Title validator/normalizer: 1..200 chars after trim. */
export function normalizeTitle(raw) {
  if (typeof raw !== 'string') throw new Error('title must be a string')
  const title = raw.trim()
  if (title.length === 0) throw new Error('title must not be empty')
  if (title.length > 200) throw new Error('title must be at most 200 characters')
  return title
}

/** Optional free-text normalizer (description/prompt/comment bodies). */
export function normalizeOptionalText(raw, label, maxLength = 20_000) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new Error(`${label} must be a string`)
  const text = raw.trim()
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`)
  return text
}

/** Optional workspace-id normalizer (empty string = no project binding). */
export function normalizeWorkspaceId(raw) {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw new Error('workspaceId must be a string')
  return raw.trim()
}

/**
 * Structural plausibility check for a ledger entry read from disk. Corrupt
 * records are dropped with a warning instead of taken down (store load).
 */
export function isPlausibleTaskRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) return false
  if (typeof value.title !== 'string' || value.title.length === 0) return false
  if (typeof value.status !== 'string' || !isValidStatus(value.status)) return false
  if (typeof value.version !== 'number') return false
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return false
  return true
}

/** Create a fresh task record (actor: { kind: 'user' } | { kind: 'agent', sessionId }). */
export function createTaskRecord({ title, description, prompt, workspaceId, actor, now }) {
  return {
    id: newTaskId(),
    title: normalizeTitle(title),
    description: normalizeOptionalText(description, 'description'),
    prompt: normalizeOptionalText(prompt, 'prompt'),
    workspaceId: normalizeWorkspaceId(workspaceId),
    status: 'todo',
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
    comments: [],
  }
}

/** Summaries used by change events and listings (keeps SSE payloads light). */
export function summarizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    version: task.version,
    workspaceId: task.workspaceId ?? '',
    claimedBy: typeof task.claimedBy === 'string' ? task.claimedBy : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    column: columnForStatus(task.status),
  }
}
