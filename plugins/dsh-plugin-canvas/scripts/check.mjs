/**
 * Verify the package: syntax-check every source file, rebuild lib/ from src/
 * (so generated output is never stale), then syntax-check every build output
 * including the wrapped client bundle. `npm run check` runs this script.
 *
 * @module dsh-plugin-canvas/scripts/check
 */
import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const JS = new Set(['.js', '.mjs', '.cjs'])

async function collect(dir) {
  const files = []
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry)
    const info = await stat(full)
    if (info.isDirectory()) files.push(...(await collect(full)))
    else if (JS.has(extname(full))) files.push(full)
  }
  return files.sort()
}

function syntax(file) {
  execFileSync(process.execPath, ['--check', resolve(file)], { stdio: 'ignore' })
}

async function tree(label, dir) {
  const files = await collect(dir)
  let failed = 0
  for (const file of files) {
    try {
      syntax(file)
    } catch (error) {
      failed += 1
      console.error(`[check] syntax FAIL ${file}`)
      const stderr = error.stderr !== undefined ? String(error.stderr) : ''
      if (stderr.length > 0) console.error(stderr.trim().split('\n').slice(-3).join('\n'))
    }
  }
  console.log(`[check] ${label}: ${files.length} file(s) - ${failed === 0 ? 'OK' : `FAILED (${failed})`}`)
  if (failed > 0) process.exitCode = 1
}

await tree('src', join(root, 'src'))
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' })
await tree('lib (built)', join(root, 'lib'))

if ((process.exitCode ?? 0) !== 0) process.exit(1)
