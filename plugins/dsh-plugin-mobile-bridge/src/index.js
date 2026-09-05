/**
 * dsh-plugin-mobile-bridge — host half.
 *
 * Lets the MCode phone app drive this desktop's dsh. The plugin is the
 * "承接" (receiving) side: it owns pairing, authentication, and a narrow
 * phone-shaped protocol projected from dsh's own `/api`, and it publishes that
 * protocol on two carriers — dsh's loopback web server (for the in-page panel)
 * and its own all-interfaces listener (for the LAN, and for whatever tunnel the
 * user points at it).
 *
 * What it deliberately does NOT do:
 *
 * - It does not proxy `/api` wholesale. Upstream pins the configuration plane and
 *   the native-action methods to loopback until a real authentication layer
 *   exists; a token-gated passthrough would re-expose them. host/bridge.js is the
 *   entire allowlist, enforced by which functions exist.
 * - It does not change how dsh binds. dsh keeps serving its GUI on loopback
 *   exactly as shipped.
 * - It does not register tools or touch the system prompt. Nothing about this
 *   plugin is visible to the model; it is a second UI, not a behavior change.
 *
 * Export shape is cordis's function/namespace plugin: named `name` / `inject` /
 * `apply`, no default export.
 *
 * @module dsh-plugin-mobile-bridge
 */
import { APP_DOWNLOAD_URL, ROUTE_PREFIX } from './shared/protocol.js'
import { PairingOffers } from './host/auth.js'
import { createBridge } from './host/bridge.js'
import { registerWebServerCarrier } from './host/carriers/webserver.js'
import { startListener } from './host/carriers/listener.js'
import { LEDGER_FILE, normalizeConfig } from './host/config.js'
import { bridgeUrls, defaultDisplayName } from './host/net.js'
import { dshHomePath } from './host/sdk.js'
import { createRoutes, createUpgradeHandler } from './host/routes.js'
import { DeviceStore } from './host/store.js'
import { EventHub } from './host/stream.js'

/** Cordis plugin name. */
export const name = 'dsh-plugin-mobile-bridge'

/**
 * Required host services. `webServer` is the hard one: without it there is no
 * panel and no loopback carrier, and a mobile bridge with neither is not worth
 * activating. `apiProxy` is injected in a nested scope so a composition that
 * lacks it degrades to a panel explaining why, instead of failing to load.
 */
export const inject = ['webServer']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = new DeviceStore({ file: dshHomePath(LEDGER_FILE) })
  void store.load()
  const offers = new PairingOffers()
  const displayName = () => config.displayName || defaultDisplayName()

  ctx.inject(['apiProxy'], (apiCtx) => {
    const bridge = createBridge(apiCtx.apiProxy)
    const hub = new EventHub({ bridge })
    hub.start()

    let listener = null
    let listenError = null
    let dshVersion = null
    // One describe at activation, cached: `/hello` is polled by the panel and by
    // every reconnecting phone, and it must not turn into an RPC per poll.
    void bridge
      .describe()
      .then((info) => {
        dshVersion = String(info?.version ?? '') || null
      })
      .catch(() => {
        /* the version is decoration; its absence is reported as null */
      })

    /**
     * Where a phone can reach this bridge right now. Recomputed per call because
     * a laptop changes networks without telling anyone, and a stale QR pointing at
     * the previous Wi-Fi is the single most confusing failure this feature has.
     */
    const reach = () => {
      const port = listener?.port ?? null
      return {
        lan: config.lan,
        listening: listener !== null,
        port,
        host: config.lanHost,
        error: listenError,
        localUrl: port === null ? null : `http://127.0.0.1:${port}${ROUTE_PREFIX}`,
        urls: port === null ? [] : bridgeUrls(port),
        // The loopback carrier is always there; a tunnel pointed at dsh's own
        // port would reach it, which is exactly what the docs tell users not to
        // do, so it is reported separately rather than as a pairing candidate.
        dshRoutePrefix: ROUTE_PREFIX,
      }
    }

    const shared = {
      bridge,
      store,
      hub,
      offers,
      reach,
      displayName,
      // A getter-shaped dependency, not a value: `apply` returns before the
      // describe resolves, and a spread of a plain field would freeze `null`
      // into both route tables forever.
      dshVersion: () => dshVersion,
      downloadUrl: APP_DOWNLOAD_URL,
      now: () => Date.now(),
    }

    const localRoutes = createRoutes({ ...shared, admin: true })
    const remoteRoutes = createRoutes({ ...shared, admin: false })
    // The upgrade handler is carrier-independent: a WebSocket only ever carries
    // the event stream, and there is no admin stream.
    const upgradeHandler = createUpgradeHandler(shared)

    const disposeRoute = registerWebServerCarrier(apiCtx, localRoutes, upgradeHandler)

    if (config.lan) {
      void startListener({
        handler: remoteRoutes,
        upgradeHandler,
        host: config.lanHost,
        port: config.lanPort,
        onError: (error) => {
          listenError = `${error.code ?? 'ERR'}: ${error.message}`
          console.warn(
            `[dsh-plugin-mobile-bridge] 无法在 ${config.lanHost}:${config.lanPort} 监听：${error.message}`,
          )
        },
      }).then((started) => {
        listener = started
        if (started !== null) {
          console.log(
            `[dsh-plugin-mobile-bridge] 手机桥已监听 http://${config.lanHost}:${started.port}${ROUTE_PREFIX}`,
          )
        }
      })
    }

    // cordis inject semantics: the callback's return value is the disposer.
    return () => {
      disposeRoute()
      hub.stop()
      const closing = listener
      listener = null
      void closing?.close()
    }
  })
}
