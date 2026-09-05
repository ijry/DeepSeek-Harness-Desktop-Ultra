/**
 * Commit history: the paged, filtered list the history table renders, the branch
 * tips that decorate its rows, and per-commit detail.
 *
 * The lane/edge geometry of the graph column is NOT computed here — it is
 * computed in the browser from each row's `parents`, exactly as the reference
 * does, so scrolling and filtering never wait on a round trip.
 *
 * @module dsh-plugin-otools-git/host/history
 */
import { normalizeOptionalText } from '../shared/protocol.js'
import { gitFailure, gitLines, runGit, tryGit } from './git.js'

/**
 * Field separator inside one log record and the record separator between them.
 * Both are control characters git will never emit from a commit's own text, so
 * a message containing newlines, tabs or `|` survives the parse. Written into
 * the format string as `%x1f` / `%x1e` escapes rather than as literal control
 * bytes, so this source file stays printable.
 */
const FIELD = '\u001f'
const RECORD = '\u001e'

/** One log record: the fields above joined by `%x1f`, terminated by `%x1e`. */
const LOG_FORMAT = [
  '%H', '%h', '%P', '%an', '%ae', '%cn', '%ce', '%ad', '%cd', '%s', '%B', '%D',
].join('%x1f') + '%x1e'

/**
 * `git log --date=` spec. `format:` (not `format-local:`) keeps the commit's own
 * timezone offset, which is what the reference renders.
 */
const DATE_SPEC_LOCAL = '--date=format:%Y-%m-%d %H:%M'

/** One parsed log record. */
function parseRecord(chunk) {
  const fields = chunk.split(FIELD)
  if (fields.length < 12) return undefined
  const [hash, short, parents, an, ae, cn, ce, ad, cd, subject, body, refs] = fields
  return {
    hash,
    shortHash: short,
    parents: parents.trim().length === 0 ? [] : parents.trim().split(/\s+/),
    author: an,
    authorEmail: ae,
    committer: cn,
    committerEmail: ce,
    date: ad,
    commitDate: cd,
    subject,
    message: body.replace(/\s+$/, ''),
    // `%D` is the decoration list ("HEAD -> main, origin/main, tag: v1"), used
    // only as a fallback; the row chips come from the branch-tip map so they can
    // be capped and de-duplicated the way the reference caps them.
    refs: refs.split(',').map((ref) => ref.trim()).filter((ref) => ref.length > 0),
  }
}

/**
 * Read a page of history.
 *
 * @param root - repository worktree root.
 * @param options - `{ limit, offset, branch, includeRemote, filters, path }`
 *   where `branch` is a branch name, `'all'` (every ref) or `'current'` (HEAD),
 *   and `filters` is `{ message, author, hash, parents, dateFrom, dateTo }`.
 */
export async function readHistory(root, options = {}) {
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit ?? 50), 10) || 50, 1), 2_000)
  const offset = Math.max(Number.parseInt(String(options.offset ?? 0), 10) || 0, 0)
  const filters = options.filters ?? {}
  // Hash and parent filters are `contains` matches git cannot express, so they
  // are applied here — which means the window read from git must be wider than
  // the page when one of them is set, or a page could come back short.
  const postFilter = hasPostFilter(filters)
  const args = ['log', `--pretty=format:${LOG_FORMAT}`, DATE_SPEC_LOCAL]

  if (postFilter) {
    // Read generously and slice after filtering. Bounded so a filter that
    // matches nothing cannot walk a 500k-commit repository forever.
    args.push(`--max-count=${Math.min(20_000, (offset + limit) * 40 + 500)}`)
  } else {
    args.push(`--max-count=${limit}`, `--skip=${offset}`)
  }

  // Literal, case-insensitive matching — the reference's filters are `contains`,
  // not regexes, and a user typing `c++` must not get a regex error.
  args.push('--fixed-strings', '--regexp-ignore-case')
  const message = normalizeOptionalText(filters.message, 'message', 500)
  if (message !== undefined) args.push(`--grep=${message}`)
  const author = normalizeOptionalText(filters.author, 'author', 500)
  if (author !== undefined) args.push(`--author=${author}`)
  const dateFrom = normalizeDate(filters.dateFrom)
  if (dateFrom !== undefined) args.push(`--since=${dateFrom} 00:00:00`)
  const dateTo = normalizeDate(filters.dateTo)
  if (dateTo !== undefined) args.push(`--until=${dateTo} 23:59:59`)

  args.push(...revisionArgs(options))

  // One `--` for the whole command: it both ends the revision list (so a branch
  // that shares a name with a file is never read as a pathspec) and opens the
  // pathspec list when a path filter is set.
  args.push('--')
  if (typeof options.path === 'string' && options.path.length > 0) {
    args.push(options.path)
  }

  const result = await runGit({ cwd: root, args, timeoutMs: 180_000, allowFailure: true })
  if (result.code !== 0) {
    // An unborn branch has no history; that is an empty list, not a failure.
    if (/does not have any commits yet|unknown revision/i.test(result.stderr)) return { rows: [], hasMore: false }
    throw gitFailure(args, result)
  }

  let rows = result.stdout
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\r?\n/, ''))
    .filter((chunk) => chunk.trim().length > 0)
    .map(parseRecord)
    .filter((row) => row !== undefined)

  if (postFilter) {
    rows = rows.filter((row) => matchesPostFilter(row, filters))
    const page = rows.slice(offset, offset + limit)
    return { rows: page, hasMore: rows.length > offset + limit }
  }
  return { rows, hasMore: rows.length === limit }
}

