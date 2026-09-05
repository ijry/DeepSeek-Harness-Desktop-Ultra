/**
 * Transfers: the task ledger the drawer shows, and the four ways bytes move.
 *
 *   browser → remote     an upload streamed out of the page's file input
 *   remote  → browser    a download (a file, or a whole folder as one tar stream)
 *   workspace → remote    a recursive upload from a folder DSH has open
 *   remote → workspace    a recursive download into a folder DSH has open
 *
 * Progress is emitted on a timer, not per file. The reference emitted one event
 * before each file and one after, which means a single 4 GB file showed a frozen
 * bar from start to finish, and fifty thousand small files produced a hundred
 * thousand events into a 4096-entry queue that silently dropped the oldest. Here a
 * task coalesces into at most one frame every `PROGRESS_INTERVAL_MS`, plus one at
 * every state change, so both shapes report honestly.
 *
 * @module dsh-plugin-otools-term/host/transfer
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { baseRemote, ERR, joinRemote, newId, parentRemote, TermError } from '../shared/protocol.js'
import { entry as tarEntry, padding as tarPadding, trailer as tarTrailer } from './tar.js'

/** Fastest a task's progress frame is repeated. */
export const PROGRESS_INTERVAL_MS = 250

/** Copy buffer for the SFTP streams. 32 KB matched the reference; 64 KB is faster. */
export const CHUNK_BYTES = 64 * 1024

/** How many finished tasks are kept in the drawer. */
export const MAX_TASKS = 200

/** One transfer task. */
class Task {
  constructor(fields) {
    this.id = fields.id
    this.kind = fields.kind
    this.serverId = fields.serverId
    this.source = fields.source
    this.target = fields.target
    this.status = 'pending'
    this.progress = 0
    this.bytesTotal = fields.bytesTotal ?? 0
    this.bytesTransferred = 0
    this.totalFiles = fields.totalFiles ?? 0
    this.completedFiles = 0
    this.currentItem = ''
    this.error = ''
    this.startedAt = Date.now()
    this.finishedAt = null
    this.controller = new AbortController()
    this.lastEmit = 0
  }

  /** The record the browser sees (never the AbortController). */
  describe() {
    return {
      id: this.id,
      kind: this.kind,
      serverId: this.serverId,
      source: this.source,
      target: this.target,
      status: this.status,
      progress: this.progress,
      bytesTotal: this.bytesTotal,
      bytesTransferred: this.bytesTransferred,
      totalFiles: this.totalFiles,
      completedFiles: this.completedFiles,
      currentItem: this.currentItem,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    }
  }

  /** Recompute the percentage from whichever counter is meaningful. */
  recompute() {
    if (this.bytesTotal > 0) {
      this.progress = Math.max(0, Math.min(100, (this.bytesTransferred / this.bytesTotal) * 100))
      return
    }
    if (this.totalFiles > 0) {
      this.progress = Math.max(0, Math.min(100, (this.completedFiles / this.totalFiles) * 100))
      return
    }
    this.progress = this.status === 'completed' ? 100 : 0
  }
}

/** The ledger. */
export class TransferRegistry {
  constructor(options) {
    this.hub = options.hub
    this.tasks = new Map()
  }

  /** Start tracking one task. */
  create(fields) {
    const task = new Task({ id: newId('task'), ...fields })
    this.tasks.set(task.id, task)
    this.trim()
    this.emit(task, true)
    return task
  }

  /** Every task, newest first. */
  list() {
    return [...this.tasks.values()].sort((left, right) => right.startedAt - left.startedAt).map((task) => task.describe())
  }

  /** One task or a not-found failure. */
  require(taskId) {
    const task = this.tasks.get(taskId)
    if (task === undefined) throw new TermError(ERR.notFound, `没有这个传输任务：${taskId}`)
    return task
  }

  /** Move a task to `transferring` and stamp what it is doing. */
  begin(task, patch = {}) {
    task.status = 'transferring'
    Object.assign(task, patch)
    task.recompute()
    this.emit(task, true)
  }

  /** Update counters; the frame is throttled unless `force`. */
  update(task, patch = {}, force = false) {
    Object.assign(task, patch)
    task.recompute()
    this.emit(task, force)
  }

  /** Finish a task, successfully or not. */
  finish(task, { status, error } = {}) {
    task.status = status ?? 'completed'
    task.error = error === undefined || error === null ? '' : (error.message ?? String(error))
    task.finishedAt = Date.now()
    if (task.status === 'completed') {
      task.progress = 100
      if (task.totalFiles > 0) task.completedFiles = task.totalFiles
    } else {
      task.recompute()
    }
    this.emit(task, true)
    return task.describe()
  }

  /** Ask a running task to stop. */
  cancel(taskId) {
    const task = this.require(taskId)
    if (task.status !== 'pending' && task.status !== 'transferring') return task.describe()
    task.controller.abort()
    return this.finish(task, { status: 'failed', error: new Error('已取消') })
  }

