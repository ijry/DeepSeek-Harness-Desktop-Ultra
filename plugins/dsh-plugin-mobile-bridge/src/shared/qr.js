/**
 * Dependency-free QR Code encoder (byte mode, ECC level L or M, versions 1-20).
 *
 * Why hand-rolled instead of an npm dependency: this package ships with the
 * desktop shell as a local tarball and is installed by pnpm from that file with
 * no registry access, so every runtime dependency would turn a first-run plugin
 * install into a network operation that can fail offline. The encoder is also
 * the only piece of maths here, which makes it the one piece worth testing
 * independently — see test/qr.test.mjs, which re-extracts the codewords out of
 * the finished matrix and checks the Reed-Solomon syndromes vanish.
 *
 * Scope is deliberately narrow: byte mode only (payloads are UTF-8 JSON and
 * URLs), no Kanji/alphanumeric compaction, no structured append. Version 20 at
 * level L holds 858 bytes, an order of magnitude more than the largest pairing
 * payload.
 *
 * @module dsh-plugin-mobile-bridge/shared/qr
 */

import { utf8Bytes as encodeUtf8 } from './codec.js'

/* ------------------------------------------------------------------ GF(256) */

/** Exponent table over GF(256), primitive polynomial 0x11d, doubled for wrap-free reads. */
const EXP = new Uint8Array(512)
/** Discrete log table over GF(256); LOG[0] is unused (log 0 is undefined). */
const LOG = new Uint8Array(256)

for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if ((x & 0x100) !== 0) x ^= 0x11d
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]

/** Multiply two GF(256) elements. */
function gmul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/**
 * Reed-Solomon generator polynomial of the given degree, coefficients
 * high-order first with a leading 1 that is implicit in `remainder`.
 * @param {number} degree - number of error-correction codewords.
 * @returns {Uint8Array} the degree+1 coefficients.
 */
function generatorPoly(degree) {
  let poly = Uint8Array.of(1)
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gmul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * Reed-Solomon remainder of `data` divided by `gen` — the block's EC codewords.
 * @param {Uint8Array} data - the block's data codewords.
 * @param {Uint8Array} gen - generator polynomial from {@link generatorPoly}.
 * @returns {Uint8Array} gen.length-1 error-correction codewords.
 */
export function remainder(data, gen) {
  const out = new Uint8Array(data.length + gen.length - 1)
  out.set(data)
  for (let i = 0; i < data.length; i += 1) {
    const lead = out[i]
    if (lead === 0) continue
    for (let j = 1; j < gen.length; j += 1) out[i + j] ^= gmul(gen[j], lead)
  }
  return out.slice(data.length)
}

/* ------------------------------------------------------------------- tables */

/**
 * Total codewords (data + EC) per version, index = version-1. Derived from the
 * symbol's free module count; used by the table self-consistency test.
 */
export const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
]

/**
 * Reed-Solomon block layout per version, as flat triples
 * `[blockCount, totalCodewords, dataCodewords]` repeated once per block group
 * (ISO/IEC 18004 tables 13-22). Only the two lower EC levels are carried: a
 * pairing QR is scanned from a screen at arm's length, where L/M is ample, and
 * every level added is another column of transcription risk.
 */
const BLOCKS = {
  L: [
    [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
    [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116], [2, 86, 68, 2, 87, 69],
    [4, 101, 81], [2, 116, 92, 2, 117, 93], [4, 133, 107], [3, 145, 115, 1, 146, 116],
    [5, 109, 87, 1, 110, 88], [5, 122, 98, 1, 123, 99], [1, 135, 107, 5, 136, 108],
    [5, 150, 120, 1, 151, 121], [3, 141, 113, 4, 142, 114], [3, 135, 107, 5, 136, 108],
  ],
  M: [
    [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
    [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37],
    [4, 69, 43, 1, 70, 44], [1, 80, 50, 4, 81, 51], [6, 58, 36, 2, 59, 37],
    [8, 59, 37, 1, 60, 38], [4, 64, 40, 5, 65, 41], [5, 65, 41, 5, 66, 42],
    [7, 73, 45, 3, 74, 46], [10, 74, 46, 1, 75, 47], [9, 69, 43, 4, 70, 44],
    [3, 70, 44, 11, 71, 45], [3, 67, 41, 13, 68, 42],
  ],
}

/** Alignment-pattern centre coordinates per version, index = version-1. */
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90],
]

/** 18-bit BCH-protected version information, index = version-7 (versions 7+). */
const VERSION_INFO = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847,
  0x0e60d, 0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6,
]

/** Format-information EC-level indicator bits. */
const LEVEL_BITS = { L: 1, M: 0 }

/* --------------------------------------------------------------- bit stream */

/** Big-endian bit accumulator; QR codewords are byte-aligned MSB-first. */
class Bits {
  constructor() {
    this.bytes = []
    this.length = 0
  }

