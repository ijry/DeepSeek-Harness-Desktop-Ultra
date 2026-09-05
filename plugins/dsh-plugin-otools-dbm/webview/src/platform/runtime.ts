/**
 * Runtime probes.
 *
 * The reference plugin used these to tell "running inside the OTools desktop
 * shell" from "running in a plain browser against a remote service", because the
 * former had a Tauri bridge and the latter had nothing — several panels degrade
 * gracefully on that answer (no local state persistence, no OS file manager).
 *
 * In this port there is always a host on the other end of the HTTP origin, so the
 * bridge is always present. `isNativeTauriRuntime` stays false: it gates things
 * only a native window can do, and nothing here can.
 */

/** A host that can run commands is reachable. Always true in this port. */
export const hasHostBridgeRuntime = () => true

/** There is no Tauri window around this panel. */
export const isNativeTauriRuntime = () => false

/** The panel always talks to a service over HTTP. */
export const isRemoteServiceRuntime = () => true
