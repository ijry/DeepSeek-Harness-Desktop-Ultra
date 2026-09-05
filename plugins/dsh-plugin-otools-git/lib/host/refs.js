/**
 * Branches and tags: listing them with everything the panel's chips need
 * (upstream, ahead/behind, tip subject), and the mutations — create, checkout,
 * rename, delete, set-upstream, merge, rebase, reset, cherry-pick, revert, tag.
 *
 * `for-each-ref` does the listing in one call per namespace: asking `git branch`
 * and then `rev-list --count` per branch is what makes other panels slow on a
 * repository with 200 branches.
 *
 * @module dsh-plugin-otools-git/host/refs
 */
import { ERR, GitError, normalizeEnum } from '../shared/protocol.js'
import { gitFailure, gitLines, gitRecords, runGit, tryGit } from './git.js'
import { runNetwork } from './remotes.js'
import { currentBranch } from './status.js'

/**
 * Reset modes the panel offers, in the order the dialog lists them.
 *
 * `--merge` is deliberately NOT here: next to `--keep` it is almost impossible to
 * explain in a dialog, and the two differ only in how they treat a change that is
 * staged. The panel offers the three the reference offered plus `--keep`.
 */
export const RESET_MODES = ['soft', 'mixed', 'hard', 'keep']

/** Merge strategies the merge dialog offers. */
export const MERGE_MODES = ['default', 'no-ff', 'ff-only', 'squash']

/**
 * List local branches. `%(upstream:track)` gives `[ahead 2, behind 1]` in one
 * pass, so no extra process per branch.
 */
export async function listBranches(root, options = {}) {
  const format = [
    '%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)',
    '%(upstream:track)', '%(HEAD)', '%(contents:subject)', '%(committerdate:format:%Y-%m-%d %H:%M)',
    '%(worktreepath)',
  ].join('%09')
  const namespaces = ['refs/heads']
  if (options.includeRemote !== false) namespaces.push('refs/remotes')
  const lines = await gitLines(root, [
    'for-each-ref', `--format=${format}`, '--sort=-committerdate', ...namespaces,
  ], { timeoutMs: 60_000, allowFailure: true })

  const head = await currentBranch(root)
  const rows = []
  for (const line of lines) {
    const [refname, short, oid, upstream, track, isHead, subject, date, worktreePath] = line.split('\t')
    if (refname === undefined) continue
    // `refs/remotes/origin/HEAD` is a symbolic alias, not a branch anyone checks
    // out — and its short form is bare `origin`, so the full ref is what tells.
    if (refname.endsWith('/HEAD')) continue
    const remote = refname.startsWith('refs/remotes/')
    const { ahead, behind, gone } = parseTrack(track)
    rows.push({
      refname,
      name: short,
      oid,
      shortOid: (oid ?? '').slice(0, 7),
      remote,
      remoteName: remote ? (short ?? '').split('/')[0] : undefined,
      upstream: upstream === undefined || upstream.length === 0 ? undefined : upstream,
      upstreamGone: gone,
      ahead,
      behind,
      current: isHead === '*' || (!remote && short === head),
      subject,
      date,
      // A branch checked out in another worktree cannot be checked out here.
      worktreePath: worktreePath === undefined || worktreePath.length === 0 ? undefined : worktreePath,
    })
  }
  return rows
}

/** Parse `%(upstream:track)`: `[ahead 3, behind 1]`, `[gone]` or empty. */
export function parseTrack(track) {
  const text = String(track ?? '')
  if (text.includes('gone')) return { ahead: 0, behind: 0, gone: true }
  const ahead = Number.parseInt((text.match(/ahead (\d+)/) ?? [])[1] ?? '0', 10)
  const behind = Number.parseInt((text.match(/behind (\d+)/) ?? [])[1] ?? '0', 10)
  return { ahead, behind, gone: false }
}

/** List tags with their target and (for annotated tags) their message. */
export async function listTags(root) {
  const format = [
    '%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)',
    '%(contents:subject)', '%(taggerdate:format:%Y-%m-%d %H:%M)',
    '%(creatordate:format:%Y-%m-%d %H:%M)', '%(taggername)',
  ].join('%09')
  const lines = await gitLines(root, [
    'for-each-ref', `--format=${format}`, '--sort=-creatordate', 'refs/tags',
  ], { timeoutMs: 60_000, allowFailure: true })
  return lines.map((line) => {
    const [name, oid, peeled, type, subject, taggerDate, creatorDate, tagger] = line.split('\t')
    const annotated = type === 'tag'
    return {
      name,
      oid,
      target: peeled !== undefined && peeled.length > 0 ? peeled : oid,
      shortTarget: (peeled !== undefined && peeled.length > 0 ? peeled : oid ?? '').slice(0, 7),
      annotated,
      subject,
      tagger: annotated ? tagger : undefined,
      date: annotated && taggerDate !== undefined && taggerDate.length > 0 ? taggerDate : creatorDate,
    }
  })
}

