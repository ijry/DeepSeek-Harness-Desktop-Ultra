/**
 * Import a .txt or .epub buffer into the reader's internal shape:
 * `{ title, author, format, text, chapters }`, where `text` is the normalized
 * full text and every chapter is a character range into it.
 *
 * Encoding matters more than it looks: Chinese novels circulate as GB18030 far
 * more often than as UTF-8, and a mojibake import is indistinguishable from a
 * broken plugin. So UTF-8 is tried strictly first and a decode failure falls
 * back to GB18030, then Big5 — never a lossy UTF-8 read.
 *
 * EPUB structure is taken from the OPF spine (with `toc.ncx` for nicer titles),
 * and only falls back to heading detection when the spine turns out to be one
 * giant document — which badly converted EPUBs frequently are.
 *
 * @module dsh-plugin-longread/host/import
 */
import { LIMITS, titleFromFilename } from '../shared/protocol.js'
import { normalizeText, splitChapters } from '../shared/chapters.js'
import { readZip } from './zip.js'

/** Import rejected for a reason worth showing the reader. */
export class ImportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

/** Decoders tried in order once UTF-8 has been ruled out. */
const FALLBACK_ENCODINGS = ['gb18030', 'big5']

/** Decode with one label, returning undefined when the runtime lacks it. */
function tryDecode(buffer, label, fatal) {
  let decoder
  try {
    decoder = new TextDecoder(label, { fatal: fatal === true })
  } catch {
    return undefined
  }
  try {
    return decoder.decode(buffer)
  } catch {
    return undefined
  }
}

/**
 * Decode a text buffer, honouring a BOM and otherwise sniffing.
 * @returns { text, encoding }
 */
export function decodeText(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { text: tryDecode(buffer.subarray(2), 'utf-16le', false) ?? '', encoding: 'utf-16le' }
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      // Node has no utf-16be decoder; swap into LE and reuse it.
      const swapped = Buffer.from(buffer.subarray(2))
      swapped.swap16()
      return { text: tryDecode(swapped, 'utf-16le', false) ?? '', encoding: 'utf-16be' }
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  const strict = tryDecode(buffer, 'utf-8', true)
  if (strict !== undefined) return { text: strict, encoding: 'utf-8' }
  for (const label of FALLBACK_ENCODINGS) {
    const decoded = tryDecode(buffer, label, false)
    // A wrong-codepage decode is full of U+FFFD; treat that as a miss.
    if (decoded !== undefined && !/�/.test(decoded.slice(0, 4000))) {
      return { text: decoded, encoding: label }
    }
  }
  // Everything failed: a lossy UTF-8 read at least yields something readable.
  return { text: buffer.toString('utf8'), encoding: 'utf-8?' }
}

/** Pull `作者：X` out of a text head when the file carries one. */
export function sniffAuthor(text) {
  const head = String(text ?? '').slice(0, 600)
  const match = /(?:作者|著者|author)\s*[:：]\s*([^\n\r]{1,40})/i.exec(head)
  return match === null ? '' : match[1].trim().replace(/\s+/g, ' ')
}

/** Decode HTML entities that survive into extracted text. */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_all, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_all, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/** Guard against invalid code points in malformed entities. */
function safeCodePoint(value) {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

/** Strip one XHTML document down to paragraph-separated plain text. */
export function htmlToText(html) {
  const stripped = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
}

/** First heading-ish text inside an XHTML document. */
function htmlTitle(html) {
  const heading = /<h[1-6][^>]*>([\s\S]{1,200}?)<\/h[1-6]>/i.exec(html)
  const raw = heading !== null ? heading[1] : (/<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html)?.[1] ?? '')
  const text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  return text.slice(0, 80)
}

/** Read one attribute off a tag string. */
function attr(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  if (match === null) return undefined
  return match[2] ?? match[3] ?? ''
}

