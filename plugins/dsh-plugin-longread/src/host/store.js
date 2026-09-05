/**
 * The library: one JSON ledger under the DSH home for metadata (books, chapter
 * ranges, per-book progress, reader settings) plus one plain .txt per book in a
 * sibling directory.
 *
 * Splitting text out of the ledger is the whole design: a book is megabytes and
 * the ledger is read on every list request, so keeping prose in JSON would mean
 * parsing a novel to draw a menu. Chapter ranges live in the ledger; the text
 * file is opened only when a chapter is actually read.
 *
 * Mutations run through a serial queue and are persisted with a temp-file
 * rename. Corruption on load is quarantined, never fatal.
 *
 * @module dsh-plugin-longread/host/store
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  LIBRARY_SCHEMA_VERSION,
  emptyLibrary,
  isPlausibleBookRecord,
  sanitizeProgress,
  sanitizeSettings,
  summarizeBook,
} from '../shared/protocol.js'

/** Persist atomically: write a temp file beside the target, then rename over it. */
async function persistAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/** Deep-freeze a clone so handed-out snapshots can never mutate internal state. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** The library store. */
export class LibraryStore {
  /** @param options - { file: string, textDir: string } */
  constructor(options) {
    this.file = options.file
    this.textDir = options.textDir
    this.ledger = emptyLibrary()
    this.queue = Promise.resolve()
    this.loaded = false
    /** bookId -> text, so re-reading a chapter does not re-read the file. */
    this.textCache = new Map()
    /** How many book texts stay resident. */
    this.textCacheLimit = 2
  }

  /** Load (once) from disk; missing file starts empty; corrupt file quarantined. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return
      console.warn('[dsh-plugin-longread] library unreadable:', error.message)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.books)) {
      console.warn('[dsh-plugin-longread] quarantining corrupt library')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return
    }
    const books = []
    for (const entry of parsed.books) {
      if (!isPlausibleBookRecord(entry)) {
        console.warn('[dsh-plugin-longread] dropping implausible library entry:', entry?.id)
        continue
      }
      books.push(entry)
    }
    const known = new Set(books.map((book) => book.id))
    const progress = {}
    const rawProgress = typeof parsed.progress === 'object' && parsed.progress !== null ? parsed.progress : {}
    for (const [id, value] of Object.entries(rawProgress)) {
      // Progress for a deleted book is dead weight; drop it on load.
      if (!known.has(id)) continue
      progress[id] = sanitizeProgress(value, books.find((book) => book.id === id))
    }
    this.ledger = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      seeded: parsed.seeded === true,
      books,
      progress,
      settings: sanitizeSettings(parsed.settings, undefined),
    }
  }

  /** The list-view snapshot: metadata only, never prose. */
  snapshot() {
    return deepFreeze({
      schemaVersion: this.ledger.schemaVersion,
      revision: this.ledger.revision,
      settings: { ...this.ledger.settings },
      books: this.ledger.books.map((book) => summarizeBook(book)),
      progress: structuredClone(this.ledger.progress),
    })
  }

  /** One book's metadata (deep-frozen clone), or undefined. */
  get(id) {
    const book = this.ledger.books.find((entry) => entry.id === id)
    return book === undefined ? undefined : deepFreeze(structuredClone(book))
  }

  /** The current settings (frozen clone). */
  get settings() {
    return deepFreeze({ ...this.ledger.settings })
  }

  /** Whether the bundled sample has already been seeded once. */
  get seeded() {
    return this.ledger.seeded === true
  }

  /** Where one book's text lives. */
  textPath(id) {
    return join(this.textDir, `${id}.txt`)
  }

  /** Read one book's full text, memoized. */
  async text(id) {
    const cached = this.textCache.get(id)
    if (cached !== undefined) return cached
    let content
    try {
      content = await readFile(this.textPath(id), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    // Small LRU-ish bound: a book is megabytes, and the reader only ever has
    // one open. Evict in insertion order.
    if (this.textCache.size >= this.textCacheLimit) {
      const oldest = this.textCache.keys().next().value
      if (oldest !== undefined) this.textCache.delete(oldest)
    }
    this.textCache.set(id, content)
    return content
  }

  /** Read one chapter's text by index. */
  async chapterText(id, chapterIndex) {
    const book = this.ledger.books.find((entry) => entry.id === id)
    if (book === undefined) return undefined
    const chapter = book.chapters[chapterIndex]
    if (chapter === undefined) return undefined
    const text = await this.text(id)
    if (text === undefined) return undefined
    return text.slice(chapter.start, chapter.end)
  }

  /**
   * Run one mutation inside the serial queue. The mutator receives a structured
   * clone of the ledger; returning `true` commits, `undefined`/`false` aborts
   * with no write. Text files are written by the caller through `writeText`
   * before the ledger row that references them is committed.
   */
  async mutate(mutator) {
    const run = async () => {
      await this.load()
      const draft = structuredClone(this.ledger)
      const committed = await mutator(draft)
      if (committed !== true) return { committed: false, snapshot: this.snapshot() }
      draft.revision += 1
      draft.schemaVersion = LIBRARY_SCHEMA_VERSION
      this.ledger = draft
      try {
        await persistAtomic(this.file, JSON.stringify(this.ledger, null, 2))
      } catch (error) {
        console.warn('[dsh-plugin-longread] library write failed:', error.message)
      }
      return { committed: true, snapshot: this.snapshot() }
    }
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Write one book's text file (before its ledger row is committed). */
  async writeText(id, text) {
    await persistAtomic(this.textPath(id), text)
    this.textCache.delete(id)
  }

  /** Remove one book's text file; a missing file is not an error. */
  async removeText(id) {
    this.textCache.delete(id)
    try {
      await rm(this.textPath(id), { force: true })
    } catch (error) {
      console.warn('[dsh-plugin-longread] could not remove book text:', error.message)
    }
  }

  /** The current revision (for diagnostics). */
  get revision() {
    return this.ledger.revision
  }
}
