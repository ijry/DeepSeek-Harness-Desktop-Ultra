/**
 * HTTP plumbing: the envelope, the body reader, and the static file server for the
 * panel's own bundle.
 *
 * The envelope is `{ ok: true, value }` / `{ ok: false, error: { code, message } }`,
 * which is what `webview/src/shims/tauri-core.ts` unwraps. Keeping it that dumb is
 * what lets the Vue sources stay byte-identical to the reference: they still call
 * `invoke('get_tables', …)` and still get a value or a thrown Error.
 *
 * @module dsh-plugin-otools-dbm/host/http
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { DbmError, ERR, statusOf } from '../shared/protocol.js'

/** Bodies bigger than this are a mistake, not a request. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Send JSON with no caching. */
export function json(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Success envelope. */
export function ok(res, value, status = 200) {
  json(res, { ok: true, value: value === undefined ? null : value }, status)
}

/** Failure envelope, status derived from the code. */
export function fail(res, error) {
  const code = error instanceof DbmError ? error.code : ERR.internal
  const message = messageOf(error)
  if (!(error instanceof DbmError)) {
    console.error('[dsh-plugin-otools-dbm] route error:', message)
  }
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Read and parse a JSON body. `{}` for an empty body; throws on garbage. */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new DbmError(ERR.tooLarge, '请求体过大')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new DbmError(ERR.invalidInput, `请求体不是合法 JSON: ${String(error?.message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DbmError(ERR.invalidInput, '请求体必须是 JSON 对象')
  }
  return parsed
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve one file out of `root`.
 *
 * The path is normalized and then checked to still be inside `root`, with the
 * separator included in the prefix — a bare `startsWith` would also accept a
 * sibling directory whose name merely begins with the root's (`…/webview-secrets`).
 */
export async function serveStatic(res, root, requestPath, options = {}) {
  const rootDir = resolve(root)
  const relative = normalize(decodeURIComponent(requestPath)).replace(/^([/\\])+/, '')
  const target = resolve(join(rootDir, relative))
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    res.writeHead(403)
    res.end()
    return
  }

  let info
  try {
    info = await stat(target)
  } catch {
    if (options.fallback !== undefined) {
      await serveStatic(res, root, options.fallback)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (info.isDirectory()) {
    await serveStatic(res, root, join(relative, 'index.html'), options)
    return
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  // The bundle's file names carry a content hash, so they can be cached hard; the
  // entry HTML must not be, or a plugin upgrade shows a stale app.
  const cache = /\.html$/i.test(target) ? 'no-cache' : 'public, max-age=604800, immutable'
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': cache,
  })
  createReadStream(target).pipe(res)
}

/** Message of anything throwable, never `[object Object]`. */
export function messageOf(error) {
  if (error === null || error === undefined) {
    return '未知错误'
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}
