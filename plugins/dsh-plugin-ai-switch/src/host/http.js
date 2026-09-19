/**
 * HTTP plumbing for the panel's own API: the envelope, the body reader, the static server.
 *
 * The envelope is the reference's, not this repo's usual `{ok, value}`: the panel is that
 * app's React front end unmodified, and its `WebTransport` expects the bare return value on
 * success and `{code, message, details, recoverable, operation_id}` with a non-2xx status on
 * failure. Wrapping it would mean editing every call site.
 *
 * @module dsh-plugin-ai-switch/host/http
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { ApiError } from '../shared/protocol.js'

/** Bodies bigger than this are a mistake, not a request. Export/import allows 8 MiB. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024

/** Send JSON with no caching. */
export function json(res, payload, status = 200) {
  const body = JSON.stringify(payload === undefined ? null : payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** The failure shape `normalizeApiError` in the panel reads. */
export function fail(res, error) {
  if (error instanceof ApiError) {
    json(res, error.toJSON(), error.status)
    return
  }
  console.error('[dsh-plugin-ai-switch] route error:', error?.stack ?? error)
  json(
    res,
    {
      code: 'host.internal',
      message: String(error?.message ?? error),
      details: null,
      recoverable: false,
      operation_id: null,
    },
    500,
  )
}

/** Read and parse a JSON body. `{}` for an empty body; throws on garbage. */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new ApiError('host.body_too_large', 'The request body is too large', { status: 413 })
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
    throw new ApiError('host.invalid_json', 'The request body is not valid JSON', {
      details: String(error?.message ?? error),
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('host.invalid_json', 'The request body must be a JSON object')
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
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve one file out of `root`.
 *
 * The path is normalized and then checked to still be inside `root`, with the separator
 * included in the prefix — a bare `startsWith` would also accept a sibling directory whose
 * name merely begins with the root's (`…/webview-secrets`).
 */
export async function serveStatic(res, root, requestPath, options = {}) {
  const rootDir = resolve(root)
  let decoded
  try {
    decoded = decodeURIComponent(String(requestPath ?? ''))
  } catch {
    // A malformed escape is not a path.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }

  // Reject `..` on the DECODED path, before normalize gets a chance to collapse it.
  //
  // Order matters here and it is the trap: `/..%2f..%2fsecret` decodes to `/../../secret`,
  // which `path.normalize` flattens to `/secret` — back inside the root, so a prefix check
  // alone says "fine" and the file simply appears to be missing. Nothing escapes either way,
  // but "missing" then becomes the SPA fallback and a 200, which reads as though the path
  // were legitimate. Refusing the segment outright is both honest and easier to verify.
  const segments = decoded.split(/[/\\]+/)
  if (segments.includes('..')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, '')
  const target = resolve(join(rootDir, relative))
  // Separator included, so a sibling directory whose name merely begins with the root's
  // (`…/webview-secrets`) cannot pass a bare startsWith.
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
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

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // The panel bundle is content-hashed by Vite except for index.html, which must not be
    // cached or a plugin upgrade keeps serving the old asset names.
    'cache-control': extname(target).toLowerCase() === '.html' ? 'no-store' : 'public, max-age=86400',
  })
  createReadStream(target).pipe(res)
}
