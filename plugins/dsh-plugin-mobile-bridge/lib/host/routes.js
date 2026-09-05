/**
 * The bridge route table — one `(req, res)` handler mounted on every carrier.
 *
 * Carriers differ in exactly one way, and it is a security boundary rather than a
 * convenience: `admin` decides whether this mount serves `/admin/*`, the routes
 * that can read the pairing secret and revoke devices. Only the loopback carrier
 * inside dsh's own web server sets it. The LAN listener never does, so exposing
 * that listener through a tunnel cannot reach them.
 *
 * Peer address is checked *as well*, not instead: a local tunnel daemon connects
 * from loopback too, so a loopback peer proves "this machine" and nothing about
 * who is upstream of it. Requiring both means an admin request has to arrive on
 * the carrier that is not reachable from outside AND from a local socket.
 *
 * @module dsh-plugin-mobile-bridge/host/routes
 */
import {
  ANSWER_KIND,
  APPROVAL_OUTCOME,
  BridgeError,
  CAPABILITY,
  ERR,
  EVENTS_PATH,
  EVENTS_WS_PATH,
  PROTOCOL_VERSION,
  ROUTE_PREFIX,
  TARGET_AGENT,
  encodeConfigCode,
  pairingPayload,
  statusOf,
} from '../shared/protocol.js'
import { handshakeToken, upgrade } from './carriers/websocket.js'
import { deviceFor, mintDevice, mintToken, sha256 } from './auth.js'
import { bearer, cors, fail, fromLoopback, ok, readJson, sse } from './http.js'
import { messagesOf, summaryOf } from './projection.js'
import { encodeQr, toSvgPath } from '../shared/qr.js'

/** Everything the bridge advertises; a client reads this, never a version check. */
const CAPABILITIES = Object.values(CAPABILITY)

/** Default history page size, in messages. */
const DEFAULT_PAGE = 40

/** Hard ceiling on one history page, so a phone cannot ask for a whole log. */
const MAX_PAGE = 200

const TASK = new RegExp(`^${ROUTE_PREFIX}/sessions/([^/]+)(?:/([\\w-]+))?$`)

/** Require a paired device, or refuse with 401. */
async function requireDevice(deps, req) {
  const token = bearer(req)
  if (token === '') throw new BridgeError(ERR.unauthorized, '缺少 Authorization: Bearer <token>')
  const ledger = await deps.store.load()
  const device = deviceFor(ledger.devices, token)
  if (device === undefined) throw new BridgeError(ERR.unauthorized, '令牌无效或已被吊销，请重新配对')
  deps.store.touch(device.deviceId, deps.now())
  return device
}

/** Require the admin carrier and a local peer, or refuse with 403. */
function requireAdmin(deps, req) {
  if (deps.admin !== true || !fromLoopback(req)) {
    throw new BridgeError(ERR.forbidden, '这个接口只在本机的 dsh 界面里可用')
  }
}

/** The public identity of this bridge. Must never carry a secret. */
function hello(deps, ledger) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    targetAgent: TARGET_AGENT,
    targetId: ledger.targetId,
    displayName: ledger.displayName || deps.displayName(),
    capabilities: CAPABILITIES,
    dshVersion: deps.dshVersion(),
    devices: ledger.devices.filter((device) => device.revokedAt === null).length,
    // A client shows "扫码配对" versus "输入配对码" from this, so it must be
    // honest even before any device exists.
    requiresPairing: true,
  }
}

/** The pair response, shaped like MCode's own so its normalizer needs no branch. */
function pairResponse(tokens, deps, ledger) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    target: {
      targetId: ledger.targetId,
      targetAgent: TARGET_AGENT,
      displayName: ledger.displayName || deps.displayName(),
      capabilities: CAPABILITIES,
      protocolVersion: PROTOCOL_VERSION,
      online: true,
    },
  }
}

