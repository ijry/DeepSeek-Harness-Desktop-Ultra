/**
 * Tunnels: local→remote port forwards and a SOCKS5 proxy, both riding the shared
 * SSH connection.
 *
 * The reference opened a COMPLETE new SSH connection — TCP, handshake, password
 * auth — for every accepted socket. A SOCKS5 proxy in front of a browser therefore
 * re-authenticated per request, which is slow enough to notice and keeps a copy of
 * the credentials in every worker. Here an accepted socket costs one channel on the
 * connection that is already open.
 *
 * Both listeners default to 127.0.0.1. Binding a tunnel to 0.0.0.0 publishes a
 * hole into the remote network to anything that can reach this machine, so it takes
 * an explicit `allowPublic` (see `normalizeListenHost` in shared/protocol.js)
 * rather than happening because a field was left blank.
 *
 * @module dsh-plugin-otools-term/host/tunnel
 */
import { createServer } from 'node:net'
import { ERR, TermError } from '../shared/protocol.js'

/** SOCKS5 wire constants. */
const SOCKS_VERSION = 0x05
const AUTH_NONE = 0x00
const AUTH_UNSUPPORTED = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const REP_OK = 0x00
const REP_FAILURE = 0x01
const REP_UNREACHABLE = 0x04
const REP_CMD_UNSUPPORTED = 0x07
const REP_ATYP_UNSUPPORTED = 0x08

/** How long a half-finished SOCKS5 greeting may sit there. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** The runtime id strings, kept in the reference's shape. */
export function forwardRuntimeId(serverId, ruleId) {
  return `${serverId}::port-forward::${ruleId}`
}

/** The SOCKS5 runtime id for one server. */
export function socksRuntimeId(serverId) {
  return `${serverId}::socks5`
}

