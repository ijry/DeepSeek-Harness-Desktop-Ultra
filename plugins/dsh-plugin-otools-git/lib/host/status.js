/**
 * Repository state and the working-tree status the panel's left pane renders.
 *
 * Everything comes from ONE `git status --porcelain=v2 --branch --show-stash -z`
 * call plus a handful of cheap probes, because the panel refreshes this on every
 * focus and after every mutation: the reference plugin polls it, and a
 * multi-command status would make that visible.
 *
 * @module dsh-plugin-otools-git/host/status
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ERR, GitError, STATUS_LETTERS } from '../shared/protocol.js'
import { gitOut, gitRecords, runGit, tryGit } from './git.js'

/** Human label for an XY letter pair, mirroring the reference's badge text. */
export function statusLabel(letter) {
  const row = STATUS_LETTERS[letter]
  return row === undefined ? '未知' : row.label
}

/**
 * The repository root of a path, or undefined when it is not in a worktree.
 *
 * Never throws. The repository tree asks this for EVERY workspace, and a
 * workspace whose folder the user has since deleted must degrade to "not a
 * repository" rather than take the whole list down.
 */
export async function repoRoot(path) {
  const result = await tryGit(path, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    .catch(() => undefined)
  if (result === undefined || result.code !== 0) return undefined
  const root = result.stdout.trim()
  return root.length === 0 ? undefined : root
}

/**
 * Is this path inside a git worktree at all? Cheaper than repoRoot when only the
 * yes/no matters. Never throws, for the same reason.
 */
export async function isRepo(path) {
  const result = await tryGit(path, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 })
    .catch(() => undefined)
  return result !== undefined && result.code === 0 && result.stdout.trim() === 'true'
}

/**
 * Which multi-step operation the repository is in the middle of. Read from the
 * marker files in `.git` rather than parsed out of prose, because `git status`
 * only says so in localized text.
 */
export async function repoState(root) {
  const gitDir = await resolveGitDir(root)
  if (gitDir === undefined) return { state: 'clean' }
  const has = (...segments) => existsSync(join(gitDir, ...segments))

  if (has('rebase-merge') || has('rebase-apply')) {
    const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply'
    const [onto, head, step, total] = await Promise.all([
      readMarker(join(gitDir, dir, 'onto')),
      readMarker(join(gitDir, dir, 'head-name')),
      readMarker(join(gitDir, dir, 'msgnum')),
      readMarker(join(gitDir, dir, 'end')),
    ])
    return {
      state: 'rebasing',
      interactive: has('rebase-merge', 'interactive'),
      onto,
      headName: head === undefined ? undefined : head.replace(/^refs\/heads\//, ''),
      step: step === undefined ? undefined : Number.parseInt(step, 10),
      total: total === undefined ? undefined : Number.parseInt(total, 10),
    }
  }
  if (has('MERGE_HEAD')) {
    return { state: 'merging', mergeHead: await readMarker(join(gitDir, 'MERGE_HEAD')) }
  }
  if (has('CHERRY_PICK_HEAD')) {
    return { state: 'cherry_picking', pickHead: await readMarker(join(gitDir, 'CHERRY_PICK_HEAD')) }
  }
  if (has('REVERT_HEAD')) {
    return { state: 'reverting', revertHead: await readMarker(join(gitDir, 'REVERT_HEAD')) }
  }
  if (has('BISECT_LOG')) return { state: 'bisecting' }
  return { state: 'clean' }
}

/** Absolute `.git` directory (handles worktrees, where it is a file). */
export async function resolveGitDir(root) {
  const result = await tryGit(root, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 10_000 })
  if (result.code !== 0) return undefined
  const dir = result.stdout.trim()
  return dir.length === 0 ? undefined : dir
}

/** First line of a marker file, or undefined. */
async function readMarker(file) {
  try {
    const text = await readFile(file, 'utf8')
    const line = text.split(/\r?\n/)[0].trim()
    return line.length === 0 ? undefined : line
  } catch {
    return undefined
  }
}