/** Exchange a pairing code for a device's first token pair. */
async function pair(deps, req) {
  if (deps.offers.throttled()) {
    throw new BridgeError(ERR.rateLimited, '配对尝试过于频繁，请稍后再试')
  }
  const body = await readJson(req)
  if (!deps.offers.consume(body.code, body.secret)) {
    throw new BridgeError(ERR.pairingFailed, '配对码或密钥不正确、已过期，或已经被用过——请在 dsh 里重新出码')
  }
  const now = deps.now()
  const { tokens, record } = mintDevice(body.deviceName ?? body.name, now)
  const ledger = await deps.store.addDevice(record)
  return pairResponse(tokens, deps, ledger)
}

/** Trade a refresh token for a fresh pair, rotating both. */
async function refresh(deps, req) {
  const body = await readJson(req)
  const ledger = await deps.store.load()
  const device = deviceFor(ledger.devices, body.refreshToken, 'refreshHash')
  if (device === undefined) throw new BridgeError(ERR.unauthorized, '刷新令牌无效或已被吊销，请重新配对')
  const accessToken = mintToken()
  const refreshToken = mintToken()
  // Both halves rotate together: leaving the refresh token in place would make a
  // single captured refresh valid forever, which is the whole failure mode
  // refresh rotation exists to close.
  const next = await deps.store.rotateDevice(
    device.deviceId,
    sha256(accessToken),
    sha256(refreshToken),
    deps.now(),
  )
  return pairResponse({ accessToken, refreshToken }, deps, next)
}

/** Prompt content parts from a phone-shaped body. */
function contentOf(body) {
  const parts = []
  const text = String(body.text ?? '').trim()
  if (text !== '') parts.push({ type: 'text', text })
  for (const image of Array.isArray(body.images) ? body.images.slice(0, 8) : []) {
    if (image === null || typeof image !== 'object') continue
    const mediaType = String(image.mediaType ?? '')
    const data = String(image.data ?? '')
    if (!mediaType.startsWith('image/') || data === '') continue
    parts.push({
      type: 'image',
      mediaType,
      data,
      ...(image.name === undefined ? {} : { name: String(image.name).slice(0, 120) }),
    })
  }
  if (parts.length === 0) throw new BridgeError(ERR.invalidInput, '消息为空：至少要有文本或一张图片')
  return parts
}

/** One session route: `/sessions/:id` plus an optional action segment. */
async function sessionRoute(deps, req, res, sessionId, action, method) {
  if (method === 'GET' && action === 'messages') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_PAGE))
    const beforeRaw = url.searchParams.get('beforeSeq')
    const page = await deps.bridge.history({
      sessionId,
      maxMessages: limit,
      ...(beforeRaw === null ? {} : { beforeSeq: Number(beforeRaw) }),
    })
    const title = page.projections?.values?.title
    return ok(res, {
      messages: messagesOf(page.events),
      hasMore: page.hasMore === true,
      asOfSeq: Number(page.projections?.asOfSeq ?? -1),
      ...(typeof title === 'string' ? { title } : {}),
    })
  }

  if (method === 'GET' && action === 'models') {
    return ok(res, await deps.bridge.models(sessionId))
  }

  if (method === 'POST' && action === 'prompt') {
    const body = await readJson(req)
    const mode = body.mode === 'steer' ? 'steer' : 'queue'
    const value = await deps.bridge.prompt({
      sessionId,
      mode,
      content: contentOf(body),
      ...(typeof body.clientTimeZone === 'string' ? { clientTimeZone: body.clientTimeZone } : {}),
    })
    return ok(res, value)
  }

  if (method === 'POST' && action === 'cancel') {
    return ok(res, await deps.bridge.cancel(sessionId))
  }

  if (method === 'POST' && action === 'rename') {
    const body = await readJson(req)
    const title = String(body.title ?? '').trim()
    if (title === '') throw new BridgeError(ERR.invalidInput, '标题不能为空')
    return ok(res, await deps.bridge.rename(sessionId, title))
  }

  if (method === 'POST' && action === 'model') {
    const body = await readJson(req)
    const provider = String(body.provider ?? '')
    const model = String(body.model ?? '')
    if (provider === '' || model === '') {
      throw new BridgeError(ERR.invalidInput, 'provider 与 model 都是必填')
    }
    return ok(
      res,
      await deps.bridge.selectModel({
        sessionId,
        provider,
        model,
        ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: String(body.reasoningEffort) }),
      }),
    )
  }

  if (method === 'GET' && action === undefined) {
    const list = await deps.bridge.listSessions()
    const row = (list.items ?? []).map(summaryOf).find((item) => item.sessionId === sessionId)
    if (row === undefined) throw new BridgeError(ERR.notFound, '没有这个会话')
    return ok(res, row)
  }

  throw new BridgeError(ERR.notFound, `未知的会话操作 ${method} ${action ?? ''}`)
}

