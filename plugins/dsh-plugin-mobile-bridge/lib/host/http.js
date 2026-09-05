/**
 * Carrier-level HTTP plumbing: the response envelope, a bounded body reader,
 * peer classification, and the SSE writer. Deliberately free of any dsh or
 * bridge domain knowledge so the route table can be mounted on more than one
 * carrier without either knowing about the other.
 *
 * @module dsh-plugin-mobile-bridge/host/http
 */
import { BridgeError, ERR, statusOf } from '../shared/protocol.js'
import { pick } from '../shared/lang.js'

/**
 * Request-body ceiling. A prompt may carry base64 image bytes, so it cannot be
 * small — but an unbounded local HTTP buffer is an OOM vector reachable by
 * anything that can open a socket, which on this listener is the whole LAN.
 */
export const MAX_BODY_BYTES = 12 * 1024 * 1024

/** Send a JSON body with no-store caching. */
export function json(res, payload, status = 200) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Send the success envelope. */
export function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/**
 * Send the failure envelope, mapping the wire code onto an HTTP status.
 * An unrecognized throw becomes `internal` with its message: swallowing the text
 * would leave a phone user with a bare 500 and no way to report anything useful.
 */
export function fail(res, error) {
  const code = error instanceof BridgeError ? error.code : ERR.internal
  const body = { code, message: String(error?.message ?? pick('未知错误', 'Unknown error')) }
  if (error?.dshCode !== undefined) body.dshCode = error.dshCode
  json(res, { ok: false, error: body }, statusOf(code))
}

/**
 * Read and JSON-parse a request body under {@link MAX_BODY_BYTES}.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>} the parsed body; `{}` for an empty one.
 * @throws {BridgeError} `invalid_input` when it is too large or not JSON.
 */
export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(
          new BridgeError(
            ERR.invalidInput,
            pick(
              `请求体超过 ${MAX_BODY_BYTES} 字节上限`,
              `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
            ),
          ),
        )
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) =>
      reject(
        new BridgeError(
          ERR.invalidInput,
          pick(`读取请求体失败：${error.message}`, `Could not read the request body: ${error.message}`),
        ),
      ),
    )
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(
          new BridgeError(
            ERR.invalidInput,
            pick(`请求体不是合法 JSON：${error.message}`, `The request body is not valid JSON: ${error.message}`),
          ),
        )
      }
    })
  })
}

/**
 * Whether the peer is on this machine.
 *
 * Read the caveat before using this for trust: a local tunnel daemon
 * (`cloudflared`, `ngrok`) connects from loopback too, so a loopback peer proves
 * "this machine" and nothing about who is on the other side of that daemon.
 * Which is exactly why the admin routes are gated on the *carrier* as well —
 * see host/routes.js.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the socket peer is a loopback address.
 */
export function fromLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/** The bearer token on a request, or `''`. */
export function bearer(req) {
  const header = String(req?.headers?.authorization ?? '')
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
}

/**
 * Cross-origin headers.
 *
 * The app is not a browser page, so CORS is not what protects this bridge —
 * tokens are. But a browser-based client (MCode's H5 build, a debugging tab) is a
 * legitimate consumer, and refusing it would push people towards disabling
 * security elsewhere. `*` is safe here only because every stateful route
 * requires an `Authorization` header, which a cross-site request cannot attach
 * without a successful preflight, and because no route trusts a cookie.
 */
export function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
}

/**
 * Open an SSE response and return a writer.
 *
 * `retry:` is sent up front so a phone that loses Wi-Fi reconnects on its own,
 * and a comment heartbeat keeps NAT and tunnel idle timers from closing a quiet
 * stream — a 15-minute silent session is normal while an agent thinks.
 *
 * @param {import('node:http').ServerResponse} res - the response to hijack.
 * @param {number} [heartbeatMs] - comment-ping interval.
 * @returns {{ send: Function, comment: Function, close: Function, closed: () => boolean }} the writer.
 */
export function sse(res, heartbeatMs = 20000) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Any reverse proxy in the path must not buffer an event stream.
    'x-accel-buffering': 'no',
  })
  res.write('retry: 3000\n\n')

  let open = true
  const timer = setInterval(() => {
    if (open) res.write(': ping\n\n')
  }, heartbeatMs)
  const stop = () => {
    if (!open) return
    open = false
    clearInterval(timer)
  }
  res.on('close', stop)
  res.on('error', stop)

  return {
    /** Write one named frame with an id the client can resume from. */
    send(id, event, data) {
      if (!open) return false
      return res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    /** Write a comment line (invisible to EventSource consumers). */
    comment(text) {
      if (open) res.write(`: ${text}\n\n`)
    },
    close() {
      stop()
      try {
        res.end()
      } catch {
        /* already gone */
      }
    },
    closed() {
      return !open
    },
  }
}
