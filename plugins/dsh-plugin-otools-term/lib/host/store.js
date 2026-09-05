/**
 * The panel's durable ledger: one JSON file under the DSH home holding what the
 * reference kept in its OTools plugin-state blob — the server list, the favourite
 * commands, the favourite SFTP directories, the settings, and the workspace
 * layout (which tabs were open, splitter positions, chosen theme).
 *
 * Secrets are NOT here. Passwords, private-key passphrases and pasted key bodies
 * live in a separate 0600 file (host/secrets.js) and never reach the browser; the
 * records in this file only carry `hasPassword`-style booleans. The reference kept
 * passwords in plain text inside the same blob it shipped to its front end.
 *
 * Every write is atomic (temp file + rename in the same directory) and serialized
 * through one chain, so two concurrent saves cannot drop each other's keys. A
 * corrupt file is quarantined and treated as defaults rather than taking the
 * routes down.
 *
 * @module dsh-plugin-otools-term/host/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  CLOSE_BEHAVIORS,
  newId,
  normalizeFlag,
  normalizeId,
  normalizeInt,
  normalizeServer,
  TermError,
  ERR,
} from '../shared/protocol.js'

/** Ledger file name; the caller joins it onto the DSH home. */
export const STORE_FILE = 'dsh-plugin-otools-term.json'

/** Stored-file schema version (bump on breaking record changes). */
const SCHEMA_VERSION = 1

/** Ceiling on stored rows, so a runaway client cannot grow the file forever. */
const MAX_SERVERS = 300
const MAX_FAVORITE_COMMANDS = 200
const MAX_FAVORITE_DIRS = 100

/** The settings a brand-new install behaves by. */
export function defaultPrefs() {
  return {
    closeBehavior: 'close-tabs',
    themeName: 'default',
    fontSize: 13,
    scrollback: 2000,
    cursorBlink: true,
    copyOnSelect: false,
    sidebarVisible: true,
    sidebarWidth: 260,
    serverListHeight: 220,
    sftpVisible: true,
    aiLanguage: 'zh',
    confirmDangerousCommands: true,
    localShell: '',
  }
}

/** Numeric prefs and their bounds. */
const NUMBERS = {
  fontSize: [8, 32],
  scrollback: [200, 200_000],
  sidebarWidth: [180, 560],
  serverListHeight: [120, 1_200],
}

/** Enum prefs and their allowed values. */
const ENUMS = {
  closeBehavior: CLOSE_BEHAVIORS,
  aiLanguage: ['zh', 'en'],
  themeName: undefined,
  localShell: undefined,
}

/** Coerce one pref onto the shape the defaults declare, or undefined to skip. */
function sanitize(key, value, fallback) {
  if (typeof fallback === 'boolean') {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    return undefined
  }
  if (typeof fallback === 'number') {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(parsed)) return undefined
    const bounds = NUMBERS[key]
    if (bounds === undefined) return Math.round(parsed)
    return Math.max(bounds[0], Math.min(bounds[1], Math.round(parsed)))
  }
  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return undefined
    const allowed = ENUMS[key]
    if (allowed === undefined) return value.slice(0, 400)
    return allowed.includes(value) ? value : undefined
  }
  return undefined
}

/** A favourite command row. */
function sanitizeCommand(value) {
  if (value === null || typeof value !== 'object') return null
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  if (command.length === 0 || command.length > 4_000) return null
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 120) : ''
  return { name, command }
}

/** The ledger. */
export class TermStore {
  constructor(options) {
    this.file = options.file
    this.state = {
      servers: [],
      favoriteCommands: [],
      favoriteDirs: Object.create(null),
      prefs: defaultPrefs(),
      workspace: null,
    }
    this.revision = 0
    this.loaded = false
    this.writes = Promise.resolve()
    this.listeners = new Set()
  }

  /** Subscribe to committed changes; returns the unsubscriber. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Announce a committed change. A throwing listener must not break a write. */
  broadcast(kind) {
    for (const listener of [...this.listeners]) {
      try {
        listener({ revision: this.revision, kind })
      } catch (error) {
        console.warn('[dsh-plugin-otools-term] store listener threw:', error?.message ?? error)
      }
    }
  }

