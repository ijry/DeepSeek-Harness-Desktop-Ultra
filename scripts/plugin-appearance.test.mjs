import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const plugins = new URL('../plugins/', import.meta.url)
const icons = [
  ['dsh-plugin-taskboard', 'index.js', '.dsh-cgtb-entry', '.dsh-cgtb-entry-icon'],
  ['dsh-plugin-canvas', 'styles.js', '.dshc-entry', '.dshc-entry-icon'],
  ['dsh-plugin-longread', 'index.js', '.dsh-lr-entry', '.dsh-lr-entry-icon'],
  ['dsh-plugin-repopanel', 'index.js', '.dsh-rp-entry', '.dsh-rp-entry-icon'],
  ['dsh-plugin-automation', 'index.js', '.dsh-au-entry', '.dsh-au-entry-icon'],
  ['dsh-plugin-otools-git', 'styles.js', '.dsh-og-entry', '.dsh-og-entry-icon'],
  ['dsh-plugin-otools-term', 'styles.js', '.dsh-ot-entry', '.dsh-ot-entry-icon'],
  ['dsh-plugin-otools-dbm', 'index.js', '.dsh-dbm-entry', '.dsh-dbm-entry-icon'],
  ['dsh-plugin-mobile-bridge', 'index.js', '.mbridge__entry', '.mbridge__entryIcon'],
]

for (const [plugin, file, entry, icon] of icons) {
  test(`${plugin} has neutral resting icons and colored hover/focus icons`, async () => {
    const source = await readFile(new URL(`${plugin}/src/client/${file}`, plugins), 'utf8')
    const rule = source.slice(source.indexOf(icon + ' {') >= 0
      ? source.indexOf(icon + ' {') : source.indexOf(icon + '{')).split('}')[0]
    assert.match(rule, /filter:\s*grayscale\(1\)/)
    assert.ok(source.includes(`${entry}:hover ${icon}`))
    assert.ok(source.includes(`${entry}:focus-visible ${icon}`))
  })
}

test('database platform translations cover every shared control', async () => {
  const base = new URL('dsh-plugin-otools-dbm/webview/src/platform/', plugins)
  const files = await readdir(new URL('ui/common/', base), { recursive: true })
  const components = await Promise.all(files.filter((file) => /\.(vue|ts)$/.test(file))
    .map((file) => readFile(new URL('ui/common/' + file.replace(/\\/g, '/'), base), 'utf8')))
  const component = components.join('\n')
  for (const locale of ['zh-CN', 'en-US']) {
    const messages = JSON.parse(await readFile(new URL(`i18n/locales/${locale}.json`, base), 'utf8'))
    for (const [, key] of component.matchAll(/t\('(platform\.[^']+)'/g)) {
      assert.ok(messages[key], `${locale} is missing ${key}`)
    }
  }
})

test('database connection header owns spacing without utility CSS', async () => {
  const source = await readFile(new URL('dsh-plugin-otools-dbm/webview/src/DbConnectionList.vue', plugins), 'utf8')
  assert.match(source, /\.list-header\s*\{[^}]*padding:\s*16px 14px/)
  assert.match(source, /\.list-title\s*\{[^}]*margin:\s*0/)
  assert.match(source, /:aria-label="t\('add'\)"/)
})

test('mobile panel controls use DSH theme colors in light and dark modes', async () => {
  const source = await readFile(new URL('dsh-plugin-mobile-bridge/src/client/index.js', plugins), 'utf8')
  for (const selector of ['.mbridge__button{', '.mbridge__input{']) {
    const rule = source.slice(source.indexOf(selector)).split('}')[0]
    assert.ok(rule.includes('--dsw-alias-label-primary'), `${selector} must not fall back to light text on white`)
  }
})

test('database form labels wrap within the row and the drawer stays usable on narrow screens', async () => {
  const base = new URL('dsh-plugin-otools-dbm/webview/src/', plugins)
  const form = await readFile(new URL('DbConnectionForm.vue', base), 'utf8')
  assert.match(form, /:deep\(\.el-form-item__label\)\s*\{[^}]*height:\s*auto/)
  const layout = await readFile(new URL('Dbm.vue', base), 'utf8')
  assert.match(layout, /min\(100%, max\(640px,/)
})
