/**
 * The safe-write primitive: snapshot, atomic replace, concurrency guard, rollback.
 *
 * This is the one part of the reference (`config_writer/mod.rs`) worth transcribing almost
 * line for line, because it is the part that touches files the user did not ask us to
 * touch — `~/.codex/config.toml`, `~/.claude/settings.json` — and getting it wrong loses
 * someone's hand-tuned CLI configuration.
 *
 * The rules, in order:
 *
 * 1. Refuse anything that is not a regular file in a real directory. A symlink (or a
 *    Windows junction) in the path is a redirection we did not authorize, so it is an
 *    error rather than something to follow.
 * 2. Hash before and after. The hash taken at inspect time is re-checked immediately
 *    before the replace, so a file the CLI rewrote while the dialog was open is reported
 *    as `config.concurrent_modification` instead of being clobbered.
 * 3. Replace atomically: write a sibling temp file, fsync it, rename over the target.
 *    `fs.rename` maps to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` on Windows and to
 *    `rename(2)` elsewhere, so the target is never observed half-written.
 * 4. Verify what landed. Then, and only then, is the write reported as succeeded.
 * 5. Keep the original bytes in a private 0600 backup so rollback is byte-exact.
 *
 * One honest gap versus Rust: Node cannot read `FILE_ATTRIBUTE_REPARSE_POINT`, so on
 * Windows the symlink check is `lstat().isSymbolicLink()`, which libuv reports for
 * symlinks and junctions but not for every exotic reparse point.
 *
 * @module dsh-plugin-ai-switch/host/configwrite/safewrite
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { ApiError } from '../../shared/protocol.js'
import { uuid } from '../sdk.js'

const unsafePath = (path, why) =>
  new ApiError('config.path_unsafe', 'Configuration path is unsafe', {
    details: `${path}: ${why}`,
    recoverable: false,
  })

/** sha256 of the exact bytes, lowercase hex — the same digest the ledger stores. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Normalize a path for identity comparisons: locks, and the snapshot-path check that
 * refuses to roll back a file the adapter no longer resolves to.
 *
 * Lexical only — never `realpath`, because resolving symlinks would defeat the very
 * check above. Lowercased on Windows, where two spellings are one file.
 */
export function normalizePath(path) {
  const absolute = resolve(String(path ?? ''))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

async function assertSafeParent(path) {
  const parent = dirname(path)
  let info
  try {
    info = await lstat(parent)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // A parent that does not exist yet is fine: prepareParent creates it.
      return
    }
    throw unsafePath(parent, String(error?.code ?? error))
  }
  if (info.isSymbolicLink()) {
    throw unsafePath(parent, 'parent directory is a link')
  }
  if (!info.isDirectory()) {
    throw unsafePath(parent, 'parent is not a directory')
  }
}

async function assertSafeFile(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    throw unsafePath(path, 'target is a link')
  }
  if (!info.isFile()) {
    throw unsafePath(path, 'target is not a regular file')
  }
  return info
}

/** `{existed, bytes, hash, mode}` — the before-state every write is checked against. */
export async function inspect(path) {
  if (!isAbsolute(path)) {
    throw unsafePath(path, 'path is not absolute')
  }
  await assertSafeParent(path)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { existed: false, bytes: null, hash: null, mode: null }
    }
    throw new ApiError('filesystem.config_inspect', 'Could not read the configuration file', {
      details: `${path}: ${String(error?.code ?? error)}`,
    })
  }
  if (info.isSymbolicLink()) {
    throw unsafePath(path, 'target is a link')
  }
  if (!info.isFile()) {
    throw unsafePath(path, 'target is not a regular file')
  }
  const bytes = await readFile(path)
  // Re-check after the read: between the first lstat and here the file could have been
  // swapped for a link. Narrow, not closed — the same window the reference documents.
  await assertSafeFile(path)
  await assertSafeParent(path)
  return { existed: true, bytes, hash: sha256(bytes), mode: info.mode & 0o777 }
}

async function prepareParent(path) {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  await assertSafeParent(path)
}

