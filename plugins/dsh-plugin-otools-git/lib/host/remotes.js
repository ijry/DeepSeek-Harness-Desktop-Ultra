/**
 * Remotes and the network operations: fetch, pull, push, clone, plus remote
 * bookkeeping (add / rename / set-url / remove / prune) and the ahead-behind
 * numbers the toolbar badges show.
 *
 * Progress comes from git's own `--progress` stderr, parsed into a 0-100 percent
 * plus a phase label, so the operation dialog behaves like the reference's:
 * a bar, the command being run, and a growing log.
 *
 * @module dsh-plugin-otools-git/host/remotes
 */
import { ERR, GitError } from '../shared/protocol.js'
import { gitFailure, gitLines, runGit, tryGit } from './git.js'

/**
 * How git's phases map onto one overall percentage. Each entry owns a slice of
 * the bar, so "Receiving objects 50%" lands mid-bar instead of resetting it —
 * which is exactly the monotonic behavior the reference enforces by hand.
 */
const PHASES = [
  { re: /^remote: Enumerating objects/i, label: '枚举对象', from: 2, to: 6 },
  { re: /^Enumerating objects/i, label: '枚举对象', from: 2, to: 6 },
  { re: /^Counting objects/i, label: '统计对象', from: 6, to: 14 },
  { re: /^Compressing objects/i, label: '压缩对象', from: 14, to: 30 },
  { re: /^Writing objects/i, label: '写入对象', from: 30, to: 82 },
  { re: /^Receiving objects/i, label: '接收对象', from: 20, to: 78 },
  { re: /^Resolving deltas/i, label: '解析增量', from: 78, to: 92 },
  { re: /^remote: Resolving deltas/i, label: '远端解析增量', from: 82, to: 94 },
  { re: /^Updating files/i, label: '更新工作区', from: 92, to: 98 },
  { re: /^Checking out files/i, label: '检出文件', from: 92, to: 98 },
  { re: /^Filtering content/i, label: '过滤内容', from: 92, to: 98 },
]

/**
 * Parse one progress line into `{ percent, label, detail }`, or undefined when
 * the line is not progress. `\r`-separated updates arrive in one chunk, so the
 * caller splits on both.
 */
export function parseProgressLine(line) {
  const text = String(line ?? '').trim()
  if (text.length === 0) return undefined
  for (const phase of PHASES) {
    if (!phase.re.test(text)) continue
    const pct = Number.parseInt((text.match(/(\d+)%/) ?? [])[1] ?? '', 10)
    const within = Number.isInteger(pct) ? pct / 100 : 0
    return {
      percent: Math.round(phase.from + (phase.to - phase.from) * within),
      label: phase.label,
      detail: text,
    }
  }
  return undefined
}

/** Split a stderr chunk into lines, honouring git's `\r` progress rewrites. */
export function progressLines(chunk) {
  return String(chunk ?? '').split(/\r\n|[\r\n]/).filter((line) => line.trim().length > 0)
}

/** List remotes with both fetch and push URLs. */
export async function listRemotes(root) {
  const lines = await gitLines(root, ['remote', '-v'], { timeoutMs: 30_000, allowFailure: true })
  const byName = new Map()
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (match === null) continue
    const [, name, url, kind] = match
    const row = byName.get(name) ?? { name, fetchUrl: undefined, pushUrl: undefined }
    if (kind === 'fetch') row.fetchUrl = url
    else row.pushUrl = url
    byName.set(name, row)
  }
  return [...byName.values()].map((row) => ({
    ...row,
    url: row.fetchUrl ?? row.pushUrl,
    host: hostOf(row.fetchUrl ?? row.pushUrl),
  }))
}