/** The prepared message git left for us (merge/squash/`.git/MERGE_MSG`). */
export async function preparedMessage(root) {
  const gitDir = await resolveGitDir(root)
  if (gitDir === undefined) return undefined
  for (const name of ['MERGE_MSG', 'SQUASH_MSG']) {
    try {
      const text = await readFile(join(gitDir, name), 'utf8')
      const cleaned = text
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim()
      if (cleaned.length > 0) return cleaned
    } catch { /* not present */ }
  }
  return undefined
}

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 *
 * The `-z` form is mandatory: a path with a space, a quote or a newline in it
 * survives nothing else, and rename entries carry two NUL-separated paths.
 */
export function parsePorcelainV2(records) {
  const out = {
    branch: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    oid: undefined,
    detached: false,
    stashCount: 0,
    entries: [],
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length === 0) continue
    const kind = record[0]

    if (kind === '#') {
      const [, key, ...rest] = record.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        out.oid = value === '(initial)' ? undefined : value
      } else if (key === 'branch.head') {
        out.detached = value === '(detached)'
        out.branch = value === '(detached)' ? undefined : value
      } else if (key === 'branch.upstream') {
        out.upstream = value
      } else if (key === 'branch.ab') {
        const match = value.match(/^\+(-?\d+)\s+-(-?\d+)$/)
        if (match !== null) {
          out.ahead = Number.parseInt(match[1], 10)
          out.behind = Number.parseInt(match[2], 10)
        }
      } else if (key === 'stash') {
        out.stashCount = Number.parseInt(value, 10) || 0
      }
      continue
    }

    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = record.split(' ')
      const xy = parts[1] ?? '  '
      const path = parts.slice(8).join(' ')
      out.entries.push(makeEntry({ xy, path, sub: parts[2] }))
      continue
    }

    if (kind === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parts = record.split(' ')
      const xy = parts[1] ?? '  '
      const score = parts[8] ?? ''
      const path = parts.slice(9).join(' ')
      const origPath = records[index + 1]
      index += 1
      out.entries.push(makeEntry({
        xy,
        path,
        sub: parts[2],
        origPath,
        similarity: Number.parseInt(score.slice(1), 10) || undefined,
        renameKind: score.slice(0, 1) === 'C' ? 'copy' : 'rename',
      }))
      continue
    }

    if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      const path = parts.slice(10).join(' ')
      out.entries.push(makeEntry({ xy, path, sub: parts[2], conflicted: true }))
      continue
    }

    if (kind === '?' || kind === '!') {
      const path = record.slice(2)
      out.entries.push(makeEntry({ xy: kind === '?' ? '??' : '!!', path }))
    }
  }
  return out
}

/** One status row in the shape the browser renders. */
function makeEntry(input) {
  // Porcelain v2 writes `.` where v1 wrote a space for "unmodified on this side".
  // Normalizing here means every consumer — the grouping below, the badge in the
  // browser, the discard/stage split — can test against a single alphabet.
  const xy = (input.xy ?? '..').replace(/\./g, ' ')
  const index = xy[0] ?? ' '
  const worktree = xy[1] ?? ' '
  const untracked = xy === '??'
  const ignored = xy === '!!'
  const conflicted = input.conflicted === true || (index === 'U' || worktree === 'U' || xy === 'AA' || xy === 'DD')
  return {
    path: input.path,
    origPath: input.origPath,
    xy,
    index,
    worktree,
    // A submodule entry's `sub` field starts with `S` (`N...` means not one).
    submodule: typeof input.sub === 'string' && input.sub.startsWith('S'),
    staged: !untracked && !ignored && index !== ' ' && index !== '?',
    unstaged: untracked || (worktree !== ' ' && worktree !== '?'),
    untracked,
    ignored,
    conflicted,
    renameKind: input.renameKind,
    similarity: input.similarity,
    indexLabel: statusLabel(index),
    worktreeLabel: statusLabel(worktree),
  }
}