/** Branches that could be merged into HEAD — every local branch but the current. */
export async function mergeableBranches(root) {
  const rows = await listBranches(root, { includeRemote: true })
  return rows.filter((row) => !row.current).map((row) => row.name)
}

/** Create a branch (and optionally check it out). */
export async function createBranch(root, options) {
  const args = ['branch']
  if (options.force === true) args.push('--force')
  args.push(options.name)
  if (typeof options.startPoint === 'string' && options.startPoint.length > 0) args.push(options.startPoint)
  await runGit({ cwd: root, args, timeoutMs: 60_000 })
  if (options.checkout === true) await checkoutBranch(root, { name: options.name })
  return { name: options.name, checkedOut: options.checkout === true }
}

/** Check out a branch, a tag or a detached commit. */
export async function checkoutBranch(root, options) {
  const args = ['checkout']
  if (options.detach === true) args.push('--detach')
  if (options.force === true) args.push('--force')
  if (typeof options.newBranch === 'string' && options.newBranch.length > 0) {
    // `--no-track` must precede `-b`; without it git tracks a remote start
    // point automatically, which is the behavior the dialog defaults to.
    if (options.track === false) args.push('--no-track')
    args.push('-b', options.newBranch)
  }
  args.push(options.name)
  const result = await runGit({ cwd: root, args, timeoutMs: 120_000, allowFailure: true })
  if (result.code !== 0) throw gitFailure(args, result)
  return { output: result.stderr.trim() || result.stdout.trim() }
}

/**
 * Would switching to `name` succeed, and if not, which files are in the way?
 *
 * The reference asks libgit2 for a dry-run checkout. The git CLI has no such
 * thing (`--dry-run` is not an option on either `checkout` or `switch`), so the
 * same answer is computed the way git itself decides: a checkout refuses when a
 * file it would REWRITE also has a local change. So: the files that differ
 * between HEAD and the target, intersected with the files that are dirty or
 * untracked here.
 *
 * A false positive is impossible by construction; a false negative is possible
 * for exotic cases (a mode-only change, a submodule) — and there the checkout
 * itself still reports the real error, so the panel is never wrong for long.
 */
export async function validateCheckout(root, name) {
  const resolved = await tryGit(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { timeoutMs: 10_000 })
  if (resolved.code !== 0) {
    return { canCheckout: false, reason: `无法解析 ${name}` }
  }
  const [changing, unstaged, staged, untracked] = await Promise.all([
    gitRecords(root, ['diff', '--name-only', '-z', 'HEAD', name], { timeoutMs: 60_000, allowFailure: true }),
    gitRecords(root, ['diff', '--name-only', '-z'], { timeoutMs: 60_000, allowFailure: true }),
    gitRecords(root, ['diff', '--name-only', '-z', '--cached'], { timeoutMs: 60_000, allowFailure: true }),
    gitRecords(root, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 60_000, allowFailure: true }),
  ])
  const wouldRewrite = new Set(changing.filter((path) => path.length > 0))
  const dirty = new Set()
  for (const path of [...unstaged, ...staged, ...untracked]) {
    if (path.length > 0 && wouldRewrite.has(path)) dirty.add(path)
  }
  if (dirty.size === 0) return { canCheckout: true }
  const list = [...dirty].slice(0, 10)
  return {
    canCheckout: false,
    conflicts: [...dirty],
    reason: `切换到 ${name} 会覆盖这些本地改动：${list.join('、')}` +
      (dirty.size > list.length ? ` 等 ${dirty.size} 个文件` : ''),
  }
}

/** Rename a branch. */
export async function renameBranch(root, from, to, force = false) {
  await runGit({ cwd: root, args: ['branch', force ? '-M' : '-m', from, to], timeoutMs: 60_000 })
  return { name: to }
}

/** Delete one or more local branches. */
export async function deleteBranches(root, names, force = false) {
  await runGit({ cwd: root, args: ['branch', force ? '-D' : '-d', ...names], timeoutMs: 60_000 })
  return { deleted: names }
}

/**
 * Delete a branch on a remote. Routed through `runNetwork` because it IS a push:
 * without that it would miss the stored credential and the cancel signal, and an
 * https remote would fail on authentication with nothing to offer the user.
 */
export async function deleteRemoteBranch(root, remote, branch, extra = {}) {
  return runNetwork(root, ['push', '--progress', remote, '--delete', branch], {
    timeoutMs: 300_000,
    ...extra,
  })
}

/** Point a branch's upstream at a remote-tracking ref, or drop it. */
export async function setUpstream(root, branch, upstream) {
  if (upstream === undefined) {
    await runGit({ cwd: root, args: ['branch', '--unset-upstream', branch], timeoutMs: 30_000 })
    return { branch, upstream: undefined }
  }
  await runGit({ cwd: root, args: ['branch', `--set-upstream-to=${upstream}`, branch], timeoutMs: 30_000 })
  return { branch, upstream }
}

