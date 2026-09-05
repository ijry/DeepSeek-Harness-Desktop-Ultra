/**
 * QR encoder tests. There is no trusted offline fixture to diff against, so the
 * suite verifies the encoder against the specification's own invariants
 * instead — most importantly by re-deriving the Reed-Solomon syndromes with an
 * independent GF(256) implementation, and by reading the codewords back out of
 * the finished matrix. A transposed table entry, an off-by-one in the zig-zag,
 * or a wrong mask XOR all fail at least one of these.
 *
 * @module dsh-plugin-mobile-bridge/test/qr
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  TOTAL_CODEWORDS,
  blockLayout,
  dataCapacity,
  dataCodewords,
  encodeQr,
  fitVersion,
  formatBits,
  hasFinderPattern,
  interleave,
  penalty,
  reservedMap,
  toSvgPath,
  utf8Bytes,
} from '../lib/shared/qr.js'

const LEVELS = ['L', 'M']

/** Independent GF(256) tables, so the syndrome check does not reuse the encoder's. */
const exp = new Array(512)
const log = new Array(256)
for (let i = 0, x = 1; i < 255; i += 1) {
  exp[i] = x
  log[x] = i
  x = x << 1
  if (x > 255) x ^= 0x11d
}
for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255]
const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]])

test('block tables agree with the per-version codeword totals', () => {
  for (const level of LEVELS) {
    for (let version = 1; version <= TOTAL_CODEWORDS.length; version += 1) {
      const blocks = blockLayout(version, level)
      const total = blocks.reduce((sum, block) => sum + block.total, 0)
      assert.equal(
        total,
        TOTAL_CODEWORDS[version - 1],
        `version ${version} level ${level}: blocks sum to ${total}`,
      )
      const ec = blocks.map((block) => block.total - block.data)
      assert.equal(new Set(ec).size, 1, `version ${version} level ${level}: EC count must be uniform`)
      assert.ok(ec[0] > 0, `version ${version} level ${level}: EC count must be positive`)
    }
  }
})

test('a longer error-correction level never holds more data', () => {
  for (let version = 1; version <= TOTAL_CODEWORDS.length; version += 1) {
    assert.ok(
      dataCapacity(version, 'L') > dataCapacity(version, 'M'),
      `version ${version}: level L should hold more than level M`,
    )
  }
})

/** Split an interleaved codeword stream back into per-block data and EC halves. */
function deinterleave(stream, version, level) {
  const layout = blockLayout(version, level)
  const blocks = layout.map((block) => ({ data: [], ec: [], want: block }))
  let at = 0
  const maxData = Math.max(...layout.map((block) => block.data))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.want.data) block.data.push(stream[at++])
  }
  const ecCount = layout[0].total - layout[0].data
  for (let i = 0; i < ecCount; i += 1) {
    for (const block of blocks) block.ec.push(stream[at++])
  }
  assert.equal(at, stream.length, 'de-interleave must consume the whole stream')
  return blocks
}

test('every Reed-Solomon block has vanishing syndromes', () => {
  const payloads = ['x', 'https://getmcode.lingyun.net', 'a'.repeat(300), '手机遥控 dsh 桥'.repeat(9)]
  for (const level of LEVELS) {
    for (const payload of payloads) {
      const bytes = utf8Bytes(payload)
      const version = fitVersion(bytes, level)
      const stream = interleave(dataCodewords(bytes, version, level), version, level)
      for (const block of deinterleave(stream, version, level)) {
        const word = [...block.data, ...block.ec]
        for (let s = 0; s < block.ec.length; s += 1) {
          let sum = 0
          for (let i = 0; i < word.length; i += 1) {
            sum ^= mul(word[i], exp[(s * (word.length - 1 - i)) % 255])
          }
          assert.equal(sum, 0, `level ${level} v${version}: syndrome ${s} must vanish`)
        }
      }
    }
  }
})

test('codewords read back out of the finished matrix unchanged', () => {
  for (const payload of ['ok', 'https://getmcode.lingyun.net/#/download', 'z'.repeat(220)]) {
    const symbol = encodeQr(payload, { level: 'M' })
    const fixed = reservedMap(symbol.version)
    const size = symbol.size
    const bits = []
    let row = size - 1
    let step = -1
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1
      for (;;) {
        for (let c = 0; c < 2; c += 1) {
          const target = col - c
          if (fixed[row][target] === 1) continue
          const masked = symbol.modules[row][target]
          bits.push(masked ^ (maskBit(symbol.mask, row, target) ? 1 : 0))
        }
        row += step
        if (row < 0 || row >= size) {
          row -= step
          step = -step
          break
        }
      }
    }
    for (let i = 0; i < symbol.codewords.length; i += 1) {
      let byte = 0
      for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i * 8 + b]
      assert.equal(byte, symbol.codewords[i], `codeword ${i} of "${payload.slice(0, 12)}" round-trips`)
    }
  }
})