/** Bind one listener, mapping the errors a user can actually fix. */
function listen(server, host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE') {
        rejectPromise(new TermError(ERR.portInUse, `本机 ${host}:${port} 已被占用`))
        return
      }
      if (error.code === 'EACCES') {
        rejectPromise(new TermError(ERR.tunnel, `没有权限监听 ${host}:${port}（小于 1024 的端口通常需要管理员）`))
        return
      }
      if (error.code === 'EADDRNOTAVAIL') {
        rejectPromise(new TermError(ERR.tunnel, `本机没有地址 ${host}`))
        return
      }
      rejectPromise(new TermError(ERR.tunnel, `监听 ${host}:${port} 失败：${error.message ?? error}`))
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolvePromise(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** Join a local socket to an SSH channel, counting bytes both ways. */
function bridge(socket, channel, stats) {
  socket.on('error', () => channel.destroy?.())
  channel.on('error', () => socket.destroy())
  socket.on('data', (chunk) => {
    stats.bytesOut += chunk.length
  })
  channel.on('data', (chunk) => {
    stats.bytesIn += chunk.length
  })
  socket.pipe(channel).pipe(socket)
  const done = () => {
    socket.destroy()
    channel.destroy?.()
  }
  socket.on('close', done)
  channel.on('close', done)
}

/** One running forward or proxy. */
class Runtime {
  constructor(fields) {
    Object.assign(this, fields)
    this.connections = 0
    this.bytesIn = 0
    this.bytesOut = 0
    this.startedAt = Date.now()
    this.lastError = ''
  }

  describe() {
    return {
      runtimeId: this.runtimeId,
      serverId: this.serverId,
      ruleId: this.ruleId,
      name: this.name,
      kind: this.kind,
      listenHost: this.listenHost,
      listenPort: this.listenPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      connections: this.connections,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      startedAt: this.startedAt,
      lastError: this.lastError,
    }
  }
}

/** The tunnel manager. */
export class TunnelManager {
  constructor(options) {
    this.pool = options.pool
    this.hub = options.hub
    this.runtimes = new Map()
  }

  /** Announce the whole state (the dialog re-reads it wholesale). */
  announce() {
    this.hub.broadcast('tunnels', { tunnels: this.state() })
  }

  /** Every running tunnel, optionally for one server. */
  state(serverId) {
    const rows = [...this.runtimes.values()]
      .filter((runtime) => serverId === undefined || runtime.serverId === serverId)
      .map((runtime) => runtime.describe())
    return {
      portForwards: rows.filter((row) => row.kind === 'port-forward')
        .sort((left, right) => left.listenPort - right.listenPort || left.name.localeCompare(right.name)),
      socks5: rows.filter((row) => row.kind === 'socks5'),
    }
  }

  /** Whether one rule is running. */
  isRunning(serverId, ruleId) {
    return this.runtimes.has(forwardRuntimeId(serverId, ruleId))
  }

  /** Start (or restart) one local→remote forward. */
  async startForward(server, rule) {
    const runtimeId = forwardRuntimeId(server.id, rule.id)
    this.stop(runtimeId)
    const connection = this.pool.get(server)
    // Fail before the socket exists when the server is unreachable: a listener that
    // accepts and then errors on every connection looks like it works.
    await connection.ready()

    const runtime = new Runtime({
      runtimeId,
      serverId: server.id,
      ruleId: rule.id,
      kind: 'port-forward',
      name: rule.name.length > 0 ? rule.name : `${rule.listenHost}:${rule.listenPort} -> ${rule.remoteHost}:${rule.remotePort}`,
      listenHost: rule.listenHost,
      listenPort: rule.listenPort,
      remoteHost: rule.remoteHost,
      remotePort: rule.remotePort,
    })

    const netServer = createServer((socket) => {
      runtime.connections += 1
      socket.setNoDelay(true)
      connection.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, rule.remoteHost, rule.remotePort)
        .then((channel) => bridge(socket, channel, runtime))
        .catch((error) => {
          runtime.lastError = error?.message ?? String(error)
          socket.destroy()
          this.announce()
        })
    })
    const address = await listen(netServer, rule.listenHost, rule.listenPort)
    runtime.server = netServer
    // Port 0 asks the OS to pick; report what it picked.
    if (address !== null && typeof address === 'object') runtime.listenPort = address.port
    this.runtimes.set(runtimeId, runtime)
    this.announce()
    return runtime.describe()
  }

  /** Start (or restart) the SOCKS5 proxy for one server. */
  async startSocks(server, proxy) {
    const runtimeId = socksRuntimeId(server.id)
    this.stop(runtimeId)
    const connection = this.pool.get(server)
    await connection.ready()

    const runtime = new Runtime({
      runtimeId,
      serverId: server.id,
      ruleId: '',
      kind: 'socks5',
      name: `SOCKS5 ${proxy.listenHost}:${proxy.listenPort}`,
      listenHost: proxy.listenHost,
      listenPort: proxy.listenPort,
      remoteHost: '',
      remotePort: 0,
    })

    const netServer = createServer((socket) => {
      runtime.connections += 1
      socket.setNoDelay(true)
      handleSocks(socket, connection, runtime).catch((error) => {
        runtime.lastError = error?.message ?? String(error)
        socket.destroy()
      })
    })
    const address = await listen(netServer, proxy.listenHost, proxy.listenPort)
    runtime.server = netServer
    if (address !== null && typeof address === 'object') runtime.listenPort = address.port
    this.runtimes.set(runtimeId, runtime)
    this.announce()
    return runtime.describe()
  }

  /** Stop one runtime by id. */
  stop(runtimeId) {
    const runtime = this.runtimes.get(runtimeId)
    if (runtime === undefined) return false
    this.runtimes.delete(runtimeId)
    try {
      runtime.server?.close()
    } catch { /* already closing */ }
    return true
  }

  /** Stop one forward. */
  stopForward(serverId, ruleId) {
    const stopped = this.stop(forwardRuntimeId(serverId, ruleId))
    if (stopped) this.announce()
    return stopped
  }

  /** Stop one server's proxy. */
  stopSocks(serverId) {
    const stopped = this.stop(socksRuntimeId(serverId))
    if (stopped) this.announce()
    return stopped
  }

  /** Stop everything belonging to one server. */
  stopServer(serverId) {
    let count = 0
    for (const [runtimeId, runtime] of [...this.runtimes]) {
      if (runtime.serverId !== serverId) continue
      if (this.stop(runtimeId)) count += 1
    }
    if (count > 0) this.announce()
    return count
  }

  /** Stop everything (plugin teardown). */
  dispose() {
    for (const runtimeId of [...this.runtimes.keys()]) this.stop(runtimeId)
  }
}

