/**
 * HTTP envelope helpers shared by the read routes, the action routes and the two
 * streaming routes.
 *
 * Kept in its own module so `actions.js` does not have to import from `routes.js`
 * (which imports it back) — a cycle ESM would tolerate but nobody should have to
 * reason about.
 *
 * @module dsh-plugin-otools-term/host/http
 */
import {
  ERR,
  normalizeEnum,
  normalizeId,
  normalizeInt,
  normalizeRemotePath,
  statusOf,
  TermError,
} from '../shared/protocol.js'

/** Max accepted JSON body bytes (an unbounded local HTTP buffer is an OOM vector). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Envelope writer. */
export function json(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** `{ ok: true }` writer. */
export function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/** `{ ok: false }` writer. */
export function sendFail(res, code, message, extra) {
  json(res, { ok: false, error: { code, message, ...(extra ?? {}) } }, statusOf(code))
}

/**
 * Map any thrown value onto the failure envelope.
 *
 * A `host_key` failure carries its fingerprint fields along, because the panel has
 * to show them for the user to compare — that is the whole point of the check.
 */
export function envelopeOfError(error) {
  if (error instanceof TermError) {
    const envelope = { code: error.code, message: error.message, status: statusOf(error.code) }
    for (const key of ['fingerprint', 'keyType', 'mismatch', 'pinnedFingerprint', 'host', 'port', 'serverId']) {
      if (error[key] !== undefined) envelope[key] = error[key]
    }
    return envelope
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-otools-term] route error:', message)
  return { code: ERR.internal, message, status: 500 }
}

/** Write one failure envelope for a thrown value. */
export function sendError(res, error) {
  const failure = envelopeOfError(error)
  const { status, ...rest } = failure
  json(res, { ok: false, error: rest }, status)
}

/** Read one JSON body (`{}` when empty; null on parse failure). */
export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new TermError(ERR.tooLarge, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A required query parameter. */
export function requireParam(params, name) {
  const value = params.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new TermError(ERR.invalidInput, `${name} is required`)
  }
  return value
}

/** An optional query parameter. */
export function optionalParam(params, name) {
  const value = params.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A required id-shaped query parameter. */
export function requireIdParam(params, name) {
  return normalizeId(requireParam(params, name), name)
}

/** A required remote path from the query string. */
export function requirePathParam(params, name = 'path') {
  return normalizeRemotePath(requireParam(params, name), name)
}

/** An optional remote path from the query string. */
export function optionalPathParam(params, name = 'path') {
  const value = optionalParam(params, name)
  return value === undefined ? undefined : normalizeRemotePath(value, name)
}

/** A bounded integer from the query string. */
export function intParam(params, name, bounds) {
  return normalizeInt(params.get(name), name, bounds)
}

/** One of a closed set, from the query string. */
export function enumParam(params, name, allowed, fallback) {
  const value = params.get(name)
  if (value === null || value === '') {
    if (fallback === undefined) throw new TermError(ERR.invalidInput, `${name} is required`)
    return fallback
  }
  return normalizeEnum(value, allowed, name)
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * The quoted form is ASCII-only with quotes and control characters removed; the
 * real name rides in `filename*` as RFC 5987 percent-encoded UTF-8, which is what
 * lets a Chinese filename download with its own name.
 */
export function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(String(name))
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
