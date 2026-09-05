/**
 * /dsh-plugin-otools-git routes on the shared DSH webserver: a JSON API for the
 * browser panel plus an SSE stream carrying preference changes and live operation
 * progress.
 *
 * Nothing about a repository is cached beyond the short TTLs in host/workspaces.js
 * — the panel is a live view of a working tree, so every read runs `git`. The two
 * durable things are the panel preferences and the HTTPS credentials, and both
 * live in their own files.
 *
 * Containment: every route that names a repository resolves it through
 * `repos.resolve`, which only ever answers with a repository inside a registered
 * DSH workspace. The browser cannot point this at an arbitrary directory.
 *
 * @module dsh-plugin-otools-git/host/routes
 */
import { ERR, GitError, normalizeFlag, normalizeRemoteName } from '../shared/protocol.js'
import {
  envelopeOfError,
  json,
  ok,
  optionalPath,
  optionalRev,
  readBody,
  requireBranchSelector,
  requireParam,
  requirePath,
  requireRev,
  requireStashRef,
  sendFail,
  sourceOf,
} from './http.js'
import { aiAvailability } from './ai.js'
import { loadCredentialHosts, envCredentialSources } from './auth.js'
import { conflictStages, headMessage, worktreeFile } from './commit.js'
import { installationStatus, readIdentity, readSettings } from './config.js'
import { diffShortstat, diffSummary, fileDiff, imagePreview } from './diff.js'
import { blame, branchTips, commitDetail, fileHistory, readHistory, tagTips } from './history.js'
import { listBranches, listTags, mergeableBranches } from './refs.js'
import { listRemotes, pullDefaults, pushDefaults, remoteBranches } from './remotes.js'
import { listStashes, stashDiff, stashSummary } from './stash.js'
import { preparedMessage, readStatus } from './status.js'
import { createOperations } from './ops.js'
import { registerActionRoutes } from './actions.js'

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-plugin-otools-git'

/** SSE stream path (an exact route; longest-prefix keeps it disjoint). */
export const SSE_PATH = '/dsh-plugin-otools-git/events'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/**
 * Register the panel routes (JSON prefix + exact SSE stream). Returns the
 * disposer.
 *
 * @param options - `{ prefs, repos, credentialsFile, ai, now }`
 */
