/**
 * Agent terminals: launch a CLI in a real pty and stream it to the panel's xterm.
 *
 * This is what the Vibe screen is: you pick an account pool, then launch `codex` or `claude`
 * in a terminal that is already pointed at it. The value is the combination — the CLI runs
 * against whichever account the pool picks, and you watch it in the same window where you
 * configured that.
 *
 * `node-pty` is an OPTIONAL dependency, and its absence is a documented degradation rather
 * than a broken screen: without it the process is spawned with pipes, which means no TTY, so
 * a CLI that draws a full-screen interface will not. The panel says so instead of showing an
 * empty black rectangle. (This is the same choice the otools-term plugin in this repo made,
 * for the same reason: a prebuilt native module that fails to install must not take the
 * plugin down with it.)
 *
 * @module dsh-plugin-ai-switch/host/terminals
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

import { ApiError, requireText, validation } from '../shared/protocol.js'
import {
  AGENT_LAUNCHERS,
  agentSupportsModelFlag,
  agentSupportsReasoning,
  findProgramInPath,
  parsePlatform,
  platformDisplayName,
  requireCapability,
} from './platforms.js'
import { uuid } from './sdk.js'

/** Rows/columns a session starts at when the panel has not measured yet. */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

/** Scrollback the host keeps per session, so a reopened panel can repaint. */
const REPLAY_LIMIT = 256 * 1024

/** How many sessions may run at once. A pty per tab, not per keystroke. */
const MAX_SESSIONS = 32

let ptyModule = null

/**
 * Load node-pty once, tolerating its absence.
 *
 * Dynamic `import()` because this file is ESM and the module is optional: a static import of
 * a package that may not be installed fails at load time and takes the whole host half with
 * it. Awaited by `create`, so the first launch pays for it and later ones do not.
 */
async function loadPty() {
  if (ptyModule !== null) {
    return ptyModule.module
  }
  try {
    ptyModule = { module: await import('@homebridge/node-pty-prebuilt-multiarch') }
  } catch {
    ptyModule = { module: undefined }
  }
  return ptyModule.module
}

/** Is a real pty available? The panel shows a warning when it is not. */
export async function ptyAvailable() {
  return (await loadPty()) !== undefined
}

/** `list_agent_launch_options`: which CLIs are installed, and what to run them with. */
export function listAgentLaunchOptions({ catalogFor = () => [] } = {}) {
  return AGENT_LAUNCHERS.map((launcher) => ({
    platform: launcher.platform,
    displayName: platformDisplayName(launcher.platform),
    program: launcher.program,
    installed: findProgramInPath(launcher.program) !== null,
    npmPackage: launcher.npm_package,
    installCommand: `npm install -g ${launcher.npm_package}`,
    supportsModelSelection: agentSupportsModelFlag(launcher.platform),
    supportsReasoning: agentSupportsReasoning(launcher.platform),
    models: agentSupportsModelFlag(launcher.platform)
      ? catalogFor(launcher.platform).map((model) => ({
          id: model.id,
          reasoningLevels: model.supported_reasoning_levels.map((level) => ({
            effort: level.effort,
            description: level.description ?? '',
          })),
          defaultReasoningLevel: model.default_reasoning_level ?? null,
        }))
      : [],
  }))
}

