/**
 * The file pool the camouflage draws from: a bounded, cached sample of real
 * paths in the reader's own workspaces, so a fake `read(src/lib/retry.ts)` names
 * a file that actually exists in the project on screen. That single detail is
 * what separates "looks like a session" from "is indistinguishable from one".
 *
 * Every part of the scan is bounded — depth, entries, results, and a TTL —
 * because this runs inside the harness process on a directory the reader chose,
 * which may well be a monorepo with a million files.
 *
 * @module dsh-plugin-longread/host/files
 */
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Directories never worth showing in a transcript. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.jj', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  'vendor', '.idea', '.vscode', '.pnpm-store', '.gradle', 'Pods', 'bin', 'obj',
])

/** Extensions that read as "source" in a transcript. */
const KEEP = /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|sql|sh|ps1|md|json|ya?ml|toml)$/i

/** Bounds. */
const MAX_DEPTH = 4
const MAX_FILES = 400
const MAX_ENTRIES = 6000
const MAX_WORKSPACES = 3
const TTL_MS = 5 * 60 * 1000

/** Walk one directory tree, breadth-first, into `out`. */
async function walk(root, out, budget) {
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && out.length < MAX_FILES && budget.entries < MAX_ENTRIES) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      budget.entries += 1
      if (budget.entries > MAX_ENTRIES) break
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue
        queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile() || !KEEP.test(entry.name)) continue
      const rel = relative(root, full).split(sep).join('/')
      if (rel.length > 0 && rel.length <= 120) out.push(rel)
      if (out.length >= MAX_FILES) break
    }
  }
}

/**
 * Create the pool.
 * @param options - { workspaces: () => Array<{ path, updatedAt? }>, now?: () => number }
 */
export function createFilePool(options) {
  const listWorkspaces = options.workspaces
  const now = options.now ?? (() => Date.now())
  let cache = { at: -Infinity, paths: [] }
  let inflight = null

  async function scan() {
    let workspaces = []
    try {
      workspaces = listWorkspaces() ?? []
    } catch (error) {
      console.warn('[dsh-plugin-longread] workspace list unavailable:', error?.message ?? error)
      return []
    }
    const ordered = [...workspaces]
      .filter((workspace) => typeof workspace?.path === 'string' && workspace.path.length > 0)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_WORKSPACES)
    const paths = []
    const budget = { entries: 0 }
    for (const workspace of ordered) {
      await walk(workspace.path, paths, budget)
      if (paths.length >= MAX_FILES) break
    }
    return paths
  }

  return {
    /** The cached path sample; refreshed past the TTL, never throwing. */
    async paths() {
      if (now() - cache.at < TTL_MS) return cache.paths
      if (inflight !== null) return inflight
      inflight = scan()
        .then((paths) => {
          cache = { at: now(), paths }
          return paths
        })
        .catch((error) => {
          console.warn('[dsh-plugin-longread] file scan failed:', error?.message ?? error)
          cache = { at: now(), paths: [] }
          return []
        })
        .finally(() => { inflight = null })
      return inflight
    },
    /** Drop the cache (used by tests, and when a workspace registry arrives). */
    invalidate() {
      cache = { at: -Infinity, paths: [] }
    },
  }
}

/**
 * The workspace face the pool needs, tolerant of a registry that is not there.
 * This cordis build has no `optional` inject form, so the registry is handed in
 * later through a getter instead of being a hard dependency of the panel.
 * @param getRegistry - () => ctx.workspaceRegistry | undefined
 */
export function workspaceFace(getRegistry) {
  return () => {
    const registry = typeof getRegistry === 'function' ? getRegistry() : undefined
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
    return registry.list().map((workspace) => ({ path: workspace.path, updatedAt: workspace.updatedAt }))
  }
}
