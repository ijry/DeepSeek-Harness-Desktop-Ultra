/**
 * A minimal tar (ustar + pax) writer, used for exactly one thing: letting the
 * browser download a whole remote directory.
 *
 * The reference downloaded a folder by walking it into a local directory the user
 * had picked in a native dialog. A web page has no such dialog and cannot write a
 * tree, so a folder leaves the host as one stream the browser saves as a file. Tar
 * rather than zip because tar needs no compression, no CRC table and no central
 * directory — it is a header plus the bytes, which is a hundred lines instead of a
 * dependency.
 *
 * Paths longer than 100 bytes (or with non-ASCII, which ustar cannot express) get a
 * pax extended header carrying `path=`, the POSIX-standard escape hatch that GNU
 * tar, bsdtar and 7-Zip all read.
 *
 * @module dsh-plugin-otools-term/host/tar
 */

/** Tar block size. Everything is padded to a multiple of this. */
export const BLOCK = 512

/** Zero padding to the next block boundary. */
export function padding(size) {
  const remainder = size % BLOCK
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
}

/** Write one ASCII field, NUL-terminated inside its fixed width. */
function writeString(block, value, offset, length) {
  const text = Buffer.from(String(value ?? ''), 'utf8').subarray(0, length - 1)
  text.copy(block, offset)
}

/** Write one octal numeric field the way tar spells numbers. */
function writeOctal(block, value, offset, length) {
  const text = Math.max(0, Math.floor(Number(value) || 0)).toString(8).padStart(length - 1, '0').slice(-(length - 1))
  Buffer.from(`${text}\0`, 'ascii').copy(block, offset)
}

/** Build one 512-byte header. */
export function header({ name, size = 0, mode = 0o644, mtime = Date.now() / 1000, type = '0', linkname = '' }) {
  const block = Buffer.alloc(BLOCK)
  writeString(block, name, 0, 100)
  writeOctal(block, mode & 0o7777, 100, 8)
  writeOctal(block, 0, 108, 8)
  writeOctal(block, 0, 116, 8)
  writeOctal(block, size, 124, 12)
  writeOctal(block, Math.floor(mtime), 136, 12)
  // The checksum field is spaces while the sum is computed over the header.
  block.fill(0x20, 148, 156)
  block.write(type, 156, 1, 'ascii')
  writeString(block, linkname, 157, 100)
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  writeString(block, 'root', 265, 32)
  writeString(block, 'root', 297, 32)
  let sum = 0
  for (const byte of block) sum += byte
  // The checksum field is SIX octal digits, then NUL, then a space — not the seven
  // digits every other numeric field uses. Getting this wrong makes an archive that
  // `tar` refuses with "checksum error".
  block.write(`${(sum & 0o777777).toString(8).padStart(6, '0')}\u0000 `, 148, 8, 'ascii')
  return block
}

/** Whether a name fits in a plain ustar header. */
export function fitsUstar(name) {
  const bytes = Buffer.byteLength(name, 'utf8')
  return bytes <= 100 && /^[\x20-\x7e]*$/.test(name)
}

/** The pax extended header pair that carries a long or non-ASCII path. */
export function paxHeaders(name, index) {
  const record = paxRecord('path', name)
  return [
    header({ name: `PaxHeader/${index}`, size: record.length, type: 'x', mode: 0o644 }),
    record,
    padding(record.length),
  ]
}

/** One `len key=value\n` pax record, with the self-referential length. */
export function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body, 'utf8') + 2
  // The length prefix counts itself, so it can push the total over a digit boundary.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${length} ${body}`
    const actual = Buffer.byteLength(candidate, 'utf8')
    if (actual === length) return Buffer.from(candidate, 'utf8')
    length = actual
  }
  return Buffer.from(`${length} ${body}`, 'utf8')
}

/** The two 512-byte zero blocks that end an archive. */
export function trailer() {
  return Buffer.alloc(BLOCK * 2)
}

/**
 * A tar entry's prelude: the pax header when the name needs one, then the real
 * header. The caller writes `size` bytes and then the padding.
 */
export function entry(options, index) {
  const parts = []
  const name = options.type === '5' && !options.name.endsWith('/') ? `${options.name}/` : options.name
  if (!fitsUstar(name)) {
    parts.push(...paxHeaders(name, index))
    // The ustar name still has to hold SOMETHING readable for tools that ignore
    // pax; a truncated tail is the conventional choice.
    parts.push(header({ ...options, name: truncateName(name) }))
    return parts
  }
  parts.push(header({ ...options, name }))
  return parts
}

/** The last 99 bytes of a path, cut on a character boundary. */
export function truncateName(name) {
  let text = name
  while (Buffer.byteLength(text, 'utf8') > 99) text = text.slice(1)
  return text
}
