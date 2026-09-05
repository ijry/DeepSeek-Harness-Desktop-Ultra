/**
 * The remote-desktop launcher: hands an RDP or VNC connection to a NATIVE client
 * on this machine, exactly as the reference did. Nothing is embedded — there is no
 * RDP protocol implementation here, and the panel is a launch button plus a summary
 * card.
 *
 * Three deliberate differences from the reference:
 *
 *  - The executable is chosen from a fixed table of known clients and spawned with
 *    an argv, never through a shell. The reference used `cmd /C start "" vnc://…`,
 *    which parses a URL built from stored fields on a command line.
 *  - The password is NOT passed by default. `cmdkey /pass:<password>` and
 *    `vnc://:<password>@host` put a credential in a command line, where any process
 *    listing on the machine can read it; that now takes an explicit opt-in per
 *    launch, and without it the native client prompts (which is what the
 *    reference's own "启动时输入" state already described).
 *  - A missing client is reported with the names that were tried instead of a bare
 *    non-zero exit.
 *
 * @module dsh-plugin-otools-term/host/desktop
 */
import { spawn } from 'node:child_process'
import { access, constants, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERR, TermError } from '../shared/protocol.js'

/** Candidate clients per platform and protocol, in preference order. */
export const CLIENTS = {
  win32: {
    rdp: [{ command: 'mstsc.exe', kind: 'mstsc' }],
    vnc: [
      { command: 'vncviewer.exe', kind: 'vncviewer' },
      { command: 'tvnviewer.exe', kind: 'tightvnc' },
      { command: 'C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe', kind: 'realvnc' },
      { command: 'C:\\Program Files\\TightVNC\\tvnviewer.exe', kind: 'tightvnc' },
    ],
  },
  darwin: {
    rdp: [{ command: 'open', kind: 'open-url' }],
    vnc: [{ command: 'open', kind: 'open-url' }],
  },
  linux: {
    rdp: [
      { command: 'xfreerdp', kind: 'xfreerdp' },
      { command: 'xfreerdp3', kind: 'xfreerdp' },
      { command: 'remmina', kind: 'remmina' },
      { command: 'xdg-open', kind: 'open-url' },
    ],
    vnc: [
      { command: 'vncviewer', kind: 'vncviewer' },
      { command: 'remmina', kind: 'remmina' },
      { command: 'xdg-open', kind: 'open-url' },
    ],
  },
}

