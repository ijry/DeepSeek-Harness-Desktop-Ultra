/**
 * The wire vocabulary shared by the host half and (as a hand-kept copy) the
 * browser half of dsh-plugin-otools-git: error codes, the file-status alphabet,
 * ref-name validation and the input normalizers every route reuses.
 *
 * The browser bundle cannot import this file (it has no module resolution), so
 * src/client/vocab.js repeats the parts it needs. The two copies MUST change
 * together — a drift here is a wire break, not a cosmetic one.
 *
 * @module dsh-plugin-otools-git/shared/protocol
 */

/** Stable error codes. The browser localizes these; the prose is a fallback. */
export const ERR = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  notRepo: 'not_repo',
  gitMissing: 'git_missing',
  gitError: 'git_error',
  authRequired: 'auth_required',
  sshAuth: 'ssh_auth',
  network: 'network',
  locked: 'locked',
  conflict: 'conflict',
  rejected: 'rejected',
  nothingToDo: 'nothing_to_do',
  timeout: 'timeout',
  tooLarge: 'too_large',
  aiUnavailable: 'ai_unavailable',
  internal: 'internal',
}

/** A failure with one of the codes above. */
export class GitError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

/** HTTP status for an error code. */
export function statusOf(code) {
  switch (code) {
    case ERR.invalidInput: return 400
    case ERR.notFound: return 404
    case ERR.notRepo: return 409
    case ERR.authRequired:
    case ERR.sshAuth: return 401
    case ERR.locked:
    case ERR.conflict:
    case ERR.rejected:
    case ERR.nothingToDo: return 409
    case ERR.timeout: return 504
    case ERR.tooLarge: return 413
    case ERR.network: return 502
    case ERR.aiUnavailable: return 503
    case ERR.gitMissing: return 500
    default: return 500
  }
}

// ------------------------------------------------------------------ statuses
/**
 * The porcelain-v2 XY alphabet, kept as data because both halves render it: the
 * host groups by it, the browser paints the badge.
 */
export const STATUS_LETTERS = {
  M: { key: 'modified', label: '已修改' },
  T: { key: 'typechange', label: '类型变更' },
  A: { key: 'added', label: '新增' },
  D: { key: 'deleted', label: '已删除' },
  R: { key: 'renamed', label: '已重命名' },
  C: { key: 'copied', label: '已复制' },
  U: { key: 'unmerged', label: '冲突' },
  '?': { key: 'untracked', label: '未跟踪' },
  '!': { key: 'ignored', label: '已忽略' },
  ' ': { key: 'unchanged', label: '未变更' },
}

/** Working-tree sections the status panel renders, in display order. */
export const STATUS_SECTIONS = ['conflicted', 'staged', 'unstaged', 'untracked']

/** Which repository operation is half-finished, if any. */
export const REPO_STATES = ['clean', 'merging', 'rebasing', 'cherry_picking', 'reverting', 'bisecting']

// ----------------------------------------------------------------- defaults
/** History page size options and the default. */
export const HISTORY_PAGE_SIZES = [50, 100, 200, 500]
export const DEFAULT_HISTORY_PAGE_SIZE = 100

/** Diff rendering limits. A 200k-line diff is not something a panel renders. */
export const MAX_DIFF_LINES = 20_000
export const DEFAULT_DIFF_CONTEXT = 3
export const DIFF_CONTEXT_CHOICES = [0, 1, 3, 6, 12, 25]

/** Caps on free text the browser sends. */
export const MAX_COMMIT_MESSAGE_CHARS = 20_000
export const MAX_REF_NAME_CHARS = 255
export const MAX_PATHS_PER_CALL = 5_000
export const MAX_URL_CHARS = 2_048

/** How much diff text the AI commit-message writer is allowed to read. */
export const AI_DIFF_BUDGET_CHARS = 48_000