/** The host part of a remote URL, for the credential prompt's wording. */
export function hostOf(url) {
  const text = String(url ?? '')
  if (text.length === 0) return undefined
  const scp = text.match(/^[^/]*@([^:/]+):/)
  if (scp !== null) return scp[1].toLowerCase()
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Whether a URL uses http(s) — i.e. whether a username/password can apply. */
export function isHttpRemote(url) {
  return /^https?:\/\//i.test(String(url ?? ''))
}

/** Add a remote. */
export async function addRemote(root, name, url) {
  await runGit({ cwd: root, args: ['remote', 'add', name, url], timeoutMs: 30_000 })
  return { name, url }
}

/** Rename a remote. */
export async function renameRemote(root, from, to) {
  await runGit({ cwd: root, args: ['remote', 'rename', from, to], timeoutMs: 60_000 })
  return { name: to }
}

/** Remove a remote. */
export async function removeRemote(root, name) {
  await runGit({ cwd: root, args: ['remote', 'remove', name], timeoutMs: 30_000 })
  return { removed: name }
}

/** Point a remote at a different URL (fetch, push, or both). */
export async function setRemoteUrl(root, name, url, which = 'both') {
  if (which === 'push') {
    await runGit({ cwd: root, args: ['remote', 'set-url', '--push', name, url], timeoutMs: 30_000 })
  } else if (which === 'fetch') {
    await runGit({ cwd: root, args: ['remote', 'set-url', name, url], timeoutMs: 30_000 })
  } else {
    await runGit({ cwd: root, args: ['remote', 'set-url', name, url], timeoutMs: 30_000 })
    await tryGit(root, ['remote', 'set-url', '--push', name, url], { timeoutMs: 30_000 })
  }
  return { name, url }
}

/** Branch names on a remote, read from the local tracking refs. */
export async function remoteBranches(root, remote) {
  const lines = await gitLines(root, [
    'for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`,
  ], { timeoutMs: 30_000, allowFailure: true })
  const prefix = `${remote}/`
  return lines
    .filter((name) => name.startsWith(prefix) && !name.endsWith('/HEAD'))
    .map((name) => name.slice(prefix.length))
}

/** Fetch. `--prune` and `--tags` are the two toggles the dialog offers. */
export async function fetch(root, options = {}) {
  const args = ['fetch', '--progress']
  if (options.all === true) args.push('--all')
  if (options.prune === true) args.push('--prune')
  if (options.tags === true) args.push('--tags')
  if (options.depth !== undefined) args.push(`--depth=${Number.parseInt(String(options.depth), 10) || 1}`)
  if (options.all !== true && typeof options.remote === 'string' && options.remote.length > 0) {
    args.push(options.remote)
    if (typeof options.branch === 'string' && options.branch.length > 0) args.push(options.branch)
  }
  return runNetwork(root, args, options)
}

/** Pull, with the merge/rebase/ff-only choice the dialog offers. */
export async function pull(root, options = {}) {
  const args = ['pull', '--progress']
  if (options.mode === 'rebase') args.push('--rebase')
  else if (options.mode === 'ff-only') args.push('--ff-only')
  else if (options.mode === 'no-ff') args.push('--no-rebase', '--no-ff')
  else args.push('--no-rebase')
  if (options.autostash === true) args.push('--autostash')
  if (options.prune === true) args.push('--prune')
  if (options.tags === true) args.push('--tags')
  if (typeof options.remote === 'string' && options.remote.length > 0) {
    args.push(options.remote)
    if (typeof options.branch === 'string' && options.branch.length > 0) args.push(options.branch)
  }
  // A pull that needs a merge commit must not open an editor.
  return runNetwork(root, args, { ...options, env: { ...(options.env ?? {}), GIT_EDITOR: 'true' } })
}

/**
 * Push one refspec.
 *
 * `--force-with-lease` is offered alongside `--force` because the reference's
 * plain `--force` is the footgun version: with-lease refuses when the remote
 * moved since the last fetch, which is the check a user actually wants.
 */
export async function push(root, options = {}) {
  const args = ['push', '--progress']
  if (options.force === true) args.push('--force')
  else if (options.forceWithLease === true) args.push('--force-with-lease')
  if (options.setUpstream === true) args.push('--set-upstream')
  if (options.tags === true) args.push('--tags')
  if (options.followTags === true) args.push('--follow-tags')
  if (options.dryRun === true) args.push('--dry-run')
  if (typeof options.remote === 'string' && options.remote.length > 0) {
    args.push(options.remote)
    if (typeof options.refspec === 'string' && options.refspec.length > 0) args.push(options.refspec)
  }
  return runNetwork(root, args, options)
}

/**
 * Run a network git command with progress reporting.
 *
 * @param options - may carry `onProgress({percent,label,detail})`, `onLog(line)`,
 *   `credential` (`{username,password}` for an http(s) remote), `signal`.
 */
export async function runNetwork(root, args, options = {}) {
  const { onProgress, onLog } = options
  let percent = 0
  const handleChunk = (chunk) => {
    for (const line of progressLines(chunk)) {
      if (onLog !== undefined) onLog(line)
      const parsed = parseProgressLine(line)
      if (parsed === undefined) continue
      // Monotonic: a later phase never rewinds the bar.
      percent = Math.max(percent, Math.min(99, parsed.percent))
      if (onProgress !== undefined) onProgress({ ...parsed, percent })
    }
  }

  const env = { ...(options.env ?? {}), ...credentialEnv(options.credential) }
  const result = await runGit({
    cwd: root,
    args: options.credential === undefined ? args : withCredentialConfig(args, options.credential),
    timeoutMs: options.timeoutMs ?? 1_800_000,
    allowFailure: true,
    env,
    signal: options.signal,
    onStderr: handleChunk,
    onStdout: (chunk) => {
      for (const line of progressLines(chunk)) if (onLog !== undefined) onLog(line)
    },
  })
  if (result.code !== 0) {
    throw gitFailure(args, result)
  }
  if (onProgress !== undefined) onProgress({ percent: 100, label: '完成', detail: '' })
  return { output: `${result.stdout}\n${result.stderr}`.trim() }
}

/**
 * Feed a username/password to git for ONE call without writing it anywhere.
 *
 * `credential.helper=` (empty) first CLEARS the inherited helper chain, so a
 * system credential manager cannot answer first with a stale token; the second
 * helper is a `!` shell snippet that prints the pair from the environment. The
 * password never appears in an argv (which is world-readable in /proc) — only in
 * the child's environment, and only for the lifetime of that child.
 */
function withCredentialConfig(args, credential) {
  if (credential === undefined) return args
  const helper = '!f() { test "$1" = get && ' +
    'printf "username=%s\\npassword=%s\\n" "$DSH_OG_USER" "$DSH_OG_PASS"; }; f'
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, ...args]
}