/** Whether one candidate exists on this machine. */
async function exists(command) {
  // An absolute path is checked directly; a bare name is left to the OS resolver
  // (spawn reports ENOENT, which the caller turns into "tried these").
  if (!command.includes('/') && !command.includes('\\')) return true
  try {
    await access(command, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Build the argv for one client kind. */
export function buildArgv(kind, options) {
  const { protocol, host, port, username, password, sendPassword } = options
  const address = `${host}:${port}`
  if (kind === 'mstsc') return { command: 'mstsc.exe', args: [options.rdpFile] }
  if (kind === 'xfreerdp') {
    const args = [`/v:${address}`, '/dynamic-resolution', '+clipboard']
    if (username.length > 0) args.push(`/u:${username}`)
    if (sendPassword && password.length > 0) args.push(`/p:${password}`)
    else args.push('/from-stdin')
    return { command: options.command, args }
  }
  if (kind === 'remmina') {
    const url = protocol === 'rdp'
      ? `rdp://${username.length > 0 ? `${encodeURIComponent(username)}@` : ''}${address}`
      : `vnc://${address}`
    return { command: options.command, args: ['-c', url] }
  }
  if (kind === 'vncviewer' || kind === 'tightvnc' || kind === 'realvnc') {
    return { command: options.command, args: [address] }
  }
  if (kind === 'open-url') {
    const url = protocol === 'rdp'
      ? `rdp://full%20address=s:${address}${username.length > 0 ? `&username=s:${encodeURIComponent(username)}` : ''}`
      : `vnc://${address}`
    return { command: options.command, args: [url] }
  }
  throw new TermError(ERR.desktop, `未知的客户端类型：${kind}`)
}

/**
 * The `.rdp` file mstsc reads. A file rather than a command line because mstsc
 * takes almost no connection settings as flags, and because the password never
 * appears here at all — `prompt for credentials:i:1` makes Windows ask.
 */
export function rdpFileBody({ host, port, username }) {
  const lines = [
    'screen mode id:i:2',
    'use multimon:i:0',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    'compression:i:1',
    'keyboardhook:i:2',
    'audiocapturemode:i:0',
    'videoplaybackmode:i:1',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'displayconnectionbar:i:1',
    'enableworkspacereconnect:i:0',
    'disable wallpaper:i:0',
    'allow font smoothing:i:1',
    'allow desktop composition:i:1',
    'redirectclipboard:i:1',
    'redirectprinters:i:0',
    'autoreconnection enabled:i:1',
    'authentication level:i:2',
    'prompt for credentials:i:1',
    'negotiate security layer:i:1',
    'remoteapplicationmode:i:0',
    `full address:s:${host}:${port}`,
  ]
  if (username.length > 0) lines.push(`username:s:${username}`)
  return `${lines.join('\r\n')}\r\n`
}

/** Launch a native client for one server record. */
export async function launchDesktop(server, options = {}) {
  const protocol = server.protocol
  if (protocol !== 'rdp' && protocol !== 'vnc') {
    throw new TermError(ERR.invalidInput, '只有 RDP 或 VNC 连接可以打开远程桌面')
  }
  const table = CLIENTS[process.platform]
  if (table === undefined) throw new TermError(ERR.desktop, `这个平台还没有远程桌面客户端支持：${process.platform}`)
  const candidates = table[protocol]

  const password = options.sendPassword === true && typeof options.password === 'string' ? options.password : ''
  const tried = []
  for (const candidate of candidates) {
    if (!(await exists(candidate.command))) {
      tried.push(candidate.command)
      continue
    }
    let rdpFile
    if (candidate.kind === 'mstsc') {
      rdpFile = join(tmpdir(), `dsh-term-${server.host.replace(/[^\w.-]/g, '_')}-${server.port}.rdp`)
      await writeFile(rdpFile, rdpFileBody(server), 'utf8')
    }
    const argv = buildArgv(candidate.kind, {
      protocol,
      host: server.host,
      port: server.port,
      username: server.username ?? '',
      password,
      sendPassword: options.sendPassword === true,
      command: candidate.command,
      rdpFile,
    })
    try {
      const child = spawn(argv.command, argv.args, {
        detached: true,
        // The client owns a window, not this process's console: nothing is read
        // back, and inheriting stdio would keep dsh's pipes open for its lifetime.
        stdio: candidate.kind === 'xfreerdp' && argv.args.includes('/from-stdin') ? ['pipe', 'ignore', 'ignore'] : 'ignore',
        windowsHide: false,
      })
      if (child.stdin !== null && child.stdin !== undefined) {
        // freerdp's /from-stdin reads one line; an empty line makes it prompt in
        // its own window instead of failing.
        child.stdin.end(options.sendPassword === true ? `${password}\n` : '\n')
      }
      child.unref()
      return {
        launched: true,
        client: candidate.kind,
        command: argv.command,
        protocol,
        host: server.host,
        port: server.port,
        passwordSent: options.sendPassword === true && password.length > 0,
      }
    } catch (error) {
      tried.push(`${candidate.command} (${error.code ?? 'ERR'})`)
    }
  }
  throw new TermError(ERR.desktop, `没有找到可用的${protocol.toUpperCase()}客户端，已尝试：${tried.join('、')}`)
}

/** Which clients this machine appears to have, for the panel's summary card. */
export async function probeClients() {
  const table = CLIENTS[process.platform]
  if (table === undefined) return { platform: process.platform, rdp: [], vnc: [] }
  const probe = async (rows) => {
    const found = []
    for (const row of rows) {
      if (await exists(row.command)) found.push(row.kind)
    }
    return [...new Set(found)]
  }
  return {
    platform: process.platform,
    rdp: await probe(table.rdp),
    vnc: await probe(table.vnc),
  }
}
