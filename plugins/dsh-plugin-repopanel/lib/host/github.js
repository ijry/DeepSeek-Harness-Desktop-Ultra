/**
 * The GitHub REST client: everything the panel needs from a forge behind nine
 * methods. Written as a factory rather than a class so a GitLab sibling can
 * implement the SAME face later and the routes layer keeps one code path. The
 * host, the repository and the token live in the closure, which is also why the
 * token cannot reach a returned value, a thrown detail or a log line.
 *
 * `fetchImpl` exists only so tests can inject a stub — every network call in
 * this file goes through it, so stubbing it covers the whole surface.
 *
 * Two GitHub behaviors shape this file more than anything else:
 *   - a merged pull request is reported as `state: 'closed'`, so `merged` is
 *     DERIVED here instead of trusted from the payload
 *   - /search/issues refuses to page past 1000 matches, so the reachable count
 *     is capped and the requested page clamped before a request goes out
 *
 * @module dsh-plugin-repopanel/host/github
 */
import {
  ERR,
  MAX_BODY_CHARS,
  MAX_LABELS,
  PanelError,
  normalizeCommentBody,
  normalizeOptionalText,
  normalizePage,
  normalizePageSize,
  normalizeRepo,
  normalizeTitle,
} from '../shared/protocol.js'
import { hostLang } from '../shared/lang.js'

/** Per-request deadline: a hung forge must not pin a route handler forever. */
export const REQUEST_TIMEOUT_MS = 20_000

/** GitHub's search API will not serve a match past the first 1000. */
export const SEARCH_RESULT_CAP = 1000

/** Labels are read a page at a time, up to MAX_LABELS. */
const LABEL_PAGE_SIZE = 100
const MAX_LABEL_PAGES = Math.max(1, Math.ceil(MAX_LABELS / LABEL_PAGE_SIZE))

/**
 * Headers every request carries. Canonical casing because these are also what a
 * test stub sees; a real fetch normalizes them either way. GitHub rejects a
 * request with no User-Agent, and the API version is pinned so a server-side
 * default change cannot reshape a payload under us.
 */
const BASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-plugin-repopanel',
}

/**
 * Appended to a body cut at MAX_BODY_CHARS so reader and agent both know. The
 * host's language cannot change while the process lives, so it is resolved once.
 */
const TRUNCATION_NOTE = hostLang() === 'en'
  ? `\n\n… (too long — truncated to the first ${MAX_BODY_CHARS} characters)`
  : `\n\n…（内容过长，已截断，仅保留前 ${MAX_BODY_CHARS} 个字符）`

/**
 * The REST base for a host: github.com answers on api.github.com, every
 * Enterprise host on https://<host>/api/v3.
 */
function apiBase(host) {
  const clean = String(host ?? '').trim().toLowerCase()
  return clean === 'github.com' || clean === 'www.github.com'
    ? 'https://api.github.com'
    : `https://${clean}/api/v3`
}

/**
 * owner/repo as a URL path, one encoded segment each. Exactly two segments and
 * no `.`/`..`: the repository comes from a git remote, and a crafted one must
 * not be able to walk out of /repos/<owner>/<repo> into another endpoint.
 */
