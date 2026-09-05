/**
 * The engine: one object holding every host-side piece, plus the operations that
 * touch more than one of them.
 *
 * The routes stay pure dispatch — parse, validate, call one method here, write the
 * envelope — so the interesting behaviour (what "disconnect" means, what a fresh
 * panel needs to paint itself) is testable without an HTTP server.
 *
 * @module dsh-plugin-otools-term/host/engine
 */
import { ERR, LOCAL_SERVER_ID, TermError } from '../shared/protocol.js'
import { AiJobs, aiAvailability } from './ai.js'
import { probeClients } from './desktop.js'
import { EventHub } from './events.js'
import { KnownHosts, SecretStore } from './secrets.js'
import { SftpFace } from './sftp.js'
import { SshPool } from './ssh.js'
import { loadPty, ptyUnavailableReason, SessionRegistry, defaultShell } from './terminals.js'
import { TransferRegistry } from './transfer.js'
import { TunnelManager } from './tunnel.js'
import { vendorReady } from './vendor.js'
import { createLocalPaths } from './workspaces.js'
import { hostLang } from '../shared/lang.js'

/** Everything the host owns, wired together. */
export class TermEngine {
  constructor(options) {
    this.store = options.store
    this.ai = options.ai
    this.secrets = new SecretStore({ file: options.secretsFile })
    this.knownHosts = new KnownHosts({ file: options.knownHostsFile })
    this.hub = new EventHub()
    this.pool = new SshPool({
      secrets: this.secrets,
      knownHosts: this.knownHosts,
      onStatus: (event) => this.hub.broadcast('connection', event),
    })
    this.sessions = new SessionRegistry({ pool: this.pool, hub: this.hub })
    this.transfers = new TransferRegistry({ hub: this.hub })
    this.tunnels = new TunnelManager({ pool: this.pool, hub: this.hub })
    this.jobs = new AiJobs({ hub: this.hub, ai: this.ai })
    this.localPaths = createLocalPaths(options.workspaces)
    this.unsubscribeStore = this.store.subscribe((change) => {
      this.hub.broadcast('state', { revision: change.revision, kind: change.kind })
    })
  }

  /** One stored server, or a not-found failure. */
  async serverOf(serverId) {
    await this.store.load()
    return this.store.requireServer(serverId)
  }

  /** One stored SSH server, refusing the RDP/VNC rows. */
  async sshServerOf(serverId) {
    const server = await this.serverOf(serverId)
    if (server.protocol !== 'ssh') throw new TermError(ERR.invalidInput, `${server.name} 不是 SSH 连接`)
    return server
  }

  /** The SFTP façade for one server (opens the connection if needed). */
  async sftpOf(serverId) {
    const server = await this.sshServerOf(serverId)
    return new SftpFace(this.pool.get(server))
  }

  /** The shared connection for one server. */
  async connectionOf(serverId) {
    const server = await this.sshServerOf(serverId)
    return this.pool.get(server)
  }

  /** Connect eagerly, so the panel can report the outcome of a click. */
  async connect(serverId) {
    const connection = await this.connectionOf(serverId)
    await connection.ready()
    return { serverId, status: connection.status, facts: connection.facts }
  }

  /**
   * Close one server down: its terminals, its tunnels, its SFTP channel and the
   * shared connection. Callers decide whether the panel keeps the tabs (the
   * `closeBehavior` setting) — that is a browser-side choice, not a host one.
   */
  async disconnect(serverId) {
    const sessions = this.sessions.closeServer(serverId)
    const tunnels = this.tunnels.stopServer(serverId)
    this.pool.close(serverId)
    return { serverId, sessions, tunnels }
  }

  /** Accept the fingerprint the last failed connect reported, then retry. */
  async acceptHostKey(serverId, fingerprint, keyType) {
    const server = await this.sshServerOf(serverId)
    await this.knownHosts.load()
    const pinned = this.knownHosts.lookup(server.host, server.port)
    if (pinned !== undefined && pinned.fingerprint !== fingerprint) {
      // A mismatch is not something an accept button may resolve: the user has to
      // delete the old pin deliberately, having decided the change is legitimate.
      throw new TermError(ERR.hostKey, '这个主机已经有一条不同的密钥记录，请先在设置里删除旧记录再接受新密钥', {
        pinnedFingerprint: pinned.fingerprint,
        fingerprint,
        mismatch: true,
      })
    }
    await this.knownHosts.remember(server.host, server.port, keyType ?? '', fingerprint)
    return { serverId, endpoint: KnownHosts.keyOf(server.host, server.port), fingerprint }
  }

