/**
 * SFTP: directory listings, the file operations the context menu offers, the
 * remote search, and the byte streams the transfer engine moves.
 *
 * Everything here goes through the ONE SFTP channel `host/ssh.js` keeps per
 * server. The reference opened a fresh SSH connection per SFTP browser and a
 * second one for every remote search.
 *
 * Two differences from the reference worth knowing:
 *
 *  - Listings use the attributes `readdir` already returned (which are lstat-like
 *    on OpenSSH), so a symlink is REPORTED as a symlink instead of silently
 *    showing up as whatever it points at. Only the symlinks get a follow-up stat,
 *    to learn whether they lead to a directory, so a folder of 5000 regular files
 *    still costs one round trip.
 *  - `permissions` is a real mode plus its `rwxr-xr-x` spelling, and there is a
 *    chmod. The reference carried a raw octal string into the browser and never
 *    displayed it.
 *
 * @module dsh-plugin-otools-term/host/sftp
 */
import {
  baseRemote,
  ERR,
  formatMode,
  joinRemote,
  MAX_EDIT_BYTES,
  normalizeRemotePath,
  parentRemote,
  shellQuote,
  TermError,
} from '../shared/protocol.js'

/** POSIX file-type bits. */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/** Cap on entries returned for one directory (a listing, not a database). */
export const MAX_ENTRIES = 5_000

/** Cap on search hits, matching the reference's 200. */
export const SEARCH_LIMIT = 200

/** Wrap an ssh2 SFTP error, keeping its numeric code for the caller. */
function sftpError(error, action, path) {
  const code = error?.code
  const message = error?.message ?? String(error)
  // 2 = SSH_FX_NO_SUCH_FILE, 3 = SSH_FX_PERMISSION_DENIED, 4 = FAILURE, 11 = ALREADY EXISTS
  if (code === 2) return new TermError(ERR.notFound, `${action}失败：${path} 不存在`)
  if (code === 3) return new TermError(ERR.sftp, `${action}失败：没有权限访问 ${path}`)
  if (code === 11) return new TermError(ERR.sftp, `${action}失败：${path} 已存在`)
  return new TermError(ERR.sftp, `${action}失败：${message}`)
}

/** Promisify one SFTP call. */
function call(sftp, method, args, action, path) {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp[method](...args, (error, value) => {
      if (error !== undefined && error !== null) {
        rejectPromise(sftpError(error, action, path))
        return
      }
      resolvePromise(value)
    })
  })
}

/** One directory entry as the browser sees it. */
function entryOf(path, name, attrs, linkTarget) {
  const mode = typeof attrs?.mode === 'number' ? attrs.mode : 0
  const type = mode & S_IFMT
  const isLink = type === S_IFLNK
  return {
    name,
    path,
    isDirectory: type === S_IFDIR,
    isFile: type === S_IFREG,
    isSymlink: isLink,
    linkTarget,
    size: typeof attrs?.size === 'number' ? attrs.size : null,
    mode: mode & 0o7777,
    permissions: formatMode(mode),
    uid: attrs?.uid ?? null,
    gid: attrs?.gid ?? null,
    mtime: typeof attrs?.mtime === 'number' ? attrs.mtime * 1000 : null,
  }
}

/** The SFTP façade for one connection. */
export class SftpFace {
  constructor(connection) {
    this.connection = connection
  }

  /** The shared SFTP channel. */
  async channel() {
    return await this.connection.sftp()
  }