/**
 * A byte reader over one socket.
 *
 * One persistent `data` listener with its own leftover buffer, rather than a fresh
 * listener plus `socket.unshift()` per read: unshifting a socket that is already
 * flowing can re-emit the pushed bytes before the next listener is attached, which
 * silently loses them — and a SOCKS5 greeting whose method list arrives in the same
 * TCP segment as its header is exactly that case.
 */
class SocketReader {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.want = 0
    this.resolve = null
    this.reject = null
    this.failed = null
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.settle()
    })
    const die = (error) => {
      this.failed = error ?? new Error('SOCKS5 客户端提前断开')
      if (this.reject !== null) {
        const reject = this.reject
        this.resolve = null
        this.reject = null
        reject(this.failed)
      }
    }
    socket.once('end', () => die())
    socket.once('close', () => die())
    socket.once('error', die)
  }

  /** Hand over `length` bytes as soon as they are all here. */
  read(length, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    if (this.failed !== null) return Promise.reject(this.failed)
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.resolve = null
        this.reject = null
        rejectPromise(new Error('SOCKS5 握手超时'))
      }, timeoutMs)
      this.want = length
      this.resolve = (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      }
      this.reject = (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
      this.settle()
    })
  }

  /** Complete a pending read when enough bytes have arrived. */
  settle() {
    if (this.resolve === null || this.buffer.length < this.want) return
    const value = this.buffer.subarray(0, this.want)
    this.buffer = this.buffer.subarray(this.want)
    const resolve = this.resolve
    this.resolve = null
    this.reject = null
    resolve(value)
  }

  /**
   * Stop reading and give back whatever is left over.
   *
   * The bytes a client pipelined behind its CONNECT request belong to the tunnel, so
   * they are handed to the caller to write into the channel rather than dropped.
   */
  release() {
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    this.socket.removeAllListeners('data')
    return rest
  }
}

/** The fixed ten-byte SOCKS5 reply. */
function socksReply(code) {
  return Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

/**
 * One SOCKS5 client: greeting, CONNECT request, then a bridged channel.
 *
 * No-auth only and CONNECT only, exactly like the reference. BIND and UDP ASSOCIATE
 * are refused with the codes the RFC assigns rather than by hanging up, so a client
 * can report something useful.
 */
async function handleSocks(socket, connection, runtime) {
  const reader = new SocketReader(socket)
  const greeting = await reader.read(2)
  if (greeting[0] !== SOCKS_VERSION) throw new Error(`不支持的 SOCKS 版本：${greeting[0]}`)
  const methods = await reader.read(greeting[1])
  if (!methods.includes(AUTH_NONE)) {
    socket.end(Buffer.from([SOCKS_VERSION, AUTH_UNSUPPORTED]))
    throw new Error('客户端不接受无认证方式')
  }
  socket.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]))

  const head = await reader.read(4)
  if (head[0] !== SOCKS_VERSION) throw new Error('SOCKS5 请求版本不符')
  if (head[1] !== CMD_CONNECT) {
    socket.end(socksReply(REP_CMD_UNSUPPORTED))
    throw new Error(`只支持 CONNECT，收到命令 ${head[1]}`)
  }
  let host
  if (head[3] === ATYP_IPV4) {
    host = [...(await reader.read(4))].join('.')
  } else if (head[3] === ATYP_DOMAIN) {
    const length = (await reader.read(1))[0]
    host = (await reader.read(length)).toString('ascii')
  } else if (head[3] === ATYP_IPV6) {
    const raw = await reader.read(16)
    const parts = []
    for (let index = 0; index < 16; index += 2) parts.push(raw.readUInt16BE(index).toString(16))
    host = parts.join(':')
  } else {
    socket.end(socksReply(REP_ATYP_UNSUPPORTED))
    throw new Error(`不支持的地址类型 ${head[3]}`)
  }
  const port = (await reader.read(2)).readUInt16BE(0)

  let channel
  try {
    channel = await connection.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port)
  } catch (error) {
    // "connection refused" from the remote end is a different answer than "this proxy
    // is broken", and a client that reads the reply code can say which.
    const code = /refused|unreachable|timed out|超时|拒绝/i.test(error?.message ?? '') ? REP_UNREACHABLE : REP_FAILURE
    socket.end(socksReply(code))
    throw error
  }
  const pipelined = reader.release()
  socket.write(socksReply(REP_OK))
  bridge(socket, channel, runtime)
  if (pipelined.length > 0) channel.write(pipelined)
}