function repoPath(repo) {
  const segments = repo.split('/')
  const usable = segments.length === 2
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  if (!usable) throw new PanelError(ERR.invalidInput, `not a GitHub owner/repo: ${repo}`)
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

/** Escape a value that goes into a search qualifier. */
function escapeQualifier(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * The `q` qualifier string for /search/issues. One search endpoint serves both
 * tabs and every filter, so this is the single place a panel filter becomes
 * forge syntax.
 *
 * The user's free text is split on whitespace and each term is QUOTED, so it can
 * only ever narrow the search by words. Appending it raw would let a term be
 * read as a qualifier, and one of those is not a harmless quirk: a second
 * `repo:other/repo` is ORed by GitHub, so rows from a repository the panel is not
 * pointed at would appear in the list — and this plugin derives a row's source
 * key from the SELECTED remote, not from the row, so triggering one of those rows
 * would link a task to the wrong repository. Quoting removes that whole class.
 * Escaping alone would not: `repo:x` needs no quotes to be a qualifier.
 */
function buildQualifiers(repo, query) {
  const parts = [`repo:${repo}`, query.tab === 'prs' ? 'is:pr' : 'is:issue']
  if (query.state !== 'all') parts.push(`state:${query.state}`)
  for (const label of query.labels) parts.push(`label:"${escapeQualifier(label)}"`)
  if (query.assignedToMe === true) parts.push('assignee:@me')
  for (const term of query.search.split(/\s+/)) {
    if (term.length > 0) parts.push(`"${escapeQualifier(term)}"`)
  }
  return parts.join(' ')
}

/** A UI sort id as GitHub's search `sort` + `order` pair (default: newest). */
function sortParams(sort) {
  switch (sort) {
    case 'oldest': return { sort: 'created', order: 'asc' }
    case 'recently_updated': return { sort: 'updated', order: 'desc' }
    case 'least_recently_updated': return { sort: 'updated', order: 'asc' }
    default: return { sort: 'created', order: 'desc' }
  }
}

/**
 * The last page the search API will serve for a page size. GitHub answers 422
 * once page × per_page passes the cap, so the request is clamped here rather
 * than letting a deep-linked page number turn into an error.
 */
function maxSearchPage(perPage) {
  return Math.max(1, Math.floor(SEARCH_RESULT_CAP / perPage))
}

/** Selected label names: trimmed, de-duplicated and capped at MAX_LABELS. */
function labelNames(raw) {
  if (!Array.isArray(raw)) return []
  const names = new Set()
  for (const entry of raw) {
    if (names.size >= MAX_LABELS) break
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name.length > 0) names.add(name)
  }
  return [...names]
}

/**
 * Canonicalize the browser's query object. Every field is optional over the
 * wire, so each one falls back to the default the panel opens on.
 */
function normalizeQuery(query) {
  const perPage = normalizePageSize(query?.perPage)
  return {
    tab: query?.tab === 'prs' ? 'prs' : 'issues',
    state: query?.state === 'closed' || query?.state === 'all' ? query.state : 'open',
    search: typeof query?.search === 'string' ? query.search.trim() : '',
    labels: labelNames(query?.labels),
    assignedToMe: query?.assignedToMe === true,
    sort: typeof query?.sort === 'string' ? query.sort : 'newest',
    perPage,
    page: Math.min(normalizePage(query?.page), maxSearchPage(perPage)),
  }
}

/** An item number, refused unless it is a positive integer. */
function itemNumber(raw) {
  const number = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new PanelError(ERR.invalidInput, 'number must be a positive integer')
  }
  return number
}

/** A string field, or null when the forge left it out. */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Cap a body at MAX_BODY_CHARS. A megabyte-long issue body must not travel to
 * the browser or into a prompt, and the note tells the reader — and the agent
 * the body is later fenced into — that what they have is partial.
 */
function capBody(raw) {
  if (typeof raw !== 'string') return null
  return raw.length <= MAX_BODY_CHARS ? raw : `${raw.slice(0, MAX_BODY_CHARS)}${TRUNCATION_NOTE}`
}

/**
 * A label colour as `#rrggbb`. GitHub sends bare hex digits without the `#`;
 * anything that is not 3- or 6-digit hex becomes null so the browser draws a
 * neutral chip instead of an invalid colour. A 3-digit shorthand is expanded
 * rather than passed through — the row contract is exactly `#rrggbb`.
 */
function normalizeLabelColor(raw) {
  if (typeof raw !== 'string') return null
  const hex = raw.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
  return null
}

/** One label row, or undefined when the entry carries no usable name. */
function toLabel(raw) {
  // Some payloads carry labels as bare name strings rather than objects.
  const name = typeof raw === 'string' ? raw : raw?.name
  if (typeof name !== 'string' || name.length === 0) return undefined
  return { name, color: typeof raw === 'string' ? null : normalizeLabelColor(raw?.color) }
}

/** The label rows of an item payload. */
function toLabels(raw) {
  if (!Array.isArray(raw)) return []
  const labels = []
  for (const entry of raw) {
    const label = toLabel(entry)
    if (label !== undefined) labels.push(label)
  }
  return labels
}

/**
 * Whether a pull request was merged. The marker sits in a different place in
 * each payload: `pull_request.merged_at` in a search/issues row, `merged_at` or
 * `merged` on a single pull payload.
 */
