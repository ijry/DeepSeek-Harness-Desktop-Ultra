/**
 * The one place a `git` process is started. Everything else in the host half
 * goes through `runGit`, so the process hygiene below is applied exactly once:
 *
 * - `-c core.quotepath=false` so non-ASCII paths come back verbatim instead of
 *   `\346\226\207` octal escapes (this panel is used on Chinese paths).
 * - `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0` so a background status read
 *   never takes index.lock out from under a user's own `git` in a terminal.
 * - `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `SSH_ASKPASS=`, `GIT_CONFIG_NOSYSTEM`
 *   off-switches for anything that could block forever waiting on a TTY that a
 *   web server does not have. A credential-needing remote fails FAST and the
 *   panel asks the user instead — see host/auth.js.
 * - `LC_ALL=C` so parsed prose (`ahead 2, behind 1`) is not localized.
 *
 * Output is captured as a Buffer and only then decoded, because `-z` formats and
 * `git diff` payloads are byte streams that may not be valid UTF-8.
 *
 * @module dsh-plugin-otools-git/host/git
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dubiousOwnership, GitError, ERR } from '../shared/protocol.js'

/** Does a spawn cwd still exist and is it a directory? Only used on the error path. */
function cwdExists(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return true
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/** Config flags forced onto every invocation, before the subcommand. */
export const BASE_CONFIG = [
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'advice.detachedHead=false',
]

/** Default wall-clock cap for a local (non-network) git call. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Default cap on captured stdout. A diff of a huge file must not OOM the host. */
export const DEFAULT_MAX_BYTES = 48 * 1024 * 1024

/**
 * The environment a git child gets: the host's, minus everything that could
 * make git block on a prompt, plus the overrides a caller asks for.
 */
export function gitEnv(overrides = {}) {
  const env = { ...process.env }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  env.LC_ALL = 'C'
  env.LANG = 'C'
  // An inherited askpass would pop a GUI dialog on the machine running the
  // host, which nobody is looking at. Cleared rather than set to a stub so git
  // reports "could not read Username" and the panel can ask in the browser.
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  delete env.DISPLAY
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = String(value)
  }
  return env
}

/** Decode captured bytes as UTF-8, tolerating invalid sequences. */
export function decode(buffer) {
  return buffer.length === 0 ? '' : buffer.toString('utf8')
}

/**
 * Run one git command.
 *
 * @param options - `{ cwd, args, input?, env?, timeoutMs?, maxBytes?, onStdout?,
 *   onStderr?, allowFailure?, signal? }`. `onStdout`/`onStderr` receive decoded
 *   chunks as they arrive (progress lines for push/pull/clone); the full output is
 *   still captured and returned. `signal` kills the child when aborted, which is
 *   how the operation registry's cancel button reaches a running fetch.
 * @returns `{ code, stdout, stderr, stdoutBuffer, truncated }`
 */
