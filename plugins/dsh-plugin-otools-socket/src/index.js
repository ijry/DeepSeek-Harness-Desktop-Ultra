import { randomUUID } from 'node:crypto'

import { DeviceAuth, PairingOffers } from './host/auth.js'
import { normalizeConfig, LEDGER_FILE } from './host/config.js'
import { createExternalRoutes } from './host/routes.js'
import { adoptLegacyData, pluginDataPath } from './host/sdk.js'
import { OtoolsSocketService } from './host/service.js'
import { DeviceStore } from './host/store.js'
import { TicketStore } from './host/tickets.js'
import { startListener } from './host/carriers/listener.js'
import { createSocketHub } from './host/socket.js'
import { BUS_VERSION, CLIENT_BACKLOG_MAX_BYTES, decodeControlFrame, encodeCatalogFrames, encodeControlFrame } from './shared/protocol.js'

export const name = 'dsh-plugin-otools-socket'
export const inject = []
export const INTERNAL_SOCKET_PATH = '/dsh-plugin-otools-socket/socket'

function createInternalCarrier(ctx, service) {
  const clients = new Map()
  const hub = createSocketHub(ctx, {
    path: INTERNAL_SOCKET_PATH,
    authorize(req) {
      const origin = req.headers.origin
      return origin === undefined || origin === ''
        || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
    },
    onOpen(client) {
      const handle = service.attachClient({
        id: randomUUID(), transport: 'internal',
        send(frame) { return hub.send(client, frame) },
      })
      clients.set(client, handle)
      hub.send(client, {
        v: BUS_VERSION, kind: 'hello', serverInstanceId: service.serverInstanceId,
        catalogRevision: service.catalogFor('internal').revision,
        limits: { controlFrameBytes: 262144, catalogBytes: 524288, clientBacklogBytes: 1048576, requestTimeoutMs: 30000 },
      })
      for (const frame of encodeCatalogFrames(service.catalogFor('internal'))) hub.send(client, frame)
    },
    onMessage(client, frame) {
      const handle = clients.get(client)
      if (!handle) return
      if (frame.kind === 'subscribe') void service.subscribe(handle, frame.source)
      else if (frame.kind === 'unsubscribe') service.unsubscribe(handle, frame.source)
      else if (frame.kind === 'request') void service.dispatchRequest(handle, frame)
      else if (frame.kind === 'cancel') service.cancelRequest(handle, frame)
    },
    onClose(client) { clients.get(client)?.dispose(); clients.delete(client) },
    serialize: encodeControlFrame,
    maxBacklogBytes: CLIENT_BACKLOG_MAX_BYTES,
    maxMessageBytes: 262144,
  })
  return {
    dispose() {
      for (const handle of clients.values()) handle.dispose()
      clients.clear()
      hub?.dispose()
    },
  }
}

export function apply(ctx, rawConfig = {}, dependencies = {}) {
  const config = normalizeConfig(rawConfig)
  // 早期版本把账本散在 DSH home 根部，先收编再开库（显式传入的 file 不动）。
  if (rawConfig.file === undefined) adoptLegacyData(LEDGER_FILE, LEDGER_FILE)
  const file = rawConfig.file || pluginDataPath(LEDGER_FILE)
  const store = dependencies.createStore?.({ file }) ?? new DeviceStore({ file })
  const offers = new PairingOffers()
  const auth = new DeviceAuth({ store, offers })
  const tickets = new TicketStore({ isDeviceActive: id => store.snapshot().devices.some(row => row.deviceId === id && row.revokedAt === null) })
  const service = new OtoolsSocketService({ issueTransfer: spec => {
    const issued = tickets.issue(spec)
    return { ...issued, url: `/dsh-plugin-otools-socket/transfer/${issued.ticket}`, kind: spec.kind, contentType: spec.contentType, maxBytes: spec.maxBytes }
  } })
  service.serverInstanceId = randomUUID()
  service.externalState = () => ({ enabled: config.externalEnabled, listening: false, host: config.externalHost, port: config.externalPort, error: null })
  service.pairingOffer = () => offers.current()
  service.listDevices = () => auth.listDevices()
  service.revokeDevice = async deviceId => { const result = await auth.revoke(deviceId); tickets.invalidateDevice(deviceId); return result }

  const disposeProvided = ctx.provide('otoolsSocket', service)
  void store.load()

  ctx.inject(['webServer'], socketCtx => {
    const carrier = (dependencies.createInternalCarrier ?? createInternalCarrier)(socketCtx, service)
    return () => carrier?.dispose()
  })

  let listener
  let disposed = false
  let listenerStart
  if (config.externalEnabled) {
    const routes = createExternalRoutes({ auth, offers, store, tickets, protocolVersion: BUS_VERSION, allowedOrigins: config.allowedOrigins })
    listenerStart = (dependencies.startListener ?? startListener)({
      host: config.externalHost, port: config.externalPort,
      handler: routes.handler, upgradeHandler: routes.upgradeHandler,
    }).then(async value => {
      if (disposed) {
        await value.close()
        return
      }
      listener = value
    }, error => {
      console.error('[otools-socket] external listener failed:', error)
    })
  }
  return async () => {
    disposed = true
    await listenerStart
    await listener?.close()
    await disposeProvided?.()
    service.dispose()
    tickets.dispose()
  }
}
