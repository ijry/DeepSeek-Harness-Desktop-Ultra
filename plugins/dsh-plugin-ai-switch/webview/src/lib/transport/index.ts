import type { Transport, Unsubscribe } from "./types";
import { PANEL_BASE_URL } from "../../shims/panel-base";

/**
 * PORTED FILE — this is the one copied source the dsh plugin edits.
 *
 * The reference module picks between the Tauri transport and the web transport and
 * points the web one at `window.location.origin`. Inside the dsh panel both of those
 * are wrong:
 *
 * 1. There is no Tauri IPC here, so `TauriTransport` is not even imported — that also
 *    keeps `@tauri-apps/api` out of the bundle.
 * 2. `<origin>/api/...` belongs to dsh's own shell RPC. The panel's backend lives
 *    under `<origin>/dsh-plugin-ai-switch/`, so the transport is constructed with that
 *    prefix as its base URL. `WebTransport` builds `${base}/api/<command>` and
 *    `${base}/ws/events` from it, so nothing else in the app has to know.
 * 3. `isLocalWebDevRuntime()` returns true so `App.tsx` skips the web token gate.
 *    That gate protects `ai-switch-server`, which is exposed on the network; this
 *    panel is served by dsh's own web server, behind whatever dsh is behind, on the
 *    same origin as the shell — a second token would be a second lock on the same
 *    door, and there is no place to enter it (the iframe is the whole panel).
 *
 * Everything else re-exports the reference's modules unchanged.
 */
export type { Transport, Unsubscribe };

export {
  WEB_TOKEN_STORAGE_KEY,
  clearWebAccessToken,
  getWebAccessToken,
  isUnauthorizedTransportError,
  setWebAccessToken,
  WebTransport,
} from "./web-transport";

import { WebTransport } from "./web-transport";

let transport: Transport | null = null;

export function getTransport() {
  transport ??= new WebTransport(PANEL_BASE_URL);
  return transport;
}

export function isDesktop() {
  return false;
}

/** No Tauri shell around this panel, ever. */
export function isTauriRuntime() {
  return false;
}

/**
 * True: the panel is same-origin with the host that answers its commands, and dsh
 * already authorized the page. See the file header.
 */
export function isLocalWebDevRuntime() {
  return true;
}

export function __resetTransportForTests() {
  transport?.destroy?.();
  transport = null;
}