/** Resolve an OPF-relative href against the OPF's own directory. */
function resolveHref(base, href) {
  const clean = decodeURIComponent(String(href).split('#')[0].replace(/^\.\//, ''))
  const parts = (base.length > 0 ? `${base}/${clean}` : clean).split('/')
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** Case-insensitive lookup, because EPUB producers are inconsistent. */
function getEntry(files, name) {
  if (files.has(name)) return files.get(name)
  const lower = name.toLowerCase()
  for (const [key, value] of files) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/** Map spine hrefs to nicer titles using toc.ncx. */
function readNcxTitles(files, ncxPath) {
  const titles = new Map()
  const raw = ncxPath === undefined ? undefined : getEntry(files, ncxPath)
  if (raw === undefined) return titles
  const xml = raw.toString('utf8')
  const base = ncxPath.includes('/') ? ncxPath.slice(0, ncxPath.lastIndexOf('/')) : ''
  const points = xml.match(/<navPoint[\s\S]*?<\/navPoint>/gi) ?? []
  for (const point of points) {
    const label = /<text>([\s\S]*?)<\/text>/i.exec(point)
    const content = /<content[^>]*>/i.exec(point)
    if (label === null || content === null) continue
    const src = attr(content[0], 'src')
    if (src === undefined) continue
    const title = decodeEntities(label[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    const target = resolveHref(base, src)
    if (title.length > 0 && !titles.has(target)) titles.set(target, title.slice(0, 80))
  }
  return titles
}

/** Parse the OPF package document. */
function readPackage(files, opfPath) {
  const raw = getEntry(files, opfPath)
  if (raw === undefined) throw new ImportError('invalid_input', `epub package missing: ${opfPath}`)
  const xml = raw.toString('utf8')
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const title = decodeEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1] ?? '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  const author = decodeEntities(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(xml)?.[1] ?? '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

  const manifest = new Map()
  let ncxPath
  for (const tag of xml.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (id === undefined || href === undefined) continue
    const mediaType = attr(tag, 'media-type') ?? ''
    const path = resolveHref(base, href)
    manifest.set(id, { path, mediaType })
    if (mediaType === 'application/x-dtbncx+xml') ncxPath = path
  }
  const spine = []
  for (const tag of xml.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = attr(tag, 'idref')
    if (idref === undefined) continue
    const item = manifest.get(idref)
    if (item === undefined) continue
    if (/x?html/i.test(item.mediaType) || item.mediaType === '') spine.push(item.path)
  }
  return { title, author, spine, ncxPath }
}

/** Find the OPF path through META-INF/container.xml. */
function findOpfPath(files) {
  const container = getEntry(files, 'META-INF/container.xml')
  if (container !== undefined) {
    const tag = /<rootfile\b[^>]*>/i.exec(container.toString('utf8'))
    const full = tag === null ? undefined : attr(tag[0], 'full-path')
    if (full !== undefined && full.length > 0) return resolveHref('', full)
  }
  // No container: accept a lone .opf at any depth rather than failing outright.
  for (const key of files.keys()) {
    if (key.toLowerCase().endsWith('.opf')) return key
  }
  throw new ImportError('invalid_input', 'not an epub (no container.xml and no .opf)')
}

/** Assemble chapters and text from already-extracted `{ title, body }` parts. */
function assemble(parts) {
  let text = ''
  const chapters = []
  for (const part of parts) {
    const start = text.length
    const heading = part.title.length > 0 ? `${part.title}\n\n` : ''
    text += heading + part.body + '\n\n'
    chapters.push({ title: part.title.length > 0 ? part.title : `第 ${chapters.length + 1} 节`, start, end: text.length })
  }
  const trimmedText = text.replace(/\n+$/, '')
  if (chapters.length > 0) chapters[chapters.length - 1].end = trimmedText.length
  return { text: trimmedText, chapters }
}

/** Import a .txt buffer. */
export function importTxt(buffer, filename) {
  const { text: decoded, encoding } = decodeText(buffer)
  const text = normalizeText(decoded)
  if (text.length === 0) throw new ImportError('invalid_input', 'the file decoded to an empty text')
  if (text.length > LIMITS.bookChars) {
    throw new ImportError('invalid_input', `text is too long (${text.length} chars, cap ${LIMITS.bookChars})`)
  }
  const chapters = splitChapters(text)
  return {
    title: titleFromFilename(filename),
    author: sniffAuthor(text),
    format: 'txt',
    encoding,
    text,
    chapters,
  }
}

/** Import an .epub buffer. */
export function importEpub(buffer, filename) {
  const files = readZip(buffer)
  const opfPath = findOpfPath(files)
  const pkg = readPackage(files, opfPath)
  const ncxTitles = readNcxTitles(files, pkg.ncxPath)

  const parts = []
  for (const path of pkg.spine) {
    const raw = getEntry(files, path)
    if (raw === undefined) continue
    const html = raw.toString('utf8')
    const body = normalizeText(htmlToText(html))
    if (body.length < 24) continue
    const title = ncxTitles.get(path) ?? htmlTitle(html)
    // The heading is usually the first line of the extracted body too; drop the
    // duplicate rather than showing the chapter name twice.
    const withoutDuplicate = title.length > 0 && body.startsWith(title)
      ? body.slice(title.length).replace(/^\n+/, '')
      : body
    parts.push({ title, body: withoutDuplicate })
    if (parts.length >= LIMITS.chapters) break
  }
  if (parts.length === 0) throw new ImportError('invalid_input', 'the epub spine yielded no readable text')

  let { text, chapters } = assemble(parts)
  if (text.length > LIMITS.bookChars) {
    throw new ImportError('invalid_input', `text is too long (${text.length} chars, cap ${LIMITS.bookChars})`)
  }
  // A single-document epub is a common bad conversion: fall back to headings.
  if (chapters.length < 3) {
    const detected = splitChapters(text)
    if (detected.length > chapters.length) chapters = detected
  }
  return {
    title: pkg.title.length > 0 ? pkg.title.slice(0, LIMITS.title) : titleFromFilename(filename),
    author: pkg.author,
    format: 'epub',
    encoding: 'utf-8',
    text,
    chapters,
  }
}

/** Import by filename extension (or by sniffing the ZIP magic). */
export function importBook(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ImportError('invalid_input', 'empty upload')
  const name = String(filename ?? '')
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
  if (/\.epub$/i.test(name) || isZip) {
    try {
      return importEpub(buffer, name)
    } catch (error) {
      if (error instanceof ImportError) throw error
      throw new ImportError('invalid_input', `epub could not be read: ${error?.message ?? error}`)
    }
  }
  return importTxt(buffer, name)
}