/** The environment half of the credential trick above. */
function credentialEnv(credential) {
  if (credential === undefined) return {}
  return {
    DSH_OG_USER: String(credential.username ?? ''),
    DSH_OG_PASS: String(credential.password ?? ''),
    // With a helper configured, git must not fall back to a prompt.
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** What `git push` would default to for the current branch. */
export async function pushDefaults(root) {
  const branch = await tryGit(root, ['symbolic-ref', '--short', 'HEAD'], { timeoutMs: 10_000 })
  if (branch.code !== 0) throw new GitError(ERR.invalidInput, '当前不在一个分支上')
  const localBranch = branch.stdout.trim()
  const upstream = await tryGit(root, [
    'rev-parse', '--symbolic-full-name', `${localBranch}@{upstream}`,
  ], { timeoutMs: 10_000 })
  const trackingRef = upstream.code === 0 ? upstream.stdout.trim() : undefined
  const remotes = await listRemotes(root)
  let remote = remotes.some((row) => row.name === 'origin') ? 'origin' : remotes[0]?.name
  let targetBranch = localBranch
  if (trackingRef !== undefined) {
    const parsed = parseTrackingRef(trackingRef, remotes.map((row) => row.name))
    if (parsed !== undefined) {
      remote = parsed.remote
      targetBranch = parsed.branch
    }
  }
  return {
    localBranch,
    remote,
    targetBranch,
    trackingRef,
    hasTracking: trackingRef !== undefined,
    remotes,
  }
}

/** Split `refs/remotes/origin/feature/x` into `origin` + `feature/x`. */
export function parseTrackingRef(ref, remoteNames = []) {
  const text = String(ref ?? '').replace(/^refs\/remotes\//, '')
  for (const name of remoteNames) {
    if (text.startsWith(`${name}/`)) return { remote: name, branch: text.slice(name.length + 1) }
  }
  const slash = text.indexOf('/')
  if (slash <= 0) return undefined
  return { remote: text.slice(0, slash), branch: text.slice(slash + 1) }
}

/** What `git pull` would default to. */
export async function pullDefaults(root) {
  const defaults = await pushDefaults(root).catch(() => undefined)
  if (defaults === undefined) {
    const remotes = await listRemotes(root)
    return {
      remote: remotes.some((row) => row.name === 'origin') ? 'origin' : remotes[0]?.name,
      sourceBranch: undefined,
      remotes,
    }
  }
  return {
    remote: defaults.remote,
    sourceBranch: defaults.targetBranch,
    trackingRef: defaults.trackingRef,
    localBranch: defaults.localBranch,
    remotes: defaults.remotes,
  }
}

/**
 * Prune stale remote-tracking refs. Routed through `runNetwork` rather than
 * `runGit`: `remote prune` contacts the remote, so it needs the credential and
 * the cancel signal every other network call gets.
 */
export async function pruneRemote(root, remote, extra = {}) {
  return runNetwork(root, ['remote', 'prune', remote], { timeoutMs: 300_000, ...extra })
}
