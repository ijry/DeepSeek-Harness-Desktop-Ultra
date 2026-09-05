/**
 * Build lib/ from src/: the host half is copied verbatim (plain ESM, no
 * transform), and the browser half is wrapped into the DSH module-loader shape.
 * `npm run build` runs this, and `prepack` runs `npm run build`, so a published
 * tarball can never carry a stale lib/.
 *
 * @module dsh-plugin-mobile-bridge/scripts/build
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
console.log(`[build] lib/index.js + lib/host + lib/shared copied, ${clientOut} wrapped`)