/** Answer one approval or question the agent is waiting on. */
async function answer(deps, req) {
  const body = await readJson(req)
  const requestId = String(body.requestId ?? '')
  if (requestId === '') throw new BridgeError(ERR.invalidInput, 'requestId 是必填的')
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') throw new BridgeError(ERR.invalidInput, 'sessionId 是必填的')

  if (body.kind === ANSWER_KIND.approval) {
    const outcome = String(body.outcome ?? '')
    if (outcome !== APPROVAL_OUTCOME.allow && outcome !== APPROVAL_OUTCOME.deny) {
      throw new BridgeError(
        ERR.invalidInput,
        `outcome 只能是 ${APPROVAL_OUTCOME.allow} 或 ${APPROVAL_OUTCOME.deny}`,
      )
    }
    const approvalId = String(body.approvalId ?? '')
    if (approvalId === '') throw new BridgeError(ERR.invalidInput, 'approvalId 是必填的')
    return deps.bridge.respond(requestId, { sessionId, approvalId, outcome })
  }

  if (body.kind === ANSWER_KIND.question) {
    const answers = Array.isArray(body.answers) ? body.answers : null
    if (answers === null) throw new BridgeError(ERR.invalidInput, 'answers 必须是数组')
    // dsh validates the batch against the pending question itself (unknown
    // labels, missing ids, empty custom text), so the bridge only shapes it.
    return deps.bridge.respond(requestId, {
      sessionId,
      answer: {
        answers: answers.map((item) => ({
          id: String(item?.id ?? ''),
          selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
          ...(item?.custom === undefined ? {} : { custom: String(item.custom) }),
        })),
      },
    })
  }

  throw new BridgeError(ERR.invalidInput, `未知的回答类型 ${String(body.kind)}`)
}

/** The panel's whole view: reachability, the live offer, and paired devices. */
async function adminState(deps) {
  const ledger = await deps.store.load()
  const offer = deps.offers.current()
  const reach = deps.reach()
  const name = ledger.displayName || deps.displayName()

  return {
    ...hello(deps, ledger),
    displayName: name,
    reach,
    // The code alone cannot pair anything — the secret is required too, and it
    // only ever leaves through `/admin/qr`. So this route stays free of it, and a
    // screenshot of the panel's text fields is not a credential.
    pairing: { code: offer.code, expiresAt: offer.expiresAt },
    downloadUrl: deps.downloadUrl,
    devices: ledger.devices
      .filter((device) => device.revokedAt === null)
      .map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      })),
    stream: { lastEventId: deps.hub.lastEventId, windowStart: deps.hub.windowStart },
  }
}

/**
 * The two QR codes, as SVG path geometry.
 *
 * Rendered here rather than in the browser for one structural reason: the QR
 * encoder lives in `shared/qr.js`, and the client bundle is a single wrapped file
 * with no module resolution, so shipping the encoder to the panel would mean a
 * second copy of the only real maths in this package. One copy, one test suite,
 * and the panel just draws a path.
 *
 * This is also the only route that emits the pairing secret, which is why it is
 * separate from `/admin/state`: the state poll carries no credential at all.
 */
