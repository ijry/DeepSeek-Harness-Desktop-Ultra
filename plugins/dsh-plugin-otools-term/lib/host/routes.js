/**
 * /dsh-plugin-otools-term routes on the shared DSH webserver: a JSON API for the
 * browser panel, the SSE event stream, the two byte-streaming routes (upload and
 * download) and the vendored xterm assets.
 *
 * Reads live here; writes live in `actions.js`. The split is the same one the
 * sibling otools-git plugin uses, and for the same reason: it keeps the file that
 * can change something on a remote machine small enough to read in one sitting.
 *
 * Containment rules, all enforced before anything reaches the network or the disk:
 *
 *   - a server is always named by id and looked up in the ledger, so the browser
 *     cannot hand over a host/port/credential triple of its own;
 *   - a local path is always `{workspaceId, relative}` resolved inside a registered
 *     DSH workspace (host/workspaces.js);
 *   - a remote path is normalised, and the two places one reaches a shell (the
 *     `cd` for "open terminal here", the `find` for search) quote it.
 *
 * @module dsh-plugin-otools-term/host/routes
 */
import { PassThrough } from 'node:stream'
import {
  baseRemote,
  ERR,
  MAX_UPLOAD_BYTES,
  normalizeRemotePath,
  TermError,
} from '../shared/protocol.js'
import { registerActionRoutes } from './actions.js'
import { aiAvailability } from './ai.js'
import {
  contentDisposition,
  enumParam,
  intParam,
  ok,
  optionalParam,
  optionalPathParam,
  readBody,
  requireIdParam,
  requireParam,
  requirePathParam,
  sendError,
  sendFail,
} from './http.js'
import { SEARCH_LIMIT } from './sftp.js'
import { registerTerminalSocket, SOCKET_PATH } from './socket.js'
import { downloadToStream, downloadTreeAsTar, uploadFromStream } from './transfer.js'
import { serveVendor } from './vendor.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-otools-term'

/** WebSocket path for terminal bytes (re-exported for the browser half's URL). */
export { SOCKET_PATH }

/** SSE stream path (an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-otools-term/events'

/**
 * Register the panel routes. Returns the disposer.
 *
 * @param options - `{ engine }`
 */