export function registerGitRoutes(ctx, options) {
  const { prefs, repos, credentialsFile } = options
  const subscribers = new Set()
  let heartbeat

  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const broadcast = (event, data) => {
    const text = frame(event, data)
    for (const res of subscribers) {
      try {
        res.write(text)
      } catch {
        subscribers.delete(res)
      }
    }
  }
  const unsubscribePrefs = prefs.subscribe((change) => broadcast('prefs', change))
  // The registry is created here so its change events can reach the same SSE
  // stream without a callback handed in from the entry point.
  const operations = createOperations({
    now: options.now,
    onChange: (record) => broadcast('operation', record),
  })

  /** The repository root a request names. */
  const rootOf = async (params) => repos.resolve(params.get('workspaceId') ?? params.get('root'))

  /** GET dispatch. Grouped by area, in the order the panel calls them. */
  const handleGet = async (req, res, pathname, params) => {
    const route = pathname.slice(ROUTE_PREFIX.length)

    // ---------------------------------------------------------------- shell
    if (route === '/repos') {
      ok(res, await repos.list())
      return true
    }
    if (route === '/prefs') {
      await prefs.load()
      ok(res, { prefs: prefs.snapshot(), revision: prefs.revision })
      return true
    }
    if (route === '/install') {
      ok(res, await installationStatus())
      return true
    }
    if (route === '/ai/availability') {
      ok(res, aiAvailability(options.ai?.llm, options.ai?.defaultModel))
      return true
    }
    if (route === '/credentials') {
      ok(res, { hosts: await loadCredentialHosts(credentialsFile), env: envCredentialSources() })
      return true
    }
    if (route === '/ops') {
      ok(res, operations.list())
      return true
    }
    if (route.startsWith('/ops/')) {
      const record = operations.get(route.slice(5))
      if (record === undefined) throw new GitError(ERR.notFound, '操作不存在或已过期')
      ok(res, record)
      return true
    }

    // --------------------------------------------------------------- status
    if (route === '/status') {
      const root = await rootOf(params)
      ok(res, await readStatus(root, {
        untracked: params.get('untracked') ?? 'all',
        ignored: normalizeFlag(params.get('ignored')),
      }))
      return true
    }
    if (route === '/children') {
      ok(res, await repos.children(await rootOf(params)))
      return true
    }
    if (route === '/conflict') {
      const root = await rootOf(params)
      ok(res, await conflictStages(root, requirePath(params)))
      return true
    }
    if (route === '/worktree-file') {
      const root = await rootOf(params)
      ok(res, await worktreeFile(root, requirePath(params)))
      return true
    }
    if (route === '/head-message') {
      ok(res, { message: await headMessage(await rootOf(params)) })
      return true
    }
    if (route === '/prepared-message') {
      ok(res, { message: (await preparedMessage(await rootOf(params))) ?? '' })
      return true
    }

    // ----------------------------------------------------------------- diff
    if (route === '/diff/summary') {
      const root = await rootOf(params)
      const source = sourceOf(params)
      const [files, stat] = await Promise.all([
        diffSummary(root, source),
        diffShortstat(root, source),
      ])
      ok(res, { files, stat })
      return true
    }
    if (route === '/diff/file') {
      const root = await rootOf(params)
      ok(res, await fileDiff(root, {
        source: sourceOf(params),
        path: requirePath(params),
        origPath: optionalPath(params, 'origPath'),
        context: Number.parseInt(params.get('context') ?? '', 10),
        ignoreWhitespace: normalizeFlag(params.get('ignoreWhitespace')),
        ignoreBlankLines: normalizeFlag(params.get('ignoreBlankLines')),
        wordDiff: normalizeFlag(params.get('wordDiff')),
      }))
      return true
    }
    if (route === '/diff/image') {
      const root = await rootOf(params)
      ok(res, await imagePreview(root, {
        source: sourceOf(params),
        path: requirePath(params),
        origPath: optionalPath(params, 'origPath'),
      }))
      return true
    }

    // -------------------------------------------------------------- history
    if (route === '/history') {
      const root = await rootOf(params)
      ok(res, await readHistory(root, {
        limit: params.get('limit'),
        offset: params.get('offset'),
        branch: requireBranchSelector(params),
        includeRemote: params.get('includeRemote') !== 'false',
        path: optionalPath(params, 'path'),
        filters: {
          message: params.get('message'),
          author: params.get('author'),
          hash: params.get('hash'),
          parents: params.get('parents'),
          dateFrom: params.get('dateFrom'),
          dateTo: params.get('dateTo'),
        },
      }))
      return true
    }
    if (route === '/history/tips') {
      const root = await rootOf(params)
      const [branches, tags] = await Promise.all([
        branchTips(root, params.get('includeRemote') !== 'false'),
        tagTips(root),
      ])
      ok(res, { branches, tags })
      return true
    }
    if (route === '/commit') {
      const root = await rootOf(params)
      const rev = requireRev(params)
      const detail = await commitDetail(root, rev)
      if (detail === undefined) throw new GitError(ERR.notFound, `找不到提交 ${rev}`)
      ok(res, detail)
      return true
    }
    if (route === '/file/history') {
      const root = await rootOf(params)
      ok(res, await fileHistory(root, requirePath(params), Number.parseInt(params.get('limit') ?? '', 10)))
      return true
    }
    if (route === '/blame') {
      const root = await rootOf(params)
      ok(res, await blame(root, requirePath(params), optionalRev(params, 'rev')))
      return true
    }

    // ---------------------------------------------------------------- refs
    if (route === '/branches') {
      const root = await rootOf(params)
      ok(res, await listBranches(root, { includeRemote: params.get('includeRemote') !== 'false' }))
      return true
    }
    if (route === '/branches/mergeable') {
      ok(res, await mergeableBranches(await rootOf(params)))
      return true
    }
    if (route === '/tags') {
      ok(res, await listTags(await rootOf(params)))
      return true
    }

    // -------------------------------------------------------------- stashes
    if (route === '/stashes') {
      ok(res, await listStashes(await rootOf(params)))
      return true
    }
    if (route === '/stash/files') {
      const root = await rootOf(params)
      ok(res, await stashSummary(root, requireStashRef(params)))
      return true
    }
    if (route === '/stash/diff') {
      const root = await rootOf(params)
      ok(res, await stashDiff(root, requireStashRef(params), optionalPath(params, 'path')))
      return true
    }

    // -------------------------------------------------------------- remotes
    if (route === '/remotes') {
      ok(res, await listRemotes(await rootOf(params)))
      return true
    }
    if (route === '/remote/branches') {
      const root = await rootOf(params)
      ok(res, await remoteBranches(root, normalizeRemoteName(requireParam(params, 'remote'))))
      return true
    }
    if (route === '/push/defaults') {
      ok(res, await pushDefaults(await rootOf(params)))
      return true
    }
    if (route === '/pull/defaults') {
      ok(res, await pullDefaults(await rootOf(params)))
      return true
    }

    // --------------------------------------------------------------- config
    if (route === '/config') {
      ok(res, await readSettings(await rootOf(params)))
      return true
    }
    if (route === '/identity') {
      ok(res, await readIdentity(await rootOf(params)))
      return true
    }

    return false
  }

  const actions = registerActionRoutes({ ...options, operations, broadcast })

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        res.writeHead(404)
        res.end()
        return
      }
      if (req.method === 'GET') {
        if (!(await handleGet(req, res, url.pathname, url.searchParams))) {
          res.writeHead(404)
          res.end()
        }
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) {
          sendFail(res, ERR.invalidInput, 'request body must be a JSON object')
          return
        }
        if (!(await actions.handlePost(req, res, url.pathname.slice(ROUTE_PREFIX.length), body))) {
          res.writeHead(404)
          res.end()
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    } catch (error) {
      const failure = envelopeOfError(error)
      json(res, {
        ok: false,
        error: { code: failure.code, message: failure.message, dubious: failure.dubious },
      }, failure.status)
    }
  }

  const sse = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // Baseline frame: the client reconciles by revision and refetches on a gap
    // instead of replaying every lost frame.
    res.write(frame('hello', { revision: prefs.revision, operations: operations.list() }))
    subscribers.add(res)
    // A socket that dies between 'close' detection and the next write emits
    // 'error' on the response — drop the subscriber instead of crashing.
    res.on('error', () => {
      subscribers.delete(res)
    })
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const current of subscribers) {
          try {
            current.write(': ping\n\n')
          } catch {
            subscribers.delete(current)
          }
        }
      }, HEARTBEAT_MS)
    }
    req.on('close', () => {
      subscribers.delete(res)
      if (subscribers.size === 0 && heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
  ]
  return () => {
    unsubscribePrefs()
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) {
      try {
        res.end()
      } catch { /* already gone */ }
    }
    subscribers.clear()
    operations.dispose()
  }
}
