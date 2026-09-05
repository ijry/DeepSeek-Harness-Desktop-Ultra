/**
 * A real SSH server for the tests.
 *
 * The whole point of this plugin is a Node driver, so the tests drive it against an
 * actual SSH connection rather than a mock: `ssh2.Server` with password auth, a shell
 * channel that echoes, `exec` for the probes and the remote search, and an SFTP
 * subsystem backed by a temp directory through `node:fs`.
 *
 * That makes the SFTP tests real end to end — a `readdir` here really goes over the
 * wire, comes back as protocol attrs, and gets turned into the panel's rows.
 *
 * @module dsh-plugin-otools-term/test/ssh-server
 */
import { generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, readdir, readlink, rename, rmdir, stat, unlink, chmod, open } from 'node:fs/promises'
import { connect } from 'node:net'
import { join, normalize, resolve, sep } from 'node:path'
import ssh2 from 'ssh2'

const { Server } = ssh2

/** SFTP status codes we answer with. */
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }

/** Map one fs error onto an SFTP status. */
function statusOfError(error) {
  if (error?.code === 'ENOENT') return STATUS.NO_SUCH_FILE
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return STATUS.PERMISSION_DENIED
  return STATUS.FAILURE
}

/** Attrs in the shape ssh2's SFTP server expects. */
function attrsOf(info) {
  return {
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    atime: Math.floor(info.atimeMs / 1000),
    mtime: Math.floor(info.mtimeMs / 1000),
  }
}

/**
 * Start the server. Returns `{port, close, root, password, username}`.
 *
 * @param options - `{root}` the directory the SFTP subsystem serves.
 */
export async function startSshServer(options) {
  const root = resolve(options.root)
  const username = options.username ?? 'tester'
  const password = options.password ?? 'secret-pass'
  // PKCS#1 ("BEGIN RSA PRIVATE KEY"), which is what ssh2's key parser accepts;
  // PKCS#8 is rejected with "Unsupported key format".
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })

  /** Resolve one client path inside the served root. */
  const localOf = (remotePath) => {
    const text = String(remotePath ?? '/').replace(/\\/g, '/')
    const relative = text === '.' || text === '' ? '' : text.replace(/^\/+/, '')
    const full = resolve(join(root, normalize(relative)))
    if (full !== root && !full.startsWith(root + sep)) return root
    return full
  }
  /** The remote spelling of one local path. */
  const remoteOf = (localPath) => {
    const rel = resolve(localPath).slice(root.length).split(sep).join('/')
    return rel.length === 0 ? '/' : rel
  }

  const server = new Server({ hostKeys: [keys.privateKey] }, (client) => {
    // A client that refuses our host key disconnects with KEY_EXCHANGE_FAILED, which
    // ssh2 reports as an 'error' on the SERVER's connection object. Unhandled, that
    // takes the whole test process down — and the host-key refusal is exactly what one
    // of the tests asserts.
    client.on('error', () => {})
    client.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.username === username && auth.password === password) {
        auth.accept()
        return
      }
      if (auth.method === 'none') {
        auth.reject(['password'])
        return
      }
      auth.reject()
    })
    client.on('ready', () => {
      // direct-tcpip: what a port forward and the SOCKS5 proxy both ride on. The
      // server really dials the target, so the tunnel tests move bytes end to end.
      client.on('tcpip', (acceptChannel, rejectChannel, info) => {
        const socket = connect(info.destPort, info.destIP, () => {
          const channel = acceptChannel()
          socket.pipe(channel).pipe(socket)
          const done = () => {
            socket.destroy()
            channel.destroy?.()
          }
          socket.on('close', done)
          channel.on('close', done)
        })
        socket.on('error', () => rejectChannel())
      })
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        let ptySize = { cols: 0, rows: 0 }
        session.on('pty', (accept, reject, info) => {
          ptySize = { cols: info.cols, rows: info.rows }
          accept?.()
        })
        session.on('window-change', (accept, reject, info) => {
          ptySize = { cols: info.cols, rows: info.rows }
          // The test asserts the resize arrived, so it is echoed into the stream.
          if (session.__shell !== undefined) session.__shell.write(`SIZE ${info.cols}x${info.rows}\r\n`)
          accept?.()
        })
        session.on('shell', (accept) => {
          const stream = accept()
          session.__shell = stream
          stream.write(`READY ${ptySize.cols}x${ptySize.rows}\r\n`)
          // A line-oriented echo shell: enough to test input, output and exit.
          let line = ''
          stream.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            for (const char of text) {
              if (char === '\r' || char === '\n') {
                if (line === 'exit') {
                  stream.exit(0)
                  stream.end()
                  return
                }
                stream.write(`ECHO ${line}\r\n`)
                line = ''
                continue
              }
              line += char
            }
          })
        })
        session.on('exec', (accept, reject, info) => {
          const stream = accept()
          const command = String(info.command)
          if (/^uname/.test(command)) {
            stream.write('TestOS 1.0\n')
            stream.exit(0)
            stream.end()
            return
          }
          if (/^find /.test(command)) {
            // The search route shells out to `find`; answer with two rows in the
            // GNU -printf shape it asks for first.
            stream.write(`f\t/hello.txt\nd\t/sub\n`)
            stream.exit(0)
            stream.end()
            return
          }
          stream.stderr.write('unsupported\n')
          stream.exit(127)
          stream.end()
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          installSftp(sftp, { localOf, remoteOf })
        })
      })
    })
  })

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    port: server.address().port,
    host: '127.0.0.1',
    username,
    password,
    root,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  }
}