  /** Append the low `count` bits of `value`, most significant first. */
  push(value, count) {
    for (let i = count - 1; i >= 0; i -= 1) {
      if (this.length % 8 === 0) this.bytes.push(0)
      if (((value >>> i) & 1) === 1) this.bytes[this.bytes.length - 1] |= 0x80 >>> this.length % 8
      this.length += 1
    }
  }
}

/** UTF-8 encode a string; re-exported so a consumer can size a payload. */
export { utf8Bytes } from './codec.js'

/** Block layout for one version/level: `[{ data, ec }]` in interleave order. */
export function blockLayout(version, level) {
  const triples = BLOCKS[level][version - 1]
  const out = []
  for (let i = 0; i < triples.length; i += 3) {
    for (let n = 0; n < triples[i]; n += 1) {
      out.push({ total: triples[i + 1], data: triples[i + 2] })
    }
  }
  return out
}

/** Data-codeword capacity of one version/level. */
export function dataCapacity(version, level) {
  return blockLayout(version, level).reduce((sum, block) => sum + block.data, 0)
}

/**
 * Byte-mode payload as data codewords for one version, padded to capacity.
 * @param {Uint8Array} bytes - the UTF-8 payload.
 * @param {number} version - QR version 1-20.
 * @param {'L'|'M'} level - error-correction level.
 * @returns {Uint8Array|null} capacity-length codewords, or null if it does not fit.
 */
export function dataCodewords(bytes, version, level) {
  const capacity = dataCapacity(version, level)
  const countBits = version < 10 ? 8 : 16
  const needed = 4 + countBits + bytes.length * 8
  if (bytes.length >= 1 << countBits || needed > capacity * 8) return null

  const bits = new Bits()
  bits.push(0b0100, 4)
  bits.push(bytes.length, countBits)
  for (const byte of bytes) bits.push(byte, 8)
  // Terminator, then bit-pad to the next codeword boundary.
  bits.push(0, Math.min(4, capacity * 8 - bits.length))
  if (bits.length % 8 !== 0) bits.push(0, 8 - (bits.length % 8))

  const out = new Uint8Array(capacity)
  out.set(bits.bytes.slice(0, capacity))
  // Alternating pad codewords, as specified; anything else is a decoder hazard.
  for (let i = bits.bytes.length; i < capacity; i += 1) out[i] = i % 2 === bits.bytes.length % 2 ? 0xec : 0x11
  return out
}

/**
 * Interleave data and EC codewords across blocks, the order the symbol expects.
 * @param {Uint8Array} data - capacity-length data codewords from {@link dataCodewords}.
 * @param {number} version - QR version 1-20.
 * @param {'L'|'M'} level - error-correction level.
 * @returns {Uint8Array} TOTAL_CODEWORDS[version-1] interleaved codewords.
 */
export function interleave(data, version, level) {
  const layout = blockLayout(version, level)
  const gen = generatorPoly(layout[0].total - layout[0].data)
  const blocks = []
  let offset = 0
  for (const block of layout) {
    const slice = data.slice(offset, offset + block.data)
    offset += block.data
    blocks.push({ data: slice, ec: remainder(slice, gen) })
  }

  const out = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  }
  const maxEc = Math.max(...blocks.map((block) => block.ec.length))
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of blocks) if (i < block.ec.length) out.push(block.ec[i])
  }
  return Uint8Array.from(out)
}

/* ------------------------------------------------------------------- matrix */

/** BCH(15,5) generator and final XOR mask for format information. */
const G15 = 0x537
const G15_MASK = 0x5412

function bchDigit(value) {
  let digit = 0
  let rest = value
  while (rest !== 0) {
    digit += 1
    rest >>>= 1
  }
  return digit
}

/** 15-bit BCH-protected format information for an EC level and mask pattern. */
export function formatBits(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask
  let rest = data << 10
  while (bchDigit(rest) - bchDigit(G15) >= 0) rest ^= G15 << (bchDigit(rest) - bchDigit(G15))
  return ((data << 10) | rest) ^ G15_MASK
}

/** The eight mask conditions; true means "invert this module". */
const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

/** A mutable symbol: `dark` holds module colour, `fixed` marks function modules. */
function blank(size) {
  const dark = []
  const fixed = []
  for (let row = 0; row < size; row += 1) {
    dark.push(new Uint8Array(size))
    fixed.push(new Uint8Array(size))
  }
  return { size, dark, fixed }
}

function set(grid, row, col, value) {
  if (row < 0 || col < 0 || row >= grid.size || col >= grid.size) return
  grid.dark[row][col] = value ? 1 : 0
  grid.fixed[row][col] = 1
}

