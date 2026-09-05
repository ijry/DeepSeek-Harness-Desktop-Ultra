/**
 * HTTP envelope helpers shared by the read routes and the action routes.
 *
 * Kept in its own module so `actions.js` does not have to import from
 * `routes.js` (which imports it back) — a cycle ESM would tolerate but nobody
 * should have to reason about.
 *
 * @module dsh-plugin-otools-git/host/http
 */
import { ERR, GitError, normalizeRepoPath, normalizeRevision, statusOf } from '../shared/protocol.js'

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Envelope writer. */
export function json(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** `{ ok: true }` writer. */
export function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/** `{ ok: false }` writer. */
export function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Map any thrown value onto the failure envelope. */
export function envelopeOfError(error) {
  if (error instanceof GitError) {
    return {
      code: error.code,
      message: error.message,
      // The repairable-error hint travels with the envelope so the browser can
      // offer the one-click fix instead of just printing git's complaint.
      dubious: error.dubious,
      status: statusOf(error.code),
    }
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-otools-git] route error:', message)
  return { code: ERR.internal, message, status: 500 }
}

/** Read one JSON body (`{}` when empty; null on parse failure). */
export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new GitError(ERR.invalidInput, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A required query parameter. */
export function requireParam(params, name) {
  const value = params.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitError(ERR.invalidInput, `${name} is required`)
  }
  return value
}

/**
 * The validators for the GET side.
 *
 * These exist because the POST side validated everything and the GET side did
 * not, which was a hole rather than an oversight: `rev`, `branch` and `ref` all
 * reach a `git` argv, and git accepts options anywhere. `?rev=--output=<file>`
 * truncates that file; `?rev=--contents=<file>` makes `git blame` read it and
 * echo it back. Every revision-ish and path-ish query parameter now goes through
 * the same normalizers the POST bodies use.
 */
export function requireRev(params, name = 'rev') {
  return normalizeRevision(requireParam(params, name), name)
}

/** An optional revision parameter. */
export function optionalRev(params, name) {
  const value = params.get(name)
  if (typeof value !== 'string' || value.length === 0) return undefined
  return normalizeRevision(value, name)
}

/** A required repository-relative path parameter. */
export function requirePath(params, name = 'path') {
  return normalizeRepoPath(requireParam(params, name), name)
}

/** An optional repository-relative path parameter. */
export function optionalPath(params, name) {
  const value = params.get(name)
  if (typeof value !== 'string' || value.length === 0) return undefined
  return normalizeRepoPath(value, name)
}

/** A `stash@{N}` reference, validated by shape (see actions.js for the why). */
export function requireStashRef(params, name = 'ref') {
  const text = requireParam(params, name)
  if (!/^stash@\{\d{1,6}\}$/.test(text)) {
    throw new GitError(ERR.invalidInput, 'ref must look like stash@{0}')
  }
  return text
}

/**
 * The branch selector the history pane sends: a branch name, or one of the two
 * pseudo-values. Validated as a REVISION rather than a ref name because a remote
 * branch (`origin/main`) is legal here.
 */
export function requireBranchSelector(params) {
  const value = params.get('branch')
  if (typeof value !== 'string' || value.length === 0) return 'current'
  if (value === 'all' || value === 'current') return value
  return normalizeRevision(value, 'branch')
}

/**
 * The diff source a query names. `kind` is checked against the closed set here
 * rather than passed through, because it selects the revision arguments a
 * `git diff` is built from.
 */
export function sourceOf(params) {
  const kind = params.get('kind') ?? 'worktree'
  if (kind === 'worktree' || kind === 'staged' || kind === 'head') return { kind }
  if (kind === 'commit') {
    // A merge commit is always shown against its FIRST parent — the change it
    // brought into the branch it was merged into, which is what the reference
    // showed and the only reading that is one diff rather than N.
    return { kind, rev: requireRev(params, 'rev') }
  }
  if (kind === 'range' || kind === 'two-dot') {
    return { kind, from: requireRev(params, 'from'), to: requireRev(params, 'to') }
  }
  throw new GitError(ERR.invalidInput, `unknown diff kind ${String(kind)}`)
}