  /** Drop finished rows. */
  clearFinished() {
    for (const [id, task] of [...this.tasks]) {
      if (task.status === 'completed' || task.status === 'failed') this.tasks.delete(id)
    }
    this.hub.broadcast('tasks', { tasks: this.list() })
    return this.list()
  }

  /** Keep the ledger bounded. */
  trim() {
    if (this.tasks.size <= MAX_TASKS) return
    const finished = [...this.tasks.values()]
      .filter((task) => task.status === 'completed' || task.status === 'failed')
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const task of finished) {
      if (this.tasks.size <= MAX_TASKS) break
      this.tasks.delete(task.id)
    }
  }

  /** Send one task frame, honouring the throttle. */
  emit(task, force) {
    const now = Date.now()
    if (!force && now - task.lastEmit < PROGRESS_INTERVAL_MS) return
    task.lastEmit = now
    this.hub.broadcast('task', task.describe())
  }

  /** Abort everything (plugin teardown). */
  dispose() {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'transferring') task.controller.abort()
    }
    this.tasks.clear()
  }
}

/** Throw when a task was cancelled. */
function checkAborted(task) {
  if (task.controller.signal.aborted) throw new TermError(ERR.transfer, '传输已取消')
}

/**
 * Stream one request body into a remote file.
 *
 * `bytesTotal` comes from the request's content-length when it has one; a chunked
 * upload reports bytes without a percentage rather than pretending to know.
 */
export async function uploadFromStream({ sftp, registry, task, remotePath, source }) {
  registry.begin(task, { currentItem: baseRemote(remotePath), totalFiles: 1 })
  const channel = await sftp.channel()
  await sftp.ensureParents(channel, parentRemote(remotePath))
  const out = channel.createWriteStream(remotePath, { flags: 'w', highWaterMark: CHUNK_BYTES })
  source.on('data', (chunk) => {
    registry.update(task, { bytesTransferred: task.bytesTransferred + chunk.length })
  })
  try {
    await pipeline(source, out, { signal: task.controller.signal })
  } catch (error) {
    registry.finish(task, { status: 'failed', error })
    throw error instanceof TermError ? error : new TermError(ERR.transfer, `上传失败：${error?.message ?? error}`)
  }
  registry.update(task, { completedFiles: 1 }, true)
  return registry.finish(task, { status: 'completed' })
}

/**
 * Stream one remote file into an HTTP response.
 *
 * The response is the browser's download, so the task record exists only so the
 * drawer can show it — the page's own download indicator is the real progress bar.
 */
export async function downloadToStream({ sftp, registry, task, remotePath, sink }) {
  registry.begin(task, { currentItem: baseRemote(remotePath), totalFiles: 1 })
  const stream = await sftp.readStream(remotePath, { highWaterMark: CHUNK_BYTES })
  stream.on('data', (chunk) => {
    registry.update(task, { bytesTransferred: task.bytesTransferred + chunk.length })
  })
  try {
    await pipeline(stream, sink, { signal: task.controller.signal })
  } catch (error) {
    registry.finish(task, { status: 'failed', error })
    throw error instanceof TermError ? error : new TermError(ERR.transfer, `下载失败：${error?.message ?? error}`)
  }
  registry.update(task, { completedFiles: 1 }, true)
  return registry.finish(task, { status: 'completed' })
}