/** Finder pattern plus its separator, anchored at a corner. */
function finder(grid, top, left) {
  for (let row = -1; row <= 7; row += 1) {
    for (let col = -1; col <= 7; col += 1) {
      const ring = row === 0 || row === 6 || col === 0 || col === 6
      const core = row >= 2 && row <= 4 && col >= 2 && col <= 4
      const inside = row >= 0 && row <= 6 && col >= 0 && col <= 6
      set(grid, top + row, left + col, inside && (ring || core))
    }
  }
}

/** One 5x5 alignment pattern centred on (row, col). */
function alignment(grid, row, col) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const edge = Math.max(Math.abs(dr), Math.abs(dc))
      set(grid, row + dr, col + dc, edge !== 1)
    }
  }
}

/** Function patterns and the reserved format/version areas, for one version. */
function layout(grid, version) {
  const size = grid.size
  finder(grid, 0, 0)
  finder(grid, 0, size - 7)
  finder(grid, size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0
    set(grid, 6, i, dark)
    set(grid, i, 6, dark)
  }

  for (const row of ALIGNMENT[version - 1]) {
    for (const col of ALIGNMENT[version - 1]) {
      if (grid.fixed[row][col] === 1) continue
      alignment(grid, row, col)
    }
  }

  // Reserve the format areas; real bits land in `stamp` after mask selection.
  for (let i = 0; i < 9; i += 1) {
    set(grid, 8, i, false)
    set(grid, i, 8, false)
  }
  for (let i = 0; i < 8; i += 1) {
    set(grid, 8, size - 1 - i, false)
    set(grid, size - 1 - i, 8, false)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      set(grid, Math.floor(i / 3), (i % 3) + size - 11, false)
      set(grid, (i % 3) + size - 11, Math.floor(i / 3), false)
    }
  }
}

/** Zig-zag the codeword bits into every non-function module. */
function placeData(grid, codewords) {
  const size = grid.size
  let bit = 7
  let byte = 0
  let row = size - 1
  let step = -1

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const target = col - c
        if (grid.fixed[row][target] === 1) continue
        let dark = 0
        // Past the last codeword the symbol takes remainder bits, which are 0.
        if (byte < codewords.length) dark = (codewords[byte] >>> bit) & 1
        grid.dark[row][target] = dark
        bit -= 1
        if (bit === -1) {
          byte += 1
          bit = 7
        }
      }
      row += step
      if (row < 0 || row >= size) {
        row -= step
        step = -step
        break
      }
    }
  }
}

function clone(grid) {
  return {
    size: grid.size,
    dark: grid.dark.map((line) => Uint8Array.from(line)),
    fixed: grid.fixed.map((line) => Uint8Array.from(line)),
  }
}

/** XOR one mask pattern over every data module. */
function applyMask(grid, mask) {
  const condition = MASKS[mask]
  for (let row = 0; row < grid.size; row += 1) {
    for (let col = 0; col < grid.size; col += 1) {
      if (grid.fixed[row][col] === 1) continue
      if (condition(row, col)) grid.dark[row][col] ^= 1
    }
  }
}

/** Write format information (and version information for versions 7+). */
function stamp(grid, version, level, mask) {
  const size = grid.size
  const bits = formatBits(level, mask)
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) set(grid, i, 8, dark)
    else if (i < 8) set(grid, i + 1, 8, dark)
    else set(grid, size - 15 + i, 8, dark)
  }
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 8) set(grid, 8, size - i - 1, dark)
    else if (i < 9) set(grid, 8, 15 - i, dark)
    else set(grid, 8, 14 - i, dark)
  }
  set(grid, size - 8, 8, true)

  if (version >= 7) {
    const info = VERSION_INFO[version - 7]
    for (let i = 0; i < 18; i += 1) {
      const dark = ((info >> i) & 1) === 1
      set(grid, Math.floor(i / 3), (i % 3) + size - 11, dark)
      set(grid, (i % 3) + size - 11, Math.floor(i / 3), dark)
    }
  }
}

/** Same-colour runs of 5+ in a line: 3 points, plus 1 per module beyond 5. */
function runPenalty(line) {
  let total = 0
  let run = 1
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) run += 1
    else {
      if (run >= 5) total += 3 + (run - 5)
      run = 1
    }
  }
  return run >= 5 ? total + 3 + (run - 5) : total
}

