/**
 * Build the publishable lib/ directory:
 *   - copy src/index.js, src/host and src/shared verbatim (plain ESM that
 *     runs as-is in the published package)
 *   - generate lib/client.js from src/client/index.js via scripts/wrap-client
 *
 * The browser source is intentionally not copied raw into lib/ — the only
 * browser artifact is the wrapped bundle the DSH loader consumes.
 *
 * @module dsh-plugin-longread/scripts/build
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from './wrap-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const lib = join(root, 'lib')

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await cp(join(src, 'index.js'), join(lib, 'index.js'))
for (const sub of ['host', 'shared']) {
  await cp(join(src, sub), join(lib, sub), { recursive: true })
}

const clientOut = await buildClient()
console.log('[build] lib/index.js, lib/host/*, lib/shared/* copied from src/')
console.log(`[build] wrapped ${clientOut}`)
