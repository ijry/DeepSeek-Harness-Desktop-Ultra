/**
 * Stashes: the list, one entry's diff, and create / apply / pop / drop / branch.
 *
 * `git stash list` is parsed from `--pretty` fields rather than from its default
 * prose, so a stash message containing `:` (very common — the default message is
 * `WIP on main: abc1234 subject`) does not confuse the split.
 *
 * @module dsh-plugin-otools-git/host/stash
 */
import { normalizeEnum } from '../shared/protocol.js'
import { gitFailure, runGit, tryGit } from './git.js'
import { classifyDiff, parseNameStatusZ, parseNumstatZ } from './diff.js'

/**
 * Field separator inside one `stash list` record, written into the format string
 * as `%x1f` — the same control character host/history.js uses, for the same
 * reason: a stash message may contain anything a commit message may.
 */
const FIELD_SEP = '\u001f'

/**
 * List stashes.
 *
 * The ref is built as `stash@{N}` from the enumeration order rather than read
 * from `%gd`: a reflog selector honours `--date=`, so asking for a formatted date
 * in the same call turns `stash@{0}` into `stash@{2026-09-05 15:20}` — which is a
 * legal selector git accepts, but not one that survives a re-list.
 */
export async function listStashes(root) {
  const format = ['%H', '%gs', '%an', '%ad', '%s'].join('%x1f')
  const result = await tryGit(root, [
    'stash', 'list', `--pretty=format:${format}`, '--date=format:%Y-%m-%d %H:%M',
  ], { timeoutMs: 60_000 })
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const [oid, reflogSubject, author, date, subject] = line.split(FIELD_SEP)
      return {
        index,
        refName: `stash@{${index}}`,
        oid,
        message: reflogSubject ?? subject ?? '',
        subject,
        author,
        date,
      }
    })
}

/** One stash's changed-file list with +/- counts. */
export async function stashSummary(root, ref) {
  const [nameStatus, numstat] = await Promise.all([
    tryGit(root, ['stash', 'show', '--name-status', '-z', '-M', ref], { timeoutMs: 60_000 }),
    tryGit(root, ['stash', 'show', '--numstat', '-z', '-M', ref], { timeoutMs: 60_000 }),
  ])
  const rows = parseNameStatusZ(nameStatus.stdout)
  const stats = parseNumstatZ(numstat.stdout)
  for (const row of rows) {
    const stat = stats.get(row.path)
    row.additions = stat === undefined ? 0 : stat.additions
    row.deletions = stat === undefined ? 0 : stat.deletions
    row.binary = stat === undefined ? false : stat.binary
  }
  return rows
}

/** One stash's full diff, or one file's diff inside it. */
export async function stashDiff(root, ref, path) {
  const args = ['stash', 'show', '-p', '--no-color', '-M', ref]
  if (typeof path === 'string' && path.length > 0) args.push('--', path)
  const result = await tryGit(root, args, { timeoutMs: 120_000 })
  return classifyDiff(result.stdout)
}

/** Create a stash. */
export async function createStash(root, options = {}) {
  const args = ['stash', 'push']
  if (options.includeUntracked === true) args.push('--include-untracked')
  if (options.all === true) args.push('--all')
  if (options.keepIndex === true) args.push('--keep-index')
  if (typeof options.message === 'string' && options.message.length > 0) args.push('-m', options.message)
  if (Array.isArray(options.paths) && options.paths.length > 0) args.push('--', ...options.paths)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  if (result.code !== 0) throw gitFailure(args, result)
  const output = result.stdout.trim() || result.stderr.trim()
  return {
    output: output.length > 0 ? output : '贮藏完成',
    // "No local changes to save" is a success exit in git, so it is reported as
    // an outcome instead of being mistaken for a stash that now exists.
    noChanges: /No local changes to save/i.test(output),
  }
}

/** Apply, pop or drop a stash. */
export async function applyStash(root, ref, action, options = {}) {
  const act = normalizeEnum(action, ['apply', 'pop', 'drop'], 'action')
  const args = ['stash', act]
  if (act !== 'drop' && options.restoreIndex === true) args.push('--index')
  args.push(ref)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  if (result.code !== 0) {
    const blob = `${result.stdout}\n${result.stderr}`
    if (/CONFLICT|could not restore untracked files|needs merge/i.test(blob)) {
      return { ok: false, conflict: true, output: blob.trim() }
    }
    throw gitFailure(args, result)
  }
  return { ok: true, conflict: false, output: result.stdout.trim() || result.stderr.trim() }
}

/** Turn a stash into a new branch (`git stash branch`). */
export async function stashToBranch(root, ref, branch) {
  const args = ['stash', 'branch', branch, ref]
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  if (result.code !== 0) throw gitFailure(args, result)
  return { branch, output: result.stdout.trim() || result.stderr.trim() }
}

/** Drop every stash. */
export async function clearStashes(root) {
  await runGit({ cwd: root, args: ['stash', 'clear'], timeoutMs: 60_000 })
  return { ok: true }
}