/** The 1:1:3:1:1 finder-lookalike, with its 4-module light margin on either side. */
const FINDER_LIKE = [
  [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
]

/**
 * Rule 3 of the mask penalty: does `line` contain the 1:1:3:1:1 finder ratio
 * with its four-module light margin, starting at `at`? Exported so the rule can
 * be tested on its own — inside a whole-symbol score it is impossible to
 * separate from the three other rules.
 *
 * @param {ArrayLike<number>} line - one row or column, 0 light and 1 dark.
 * @param {number} at - window start; the window is 11 modules wide.
 * @returns {boolean} true when the window is a finder lookalike.
 */
export function hasFinderPattern(line, at) {
  return FINDER_LIKE.some((pattern) => pattern.every((value, i) => line[at + i] === value))
}


/**
 * Total mask penalty (ISO/IEC 18004 section 8.8.2, all four rules). Lower is
 * better; the encoder picks the lowest-scoring of the eight masks.
 */
export function penalty(grid) {
  const size = grid.size
  let total = 0

  for (let row = 0; row < size; row += 1) {
    const line = Array.from(grid.dark[row])
    total += runPenalty(line)
    for (let col = 0; col + 11 <= size; col += 1) if (hasFinderPattern(line, col)) total += 40
  }
  for (let col = 0; col < size; col += 1) {
    const line = []
    for (let row = 0; row < size; row += 1) line.push(grid.dark[row][col])
    total += runPenalty(line)
    for (let row = 0; row + 11 <= size; row += 1) if (hasFinderPattern(line, row)) total += 40
  }

  for (let row = 0; row + 1 < size; row += 1) {
    for (let col = 0; col + 1 < size; col += 1) {
      const first = grid.dark[row][col]
      if (
        grid.dark[row][col + 1] === first &&
        grid.dark[row + 1][col] === first &&
        grid.dark[row + 1][col + 1] === first
      ) {
        total += 3
      }
    }
  }

  let dark = 0
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += grid.dark[row][col]
  }
  const percent = (dark * 100) / (size * size)
  total += Math.floor(Math.abs(percent - 50) / 5) * 10

  return total
}

/** Smallest version that fits `bytes` at `level`, or null when nothing does. */
export function fitVersion(bytes, level) {
  for (let version = 1; version <= TOTAL_CODEWORDS.length; version += 1) {
    if (dataCodewords(bytes, version, level) !== null) return version
  }
  return null
}

/**
 * The function-module map for one version: 1 where a module belongs to a
 * finder, separator, timing, alignment, format, or version area, and therefore
 * carries no data and is never masked. Exported because it is the only way a
 * consumer (or a test) can read the codewords back out of a finished symbol.
 *
 * @param {number} version - QR version 1-20.
 * @returns {Uint8Array[]} `map[row][col]`, 1 for a function module.
 */
export function reservedMap(version) {
  const grid = blank(version * 4 + 17)
  layout(grid, version)
  return grid.fixed
}

/**
 * Encode one string as a QR symbol.
 *
 * @param {string} text - payload; encoded as UTF-8 in byte mode.
 * @param {{ level?: 'L'|'M', version?: number }} [options] - EC level (default
 *   'M') and a forced minimum version (default: the smallest that fits).
 * @returns {{ version: number, level: 'L'|'M', mask: number, size: number,
 *   codewords: Uint8Array, modules: Uint8Array[] }} the finished symbol; each
 *   `modules[row][col]` is 1 for a dark module.
 * @throws {Error} when the payload exceeds version 20 at the chosen level.
 */
export function encodeQr(text, options = {}) {
  const level = options.level === 'L' ? 'L' : 'M'
  const bytes = encodeUtf8(text)
  const fitted = fitVersion(bytes, level)
  if (fitted === null) {
    throw new Error(`qr: payload of ${bytes.length} bytes exceeds version 20 at level ${level}`)
  }
  const version = Math.max(fitted, Number(options.version) || 1)
  if (version > TOTAL_CODEWORDS.length) throw new Error(`qr: version ${version} is out of range`)

  const codewords = interleave(dataCodewords(bytes, version, level), version, level)
  const base = blank(version * 4 + 17)
  layout(base, version)
  placeData(base, codewords)

  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = clone(base)
    applyMask(candidate, mask)
    stamp(candidate, version, level, mask)
    const score = penalty(candidate)
    if (best === null || score < best.score) best = { mask, score, grid: candidate }
  }

  return {
    version,
    level,
    mask: best.mask,
    size: base.size,
    codewords,
    modules: best.grid.dark,
  }
}

/**
 * SVG `path` geometry for a symbol, one `M`/`h`/`v` rectangle per dark module.
 * The caller owns the `<svg>` element, its viewBox, and the quiet zone.
 *
 * @param {Uint8Array[]} modules - `modules` from {@link encodeQr}.
 * @param {number} [quiet] - quiet-zone modules added around the symbol (default 4).
 * @returns {{ path: string, extent: number }} path data and the viewBox extent.
 */
export function toSvgPath(modules, quiet = 4) {
  const parts = []
  for (let row = 0; row < modules.length; row += 1) {
    for (let col = 0; col < modules.length; col += 1) {
      if (modules[row][col] === 1) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
    }
  }
  return { path: parts.join(''), extent: modules.length + quiet * 2 }
}









