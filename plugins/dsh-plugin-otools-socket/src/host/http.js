export const ROUTE_PREFIX = '/dsh-plugin-otools-socket'

export function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(value))
}

export async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'invalid_input' })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('invalid JSON body'), { code: 'invalid_input' }) }
}

export function bearer(req) {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}

export function corsHeaders(req, allowedOrigins = []) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    return { 'access-control-allow-origin': origin, vary: 'Origin' }
  }
  return {}
}

function uploadError(message) {
  return Object.assign(new Error(message), { code: 'invalid_input' })
}

async function readBounded(req, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw uploadError('upload exceeds maxBytes')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, bytes)
}

export async function parseUploadBody(req, contentType, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw uploadError('invalid maxBytes')
  if (!String(contentType).toLowerCase().startsWith('multipart/form-data')) {
    return { contentType: String(contentType || 'application/octet-stream'), body: req }
  }
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary || boundary.length > 200) throw uploadError('multipart boundary is invalid')

  // The parser buffers at most the declared file limit plus a bounded multipart
  // envelope. It never trusts a filename or allows extra form fields.
  const raw = await readBounded(req, maxBytes + 16 * 1024)
  const marker = Buffer.from(`--${boundary}`)
  const separator = Buffer.from('\r\n\r\n')
  const closing = Buffer.from(`\r\n--${boundary}--`)
  if (!raw.subarray(0, marker.length).equals(marker)) throw uploadError('multipart start is invalid')
  const headerEnd = raw.indexOf(separator, marker.length)
  if (headerEnd < 0 || headerEnd - marker.length > 16 * 1024) throw uploadError('multipart headers are invalid')
  const headers = raw.subarray(marker.length + 2, headerEnd).toString('utf8')
  const disposition = headers.match(/^Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?\s*$/im)
  if (!disposition || disposition[1] !== 'file' || disposition[2] === undefined) {
    throw uploadError('multipart requires exactly one file part')
  }
  const fileStart = headerEnd + separator.length
  const fileEnd = raw.indexOf(closing, fileStart)
  if (fileEnd < 0) throw uploadError('multipart closing boundary is missing')
  const after = fileEnd + closing.length
  if (after > raw.length || !raw.subarray(after).equals(Buffer.from('\r\n'))) {
    throw uploadError('multipart contains extra parts')
  }
  const file = raw.subarray(fileStart, fileEnd)
  if (file.length > maxBytes) throw uploadError('upload exceeds maxBytes')
  const partType = headers.match(/^Content-Type:\s*([^\r\n]+)$/im)?.[1]?.trim()
  return {
    contentType: partType || 'application/octet-stream',
    body: (async function* () { yield file })(),
  }
}

export function statusFor(code) {
  switch (code) {
    case 'invalid_input': return 400
    case 'unauthorized': return 401
    case 'forbidden': return 403
    case 'not_found': return 404
    case 'ticket_unavailable':
    case 'conflict': return 409
    case 'rate_limited': return 429
    case 'source_unavailable': return 503
    default: return 500
  }
}
