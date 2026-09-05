/**
 * Credentials: the pairing offer, the device tokens it mints, and the constant
 * -time comparisons that check them.
 *
 * Threat model, stated plainly, because this is the one module where getting it
 * wrong is not a bug but a breach. The bridge listens on a LAN address and may
 * sit behind a public tunnel, and behind it is an agent with shell and
 * filesystem tools. So:
 *
 * - No unauthenticated route may reach dsh. `/hello` answers reachability and
 *   nothing else; every session route needs a bearer token.
 * - Tokens are stored hashed. A leaked ledger file must not be a leaked login.
 * - Comparisons are constant-time. Token comparison is an oracle otherwise.
 * - The pairing offer lives in memory, is regenerated on every host boot, and
 *   is consumed by the first successful pair. A photographed QR is therefore
 *   worthless a moment later, which is the behavior a pairing credential should
 *   have — and it is why the panel re-reads the offer instead of caching it.
 *
 * @module dsh-plugin-mobile-bridge/host/auth
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { CODE_ALPHABET, normalizeCode } from '../shared/protocol.js'
import { pick } from '../shared/lang.js'

/** How long one pairing offer stays valid, in milliseconds. */
export const PAIRING_TTL_MS = 30 * 60 * 1000

/** Token prefix, so a leaked string is recognizable in a log or a bug report. */
const TOKEN_PREFIX = 'dshm_'

/** sha256 hex of a UTF-8 string. */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/**
 * Constant-time string comparison. Length is compared first and leaks — that is
 * unavoidable and harmless here, because every secret this module compares has
 * a fixed length by construction.
 * @param {string} a - one value.
 * @param {string} b - the other value.
 * @returns {boolean} whether they are equal.
 */
export function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** A fresh opaque bearer token. 32 random bytes is 256 bits of entropy. */
export function mintToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/** A fresh `XXXX-XXXX` pairing code over the unambiguous alphabet. */
export function mintCode() {
  const pick = () => {
    let out = ''
    for (const byte of randomBytes(4)) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    return out
  }
  return `${pick()}-${pick()}`
}

/**
 * A fresh pairing offer.
 *
 * The secret is 128 bits, spelled base64url rather than hex: it is read out of a
 * QR by a machine, never typed, and the ten characters hex would waste are ten
 * characters of QR density paid for by whoever is holding the phone.
 *
 * @param {number} now - epoch milliseconds.
 * @returns {{ code: string, secret: string, createdAt: number, expiresAt: number }} the offer.
 */
export function mintOffer(now) {
  return {
    code: mintCode(),
    secret: randomBytes(16).toString('base64url'),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  }
}


/**
 * Whether a submitted code/secret pair matches a live offer.
 * @param {object|null} offer - the current offer, or null when none is live.
 * @param {unknown} code - the submitted code, in any spelling.
 * @param {unknown} secret - the submitted secret.
 * @param {number} now - epoch milliseconds.
 * @returns {boolean} whether the pair may be exchanged for a token.
 */
export function offerAccepts(offer, code, secret, now) {
  if (offer === null || offer === undefined) return false
  if (offer.expiresAt <= now) return false
  // Both halves are checked in constant time even when the first already
  // failed, so a wrong code and a wrong secret are indistinguishable in timing.
  const codeOk = sameSecret(normalizeCode(code), offer.code)
  const secretOk = sameSecret(secret, offer.secret)
  return codeOk && secretOk
}

/** A fresh device record with its plaintext tokens, which the caller returns once. */
export function mintDevice(name, now) {
  const accessToken = mintToken()
  const refreshToken = mintToken()
  return {
    tokens: { accessToken, refreshToken },
    record: {
      deviceId: randomUUID(),
      // The name is persisted as the phone spelled it, so an unnamed device is
      // stamped in whatever language the host speaks at pairing time — renaming
      // it later is the phone's business, not a migration.
      name: String(name ?? '').slice(0, 64) || pick('未命名设备', 'Unnamed device'),
      tokenHash: sha256(accessToken),
      refreshHash: sha256(refreshToken),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    },
  }
}

/** A fresh target identity for a host that has never had one. */
export function mintTargetId() {
  return randomUUID()
}

/**
 * Find the live device a bearer token belongs to.
 * @param {object[]} devices - the ledger's device rows.
 * @param {unknown} token - the presented bearer token.
 * @param {'tokenHash'|'refreshHash'} [field] - which credential to match.
 * @returns {object|undefined} the device row, or undefined when nothing matches.
 */
export function deviceFor(devices, token, field = 'tokenHash') {
  const presented = String(token ?? '')
  if (!presented.startsWith(TOKEN_PREFIX)) return undefined
  const hash = sha256(presented)
  return (Array.isArray(devices) ? devices : []).find(
    (device) => device?.revokedAt === null && sameSecret(device?.[field], hash),
  )
}

/** Failed pair attempts tolerated inside {@link THROTTLE_WINDOW_MS}. */
export const MAX_PAIR_FAILURES = 10

/** The window failed pair attempts are counted over. */
export const THROTTLE_WINDOW_MS = 60 * 1000

/**
 * The live pairing offer and the throttle in front of it.
 *
 * Rotation on consumption is the important property: an offer buys exactly one
 * device, so a QR on a screen behind someone cannot be reused after the intended
 * phone has paired. Rotation on boot is the second: nothing about a pairing
 * credential should survive a restart.
 *
 * The throttle exists even though an eight-character code over a 32-symbol
 * alphabet is 2^40 possibilities: a bridge on a public tunnel is reachable by
 * anything, and ten guesses a minute turns a theoretical bound into a practical
 * one without ever inconveniencing a human typing a code.
 */
export class PairingOffers {
  constructor(now = () => Date.now()) {
    this.now = now
    this.offer = mintOffer(now())
    this.failures = []
  }

  /** The live offer, minting a fresh one when the current has expired. */
  current() {
    const now = this.now()
    if (this.offer.expiresAt <= now) this.offer = mintOffer(now)
    return this.offer
  }

  /** Replace the offer with a new one and return it. */
  rotate() {
    this.offer = mintOffer(this.now())
    return this.offer
  }

  /** Whether the caller has burned through its guess budget. */
  throttled() {
    const cutoff = this.now() - THROTTLE_WINDOW_MS
    this.failures = this.failures.filter((at) => at > cutoff)
    return this.failures.length >= MAX_PAIR_FAILURES
  }

  /**
   * Check a submitted code/secret. A success rotates the offer; a failure counts
   * against the throttle.
   * @param {unknown} code - the submitted code.
   * @param {unknown} secret - the submitted secret.
   * @returns {boolean} whether the pair may proceed.
   */
  consume(code, secret) {
    const now = this.now()
    if (!offerAccepts(this.current(), code, secret, now)) {
      this.failures.push(now)
      return false
    }
    this.rotate()
    return true
  }
}