/** Group parsed entries into the four sections the status panel shows. */
export function groupEntries(entries) {
  const groups = { conflicted: [], staged: [], unstaged: [], untracked: [] }
  for (const entry of entries) {
    if (entry.ignored) continue
    if (entry.conflicted) {
      groups.conflicted.push(entry)
      continue
    }
    if (entry.untracked) {
      groups.untracked.push(entry)
      continue
    }
    if (entry.staged) groups.staged.push(entry)
    if (entry.worktree !== ' ') groups.unstaged.push(entry)
  }
  const byPath = (a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN')
  for (const key of Object.keys(groups)) groups[key].sort(byPath)
  return groups
}

/**
 * The full status payload for one repository.
 *
 * @param root - repository worktree root.
 * @param options - `{ untracked: 'all'|'normal'|'no', ignored?: boolean }`
 */
export async function readStatus(root, options = {}) {
  const untracked = options.untracked === 'no' || options.untracked === 'normal' ? options.untracked : 'all'
  const args = [
    'status', '--porcelain=v2', '--branch', '--show-stash', '-z',
    `--untracked-files=${untracked}`,
  ]
  if (options.ignored === true) args.push('--ignored=matching')
  const records = await gitRecords(root, args, { timeoutMs: 120_000 })
  const parsed = parsePorcelainV2(records)
  const [state, head] = await Promise.all([repoState(root), readHead(root)])

  return {
    root,
    name: basename(root),
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    oid: parsed.oid,
    shortOid: parsed.oid === undefined ? undefined : parsed.oid.slice(0, 7),
    headSubject: head.subject,
    headAuthor: head.author,
    headDate: head.date,
    unborn: parsed.oid === undefined,
    stashCount: parsed.stashCount,
    repoState: state,
    groups: groupEntries(parsed.entries),
    counts: countOf(parsed.entries),
  }
}

/** Section sizes, so a collapsed panel can still show its badges. */
export function countOf(entries) {
  const groups = groupEntries(entries)
  return {
    conflicted: groups.conflicted.length,
    staged: groups.staged.length,
    unstaged: groups.unstaged.length,
    untracked: groups.untracked.length,
    total: groups.conflicted.length + groups.staged.length + groups.unstaged.length + groups.untracked.length,
  }
}

/** HEAD's subject/author/date, or blanks on an unborn branch. */
export async function readHead(root) {
  const result = await tryGit(root, ['log', '-1', '--pretty=format:%s%x00%an%x00%aI'], { timeoutMs: 15_000 })
  if (result.code !== 0) return {}
  const [subject, author, date] = result.stdout.split('\0')
  return { subject, author, date }
}

/** Short one-line summary used by the repository tree rows. */
export async function readBrief(root) {
  const records = await gitRecords(root, [
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
  ], { timeoutMs: 60_000 })
  const parsed = parsePorcelainV2(records)
  const counts = countOf(parsed.entries)
  const state = await repoState(root)
  return {
    root,
    name: basename(root),
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    shortOid: parsed.oid === undefined ? undefined : parsed.oid.slice(0, 7),
    dirty: counts.total > 0,
    counts,
    repoState: state.state,
  }
}

/** `git rev-parse --verify` as a boolean. */
export async function refExists(root, ref) {
  const result = await tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{}`], { timeoutMs: 10_000 })
  return result.code === 0
}

/** Fail loud when a path is not a repository — the message the panel shows. */
export async function requireRepo(path) {
  const root = await repoRoot(path)
  if (root === undefined) throw new GitError(ERR.notRepo, `${path} 不是一个 git 仓库`)
  return root
}

/** `git rev-parse HEAD`, or undefined on an unborn branch. */
export async function headOid(root) {
  const result = await tryGit(root, ['rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

/** The current branch name, or undefined when detached. */
export async function currentBranch(root) {
  const name = await gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  return name === 'HEAD' || name.length === 0 ? undefined : name
}

/** Whether the worktree has any change at all (staged or not). */
export async function isDirty(root) {
  const result = await runGit({ cwd: root, args: ['status', '--porcelain', '-z'], timeoutMs: 60_000 })
  return result.stdout.length > 0
}
