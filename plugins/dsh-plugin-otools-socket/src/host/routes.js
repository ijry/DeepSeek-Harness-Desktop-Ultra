import { URL } from 'node:url'

import { bearer, corsHeaders, json, parseUploadBody, readJson, ROUTE_PREFIX, statusFor } from './http.js'
import { createExternalUpgrade } from './carriers/websocket.js'

function envelope(value) { return { ok: true, value } }
function failure(reason) {
  const code = reason?.code ?? 'internal'
  return { ok: false, error: { code, message: code === 'internal' ? 'internal error' : String(reason.message ?? code) } }
}

export function createExternalRoutes(options) {
  const {
    auth, offers, store, tickets, protocolVersion = 2,
    allowedOrigins = [], onControl = () => {},
  } = options

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const cors = corsHeaders(req, allowedOrigins)
    if (url.searchParams.has('token') || url.searchParams.has('accessToken')) {
      return json(res, 400, failure(Object.assign(new Error('tokens are not accepted in URLs'), { code: 'invalid_input' })), cors)
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
      })
      return res.end()
    }
    try {
      if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/hello`) {
        const snapshot = store.snapshot()
        return json(res, 200, envelope({
          protocolVersion,
          targetId: snapshot.targetId,
          displayName: snapshot.displayName,
          requiresPairing: snapshot.devices.filter(row => row.revokedAt === null).length === 0,
        }), cors)
      }
      if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/pair`) {
        const body = await readJson(req)
        return json(res, 200, envelope(await auth.pair(body)), cors)
      }
      if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/session/refresh`) {
        const token = bearer(req)
        if (!token) throw Object.assign(new Error('refresh token required'), { code: 'unauthorized' })
        return json(res, 200, envelope(await auth.refresh(token)), cors)
      }
      const transfer = url.pathname.match(new RegExp(`^${ROUTE_PREFIX}/transfer/([A-Za-z0-9_-]+)$`))
      if (transfer && (req.method === 'GET' || req.method === 'POST')) {
        const device = auth.authenticateAccess(bearer(req))
        if (!device) throw Object.assign(new Error('access token required'), { code: 'unauthorized' })
        const kind = req.method === 'POST' ? 'upload' : 'download'
        const active = tickets.consume(transfer[1], { deviceId: device.deviceId, kind })
        const controller = new AbortController()
        const abort = () => controller.abort('disconnect')
        req.on('aborted', abort)
        res.on('close', () => { if (!res.writableEnded) abort() })
        active.signal.addEventListener('abort', () => controller.abort(active.signal.reason), { once: true })
        if (kind === 'upload') {
          let loaded = 0
          const parsed = await parseUploadBody(req, req.headers['content-type'], active.maxBytes)
          const body = (async function* () {
            for await (const chunk of parsed.body) {
              active.touch?.()
              loaded += chunk.length
              if (loaded > active.maxBytes) throw Object.assign(new Error('upload too large'), { code: 'invalid_input' })
              yield chunk
            }
          })()
          await active.onStart({ ...active, contentType: parsed.contentType, signal: controller.signal, request: req, body })
          active.done()
          return json(res, 200, envelope({ uploadedBytes: loaded }), cors)
        }
        let started = false
        const writer = {
          setResponse(meta = {}) {
            if (started) throw new Error('response already started')
            started = true
            res.writeHead(meta.status ?? 200, {
              ...cors, 'content-type': active.contentType,
              ...(meta.size === undefined ? {} : { 'content-length': meta.size }),
              ...(meta.headers ?? {}),
            })
          },
          write(bytes) {
            active.touch?.()
            if (!started) this.setResponse()
            return res.write(Buffer.from(bytes))
          },
          end() { if (!started) this.setResponse(); res.end(); active.done() },
        }
        await active.onStart({ ...active, signal: controller.signal, request: req, ...writer })
        return
      }
      return json(res, 404, failure(Object.assign(new Error('not found'), { code: 'not_found' })), cors)
    } catch (reason) {
      return json(res, statusFor(reason?.code), failure(reason), cors)
    }
  }

  const upgradeHandler = createExternalUpgrade({
    auth,
    onControl,
    consumeTransfer: (ticket, identity) => tickets.consume(ticket, identity),
  })
  return { handler, upgradeHandler }
}
