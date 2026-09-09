import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const PLUGIN_ID = 'dsh-plugin-otools-socket'

function inline(source) {
  return String(source)
    .replace(/^import[^\n]+from '[^']+'\r?\n/gm, '')
    .replace(/^export (?=(async function|const|function|class|let|var) )/gm, '')
    .replace(/\s+$/, '')
}

export function wrapClient(busClient, entry) {
  const body = inline(busClient) + '\n\n' + inline(entry)
  return 'window.__ModuleLoader__.load({\n' +
    "  id: '" + PLUGIN_ID + "',\n" +
    '  factory: (require) => {\n' +
    '    var module = { exports: {} };\n' +
    body + '\n' +
    '    module.exports = { name, inject, apply };\n' +
    '    return module.exports;\n' +
    '  }\n' +
    '});\n'
}

export async function buildClient() {
  const busClient = await readFile(join(root, 'src', 'client', 'bus-client.js'), 'utf8')
  const entry = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')
  const bundle = wrapClient(busClient, entry)
  new Script(bundle, { filename: 'lib/client.js' })
  const out = join(root, 'lib', 'client.js')
  await writeFile(out, bundle, 'utf8')
  return out
}