  /** Load once. Never throws — a broken file degrades to defaults. */
  async load() {
    if (this.loaded) return this.state
    this.loaded = true
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[dsh-plugin-otools-term] ledger unreadable:', error.message)
      return this.state
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[dsh-plugin-otools-term] quarantining corrupt ledger')
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return this.state
    }

    if (Array.isArray(parsed.servers)) {
      const servers = []
      for (const row of parsed.servers.slice(0, MAX_SERVERS)) {
        // One unusable row must not lose the rest of the list.
        try {
          servers.push(normalizeServer(row))
        } catch (error) {
          console.warn('[dsh-plugin-otools-term] dropping unusable server row:', error?.message ?? error)
        }
      }
      this.state.servers = servers
    }
    if (Array.isArray(parsed.favoriteCommands)) {
      this.state.favoriteCommands = parsed.favoriteCommands
        .slice(0, MAX_FAVORITE_COMMANDS)
        .map(sanitizeCommand)
        .filter((row) => row !== null)
    }
    // Null prototype: server ids come out of a file, and a hand-edited
    // `__proto__` key must become a row rather than touch a prototype.
    const dirs = Object.create(null)
    if (typeof parsed.favoriteDirs === 'object' && parsed.favoriteDirs !== null && !Array.isArray(parsed.favoriteDirs)) {
      for (const [id, rows] of Object.entries(parsed.favoriteDirs)) {
        if (!Array.isArray(rows)) continue
        const paths = rows
          .filter((row) => typeof row === 'string' && row.trim().length > 0)
          .map((row) => row.trim().slice(0, 4_096))
          .slice(0, MAX_FAVORITE_DIRS)
        if (paths.length > 0) dirs[String(id).slice(0, 200)] = paths
      }
    }
    this.state.favoriteDirs = dirs