/** fsync a directory so the rename is durable. A no-op where the OS refuses. */
async function fsyncDir(path) {
  if (process.platform === 'win32') {
    return
  }
  let handle
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } catch {
    // EISDIR/EINVAL/EPERM depending on the platform and filesystem; the rename itself
    // is still atomic, only the directory entry's durability is best-effort.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Replace `path` with `bytes`, but only if it still looks like `expected`.
 *
 * @returns `{path, before_hash, after_hash, status:'written'}`
 */
export async function writeAtomicIfUnchanged(path, bytes, expected) {
  await prepareParent(path)
  const temporary = join(dirname(path), `.${basename(path)}.${uuid()}.tmp`)
  const mode = expected.mode ?? (process.platform === 'win32' ? undefined : 0o600)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode ?? 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (mode !== undefined) {
      // The mode of the file being replaced wins; a brand new file is private.
      await chmod(temporary, mode).catch(() => {})
    }

    const current = await inspect(path)
    if (current.existed !== expected.existed || current.hash !== expected.hash) {
      throw new ApiError('config.concurrent_modification', 'The configuration file changed while we were writing it', {
        details: path,
        recoverable: true,
      })
    }

    await rename(temporary, path)
    await fsyncDir(dirname(path))

    const after = await inspect(path)
    const wanted = sha256(bytes)
    if (!after.existed || after.hash !== wanted) {
      throw new ApiError('config.verify_failed', 'The configuration file did not contain what we wrote', {
        details: path,
        recoverable: true,
      })
    }
    return { path, before_hash: expected.hash ?? null, after_hash: after.hash, status: 'written' }
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** Keep the original bytes, 0600, refusing to overwrite an existing backup. */
export async function writePrivateBackup(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await chmod(path, 0o600).catch(() => {})
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'EEXIST') {
      throw new ApiError('config.snapshot_failed', 'A backup already exists at that path', { details: path })
    }
    await unlink(path).catch(() => {})
    throw new ApiError('config.snapshot_failed', 'Could not write the configuration backup', {
      details: `${path}: ${String(error?.code ?? error)}`,
    })
  } finally {
    await handle?.close().catch(() => {})
  }
  return path
}

/**
 * Delete a file, but only while it still hashes to what we wrote.
 *
 * This is how a rollback undoes a write that CREATED the file: deleting unconditionally
 * would throw away whatever the CLI has written since.
 */
export async function removeIfHashMatches(path, expectedHash) {
  const current = await inspect(path)
  if (!current.existed || current.hash !== expectedHash) {
    throw new ApiError('config.rollback_conflict', 'The file changed since it was written; not rolling back', {
      details: path,
      recoverable: true,
    })
  }
  try {
    await unlink(path)
  } catch (error) {
    throw new ApiError('config.rollback_failed', 'Could not remove the configuration file', {
      details: `${path}: ${String(error?.code ?? error)}`,
    })
  }
  await fsyncDir(dirname(path))
}

/**
 * One async mutex per normalized path.
 *
 * In-process only, which is all the reference claims too: it stops two panel requests
 * from interleaving read-modify-write on `~/.codex/config.toml`. Cross-process safety is
 * the hash check's job, not this one's.
 */
export class PathLocks {
  constructor() {
    this.chains = new Map()
    this.waiters = new Map()
  }

  /** Run `task` with the locks for every path held; paths are sorted to avoid deadlock. */
  async withPaths(paths, task) {
    const keys = Array.from(new Set(paths.map(normalizePath))).sort()
    const releases = []
    for (const key of keys) {
      const tail = this.chains.get(key) ?? Promise.resolve()
      let release
      const held = new Promise((resolveHeld) => {
        release = resolveHeld
      })
      this.chains.set(key, tail.then(() => held))
      this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1)
      await tail
      releases.push({ key, release })
    }
    try {
      return await task()
    } finally {
      for (const entry of releases) {
        entry.release()
        const left = (this.waiters.get(entry.key) ?? 1) - 1
        if (left <= 0) {
          this.waiters.delete(entry.key)
          this.chains.delete(entry.key)
        } else {
          this.waiters.set(entry.key, left)
        }
      }
    }
  }
}

/** True when `child` is inside `parent` — separator included, so a sibling cannot pass. */
export function isInside(parent, child) {
  const root = normalizePath(parent)
  const target = normalizePath(child)
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}


