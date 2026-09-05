/**
 * SSH tunnels for connections that need one.
 *
 * The shape is the one every SSH-tunnelling DB client converges on, and the reason
 * for it is not obvious: ssh2's `forwardOut()` does NOT listen on a local port, it
 * opens a channel on demand. So a real `net` server has to sit in front of it,
 * accept the driver's TCP connection, and pipe it through a freshly forwarded
 * channel. Port 0 lets the OS pick the local port, which is then handed to the
 * driver in place of the real host — so no driver in this plugin knows a tunnel
 * exists.
 *
 * Tunnels are cached per connection id and keyed by a signature of the SSH config
 * plus the target, so editing the SSH settings tears the old tunnel down instead of
 * silently reusing it.
 *
 * @module dsh-plugin-otools-dbm/host/tunnel
 */
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'

import { DbmError, ERR } from '../shared/protocol.js'

import { loadDriverNamed } from './engines/drivers/load.js'

/** id → { signature, server, client, port, close } */
const tunnels = new Map()

/** Everything that, if changed, invalidates an existing tunnel. */
function signatureOf(ssh, host, port) {
  return JSON.stringify([
    ssh?.host ?? '',
    Number(ssh?.port) || 22,
    ssh?.username ?? '',
    ssh?.auth_type ?? 'password',
    ssh?.private_key_path ?? '',
    // The secrets are hashed by length only — a signature is compared, logged in
    // debug output, and must never carry a password.
    String(ssh?.password ?? '').length,
    String(ssh?.passphrase ?? '').length,
    host,
    port,
  ])
}

/** Validate the SSH block the panel sent, before anything is dialled. */
export function validateSsh(ssh) {
  if (ssh?.enabled !== true) {
    return false
  }
  if (String(ssh.host ?? '').trim().length === 0) {
    throw new DbmError(ERR.invalidInput, 'SSH 主机地址不能为空')
  }
  if (String(ssh.username ?? '').trim().length === 0) {
    throw new DbmError(ERR.invalidInput, 'SSH 用户名不能为空')
  }
  if (ssh.auth_type === 'private_key') {
    if (String(ssh.private_key_path ?? '').trim().length === 0) {
      throw new DbmError(ERR.invalidInput, 'SSH 私钥路径不能为空')
    }
  } else if (String(ssh.password ?? '').length === 0) {
    throw new DbmError(ERR.invalidInput, 'SSH 密码不能为空')
  }
  return true
}

/**
 * Ensure a tunnel for `connection` and return the loopback endpoint the driver
 * should dial. Returns undefined when the connection needs no tunnel.
 */
export async function resolveTunnel(connection) {
  const ssh = connection?.ssh
  if (!validateSsh(ssh)) {
    return undefined
  }

  const targetHost = String(connection.host ?? '127.0.0.1')
  const targetPort = Number(connection.port) || 0
  if (targetPort === 0) {
    throw new DbmError(ERR.invalidInput, 'SSH 隧道需要一个目标端口')
  }

  const id = String(connection.id ?? '')
  const signature = signatureOf(ssh, targetHost, targetPort)
  const existing = tunnels.get(id)
  if (existing !== undefined) {
    if (existing.signature === signature) {
      return { host: '127.0.0.1', port: existing.port }
    }
    await closeTunnel(id)
  }

  const Client = await loadDriverNamed('ssh2', 'SSH', 'Client')
  const client = new Client()

  const config = {
    host: String(ssh.host).trim(),
    port: Number(ssh.port) || 22,
    username: String(ssh.username).trim(),
    readyTimeout: 15000,
    // ssh2 keeps the process alive otherwise; a panel nobody is looking at must
    // not hold dsh open.
    keepaliveInterval: 30000,
  }
  if (ssh.auth_type === 'private_key') {
    config.privateKey = await readPrivateKey(ssh.private_key_path)
    if (String(ssh.passphrase ?? '').length > 0) {
      config.passphrase = String(ssh.passphrase)
    }
  } else {
    config.password = String(ssh.password ?? '')
  }

  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      if (error === undefined) {
        resolve()
      } else {
        reject(
          new DbmError(
            ERR.internal,
            `SSH 连接失败: ${String(error?.message ?? error)}`,
            { cause: error },
          ),
        )
      }
    }
    client.once('ready', () => finish(undefined))
    client.once('error', (error) => finish(error))
    client.once('close', () => finish(new Error('SSH 连接被关闭')))
    client.connect(config)
  })

  // A late error (network drop, server restart) must not become an uncaught
  // exception; the next query will fail and the user will reconnect.
  client.on('error', () => {})

  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
      if (error) {
        socket.destroy()
        return
      }
      stream.on('error', () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })
  server.on('error', () => {})

  const port = await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new DbmError(ERR.internal, `SSH 隧道本地端口监听失败: ${String(error?.message ?? error)}`)))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

  tunnels.set(id, {
    signature,
    server,
    client,
    port,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()))
      try {
        client.end()
      } catch {
        // Already gone.
      }
    },
  })

  return { host: '127.0.0.1', port }
}

/** Tear down one connection's tunnel. */
export async function closeTunnel(id) {
  const tunnel = tunnels.get(String(id ?? ''))
  if (tunnel === undefined) {
    return
  }
  tunnels.delete(String(id ?? ''))
  try {
    await tunnel.close()
  } catch {
    // Best effort.
  }
}

/** Tear down every tunnel, for plugin teardown. */
export async function closeAllTunnels() {
  await Promise.all(Array.from(tunnels.keys()).map((id) => closeTunnel(id)))
}

/** Read a private key file, with a message that names the path. */
async function readPrivateKey(path) {
  const file = String(path ?? '').trim()
  try {
    return await readFile(file)
  } catch (error) {
    throw new DbmError(ERR.invalidInput, `读不到 SSH 私钥文件: ${file}（${String(error?.message ?? error)}）`)
  }
}
