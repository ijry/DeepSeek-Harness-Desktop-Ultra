/**
 * The local side of a transfer, bounded by DSH's own workspace registry.
 *
 * The reference ran inside a desktop shell, so "upload a file" meant opening a
 * native file dialog and "download" meant picking a folder — the browser half
 * could name any path on the machine because a human had just pointed at it. In a
 * web GUI there is no such dialog, and a page that can name any path is a page
 * that can read `~/.ssh/id_rsa` and write into `~/.bashrc`. So the local
 * filesystem is reachable exactly two ways:
 *
 *  1. Through the browser itself — a file input or a drag from the desktop for
 *     upload, a download response for the other direction. The bytes pass through
 *     the page, and the host never names a local path at all.
 *  2. Through a REGISTERED WORKSPACE — the folders the user already opened in DSH.
 *     A request names `{workspaceId, relative}`, and this module resolves it inside
 *     that workspace's root or refuses.
 *
 * That second door is what keeps the reference's recursive folder transfers
 * working where they matter (your project directory) without handing the page the
 * whole disk. The containment test compares with a trailing separator, so a
 * sibling directory sharing a prefix (`<root>-secrets`) is not inside `<root>`.
 *
 * @module dsh-plugin-otools-term/host/workspaces
 */
import { mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ERR, TermError } from '../shared/protocol.js'

/** Adapt DSH's workspace registry to the narrow face this plugin needs. */
export function workspaceFace(registry) {
  const toView = (ws) => (ws === undefined || ws === null
    ? undefined
    : { id: ws.id, path: ws.path, title: ws.title ?? basename(ws.path) })
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

/** A registry face that knows no workspaces (a build without the service). */
export function emptyWorkspaces() {
  return { list: () => [], get: () => undefined }
}

/** Whether `child` is `root` or inside it. */
export function isInside(root, child) {
  const from = resolve(root)
  const to = resolve(child)
  if (from === to) return true
  const rel = relative(from, to)
  if (rel.length === 0) return true
  // `..` at the front means the path climbed out; an absolute result means it
  // landed on another drive entirely (Windows).
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/** The local-path resolver the transfer routes use. */
export function createLocalPaths(workspaces) {
  return {
    /** Every workspace, for the transfer target picker. */
    list() {
      return workspaces.list()
    },

    /**
     * Resolve `{workspaceId, relative}` into an absolute path inside that
     * workspace. `relative` may be empty (the workspace root itself).
     */
    resolve(input) {
      const raw = input !== null && typeof input === 'object' ? input : {}
      const id = typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : ''
      if (id.length === 0) throw new TermError(ERR.invalidInput, 'workspaceId 是必填的')
      const workspace = workspaces.get(id)
      if (workspace === undefined) throw new TermError(ERR.notFound, `没有这个工作区：${id}`)
      const rel = typeof raw.relative === 'string' ? raw.relative.trim() : ''
      if (rel.includes('\0')) throw new TermError(ERR.invalidInput, 'relative 不能包含 NUL')
      const target = rel.length === 0 ? resolve(workspace.path) : resolve(join(workspace.path, rel))
      if (!isInside(workspace.path, target)) {
        throw new TermError(ERR.invalidInput, '目标路径超出了这个工作区')
      }
      return { workspace, path: target }
    },

    /** Resolve and require that the path exists, reporting what kind it is. */
    async resolveExisting(input) {
      const { workspace, path } = this.resolve(input)
      let info
      try {
        info = await stat(path)
      } catch (error) {
        throw new TermError(ERR.notFound, `本机路径不存在：${path}（${error.code ?? 'ERR'}）`)
      }
      return { workspace, path, isDirectory: info.isDirectory(), size: info.isFile() ? info.size : 0 }
    },

    /**
     * Resolve a DOWNLOAD target, creating it when it is not there yet.
     *
     * Asking the user to go and create the folder first would be pointless: the path
     * is already constrained to a workspace they opened, so making it is no more
     * authority than writing the files into it.
     */
    async resolveTargetDirectory(input) {
      const { workspace, path } = this.resolve(input)
      try {
        const info = await stat(path)
        if (!info.isDirectory()) throw new TermError(ERR.invalidInput, `${path} 不是一个目录`)
      } catch (error) {
        if (error instanceof TermError) throw error
        if (error.code !== 'ENOENT') throw new TermError(ERR.invalidInput, `无法使用本机路径：${path}（${error.code}）`)
        await mkdir(path, { recursive: true })
      }
      return { workspace, path, isDirectory: true }
    },
  }
}
