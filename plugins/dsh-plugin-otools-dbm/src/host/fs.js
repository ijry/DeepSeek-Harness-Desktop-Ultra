/**
 * Host filesystem routes.
 *
 * The panel needs paths on the machine the databases live on: where to write an
 * export, which .sql file to import, which SQLite file to open, where an SSH key
 * is. A browser cannot answer any of that, so `HostPathPicker.vue` browses through
 * these routes instead.
 *
 * On exposure: these give whoever can reach the dsh web UI a directory listing and
 * a file write. That is not a new capability — dsh's own agent tools (`read`,
 * `write`, `bash`) already do strictly more over the same origin — but it is worth
 * knowing, which is why the README says so under 安全边界. What is NOT offered here
 * is reading file contents: nothing in the panel needs it, so the route does not
 * exist. `get_file_headers` reads only the header row of an import file.
 *
 * @module dsh-plugin-otools-dbm/host/fs
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'

import { DbmError, ERR } from '../shared/protocol.js'

import { pluginHomePath } from './sdk.js'

/** A directory listing longer than this is a mistake to render, not to send. */
const MAX_ENTRIES = 5000

/** Where uploaded markdown images go. */
export const IMAGE_DIR = pluginHomePath('images')

/** The host user's home directory. */
export function homeDir() {
  return homedir()
}

/** Join segments the way the host's platform spells paths. */
export function joinPath(paths) {
  const parts = (Array.isArray(paths) ? paths : [])
    .map((part) => String(part ?? '').trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    return homedir()
  }
  return isAbsolute(parts[0]) ? resolve(join(...parts)) : join(...parts)
}

/** One directory's entries, directories first is the picker's job. */
export async function listDir(path) {
  const target = String(path ?? '').trim().length === 0 ? homedir() : resolve(String(path))
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    throw new DbmError(
      error?.code === 'ENOENT' ? ERR.notFound : ERR.invalidInput,
      `无法读取目录 ${target}：${String(error?.message ?? error)}`,
    )
  }

  const rows = []
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const full = join(target, entry.name)
    let size = 0
    let modifiedAt = 0
    // A stat can fail on a dangling symlink or a locked file; that entry is still
    // worth showing, just without its metadata.
    try {
      const info = await stat(full)
      size = info.size
      modifiedAt = info.mtimeMs
    } catch {
      /* keep the entry with zeroed metadata */
    }
    rows.push({
      name: entry.name,
      path: full,
      isDir: entry.isDirectory(),
      size,
      modifiedAt,
    })
  }

  const parent = parse(target).dir
  return {
    path: target,
    parent: parent === target ? '' : parent,
    entries: rows,
  }
}

/** Create a directory (and its parents). */
export async function createDir(path) {
  const target = requireAbsolute(path, '目录路径')
  await mkdir(target, { recursive: true })
  return target
}

/** Write a file from base64 content, creating parent directories. */
export async function writeBase64File(path, dataBase64) {
  const target = requireAbsolute(path, '文件路径')
  await mkdir(dirname(target), { recursive: true })
  const buffer = Buffer.from(String(dataBase64 ?? ''), 'base64')
  await writeFile(target, buffer)
  return target
}

/** Copy a file the panel produced to wherever the user asked for it. */
export async function copyExportedFile(sourcePath, destinationPath) {
  const from = requireAbsolute(sourcePath, '源文件路径')
  const to = requireAbsolute(destinationPath, '目标文件路径')
  try {
    await stat(from)
  } catch {
    throw new DbmError(ERR.notFound, `源文件不存在: ${from}`)
  }
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  return true
}

/**
 * Reveal a path in the host's file manager.
 *
 * `spawn` with an explicit argv and `shell: false`, so a path with a quote or a
 * semicolon in it is a path and not a command.
 */
export async function revealPath(path) {
  const target = requireAbsolute(path, '路径')
  const { spawn } = await import('node:child_process')
  const platform = process.platform

  let command
  let args
  if (platform === 'win32') {
    command = 'explorer.exe'
    args = [`/select,${target}`]
  } else if (platform === 'darwin') {
    command = 'open'
    args = ['-R', target]
  } else {
    command = 'xdg-open'
    args = [dirname(target)]
  }

  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true })
    child.once('error', (error) =>
      reject(new DbmError(ERR.unsupported, `无法在文件管理器中打开: ${String(error?.message ?? error)}`)),
    )
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
  return true
}

/**
 * The header row of an import file, for the column-mapping step.
 *
 * Only the header is read, never the whole file — a 2 GB CSV must not become 2 GB
 * of host memory just to fill a dropdown.
 */