/** The eight mask conditions, restated here so the test does not import them. */
function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

test('format information is a valid BCH(15,5) word', () => {
  for (const level of LEVELS) {
    for (let mask = 0; mask < 8; mask += 1) {
      const bits = formatBits(level, mask)
      assert.ok(bits >= 0 && bits < 1 << 15, `format bits out of range: ${bits}`)
      // Undo the specified XOR, then divide by the generator: the remainder of a
      // valid codeword is zero, and the top 5 bits are the level/mask payload.
      let rest = bits ^ 0x5412
      assert.equal(rest >>> 10, ((level === 'L' ? 1 : 0) << 3) | mask)
      for (let shift = 4; shift >= 0; shift -= 1) {
        if ((rest >>> (10 + shift)) & 1) rest ^= 0x537 << shift
      }
      assert.equal(rest, 0, `level ${level} mask ${mask}: BCH remainder must vanish`)
    }
  }
})

test('symbol geometry matches the version', () => {
  for (const version of [1, 2, 6, 7, 10, 14, 20]) {
    const symbol = encodeQr('p'.repeat(4), { version, level: 'L' })
    assert.equal(symbol.version, version)
    assert.equal(symbol.size, version * 4 + 17)
    assert.equal(symbol.modules.length, symbol.size)
    // Finder cores, separators, and the always-dark module below the top-left one.
    for (const [row, col] of [[3, 3], [3, symbol.size - 4], [symbol.size - 4, 3]]) {
      assert.equal(symbol.modules[row][col], 1, `finder core at ${row},${col}`)
    }
    assert.equal(symbol.modules[7][7], 0, 'separator stays light')
    assert.equal(symbol.modules[symbol.size - 8][8], 1, 'dark module is dark')
    assert.ok(symbol.mask >= 0 && symbol.mask <= 7)
  }
})

test('penalty punishes a solid block more than a checkerboard', () => {
  const size = 21
  const solid = { size, dark: Array.from({ length: size }, () => new Uint8Array(size).fill(1)) }
  const checker = {
    size,
    dark: Array.from({ length: size }, (_, row) =>
      Uint8Array.from({ length: size }, (_, col) => (row + col) % 2),
    ),
  }
  assert.ok(penalty(solid) > penalty(checker), 'a solid block must score worse than a checkerboard')
  assert.equal(penalty(checker) >= 0, true)
})

test('rule 3 recognises the finder ratio and only the finder ratio', () => {
  const dark = [1, 0, 1, 1, 1, 0, 1]
  const margin = [0, 0, 0, 0]
  assert.ok(hasFinderPattern([...dark, ...margin], 0), 'pattern then light margin')
  assert.ok(hasFinderPattern([...margin, ...dark], 0), 'light margin then pattern')
  assert.ok(!hasFinderPattern([...dark, 0, 0, 0, 1], 0), 'a dark module inside the margin')
  assert.ok(!hasFinderPattern([1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0], 0), 'ratio 1:1:2:2:1 is not it')
  assert.ok(!hasFinderPattern(new Array(11).fill(0), 0), 'all light is not it')
  // The window is read at an offset, so a pattern that starts late still counts.
  assert.ok(hasFinderPattern([1, 1, ...dark, ...margin], 2))
})


test('encoding is deterministic', () => {
  const first = encodeQr('https://getmcode.lingyun.net')
  const second = encodeQr('https://getmcode.lingyun.net')
  assert.equal(first.mask, second.mask)
  assert.deepEqual(Array.from(first.codewords), Array.from(second.codewords))
  assert.deepEqual(
    first.modules.map((line) => Array.from(line)),
    second.modules.map((line) => Array.from(line)),
  )
})

test('payloads too large for version 20 are refused, not truncated', () => {
  assert.throws(() => encodeQr('x'.repeat(5000)), /exceeds version 20/)
})

test('svg path covers exactly the dark modules', () => {
  const symbol = encodeQr('abc')
  const { path, extent } = toSvgPath(symbol.modules, 4)
  const dark = symbol.modules.reduce((sum, line) => sum + line.reduce((a, b) => a + b, 0), 0)
  assert.equal(path.split('M').length - 1, dark)
  assert.equal(extent, symbol.size + 8)
})