export function runGit(options) {
  const {
    cwd,
    args,
    input,
    env: envOverrides,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    onStdout,
    onStderr,
    allowFailure = false,
    signal,
  } = options
  if (!Array.isArray(args) || args.length === 0) {
    throw new GitError(ERR.invalidInput, 'git args are required')
  }
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(new GitError(ERR.timeout, 'operation was canceled before it started'))
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', [...BASE_CONFIG, ...args], {
        cwd,
        env: gitEnv(envOverrides),
        windowsHide: true,
        // No shell: args are passed as a vector, so a path or branch name
        // containing spaces, quotes or `&` cannot become another command.
        shell: false,
      })
    } catch (error) {
      reject(new GitError(ERR.gitMissing, `cannot start git: ${error?.message ?? error}`))
      return
    }

    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let settled = false
    let timer

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(reject, new GitError(ERR.timeout, `git ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    // A canceled operation must actually stop the process, not just stop being
    // waited on — otherwise a canceled clone keeps writing to disk.
    let onAbort
    if (signal !== undefined) {
      onAbort = () => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(reject, new GitError(ERR.timeout, `git ${args[0]} was canceled`))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) {
        truncated = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        return
      }
      outChunks.push(chunk)
      if (onStdout !== undefined) {
        try { onStdout(decode(chunk)) } catch { /* a listener must not kill the call */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length
      // stderr is progress and diagnostics; a hard cap is enough, no truncation
      // flag — nothing parses more than the last few lines of it.
      if (errBytes <= 4 * 1024 * 1024) errChunks.push(chunk)
      if (onStderr !== undefined) {
        try { onStderr(decode(chunk)) } catch { /* as above */ }
      }
    })
    child.on('error', (error) => {
      // ENOENT here is ambiguous: it means either "no git on PATH" or "cwd does
      // not exist". They need different messages — a workspace folder the user
      // deleted must not be reported as a missing git installation — and the only
      // way to tell them apart is to look.
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT' && !cwdExists(cwd)) {
        finish(reject, new GitError(ERR.notFound, `目录不存在：${cwd}`))
        return
      }
      const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT'
      finish(reject, new GitError(
        missing ? ERR.gitMissing : ERR.internal,
        missing ? 'git is not installed or not on PATH' : `git failed to start: ${error?.message ?? error}`,
      ))
    })
    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(outChunks)
      const result = {
        code: code ?? -1,
        stdout: decode(stdoutBuffer),
        stderr: decode(Buffer.concat(errChunks)),
        stdoutBuffer,
        truncated,
      }
      if (truncated) {
        finish(reject, new GitError(ERR.tooLarge, `git ${args[0]} produced more than ${maxBytes} bytes`))
        return
      }
      if (result.code !== 0 && !allowFailure) {
        finish(reject, gitFailure(args, result))
        return
      }
      finish(resolve, result)
    })

    if (input !== undefined) {
      child.stdin.on('error', () => { /* a closed pipe is the child's business */ })
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

/** stdout of a successful git call, trailing newline stripped. */
export async function gitOut(cwd, args, extra = {}) {
  const result = await runGit({ cwd, args, ...extra })
  return result.stdout.replace(/\r?\n$/, '')
}

/** Lines of stdout, blank lines dropped. */
export async function gitLines(cwd, args, extra = {}) {
  const text = await gitOut(cwd, args, extra)
  return text.length === 0 ? [] : text.split(/\r?\n/).filter((line) => line.length > 0)
}

/** NUL-separated records of stdout, trailing empty record dropped. */
export async function gitRecords(cwd, args, extra = {}) {
  const result = await runGit({ cwd, args, ...extra })
  const parts = result.stdout.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Run a git command that is allowed to fail, returning the result either way.
 * For probes like `git rev-parse --verify` where failure IS the answer.
 */
export function tryGit(cwd, args, extra = {}) {
  return runGit({ cwd, args, allowFailure: true, ...extra })
}

/** The last non-empty line of stderr — the part worth showing a user. */
export function lastStderrLine(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

/**
 * Classify a failed git call. The codes are the ones the browser localizes, so
 * the mapping lives here rather than at each call site: an auth failure looks
 * the same whether it came from fetch, push or ls-remote.
 */
export function gitFailure(args, result) {
  const stderr = String(result.stderr ?? '')
  const blob = `${stderr}\n${String(result.stdout ?? '')}`
  const code = classifyGitError(blob)
  const detail = lastStderrLine(stderr) || `git ${args.join(' ')} exited with ${result.code}`
  const error = new GitError(code, detail)
  error.exitCode = result.code
  error.stderr = stderr
  error.stdout = String(result.stdout ?? '')
  error.command = ['git', ...args].join(' ')
  // "dubious ownership" has a one-click repair (/safe-directory), so the paths
  // git named travel with the error and the browser can offer it wherever the
  // failure surfaces.
  const dubious = dubiousOwnership(blob)
  if (dubious !== undefined) error.dubious = dubious
  return error
}

/** Map git's diagnostics onto this plugin's stable error codes. */
export function classifyGitError(text) {
  const blob = String(text ?? '')
  if (/could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|invalid credentials|HTTP Basic: Access denied|Support for password authentication was removed/i.test(blob)) {
    return ERR.authRequired
  }
  if (/Permission denied \(publickey|Host key verification failed|no matching host key|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(blob)) {
    return ERR.sshAuth
  }
  if (/Could not resolve host|unable to access|Failed to connect|Connection timed out|Connection refused|Operation timed out|SSL certificate problem|proxy/i.test(blob)) {
    return ERR.network
  }
  if (/index\.lock|Another git process seems to be running|Unable to create .*\.lock/i.test(blob)) {
    return ERR.locked
  }
  if (/not a git repository|does not appear to be a git repository/i.test(blob)) {
    return ERR.notRepo
  }
  if (/CONFLICT|Automatic merge failed|needs merge|fix conflicts|would be overwritten by merge|local changes .* would be overwritten/i.test(blob)) {
    return ERR.conflict
  }
  if (/Updates were rejected|non-fast-forward|failed to push some refs|stale info/i.test(blob)) {
    return ERR.rejected
  }
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(blob)) {
    return ERR.nothingToDo
  }
  if (/unknown revision|bad revision|ambiguous argument|pathspec .* did not match|unknown option|not a valid object name/i.test(blob)) {
    return ERR.invalidInput
  }
  return ERR.gitError
}