  /** Resolve `.`, `~` and relative paths into one absolute remote path. */
  async resolve(path) {
    const sftp = await this.channel()
    const wanted = path === undefined || path === null || path === '' ? '.' : normalizeRemotePath(path)
    if (wanted.startsWith('/')) return wanted
    // `~` is a shell concept, not an SFTP one: OpenSSH's SFTP server resolves '.'
    // to the login directory, so that is what a leading ~ becomes.
    const relative = wanted === '~' ? '.' : wanted.replace(/^~\//, '')
    const absolute = await call(sftp, 'realpath', [relative === '~' ? '.' : relative], '解析路径', wanted)
    return normalizeRemotePath(absolute)
  }

  /** One directory, sorted directories-first then by name (the reference's order). */
  async list(path) {
    const sftp = await this.channel()
    const dir = await this.resolve(path)
    const rows = await call(sftp, 'readdir', [dir], '读取目录', dir)
    const entries = []
    for (const row of rows.slice(0, MAX_ENTRIES)) {
      const name = String(row.filename)
      if (name === '.' || name === '..') continue
      entries.push(entryOf(joinRemote(dir, name), name, row.attrs, undefined))
    }
    // Only the symlinks need a second round trip, to learn where they lead.
    await Promise.all(entries.filter((entry) => entry.isSymlink).map(async (entry) => {
      try {
        const target = await call(sftp, 'readlink', [entry.path], '读取链接', entry.path)
        entry.linkTarget = String(target)
      } catch { /* a dangling link still lists */ }
      try {
        const stats = await call(sftp, 'stat', [entry.path], '读取属性', entry.path)
        entry.isDirectory = (stats.mode & S_IFMT) === S_IFDIR
        entry.isFile = (stats.mode & S_IFMT) === S_IFREG
        if (entry.isFile) entry.size = stats.size
      } catch { /* dangling: leave it as a link */ }
    }))
    entries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-Hans-CN')
    })
    return { path: dir, parent: parentRemote(dir), entries, truncated: rows.length > MAX_ENTRIES }
  }

  /** stat, following links. */
  async stat(path) {
    const sftp = await this.channel()
    const target = await this.resolve(path)
    const attrs = await call(sftp, 'stat', [target], '读取属性', target)
    return entryOf(target, baseRemote(target), attrs, undefined)
  }

  /** lstat, NOT following links (the delete path needs the truth about links). */
  async lstat(path) {
    const sftp = await this.channel()
    const target = normalizeRemotePath(path)
    const attrs = await call(sftp, 'lstat', [target], '读取属性', target)
    return entryOf(target, baseRemote(target), attrs, undefined)
  }

  /** Create one directory (parents included, like `mkdir -p`). */
  async mkdir(path) {
    const sftp = await this.channel()
    const target = await this.resolveForCreate(path)
    await this.ensureParents(sftp, parentRemote(target))
    await call(sftp, 'mkdir', [target], '创建文件夹', target)
    return target
  }

  /** Create every missing parent of a path. */
  async ensureParents(sftp, dir) {
    if (dir === '/' || dir === '' || dir === '.') return
    try {
      const attrs = await call(sftp, 'stat', [dir], '读取属性', dir)
      if ((attrs.mode & S_IFMT) === S_IFDIR) return
      throw new TermError(ERR.sftp, `${dir} 已存在且不是文件夹`)
    } catch (error) {
      if (error instanceof TermError && error.code !== ERR.notFound) throw error
    }
    await this.ensureParents(sftp, parentRemote(dir))
    try {
      await call(sftp, 'mkdir', [dir], '创建文件夹', dir)
    } catch (error) {
      // Tolerate a concurrent create: what matters is that it exists now.
      const attrs = await call(sftp, 'stat', [dir], '读取属性', dir).catch(() => undefined)
      if (attrs === undefined) throw error
    }
  }

  /** A path for a NEW entry: resolved against its parent, since it does not exist. */
  async resolveForCreate(path) {
    const wanted = normalizeRemotePath(path)
    if (wanted.startsWith('/')) return wanted
    const parent = await this.resolve(parentRemote(wanted))
    return joinRemote(parent, baseRemote(wanted))
  }

  /** Create one empty file. */
  async createFile(path) {
    const sftp = await this.channel()
    const target = await this.resolveForCreate(path)
    await this.ensureParents(sftp, parentRemote(target))
    const handle = await call(sftp, 'open', [target, 'wx'], '创建文件', target)
    await call(sftp, 'close', [handle], '创建文件', target)
    return target
  }

  /** Rename or move. */
  async rename(from, to) {
    const sftp = await this.channel()
    const source = await this.resolve(from)
    const target = await this.resolveForCreate(to)
    await call(sftp, 'rename', [source, target], '重命名', source)
    return { from: source, to: target }
  }

  /** chmod one entry (no recursion — a recursive chmod is a footgun, not a feature). */
  async chmod(path, mode) {
    const sftp = await this.channel()
    const target = await this.resolve(path)
    await call(sftp, 'chmod', [target, mode], '修改权限', target)
    return { path: target, mode, permissions: formatMode(mode) }
  }

  /** Delete a file, a link, or a whole directory tree. */
  async remove(path) {
    const sftp = await this.channel()
    const target = await this.resolve(path)
    if (target === '/') throw new TermError(ERR.invalidInput, '不允许删除根目录')
    const info = await this.lstat(target)
    if (info.isDirectory && !info.isSymlink) {
      await this.removeTree(sftp, target)
      return { path: target, isDirectory: true }
    }
    // A symlink is unlinked, never followed — deleting a link to /etc must not
    // delete /etc.
    await call(sftp, 'unlink', [target], '删除', target)
    return { path: target, isDirectory: false }
  }

  /** Depth-first directory removal. */
  async removeTree(sftp, dir) {
    const rows = await call(sftp, 'readdir', [dir], '读取目录', dir)
    for (const row of rows) {
      const name = String(row.filename)
      if (name === '.' || name === '..') continue
      const child = joinRemote(dir, name)
      const type = (row.attrs?.mode ?? 0) & S_IFMT
      if (type === S_IFDIR) await this.removeTree(sftp, child)
      else await call(sftp, 'unlink', [child], '删除', child)
    }
    await call(sftp, 'rmdir', [dir], '删除文件夹', dir)
  }

  /** Read one file for the editor, with a hard size cap. */
  async readFile(path) {
    const sftp = await this.channel()
    const target = await this.resolve(path)
    const attrs = await call(sftp, 'stat', [target], '读取属性', target)
    if (typeof attrs.size === 'number' && attrs.size > MAX_EDIT_BYTES) {
      throw new TermError(ERR.tooLarge, `文件过大：${Math.round(attrs.size / 1024)} KB，编辑器上限 ${MAX_EDIT_BYTES / 1024} KB`)
    }
    const buffer = await new Promise((resolvePromise, rejectPromise) => {
      sftp.readFile(target, (error, data) => {
        if (error !== undefined && error !== null) {
          rejectPromise(sftpError(error, '读取文件', target))
          return
        }
        resolvePromise(data)
      })
    })
    // Binary is reported rather than mangled: a lone 0x00 means this is not a text
    // file, and handing the editor a lossy decode would let a save destroy it.
    const binary = buffer.includes(0)
    return {
      path: target,
      size: buffer.length,
      binary,
      content: binary ? '' : buffer.toString('utf8'),
      permissions: formatMode(attrs.mode),
      mode: attrs.mode & 0o7777,
      mtime: typeof attrs.mtime === 'number' ? attrs.mtime * 1000 : null,
    }
  }

  /** Write one file from the editor. */
  async writeFile(path, content) {
    const sftp = await this.channel()
    const target = await this.resolve(path)
    const data = Buffer.from(String(content), 'utf8')
    if (data.length > MAX_EDIT_BYTES) throw new TermError(ERR.tooLarge, '内容超过编辑器上限')
    await this.ensureParents(sftp, parentRemote(target))
    await new Promise((resolvePromise, rejectPromise) => {
      sftp.writeFile(target, data, (error) => {
        if (error !== undefined && error !== null) {
          rejectPromise(sftpError(error, '写入文件', target))
          return
        }
        resolvePromise(undefined)
      })
    })
    const attrs = await call(sftp, 'stat', [target], '读取属性', target).catch(() => undefined)
    return { path: target, size: data.length, mtime: attrs?.mtime === undefined ? null : attrs.mtime * 1000 }
  }

  /** A read stream for a download. */
  async readStream(path, options) {
    const sftp = await this.channel()
    return sftp.createReadStream(path, options)
  }

  /** A write stream for an upload. */
  async writeStream(path, options) {
    const sftp = await this.channel()
    return sftp.createWriteStream(path, options)
  }

  /**
   * Walk a remote tree, returning every file with its size. Used to compute a
   * transfer's totals before it starts, so the progress bar means something.
   */
  async walk(root, { maxEntries = 200_000 } = {}) {
    const sftp = await this.channel()
    const start = await this.resolve(root)
    const info = await this.lstat(start)
    if (!info.isDirectory) return { root: start, isDirectory: false, files: [{ path: start, size: info.size ?? 0 }], dirs: [] }
    const files = []
    const dirs = []
    const queue = [start]
    while (queue.length > 0) {
      const dir = queue.shift()
      dirs.push(dir)
      const rows = await call(sftp, 'readdir', [dir], '读取目录', dir)
      for (const row of rows) {
        const name = String(row.filename)
        if (name === '.' || name === '..') continue
        const child = joinRemote(dir, name)
        const type = (row.attrs?.mode ?? 0) & S_IFMT
        if (type === S_IFDIR) {
          queue.push(child)
          continue
        }
        // Links are copied as their target's bytes when the target is a file, and
        // skipped otherwise; a recursive copy that follows a link to `/` is a
        // classic way to fill a disk.
        if (type === S_IFLNK) {
          const stats = await call(sftp, 'stat', [child], '读取属性', child).catch(() => undefined)
          if (stats === undefined || (stats.mode & S_IFMT) !== S_IFREG) continue
          files.push({ path: child, size: stats.size ?? 0 })
          continue
        }
        files.push({ path: child, size: row.attrs?.size ?? 0 })
      }
      if (files.length + dirs.length > maxEntries) {
        throw new TermError(ERR.tooLarge, `目录条目超过 ${maxEntries}，请分批传输`)
      }
    }
    return { root: start, isDirectory: true, files, dirs }
  }

  /**
   * Remote search. Shells out to `find`, exactly as the reference did, because a
   * client-side recursive readdir over a deep tree is thousands of round trips.
   *
   * Every interpolated value is single-quoted through `shellQuote`; the keyword is
   * matched case-insensitively with `-iname`, and the result count is capped on the
   * remote side so a match against `/` cannot stream forever.
   */
  async search(root, keyword, limit = SEARCH_LIMIT) {
    const term = String(keyword ?? '').trim()
    if (term.length === 0) return { items: [], truncated: false }
    const capped = Math.max(1, Math.min(limit, SEARCH_LIMIT))
    const start = await this.resolve(root === undefined || root === '' ? '/' : root)
    const pattern = shellQuote(`*${term}*`)
    const command =
      `find ${shellQuote(start)} \\( -type d -o -type f -o -type l \\) -iname ${pattern} ` +
      `-printf '%y\\t%p\\n' 2>/dev/null | head -n ${capped + 1}`
    // -printf is GNU find; BSD/macOS find lacks it, so a second shape is tried.
    const fallback =
      `find ${shellQuote(start)} \\( -type d -o -type f -o -type l \\) -iname ${pattern} ` +
      `-exec sh -c 'for p do if [ -d "$p" ]; then printf "d\\t%s\\n" "$p"; else printf "f\\t%s\\n" "$p"; fi; done' sh {} + ` +
      `2>/dev/null | head -n ${capped + 1}`

    let out = await this.connection.exec(command, { timeoutMs: 120_000, maxBytes: 1024 * 1024 })
    if (out.stdout.trim().length === 0) {
      out = await this.connection.exec(fallback, { timeoutMs: 120_000, maxBytes: 1024 * 1024 })
    }
    const lines = out.stdout.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0)
    const truncated = lines.length > capped
    const items = lines.slice(0, capped).map((line) => {
      const cut = line.indexOf('\t')
      const kind = cut === -1 ? 'f' : line.slice(0, cut)
      const path = normalizeRemotePath(cut === -1 ? line : line.slice(cut + 1))
      return { path, name: baseRemote(path), parent: parentRemote(path), isDirectory: kind === 'd' }
    })
    items.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.path.localeCompare(right.path)
    })
    return { items, truncated }
  }
}
