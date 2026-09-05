/**
 * The SSH layer: one ssh2 Client per server, shared by every terminal, the SFTP
 * session, and every tunnel that server owns.
 *
 * The reference opened a brand-new TCP connection and authentication handshake for
 * each terminal tab, each SFTP browser AND each accepted socket on a forwarded
 * port — a busy SOCKS5 proxy re-authenticated per request. Here one connection is
 * multiplexed the way OpenSSH's ControlMaster does it: opening a second tab is
 * instant, a forwarded connection costs one channel, and the password is typed
 * once. The trade is that a dropped connection takes every channel with it, so
 * channel death is reported per session and reconnect revives the shared client.
 *
 * Host keys are verified against the pin store (see host/secrets.js). An unknown
 * host fails with `host_key` and the fingerprint attached, so the panel can show
 * it and ask; a CHANGED key fails the same way but with `mismatch: true`, and no
 * accept button clears that.
 *
 * @module dsh-plugin-otools-term/host/ssh
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import ssh2 from 'ssh2'
import { ERR, TermError } from '../shared/protocol.js'
import { fingerprintOf } from './secrets.js'

const { Client } = ssh2

/** TCP + handshake deadline, matching the reference's 30s. */
export const READY_TIMEOUT_MS = 30_000

/** Default keepalive when a server record does not choose one. */
export const DEFAULT_KEEPALIVE_MS = 30_000

/** How many missed keepalives end the connection. */
export const KEEPALIVE_COUNT_MAX = 3

/** The pipe OpenSSH for Windows listens on when no SSH_AUTH_SOCK is set. */
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** Parse the algorithm name out of an SSH public-key blob. */
export function keyTypeOf(keyBuffer) {
  try {
    if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length < 8) return ''
    const length = keyBuffer.readUInt32BE(0)
    if (length <= 0 || length > 64 || keyBuffer.length < 4 + length) return ''
    const name = keyBuffer.subarray(4, 4 + length).toString('ascii')
    return /^[\w.@-]+$/.test(name) ? name : ''
  } catch {
    return ''
  }
}

