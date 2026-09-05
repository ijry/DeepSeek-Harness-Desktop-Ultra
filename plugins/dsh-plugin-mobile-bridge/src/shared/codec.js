/**
 * Portable byte/text/base64url codecs, shared by the host half (node) and the
 * browser half. Nothing here may touch `node:` builtins or DOM globals: this
 * module is imported by both faces, and by the QR encoder in between.
 *
 * The base64url variant is the one the MCode config code uses (`-`/`_` instead
 * of `+`/`/`, no `=` padding), because the pairing QR is deliberately readable
 * by MCode's existing scanner path without a second format.
 *
 * @module dsh-plugin-mobile-bridge/shared/codec
 */

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Reverse lookup for {@link base64UrlDecode}; accepts the `+`/`/` spellings too. */
const REVERSE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64URL.length; i += 1) table[BASE64URL.charCodeAt(i)] = i
  table['+'.charCodeAt(0)] = 62
  table['/'.charCodeAt(0)] = 63
  return table
})()

/**
 * UTF-8 encode a string. Uses TextEncoder when the runtime has one and hand-rolls
 * the four-byte forms otherwise, so the module works in any ES2020 host.
 * @param {string} text - any string, astral plane included.
 * @returns {Uint8Array} the UTF-8 bytes.
 */
export function utf8Bytes(text) {
  if (typeof TextEncoder === 'function') return new Uint8Array(new TextEncoder().encode(String(text)))
  const out = []
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f))
      out.push(0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return new Uint8Array(out)
}

/**
 * Decode UTF-8 bytes back to a string.
 * @param {Uint8Array} bytes - UTF-8 bytes.
 * @returns {string} the decoded text.
 */
export function utf8Text(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]
    if (byte < 0x80) {
      out += String.fromCodePoint(byte)
      i += 1
    } else if (byte < 0xe0) {
      out += String.fromCodePoint(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (byte < 0xf0) {
      out += String.fromCodePoint(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      out += String.fromCodePoint(
        ((byte & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f),
      )
      i += 4
    }
  }
  return out
}

/**
 * base64url-encode a string (unpadded).
 * @param {string} text - the plain text.
 * @returns {string} the encoded code.
 */
export function base64UrlEncode(text) {
  const bytes = utf8Bytes(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const left = bytes.length - i
    out += BASE64URL[(chunk >> 18) & 63] + BASE64URL[(chunk >> 12) & 63]
    if (left > 1) out += BASE64URL[(chunk >> 6) & 63]
    if (left > 2) out += BASE64URL[chunk & 63]
  }
  return out
}

/**
 * Decode a base64url (or plain base64) code back to text. Padding and stray
 * whitespace are tolerated because these codes get copied by hand.
 * @param {string} code - the encoded code.
 * @returns {string} the decoded text.
 * @throws {Error} on a character outside the alphabet.
 */
export function base64UrlDecode(code) {
  const clean = String(code).replace(/[\s=]+/g, '')
  const bytes = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = REVERSE[char.charCodeAt(0)] ?? -1
    if (value < 0) throw new Error(`base64url: unexpected character ${JSON.stringify(char)}`)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return utf8Text(new Uint8Array(bytes))
}
