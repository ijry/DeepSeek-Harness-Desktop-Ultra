/**
 * Verify the package: syntax-check every source file, rebuild lib/ from src/ (so
 * generated output is never stale), then syntax-check every build output including
 * the wrapped client bundle. `npm run check` runs this script.
 *
 * The webview build is skipped here on purpose — it is a 20-second Vite run whose
 * output `node --check` cannot read anyway (it is a browser bundle, not ESM the CLI
 * parses). `npm run build` is what produces it.
 *
 * @module dsh-plugin-otools-dbm/scripts/check
 */
import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const JS = new Set(['.js', '.mjs', '.cjs'])
/** The built panel is a browser bundle; checking it as ESM proves nothing. */
const SKIP_DIRS = new Set(['webview', 'node_modules'])

async function collect(dir) {
  const files = []
  for (const entry of await readdir(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue
    }
    const full = join(dir, entry)
    const info = await stat(full)
    if (info.isDirectory()) {
      files.push(...(await collect(full)))
    } else if (JS.has(extname(full))) {
      files.push(full)
    }
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
      if (stderr.length > 0) {
        console.error(stderr.trim().split('\n').slice(-3).join('\n'))
      }
    }
  }
  console.log(`[check] ${label}: ${files.length} file(s) - ${failed === 0 ? 'OK' : `FAILED (${failed})`}`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

await tree('src', join(root, 'src'))
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--skip-webview'], { stdio: 'inherit' })
await tree('lib (built)', join(root, 'lib'))

if ((process.exitCode ?? 0) !== 0) {
  process.exit(1)
}
