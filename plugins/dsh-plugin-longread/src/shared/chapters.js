/**
 * Text normalization and chapter detection — the part of an import that is pure
 * string work, kept away from the decoding/zip layers so it can be tested with
 * plain string fixtures.
 *
 * Chapter detection targets the two shapes real files come in: Chinese novels
 * dumped as one .txt with `第N章` headings, and EPUBs where each spine item is
 * already a chapter. A file with no headings at all still has to be readable, so
 * it falls back to fixed-size sections.
 *
 * Invisible characters (BOM, zero-width joiners) are written as \u escapes
 * on purpose — a literal zero-width space in a character class is unreviewable.
 * Visible CJK is written as itself: a hand-typed escape for it is how you end up
 * matching 樚子 instead of 楔子.
 *
 * @module dsh-plugin-longread/shared/chapters
 */
import { LIMITS } from './protocol.js'

/** Longest line still eligible to be a heading. */
const MAX_HEADING_CHARS = 40

/** Characters that mark a line as prose rather than a heading. */
const PROSE_MARKS = /[。！？；…]|["“”]/

/** Chinese and Arabic numerals a chapter number can be built from. */
const NUMERALS = '零一二三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾两廿卅0-9０-９'

/** `第一章`, `第 12 回`, `第五十节` … */
const NUMBERED_HEADING = new RegExp(`^第\\s*[${NUMERALS}]{1,12}\\s*[章回节節卷篇折幕集话話]`)

/** `卷三`, `篇二`, `部一` — the marker-first form that carries no leading 第. */
const MARKER_HEADING = new RegExp(`^[卷篇部]\\s*[${NUMERALS}]{1,12}(?:[\\s：:·—-]|$)`)

/** Structural headings that carry no number at all. */
const NAMED_HEADING =
  /^(?:序章|序言|序|自序|楔子|前言|引子|引言|开篇|尾声|终章|終章|后记|後記|番外|附录|附錄)(?:[\s：:·—-]|$)/

/** `Chapter 3`, `CHAPTER IV`, `Part 2` … */
const LATIN_HEADING = /^(?:chapter|chap\.?|part|book|section)\s+(?:\d{1,4}|[ivxlcdm]{1,7})\b/i

/** Target size of a synthetic section when a file has no headings at all. */
const FALLBACK_SECTION_CHARS = 2400

/**
 * Normalize raw decoded text: unify line endings, drop the BOM and zero-width
 * junk EPUB/HTML conversions leave behind, trim trailing spaces, and collapse
 * runs of blank lines to one. Character offsets in a BookRecord index into the
 * output of this function.
 */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    // Zero-width space / ZWNJ / ZWJ / word joiner / stray BOMs mid-file.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // Non-breaking space -> plain space, so the indent trim below catches it.
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Whether one line looks like a chapter heading. */
export function isHeadingLine(line) {
  const text = String(line ?? '').trim()
  if (text.length === 0 || text.length > MAX_HEADING_CHARS) return false
  if (PROSE_MARKS.test(text)) return false
  // A heading may carry one separating comma at most ("第一章 风雪，归途").
  if ((text.match(/[\uff0c,]/g) ?? []).length > 1) return false
  return NUMBERED_HEADING.test(text) || MARKER_HEADING.test(text) ||
    NAMED_HEADING.test(text) || LATIN_HEADING.test(text)
}

/** Split normalized text into `{ title, start, end }` chapters. */
export function splitChapters(text) {
  const body = String(text ?? '')
  if (body.trim().length === 0) return []
  const heads = []
  let cursor = 0
  while (cursor <= body.length) {
    const lineEnd = body.indexOf('\n', cursor)
    const stop = lineEnd === -1 ? body.length : lineEnd
    if (isHeadingLine(body.slice(cursor, stop))) {
      heads.push({ start: cursor, titleEnd: stop })
      if (heads.length >= LIMITS.chapters) break
    }
    if (lineEnd === -1) break
    cursor = lineEnd + 1
  }
  if (heads.length === 0) return sectionize(body)

  const chapters = []
  // Text before the first heading is a front-matter chapter when it is
  // substantial; a stray line or two is dropped as noise.
  const preface = body.slice(0, heads[0].start)
  if (preface.trim().length >= 80) {
    chapters.push({ title: '卷首', start: 0, end: heads[0].start })
  }
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1].start : body.length
    chapters.push({
      title: body.slice(head.start, head.titleEnd).trim(),
      start: head.start,
      end,
    })
  }
  return chapters
}

/** Cut heading-less text into `第 N 节` sections at paragraph boundaries. */
export function sectionize(body) {
  const sections = []
  const label = (n) => `第 ${n} 节`
  let start = 0
  while (start < body.length) {
    if (sections.length + 1 >= LIMITS.chapters || start + FALLBACK_SECTION_CHARS >= body.length) {
      sections.push({ title: label(sections.length + 1), start, end: body.length })
      break
    }
    let stop = body.indexOf('\n\n', start + FALLBACK_SECTION_CHARS)
    if (stop === -1 || stop - start > FALLBACK_SECTION_CHARS * 3) {
      stop = start + FALLBACK_SECTION_CHARS
      // Prefer a sentence boundary over cutting mid-sentence.
      const punct = body.lastIndexOf('。', stop)
      if (punct > start + FALLBACK_SECTION_CHARS / 2) stop = punct + 1
    } else {
      stop += 1
    }
    sections.push({ title: label(sections.length + 1), start, end: stop })
    start = stop
  }
  if (sections.length === 0) sections.push({ title: '全文', start: 0, end: body.length })
  return sections
}

/**
 * Split one chapter's text into display paragraphs, dropping the heading line
 * (the UI shows it as the turn header instead) and any leading indentation.
 */
export function paragraphsOf(chapterText, options) {
  const dropHeading = options === undefined || options.dropHeading !== false
  const lines = String(chapterText ?? '').split('\n')
  if (dropHeading && lines.length > 0 && isHeadingLine(lines[0])) lines.shift()
  const paragraphs = []
  let buffer = []
  const flush = () => {
    if (buffer.length === 0) return
    const joined = buffer.join('').trim()
    if (joined.length > 0) paragraphs.push(joined)
    buffer = []
  }
  for (const line of lines) {
    const trimmed = line.replace(/^[ \t\u3000]+/, '').replace(/\s+$/, '')
    if (trimmed.length === 0) flush()
    else buffer.push(trimmed)
  }
  flush()
  return paragraphs
}
