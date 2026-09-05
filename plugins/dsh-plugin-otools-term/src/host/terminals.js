/**
 * The session registry: every live terminal, SSH or local.
 *
 * Sessions live in the HOST, not in the page. The reference kept a terminal alive
 * only as long as its Vue component was mounted — switching tabs was fine, but a
 * reload lost every shell. Here a session is a host object with an output ring
 * buffer, so closing the panel, reloading DSH, or opening a second browser window
 * all re-attach to the same running shell and get a replay of the last screenful
 * instead of a blank one.
 *
 * A local terminal wants a PTY, and a PTY needs a native module. `node-pty` is an
 * OPTIONAL dependency here: if it (or its prebuilt fork) loaded, the local
 * terminal is a real PTY with a real `resize`; if not, the shell still runs over
 * pipes in a clearly-labelled compatibility mode where non-interactive commands
 * work and full-screen programs do not. Refusing to offer a local terminal at all
 * on a machine without build tools would be worse.
 *
 * @module dsh-plugin-otools-term/host/terminals
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  ERR,
  MAX_SESSIONS,
  SCROLLBACK_BYTES,
  SESSION_IDLE_MS,
  TermError,
} from '../shared/protocol.js'

/** How often the idle sweeper runs. */
export const SWEEP_INTERVAL_MS = 60_000

/** The PTY module candidates, in preference order. */
const PTY_MODULES = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch']

/** Resolved PTY module, or null when none loaded. Cached after the first try. */
let ptyModule
let ptyModuleError = ''

/** Load a PTY implementation once, tolerating its absence. */
export async function loadPty() {
  if (ptyModule !== undefined) return ptyModule
  const failures = []
  for (const id of PTY_MODULES) {
    try {
      const loaded = await import(id)
      const api = loaded?.spawn !== undefined ? loaded : loaded?.default
      if (api !== undefined && api !== null && typeof api.spawn === 'function') {
        ptyModule = api
        return ptyModule
      }
      failures.push(`${id}: no spawn()`)
    } catch (error) {
      failures.push(`${id}: ${error?.code ?? error?.message ?? 'load failed'}`)
    }
  }
  ptyModule = null
  ptyModuleError = failures.join('; ')
  return ptyModule
}

/** Why the PTY is unavailable, for the compatibility-mode notice. */
export function ptyUnavailableReason() {
  return ptyModuleError
}