/** Which refs the page walks. */
function revisionArgs(options) {
  const branch = typeof options.branch === 'string' ? options.branch : 'current'
  if (branch === 'all') {
    return options.includeRemote === false ? ['--branches', '--tags'] : ['--all']
  }
  if (branch === 'current' || branch.length === 0) return ['HEAD']
  return [branch]
}

/** `YYYY-MM-DD`, or undefined. */
function normalizeDate(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
}

/** Are any filters set that git cannot express? */
function hasPostFilter(filters) {
  return normalizeOptionalText(filters.hash, 'hash', 200) !== undefined ||
    normalizeOptionalText(filters.parents, 'parents', 200) !== undefined
}

/** Case-insensitive `contains` on hash and parent list, as the reference does. */
function matchesPostFilter(row, filters) {
  const hash = normalizeOptionalText(filters.hash, 'hash', 200)
  if (hash !== undefined && !row.hash.toLowerCase().includes(hash.toLowerCase())) return false
  const parents = normalizeOptionalText(filters.parents, 'parents', 200)
  if (parents !== undefined) {
    const needle = parents.toLowerCase()
    if (!row.parents.some((parent) => parent.toLowerCase().includes(needle))) return false
  }
  return true
}

/**
 * `branch name → commit hash` for every local (and optionally remote) branch, so
 * the history rows can carry their branch chips. `origin/HEAD`-style symbolic
 * refs are dropped, matching the reference.
 */
export async function branchTips(root, includeRemote = true) {
  const args = ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname)', 'refs/heads']
  if (includeRemote) args.push('refs/remotes')
  const lines = await gitLines(root, args, { timeoutMs: 60_000, allowFailure: true })
  const tips = {}
  for (const line of lines) {
    const [refname, name, oid] = line.split('\t')
    if (refname === undefined || name === undefined || oid === undefined) continue
    // `refs/remotes/origin/HEAD` shortens to bare `origin`, so the FULL ref is
    // what identifies it; filtering the short name would keep it.
    if (refname.endsWith('/HEAD')) continue
    tips[name] = oid
  }
  return tips
}

/** `tag name → commit hash`, so history rows can also carry tag chips. */
export async function tagTips(root) {
  const lines = await gitLines(root, [
    'for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(*objectname)', 'refs/tags',
  ], { timeoutMs: 60_000, allowFailure: true })
  const tips = {}
  for (const line of lines) {
    const [name, oid, peeled] = line.split('\t')
    if (name === undefined) continue
    // An annotated tag's own object id is the tag, not the commit — `*objectname`
    // is the commit it points at.
    tips[name] = peeled !== undefined && peeled.length > 0 ? peeled : oid
  }
  return tips
}

/** Full detail for one commit, for the viewer's detail card. */
export async function commitDetail(root, rev) {
  const result = await runGit({
    cwd: root,
    args: ['show', '--no-patch', `--pretty=format:${LOG_FORMAT}`, DATE_SPEC_LOCAL, rev],
    timeoutMs: 30_000,
  })
  const parsed = parseRecord(result.stdout.split(RECORD)[0] ?? '')
  if (parsed === undefined) return undefined
  return parsed
}

/** `git log` for one file, for the file-history panel. */
export async function fileHistory(root, path, limit = 100) {
  const args = [
    'log', `--pretty=format:${LOG_FORMAT}`, DATE_SPEC_LOCAL,
    `--max-count=${Math.min(Math.max(limit, 1), 1_000)}`,
    '--follow', '--', path,
  ]
  const result = await runGit({ cwd: root, args, timeoutMs: 120_000, allowFailure: true })
  if (result.code !== 0) return []
  return result.stdout
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\r?\n/, ''))
    .filter((chunk) => chunk.trim().length > 0)
    .map(parseRecord)
    .filter((row) => row !== undefined)
}

/** `git blame --porcelain` reduced to one row per line. */
export async function blame(root, path, rev) {
  const args = ['blame', '--porcelain', '--date=format:%Y-%m-%d %H:%M']
  if (typeof rev === 'string' && rev.length > 0) args.push(rev)
  args.push('--', path)
  const result = await runGit({ cwd: root, args, timeoutMs: 120_000, allowFailure: true })
  if (result.code !== 0) return []
  return parseBlamePorcelain(result.stdout)
}

/** Parse `git blame --porcelain` into `{ oid, author, date, line, text }` rows. */
export function parseBlamePorcelain(text) {
  const lines = String(text ?? '').split('\n')
  const commits = new Map()
  const rows = []
  let current
  for (const line of lines) {
    const header = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/)
    if (header !== null) {
      current = { oid: header[1], lineNo: Number.parseInt(header[3], 10) }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('\t')) {
      const meta = commits.get(current.oid) ?? {}
      rows.push({
        oid: current.oid,
        shortOid: current.oid.slice(0, 7),
        author: meta.author,
        date: meta.date,
        summary: meta.summary,
        line: current.lineNo,
        text: line.slice(1),
      })
      current = undefined
      continue
    }
    const meta = commits.get(current.oid) ?? {}
    if (line.startsWith('author ')) meta.author = line.slice(7)
    else if (line.startsWith('author-time ')) meta.time = Number.parseInt(line.slice(12), 10)
    else if (line.startsWith('summary ')) meta.summary = line.slice(8)
    if (meta.time !== undefined && meta.date === undefined) {
      meta.date = new Date(meta.time * 1000).toISOString().slice(0, 16).replace('T', ' ')
    }
    commits.set(current.oid, meta)
  }
  return rows
}
