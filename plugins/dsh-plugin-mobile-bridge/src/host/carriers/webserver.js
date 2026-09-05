/**
 * The loopback carrier: the same route table mounted on dsh's own web server.
 *
 * This is the mount the in-page panel talks to, and the only one that serves
 * `/admin/*`. It is same-origin with the GUI, so the panel needs no token, no
 * CORS negotiation, and no second port — and because dsh's server binds loopback
 * by default, nothing off this machine can reach it.
 *
 * One prefix registration is enough: dsh matches exact routes first, then the
 * longest prefix, so `/dsh-mobile-bridge` claims itself and everything under it.
 *
 * @module dsh-plugin-mobile-bridge/host/carriers/webserver
 */
import { EVENTS_WS_PATH, ROUTE_PREFIX } from '../../shared/protocol.js'

/**
 * Register the route table on `ctx.webServer`.
 *
 * @param {object} ctx - a context with `webServer` injected.
 * @param {Function} handler - the route handler from `createRoutes`.
 * @param {Function} upgradeHandler - the handler from `createUpgradeHandler`.
 * @returns {() => void} the disposer removing both routes.
 */
export function registerWebServerCarrier(ctx, handler, upgradeHandler) {
  const disposers = [
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handler(req, res),
    }),
    ctx.webServer.registerUpgrade({
      path: EVENTS_WS_PATH,
      handler: (req, socket, head) => upgradeHandler(req, socket, head),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

