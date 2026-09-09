export const BUS_VERSION = 2
export const UI_VERSION = 1
export const CONTROL_FRAME_MAX_BYTES = 262_144
export const CATALOG_MAX_BYTES = 524_288
export const CATALOG_CHUNK_MAX_BYTES = 98_304
export const CATALOG_ASSEMBLY_TIMEOUT_MS = 30_000
export const CLIENT_BACKLOG_MAX_BYTES = 1_048_576
export const REQUEST_TIMEOUT_MS = 30_000

export const ERROR_CODES = Object.freeze([
  'bad_frame',
  'bad_version',
  'frame_too_large',
  'source_unavailable',
  'not_found',
  'forbidden',
  'unauthorized',
  'rate_limited',
  'timeout',
  'cancelled',
  'circuit_open',
  'ticket_unavailable',
  'invalid_input',
  'conflict',
  'internal',
])

const ERROR_CODE_SET = new Set(ERROR_CODES)
const KINDS = new Set([
  'hello', 'catalog', 'subscribe', 'unsubscribe', 'event',
  'request', 'response', 'cancel', 'overflow', 'error',
])
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BASE64URL = /^[A-Za-z0-9_-]*$/
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function string(value, minimum = 1, maximum = 128) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function source(value) {
  return typeof value === 'string' && SOURCE_ID.test(value)
}

function requestId(value) {
  return string(value, 1, 128)
}

function eventName(value, allowReserved) {
  return string(value, 1, 128) && (allowReserved || !value.startsWith('$'))
}

function errorShape(value) {
  return isObject(value)
    && ERROR_CODE_SET.has(value.code)
    && typeof value.message === 'string'
    && value.message.length <= 1024
}

function validateHello(frame) {
  if (!string(frame.serverInstanceId, 36, 36) || !UUID.test(frame.serverInstanceId)) {
    fail('bad_frame', 'hello.serverInstanceId must be a UUID')
  }
  if (!integer(frame.catalogRevision)) fail('bad_frame', 'hello.catalogRevision is invalid')
  const limits = frame.limits
  if (!isObject(limits)
      || limits.controlFrameBytes !== CONTROL_FRAME_MAX_BYTES
      || limits.catalogBytes !== CATALOG_MAX_BYTES
      || limits.clientBacklogBytes !== CLIENT_BACKLOG_MAX_BYTES
      || limits.requestTimeoutMs !== REQUEST_TIMEOUT_MS) {
    fail('bad_frame', 'hello.limits is invalid')
  }
}

function validateCatalogFrame(frame) {
  if (!integer(frame.revision)) fail('bad_frame', 'catalog.revision is invalid')
  if (!Number.isInteger(frame.count) || frame.count < 1 || frame.count > 6) {
    fail('bad_frame', 'catalog.count is invalid')
  }
  if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= frame.count) {
    fail('bad_frame', 'catalog.index is invalid')
  }
  if (frame.encoding !== 'base64url') fail('bad_frame', 'catalog.encoding is invalid')
  if (typeof frame.data !== 'string' || !BASE64URL.test(frame.data)) {
    fail('bad_frame', 'catalog.data is invalid')
  }
}

function validateSourceFrame(frame) {
  if (!source(frame.source)) fail('bad_frame', 'source is invalid')
}

function validateRequest(frame) {
  validateSourceFrame(frame)
  if (!requestId(frame.requestId)) fail('bad_frame', 'requestId is invalid')
  if (!string(frame.name, 1, 128) || frame.name.startsWith('$')) {
    fail('bad_frame', 'request.name is invalid')
  }
  if (!hasOwn(frame, 'data')) fail('bad_frame', 'request.data is required')
}

function validateResponse(frame) {
  validateSourceFrame(frame)
  if (!requestId(frame.requestId)) fail('bad_frame', 'requestId is invalid')
  if (typeof frame.ok !== 'boolean') fail('bad_frame', 'response.ok is invalid')
  if (frame.ok) {
    if (!hasOwn(frame, 'data') || hasOwn(frame, 'error')) {
      fail('bad_frame', 'success response is invalid')
    }
  } else if (!errorShape(frame.error) || hasOwn(frame, 'data')) {
    fail('bad_frame', 'error response is invalid')
  }
}

function validateEvent(frame) {
  validateSourceFrame(frame)
  if (!eventName(frame.name, frame.name === '$snapshot')) {
    fail('bad_frame', 'event.name is invalid')
  }
  if (!hasOwn(frame, 'data')) fail('bad_frame', 'event.data is required')
}

export function validateControlFrame(frame) {
  if (!isObject(frame)) fail('bad_frame', 'frame must be an object')
  if (frame.v !== BUS_VERSION) fail('bad_version', 'unsupported bus version')
  if (!KINDS.has(frame.kind)) fail('bad_frame', 'unknown frame kind')

  switch (frame.kind) {
    case 'hello':
      validateHello(frame)
      break
    case 'catalog':
      validateCatalogFrame(frame)
      break
    case 'subscribe':
    case 'unsubscribe':
      validateSourceFrame(frame)
      break
    case 'event':
      validateEvent(frame)
      break
    case 'request':
      validateRequest(frame)
      break
    case 'response':
      validateResponse(frame)
      break
    case 'cancel':
      validateSourceFrame(frame)
      if (!requestId(frame.requestId)) fail('bad_frame', 'requestId is invalid')
      break
    case 'overflow':
      validateSourceFrame(frame)
      if (!string(frame.reason, 1, 128)) fail('bad_frame', 'overflow.reason is invalid')
      break
    case 'error':
      if (!errorShape(frame.error)) fail('bad_frame', 'error frame is invalid')
      break
    default:
      fail('bad_frame', 'unknown frame kind')
  }
  return frame
}

