/**
 * Verify the package: syntax-check every source file, rebuild lib/ from src/ (so
 * generated output is never stale), then syntax-check every build output
 * including the wrapped client bundle. `npm run check` runs this script.
 *
 * The wrapped bundle is the check that matters most for the browser half: the
 * client fragments share one lexical scope, so a name declared twice across two
 * fragments is a syntax error there and nowhere else.
 *
 * @module dsh-plugin-otools-term/scripts/check
 */
import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
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

/**
 * Refuse raw control characters in source.
 *
 * This file writes escape sequences all over the place (`[33m` for a colour, a
 * NUL guard in a validator), and a literal control byte instead of the two-character
 * escape is invisible in every diff, review and grep — `node --check` accepts it
 * happily. One such byte already shipped as a bug once; now it fails the build.
 */
function controlBytes(file, source) {
  const found = []
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) {
      const line = source.slice(0, index).split('\n').length
      found.push(`${file}:${line} contains a raw control byte 0x${code.toString(16)} (write it as an escape)`)
    }
  }
  return found
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
      continue
    }
    const control = controlBytes(file, await readFile(file, 'utf8'))
    if (control.length > 0) {
      failed += 1
      for (const line of control.slice(0, 5)) console.error(`[check] ${line}`)
    }
  }
  console.log(`[check] ${label}: ${files.length} file(s) - ${failed === 0 ? 'OK' : `FAILED (${failed})`}`)
  if (failed > 0) process.exitCode = 1
}

await tree('src', join(root, 'src'))
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' })
await tree('lib (built)', join(root, 'lib'))

if ((process.exitCode ?? 0) !== 0) process.exit(1)