function isMerged(raw) {
  if (raw?.merged === true) return true
  if (typeof raw?.merged_at === 'string') return true
  return typeof raw?.pull_request?.merged_at === 'string'
}

/** The normalized state; `merged` is derived because GitHub reports `closed`. */
function stateOf(raw, isPr) {
  if (isPr && isMerged(raw)) return 'merged'
  return raw?.state === 'closed' ? 'closed' : 'open'
}

/**
 * One issue or pull-request payload as a browser row. These field names ARE the
 * contract with the browser half — renaming one here silently empties a column
 * there.
 * @param prHint - true when the caller already knows this is a pull request;
 *   otherwise it is read off the payload.
 */
function toRow(raw, prHint) {
  const isPr = prHint === true
    || (raw?.pull_request !== undefined && raw?.pull_request !== null)
    || (raw?.head !== undefined && raw?.head !== null)
  const row = {
    number: typeof raw?.number === 'number' ? raw.number : 0,
    title: typeof raw?.title === 'string' ? raw.title : '',
    body: capBody(raw?.body),
    state: stateOf(raw, isPr),
    draft: isPr && raw?.draft === true,
    labels: toLabels(raw?.labels),
    author: stringOrNull(raw?.user?.login),
    authorAvatar: stringOrNull(raw?.user?.avatar_url),
    updatedAt: stringOrNull(raw?.updated_at),
    htmlUrl: typeof raw?.html_url === 'string' ? raw.html_url : '',
    isPr,
    // GitHub's `comments` counts the discussion thread only; review threads
    // live on their own endpoint and are not what the row's badge means.
    comments: typeof raw?.comments === 'number' ? raw.comments : 0,
  }
  // Branch coordinates exist only on a single pull payload — a search row has
  // none, and the browser reads their absence as "not loaded yet".
  if (raw?.head !== undefined || raw?.base !== undefined) {
    row.baseRef = stringOrNull(raw?.base?.ref)
    row.headRef = stringOrNull(raw?.head?.ref)
    row.headSha = stringOrNull(raw?.head?.sha)
    row.headRepo = stringOrNull(raw?.head?.repo?.full_name)
  }
  return row
}

/**
 * One comment row. `id` is stringified so it can key a DOM node directly and so
 * a provider whose ids are not numbers fits the same shape.
 */
function toComment(raw) {
  return {
    id: raw?.id === undefined || raw?.id === null ? '' : String(raw.id),
    author: stringOrNull(raw?.user?.login),
    authorAvatar: stringOrNull(raw?.user?.avatar_url),
    body: capBody(raw?.body),
    createdAt: stringOrNull(raw?.created_at),
    updatedAt: stringOrNull(raw?.updated_at),
    htmlUrl: typeof raw?.html_url === 'string' ? raw.html_url : '',
  }
}

/** The HTTP status, tolerating a test stub that only sets `ok`. */
function statusOf(response) {
  if (typeof response?.status === 'number') return response.status
  return response?.ok === true ? 200 : 0
}

/** One response header, tolerating a stub that hands over a plain object. */
function headerOf(response, name) {
  const headers = response?.headers
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value === undefined || value === null ? undefined : String(value)
  }
  return undefined
}

/**
 * The body as parsed JSON, or undefined when there is none. A 204, a proxy's
 * HTML error page and an Enterprise login redirect all land here, and the status
 * mapping is then the only signal — which is why this never throws.
 */