    const defaults = defaultPrefs()
    const prefs = defaultPrefs()
    if (typeof parsed.prefs === 'object' && parsed.prefs !== null && !Array.isArray(parsed.prefs)) {
      for (const key of Object.keys(defaults)) {
        if (!Object.hasOwn(parsed.prefs, key)) continue
        const clean = sanitize(key, parsed.prefs[key], defaults[key])
        if (clean !== undefined) prefs[key] = clean
      }
    }
    this.state.prefs = prefs
    this.state.workspace = typeof parsed.workspace === 'object' && parsed.workspace !== null && !Array.isArray(parsed.workspace)
      ? parsed.workspace
      : null
    return this.state
  }

  /** Servers as the browser sees them, with secret presence folded in. */
  serverList(secrets) {
    return this.state.servers.map((server) => ({
      ...server,
      hasPassword: secrets === undefined ? false : secrets.has(server.id, 'password'),
      hasPassphrase: secrets === undefined ? false : secrets.has(server.id, 'passphrase'),
      hasPrivateKeyBody: secrets === undefined ? false : secrets.has(server.id, 'privateKeyBody'),
    }))
  }

  /** One server by id, or undefined. */
  server(id) {
    return this.state.servers.find((row) => row.id === id)
  }

  /** One server by id, or a not-found failure. */
  requireServer(id) {
    const server = this.server(id)
    if (server === undefined) throw new TermError(ERR.notFound, `没有这个连接: ${id}`)
    return server
  }

  /** Insert or replace one server. Returns the stored record. */
  async saveServer(draft) {
    await this.load()
    const id = draft !== null && typeof draft === 'object' && draft.id !== undefined && draft.id !== null && draft.id !== ''
      ? normalizeId(draft.id, 'id')
      : newId('srv')
    const server = normalizeServer(draft, { id })
    const index = this.state.servers.findIndex((row) => row.id === id)
    if (index === -1) {
      if (this.state.servers.length >= MAX_SERVERS) throw new TermError(ERR.invalidInput, '连接数量已达上限')
      this.state.servers = [...this.state.servers, server]
    } else {
      const next = [...this.state.servers]
      next[index] = server
      this.state.servers = next
    }
    await this.commit('servers-changed')
    return server
  }

  /** Remove one server. */
  async removeServer(id) {
    await this.load()
    this.state.servers = this.state.servers.filter((row) => row.id !== id)
    delete this.state.favoriteDirs[id]
    await this.commit('servers-changed')
  }

  /** Replace one server's forwarding rules and SOCKS5 config. */
  async saveForwarding(id, patch) {
    await this.load()
    const server = this.requireServer(id)
    const next = normalizeServer({ ...server, ...patch }, { id })
    const index = this.state.servers.findIndex((row) => row.id === id)
    const servers = [...this.state.servers]
    servers[index] = next
    this.state.servers = servers
    await this.commit('servers-changed')
    return next
  }

  /** Merge a preference patch. */
  async savePrefs(patch) {
    await this.load()
    const defaults = defaultPrefs()
    const clean = {}
    if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
      for (const key of Object.keys(defaults)) {
        if (!Object.hasOwn(patch, key)) continue
        const value = sanitize(key, patch[key], defaults[key])
        if (value !== undefined) clean[key] = value
      }
    }
    if (Object.keys(clean).length === 0) return { ...this.state.prefs }
    this.state.prefs = { ...this.state.prefs, ...clean }
    await this.commit('prefs-changed')
    return { ...this.state.prefs }
  }

  /** Replace the favourite-command list. */
  async saveCommands(rows) {
    await this.load()
    const list = Array.isArray(rows)
      ? rows.slice(0, MAX_FAVORITE_COMMANDS).map(sanitizeCommand).filter((row) => row !== null)
      : []
    this.state.favoriteCommands = list
    await this.commit('commands-changed')
    return list
  }

  /** Replace one server's favourite directories. */
  async saveFavoriteDirs(serverId, paths) {
    await this.load()
    const list = Array.isArray(paths)
      ? paths
        .filter((row) => typeof row === 'string' && row.trim().length > 0)
        .map((row) => row.trim().slice(0, 4_096))
        .slice(0, MAX_FAVORITE_DIRS)
      : []
    if (list.length === 0) delete this.state.favoriteDirs[serverId]
    else this.state.favoriteDirs[serverId] = list
    await this.commit('favorites-changed')
    return list
  }

  /**
   * Store the browser's layout snapshot verbatim.
   *
   * Not validated field by field on purpose: it is opaque UI state written and
   * read by the same bundle, and the only thing the host cares about is that it
   * stays small. A hostile value can at worst confuse the panel that wrote it.
   */
  async saveWorkspace(snapshot) {
    await this.load()
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      this.state.workspace = null
    } else {
      const text = JSON.stringify(snapshot)
      if (text.length > 256 * 1024) throw new TermError(ERR.tooLarge, 'workspace snapshot is too large')
      this.state.workspace = JSON.parse(text)
    }
    await this.commit('workspace-changed')
    return this.state.workspace
  }

  /** Everything the browser needs in one object. */
  snapshot(secrets) {
    return {
      revision: this.revision,
      servers: this.serverList(secrets),
      favoriteCommands: this.state.favoriteCommands.map((row) => ({ ...row })),
      favoriteDirs: Object.fromEntries(Object.entries(this.state.favoriteDirs).map(([id, rows]) => [id, [...rows]])),
      prefs: { ...this.state.prefs },
      workspace: this.state.workspace,
    }
  }

  /** Bump the revision, write, then announce. */
  async commit(kind) {
    this.revision += 1
    await this.persist()
    this.broadcast(kind)
  }

  /** Atomic write inside the serial chain. */
  persist() {
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const content = JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        servers: this.state.servers,
        favoriteCommands: this.state.favoriteCommands,
        favoriteDirs: this.state.favoriteDirs,
        prefs: this.state.prefs,
        workspace: this.state.workspace,
      }, null, 2)
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, this.file)
    }
    const result = this.writes.then(run, run)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Coerce a boolean-ish query/body flag (re-exported for the routes). */
export { normalizeFlag, normalizeInt }
