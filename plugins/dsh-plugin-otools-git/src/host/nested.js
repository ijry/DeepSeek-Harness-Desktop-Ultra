/**
 * Worktrees and submodules — the two places a "repository" has sub-repositories.
 *
 * Both are parsed from porcelain formats (`worktree list --porcelain`,
 * `submodule status`) rather than from prose, and both report enough state for
 * the tree rows to show what is initialized and what is stale.
 *
 * @module dsh-plugin-otools-git/host/nested
 */
import { rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ERR, GitError } from '../shared/protocol.js'
import { gitFailure, gitLines, runGit, tryGit } from './git.js'
import { runNetwork } from './remotes.js'

// -------------------------------------------------------------- worktrees
/** List worktrees, main one first. */
export async function listWorktrees(root) {
  const result = await tryGit(root, ['worktree', 'list', '--porcelain'], { timeoutMs: 60_000 })
  if (result.code !== 0) return []
  return parseWorktreePorcelain(result.stdout)
}

/** Parse `git worktree list --porcelain` (records separated by blank lines). */
export function parseWorktreePorcelain(text) {
  const rows = []
  let current
  const flush = () => {
    if (current !== undefined && current.path !== undefined) rows.push(finishWorktree(current))
    current = undefined
  }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim().length === 0) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice(9) }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (line.startsWith('branch ')) current.branchRef = line.slice(7)
    else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
    else if (line.startsWith('locked')) {
      current.locked = true
      current.lockReason = line.length > 7 ? line.slice(7) : undefined
    } else if (line.startsWith('prunable')) {
      current.prunable = true
      current.prunableReason = line.length > 9 ? line.slice(9) : undefined
    }
  }
  flush()
  // The first record `git worktree list` prints is always the main worktree.
  if (rows.length > 0) rows[0].isMain = true
  return rows
}