async function adminQr(deps) {
  const ledger = await deps.store.load()
  const offer = deps.offers.current()
  const reach = deps.reach()
  const payload = pairingPayload({
    name: ledger.displayName || deps.displayName(),
    baseUrl: reach.urls[0] ?? reach.localUrl ?? '',
    code: offer.code,
    secret: offer.secret,
    targetId: ledger.targetId,
    candidates: reach.urls.slice(1),
  })
  const configCode = encodeConfigCode(payload)

  return {
    code: offer.code,
    expiresAt: offer.expiresAt,
    configCode,
    // Level L for the pairing code: it is the denser of the two payloads, and a
    // screen at arm's length has no print defects for the extra parity to fix.
    pairing: reach.urls.length === 0 && reach.localUrl === null ? null : svg(configCode, 'L'),
    download: svg(deps.downloadUrl, 'M'),
    payload,
  }
}

/** One QR as `{ path, extent, version }`, or null when the payload will not fit. */
function svg(text, level) {
  try {
    const symbol = encodeQr(text, { level })
    const { path, extent } = toSvgPath(symbol.modules, 4)
    return { path, extent, version: symbol.version }
  } catch (error) {
    console.warn(`[dsh-plugin-mobile-bridge] 二维码生成失败：${error.message}`)
    return null
  }
}


/**
 * Build the route handler for one carrier.
 *
 * @param {object} deps - `{ admin, bridge, store, hub, offers, reach, displayName,
 *   downloadUrl, dshVersion, now }`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRoutes(deps) {
  return async function handle(req, res) {
    cors(res)
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX

    try {
      if (method === 'GET' && (path === ROUTE_PREFIX || path === `${ROUTE_PREFIX}/hello`)) {
        return ok(res, hello(deps, await deps.store.load()))
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/pair`) {
        return ok(res, await pair(deps, req), 201)
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/session/refresh`) {
        return ok(res, await refresh(deps, req))
      }

      if (path.startsWith(`${ROUTE_PREFIX}/admin/`)) {
        requireAdmin(deps, req)
        return await adminRoute(deps, req, res, path.slice(`${ROUTE_PREFIX}/admin/`.length), method)
      }

      // Everything below needs a paired device.
      const device = await requireDevice(deps, req)

      if (method === 'GET' && path === EVENTS_PATH) {
        return events(deps, req, res, url)
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/sessions`) {
        const list = await deps.bridge.listSessions()
        return ok(res, { items: (list.items ?? []).map(summaryOf) })
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/sessions`) {
        const body = await readJson(req)
        const payload = {}
        if (typeof body.workspaceId === 'string' && body.workspaceId !== '') payload.workspaceId = body.workspaceId
        else if (typeof body.cwd === 'string' && body.cwd !== '') payload.cwd = body.cwd
        if (typeof body.agentPreset === 'string' && body.agentPreset !== '') payload.agentPreset = body.agentPreset
        return ok(res, await deps.bridge.createSession(payload), 201)
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/workspaces`) {
        const value = await deps.bridge.listWorkspaces()
        return ok(res, {
          items: (value.items ?? []).map((item) => ({
            workspaceId: item.workspaceId,
            title: item.title,
            path: item.path,
            sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
          })),
          archivedSessionIds: value.archivedSessionIds ?? [],
        })
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/search`) {
        const query = String(url.searchParams.get('q') ?? '').trim()
        if (query === '') throw new BridgeError(ERR.invalidInput, '搜索词不能为空')
        const controller = new AbortController()
        req.on('close', () => controller.abort())
        return ok(res, await deps.bridge.searchSessions(query, controller.signal))
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/answers`) {
        return ok(res, await answer(deps, req))
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/logout`) {
        await deps.store.revokeDevice(device.deviceId, deps.now())
        return ok(res, { revoked: true })
      }

      const match = TASK.exec(path)
      if (match !== null) {
        return await sessionRoute(deps, req, res, decodeURIComponent(match[1]), match[2], method)
      }

      throw new BridgeError(ERR.notFound, `没有这个接口：${method} ${path}`)
    } catch (error) {
      fail(res, error)
    }
  }
}

/** The admin sub-table. Reached only after {@link requireAdmin} passes. */
async function adminRoute(deps, req, res, action, method) {
  if (method === 'GET' && action === 'state') {
    return ok(res, await adminState(deps))
  }
  if (method === 'GET' && action === 'qr') {
    return ok(res, await adminQr(deps))
  }
  if (method === 'POST' && action === 'rotate') {
    deps.offers.rotate()
    return ok(res, await adminState(deps))
  }
  if (method === 'POST' && action === 'name') {
    const body = await readJson(req)
    await deps.store.setDisplayName(body.displayName)
    return ok(res, await adminState(deps))
  }
  if (method === 'POST' && action === 'revoke') {
    const body = await readJson(req)
    if (body.all === true) await deps.store.revokeAll(deps.now())
    else {
      const deviceId = String(body.deviceId ?? '')
      if (deviceId === '') throw new BridgeError(ERR.invalidInput, 'deviceId 是必填的')
      await deps.store.revokeDevice(deviceId, deps.now())
    }
    // Revoking is also the "someone saw my screen" button, so it rotates the
    // offer too: leaving a live code behind would undo half the gesture.
    deps.offers.rotate()
    return ok(res, await adminState(deps))
  }
  throw new BridgeError(ERR.notFound, `没有这个管理接口：${method} ${action}`)
}

