/**
 * Index and worktree mutations: staging, unstaging, discarding, committing, and
 * the conflict resolutions the status panel offers.
 *
 * Paths always travel after a `--` separator and are validated upstream by
 * `normalizeRepoPath`, so a file called `-f` or `../../etc/passwd` can never be
 * read as an option or escape the worktree.
 *
 * @module dsh-plugin-otools-git/host/commit
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ERR, GitError, normalizeEnum } from '../shared/protocol.js'
import { gitFailure, runGit, tryGit } from './git.js'

/**
 * Stage paths. `git add -A` (not plain `add`) so a deletion is staged as a
 * deletion — the reference had to special-case that with libgit2 and this is the
 * CLI equivalent.
 */
export async function stagePaths(root, paths) {
  await runGit({ cwd: root, args: ['add', '-A', '--', ...paths], timeoutMs: 300_000 })
  return { staged: paths.length }
}

/** Stage everything, including untracked files. */
export async function stageAll(root) {
  await runGit({ cwd: root, args: ['add', '-A'], timeoutMs: 600_000 })
  return { ok: true }
}

/**
 * git's ways of saying "there is no HEAD yet". Matched rather than guessed at:
 * `restore --staged` says "could not resolve 'HEAD'", `reset` says "does not have
 * any commits yet", and `rev-parse` says "unknown revision" — all three mean the
 * same thing and all three need the `rm --cached` path instead.
 */
const NO_HEAD_RE = /unknown revision|does not have any commits yet|ambiguous argument 'HEAD'|could not resolve 'HEAD'|needed a single revision/i

/**
 * Unstage paths. `restore --staged` rather than `reset` because on an unborn
 * branch there is no HEAD to reset against; `rm --cached` covers that case.
 */
export async function unstagePaths(root, paths) {
  const result = await tryGit(root, ['restore', '--staged', '--', ...paths], { timeoutMs: 300_000 })
  if (result.code === 0) return { unstaged: paths.length }
  if (NO_HEAD_RE.test(result.stderr)) {
    await runGit({ cwd: root, args: ['rm', '--cached', '-r', '--', ...paths], timeoutMs: 300_000 })
    return { unstaged: paths.length }
  }
  throw gitFailure(['restore', '--staged'], result)
}

/** Unstage everything. */
export async function unstageAll(root) {
  const result = await tryGit(root, ['reset'], { timeoutMs: 300_000 })
  if (result.code === 0) return { ok: true }
  if (NO_HEAD_RE.test(result.stderr)) {
    await runGit({ cwd: root, args: ['rm', '-r', '--cached', '.'], timeoutMs: 300_000 })
    return { ok: true }
  }
  throw gitFailure(['reset'], result)
}

/**
 * Discard worktree changes for tracked paths and DELETE untracked ones.
 *
 * The two halves are separated by the caller (which knows each path's status)
 * because they are not the same act: `restore` cannot remove a file git has
 * never seen, and deleting a tracked file would be data loss beyond "discard".
 *
 * @param options - `{ tracked: string[], untracked: string[], staged?: boolean }`
 */
export async function discardPaths(root, options) {
  const tracked = options.tracked ?? []
  const untracked = options.untracked ?? []
  if (tracked.length > 0) {
    const args = ['restore']
    // `--staged --worktree` throws away the staged copy too, which is what the
    // panel's "重置" on a staged row means.
    if (options.staged === true) args.push('--staged', '--worktree', '--source=HEAD')
    args.push('--', ...tracked)
    const result = await tryGit(root, args, { timeoutMs: 300_000 })
    if (result.code !== 0) {
      // On an unborn branch there is nothing to restore FROM; the file only
      // exists in the index, so dropping it there is the whole discard.
      if (!NO_HEAD_RE.test(result.stderr)) {
        throw gitFailure(args, result)
      }
      await runGit({ cwd: root, args: ['rm', '-f', '--', ...tracked], timeoutMs: 300_000 })
    }
  }
  for (const path of untracked) {
    // Resolved against the root and re-checked: normalizeRepoPath already
    // rejected `..`, and this is the second lock on the only place in the host
    // half that deletes a file outright.
    const full = resolve(join(root, path))
    if (!isInside(root, full)) {
      throw new GitError(ERR.invalidInput, `${path} 不在仓库内，拒绝删除`)
    }
    await rm(full, { recursive: true, force: true })
  }
  return { discarded: tracked.length + untracked.length }
}

/** Discard every worktree change; optionally also remove untracked files. */
export async function discardAll(root, options = {}) {
  await runGit({ cwd: root, args: ['reset', '--hard'], timeoutMs: 300_000 })
  if (options.includeUntracked === true) {
    const args = ['clean', '-fd']
    if (options.includeIgnored === true) args.push('-x')
    await runGit({ cwd: root, args, timeoutMs: 300_000 })
  }
  return { ok: true }
}