/** Stream a whole remote directory into an HTTP response as one tar archive. */
export async function downloadTreeAsTar({ sftp, registry, task, remotePath, sink }) {
  const walk = await sftp.walk(remotePath)
  const rootName = baseRemote(walk.root) || 'download'
  registry.begin(task, {
    totalFiles: walk.files.length,
    bytesTotal: walk.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
  })

  const write = async (buffer) => {
    if (buffer.length === 0) return
    if (!sink.write(buffer)) {
      await new Promise((resolvePromise) => sink.once('drain', resolvePromise))
    }
  }
  const nameOf = (path) => {
    const rel = path === walk.root ? '' : path.slice(walk.root.length).replace(/^\//, '')
    return rel.length === 0 ? rootName : `${rootName}/${rel}`
  }

  let index = 0
  for (const dir of walk.dirs) {
    checkAborted(task)
    index += 1
    for (const part of tarEntry({ name: nameOf(dir), size: 0, type: '5', mode: 0o755 }, index)) await write(part)
  }
  for (const file of walk.files) {
    checkAborted(task)
    index += 1
    registry.update(task, { currentItem: baseRemote(file.path) })
    const size = file.size ?? 0
    for (const part of tarEntry({ name: nameOf(file.path), size, type: '0', mode: 0o644 }, index)) await write(part)
    let written = 0
    const stream = await sftp.readStream(file.path, { highWaterMark: CHUNK_BYTES })
    for await (const chunk of stream) {
      checkAborted(task)
      // A file that grew since the walk would desynchronise the archive, so the
      // entry is written at exactly the size its header promised.
      const room = size - written
      if (room <= 0) break
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      written += slice.length
      await write(slice)
      registry.update(task, { bytesTransferred: task.bytesTransferred + slice.length })
    }
    if (written < size) await write(Buffer.alloc(size - written))
    await write(tarPadding(size))
    registry.update(task, { completedFiles: task.completedFiles + 1 }, true)
  }
  await write(tarTrailer())
  return registry.finish(task, { status: 'completed' })
}

/** Recursively upload a local file or folder (inside a workspace) to a remote dir. */
export async function uploadTree({ sftp, registry, task, localPath, remoteDir }) {
  const info = await stat(localPath)
  const files = []
  const dirs = []
  if (info.isDirectory()) {
    await collectLocal(localPath, files, dirs)
  } else {
    files.push({ path: localPath, size: info.size })
  }
  const base = basename(localPath)
  const remoteRoot = joinRemote(remoteDir, base)
  registry.begin(task, {
    totalFiles: files.length,
    bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
    target: remoteRoot,
  })

  const channel = await sftp.channel()
  const remoteOf = (localFile) => {
    if (!info.isDirectory()) return remoteRoot
    const rel = relative(localPath, localFile).split(/[\\/]/).filter((part) => part.length > 0)
    return rel.length === 0 ? remoteRoot : joinRemote(remoteRoot, rel.join('/'))
  }

  try {
    if (info.isDirectory()) {
      await sftp.ensureParents(channel, remoteRoot)
      for (const dir of dirs) {
        checkAborted(task)
        await sftp.ensureParents(channel, remoteOf(dir))
      }
    } else {
      await sftp.ensureParents(channel, remoteDir)
    }
    for (const file of files) {
      checkAborted(task)
      const remotePath = remoteOf(file.path)
      registry.update(task, { currentItem: basename(file.path) })
      await sftp.ensureParents(channel, parentRemote(remotePath))
      const out = channel.createWriteStream(remotePath, { flags: 'w', highWaterMark: CHUNK_BYTES })
      const input = createReadStream(file.path, { highWaterMark: CHUNK_BYTES })
      input.on('data', (chunk) => {
        registry.update(task, { bytesTransferred: task.bytesTransferred + chunk.length })
      })
      await pipeline(input, out, { signal: task.controller.signal })
      registry.update(task, { completedFiles: task.completedFiles + 1 }, true)
    }
  } catch (error) {
    registry.finish(task, { status: 'failed', error })
    throw error instanceof TermError ? error : new TermError(ERR.transfer, `上传失败：${error?.message ?? error}`)
  }
  return registry.finish(task, { status: 'completed' })
}

/** Recursively download a remote file or folder into a local (workspace) folder. */
export async function downloadTree({ sftp, registry, task, remotePath, localDir }) {
  const walk = await sftp.walk(remotePath)
  const base = baseRemote(walk.root)
  const localRoot = join(localDir, base)
  registry.begin(task, {
    totalFiles: walk.files.length,
    bytesTotal: walk.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
    target: localRoot,
  })

  const localOf = (remoteFile) => {
    if (!walk.isDirectory) return localRoot
    const rel = remoteFile.slice(walk.root.length).replace(/^\//, '')
    return rel.length === 0 ? localRoot : join(localRoot, ...rel.split('/'))
  }

  try {
    if (walk.isDirectory) {
      await mkdir(localRoot, { recursive: true })
      for (const dir of walk.dirs) {
        checkAborted(task)
        await mkdir(localOf(dir), { recursive: true })
      }
    } else {
      await mkdir(dirname(localRoot), { recursive: true })
    }
    for (const file of walk.files) {
      checkAborted(task)
      const target = localOf(file.path)
      registry.update(task, { currentItem: baseRemote(file.path) })
      await mkdir(dirname(target), { recursive: true })
      const stream = await sftp.readStream(file.path, { highWaterMark: CHUNK_BYTES })
      stream.on('data', (chunk) => {
        registry.update(task, { bytesTransferred: task.bytesTransferred + chunk.length })
      })
      await pipeline(stream, createWriteStream(target), { signal: task.controller.signal })
      registry.update(task, { completedFiles: task.completedFiles + 1 }, true)
    }
  } catch (error) {
    registry.finish(task, { status: 'failed', error })
    throw error instanceof TermError ? error : new TermError(ERR.transfer, `下载失败：${error?.message ?? error}`)
  }
  return registry.finish(task, { status: 'completed' })
}

/** Depth-first local walk, collecting files with sizes and every directory. */
async function collectLocal(dir, files, dirs, depth = 0) {
  if (depth > 40) throw new TermError(ERR.tooLarge, '本机目录层级过深')
  dirs.push(dir)
  const rows = await readdir(dir, { withFileTypes: true })
  for (const row of rows) {
    const full = join(dir, row.name)
    // Symlinks are skipped rather than followed: a link back up the tree turns a
    // recursive upload into an infinite one.
    if (row.isSymbolicLink()) continue
    if (row.isDirectory()) {
      await collectLocal(full, files, dirs, depth + 1)
      continue
    }
    if (!row.isFile()) continue
    const info = await stat(full)
    files.push({ path: full, size: info.size })
  }
  if (files.length > 200_000) throw new TermError(ERR.tooLarge, '本机文件数量过多，请分批传输')
}