/**
 * Open one SSE stream.
 *
 * `Last-Event-ID` is honoured over the query parameter because that is the
 * header a browser `EventSource` resends by itself; the query form exists for
 * native clients that cannot set headers on a stream.
 */
function events(deps, req, res, url) {
  const sessionId = url.searchParams.get('sessionId')
  const headerId = Number(req.headers['last-event-id'])
  const queryId = Number(url.searchParams.get('lastEventId'))
  const lastEventId = Number.isFinite(headerId) && headerId > 0 ? headerId : Number.isFinite(queryId) ? queryId : 0

  const writer = sse(res)
  const unsubscribe = deps.hub.subscribe(writer, {
    sessionId: sessionId === null || sessionId === '' ? null : sessionId,
    lastEventId,
  })
  req.on('close', () => {
    unsubscribe()
    writer.close()
  })
}

/**
 * The WebSocket half of the event stream.
 *
 * A failed handshake is answered with a plain HTTP response and the socket is
 * destroyed rather than upgraded: a client that gets a 101 and then an immediate
 * close cannot tell "bad token" from "network glitch", and would retry forever.
 *
 * @param {object} deps - the same deps `createRoutes` takes.
 * @returns {(req, socket, head) => Promise<void>} an upgrade handler.
 */
export function createUpgradeHandler(deps) {
  return async function handleUpgrade(req, socket) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.replace(/\/+$/, '') !== EVENTS_WS_PATH) {
      socket.destroy()
      return
    }

    let device
    try {
      const token = handshakeToken(req)
      const ledger = await deps.store.load()
      device = deviceFor(ledger.devices, token)
      if (device === undefined) throw new BridgeError(ERR.unauthorized, '令牌无效或已被吊销')
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : ERR.internal
      socket.write(
        `HTTP/1.1 ${statusOf(code)} Unauthorized\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n` +
          JSON.stringify({ ok: false, error: { code, message: String(error?.message ?? error) } }),
      )
      socket.destroy()
      return
    }

    deps.store.touch(device.deviceId, deps.now())
    const sessionId = url.searchParams.get('sessionId')
    const lastEventId = Number(url.searchParams.get('lastEventId'))
    const writer = upgrade(req, socket)
    const unsubscribe = deps.hub.subscribe(writer, {
      sessionId: sessionId === null || sessionId === '' ? null : sessionId,
      lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
    })
    socket.on('close', unsubscribe)
  }
}