function toText(raw) {
  if (typeof raw === 'string') return raw
  if (raw instanceof Uint8Array) {
    try {
      return textDecoder.decode(raw)
    } catch {
      fail('bad_frame', 'frame is not valid UTF-8')
    }
  }
  fail('bad_frame', 'frame must be UTF-8 text')
}

export function decodeControlFrame(raw) {
  const text = toText(raw)
  if (Buffer.byteLength(text, 'utf8') > CONTROL_FRAME_MAX_BYTES) {
    fail('frame_too_large', 'control frame exceeds byte limit')
  }
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    fail('bad_frame', 'control frame is not valid JSON')
  }
  return validateControlFrame(frame)
}

export function encodeControlFrame(frame) {
  validateControlFrame(frame)
  let text
  try {
    text = JSON.stringify(frame)
  } catch {
    fail('bad_frame', 'control frame is not serializable')
  }
  if (text === undefined) fail('bad_frame', 'control frame is not serializable')
  if (Buffer.byteLength(text, 'utf8') > CONTROL_FRAME_MAX_BYTES) {
    fail('frame_too_large', 'control frame exceeds byte limit')
  }
  return text
}

function validateCommand(command) {
  if (!isObject(command)
      || !string(command.name, 1, 128)
      || !['read', 'write'].includes(command.effect)
      || !['none', 'confirm', 'danger'].includes(command.confirmation)
      || !isObject(command.input)
      || command.input.type !== 'object'
      || !isObject(command.input.properties)
      || command.input.additionalProperties !== false) {
    fail('invalid_input', 'catalog command is invalid')
  }
  if (command.effect === 'write' && !['none', 'confirm', 'danger'].includes(command.confirmation)) {
    fail('invalid_input', 'write command confirmation is required')
  }
}

function validateSourceDescriptor(row) {
  if (!isObject(row) || !source(row.id) || !integer(row.protocolVersion, 1)) {
    fail('invalid_input', 'source descriptor is invalid')
  }
  if (!isObject(row.catalog) || !string(row.catalog.title, 1, 128)) {
    fail('invalid_input', 'source catalog is invalid')
  }
  if (!Array.isArray(row.catalog.commands) || row.catalog.commands.length > 512) {
    fail('invalid_input', 'source commands are invalid')
  }
  for (const command of row.catalog.commands) validateCommand(command)
  if (row.catalog.uiVersion !== undefined && row.catalog.uiVersion !== UI_VERSION) {
    fail('invalid_input', 'unsupported UI version')
  }
}

export function validateCatalog(catalog) {
  if (!isObject(catalog) || !integer(catalog.revision) || !Array.isArray(catalog.sources)) {
    fail('invalid_input', 'catalog is invalid')
  }
  let text
  try {
    text = JSON.stringify(catalog)
  } catch {
    fail('invalid_input', 'catalog is not serializable')
  }
  if (Buffer.byteLength(text, 'utf8') > CATALOG_MAX_BYTES) {
    fail('frame_too_large', 'catalog exceeds byte limit')
  }
  const seen = new Set()
  for (const row of catalog.sources) {
    validateSourceDescriptor(row)
    if (seen.has(row.id)) fail('invalid_input', 'duplicate source ID')
    seen.add(row.id)
  }
  return catalog
}

export function encodeCatalogFrames(catalog) {
  validateCatalog(catalog)
  const payload = Buffer.from(JSON.stringify(catalog), 'utf8')
  const count = Math.ceil(payload.length / CATALOG_CHUNK_MAX_BYTES) || 1
  if (count > 6) fail('frame_too_large', 'catalog needs too many chunks')
  const frames = []
  for (let index = 0; index < count; index += 1) {
    const start = index * CATALOG_CHUNK_MAX_BYTES
    const data = payload.subarray(start, start + CATALOG_CHUNK_MAX_BYTES).toString('base64url')
    const frame = {
      v: BUS_VERSION,
      kind: 'catalog',
      revision: catalog.revision,
      index,
      count,
      encoding: 'base64url',
      data,
    }
    encodeControlFrame(frame)
    frames.push(frame)
  }
  return frames
}

export function createCatalogAssembler(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let state = null

  const reset = () => {
    state = null
  }

  const accept = (frame) => {
    validateControlFrame(frame)
    if (frame.kind !== 'catalog') fail('bad_frame', 'expected a catalog frame')

    if (frame.index === 0 && state === null) {
      state = {
        revision: frame.revision,
        count: frame.count,
        next: 0,
        startedAt: now(),
        bytes: 0,
        chunks: [],
      }
    } else if (frame.index === 0 && state !== null && frame.revision !== state.revision) {
      state = {
        revision: frame.revision,
        count: frame.count,
        next: 0,
        startedAt: now(),
        bytes: 0,
        chunks: [],
      }
    }
    if (state === null
        || frame.revision !== state.revision
        || frame.count !== state.count
        || frame.index !== state.next
        || now() - state.startedAt > CATALOG_ASSEMBLY_TIMEOUT_MS) {
      fail('bad_frame', 'catalog chunk order is invalid')
    }

    const chunk = Buffer.from(frame.data, 'base64url')
    state.bytes += chunk.length
    if (state.bytes > CATALOG_MAX_BYTES) {
      reset()
      fail('frame_too_large', 'catalog exceeds byte limit')
    }
    state.chunks.push(chunk)
    state.next += 1
    if (state.next !== state.count) return null

    let catalog
    try {
      catalog = JSON.parse(Buffer.concat(state.chunks, state.bytes).toString('utf8'))
    } catch {
      reset()
      fail('bad_frame', 'assembled catalog is invalid JSON')
    }
    reset()
    return validateCatalog(catalog)
  }

  return { accept, reset }
}
