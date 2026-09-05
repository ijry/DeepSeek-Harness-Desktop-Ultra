/**
 * The one place the panel talks to its host.
 *
 * In the reference plugin every call went through Tauri's `invoke`, which is a
 * synchronous-looking bridge into a Rust process living in the same window. Here
 * the host is the dsh Node process on the other end of the same HTTP origin that
 * served this page, so `invoke` becomes one POST per command and Tauri's event
 * bus becomes one shared SSE stream.
 *
 * Keeping the Tauri-shaped API (rather than rewriting 30 components) is what lets
 * the Vue sources stay byte-identical to the reference.
 */

/** Route prefix; the page itself is served from `<prefix>/app/`. */
export const ROUTE_PREFIX = '/dsh-plugin-otools-dbm'

/** Error carrying the host's stable code, so callers can branch on it. */
export class HostCallError extends Error {
  readonly code: string

  readonly status: number

  constructor(message: string, code = '', status = 0) {
    super(message)
    this.name = 'HostCallError'
    this.code = code
    this.status = status
  }
}

const asMessage = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['message', 'error', 'msg', 'details']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate
      }
    }
  }
  return fallback
}

/**
 * Call one host command.
 *
 * The wire shape is deliberately dumb: `POST <prefix>/api/<command>` with the
 * arguments object as the JSON body, and `{ ok, value }` / `{ ok: false, error }`
 * back. A rejected promise carries the host's message verbatim, because every
 * component already funnels errors through `extractDbmErrorMessage`.
 */
export const invoke = async <T = unknown>(
  command: string,
  args?: Record<string, unknown> | object,
): Promise<T> => {
  const name = String(command || '').trim()
  if (!name) {
    throw new HostCallError('缺少命令名', 'invalid_input')
  }

  let response: Response
  try {
    response = await fetch(`${ROUTE_PREFIX}/api/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
  } catch (error) {
    throw new HostCallError(asMessage(error, '无法连接到 DSH 服务'), 'network')
  }

  const raw = await response.text()
  let payload: unknown = null
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new HostCallError(`响应不是合法 JSON: ${raw.slice(0, 200)}`, 'protocol', response.status)
    }
  }

  const envelope = (payload || {}) as Record<string, unknown>
  if (!response.ok || envelope.ok === false) {
    const error = (envelope.error || {}) as Record<string, unknown>
    throw new HostCallError(
      asMessage(error.message ?? envelope.message ?? raw, `请求失败 (HTTP ${response.status})`),
      typeof error.code === 'string' ? error.code : '',
      response.status,
    )
  }

  return envelope.value as T
}

/** Tauri parity: the panel is always inside a host here. */
export const isTauri = () => true

/** Absolute URL of a host route, for `<a download>` and `EventSource`. */
export const hostUrl = (path: string) => {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${ROUTE_PREFIX}${suffix}`
}