export function registerTermRoutes(ctx, options) {
  const { engine } = options

  /** GET dispatch. Grouped by area, in the order the panel calls them. */
  const handleGet = async (req, res, pathname, params) => {
    const route = pathname.slice(ROUTE_PREFIX.length)

    // ------------------------------------------------------------- vendored
    if (route.startsWith('/vendor/')) {
      await serveVendor(req, res, route.slice('/vendor/'.length))
      return true
    }

    // ---------------------------------------------------------------- state
    if (route === '/state' || route === '' || route === '/') {
      ok(res, await engine.state())
      return true
    }
    if (route === '/sessions') {
      ok(res, { sessions: engine.sessions.list() })
      return true
    }
    if (route === '/session/replay') {
      ok(res, engine.sessions.replay(requireIdParam(params, 'sessionId')))
      return true
    }
    if (route === '/tasks') {
      ok(res, { tasks: engine.transfers.list() })
      return true
    }
    if (route === '/tunnels') {
      ok(res, engine.tunnels.state(optionalParam(params, 'serverId')))
      return true
    }
    if (route === '/known-hosts') {
      await engine.knownHosts.load()
      ok(res, { knownHosts: engine.knownHosts.list() })
      return true
    }
    if (route === '/ai/availability') {
      ok(res, aiAvailability(engine.ai))
      return true
    }
    if (route === '/ai/jobs') {
      ok(res, { jobs: engine.jobs.list() })
      return true
    }
    if (route === '/workspaces') {
      ok(res, { workspaces: engine.localPaths.list() })
      return true
    }

    // ----------------------------------------------------------------- sftp
    if (route === '/sftp/list') {
      const sftp = await engine.sftpOf(requireIdParam(params, 'serverId'))
      ok(res, await sftp.list(optionalPathParam(params, 'path')))
      return true
    }
    if (route === '/sftp/stat') {
      const sftp = await engine.sftpOf(requireIdParam(params, 'serverId'))
      ok(res, await sftp.stat(requirePathParam(params)))
      return true
    }
    if (route === '/sftp/home') {
      const sftp = await engine.sftpOf(requireIdParam(params, 'serverId'))
      ok(res, { path: await sftp.resolve('.') })
      return true
    }
    if (route === '/sftp/search') {
      const sftp = await engine.sftpOf(requireIdParam(params, 'serverId'))
      const limit = intParam(params, 'limit', { min: 1, max: SEARCH_LIMIT, fallback: SEARCH_LIMIT })
      ok(res, await sftp.search(optionalPathParam(params, 'path') ?? '/', requireParam(params, 'keyword'), limit))
      return true
    }
    if (route === '/sftp/read') {
      const sftp = await engine.sftpOf(requireIdParam(params, 'serverId'))
      ok(res, await sftp.readFile(requirePathParam(params)))
      return true
    }
    if (route === '/sftp/download') {
      await handleDownload(req, res, params)
      return true
    }

    return false
  }

  /**
   * Stream one remote file — or a whole directory as a tar — into the response.
   *
   * This is the browser's own download, so the bytes go straight out with a
   * `Content-Disposition`; the task record exists only so the transfer drawer can
   * show that something is happening.
   */
  const handleDownload = async (req, res, params) => {
    const serverId = requireIdParam(params, 'serverId')
    const path = requirePathParam(params)
    const sftp = await engine.sftpOf(serverId)
    const info = await sftp.stat(path)
    const wantsTar = info.isDirectory || enumParam(params, 'kind', ['auto', 'file', 'tar'], 'auto') === 'tar'
    const name = baseRemote(path) || 'download'
    const filename = wantsTar ? `${name}.tar` : name

    const task = engine.transfers.create({
      kind: 'download',
      serverId,
      source: path,
      target: `浏览器下载 · ${filename}`,
      bytesTotal: wantsTar ? 0 : (info.size ?? 0),
    })
    // The response is the sink, so failures cannot be reported as JSON once the
    // headers are out — the task record carries the error instead.
    res.writeHead(200, {
      'content-type': wantsTar ? 'application/x-tar' : 'application/octet-stream',
      'content-disposition': contentDisposition(filename),
      'cache-control': 'no-store',
      ...(wantsTar || info.size === null ? {} : { 'content-length': String(info.size) }),
    })
    const sink = new PassThrough()
    sink.pipe(res)
    req.on('close', () => {
      if (task.status === 'transferring' || task.status === 'pending') task.controller.abort()
    })
    try {
      if (wantsTar) await downloadTreeAsTar({ sftp, registry: engine.transfers, task, remotePath: path, sink })
      else await downloadToStream({ sftp, registry: engine.transfers, task, remotePath: path, sink })
      sink.end()
    } catch (error) {
      console.warn('[dsh-plugin-otools-term] download failed:', error?.message ?? error)
      // Destroying the response is what tells the browser the file is incomplete;
      // ending it cleanly would hand the user a truncated file that looks fine.
      sink.destroy()
      res.destroy()
    }
  }

  /**
   * Accept one uploaded file body and stream it into a remote path.
   *
   * The body is raw bytes, not JSON and not multipart: the page sends one file per
   * request with the metadata in the query string, so the host never has to buffer
   * a whole file or parse a multipart envelope to find where the bytes start.
   */
  const handleUpload = async (req, res, params) => {
    const serverId = requireIdParam(params, 'serverId')
    const dir = requirePathParam(params, 'dir')
    const name = requireParam(params, 'name')
    // The name comes from a file input, so it may carry a relative path when a
    // whole folder was dropped. Each segment is checked; `..` cannot appear.
    const segments = name.replace(/\\/g, '/').split('/').filter((part) => part.length > 0 && part !== '.')
    if (segments.length === 0) throw new TermError(ERR.invalidInput, 'name is required')
    if (segments.some((part) => part === '..')) throw new TermError(ERR.invalidInput, 'name must not contain ..')
    if (segments.some((part) => part.length > 255)) throw new TermError(ERR.invalidInput, 'name segment is too long')
    const remotePath = normalizeRemotePath(`${dir === '/' ? '' : dir}/${segments.join('/')}`)

    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new TermError(ERR.tooLarge, '单个文件超过上传上限')
    }
    const sftp = await engine.sftpOf(serverId)
    const task = engine.transfers.create({
      kind: 'upload',
      serverId,
      source: `浏览器上传 · ${segments[segments.length - 1]}`,
      target: remotePath,
      bytesTotal: Number.isFinite(declared) ? declared : 0,
    })
    ok(res, await uploadFromStream({ sftp, registry: engine.transfers, task, remotePath, source: req }))
  }

  const actions = registerActionRoutes({ engine })

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        res.writeHead(404)
        res.end()
        return
      }
      const route = url.pathname.slice(ROUTE_PREFIX.length)
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!(await handleGet(req, res, url.pathname, url.searchParams))) {
          res.writeHead(404)
          res.end()
        }
        return
      }
      if (req.method === 'POST') {
        // The upload route reads the request as a stream, so it must be dispatched
        // BEFORE anything buffers the body.
        if (route === '/sftp/upload') {
          await handleUpload(req, res, url.searchParams)
          return
        }
        const body = await readBody(req)
        if (body === null) {
          sendFail(res, ERR.invalidInput, 'request body must be a JSON object')
          return
        }
        if (!(await actions.handlePost(req, res, route, body))) {
          res.writeHead(404)
          res.end()
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendError(res, error)
    }
  }

  /** The one SSE stream a panel opens. */
  const sse = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const clientId = url.searchParams.get('clientId')
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 120) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('clientId is required')
      return
    }
    let hello
    try {
      hello = await engine.state()
    } catch (error) {
      hello = { error: error?.message ?? String(error) }
    }
    engine.hub.add(clientId, res, hello)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
  ]
  // The terminal socket is an optimisation, not a requirement: a DSH build without an
  // upgrade hook keeps the POST + SSE path, which is why this is the only place that
  // has to know whether the hook exists.
  const disposeSocket = registerTerminalSocket(ctx, { engine })
  if (disposeSocket !== undefined) disposers.push(disposeSocket)
  return () => {
    for (const dispose of disposers) dispose()
  }
}