export async function fileHeaders(path, format) {
  const target = requireAbsolute(path, '文件路径')
  const kind = String(format ?? '').toLowerCase() || guessFormat(target)

  if (kind === 'csv') {
    return csvHeaders(await readFirstLine(target))
  }
  if (kind === 'json') {
    const raw = await readFile(target, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new DbmError(ERR.invalidInput, `JSON 文件解析失败: ${String(error?.message ?? error)}`)
    }
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (first === null || typeof first !== 'object') {
      throw new DbmError(ERR.invalidInput, 'JSON 文件的第一条记录不是对象')
    }
    return Object.keys(first)
  }
  if (kind === 'excel') {
    const ExcelJS = await import('exceljs').then((module) => module?.default ?? module)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(target)
    const sheet = workbook.worksheets[0]
    if (sheet === undefined) {
      throw new DbmError(ERR.invalidInput, 'Excel 文件里没有工作表')
    }
    const header = sheet.getRow(1)
    const names = []
    header.eachCell({ includeEmpty: true }, (cell, index) => {
      const text = cell.text === undefined || cell.text === null ? '' : String(cell.text).trim()
      names.push(text.length > 0 ? text : `Column_${index}`)
    })
    return names
  }
  // A .sql file has no header row: the importer replays statements as they are.
  return []
}

function guessFormat(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    return 'csv'
  }
  if (extension === '.json') {
    return 'json'
  }
  if (extension === '.xlsx' || extension === '.xls') {
    return 'excel'
  }
  return 'sql'
}

/** First line of a text file, without reading the rest. */
async function readFirstLine(path) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const cut = text.search(/\r?\n/)
    return cut === -1 ? text : text.slice(0, cut)
  } finally {
    await handle.close()
  }
}

/** Split a CSV header row, honouring quoted fields with embedded commas. */
export function csvHeaders(line) {
  const text = String(line ?? '').replace(/^﻿/, '')
  const names = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
          continue
        }
        quoted = false
        continue
      }
      field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',' || char === '\t') {
      names.push(field.trim())
      field = ''
      continue
    }
    field += char
  }
  names.push(field.trim())
  return names.map((name, index) => (name.length > 0 ? name : `Column_${index + 1}`))
}

/**
 * Store an image pasted into the markdown editor.
 *
 * The stored name is generated, never the uploaded one: a file called
 * `../../evil.js` must land in the image directory as a random name like every
 * other upload.
 */
export async function saveImage({ fileName, mime, dataBase64 }) {
  const buffer = Buffer.from(String(dataBase64 ?? ''), 'base64')
  if (buffer.length === 0) {
    throw new DbmError(ERR.invalidInput, '上传内容为空')
  }
  if (buffer.length > 16 * 1024 * 1024) {
    throw new DbmError(ERR.tooLarge, '图片超过 16 MB')
  }
  const type = String(mime ?? '').toLowerCase()
  if (type.length > 0 && !type.startsWith('image/')) {
    throw new DbmError(ERR.invalidInput, '只支持上传图片')
  }

  const extension = pickImageExtension(type, String(fileName ?? ''))
  const name = `${randomUUID()}${extension}`
  await mkdir(IMAGE_DIR, { recursive: true })
  await writeFile(join(IMAGE_DIR, name), buffer)
  return {
    name,
    originalName: basename(String(fileName ?? 'image')),
    staticUrl: `/dsh-plugin-otools-dbm/static/images/${name}`,
    size: buffer.length,
  }
}

function pickImageExtension(mime, fileName) {
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
  }[mime]
  if (byMime !== undefined) {
    return byMime
  }
  const extension = extname(fileName).toLowerCase()
  return /^\.(png|jpe?g|gif|webp|svg|bmp)$/.test(extension) ? extension : '.png'
}

/**
 * An absolute path, or a refusal that names the field.
 *
 * The check is on the INPUT, not on `resolve()`'s output: resolving first would turn
 * `evil.txt` into a path under whatever directory the dsh process happens to be
 * running in, and accept it. Every path the panel sends comes from the host path
 * picker, which always produces an absolute one.
 */
export function requireAbsolute(path, field) {
  const text = String(path ?? '').trim()
  if (text.length === 0) {
    throw new DbmError(ERR.invalidInput, `${field}不能为空`)
  }
  if (!isAbsolute(text)) {
    throw new DbmError(ERR.invalidInput, `${field}必须是绝对路径: ${text}`)
  }
  return resolve(text)
}
