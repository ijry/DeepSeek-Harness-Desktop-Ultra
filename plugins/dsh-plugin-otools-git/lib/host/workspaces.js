/**
 * The repository list — read straight from DSH's workspace registry, never
 * hand-maintained.
 *
 * This is the one deliberate departure from the reference plugin, which keeps its
 * own repo list in a JSON file and makes the user add folders by hand (open /
 * clone / init, drag to reorder, rename, delete). DSH already knows which folders
 * the user works in, so that whole ledger is replaced by `ctx.workspaceRegistry`:
 * a workspace whose path is inside a git worktree becomes a row, and its
 * submodules and sibling worktrees hang under it exactly as the reference's tree
 * hung its own.
 *
 * What is NOT persisted here, and used to be in the reference: the row order
 * (registry order wins), custom labels, and the expanded/collapsed state of a
 * row (that is browser-local UI state).
 *
 * @module dsh-plugin-otools-git/host/workspaces
 */
import { basename } from 'node:path'
import { ERR, GitError } from '../shared/protocol.js'
import { readBrief, repoRoot } from './status.js'
import { listSubmodules, listWorktrees } from './nested.js'

/** How long a resolved root is reused. Resolving costs a `git` spawn. */
const ROOT_TTL_MS = 15_000

/** How long a row's brief status is reused, so a tree repaint is not N spawns. */
const BRIEF_TTL_MS = 3_000

/** Adapt DSH's workspace registry to the narrow face this plugin needs. */
export function workspaceFace(registry) {
  const toView = (ws) => (ws === undefined || ws === null
    ? undefined
    : { id: ws.id, path: ws.path, title: ws.title })
  return {
    list() {
      try {
        const rows = registry.list()
        return (Array.isArray(rows) ? rows : []).map(toView).filter((row) => row !== undefined)
      } catch {
        return []
      }
    },
    get(id) {
      try {
        return toView(registry.get(id))
      } catch {
        return undefined
      }
    },
  }
}

/** A cache in front of the two `git` calls the tree makes per row. */
export function createRepoIndex(options) {
  const { workspaces, now = () => Date.now() } = options
  const roots = new Map()
  const briefs = new Map()

  /** The worktree root of a workspace, behind the TTL. */
  const rootOf = async (workspace) => {
    const cached = roots.get(workspace.id)
    if (cached !== undefined && cached.at + ROOT_TTL_MS > now()) return cached.root
    const root = await repoRoot(workspace.path)
    roots.set(workspace.id, { at: now(), root })
    return root
  }

  /** One row's status, behind a shorter TTL. */
  const briefOf = async (root) => {
    const cached = briefs.get(root)
    if (cached !== undefined && cached.at + BRIEF_TTL_MS > now()) return cached.brief
    const brief = await readBrief(root).catch((error) => ({
      root,
      name: basename(root),
      error: error?.message ?? String(error),
    }))
    briefs.set(root, { at: now(), brief })
    return brief
  }

  return {
    /**
     * Every workspace, annotated with whether it is a repository. A workspace
     * that is NOT one is still listed (greyed out in the tree) rather than
     * hidden: silently dropping a folder the user opened looks like a bug.
     */
    async list() {
      const rows = workspaces.list()
      return Promise.all(rows.map(async (workspace) => {
        const root = await rootOf(workspace)
        if (root === undefined) {
          return {
            workspaceId: workspace.id,
            path: workspace.path,
            title: workspace.title ?? basename(workspace.path),
            name: basename(workspace.path),
            isRepo: false,
          }
        }
        const brief = await briefOf(root)
        return {
          workspaceId: workspace.id,
          path: workspace.path,
          title: workspace.title ?? basename(root),
          isRepo: true,
          // The worktree root, which may be an ANCESTOR of the workspace path
          // when the user opened a subdirectory.
          root,
          nested: root !== workspace.path,
          ...brief,
        }
      }))
    },

    /** The root a request names, by workspace id or by an explicit path. */
    async resolve(input) {
      if (typeof input === 'object' && input !== null) return this.resolve(input.workspaceId ?? input.path)
      if (typeof input !== 'string' || input.length === 0) {
        throw new GitError(ERR.invalidInput, 'workspaceId 或 path 是必填的')
      }
      const workspace = workspaces.get(input)
      if (workspace !== undefined) {
        const root = await rootOf(workspace)
        if (root === undefined) throw new GitError(ERR.notRepo, `${workspace.path} 不是一个 git 仓库`)
        return root
      }
      // Not a workspace id: it may be a nested repository (a submodule or a
      // sibling worktree) the tree offered. Those are only reachable when they
      // live under a workspace that IS registered, which is checked below.
      return this.resolvePath(input)
    },

    /**
     * A path that must belong to a registered workspace's repository. This is the
     * containment check that keeps the browser from driving `git` in an arbitrary
     * directory on the host: the panel can only ever reach a repository DSH
     * already knows about, or something nested inside one.
     */
    async resolvePath(path) {
      const candidate = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
      const rows = workspaces.list()
      for (const workspace of rows) {
        const root = await rootOf(workspace)
        if (root === undefined) continue
        const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
        const normalizedWorkspace = workspace.path.replace(/\\/g, '/').replace(/\/+$/, '')
        if (candidate === normalizedRoot || candidate === normalizedWorkspace) return root
        if (candidate.startsWith(`${normalizedRoot}/`) || candidate.startsWith(`${normalizedWorkspace}/`)) {
          const nested = await repoRoot(candidate)
          if (nested !== undefined) return nested
        }
        // A sibling worktree of a registered repository shares its object store
        // but lives outside its directory, so it is matched separately.
        const siblings = await listWorktrees(root).catch(() => [])
        for (const worktree of siblings) {
          const normalized = worktree.path.replace(/\\/g, '/').replace(/\/+$/, '')
          if (candidate === normalized || candidate.startsWith(`${normalized}/`)) {
            const nested = await repoRoot(candidate)
            if (nested !== undefined) return nested
          }
        }
      }
      throw new GitError(ERR.notFound, `${path} 不属于任何已打开的工作区仓库`)
    },

    /** Submodules and worktrees of one root, for the tree's child rows. */
    async children(root) {
      const [submodules, worktrees] = await Promise.all([
        listSubmodules(root).catch(() => []),
        listWorktrees(root).catch(() => []),
      ])
      return {
        submodules,
        // The row for the repository itself is not a child of itself.
        worktrees: worktrees.filter((row) => row.path.replace(/\\/g, '/') !== root.replace(/\\/g, '/')),
      }
    },

    /** Drop cached roots and briefs (after a clone, a checkout, an init). */
    invalidate(root) {
      if (root === undefined) {
        roots.clear()
        briefs.clear()
        return
      }
      briefs.delete(root)
    },
  }
}
