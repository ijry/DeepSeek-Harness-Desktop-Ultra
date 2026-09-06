/**
 * Per-platform proxy keys.
 *
 * Every client config we write carries a bearer token, and that token is how the proxy
 * knows which platform's pool a request belongs to. One current key per platform, plus a
 * list of retired ones that are still accepted — rotating a key must not break a CLI whose
 * config has not been rewritten yet.
 *
 * The format is the reference's, and the config adapters recognize their own hand-made
 * entries by it: `sk-ai-switch-<32 hex>`.
 *
 * @module dsh-plugin-ai-switch/host/keys
 */
import { nowIso } from '../shared/protocol.js'
import { generateProxyKey } from './sdk.js'

/** How many retired keys stay valid per platform. */
const ALIAS_LIMIT = 8

export class ProxyKeyService {
  constructor({ store }) {
    this.store = store
    this.minted = new Set()
  }

  async #document() {
    const document = await this.store.read()
    if (document.keys === null || typeof document.keys !== 'object') {
      document.keys = {}
    }
    if (!Array.isArray(document.aliases)) {
      document.aliases = []
    }
    return document
  }

  /** Does this platform already have a key? */
  async has(platform) {
    const document = await this.#document()
    return typeof document.keys[platform] === 'string' && document.keys[platform].length > 0
  }

  /**
   * The current key, minting one if there is none.
   *
   * A key minted here is remembered in `minted` so a write that then fails outright can
   * drop it again — leaving a key behind that no config references is harmless but untidy,
   * and the reference cleans up too.
   */
  async ensure(platform) {
    const document = await this.#document()
    const existing = document.keys[platform]
    if (typeof existing === 'string' && existing.length > 0) {
      return existing
    }
    const key = generateProxyKey()
    await this.store.update((mutable) => {
      mutable.keys = { ...(mutable.keys ?? {}), [platform]: key }
    })
    this.minted.add(platform)
    return key
  }

  /** Was this platform's key minted during this run and not yet used successfully? */
  async mintedNow(platform) {
    return !(await this.has(platform))
  }

  /** Forget a key we minted for a write that then failed entirely. */
  async dropIfUnused(platform) {
    if (!this.minted.has(platform)) {
      return
    }
    this.minted.delete(platform)
    await this.store.update((document) => {
      const keys = { ...(document.keys ?? {}) }
      delete keys[platform]
      document.keys = keys
    })
  }

  /** Mark this platform's key as in use, so it will not be dropped. */
  keep(platform) {
    this.minted.delete(platform)
  }

  /** Retired keys still accepted for this platform. */
  async aliases(platform) {
    const document = await this.#document()
    return document.aliases.filter((entry) => entry.platform === platform).map((entry) => entry.proxy_key)
  }

  /** Mint a fresh key, retiring the old one rather than invalidating it. */
  async rotate(platform) {
    const document = await this.#document()
    const previous = document.keys[platform]
    const key = generateProxyKey()
    await this.store.update((mutable) => {
      mutable.keys = { ...(mutable.keys ?? {}), [platform]: key }
      const aliases = Array.isArray(mutable.aliases) ? mutable.aliases : []
      if (typeof previous === 'string' && previous.length > 0) {
        aliases.push({ proxy_key: previous, platform, created_at: nowIso() })
      }
      const mine = aliases.filter((entry) => entry.platform === platform).slice(-ALIAS_LIMIT)
      mutable.aliases = [...aliases.filter((entry) => entry.platform !== platform), ...mine]
    })
    return key
  }

  /**
   * Which platform a presented bearer token belongs to, or null.
   *
   * Accepts a retired key too — see the module header. Also accepts the reference's older
   * `sk-ai-switch-test-` prefix by rotating it away on read, because a config written by
   * the desktop app during testing should not simply stop working.
   */
  async platformForKey(key) {
    const presented = String(key ?? '').trim()
    if (presented.length === 0) {
      return null
    }
    const document = await this.#document()
    for (const [platform, value] of Object.entries(document.keys)) {
      if (value === presented) {
        return platform
      }
    }
    const alias = document.aliases.find((entry) => entry.proxy_key === presented)
    return alias?.platform ?? null
  }

  /** Every platform that has a key, for the proxy's own bookkeeping. */
  async platforms() {
    const document = await this.#document()
    return Object.keys(document.keys)
  }
}
