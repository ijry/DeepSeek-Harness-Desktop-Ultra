/**
 * 导入链上的两件事最容易悄悄坏掉：编码猜错（中文 txt 有一半是 GB18030，猜错就是
 * 满屏乱码，而不是报错），以及 EPUB 的 spine 顺序（顺序错了就是章节乱序）。
 * 这里用手搓的 zip 做真实 EPUB 夹具，不引任何依赖。
 *
 * @module dsh-plugin-longread/test/import
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { ZipError, readZip } from '../src/host/zip.js'
import {
  ImportError,
  decodeText,
  htmlToText,
  importBook,
  importEpub,
  importTxt,
  sniffAuthor,
} from '../src/host/import.js'

/**
 * Minimal ZIP writer for fixtures. CRCs are left at zero on purpose: the reader
 * under test does not verify them, and a hand-rolled CRC in a test only tests
 * itself.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data, 'utf8')
    const stored = entry.stored === true
    const body = stored ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

const CONTAINER = '<?xml version="1.0"?><container><rootfiles>'
  + '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
  + '</rootfiles></container>'

function opf(items) {
  return '<?xml version="1.0"?><package><metadata>'
    + '<dc:title>九阴真经</dc:title><dc:creator>佚名</dc:creator></metadata><manifest>'
    + '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    + items.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`).join('')
    + '</manifest><spine toc="ncx">'
    + items.map((item) => `<itemref idref="${item.id}"/>`).join('')
    + '</spine></package>'
}

function ncx(points) {
  return '<?xml version="1.0"?><ncx><navMap>'
    + points.map((point) => `<navPoint><navLabel><text>${point.title}</text></navLabel>`
      + `<content src="${point.href}"/></navPoint>`).join('')
    + '</navMap></ncx>'
}

function page(title, body) {
  return `<?xml version="1.0"?><html><head><title>${title}</title>`
    + '<style>p{color:red}</style></head><body>'
    + `<h1>${title}</h1><p>${body}</p><p>第二段 &amp; 实体&nbsp;空格。</p>`
    + '<script>alert(1)</script></body></html>'
}

test('UTF-8 优先严格解码，BOM 三种都认，GB18030 是兜底而不是首选', () => {
  assert.deepEqual(decodeText(Buffer.from('中文', 'utf8')), { text: '中文', encoding: 'utf-8' })
  assert.deepEqual(
    decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')])),
    { text: '中文', encoding: 'utf-8' },
  )
  assert.deepEqual(
    decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')])),
    { text: '中文', encoding: 'utf-16le' },
  )
  const be = Buffer.from('中文', 'utf16le')
  be.swap16()
  assert.deepEqual(
    decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])),
    { text: '中文', encoding: 'utf-16be' },
  )
  // 「中文」的 GBK 字节：严格 UTF-8 会失败，于是落到 gb18030。
  assert.deepEqual(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), { text: '中文', encoding: 'gb18030' })
})

test('作者行认得出来', () => {
  assert.equal(sniffAuthor('九阴真经\n作者：佚名\n\n第一章'), '佚名')
  assert.equal(sniffAuthor('Author: Nobody\n'), 'Nobody')
  assert.equal(sniffAuthor('没有作者行'), '')
})

test('htmlToText 去掉 head/script/style、把块级标签变成段落、解实体', () => {
  const text = htmlToText(page('第一章 甲', '正文<em>强调</em>'))
  assert.ok(!text.includes('alert(1)'), 'script 必须没了')
  assert.ok(!text.includes('color:red'), 'style 必须没了')
  assert.ok(text.includes('正文强调'))
  assert.ok(text.includes('第二段 & 实体 空格。'))
})

test('importTxt 从文件名取标题（去掉站点噪音），按标题切章', () => {
  const raw = '九阴真经\n作者：佚名\n\n第一章 甲\n\n正文一。\n\n第二章 乙\n\n正文二。\n'
  const book = importTxt(Buffer.from(raw, 'utf8'), '【某站】九阴真经_全本.txt')
  assert.equal(book.title, '九阴真经 全本')
  assert.equal(book.author, '佚名')
  assert.equal(book.format, 'txt')
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), ['第一章 甲', '第二章 乙'])
  assert.equal(book.chapters[book.chapters.length - 1].end, book.text.length)
})

test('空文件被拒，且拒得有话可说', () => {
  assert.throws(() => importTxt(Buffer.from('   ', 'utf8'), 'a.txt'), (error) => {
    assert.ok(error instanceof ImportError)
    assert.equal(error.code, 'invalid_input')
    return true
  })
})

const EPUB_ITEMS = [
  { id: 'c1', href: 'c1.xhtml' },
  { id: 'c2', href: 'c2.xhtml' },
  { id: 'c3', href: 'c3.xhtml' },
]

function makeEpub() {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', stored: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf(EPUB_ITEMS) },
    {
      name: 'OEBPS/toc.ncx',
      data: ncx([
        { title: '雪夜抄经', href: 'c1.xhtml' },
        { title: '药铺的第九味', href: 'c2.xhtml#top' },
      ]),
    },
    { name: 'OEBPS/c1.xhtml', data: page('第一章 甲', '甲的正文，长度足够。') },
    { name: 'OEBPS/c2.xhtml', data: page('第二章 乙', '乙的正文，长度足够。') },
    { name: 'OEBPS/c3.xhtml', data: page('第三章 丙', '丙的正文，长度足够。') },
  ])
}

test('EPUB 按 spine 顺序取章，ncx 的标题优先，缺的用文档标题兜底', () => {
  const book = importEpub(makeEpub(), 'x.epub')
  assert.equal(book.title, '九阴真经')
  assert.equal(book.author, '佚名')
  assert.equal(book.format, 'epub')
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), ['雪夜抄经', '药铺的第九味', '第三章 丙'])
  assert.equal(book.chapters[0].start, 0)
  for (let i = 1; i < book.chapters.length; i++) {
    assert.equal(book.chapters[i].start, book.chapters[i - 1].end)
  }
  assert.equal(book.chapters[book.chapters.length - 1].end, book.text.length)
  assert.ok(book.text.includes('甲的正文'))
  assert.ok(book.text.indexOf('甲的正文') < book.text.indexOf('丙的正文'), 'spine 顺序不能乱')
  // 标题在正文里只出现一次：h1 提出来当章名后，正文首行的重复要被去掉。
  assert.equal(book.text.split('雪夜抄经').length - 1, 1)
})

test('整本塞成一个文档的坏 EPUB 退回按标题切章', () => {
  const single = [{ id: 'all', href: 'all.xhtml' }]
  const body = ['第一章 甲', '甲正文。', '第二章 乙', '乙正文。', '第三章 丙', '丙正文。', '第四章 丁', '丁正文。']
    .map((line) => `<p>${line}</p>`).join('')
  const epub = makeZip([
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf(single) },
    { name: 'OEBPS/all.xhtml', data: `<html><body>${body}</body></html>` },
  ])
  const book = importEpub(epub, 'one.epub')
  assert.deepEqual(book.chapters.map((chapter) => chapter.title),
    ['第一章 甲', '第二章 乙', '第三章 丙', '第四章 丁'])
})

test('importBook 按 zip 魔数分派，扩展名骗不了它', () => {
  const book = importBook(makeEpub(), 'mislabelled.txt')
  assert.equal(book.format, 'epub')
  assert.equal(importBook(Buffer.from('第一章 甲\n\n正文。', 'utf8'), 'a.txt').format, 'txt')
})

test('坏 zip 报 ZipError，坏 epub 报 ImportError', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all........')), ZipError)
  assert.throws(() => readZip(Buffer.alloc(0)), ZipError)
  const noContainer = makeZip([{ name: 'a.txt', data: 'hi' }])
  assert.throws(() => importEpub(noContainer, 'x.epub'), ImportError)
})

test('stored（method 0）与 deflate（method 8）都读得出来', () => {
  const files = readZip(makeZip([
    { name: 'stored.txt', data: '原样存放', stored: true },
    { name: 'deflated.txt', data: '压缩存放'.repeat(20) },
  ]))
  assert.equal(files.get('stored.txt').toString('utf8'), '原样存放')
  assert.equal(files.get('deflated.txt').toString('utf8'), '压缩存放'.repeat(20))
})
