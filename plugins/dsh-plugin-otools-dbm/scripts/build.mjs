/**
 * Build the publishable lib/ directory:
 *   - copy src/index.js, src/host and src/shared verbatim (plain ESM that runs
 *     as-is in the published package)
 *   - generate lib/client.js from src/client/index.js via scripts/wrap-client
 *   - build the Vue panel with Vite into lib/webview (skippable)
 *
 * The webview step is the one thing this plugin has that its siblings do not: its UI
 * is the reference plugin's Vue app rather than a hand-written DOM bundle, so it
 * needs a real bundler. `--skip-webview` (or `DBM_SKIP_WEBVIEW=1`) leaves an
 * existing `lib/webview` alone, which is what `npm run check` uses — a syntax check
 * should not cost a 20-second Vite build.
 *
 * @module dsh-plugin-otools-dbm/scripts/build
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildClient } from './wrap-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const lib = join(root, 'lib')
const webviewOut = join(lib, 'webview')

const skipWebview = process.argv.includes('--skip-webview') || process.env.DBM_SKIP_WEBVIEW === '1'

/** Keep a previously built panel across a `lib/` wipe. */
const keep = join(root, '.webview-cache')
let hadWebview = false
if (skipWebview) {
  try {
    await stat(webviewOut)
    hadWebview = true
    await rm(keep, { recursive: true, force: true })
    await cp(webviewOut, keep, { recursive: true })
  } catch {
    hadWebview = false
  }
}

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await cp(join(src, 'index.js'), join(lib, 'index.js'))
for (const sub of ['host', 'shared']) {
  await cp(join(src, sub), join(lib, sub), { recursive: true })
}

const clientOut = await buildClient()
console.log('[build] lib/index.js, lib/host/*, lib/shared/* copied from src/')
console.log(`[build] wrapped ${clientOut}`)

if (skipWebview) {
  if (hadWebview) {
    await cp(keep, webviewOut, { recursive: true })
    console.log('[build] webview: reused the previous build (--skip-webview)')
  } else {
    console.log('[build] webview: SKIPPED and no previous build to reuse')
  }
  await rm(keep, { recursive: true, force: true })
} else {
  console.log('[build] webview: running vite build …')
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(root, 'webview', 'vite.config.ts')],
    { stdio: 'inherit', cwd: root },
  )
  console.log('[build] webview: lib/webview ready')
}
