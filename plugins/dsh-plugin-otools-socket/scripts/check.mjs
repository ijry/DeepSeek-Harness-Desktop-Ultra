import { execFileSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
async function files(dir) {
  const rows = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path)
    if (info.isDirectory()) rows.push(...await files(path))
    else if (['.js', '.mjs'].includes(extname(path))) rows.push(path)
  }
  return rows
}
for (const file of await files(join(root, 'src'))) execFileSync(process.execPath, ['--check', file])
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' })
for (const file of await files(join(root, 'lib'))) execFileSync(process.execPath, ['--check', file])
console.log('[check] source and generated syntax OK')