  /** Drop a pin (after a legitimate host rebuild). */
  async forgetHostKey(host, port) {
    await this.knownHosts.forget(host, port)
    return { endpoint: KnownHosts.keyOf(host, port) }
  }

  /** Open a terminal: an SSH shell, or the local one. */
  async openTerminal(request) {
    if (request.serverId === LOCAL_SERVER_ID) {
      return await this.sessions.openLocal({
        sessionId: request.sessionId,
        serverId: LOCAL_SERVER_ID,
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        shell: this.store.state.prefs.localShell,
      })
    }
    const server = await this.sshServerOf(request.serverId)
    return await this.sessions.openSsh({
      sessionId: request.sessionId,
      server,
      cols: request.cols,
      rows: request.rows,
      initialCommand: request.initialCommand,
      cwd: request.cwd,
    })
  }

  /** The AI context for one session: the machine it is on and its recent output. */
  aiContextOf(sessionId) {
    const session = this.sessions.peek(sessionId)
    if (session === undefined) return { facts: {}, transcript: '', cwd: undefined }
    const connection = session.kind === 'ssh' ? this.pool.peek(session.serverId) : undefined
    const facts = session.kind === 'ssh'
      ? { os: connection?.facts.os, shell: undefined }
      : { os: `${process.platform} (本机)`, shell: session.shell }
    return {
      facts,
      // The host's own ring buffer is the transcript: the browser does not have to
      // ship the screen back up, and what the model sees is exactly what was
      // printed (escape sequences stripped below).
      transcript: stripAnsi(session.buffer.read().toString('utf8')),
      cwd: session.kind === 'ssh' ? connection?.facts.home : session.cwd,
    }
  }

  /** Everything a freshly opened panel needs, in one response. */
  async state() {
    await this.store.load()
    await this.secrets.load()
    await this.knownHosts.load()
    const pty = await loadPty()
    return {
      revision: this.store.revision,
      language: hostLang(),
      ...this.store.snapshot(this.secrets),
      sessions: this.sessions.list(),
      tasks: this.transfers.list(),
      tunnels: this.tunnels.state(),
      connections: this.pool.statuses(),
      jobs: this.jobs.list(),
      knownHosts: this.knownHosts.list(),
      workspaces: this.localPaths.list(),
      ai: aiAvailability(this.ai),
      local: {
        pty: pty !== null,
        reason: pty === null ? ptyUnavailableReason() : '',
        shell: defaultShell(this.store.state.prefs.localShell),
        platform: process.platform,
      },
      desktop: await probeClients(),
      vendor: await vendorReady(),
    }
  }

  /** Tear everything down (plugin unload). */
  dispose() {
    this.unsubscribeStore()
    this.jobs.dispose()
    this.tunnels.dispose()
    this.transfers.dispose()
    this.sessions.dispose()
    this.pool.dispose()
    this.hub.dispose()
  }
}

/**
 * Strip escape sequences out of a transcript before it reaches the model.
 *
 * A screenful of colour codes and cursor moves is a third of the token budget and
 * tells the model nothing. Handles OSC (both BEL- and ST-terminated), CSI, and the
 * leftover C0 controls.
 *
 * The patterns are built from strings with ESC escapes rather than written as
 * literals on purpose: a raw ESC byte in a source file is invisible in every diff
 * and review tool, and `--check` will not tell you it is there.
 */
export function stripAnsi(text) {
  const ESC = '\\u001b'
  const OSC = new RegExp(`${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)`, 'g')
  const CSI = new RegExp(`${ESC}[\\[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[0-9A-PR-TZcf-nqry=><]`, 'g')
  const C0 = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g')
  return String(text)
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(C0, '')
}