/** The shell a local terminal starts, mirroring the reference's choice. */
export function defaultShell(override) {
  const chosen = typeof override === 'string' ? override.trim() : ''
  if (chosen.length > 0) return chosen
  if (process.platform === 'win32') {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    if (existsSync(pwsh)) return pwsh
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const powershell = `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    if (existsSync(powershell)) return powershell
    return process.env.ComSpec ?? 'cmd.exe'
  }
  const shell = process.env.SHELL
  if (shell !== undefined && shell.length > 0) return shell
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * A byte-capped output buffer. Chunks are kept whole and dropped from the front,
 * so a replay always starts on a chunk boundary — never in the middle of a UTF-8
 * sequence or an escape sequence that the host itself split.
 */
export class RingBuffer {
  constructor(limit = SCROLLBACK_BYTES) {
    this.limit = limit
    this.chunks = []
    this.bytes = 0
  }

  push(chunk) {
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.limit && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length
    }
  }

  read() {
    return this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks)
  }

  clear() {
    this.chunks = []
    this.bytes = 0
  }
}

/** One terminal session. */
class Session {
  constructor(fields) {
    Object.assign(this, fields)
    this.buffer = new RingBuffer()
    this.status = 'starting'
    this.exitCode = null
    this.exitSignal = null
    this.error = null
    this.lastSeen = Date.now()
    this.bytesOut = 0
  }

  /** The record the browser sees. */
  describe() {
    return {
      sessionId: this.sessionId,
      serverId: this.serverId,
      kind: this.kind,
      status: this.status,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      shell: this.shell,
      pty: this.pty === true,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      error: this.error === null ? undefined : this.error,
      startedAt: this.startedAt,
      bytesOut: this.bytesOut,
    }
  }
}

/** The registry. */
export class SessionRegistry {
  constructor(options) {
    this.pool = options.pool
    this.hub = options.hub
    this.sessions = new Map()
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  /** Every session, for the panel's first paint. */
  list() {
    return [...this.sessions.values()].map((session) => session.describe())
  }

  /** One session or a `no_session` failure. */
  require(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new TermError(ERR.noSession, `会话不存在或已结束：${sessionId}`)
    return session
  }

  /** One session, or undefined. */
  peek(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Announce a session record change. */
  announce(session) {
    this.hub.broadcast('session', session.describe())
  }

  /** Route output: ring buffer for replay, hub for the attached panels. */
  onOutput(session, chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    // The offset is taken BEFORE the counter moves, so a frame says where in the
    // session's byte stream it starts and an attaching panel can splice it against
    // the replay exactly.
    const offset = session.bytesOut
    session.buffer.push(buffer)
    session.bytesOut += buffer.length
    session.lastSeen = Date.now()
    this.hub.output(session.sessionId, buffer, offset)
  }

  /** Mark a session finished and tell the panels. */
  finish(session, { status, code, signal, error }) {
    if (session.status === 'closed' || session.status === 'error') return
    session.status = status
    session.exitCode = code ?? null
    session.exitSignal = signal ?? null
    session.error = error === undefined || error === null ? null : (error.message ?? String(error))
    this.hub.flush()
    this.announce(session)
  }

  /** Refuse to grow past the ceiling. */
  guardCapacity() {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new TermError(ERR.invalidInput, `同时打开的会话已达上限（${MAX_SESSIONS}）`)
    }
  }

  /**
   * Open an SSH shell. Reuses the server's shared connection, so the second tab on
   * a server costs one channel rather than a whole handshake.
   */
  async openSsh(options) {
    const existing = this.sessions.get(options.sessionId)
    if (existing !== undefined) return existing.describe()
    this.guardCapacity()
    const connection = this.pool.get(options.server)
    const channel = await connection.shell({ cols: options.cols, rows: options.rows, term: options.term })
    const session = new Session({
      sessionId: options.sessionId,
      serverId: options.server.id,
      kind: 'ssh',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      shell: undefined,
      pty: true,
      channel,
      startedAt: Date.now(),
    })
    this.sessions.set(session.sessionId, session)
    session.status = 'running'

    channel.on('data', (chunk) => this.onOutput(session, chunk))
    if (channel.stderr !== undefined && channel.stderr !== null) {
      channel.stderr.on('data', (chunk) => this.onOutput(session, chunk))
    }
    channel.on('exit', (code, signal) => {
      session.exitCode = typeof code === 'number' ? code : null
      session.exitSignal = signal ?? null
    })
    channel.on('close', () => {
      this.finish(session, { status: 'closed', code: session.exitCode, signal: session.exitSignal })
    })
    channel.on('error', (error) => {
      this.finish(session, { status: 'error', error })
    })

    if (typeof options.initialCommand === 'string' && options.initialCommand.length > 0) {
      // One tick after the shell starts, the way the reference delayed it: a shell
      // that has not printed its prompt yet swallows early input.
      const text = options.initialCommand.endsWith('\n') ? options.initialCommand : `${options.initialCommand}\n`
      const timer = setTimeout(() => {
        try {
          channel.write(text)
        } catch { /* the session may already be gone */ }
      }, 300)
      if (typeof timer.unref === 'function') timer.unref()
    }
    this.announce(session)
    return session.describe()
  }

  /** Open a local shell: a PTY when one is available, pipes otherwise. */
  async openLocal(options) {
    const existing = this.sessions.get(options.sessionId)
    if (existing !== undefined) return existing.describe()
    this.guardCapacity()
    const shell = defaultShell(options.shell)
    const cwd = options.cwd !== undefined && options.cwd.length > 0 && existsSync(options.cwd) ? options.cwd : homedir()
    const pty = await loadPty()

    const session = new Session({
      sessionId: options.sessionId,
      serverId: options.serverId ?? '__local__',
      kind: 'local',
      cols: options.cols,
      rows: options.rows,
      cwd,
      shell,
      pty: pty !== null,
      startedAt: Date.now(),
    })
    this.sessions.set(session.sessionId, session)

    // A login shell that thinks it is inside dsh's own agent session would inherit
    // variables that confuse it; the terminal announces itself instead.
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    delete env.NODE_OPTIONS

    if (pty !== null) {
      let child
      try {
        child = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          cwd,
          env,
          // node-pty's own default backend per platform (ConPTY on Windows). Forcing
          // winpty instead silences one cosmetic child-process complaint on a host
          // without a console ("AttachConsole failed", from the console-list agent
          // ConPTY starts) — and in exchange the winpty agent does not always exit
          // when the session is killed, which leaves a stray process behind. A noisy
          // log line is the better trade.
          useConpty: undefined,
        })
      } catch (error) {
        this.sessions.delete(session.sessionId)
        throw new TermError(ERR.ptyUnavailable, `无法启动本地终端：${error?.message ?? error}`)
      }
      session.child = child
      session.status = 'running'
      child.onData((data) => this.onOutput(session, Buffer.from(data, 'utf8')))
      child.onExit(({ exitCode, signal }) => {
        this.finish(session, { status: 'closed', code: exitCode, signal: signal ?? null })
      })
      this.announce(session)
      return session.describe()
    }

    // Compatibility mode. `-i` would make bash try to own a terminal it does not
    // have, so the shell runs non-interactive and the host echoes input back —
    // without that the user types into a void.
    let child
    try {
      child = spawn(shell, [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.sessions.delete(session.sessionId)
      throw new TermError(ERR.ptyUnavailable, `无法启动本地终端：${error?.message ?? error}`)
    }
    session.child = child
    session.status = 'running'
    session.echo = true
    child.stdout.on('data', (chunk) => this.onOutput(session, normalizeEol(chunk)))
    child.stderr.on('data', (chunk) => this.onOutput(session, normalizeEol(chunk)))
    child.on('error', (error) => this.finish(session, { status: 'error', error }))
    child.on('close', (code, signal) => this.finish(session, { status: 'closed', code, signal }))
    const notice = `\u001b[33m[兼容模式] 未找到 node-pty，本地终端以管道方式运行：不支持全屏程序与交互式提示。\u001b[0m\r\n`
    this.onOutput(session, Buffer.from(notice, 'utf8'))
    this.announce(session)
    return session.describe()
  }

  /** Write bytes to a session. */
  write(sessionId, buffer) {
    const session = this.require(sessionId)
    if (session.status !== 'running') throw new TermError(ERR.noSession, '会话已结束')
    session.lastSeen = Date.now()
    if (session.kind === 'ssh') {
      session.channel.write(buffer)
      return
    }
    if (session.pty === true) {
      session.child.write(buffer.toString('utf8'))
      return
    }
    // Pipe mode: echo, then translate a bare CR into the newline a pipe-fed shell
    // needs to execute the line.
    if (session.echo === true) this.onOutput(session, echoOf(buffer))
    session.child.stdin.write(buffer.toString('utf8').replace(/\r(?!\n)/g, process.platform === 'win32' ? '\r\n' : '\n'))
  }

  /** Report a new window size. */
  resize(sessionId, cols, rows) {
    const session = this.require(sessionId)
    session.cols = cols
    session.rows = rows
    if (session.status !== 'running') return session.describe()
    if (session.kind === 'ssh') {
      // The reference never did this: its PTY was requested at 80x24 and stayed
      // there, so every resized terminal wrapped at the wrong column forever.
      try {
        session.channel.setWindow(rows, cols, 0, 0)
      } catch { /* a closing channel */ }
    } else if (session.pty === true) {
      try {
        session.child.resize(cols, rows)
      } catch { /* a dying child */ }
    }
    return session.describe()
  }

  /**
   * Everything printed so far, for a fresh attach.
   *
   * `offset` is where the replayed bytes END in the session's stream, and `start`
   * where they begin (older bytes have fallen out of the ring). The panel writes the
   * replay, then trims any live frame that overlaps `offset` — which is what keeps a
   * reattach from double-printing the last screenful.
   *
   * The hub is flushed first so no queued chunk is left to arrive as an "older"
   * frame after this snapshot.
   */
  replay(sessionId) {
    const session = this.require(sessionId)
    session.lastSeen = Date.now()
    this.hub.flush()
    const data = session.buffer.read()
    return {
      session: session.describe(),
      start: session.bytesOut - data.length,
      offset: session.bytesOut,
      data: data.toString('base64'),
    }
  }

  /** End one session. */
  close(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return false
    this.sessions.delete(sessionId)
    try {
      if (session.kind === 'ssh') {
        session.channel.end()
        session.channel.close?.()
      } else if (session.pty === true) {
        session.child.kill()
      } else {
        session.child.stdin.end()
        session.child.kill()
      }
    } catch { /* already gone */ }
    this.finish(session, { status: 'closed', code: session.exitCode })
    this.hub.broadcast('session-removed', { sessionId })
    return true
  }

  /** End every session of one server. */
  closeServer(serverId) {
    let count = 0
    for (const session of [...this.sessions.values()]) {
      if (session.serverId !== serverId) continue
      this.close(session.sessionId)
      count += 1
    }
    return count
  }

  /**
   * Drop sessions nobody is looking at any more.
   *
   * A finished session is kept briefly so a returning panel can still read the
   * last error off the screen; a RUNNING one is only reaped when no panel has had
   * it on screen for the idle window, which is what stops a closed browser from
   * leaving shells behind forever.
   */
  sweep() {
    const now = Date.now()
    for (const session of [...this.sessions.values()]) {
      const watched = this.hub.hasViewer(session.sessionId)
      if (watched) {
        session.lastSeen = now
        continue
      }
      const idleFor = now - session.lastSeen
      if (session.status !== 'running' && idleFor > SESSION_IDLE_MS) {
        this.sessions.delete(session.sessionId)
        continue
      }
      if (session.status === 'running' && idleFor > SESSION_IDLE_MS) this.close(session.sessionId)
    }
  }

  /** Tear everything down. */
  dispose() {
    clearInterval(this.sweeper)
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }
}

/** A pipe-mode shell writes bare LFs; a terminal needs CRLF. */
function normalizeEol(chunk) {
  const text = chunk.toString('utf8')
  return Buffer.from(text.replace(/(?<!\r)\n/g, '\r\n'), 'utf8')
}

/**
 * What to echo for one pipe-mode keystroke: printable text as typed, Enter as a
 * newline, backspace as an erase, and nothing at all for an escape sequence (an
 * arrow key must not paint `^[[A` into the buffer).
 */
function echoOf(buffer) {
  const text = buffer.toString('utf8')
  if (text.includes('\u001b')) return Buffer.alloc(0)
  let out = ''
  for (const char of text) {
    if (char === '\r' || char === '\n') out += '\r\n'
    else if (char === '\u007f' || char === '\b') out += '\b \b'
    else if (char === '\u0003') out += '^C\r\n'
    else if (char >= ' ') out += char
  }
  return Buffer.from(out, 'utf8')
}