/** Expand a leading `~` in a private-key path the way every SSH client does. */
export function expandHome(path) {
  const text = String(path ?? '').trim()
  if (text.length === 0) return text
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** Turn an ssh2 / socket failure into one of our stable codes. */
export function classifyError(error, context = {}) {
  if (error instanceof TermError) return error
  const message = error?.message ?? String(error)
  const code = error?.code ?? ''
  const level = error?.level ?? ''
  if (/All configured authentication methods failed/i.test(message) || level === 'client-authentication') {
    return new TermError(ERR.authRequired, `认证失败：${context.username ?? ''}@${context.host ?? ''} 拒绝了提供的凭证`)
  }
  if (/Cannot parse privateKey|Unsupported key format|bad passphrase|Encrypted (OpenSSH )?private key detected/i.test(message)) {
    return new TermError(ERR.authRequired, `私钥无法使用：${message}`)
  }
  if (code === 'ECONNREFUSED') return new TermError(ERR.connect, `连接被拒绝：${context.host}:${context.port}`)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new TermError(ERR.connect, `无法解析主机名：${context.host}`)
  if (code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(message)) {
    return new TermError(ERR.timeout, `连接超时：${context.host}:${context.port}`)
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new TermError(ERR.connect, `网络不可达：${context.host}`)
  if (code === 'ECONNRESET' || /socket hang up/i.test(message)) return new TermError(ERR.connect, `连接被重置：${context.host}`)
  return new TermError(ERR.connect, message)
}

/** One shared connection to one server. */
export class SshConnection {
  constructor(options) {
    this.serverId = options.server.id
    this.server = options.server
    this.secrets = options.secrets
    this.knownHosts = options.knownHosts
    this.onStatus = options.onStatus ?? (() => {})
    this.client = null
    this.connecting = null
    this.status = 'disconnected'
    this.lastError = null
    this.facts = { home: undefined, os: undefined }
    this.sftpPromise = null
    this.channels = new Set()
  }

  /** Keep the caller's record in step with an edit made while connected. */
  update(server) {
    this.server = server
  }

  /** Set and announce the connection status. */
  setStatus(status, error) {
    if (this.status === status && error === undefined) return
    this.status = status
    this.lastError = error ?? null
    this.onStatus({
      serverId: this.serverId,
      status,
      error: error === undefined || error === null ? undefined : (error.message ?? String(error)),
      code: error?.code,
    })
  }

  /** Whether the shared client is usable right now. */
  get connected() {
    return this.client !== null && this.status === 'connected'
  }

  /**
   * The connect config, including the host verifier. Built fresh per attempt so an
   * edited password or a newly accepted host key takes effect without a restart.
   */
  async buildConfig() {
    const server = this.server
    await this.secrets.load()
    await this.knownHosts.load()
    const config = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: server.keepaliveSeconds > 0 ? server.keepaliveSeconds * 1000 : DEFAULT_KEEPALIVE_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // The panel shows the banner in the terminal, so ask for it.
      tryKeyboard: true,
    }

    if (server.authType === 'private_key') {
      const body = this.secrets.get(server.id, 'privateKeyBody')
      if (body !== undefined) {
        config.privateKey = body
      } else if (server.privateKeyPath.length > 0) {
        const path = expandHome(server.privateKeyPath)
        if (!isAbsolute(path)) throw new TermError(ERR.invalidInput, '私钥路径必须是绝对路径')
        try {
          config.privateKey = await readFile(resolve(path))
        } catch (error) {
          // The path itself is echoed back (the user typed it); the reason is not,
          // so a probe cannot use this route to map the filesystem.
          throw new TermError(ERR.authRequired, `无法读取私钥文件：${server.privateKeyPath}（${error.code ?? 'ERR'}）`)
        }
      } else {
        throw new TermError(ERR.authRequired, '这个连接选择了私钥认证，但既没有私钥文件也没有粘贴的私钥内容')
      }
      const passphrase = this.secrets.get(server.id, 'passphrase')
      if (passphrase !== undefined) config.passphrase = passphrase
    } else {
      const password = this.secrets.get(server.id, 'password')
      if (password !== undefined) {
        config.password = password
        // Servers that only offer keyboard-interactive still take the same secret.
        config.onKeyboardInteractive = (_name, _instructions, _lang, prompts, finish) => {
          finish(prompts.map(() => password))
        }
      }
    }

    if (server.useAgent === true) {
      const socket = process.env.SSH_AUTH_SOCK
      config.agent = socket !== undefined && socket.length > 0
        ? socket
        : (process.platform === 'win32' ? WINDOWS_AGENT_PIPE : undefined)
      if (config.agent === undefined) {
        throw new TermError(ERR.authRequired, '勾选了 SSH Agent，但环境里没有 SSH_AUTH_SOCK')
      }
    }

    if (config.privateKey === undefined && config.password === undefined && config.agent === undefined) {
      throw new TermError(ERR.authRequired, '这个连接还没有保存凭证')
    }

    config.hostVerifier = (key) => {
      const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key)
      const fingerprint = fingerprintOf(buffer)
      const keyType = keyTypeOf(buffer)
      const pinned = this.knownHosts.lookup(server.host, server.port)
      if (pinned === undefined) {
        this.pendingHostKey = { fingerprint, keyType, mismatch: false }
        return false
      }
      if (pinned.fingerprint !== fingerprint) {
        this.pendingHostKey = { fingerprint, keyType, mismatch: true, pinned: pinned.fingerprint }
        return false
      }
      this.pendingHostKey = undefined
      return true
    }
    return config
  }

  /** Connect (or join the in-flight attempt). Resolves with the ssh2 Client. */
  ready() {
    if (this.connected) return Promise.resolve(this.client)
    if (this.connecting !== null) return this.connecting
    this.connecting = this.openClient()
      .then((client) => {
        this.connecting = null
        return client
      })
      .catch((error) => {
        this.connecting = null
        throw error
      })
    return this.connecting
  }

  /** One connection attempt. */
  async openClient() {
    this.setStatus('connecting')
    let config
    try {
      config = await this.buildConfig()
    } catch (error) {
      this.setStatus('error', error)
      throw error
    }
    const client = new Client()
    const context = { host: this.server.host, port: this.server.port, username: this.server.username }

    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finishOk = () => {
        if (settled) return
        settled = true
        this.client = client
        this.setStatus('connected')
        void this.probeFacts()
        resolvePromise(client)
      }
      const finishFail = (error) => {
        const failure = this.pendingHostKey !== undefined
          ? new TermError(ERR.hostKey, this.pendingHostKey.mismatch
            ? `主机密钥与已记录的不一致，连接已中止：${this.server.host}:${this.server.port}`
            : `首次连接 ${this.server.host}:${this.server.port}，请先核对主机密钥指纹`, {
            fingerprint: this.pendingHostKey.fingerprint,
            keyType: this.pendingHostKey.keyType,
            mismatch: this.pendingHostKey.mismatch,
            pinnedFingerprint: this.pendingHostKey.pinned,
            host: this.server.host,
            port: this.server.port,
          })
          : classifyError(error, context)
        this.pendingHostKey = undefined
        this.client = null
        this.sftpPromise = null
        this.setStatus('error', failure)
        if (settled) return
        settled = true
        try {
          client.end()
        } catch { /* nothing to end */ }
        rejectPromise(failure)
      }

      client.on('ready', finishOk)
      client.on('error', finishFail)
      client.on('close', () => {
        // A close after a successful ready is a dropped connection, not a failed
        // attempt: every channel is already gone, so the pool must forget it.
        if (this.client === client) {
          this.client = null
          this.sftpPromise = null
          this.channels.clear()
          if (this.status !== 'error') this.setStatus('disconnected')
        }
        if (!settled) finishFail(new Error('连接在完成握手前被关闭'))
      })
      client.on('banner', (message) => {
        this.onStatus({ serverId: this.serverId, status: this.status, banner: String(message ?? '') })
      })
      try {
        client.connect(config)
      } catch (error) {
        finishFail(error)
      }
    })
  }

  /** Home directory and OS string, for the SFTP start path and the AI context. */
  async probeFacts() {
    if (this.facts.home === undefined) {
      try {
        const sftp = await this.sftp()
        this.facts.home = await new Promise((res) => {
          sftp.realpath('.', (error, absolute) => res(error !== undefined && error !== null ? undefined : absolute))
        })
      } catch { /* a server without SFTP still gives terminals */ }
    }
    if (this.facts.os === undefined) {
      try {
        const out = await this.exec('uname -sr 2>/dev/null || ver', { timeoutMs: 8_000 })
        const text = out.stdout.trim() || out.stderr.trim()
        if (text.length > 0) this.facts.os = text.split(/\r?\n/)[0].slice(0, 120)
      } catch { /* best effort */ }
    }
  }

  /** Open an interactive shell channel. */
  async shell(options) {
    const client = await this.ready()
    return await new Promise((resolvePromise, rejectPromise) => {
      client.shell({
        term: options.term ?? 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        // Pixel geometry: xterm reports none, and 0 means "use the character
        // grid", which is what every terminal does here.
        width: 0,
        height: 0,
        modes: {},
      }, (error, channel) => {
        if (error !== undefined && error !== null) {
          rejectPromise(classifyError(error, { host: this.server.host, port: this.server.port }))
          return
        }
        this.channels.add(channel)
        channel.on('close', () => this.channels.delete(channel))
        resolvePromise(channel)
      })
    })
  }

  /** Run one command, buffering its output (used for probes, never for the UI). */
  async exec(command, options = {}) {
    const client = await this.ready()
    const limit = options.maxBytes ?? 256 * 1024
    return await new Promise((resolvePromise, rejectPromise) => {
      client.exec(command, (error, stream) => {
        if (error !== undefined && error !== null) {
          rejectPromise(classifyError(error, {}))
          return
        }
        let stdout = ''
        let stderr = ''
        let code = null
        const timer = setTimeout(() => {
          try {
            stream.close()
          } catch { /* already closed */ }
          rejectPromise(new TermError(ERR.timeout, `命令超时：${command.slice(0, 60)}`))
        }, options.timeoutMs ?? 30_000)
        if (typeof timer.unref === 'function') timer.unref()
        stream.on('data', (chunk) => {
          if (stdout.length < limit) stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk) => {
          if (stderr.length < limit) stderr += chunk.toString('utf8')
        })
        stream.on('exit', (exitCode) => {
          code = exitCode
        })
        stream.on('close', () => {
          clearTimeout(timer)
          resolvePromise({ stdout, stderr, code })
        })
      })
    })
  }

  /** The shared SFTP session (opened on demand, reused). */
  async sftp() {
    if (this.sftpPromise !== null) return await this.sftpPromise
    const client = await this.ready()
    this.sftpPromise = new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, sftp) => {
        if (error !== undefined && error !== null) {
          this.sftpPromise = null
          rejectPromise(new TermError(ERR.sftp, `打开 SFTP 通道失败：${error.message ?? error}`))
          return
        }
        sftp.on('close', () => {
          this.sftpPromise = null
        })
        sftp.on('error', () => {
          this.sftpPromise = null
        })
        resolvePromise(sftp)
      })
    })
    return await this.sftpPromise
  }

  /** Open a direct-tcpip channel (port forwarding and the SOCKS5 proxy). */
  async forwardOut(srcHost, srcPort, dstHost, dstPort) {
    const client = await this.ready()
    return await new Promise((resolvePromise, rejectPromise) => {
      client.forwardOut(srcHost, srcPort, dstHost, dstPort, (error, channel) => {
        if (error !== undefined && error !== null) {
          rejectPromise(new TermError(ERR.tunnel, `无法打开到 ${dstHost}:${dstPort} 的通道：${error.message ?? error}`))
          return
        }
        resolvePromise(channel)
      })
    })
  }

  /** Close the connection and everything on it. */
  close() {
    const client = this.client
    this.client = null
    this.sftpPromise = null
    this.channels.clear()
    if (client !== null) {
      try {
        client.end()
      } catch { /* already gone */ }
    }
    this.setStatus('disconnected')
  }
}

