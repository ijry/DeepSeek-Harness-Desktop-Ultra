/**
 * The error envelope and the input validators, shared by the host half and the tests.
 *
 * The envelope is the reference app's, field for field: the panel is its React front
 * end unmodified, and `src/lib/api/errors.ts` reads `{code, message, details,
 * recoverable, operation_id}` off any non-2xx body. `code` is what the UI switches on
 * (`validation.required`, `capability.unavailable`, `config.concurrent_modification`,
 * …), `details` is what it prints next to the message, so both have to keep meaning
 * the same thing they mean in Rust.
 *
 * @module dsh-plugin-ai-switch/shared/protocol
 */

/** Thrown by every command; serialized by host/http.js. */
export class ApiError extends Error {
  /**
   * @param code - stable machine code, e.g. `validation.required`.
   * @param message - one human sentence.
   * @param options.details - the offending field/value, printed by the UI.
   * @param options.recoverable - whether retrying could work.
   * @param options.operationId - group id for multi-target writes.
   * @param options.status - HTTP status; 400 for everything the UI shows inline.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = options.details === undefined ? null : options.details
    this.recoverable = options.recoverable === undefined ? true : options.recoverable === true
    this.operationId = options.operationId ?? null
    this.status = options.status ?? 400
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details === null ? null : String(this.details),
      recoverable: this.recoverable,
      operation_id: this.operationId,
    }
  }
}

/** `validation.*` shorthand — recoverable, because the user can fix the input. */
export function validation(code, message, details) {
  return new ApiError(code, message, { details, recoverable: true })
}

/** A required, non-blank string. `details` is the field name, which the UI shows. */
export function requireText(value, field, max = 4096) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    throw validation('validation.required', `${field} is required`, field)
  }
  if (text.length > max) {
    throw validation('validation.too_long', `${field} is too long`, field)
  }
  return text
}

/** An optional string; blank and absent both become `''`. */
export function optionalText(value, max = 65536) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/** One of a fixed set, or a named validation error. */
export function requireOneOf(value, allowed, code, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!allowed.includes(text)) {
    throw validation(code, `${field} must be one of: ${allowed.join(', ')}`, text || field)
  }
  return text
}

/** An integer clamped to [min, max]; non-numbers fall back to `fallback`. */
export function boundedInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** An integer inside [min, max], or a named validation error. */
export function requireInt(value, min, max, code, field) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number) || Math.trunc(number) !== number || number < min || number > max) {
    throw validation(code, `${field} must be an integer between ${min} and ${max}`, String(value ?? ''))
  }
  return number
}

/** An array of non-blank strings, deduplicated, order preserved. */
export function requireIdList(value, field, max = 2000) {
  const list = Array.isArray(value) ? value : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text.length === 0 || seen.has(text)) {
      continue
    }
    seen.add(text)
    out.push(text)
    if (out.length >= max) {
      break
    }
  }
  if (out.length === 0) {
    throw validation('validation.required', `${field} must contain at least one id`, field)
  }
  return out
}

/** Parse a JSON object out of a string field; `fallback` when blank. */
export function parseJsonObject(value, field, fallback = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    return fallback
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw validation('validation.json', `${field} is not valid JSON`, String(error?.message ?? error))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validation('validation.json', `${field} must be a JSON object`, field)
  }
  return parsed
}

/** RFC 3339 in UTC with seconds — the timestamp format every stored row uses. */
export function nowIso() {
  return new Date().toISOString()
}

