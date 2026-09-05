/**
 * Wire protocol shared by both halves of the plugin: the stable error codes, the
 * error class that carries them, and the HTTP status each one maps to.
 *
 * The codes are NOT invented here. The panel's own error humanizer
 * (`webview/src/utils/dbm.ts`, copied verbatim from the reference) already knows a
 * fixed set of `DBM_*` codes and turns them into Chinese sentences; a host that
 * emits `[DBM_MYSQL_CONN_AUTH] Access denied…` therefore gets "MySQL/MariaDB 认证
 * 失败，请检查用户名或密码。" in the UI for free. That is why the message format
 * is `[CODE] detail` rather than a JSON field: it is the reference's contract.
 *
 * @module dsh-plugin-otools-dbm/shared/protocol
 */

/** Stable codes for the transport layer itself. */
export const ERR = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  conflict: 'conflict',
  unsupported: 'unsupported',
  driverMissing: 'driver_missing',
  connectionClosed: 'connection_closed',
  timeout: 'timeout',
  tooLarge: 'too_large',
  aiUnavailable: 'ai_unavailable',
  internal: 'internal',
}

/**
 * Connection/statement codes the panel already localizes. Keyed by engine so the
 * adapters can classify a driver error without hard-coding strings twice.
 */
export const CONN_CODES = {
  mysql: 'DBM_MYSQL',
  mariadb: 'DBM_MYSQL',
  postgresql: 'DBM_PG',
  kingbasees: 'DBM_KINGBASE',
  sqlserver: 'DBM_SQLSERVER',
  oracle: 'DBM_ORACLE',
  dameng: 'DBM_DAMENG',
  elasticsearch: 'DBM_ES',
  clickhouse: 'DBM_CLICKHOUSE',
  kafka: 'DBM_KAFKA',
  snowflake: 'DBM_SNOWFLAKE',
  mongodb: 'DBM_MONGO',
  redis: 'DBM_REDIS',
}

/** Error with a stable code. `dbType` turns it into a localized panel message. */
export class DbmError extends Error {
  /**
   * @param code - one of ERR.*, or a full `DBM_*` code.
   * @param message - human detail, already localized where it matters.
   * @param options - optional `{ cause }`.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DbmError'
    this.code = code
  }
}

/** The panel-facing message for a connection failure it knows how to localize. */
export function connectionErrorMessage(dbType, kind, detail) {
  const prefix = CONN_CODES[String(dbType || '').toLowerCase()]
  if (prefix === undefined) {
    return String(detail ?? '')
  }
  return `[${prefix}_CONN_${kind}] ${String(detail ?? '')}`
}

/**
 * Classify a driver error into one of the four kinds the panel localizes.
 * @returns 'TIMEOUT' | 'AUTH' | 'TLS' | 'DNS' | 'UNKNOWN'
 */
export function classifyConnectionError(error) {
  const code = String(error?.code ?? '')
  const text = `${code} ${String(error?.message ?? error ?? '')}`.toLowerCase()

  if (/etimedout|timeout|timed out|esockettimedout/.test(text)) return 'TIMEOUT'
  if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) return 'DNS'
  if (
    /access denied|authentication failed|password authentication|auth failed|login failed|invalid credentials|er_access_denied|28p01|18456|ora-01017|wrongpass|noauth/
      .test(text)
  ) {
    return 'AUTH'
  }
  if (/ssl|tls|certificate|self.signed|handshake/.test(text)) return 'TLS'
  return 'UNKNOWN'
}

/** HTTP status for a code. */
export function statusOf(code) {
  switch (code) {
    case ERR.invalidInput:
      return 400
    case ERR.notFound:
      return 404
    case ERR.conflict:
      return 409
    case ERR.unsupported:
    case ERR.driverMissing:
      return 501
    case ERR.timeout:
      return 504
    case ERR.tooLarge:
      return 413
    case ERR.aiUnavailable:
    case ERR.connectionClosed:
      return 503
    default:
      return 500
  }
}

/** Every database engine the panel offers, exactly as the UI spells them. */
export const DB_TYPES = [
  'mysql',
  'mariadb',
  'postgresql',
  'sqlserver',
  'kingbasees',
  'dameng',
  'sqlite',
  'elasticsearch',
  'clickhouse',
  'kafka',
  'snowflake',
  'mongodb',
  'redis',
  'oracle',
]

/** Throw unless `value` is one of the known engines. */
export function requireDbType(value) {
  const normalized = String(value ?? '').toLowerCase().trim()
  if (!DB_TYPES.includes(normalized)) {
    throw new DbmError(ERR.invalidInput, `不支持的数据库类型: ${String(value ?? '')}`)
  }
  return normalized
}

/** Throw unless `value` is a non-empty string; returns it trimmed. */
export function requireText(value, field, options = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    throw new DbmError(ERR.invalidInput, `${field} 不能为空`)
  }
  const max = options.max ?? 4096
  if (text.length > max) {
    throw new DbmError(ERR.invalidInput, `${field} 过长`)
  }
  return text
}

/** Trimmed string or undefined — for the many optional database/schema params. */
export function optionalText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length === 0 ? undefined : text
}

/**
 * A SQL identifier the panel supplies (database, schema, table, column, index).
 *
 * This is the security boundary for every statement the host builds by
 * concatenation. Identifiers are quoted by the dialect afterwards, but a name
 * carrying a quote character could still break out of that quoting, so quotes, the
 * backslash, the statement separator and every control character are rejected
 * outright rather than escaped.
 *
 * Spaces and non-ASCII letters ARE allowed on purpose: every dialect quotes
 * identifiers, and refusing them would lock out real tables — Northwind's
 * `Order Details`, or any Chinese table name.
 */
export function requireIdentifier(value, field) {
  const text = requireText(value, field, { max: 512 })
  if (/["'`;]/.test(text) || text.includes('\\') || hasControlCharacter(text)) {
    throw new DbmError(ERR.invalidInput, `${field} 含有不允许的字符: ${text}`)
  }
  return text
}

/** Optional identifier. */
export function optionalIdentifier(value, field) {
  const text = optionalText(value)
  return text === undefined ? undefined : requireIdentifier(text, field)
}

/** A finite integer within bounds, or the fallback. */
export function boundedInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Any C0/C1 control character, including the ones that look like nothing.
 *
 * Written as a code-point scan rather than a regex range because an escaped range
 * in a character class is exactly the kind of thing that survives review while
 * being wrong — this version cannot be misread.
 */
export function hasControlCharacter(text) {
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}
