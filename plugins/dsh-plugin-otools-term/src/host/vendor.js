/**
 * The vendored browser assets: xterm.js and its two addons, served out of this
 * package's own node_modules.
 *
 * The client bundle is a single plain script with no module resolution, so a
 * terminal emulator cannot be `import`ed into it and inlining a 290 KB minified
 * bundle into a generated file would be unreadable and unreviewable. Instead the
 * host serves the exact files npm installed, from a fixed table, and the browser
 * half loads them with a script tag. That keeps xterm at a pinned version, works
 * offline, and never reaches the network.
 *
 * The table is an ALLOW-LIST of five names. A request cannot name a path: the only
 * thing that reaches `createRequire().resolve()` is a constant from this file, so
 * there is no way to walk out of node_modules and read something else.
 *
 * @module dsh-plugin-otools-term/host/vendor
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)

/** The only files this route will serve, and what they resolve to. */
export const VENDOR_FILES = {
  'xterm.js': { specifier: '@xterm/xterm/lib/xterm.js', type: 'text/javascript; charset=utf-8' },
  'xterm.css': { specifier: '@xterm/xterm/css/xterm.css', type: 'text/css; charset=utf-8' },
  'addon-fit.js': { specifier: '@xterm/addon-fit/lib/addon-fit.js', type: 'text/javascript; charset=utf-8' },
  'addon-search.js': { specifier: '@xterm/addon-search/lib/addon-search.js', type: 'text/javascript; charset=utf-8' },
  'addon-web-links.js': { specifier: '@xterm/addon-web-links/lib/addon-web-links.js', type: 'text/javascript; charset=utf-8' },
}

/** In-memory cache: these files never change while the process runs. */
const cache = new Map()

/** Load one vendored file, or undefined when the name is not on the list. */
export async function loadVendorFile(name) {
  const entry = VENDOR_FILES[name]
  if (entry === undefined) return undefined
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  let body
  try {
    body = await readFile(require.resolve(entry.specifier))
  } catch (error) {
    console.warn(`[dsh-plugin-otools-term] vendored ${name} unavailable:`, error?.message ?? error)
    return undefined
  }
  const record = {
    body,
    type: entry.type,
    etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
  }
  cache.set(name, record)
  return record
}

/** Whether every vendored asset is present (reported in `/state`). */
export async function vendorReady() {
  const missing = []
  for (const name of Object.keys(VENDOR_FILES)) {
    if ((await loadVendorFile(name)) === undefined) missing.push(name)
  }
  return { ready: missing.length === 0, missing }
}

/**
 * Serve one vendored file.
 *
 * Cached hard: the URL carries no version, but the ETag is the content hash and the
 * files only change when the package is reinstalled, at which point the hash moves.
 */
export async function serveVendor(req, res, name) {
  const record = await loadVendorFile(name)
  if (record === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (req.headers['if-none-match'] === record.etag) {
    res.writeHead(304, { etag: record.etag })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': record.type,
    'content-length': String(record.body.length),
    etag: record.etag,
    'cache-control': 'public, max-age=3600, must-revalidate',
  })
  res.end(record.body)
}