/** Merge a ref into HEAD. */
export async function merge(root, options) {
  const mode = normalizeEnum(options.mode ?? 'default', MERGE_MODES, 'mode')
  const args = ['merge']
  if (mode === 'no-ff') args.push('--no-ff')
  else if (mode === 'ff-only') args.push('--ff-only')
  else if (mode === 'squash') args.push('--squash')
  if (options.noCommit === true && mode !== 'squash') args.push('--no-commit')
  if (typeof options.message === 'string' && options.message.length > 0) args.push('-m', options.message)
  args.push(options.ref)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  return finishOrConflict(args, result, `已合并 ${options.ref}`)
}

/** Rebase HEAD onto a ref. */
export async function rebase(root, options) {
  const args = ['rebase']
  if (options.autostash === true) args.push('--autostash')
  if (options.onto !== undefined) args.push('--onto', options.onto)
  args.push(options.ref)
  const result = await runGit({ cwd: root, args, timeoutMs: 600_000, allowFailure: true })
  return finishOrConflict(args, result, `已在 ${options.ref} 上完成变基`)
}

/** `--continue` / `--abort` / `--skip` for whichever operation is in progress. */
export async function sequencer(root, operation, action) {
  const op = normalizeEnum(operation, ['merge', 'rebase', 'cherry-pick', 'revert'], 'operation')
  const act = normalizeEnum(action, ['continue', 'abort', 'skip', 'quit'], 'action')
  if (op === 'merge' && (act === 'skip' || act === 'quit')) {
    throw new GitError(ERR.invalidInput, 'merge 不支持 skip/quit')
  }
  const args = [op, `--${act}`]
  const env = act === 'continue' ? { GIT_EDITOR: 'true' } : undefined
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true, env })
  return finishOrConflict(args, result, `${op} --${act} 完成`)
}

/** Reset HEAD (and optionally the index/worktree) to a revision. */
export async function reset(root, options) {
  const mode = normalizeEnum(options.mode ?? 'mixed', RESET_MODES, 'mode')
  const args = ['reset', `--${mode}`, options.ref]
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000 })
  return { output: result.stdout.trim() || result.stderr.trim(), mode }
}

/** Cherry-pick one or more commits onto HEAD. */
export async function cherryPick(root, revs, options = {}) {
  const args = ['cherry-pick']
  if (options.noCommit === true) args.push('--no-commit')
  if (options.mainline !== undefined) args.push('-m', String(options.mainline))
  args.push(...revs)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  return finishOrConflict(args, result, `已挑选 ${revs.length} 个提交`)
}

/** Revert one or more commits. */
export async function revert(root, revs, options = {}) {
  const args = ['revert']
  if (options.noCommit === true) args.push('--no-commit')
  if (options.mainline !== undefined) args.push('-m', String(options.mainline))
  args.push(...revs)
  const result = await runGit({ cwd: root, args, timeoutMs: 300_000, allowFailure: true })
  return finishOrConflict(args, result, `已回滚 ${revs.length} 个提交`)
}

/** Create a tag (lightweight or annotated), optionally pushing it. */
export async function createTag(root, options) {
  const args = ['tag']
  if (options.force === true) args.push('--force')
  if (typeof options.message === 'string' && options.message.length > 0) {
    args.push(options.sign === true ? '-s' : '-a', '-m', options.message)
  }
  args.push(options.name)
  if (typeof options.target === 'string' && options.target.length > 0) args.push(options.target)
  await runGit({ cwd: root, args, timeoutMs: 60_000 })
  return { name: options.name }
}

/** Delete local tags. */
export async function deleteTags(root, names) {
  await runGit({ cwd: root, args: ['tag', '-d', ...names], timeoutMs: 60_000 })
  return { deleted: names }
}

/** Delete tags on a remote. Same reasoning as deleteRemoteBranch. */
export async function deleteRemoteTags(root, remote, names, extra = {}) {
  const refs = names.map((name) => `refs/tags/${name}`)
  return runNetwork(root, ['push', '--progress', remote, '--delete', ...refs], {
    timeoutMs: 300_000,
    ...extra,
  })
}

/**
 * A conflict is an OUTCOME, not a crash: `git merge` exiting 1 with CONFLICT in
 * its output means the panel should show the conflict list, so it comes back as
 * `{ conflict: true }` rather than as a thrown error. Anything else that failed
 * still throws.
 */
async function finishOrConflict(args, result, successText) {
  const blob = `${result.stdout}\n${result.stderr}`
  if (result.code === 0) {
    return { ok: true, conflict: false, output: result.stdout.trim() || result.stderr.trim() || successText }
  }
  if (/CONFLICT|Automatic merge failed|could not apply|needs merge|fix conflicts/i.test(blob)) {
    return { ok: false, conflict: true, output: blob.trim() }
  }
  throw gitFailure(args, result)
}