/**
 * Commit the index.
 *
 * The message goes in on stdin via `-F -`, never as `-m`: a message with a
 * newline, a leading dash or 10 KB of body text survives that and nothing else.
 * `GIT_EDITOR=true` guarantees no hook or `--amend` path can open an editor the
 * host has no terminal for.
 *
 * @param options - `{ message, amend?, allowEmpty?, signoff?, noVerify?,
 *   authorName?, authorEmail?, resetAuthor? }`
 */
export async function commit(root, options) {
  const args = ['commit', '-F', '-', '--cleanup=strip']
  if (options.amend === true) args.push('--amend')
  if (options.allowEmpty === true) args.push('--allow-empty')
  if (options.signoff === true) args.push('--signoff')
  if (options.noVerify === true) args.push('--no-verify')
  if (options.resetAuthor === true) args.push('--reset-author')
  if (typeof options.authorName === 'string' && options.authorName.length > 0 &&
      typeof options.authorEmail === 'string' && options.authorEmail.length > 0) {
    args.push(`--author=${options.authorName} <${options.authorEmail}>`)
  }

  const result = await runGit({
    cwd: root,
    args,
    input: `${options.message}\n`,
    timeoutMs: 300_000,
    allowFailure: true,
    env: { GIT_EDITOR: 'true' },
  })
  if (result.code !== 0) {
    const blob = `${result.stdout}\n${result.stderr}`
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(blob)) {
      throw new GitError(ERR.nothingToDo, '没有需要提交的改动')
    }
    if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(blob)) {
      throw new GitError(ERR.invalidInput, 'Git 用户名或邮箱未配置，请先在设置里填写 user.name 与 user.email')
    }
    throw gitFailure(args, result)
  }
  const oid = await tryGit(root, ['rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  return {
    output: result.stdout.trim() || result.stderr.trim(),
    oid: oid.code === 0 ? oid.stdout.trim() : undefined,
  }
}

/**
 * The message of the commit being amended, so the box can be pre-filled the way
 * `git commit --amend` would.
 */
export async function headMessage(root) {
  const result = await tryGit(root, ['log', '-1', '--pretty=format:%B'], { timeoutMs: 15_000 })
  return result.code === 0 ? result.stdout.replace(/\s+$/, '') : ''
}

/** Resolve a conflicted path by taking one side wholesale. */
export async function resolveConflict(root, paths, side) {
  const which = normalizeEnum(side, ['ours', 'theirs', 'union'], 'side')
  if (which === 'union') {
    // `--union` is a merge-file mode, not a checkout stage; re-running the merge
    // driver per file is the only way to get it.
    for (const path of paths) {
      await runGit({
        cwd: root,
        args: ['checkout', '--merge', '--', path],
        timeoutMs: 60_000,
        allowFailure: true,
      })
    }
    await runGit({ cwd: root, args: ['add', '--', ...paths], timeoutMs: 60_000 })
    return { resolved: paths.length, side: which }
  }
  await runGit({ cwd: root, args: ['checkout', `--${which}`, '--', ...paths], timeoutMs: 120_000 })
  await runGit({ cwd: root, args: ['add', '--', ...paths], timeoutMs: 120_000 })
  return { resolved: paths.length, side: which }
}

/** Mark conflicted paths resolved as they stand on disk. */
export async function markResolved(root, paths) {
  await runGit({ cwd: root, args: ['add', '--', ...paths], timeoutMs: 120_000 })
  return { resolved: paths.length }
}

/** The three stages of a conflicted file, for a side-by-side conflict view. */
export async function conflictStages(root, path) {
  const read = async (stage) => {
    const result = await tryGit(root, ['show', `:${stage}:${path}`], { timeoutMs: 30_000 })
    return result.code === 0 ? result.stdout : undefined
  }
  const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)])
  return { base, ours, theirs }
}

/**
 * Is `path` inside `root`? A plain `startsWith` is not enough: `root` and
 * `root-secrets` share a prefix, so `<root>/../<root>-secrets/id_rsa` would pass
 * it. The separator is what makes it a containment check rather than a string
 * comparison.
 */
export function isInside(root, full) {
  const base = resolve(root)
  const target = resolve(full)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Raw file content from the worktree, for the untracked-file preview. */
export async function worktreeFile(root, path, maxBytes = 2 * 1024 * 1024) {
  const full = resolve(join(root, path))
  if (!isInside(root, full)) throw new GitError(ERR.invalidInput, `${path} 不在仓库内`)
  const info = await stat(full).catch(() => undefined)
  if (info === undefined) throw new GitError(ERR.notFound, `${path} 不存在`)
  if (info.size > maxBytes) throw new GitError(ERR.tooLarge, `${path} 太大（${info.size} 字节），不预览`)
  const buffer = await readFile(full)
  // A NUL in the first 8 KB is git's own binary heuristic.
  const binary = buffer.subarray(0, 8_192).includes(0)
  return binary
    ? { binary: true, bytes: info.size }
    : { binary: false, bytes: info.size, text: buffer.toString('utf8') }
}