// -------------------------------------------------------------- normalizers
/** A required non-empty string, capped. */
export function normalizeText(value, label, max = 1_000) {
  if (typeof value !== 'string') throw new GitError(ERR.invalidInput, `${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new GitError(ERR.invalidInput, `${label} is required`)
  if (trimmed.length > max) throw new GitError(ERR.invalidInput, `${label} must be at most ${max} characters`)
  return trimmed
}

/** An optional string: undefined when absent or blank. */
export function normalizeOptionalText(value, label, max = 1_000) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new GitError(ERR.invalidInput, `${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > max) throw new GitError(ERR.invalidInput, `${label} must be at most ${max} characters`)
  return trimmed
}

/**
 * A commit message. Only the outer whitespace goes — internal blank lines are
 * the body/subject separator and trailing spaces inside a line may be
 * deliberate (Markdown line breaks).
 */
export function normalizeMessage(value, label = 'message') {
  if (typeof value !== 'string') throw new GitError(ERR.invalidInput, `${label} must be a string`)
  const trimmed = value.replace(/^\s+|\s+$/g, '')
  if (trimmed.length === 0) throw new GitError(ERR.invalidInput, '提交信息不能为空')
  if (trimmed.length > MAX_COMMIT_MESSAGE_CHARS) {
    throw new GitError(ERR.invalidInput, `${label} must be at most ${MAX_COMMIT_MESSAGE_CHARS} characters`)
  }
  return trimmed
}

/** A bounded positive integer with a default. */
export function normalizeCount(value, fallback, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

/** A non-negative integer offset. */
export function normalizeOffset(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/** A boolean from a query string or JSON body. */
export function normalizeFlag(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/**
 * A repository-relative path. Rejects absolute paths and any `..` segment: a
 * pathspec is spent on `git add`/`checkout --`, so escaping the worktree with it
 * would let the browser stage or discard files outside the repository.
 */
export function normalizeRepoPath(value, label = 'path') {
  if (typeof value !== 'string') throw new GitError(ERR.invalidInput, `${label} must be a string`)
  const path = value.replace(/\\/g, '/').trim()
  if (path.length === 0) throw new GitError(ERR.invalidInput, `${label} is required`)
  if (path.length > 4_096) throw new GitError(ERR.invalidInput, `${label} is too long`)
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new GitError(ERR.invalidInput, `${label} must be relative to the repository`)
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new GitError(ERR.invalidInput, `${label} must not leave the repository`)
  }
  return path
}

/** A list of repository-relative paths. */
export function normalizePaths(value, label = 'paths') {
  if (!Array.isArray(value)) throw new GitError(ERR.invalidInput, `${label} must be an array`)
  if (value.length === 0) throw new GitError(ERR.invalidInput, `${label} must not be empty`)
  if (value.length > MAX_PATHS_PER_CALL) {
    throw new GitError(ERR.invalidInput, `${label} must hold at most ${MAX_PATHS_PER_CALL} entries`)
  }
  return value.map((entry) => normalizeRepoPath(entry, label))
}

/**
 * A ref name (branch, tag, remote-tracking). Validated HERE rather than left to
 * git so a name starting with `-` can never be read as an option by any
 * subcommand this plugin builds.
 */
export function normalizeRefName(value, label = 'ref') {
  const name = normalizeText(value, label, MAX_REF_NAME_CHARS)
  if (name.startsWith('-')) throw new GitError(ERR.invalidInput, `${label} must not start with "-"`)
  if (/[\s~^:?*[\\]/.test(name)) throw new GitError(ERR.invalidInput, `${label} contains a character git forbids`)
  if (name.includes('..') || name.endsWith('/') || name.endsWith('.lock') || name.startsWith('/')) {
    throw new GitError(ERR.invalidInput, `${label} is not a valid ref name`)
  }
  if (name === '@' || name.includes('@{')) throw new GitError(ERR.invalidInput, `${label} is not a valid ref name`)
  return name
}

/**
 * A revision the caller wants to read (a commit-ish). Looser than a ref name —
 * `HEAD~3`, `abc123^{}`, `origin/main` are all legal — but still barred from
 * starting with `-` and from holding whitespace or a shell metacharacter.
 */
export function normalizeRevision(value, label = 'rev') {
  const rev = normalizeText(value, label, MAX_REF_NAME_CHARS)
  if (rev.startsWith('-')) throw new GitError(ERR.invalidInput, `${label} must not start with "-"`)
  if (/[\s;|&$`'"<>]/.test(rev)) throw new GitError(ERR.invalidInput, `${label} contains a forbidden character`)
  return rev
}

/** A remote name. Same rules as a ref, plus no slashes. */
export function normalizeRemoteName(value, label = 'remote') {
  const name = normalizeRefName(value, label)
  if (name.includes('/')) throw new GitError(ERR.invalidInput, `${label} must not contain "/"`)
  return name
}

/**
 * A remote URL. `ext::` and `fd::` are git transports that run an arbitrary
 * command, so they are refused: a URL arrives from the browser and must not be
 * able to execute anything.
 */
export function normalizeRemoteUrl(value, label = 'url') {
  const url = normalizeText(value, label, MAX_URL_CHARS)
  if (url.startsWith('-')) throw new GitError(ERR.invalidInput, `${label} must not start with "-"`)
  if (/^(ext|fd)::/i.test(url)) throw new GitError(ERR.invalidInput, '不支持 ext:: / fd:: 这类可执行传输协议')
  return url
}

/** One of a fixed set. */
export function normalizeEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new GitError(ERR.invalidInput, `${label} must be one of ${allowed.join(', ')}`)
  }
  return value
}

// ------------------------------------------------------------------ helpers
/** Short form of a 40-hex object id, as git's `--abbrev-commit` would print. */
export function shortOid(oid, length = 7) {
  const text = String(oid ?? '')
  return text.length <= length ? text : text.slice(0, length)
}

/** Whether a status entry counts as a conflict. */
export function isConflicted(entry) {
  return entry !== null && entry !== undefined && entry.conflicted === true
}

/**
 * Whether an error is git's "dubious ownership" refusal, and which paths it
 * names.
 *
 * Reported rather than acted on: the repair adds an entry to the user's GLOBAL
 * git config, so the panel asks first. Lives here (not in host/config.js) because
 * it is pure string parsing and `gitFailure` attaches it to every failure —
 * which is what lets the browser offer the fix wherever the error surfaces.
 */
export function dubiousOwnership(message) {
  const text = String(message ?? '')
  if (!/detected dubious ownership/i.test(text)) return undefined
  const paths = new Set()
  for (const match of text.matchAll(/safe\.directory\s+(\S+)/g)) paths.add(unquote(match[1]))
  for (const match of text.matchAll(/repository at '([^']+)'/g)) paths.add(unquote(match[1]))
  return paths.size === 0 ? undefined : { paths: [...paths] }
}

/** Strip the quoting git puts around a path in its messages. */
function unquote(value) {
  return String(value ?? '').trim().replace(/^["']|["']$/g, '')
}

/**
 * The subject line of a commit message: everything up to the first blank line,
 * newlines folded to spaces. Used for list rows and for the AI writer's checks.
 */
export function subjectOf(message) {
  const text = String(message ?? '')
  const cut = text.search(/\n\s*\n/)
  const head = cut === -1 ? text : text.slice(0, cut)
  return head.replace(/\s+/g, ' ').trim()
}

/**
 * Strip the wrapping a model likes to add around a commit message: a fenced
 * code block, a "Commit message:" preamble, surrounding quotes. Applied to the
 * AI writer's output so its result can go straight into the message box.
 */
export function unwrapModelText(value) {
  let text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (fence !== null) text = fence[1].trim()
  text = text.replace(/^(?:commit\s*message|提交信息|提交说明)\s*[:：]\s*/i, '').trim()
  if (text.length >= 2 && /^["'“”]/.test(text) && /["'“”]$/.test(text) && !text.includes('\n')) {
    text = text.slice(1, -1).trim()
  }
  return text
}
