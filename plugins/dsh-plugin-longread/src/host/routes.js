/**
 * /dsh-plugin-longread routes on the shared DSH webserver: a small JSON API for
 * the library, the reader's position, the settings, and the per-chapter turn plan
 * the browser half renders.
 *
 * No SSE here, unlike the sibling plugins: nothing else writes to this ledger, so
 * there is no second party to stay in sync with. One reader, one panel, plain
 * request/response.
 *
 * All domain rules live in host/library.js and shared/*; this layer only maps
 * transport onto the `{ ok }` envelope every plugin in this repo uses.
 *
 * @module dsh-plugin-longread/host/routes
 */
import { paragraphsOf } from '../shared/chapters.js'
import { planChapter } from '../shared/theater.js'
import { ImportError } from './import.js'
import { addBook, deleteBook, seedSample, setProgress, updateSettings } from './library.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-longread'

/** Max accepted JSON body bytes — an unbounded local HTTP buffer is an OOM vector. */
const MAX_BODY_BYTES = 24 * 1024 * 1024

/** Route shapes, compiled once at module load. */
const PLAN_RE = new RegExp(`^${ROUTE_PREFIX}/books/([^/]+)/plan$`)
const DELETE_RE = new RegExp(`^${ROUTE_PREFIX}/books/([^/]+)/delete$`)

/** Error codes this layer can produce. */
export const ERR = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  internal: 'internal',
}

/** Envelope writer. */
function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** `{ ok: true }` writer. */
function ok(res, value, status = 200) {
  json(res, { ok: true, value }, status)
}

/** Map an error code to its HTTP status. */
function statusOf(code) {
  return code === ERR.invalidInput ? 400
    : code === ERR.notFound ? 404
      : 500
}

/** `{ ok: false }` writer. */
function sendFail(res, code, message) {
  json(res, { ok: false, error: { code, message } }, statusOf(code))
}

/** Map a thrown error onto the envelope. */
function envelopeOfError(error) {
  if (error instanceof ImportError) {
    return { code: error.code, message: error.message, status: statusOf(error.code) }
  }
  const message = error?.message ?? String(error)
  console.error('[dsh-plugin-longread] route error:', message)
  return { code: ERR.internal, message, status: 500 }
}

/** Read one JSON body (`{}` when empty; null on parse failure). */
async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new ImportError(ERR.invalidInput, 'body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Decode the base64 payload of an import request. */
function decodeUpload(body) {
  const data = body.data
  if (typeof data !== 'string' || data.length === 0) {
    throw new ImportError(ERR.invalidInput, 'data must be a base64 string')
  }
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new ImportError(ERR.invalidInput, 'data decoded to zero bytes')
  return buffer
}

/**
 * Register the reader routes on a webServer context. Returns the disposer.
 * @param ctx - a context with `webServer` injected.
 * @param options - { store, filePool, now }
 */
export function registerLongreadRoutes(ctx, options) {
  const { store, filePool } = options
  const now = options.now ?? (() => Date.now())

  /** The file pool is best-effort: the fallback pool keeps the panel working. */
  async function poolPaths() {
    if (filePool === undefined || store.settings.useRealPaths !== true) return []
    try {
      return await filePool.paths()
    } catch {
      return []
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      if (req.method === 'GET') {
        if (pathname === `${ROUTE_PREFIX}/state`) {
          await store.load()
          // Seeding on first read, not at mount: a reader who never opens the
          // panel never gets a file written into their DSH home.
          await seedSample(store, { now })
          ok(res, store.snapshot())
          return
        }
        const planMatch = PLAN_RE.exec(pathname)
        if (planMatch !== null) {
          await store.load()
          const book = store.get(planMatch[1])
          if (book === undefined) {
            sendFail(res, ERR.notFound, `no book ${planMatch[1]}`)
            return
          }
          const requested = Number.parseInt(url.searchParams.get('chapter') ?? '0', 10)
          const chapterIndex = Number.isFinite(requested)
            ? Math.min(Math.max(0, requested), book.chapters.length - 1)
            : 0
          const text = await store.chapterText(book.id, chapterIndex)
          if (text === undefined) {
            sendFail(res, ERR.notFound, 'the book text is missing on disk')
            return
          }
          const chapter = book.chapters[chapterIndex]
          const plan = planChapter({
            bookId: book.id,
            bookTitle: book.title,
            chapterIndex,
            chapterTitle: chapter.title,
            paragraphs: paragraphsOf(text),
            settings: store.settings,
            files: await poolPaths(),
          })
          ok(res, {
            ...plan,
            bookTitle: book.title,
            chapterCount: book.chapters.length,
            chapterChars: chapter.end - chapter.start,
          })
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }

      const body = await readBody(req)
      if (body === null) {
        sendFail(res, ERR.invalidInput, 'body must be a JSON object')
        return
      }

      if (pathname === `${ROUTE_PREFIX}/import`) {
        const buffer = decodeUpload(body)
        const summary = await addBook(store, { buffer, filename: body.name, now })
        ok(res, summary, 201)
        return
      }
      if (pathname === `${ROUTE_PREFIX}/settings`) {
        ok(res, await updateSettings(store, body))
        return
      }
      if (pathname === `${ROUTE_PREFIX}/progress`) {
        if (typeof body.bookId !== 'string' || body.bookId.length === 0) {
          sendFail(res, ERR.invalidInput, 'bookId must be a non-empty string')
          return
        }
        const saved = await setProgress(store, {
          bookId: body.bookId,
          chapterIndex: body.chapterIndex,
          turnIndex: body.turnIndex,
          now,
        })
        if (saved === undefined) {
          sendFail(res, ERR.notFound, `no book ${body.bookId}`)
          return
        }
        ok(res, saved)
        return
      }
      const deleteMatch = DELETE_RE.exec(pathname)
      if (deleteMatch !== null) {
        const removed = await deleteBook(store, deleteMatch[1])
        if (!removed) {
          sendFail(res, ERR.notFound, `no book ${deleteMatch[1]}`)
          return
        }
        ok(res, { id: deleteMatch[1], removed: true })
        return
      }
      res.writeHead(404)
      res.end()
    } catch (error) {
      const envelope = envelopeOfError(error)
      json(res, { ok: false, error: { code: envelope.code, message: envelope.message } }, envelope.status)
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  return () => dispose()
}