/** The command line one launch runs, as `{program, args}`. */
export function buildLaunchCommand(input) {
  const kind = String(input?.kind ?? 'shell')
  if (kind === 'resume' || kind === 'shell') {
    const command = String(input?.command ?? '').trim()
    if (command.length === 0) {
      if (kind === 'shell') {
        return { program: defaultShell(), args: [] }
      }
      throw validation('validation.required', 'A resume command is required', 'command')
    }
    // A resume command is a whole command line the session scanner produced
    // (`codex resume <id>`), so it is split rather than treated as one program name.
    const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const [program, ...args] = parts.map((part) => part.replace(/^["']|["']$/g, ''))
    return { program, args }
  }
  const platform = parsePlatform(input?.platform)
  const launcher = AGENT_LAUNCHERS.find((item) => item.platform === platform)
  if (launcher === undefined) {
    throw validation('validation.platform_no_agent', 'That platform has no launchable CLI', platform)
  }
  const args = []
  const model = String(input?.model ?? '').trim()
  if (model.length > 0 && agentSupportsModelFlag(platform)) {
    args.push('--model', model)
  }
  const effort = String(input?.reasoningEffort ?? '').trim()
  if (effort.length > 0 && agentSupportsReasoning(platform)) {
    args.push('-c', `model_reasoning_effort="${effort}"`)
  }
  return { program: launcher.program, args }
}

function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

/** The running sessions. One instance per host. */
export class TerminalManager {
  /** @param options.emit - `(channel, payload) => void`; the panel subscribes to these. */
  constructor({ emit = () => {}, hub = null } = {}) {
    this.emit = emit
    this.hub = hub
    this.sessions = new Map()
  }

  /** `list_terminal_sessions`. */
  list() {
    return Array.from(this.sessions.values()).map((session) => session.meta)
  }

  /** `create_terminal_session`. */
  async create(input) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new ApiError('terminal.too_many_sessions', `At most ${MAX_SESSIONS} terminals can run at once`, {
        recoverable: true,
      })
    }
    const cwd = requireText(input?.cwd, 'cwd', 4096)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw validation('validation.terminal_cwd', 'That working directory does not exist', cwd)
    }
    const platform = input?.platform === null || input?.platform === undefined ? null : parsePlatform(input.platform)
    if (platform !== null && String(input?.kind ?? '') === 'agent') {
      requireCapability(platform, 'terminal_launch')
    }
    const { program, args } = buildLaunchCommand(input)
    const resolved = findProgramInPath(program)
    if (resolved === null && String(input?.kind ?? '') !== 'shell') {
      throw new ApiError('terminal.program_missing', `${program} is not on PATH`, {
        details: program,
        recoverable: true,
      })
    }

    const id = uuid()
    const cols = clamp(input?.cols, 20, 500, DEFAULT_COLS)
    const rows = clamp(input?.rows, 5, 200, DEFAULT_ROWS)
    const meta = {
      id,
      title: String(input?.title ?? '').trim() || `${program} ${args.join(' ')}`.trim(),
      platform,
      cwd,
      command: [program, ...args].join(' '),
      status: 'running',
      createdAt: Date.now(),
    }

    const pty = await loadPty()
    const session = { meta, replay: '', pty: null, child: null }
    if (pty !== undefined) {
      const term = pty.spawn(resolved ?? program, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      session.pty = term
      term.onData((data) => this.#output(id, data))
      term.onExit(({ exitCode }) => this.#exit(id, exitCode))
    } else {
      const child = spawn(resolved ?? program, args, { cwd, env: process.env, shell: false })
      session.child = child
      child.stdout?.on('data', (chunk) => this.#output(id, chunk.toString('utf8')))
      child.stderr?.on('data', (chunk) => this.#output(id, chunk.toString('utf8')))
      child.on('error', (error) => this.#error(id, String(error?.message ?? error)))
      child.on('exit', (code) => this.#exit(id, code))
      this.#output(
        id,
        // Said on the terminal itself rather than only in a tooltip: a CLI that redraws will
        // look broken here, and the user needs to know it is the missing module, not the CLI.
        '\r\n[ai-switch] node-pty is not installed, so this terminal has no TTY.\r\n' +
          '[ai-switch] Full-screen CLIs will not render. Install the optional dependency and reopen.\r\n\r\n',
      )
    }
    this.sessions.set(id, session)
    return meta
  }

  #output(id, data) {
    const session = this.sessions.get(id)
    if (session === undefined) {
      return
    }
    // Keep a bounded tail so a panel that reconnects can repaint rather than showing an
    // empty terminal for a process that is mid-answer.
    session.replay = `${session.replay}${data}`.slice(-REPLAY_LIMIT)
    this.emit('terminal://output', { sessionId: id, data })
  }

  #exit(id, exitCode) {
    const session = this.sessions.get(id)
    if (session === undefined) {
      return
    }
    session.meta.status = 'exited'
    this.emit('terminal://exit', { sessionId: id, exitCode: exitCode ?? null })
  }

  #error(id, message) {
    const session = this.sessions.get(id)
    if (session !== undefined) {
      session.meta.status = 'error'
    }
    this.emit('terminal://error', { sessionId: id, message })
  }

  #require(sessionId) {
    const session = this.sessions.get(requireText(sessionId, 'sessionId'))
    if (session === undefined) {
      throw validation('validation.terminal_session_not_found', 'That terminal is gone', String(sessionId))
    }
    return session
  }

  /**
   * `write_terminal_input`.
   *
   * Refuses when nothing is listening, exactly as the reference does: input to a terminal
   * whose output nobody can see is a process running blind.
   */
  write(sessionId, data) {
    const session = this.#require(sessionId)
    if (this.hub !== null && !this.hub.connected) {
      throw new ApiError('web.terminal_not_subscribed', 'No panel is listening to that terminal', {
        details: String(sessionId),
        recoverable: true,
      })
    }
    const text = typeof data === 'string' ? data : ''
    if (session.pty !== null) {
      session.pty.write(text)
      return null
    }
    session.child?.stdin?.write(text)
    // Without a pty there is no local echo, so the host provides it or typing looks dead.
    this.#output(sessionId, text)
    return null
  }

  /** `resize_terminal`. A no-op without a pty, which has no concept of a window. */
  resize(sessionId, cols, rows) {
    const session = this.#require(sessionId)
    session.pty?.resize(clamp(cols, 20, 500, DEFAULT_COLS), clamp(rows, 5, 200, DEFAULT_ROWS))
    return null
  }

  /** `kill_terminal_session`. */
  kill(sessionId) {
    const session = this.#require(sessionId)
    try {
      session.pty?.kill()
      session.child?.kill()
    } catch {
      /* already dead */
    }
    session.meta.status = 'exited'
    this.sessions.delete(session.meta.id)
    return null
  }

  /** The scrollback a reopened panel repaints from. */
  replay(sessionId) {
    return this.sessions.get(String(sessionId ?? ''))?.replay ?? ''
  }

  /** Kill everything. Called when the plugin is disposed — no orphaned CLIs. */
  disposeAll() {
    for (const id of Array.from(this.sessions.keys())) {
      try {
        this.kill(id)
      } catch {
        /* already gone */
      }
    }
  }
}

function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.trunc(number)))
}


