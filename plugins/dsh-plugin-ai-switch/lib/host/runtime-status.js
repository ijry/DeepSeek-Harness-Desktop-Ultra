/**
 * Host/runtime status commands that keep the reference Settings screen useful in a plugin.
 *
 * The copied React app renders Web Service, local HTTPS, Tailscale and low-disk panels even
 * in a browser build. Returning `web.command_unknown` blanks those panels, which is a poor
 * way to express "this feature belongs to an installed desktop app". This module therefore
 * separates two answers:
 *
 * - read-only status commands return an honest, stable disabled state so the screen renders;
 * - mutation commands throw `transport.desktop_only`, never pretend a certificate was
 *   installed or a Tailscale daemon was started.
 *
 * The one exception is the Web Server panel's status: the plugin IS already running on
 * dsh's web server, so that status is true and reports dsh's host/port. Its configuration is
 * informational and cannot be edited here; dsh owns the listener.
 *
 * @module dsh-plugin-ai-switch/host/runtime-status
 */
import { statfs } from 'node:fs/promises'
import { parse } from 'node:path'

import { ApiError } from '../shared/protocol.js'
import { pluginHomePath } from './sdk.js'

export const LOW_DISK_THRESHOLD = 1024 * 1024 * 1024

/** Free space for the volume holding the plugin state. A probe failure degrades to empty. */
export async function getDiskSpaceStatus(path = pluginHomePath()) {
  try {
    const info = await statfs(path)
    const blockSize = Number(info.bsize ?? 0)
    const total = Number(info.blocks ?? 0) * blockSize
    const available = Number(info.bavail ?? info.bfree ?? 0) * blockSize
    const low = available < LOW_DISK_THRESHOLD
    return {
      threshold_bytes: LOW_DISK_THRESHOLD,
      low,
      volumes: [
        {
          label: process.platform === 'win32' ? parse(path).root.replace(/[\\/]$/, '') : parse(path).root,
          path,
          total_bytes: Math.max(0, Math.trunc(total)),
          available_bytes: Math.max(0, Math.trunc(available)),
          low,
        },
      ],
    }
  } catch {
    return { threshold_bytes: LOW_DISK_THRESHOLD, low: false, volumes: [] }
  }
}

/** Local HTTPS is absent because a plugin must not install a root CA into the OS. */
export function getRouteProxyHttpsStatus(home = pluginHomePath()) {
  return {
    enabled: false,
    certReady: false,
    trustStatus: 'unknown',
    trustAdapter: null,
    rootFingerprint: null,
    expiresAt: null,
    certificateDir: `${home}/certs/route-proxy`,
    rootCertificatePath: null,
    proxyBaseUrl: null,
    message: 'Local HTTPS is unavailable in the dsh plugin; the HTTP proxy remains on loopback.',
    manualInstructions: [],
  }
}

/** The reference's browser-server config, projected onto dsh's already-running server. */
export function getWebServiceConfig() {
  return {
    host: '127.0.0.1',
    port: 3090,
    token: null,
    autoStart: false,
    tailscaleEnabled: false,
    tailscaleHostname: null,
    tailscaleAuthKeyPresent: false,
    tailscaleExposureMode: 'private',
    tlsEnabled: false,
    tlsCertPath: null,
    tlsKeyPath: null,
  }
}

export function getWebServerStatus(webServer) {
  const port = Number.isFinite(webServer?.port) ? webServer.port : null
  const host = typeof webServer?.host === 'string' ? webServer.host : '127.0.0.1'
  return {
    running: true,
    host,
    port,
    baseUrl: port === null ? null : `http://${host}:${port}`,
  }
}

/** Tailscale requires the Go tsnet sidecar the Tauri app ships; a plugin has none. */
export function getTailscaleStatus() {
  return {
    state: 'disabled',
    deviceName: null,
    tailnetIp: null,
    magicDnsName: null,
    loginUrl: null,
    accessUrls: [],
    serving: false,
    public: false,
    exposureMode: 'private',
    publicPort: null,
    message: 'Tailscale remote access is unavailable in the dsh plugin.',
  }
}

/** A mutation that only an installed desktop application can perform. */
export function desktopOnly(command) {
  throw new ApiError('transport.desktop_only', 'This command is only available in the desktop application.', {
    details: command,
    recoverable: false,
  })
}