/** The pool: one connection per server id. */
export class SshPool {
  constructor(options) {
    this.secrets = options.secrets
    this.knownHosts = options.knownHosts
    this.onStatus = options.onStatus ?? (() => {})
    this.connections = new Map()
  }

  /** The connection for one server record, created on first use. */
  get(server) {
    const existing = this.connections.get(server.id)
    if (existing !== undefined) {
      existing.update(server)
      return existing
    }
    const connection = new SshConnection({
      server,
      secrets: this.secrets,
      knownHosts: this.knownHosts,
      onStatus: this.onStatus,
    })
    this.connections.set(server.id, connection)
    return connection
  }

  /** The connection for one server id if it exists. */
  peek(serverId) {
    return this.connections.get(serverId)
  }

  /** Status of every known connection, for the sidebar dots. */
  statuses() {
    const rows = {}
    for (const [serverId, connection] of this.connections) {
      rows[serverId] = {
        status: connection.status,
        error: connection.lastError === null ? undefined : connection.lastError.message,
        os: connection.facts.os,
        home: connection.facts.home,
      }
    }
    return rows
  }

  /** Drop one server's connection. */
  close(serverId) {
    const connection = this.connections.get(serverId)
    if (connection === undefined) return
    connection.close()
    this.connections.delete(serverId)
  }

  /** Drop everything (plugin teardown). */
  dispose() {
    for (const serverId of [...this.connections.keys()]) this.close(serverId)
  }
}
