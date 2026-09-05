/**
 * The execution half: turn one automation firing into a real agent run.
 *
 * A run is one `dsh --profile headless "<prompt>"` child process in the project
 * directory. That is the launcher's own documented one-shot surface ("run one
 * fresh persisted session, print the final answer, and exit"), which is why it
 * was chosen over reaching into `ctx.agents` from a plugin: the CLI contract is
 * public and stable across dsh versions, while the in-process recipe would couple
 * this plugin to the Agent constructor, the message factory and the model
 * selection installer — three internal APIs whose drift would break scheduled
 * runs silently, at night, with nobody watching.
 *
 * What that costs, written down rather than hidden:
 * - one process per run (fine at scheduler cadence, wrong for a chat surface);
 * - no per-run agent preset or model, because the one-shot CLI takes the task and
 *   nothing else — a run uses the headless profile's own configuration;
 * - the produced session is discovered from the sessions directory afterwards,
 *   and only when it can be identified unambiguously.
 *
 * The prompt is passed as ONE argv element and no shell is ever used, so prompt
 * text cannot become shell syntax.
 *
 * @module dsh-plugin-automation/host/runner
 */
import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_ERROR_CHARS, MAX_OUTPUT_CHARS } from '../shared/protocol.js'

/** How long a killed child may take to die before it is killed harder. */
export const KILL_GRACE_MS = 10_000

/** Never hold more than this much captured output per stream in memory. */
const CAPTURE_CAP = MAX_OUTPUT_CHARS * 2

/** Sessions directories are small; refuse to walk a pathological one. */
const MAX_SESSION_SCAN = 4000

/**
 * Marker the child carries. A dsh booted BY an automation must never schedule
 * automations of its own: if this plugin were also installed in the profile a run
 * boots, the scheduler would fork itself once per firing. The engine refuses to
 * start when it sees this.
 */
export const CHILD_ENV = 'DSH_PLUGIN_AUTOMATION_CHILD'

/** A rolling tail buffer: appends stay bounded, the end is what survives. */
function tailBuffer(cap) {
  let text = ''
  return {
    push(chunk) {
      text += chunk
      if (text.length > cap) text = text.slice(text.length - cap)
    },
    get value() {
      return text
    },
  }
}

/**
 * Kill a child and everything it started. A headless run spawns tools, and
 * killing only the launcher would leave them holding the repository.
 */
export function killTree(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    // Windows has no process groups to signal; taskkill /T walks the tree. Args
    // are passed as an array, never a command string.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    // Negative pid = the process group created by detached: true.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch { /* already gone */ }
  }
}

/** Every `<slug>/<session-id>` currently on disk, as a flat set of ids. */
export async function sessionIdsOnDisk(sessionsDir) {
  const out = new Set()
  let slugs
  try {
    slugs = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(sessionsDir, slug.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) out.add(entry.name)
      if (out.size > MAX_SESSION_SCAN) return out
    }
  }
  return out
}

/**
 * The session a run produced, or undefined. Deliberately conservative: with two
 * runs in flight the "new since we started" sets overlap, and a link to the wrong
 * session would be worse than no link, so anything but a single unclaimed
 * candidate answers undefined.
 *
 * @param before - ids present when the run started.
 * @param after - ids present when it ended.
 * @param claimed - ids already attributed to another run (mutated on success).
 */
export function identifySession(before, after, claimed) {
  const fresh = [...after].filter((id) => !before.has(id) && !claimed.has(id))
  if (fresh.length !== 1) return undefined
  claimed.add(fresh[0])
  return fresh[0]
}

/**
 * Start one headless run.
 *
 * @param spec - { entry, cwd, prompt, timeoutMs, env?, sessionsDir?, claimed?,
 *   spawnImpl? }
 * @returns { pid, kill(reason), done } — `done` resolves with
 *   { status, exitCode?, output?, error?, sessionId? } and never rejects: a spawn
 *   failure is an outcome, not an exception, because the caller is a scheduler
 *   that has to record something either way.
 */
export async function startHeadlessRun(spec) {
  const spawnImpl = spec.spawnImpl ?? spawn
  const args = [...spec.entry.prefix, '--profile', 'headless', spec.prompt]
  const stdout = tailBuffer(CAPTURE_CAP)
  const stderr = tailBuffer(CAPTURE_CAP)
  const before = spec.sessionsDir === undefined ? new Set() : await sessionIdsOnDisk(spec.sessionsDir)
  const state = { settled: false, cancelled: undefined, timer: undefined, hardTimer: undefined }
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const settle = (status, extra) => {
    if (state.settled) return
    state.settled = true
    clearTimeout(state.timer)
    clearTimeout(state.hardTimer)
    resolveDone({
      status,
      output: stdout.value,
      error: extra?.error ?? stderr.value,
      exitCode: extra?.exitCode,
      sessionId: extra?.sessionId,
    })
  }

  let child
  try {
    child = spawnImpl(spec.entry.command, args, {
      cwd: spec.cwd,
      env: { ...process.env, NO_COLOR: '1', [CHILD_ENV]: '1', ...(spec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group on POSIX, so killTree can reap the tools a run spawned.
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    settle('failed', { error: `无法启动 dsh：${error?.message ?? error}` })
    return { pid: undefined, kill() {}, done }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => stdout.push(chunk))
  child.stderr?.on('data', (chunk) => stderr.push(chunk))
  // A dead pipe must not take the host down with it.
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})

  const kill = (reason) => {
    if (state.settled) return
    state.cancelled = reason === 'timeout' ? 'timeout' : 'canceled'
    killTree(child, 'SIGTERM')
    // A child that ignores the polite signal still has to go: the scheduler
    // cannot leave an agent running in a repository forever.
    state.hardTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    state.hardTimer.unref?.()
  }

  if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
    state.timer = setTimeout(() => kill('timeout'), spec.timeoutMs)
    state.timer.unref?.()
  }

  child.on('error', (error) => {
    settle('failed', { error: `dsh 启动失败：${error?.message ?? error}` })
  })

  child.on('close', (code) => {
    void (async () => {
      const sessionId = spec.sessionsDir === undefined
        ? undefined
        : identifySession(before, await sessionIdsOnDisk(spec.sessionsDir), spec.claimed ?? new Set())
      const exitCode = typeof code === 'number' ? code : undefined
      if (state.cancelled === 'timeout') {
        settle('timeout', { exitCode, sessionId, error: `运行超时，已终止${stderr.value === '' ? '' : `\n${stderr.value}`}` })
        return
      }
      if (state.cancelled === 'canceled') {
        settle('canceled', { exitCode, sessionId, error: '已手动取消' })
        return
      }
      if (exitCode === 0) {
        settle('succeeded', { exitCode, sessionId })
        return
      }
      const detail = stderr.value.trim()
      settle('failed', {
        exitCode,
        sessionId,
        error: detail.length > 0 ? detail.slice(-MAX_ERROR_CHARS) : `dsh 退出码 ${exitCode ?? '未知'}`,
      })
    })()
  })

  return { pid: child.pid, kill, done }
}
