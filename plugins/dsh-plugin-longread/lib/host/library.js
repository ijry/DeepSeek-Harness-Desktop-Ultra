/**
 * Library operations: add, delete, progress, settings, and seeding the bundled
 * sample. Split out of the routes so every rule is reachable from a test without
 * an HTTP server, and so the store stays a dumb persistence layer.
 *
 * @module dsh-plugin-longread/host/library
 */
import { LIMITS, newBookId, normalizeTitle, sanitizeProgress, sanitizeSettings, summarizeBook } from '../shared/protocol.js'
import { normalizeText, splitChapters } from '../shared/chapters.js'
import { ImportError, importBook } from './import.js'
import { SAMPLE_AUTHOR, SAMPLE_TEXT, SAMPLE_TITLE } from './sample.js'

/** Add one uploaded file to the library. */
export async function addBook(store, options) {
  const { buffer, filename } = options
  const now = options.now ?? (() => Date.now())
  await store.load()
  if (store.snapshot().books.length >= LIMITS.books) {
    throw new ImportError('invalid_input', `library is full (${LIMITS.books} books)`)
  }
  const imported = importBook(buffer, filename)
  if (imported.chapters.length === 0) throw new ImportError('invalid_input', 'no chapters were detected')

  const stamp = now()
  const id = newBookId(Math.random, stamp)
  const record = {
    id,
    title: normalizeTitle(imported.title, '未命名'),
    author: imported.author ?? '',
    format: imported.format,
    encoding: imported.encoding ?? 'utf-8',
    chars: imported.text.length,
    builtin: false,
    source: { name: String(filename ?? ''), bytes: buffer.length },
    addedAt: stamp,
    updatedAt: stamp,
    chapters: imported.chapters,
  }
  // Text first: a ledger row pointing at a missing file would render an empty
  // book, while an orphan text file is merely wasted disk.
  await store.writeText(id, imported.text)
  await store.mutate((draft) => {
    draft.books.push(record)
    return true
  })
  return summarizeBook(record)
}

/** Remove one book and its text. Returns false when the id is unknown. */
export async function deleteBook(store, id) {
  await store.load()
  let found = false
  await store.mutate((draft) => {
    const index = draft.books.findIndex((book) => book.id === id)
    if (index === -1) return false
    draft.books.splice(index, 1)
    delete draft.progress[id]
    found = true
    return true
  })
  if (found) await store.removeText(id)
  return found
}

/** Record where the reader stopped. */
export async function setProgress(store, options) {
  const now = options.now ?? (() => Date.now())
  await store.load()
  const book = store.get(options.bookId)
  if (book === undefined) return undefined
  const next = sanitizeProgress(
    { chapterIndex: options.chapterIndex, turnIndex: options.turnIndex, updatedAt: now() },
    book,
  )
  await store.mutate((draft) => {
    draft.progress[options.bookId] = next
    return true
  })
  return next
}

/** Merge a settings patch. */
export async function updateSettings(store, patch) {
  await store.load()
  let next
  await store.mutate((draft) => {
    next = sanitizeSettings(patch, draft.settings)
    draft.settings = next
    return true
  })
  return next ?? store.settings
}

/**
 * Seed the bundled sample novel once. Idempotent, and a reader who deletes it
 * does not get it back: the ledger remembers that seeding already happened.
 */
export async function seedSample(store, options) {
  const now = options?.now ?? (() => Date.now())
  await store.load()
  if (store.seeded) return undefined
  const text = normalizeText(SAMPLE_TEXT)
  const chapters = splitChapters(text)
  const stamp = now()
  const id = 'bk_sample_jiuyin'
  const record = {
    id,
    title: SAMPLE_TITLE,
    author: SAMPLE_AUTHOR,
    format: 'txt',
    encoding: 'utf-8',
    chars: text.length,
    builtin: true,
    source: { name: '内置示例', bytes: Buffer.byteLength(text, 'utf8') },
    addedAt: stamp,
    updatedAt: stamp,
    chapters,
  }
  await store.writeText(id, text)
  const result = await store.mutate((draft) => {
    if (draft.seeded === true) return false
    draft.seeded = true
    if (!draft.books.some((book) => book.id === id)) draft.books.unshift(record)
    return true
  })
  return result.committed ? summarizeBook(record) : undefined
}
