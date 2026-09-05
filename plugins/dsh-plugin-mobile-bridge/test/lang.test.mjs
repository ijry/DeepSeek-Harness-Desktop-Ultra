/**
 * The language contract, from both ends.
 *
 * The host half resolves a language from the environment and reports it in
 * `/admin/state`; the browser half cannot import that code, so it restates the
 * normalizer and carries its own string table. Both duplications are deliberate
 * (see src/client/index.js), and both are only safe if something checks them:
 * these tests run the two normalizers over the same spellings and hold the two
 * halves of the panel's dictionary to the same keys.
 *
 * @module dsh-plugin-mobile-bridge/test/lang
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { LANGS, hostLang, normalizeLang, pick } from '../lib/shared/lang.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Line endings are normalized because the checkout may be CRLF on Windows and
// the declarations below are lifted with multi-line patterns.
const source = (await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')).replace(/\r\n/g, '\n')

/** Evaluate one declaration lifted out of the client bundle. */
function lift(pattern, label) {
  const found = pattern.exec(source)
  assert.ok(found !== null, `the client must declare ${label}`)
  return runInNewContext(`(${found[1]})`)
}

const clientNormalizeLang = lift(
  /\n {2}(function normalizeLang\(value\) \{\n[\s\S]*?\n {2}\})\n/,
  'normalizeLang',
)
const STRINGS = lift(/\n {2}var STRINGS = (\{[\s\S]*?\n {2}\})\n/, 'STRINGS')

/** Spellings a locale variable, a language tag, or a browser can produce. */
const SPELLINGS = [
  'zh',
  'ZH',
  'zh-CN',
  'zh_CN.UTF-8',
  'zh-Hans-CN',
  ' en ',
  'en-US',
  'en_GB.UTF-8',
  'EN',
  'fr-FR',
  'C',
  'POSIX',
  'C.UTF-8',
  '',
  null,
  undefined,
]

test('the shipped languages are the two the tables cover', () => {
  assert.deepEqual(LANGS, ['zh', 'en'])
  assert.deepEqual(Object.keys(STRINGS), LANGS)
})

test('locale spellings normalize the way the shell does', () => {
  assert.equal(normalizeLang('zh'), 'zh')
  assert.equal(normalizeLang('zh_CN.UTF-8'), 'zh')
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('EN'), 'en')
  // An unrecognised locale is null rather than a language, so the caller can
  // fall through to the next candidate instead of guessing.
  assert.equal(normalizeLang('C.UTF-8'), null)
  assert.equal(normalizeLang('fr'), null)
  assert.equal(normalizeLang(''), null)
  assert.equal(normalizeLang(undefined), null)
})

test('the panel and the host agree on what a language tag means', () => {
  for (const value of SPELLINGS) {
    assert.equal(clientNormalizeLang(value), normalizeLang(value), `disagreement on ${JSON.stringify(value)}`)
  }
})

test('the host reads the shell first, the locale chain next, Chinese last', () => {
  const saved = { ...process.env }
  const clear = () => {
    for (const key of ['DSH_DESKTOP_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) delete process.env[key]
  }
  try {
    clear()
    assert.equal(hostLang(), 'zh', 'a bare environment is Chinese, not nothing')

    process.env.LANG = 'en_US.UTF-8'
    assert.equal(hostLang(), 'en')

    // An unrecognised value must not shadow the next candidate: a container with
    // LC_ALL=C still has to see the LANG behind it.
    process.env.LC_ALL = 'C'
    assert.equal(hostLang(), 'en')

    process.env.LC_MESSAGES = 'zh_CN.UTF-8'
    assert.equal(hostLang(), 'zh', 'LC_MESSAGES outranks LANG')

    process.env.DSH_DESKTOP_LANG = 'en'
    assert.equal(hostLang(), 'en', 'the shell outranks every locale variable')
    assert.equal(pick('中文', 'English'), 'English')

    process.env.DSH_DESKTOP_LANG = 'zh'
    assert.equal(pick('中文', 'English'), '中文')
  } finally {
    clear()
    Object.assign(process.env, saved)
  }
})

test('every panel string exists in both languages', () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.zh).sort())
  for (const key of Object.keys(STRINGS.zh)) {
    assert.equal(typeof STRINGS.zh[key], 'string', `${key} must be a string`)
    assert.notEqual(STRINGS.en[key], '', `${key} must have an English spelling`)
    // A placeholder in one language and not the other renders a sentence with a
    // number missing from it, which no test of the panel itself would notice.
    assert.equal(
      STRINGS.zh[key].includes('{}'),
      STRINGS.en[key].includes('{}'),
      `${key} disagrees on the {} placeholder`,
    )
  }
})

test('every key the panel asks for is in the table', () => {
  const used = [...source.matchAll(/\bt\('([A-Za-z0-9]+)'/g)].map((match) => match[1])
  assert.ok(used.length > 20, 'the panel reads its strings through t()')
  for (const key of new Set(used)) {
    assert.ok(key in STRINGS.zh, `t('${key}') has no entry in STRINGS`)
  }
})
