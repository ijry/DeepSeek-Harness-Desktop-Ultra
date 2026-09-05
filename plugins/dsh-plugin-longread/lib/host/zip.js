/**
 * A minimal ZIP reader, because an EPUB is a ZIP and this plugin ships with zero
 * dependencies. It reads the central directory (not a streaming scan, so entry
 * names are the authoritative ones) and inflates with node:zlib.
 *
 * Deliberately narrow: stored (method 0) and deflate (method 8) only, no
 * encryption, no ZIP64. Real EPUBs use deflate and are megabytes at most; a file
 * outside that envelope gets a clear error rather than a silent half-read.
 *
 * Zip-bomb guard: the total inflated size is capped, and each entry's declared
 * uncompressed size is checked against what inflate actually produced.
 *
 * @module dsh-plugin-longread/host/zip
 */
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_MIN = 22
const ZIP64_MARKER = 0xffffffff

/** Total inflated bytes one archive may produce. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** Max entries read from one archive. */
const MAX_ENTRIES = 4000

/** A malformed or unsupported archive. */
export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Locate the End Of Central Directory record by scanning backwards. */
function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - (0xffff + EOCD_MIN))
  for (let at = buffer.length - EOCD_MIN; at >= floor; at--) {
    if (buffer.readUInt32LE(at) === SIG_EOCD) return at
  }
  throw new ZipError('不是 zip 包（找不到中央目录结尾记录）')
}

/**
 * Read every entry of a ZIP archive into a Map of name -> Buffer.
 * Directory entries (trailing "/") are skipped.
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) throw new ZipError('包是空的，或者只下载了一半')
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === ZIP64_MARKER || entryCount === 0xffff) throw new ZipError('不支持 ZIP64 的包')
  if (centralOffset >= buffer.length) throw new ZipError('中央目录的偏移越界了')

  const files = new Map()
  let cursor = centralOffset
  let total = 0
  for (let index = 0; index < Math.min(entryCount, MAX_ENTRIES); index++) {
    if (cursor + 46 > buffer.length) throw new ZipError('中央目录被截断了')
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw new ZipError('中央目录的签名不对')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new ZipError(`不支持 ZIP64 的条目：${name}`)
    }
    total += uncompressedSize
    if (total > MAX_TOTAL_BYTES) throw new ZipError('解开之后超过体积上限')

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipError(`${name} 的本地头不对`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new ZipError(`${name} 的数据被截断了`)
    const raw = buffer.subarray(dataStart, dataEnd)

    let content
    if (method === 0) content = Buffer.from(raw)
    else if (method === 8) content = inflateRawSync(raw)
    else throw new ZipError(`不支持的压缩方式 ${method}（${name}）—— 加密或 DRM 的 epub 读不了`)
    if (uncompressedSize > 0 && content.length !== uncompressedSize) {
      throw new ZipError(`${name} 的大小对不上（声明 ${uncompressedSize}，实际 ${content.length}）`)
    }
    files.set(name, content)
  }
  if (files.size === 0) throw new ZipError('包里一个文件都没有')
  return files
}