async function readPayload(response) {
  if (statusOf(response) === 204) return undefined
  if (typeof response?.json !== 'function') return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** GitHub's own explanation, when the body carries one. */
function messageOf(payload) {
  const message = payload?.message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/**
 * Whether a refusal is the rate limiter rather than a permission problem. The
 * panel's advice differs — wait, versus supply a token with the right scope —
 * and GitHub signals the primary limit with x-ratelimit-remaining: 0 while the
 * secondary limit only shows up in prose.
 */
function isRateLimited(response, payload) {
  if (headerOf(response, 'x-ratelimit-remaining') === '0') return true
  if (headerOf(response, 'retry-after') !== undefined) return true
  const message = messageOf(payload)
  return message !== undefined && /rate limit|abuse detection/i.test(message)
}

/**
 * Map an HTTP failure onto a PanelError with a stable code. `context` is the
 * method and route only — never the query string, never a header — so no token
 * can reach an error message on its way to the browser or a log.
 */
function errorForStatus(status, response, payload, context) {
  const message = messageOf(payload)
  const detail = `${context} → HTTP ${status}${message === undefined ? '' : `: ${message}`}`
  if (status === 401 || status === 403) {
    return new PanelError(isRateLimited(response, payload) ? ERR.rateLimited : ERR.forbidden, detail)
  }
  // 429 is the secondary limiter answering with a status instead of prose.
  if (status === 429) return new PanelError(ERR.rateLimited, detail)
  if (status === 404) return new PanelError(ERR.notFound, detail)
  return new PanelError(ERR.forgeError, detail)
}

/**
 * Whether another page follows. GitHub's Link header is authoritative; when a
 * proxy strips it, a full page is the only remaining hint that more exists.
 */
function hasNextPage(response, rowCount, perPage) {
  const link = headerOf(response, 'link')
  if (link !== undefined) return /<[^>]+>;\s*rel="next"/.test(link)
  return rowCount >= perPage
}

/**
 * Build a GitHub client for one repository.
 * @param options - { host, ownerRepo, token, fetchImpl }. `host` is github.com
 *   or a GitHub Enterprise host, `token` may be omitted for public reads, and
 *   `fetchImpl` defaults to the global fetch and exists only so tests can
 *   inject a stub.
 */
export function githubClient({ host, ownerRepo, token, fetchImpl } = {}) {
  const base = apiBase(host)
  const repo = normalizeRepo(ownerRepo)
  const path = repoPath(repo)
  const doFetch = fetchImpl ?? globalThis.fetch
  // Built once, here: the token becomes one header string, so no later code path
  // is in a position to interpolate it into a message.
  const authorization = typeof token === 'string' && token.trim().length > 0
    ? `Bearer ${token.trim()}`
    : undefined

  /** Absolute request URL; an undefined param is dropped, not sent empty. */
  const urlFor = (route, params) => {
    const url = new URL(`${base}${route}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * The one request path. The auth header, the API version pin, the deadline and
   * the status → PanelError mapping exist here and nowhere else.
   */
  const request = async (route, options = {}) => {
    const method = options.method ?? 'GET'
    const headers = { ...BASE_HEADERS }
    // Authorization only when a token exists: public repositories answer
    // unauthenticated reads, and an empty Bearer turns those into a 401.
    if (authorization !== undefined) headers.Authorization = authorization
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    let response
    try {
      response = await doFetch(urlFor(route, options.params), init)
    } catch (error) {
      // A dead network and the deadline firing are the same thing to the panel:
      // the forge is unreachable right now.
      throw new PanelError(ERR.forgeError, `${method} ${route} failed: ${error?.message ?? error}`)
    }
    const status = statusOf(response)
    const payload = await readPayload(response)
    if (status < 200 || status >= 300) {
      throw errorForStatus(status, response, payload, `${method} ${route}`)
    }
    return { payload, response }
  }

  return {
    /**
     * Who the token belongs to. Doubles as the credential probe: a bad token
     * fails here, before the panel has drawn a list against it.
     */
    async identity() {
      const { payload } = await request('/user')
      return { username: stringOrNull(payload?.login), avatarUrl: stringOrNull(payload?.avatar_url) }
    },

    /**
     * The repository's labels for the filter popover, paged up to MAX_LABELS.
     * `truncated` tells the browser the list is partial, so it can say so rather
     * than imply the repository has no other labels.
     */
    async labels() {
      const rows = []
      let truncated = false
      for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
        const { payload, response } = await request(`/repos/${path}/labels`, {
          params: { per_page: LABEL_PAGE_SIZE, page },
        })
        const batch = Array.isArray(payload) ? payload : []
        for (const entry of batch) {
          const label = toLabel(entry)
          if (label === undefined) continue
          if (rows.length >= MAX_LABELS) {
            truncated = true
            break
          }
          rows.push(label)
        }
        if (!hasNextPage(response, batch.length, LABEL_PAGE_SIZE)) break
        // A next page exists but the budget is spent.
        if (rows.length >= MAX_LABELS || page === MAX_LABEL_PAGES) {
          truncated = true
          break
        }
      }
      return { labels: rows, truncated }
    },

    /**
     * One page of issues or pull requests. Both tabs go through /search/issues
     * so a single code path serves every filter combination.
     */
    async list(query) {
      const wanted = normalizeQuery(query)
      const order = sortParams(wanted.sort)
      const { payload } = await request('/search/issues', {
        params: {
          q: buildQualifiers(repo, wanted),
          sort: order.sort,
          order: order.order,
          per_page: wanted.perPage,
          page: wanted.page,
        },
      })
      const totalCount = typeof payload?.total_count === 'number' ? payload.total_count : 0
      // Matches past the cap exist on the forge but cannot be paged to, so the
      // footer counts what it can actually reach.
      const reachableCount = Math.min(totalCount, SEARCH_RESULT_CAP)
      const items = Array.isArray(payload?.items) ? payload.items : []
      return {
        rows: items.map((entry) => toRow(entry, wanted.tab === 'prs')),
        page: wanted.page,
        perPage: wanted.perPage,
        totalCount,
        reachableCount,
        hasNext: wanted.page * wanted.perPage < reachableCount,
        incomplete: payload?.incomplete_results === true,
      }
    },

    /**
     * Just the match count, for a tab badge. Answers undefined instead of
     * throwing: an unknown badge is acceptable, a wrong one is not, and a failed
     * count must not fail the list beside it.
     */
    async count(query) {
      try {
        const { payload } = await request('/search/issues', {
          params: { q: buildQualifiers(repo, normalizeQuery(query)), per_page: 1, page: 1 },
        })
        const total = payload?.total_count
        return typeof total === 'number' && Number.isFinite(total) ? total : undefined
      } catch {
        return undefined
      }
    },

    /**
     * One item in full. A pull request is read from /pulls so the row carries its
     * branch coordinates — the issues endpoint answers for a pull request's
     * number too, but without them.
     */
    async item({ kind, number } = {}) {
      const isPr = kind === 'pr'
      const id = itemNumber(number)
      const { payload } = await request(`/repos/${path}/${isPr ? 'pulls' : 'issues'}/${id}`)
      return toRow(payload, isPr)
    },

    /** One page of the discussion thread, oldest first (GitHub's own order). */
    async comments({ number, page, perPage } = {}) {
      const id = itemNumber(number)
      const size = normalizePageSize(perPage)
      const current = normalizePage(page)
      const { payload, response } = await request(`/repos/${path}/issues/${id}/comments`, {
        params: { per_page: size, page: current },
      })
      const rows = Array.isArray(payload) ? payload.map((entry) => toComment(entry)) : []
      return { comments: rows, page: current, perPage: size, hasNext: hasNextPage(response, rows.length, size) }
    },

    /** Post a comment. Both kinds share one thread on GitHub: the issue's. */
    async addComment({ number, body } = {}) {
      const id = itemNumber(number)
      const { payload } = await request(`/repos/${path}/issues/${id}/comments`, {
        method: 'POST',
        body: { body: normalizeCommentBody(body) },
      })
      return toComment(payload)
    },

    /**
     * Close or reopen. Each kind goes to its own endpoint so the answer is the
     * same payload item() returns and the browser can swap the row in place;
     * only `state` is sent, so nothing else about the item can drift.
     */
    async setState({ kind, number, action } = {}) {
      if (action !== 'close' && action !== 'reopen') {
        throw new PanelError(ERR.invalidInput, 'action must be close or reopen')
      }
      const isPr = kind === 'pr'
      const id = itemNumber(number)
      const { payload } = await request(`/repos/${path}/${isPr ? 'pulls' : 'issues'}/${id}`, {
        method: 'PATCH',
        body: { state: action === 'close' ? 'closed' : 'open' },
      })
      return toRow(payload, isPr)
    },

    /**
     * Open a new issue. Title and body go through the shared normalizers, so an
     * over-cap body is refused here rather than by the forge with a 422.
     */
    async createIssue({ title, body, labels } = {}) {
      const draft = { title: normalizeTitle(title) }
      const text = normalizeOptionalText(body, 'body')
      if (text !== undefined) draft.body = text
      const names = labelNames(labels)
      if (names.length > 0) draft.labels = names
      const { payload } = await request(`/repos/${path}/issues`, { method: 'POST', body: draft })
      return toRow(payload, false)
    },
  }
}