/** Fill in the derived fields a worktree row shows. */
function finishWorktree(row) {
  const branch = row.branchRef === undefined ? undefined : row.branchRef.replace(/^refs\/heads\//, '')
  return {
    path: row.path,
    name: basename(row.path),
    head: row.head,
    shortHead: (row.head ?? '').slice(0, 7),
    branch,
    branchRef: row.branchRef,
    detached: row.detached === true || branch === undefined,
    bare: row.bare === true,
    locked: row.locked === true,
    lockReason: row.lockReason,
    prunable: row.prunable === true,
    prunableReason: row.prunableReason,
    isMain: false,
  }
}

/** Add a worktree. `mode` picks between a new branch, an existing one, detached. */
export async function addWorktree(root, options) {
  const mode = options.mode ?? 'new-branch'
  const target = isAbsolute(options.path) ? options.path : resolve(join(root, options.path))
  const args = ['worktree', 'add']
  if (options.force === true) args.push('--force')
  if (mode === 'new-branch') {
    if (typeof options.branch !== 'string' || options.branch.length === 0) {
      throw new GitError(ERR.invalidInput, '请输入新分支名称')
    }
    args.push('-b', options.branch, target)
    if (typeof options.startPoint === 'string' && options.startPoint.length > 0) args.push(options.startPoint)
  } else if (mode === 'existing-branch') {
    if (typeof options.branch !== 'string' || options.branch.length === 0) {
      throw new GitError(ERR.invalidInput, '请选择已有分支')
    }
    args.push(target, options.branch)
  } else if (mode === 'detached') {
    args.push('--detach', target)
    if (typeof options.startPoint === 'string' && options.startPoint.length > 0) args.push(options.startPoint)
  } else {
    throw new GitError(ERR.invalidInput, '不支持的工作树创建模式')
  }
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  if (result.code !== 0) throw gitFailure(args, result)
  return { path: target, output: result.stdout.trim() || result.stderr.trim() }
}

/** Remove a worktree. */
export async function removeWorktree(root, path, force = false) {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(path)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  if (result.code !== 0) throw gitFailure(args, result)
  return { removed: path }
}

/** Lock or unlock a worktree. */
export async function lockWorktree(root, path, lock, reason) {
  const args = ['worktree', lock ? 'lock' : 'unlock']
  if (lock && typeof reason === 'string' && reason.length > 0) args.push('--reason', reason)
  args.push(path)
  await runGit({ cwd: root, args, timeoutMs: 60_000 })
  return { path, locked: lock }
}

/** Prune stale worktree administrative records. */
export async function pruneWorktrees(root) {
  const result = await runGit({ cwd: root, args: ['worktree', 'prune', '-v'], timeoutMs: 120_000 })
  return { output: result.stdout.trim() || result.stderr.trim() || '已清理失效工作树记录' }
}

// ------------------------------------------------------------- submodules
/**
 * List submodules with their initialization state.
 *
 * `submodule status` prefixes each line: `-` not initialized, `+` checked out at
 * a different commit than the superproject records, `U` conflicted, space in
 * sync. That prefix IS the state, so it is kept rather than re-derived.
 */
export async function listSubmodules(root) {
  const configured = await submoduleConfig(root)
  const lines = await gitLines(root, ['submodule', 'status', '--recursive'], {
    timeoutMs: 120_000,
    allowFailure: true,
  })
  const rows = []
  for (const line of lines) {
    const match = line.match(/^([-+U ])([0-9a-f]+) (.+?)(?: \((.+)\))?$/)
    if (match === null) continue
    const [, flag, oid, path, describe] = match
    const meta = configured.get(path) ?? {}
    rows.push({
      path,
      name: meta.name ?? path,
      url: meta.url,
      branch: meta.branch,
      oid,
      shortOid: oid.slice(0, 7),
      describe,
      initialized: flag !== '-',
      modified: flag === '+',
      conflicted: flag === 'U',
    })
  }
  // A submodule listed in .gitmodules that `status` never mentions is one whose
  // directory is missing entirely; the tree still shows it, greyed out.
  for (const [path, meta] of configured) {
    if (rows.some((row) => row.path === path)) continue
    rows.push({
      path,
      name: meta.name ?? path,
      url: meta.url,
      branch: meta.branch,
      initialized: false,
      modified: false,
      conflicted: false,
      missing: true,
    })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

/** `.gitmodules` as a `path → {name,url,branch}` map, read via `git config`. */
export async function submoduleConfig(root) {
  const out = new Map()
  const result = await tryGit(root, [
    'config', '--file', '.gitmodules', '--list', '-z',
  ], { timeoutMs: 30_000 })
  if (result.code !== 0) return out
  const byName = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record.length === 0) continue
    const newline = record.indexOf('\n')
    const key = newline === -1 ? record : record.slice(0, newline)
    const value = newline === -1 ? '' : record.slice(newline + 1)
    const match = key.match(/^submodule\.(.+)\.(path|url|branch)$/)
    if (match === null) continue
    const row = byName.get(match[1]) ?? { name: match[1] }
    row[match[2]] = value
    byName.set(match[1], row)
  }
  for (const row of byName.values()) {
    if (typeof row.path === 'string' && row.path.length > 0) out.set(row.path, row)
  }
  return out
}

/** Initialize and update submodules (all of them, or one path). */
export async function updateSubmodules(root, options = {}) {
  const args = ['submodule', 'update', '--init', '--progress']
  if (options.recursive === true) args.push('--recursive')
  if (options.remote === true) args.push('--remote')
  if (options.force === true) args.push('--force')
  if (typeof options.path === 'string' && options.path.length > 0) args.push('--', options.path)
  return runNetwork(root, args, options)
}

/** Add a submodule. */
export async function addSubmodule(root, options) {
  const args = ['submodule', 'add', '--progress']
  if (typeof options.branch === 'string' && options.branch.length > 0) args.push('-b', options.branch)
  if (options.force === true) args.push('--force')
  args.push('--', options.url, options.path)
  return runNetwork(root, args, options)
}

/**
 * Remove a submodule: deinit, drop the index entry, then delete the leftover
 * `.git/modules/<name>` copy git keeps behind.
 */
export async function removeSubmodule(root, path) {
  await tryGit(root, ['submodule', 'deinit', '--force', '--', path], { timeoutMs: 300_000 })
  await runGit({ cwd: root, args: ['rm', '--force', '--', path], timeoutMs: 300_000 })
  const gitDir = await tryGit(root, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 10_000 })
  if (gitDir.code === 0) {
    const modules = join(gitDir.stdout.trim(), 'modules', path)
    await rm(modules, { recursive: true, force: true }).catch(() => undefined)
  }
  return { removed: path }
}

/** Sync submodule URLs from `.gitmodules` into `.git/config`. */
export async function syncSubmodules(root, path) {
  const args = ['submodule', 'sync', '--recursive']
  if (typeof path === 'string' && path.length > 0) args.push('--', path)
  const result = await runGit({ cwd: root, args, timeoutMs: 120_000 })
  return { output: result.stdout.trim() || result.stderr.trim() }
}
