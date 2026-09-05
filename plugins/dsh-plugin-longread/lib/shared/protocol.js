/**
 * Shared vocabulary for dsh-plugin-longread: the library ledger shape, the
 * reader settings, and the pure validators both the store and the routes use.
 *
 * "Shared" here means host-internal (store + routes + tests). The browser
 * bundle is a standalone file that cannot import anything, so it never reads
 * this module — which is exactly why the turn planning lives on the host and
 * ships to the client as JSON: one implementation, one test suite.
 *
 * @module dsh-plugin-longread/shared/protocol
 */

/** Ledger schema version; bumped when a migration becomes necessary. */
export const LIBRARY_SCHEMA_VERSION = 1

/** Accepted import formats. */
export const FORMATS = ['txt', 'epub']

/** Camouflage personas — which fake work the transcript pretends to be doing. */
export const PERSONAS = ['refactor', 'debug', 'review', 'docs']

/** How many fake tool calls the planner sprinkles between prose turns. */
export const TOOL_DENSITIES = ['off', 'low', 'medium', 'high']

/** Hard caps. A local HTTP surface with no cap is an OOM vector. */
export const LIMITS = {
  /** Max decoded book size (characters). ~2.5M chars covers a long web novel. */
  bookChars: 2_500_000,
  /** Max chapters kept per book. */
  chapters: 4000,
  /** Max books in the library. */
  books: 200,
  /** Max title length. */
  title: 200,
}

/** An empty library ledger. */
export function emptyLibrary() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: 0,
    /** Whether the bundled sample was ever seeded (so deleting it stays deleted). */
    seeded: false,
    books: [],
    /** bookId -> { chapterIndex, turnIndex, updatedAt } */
    progress: {},
    settings: defaultSettings(),
  }
}

/** The shipped reader defaults. */
export function defaultSettings() {
  return {
    /** Typewriter speed in characters per second. */
    speed: 36,
    /** Target characters per fake agent turn. */
    turnChars: 420,
    /** Fake tool-call density. */
    toolDensity: 'medium',
    /** Which kind of work the transcript pretends to be. */
    persona: 'refactor',
    /** Draw fake tool targets from the real workspace file tree. */
    useRealPaths: true,
    /** Render the fake reasoning block. */
    showThinking: true,
    /** Stream on without waiting for a keypress. */
    autoPlay: true,
    /** Prose font scale, percent. */
    fontScale: 100,
  }
}

/** Clamp a number into a range, falling back when it is not finite. */
export function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Coerce an unknown settings patch into a valid settings object. */
export function sanitizeSettings(patch, base) {
  const current = { ...defaultSettings(), ...(base ?? {}) }
  const input = typeof patch === 'object' && patch !== null ? patch : {}
  const next = { ...current }
  if ('speed' in input) next.speed = clampNumber(input.speed, 6, 600, current.speed)
  if ('turnChars' in input) next.turnChars = clampNumber(input.turnChars, 120, 2400, current.turnChars)
  if ('fontScale' in input) next.fontScale = clampNumber(input.fontScale, 80, 160, current.fontScale)
  if ('toolDensity' in input) {
    next.toolDensity = TOOL_DENSITIES.includes(input.toolDensity) ? input.toolDensity : current.toolDensity
  }
  if ('persona' in input) {
    next.persona = PERSONAS.includes(input.persona) ? input.persona : current.persona
  }
  for (const flag of ['useRealPaths', 'showThinking', 'autoPlay']) {
    if (flag in input) next[flag] = input[flag] === true
  }
  return next
}

/** Normalize a book title (never empty; bounded). */
export function normalizeTitle(raw, fallback) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  const picked = text.length > 0 ? text : String(fallback ?? '未命名')
  return picked.slice(0, LIMITS.title)
}

/** Strip a filename down to a plausible title. */
export function titleFromFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const noExt = base.replace(/\.(txt|epub|text|md)$/i, '')
  // Drop the site/uploader noise Chinese novel dumps carry: 【…】［…］(…)
  const cleaned = noExt
    .replace(/[【\[（(][^】\]）)]{0,30}[】\]）)]/g, ' ')
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalizeTitle(cleaned, noExt.length > 0 ? noExt : '未命名')
}

/** Whether a chapter entry survived a round-trip through the ledger file. */
export function isPlausibleChapter(entry) {
  return (
    typeof entry === 'object' && entry !== null &&
    typeof entry.title === 'string' &&
    typeof entry.start === 'number' && Number.isInteger(entry.start) && entry.start >= 0 &&
    typeof entry.end === 'number' && Number.isInteger(entry.end) && entry.end >= entry.start
  )
}

/** Whether a ledger entry is a usable book record. */
export function isPlausibleBookRecord(entry) {
  return (
    typeof entry === 'object' && entry !== null &&
    typeof entry.id === 'string' && entry.id.length > 0 &&
    typeof entry.title === 'string' && entry.title.length > 0 &&
    FORMATS.includes(entry.format) &&
    Array.isArray(entry.chapters) && entry.chapters.length > 0 &&
    entry.chapters.every(isPlausibleChapter)
  )
}

/** The list-view projection of a book: chapter titles, no text offsets. */
export function summarizeBook(book) {
  return {
    id: book.id,
    title: book.title,
    author: typeof book.author === 'string' ? book.author : '',
    format: book.format,
    chars: typeof book.chars === 'number' ? book.chars : 0,
    builtin: book.builtin === true,
    addedAt: book.addedAt ?? 0,
    updatedAt: book.updatedAt ?? 0,
    chapters: book.chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      chars: chapter.end - chapter.start,
    })),
  }
}

/** Coerce a progress record; out-of-range indexes clamp into the book. */
export function sanitizeProgress(raw, book) {
  const chapterCount = book === undefined ? 1 : book.chapters.length
  const input = typeof raw === 'object' && raw !== null ? raw : {}
  return {
    chapterIndex: clampNumber(input.chapterIndex, 0, Math.max(0, chapterCount - 1), 0),
    turnIndex: clampNumber(input.turnIndex, 0, 100_000, 0),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : 0,
  }
}

/** Deterministic-looking but unique book id. */
export function newBookId(random, nowMs) {
  const rand = typeof random === 'function' ? random : Math.random
  const stamp = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now()
  const tail = Math.floor(rand() * 0xfffff).toString(36).padStart(4, '0')
  return `bk_${stamp.toString(36)}${tail}`
}