/** Wire one SFTP session onto the real filesystem. */
function installSftp(sftp, paths) {
  const handles = new Map()
  let nextHandle = 1
  const makeHandle = (value) => {
    const id = nextHandle
    nextHandle += 1
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(id, 0)
    handles.set(id, value)
    return buffer
  }
  const handleOf = (buffer) => handles.get(buffer.readUInt32BE(0))
  const dropHandle = (buffer) => handles.delete(buffer.readUInt32BE(0))

  sftp.on('REALPATH', async (reqid, givenPath) => {
    const local = paths.localOf(givenPath)
    sftp.name(reqid, [{ filename: paths.remoteOf(local), longname: paths.remoteOf(local), attrs: {} }])
  })
  sftp.on('OPENDIR', async (reqid, givenPath) => {
    try {
      const local = paths.localOf(givenPath)
      const rows = await readdir(local, { withFileTypes: true })
      sftp.handle(reqid, makeHandle({ kind: 'dir', local, rows, sent: false }))
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('READDIR', async (reqid, handle) => {
    const entry = handleOf(handle)
    if (entry === undefined || entry.kind !== 'dir') {
      sftp.status(reqid, STATUS.FAILURE)
      return
    }
    if (entry.sent) {
      sftp.status(reqid, STATUS.EOF)
      return
    }
    entry.sent = true
    const names = []
    for (const row of entry.rows) {
      try {
        const info = await lstat(join(entry.local, row.name))
        names.push({ filename: row.name, longname: row.name, attrs: attrsOf(info) })
      } catch { /* vanished between readdir and lstat */ }
    }
    sftp.name(reqid, names)
  })
  sftp.on('STAT', (reqid, givenPath) => void statTo(sftp, reqid, paths.localOf(givenPath), stat))
  sftp.on('LSTAT', (reqid, givenPath) => void statTo(sftp, reqid, paths.localOf(givenPath), lstat))
  sftp.on('READLINK', async (reqid, givenPath) => {
    try {
      const target = await readlink(paths.localOf(givenPath))
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }])
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('OPEN', async (reqid, givenPath, flags) => {
    const local = paths.localOf(givenPath)
    // These are SSH_FXF_* protocol bits, NOT node's fs constants — the two sets
    // overlap numerically, so mixing them up silently opens the wrong mode (and then
    // fails with EBADF on the first read).
    const FXF = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 }
    try {
      if ((flags & FXF.WRITE) !== 0 || (flags & FXF.APPEND) !== 0) {
        const mode = (flags & FXF.EXCL) !== 0 ? 'wx' : ((flags & FXF.APPEND) !== 0 ? 'a' : 'w')
        const file = await open(local, mode)
        sftp.handle(reqid, makeHandle({ kind: 'write', file, local }))
        return
      }
      const file = await open(local, 'r')
      sftp.handle(reqid, makeHandle({ kind: 'read', file, local, position: 0 }))
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('READ', async (reqid, handle, offset, length) => {
    const entry = handleOf(handle)
    if (entry === undefined || entry.file === undefined) {
      sftp.status(reqid, STATUS.FAILURE)
      return
    }
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await entry.file.read(buffer, 0, length, offset)
    if (bytesRead === 0) {
      sftp.status(reqid, STATUS.EOF)
      return
    }
    sftp.data(reqid, buffer.subarray(0, bytesRead))
  })
  sftp.on('WRITE', async (reqid, handle, offset, data) => {
    const entry = handleOf(handle)
    if (entry === undefined || entry.file === undefined) {
      sftp.status(reqid, STATUS.FAILURE)
      return
    }
    try {
      await entry.file.write(data, 0, data.length, offset)
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('CLOSE', async (reqid, handle) => {
    const entry = handleOf(handle)
    dropHandle(handle)
    try {
      if (entry?.file !== undefined) await entry.file.close()
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('MKDIR', async (reqid, givenPath) => {
    try {
      await mkdir(paths.localOf(givenPath))
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('RMDIR', async (reqid, givenPath) => {
    try {
      await rmdir(paths.localOf(givenPath))
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('REMOVE', async (reqid, givenPath) => {
    try {
      await unlink(paths.localOf(givenPath))
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('RENAME', async (reqid, fromPath, toPath) => {
    try {
      await rename(paths.localOf(fromPath), paths.localOf(toPath))
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
  sftp.on('SETSTAT', async (reqid, givenPath, attrs) => {
    try {
      if (attrs.mode !== undefined) await chmod(paths.localOf(givenPath), attrs.mode)
      sftp.status(reqid, STATUS.OK)
    } catch (error) {
      sftp.status(reqid, statusOfError(error))
    }
  })
}

/** Answer one stat-ish request. */
async function statTo(sftp, reqid, local, reader) {
  try {
    const info = await reader(local)
    sftp.attrs(reqid, attrsOf(info))
  } catch (error) {
    sftp.status(reqid, statusOfError(error))
  }
}
