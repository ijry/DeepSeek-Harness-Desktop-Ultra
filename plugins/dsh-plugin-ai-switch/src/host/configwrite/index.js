/**
 * The config-write coordinator: prepare, commit, roll back, and report.
 *
 * The adapters decide WHAT to write; this module owns everything about DOING it —
 * resolving which clients were selected, minting the proxy key, assembling the model rows,
 * taking the snapshot, holding the path lock, and turning a failure into the exact
 * `ConfigWriteOutcome` row the panel paints.
 *
 * The invariant worth stating: every client is written as its own one-item group. A corrupt
 * ZCode config must not cost the user their working Codex write, so a failure is reported
 * per client rather than aborting the batch.
 *
 * @module dsh-plugin-ai-switch/host/configwrite/index
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ApiError, nowIso } from '../../shared/protocol.js'
import { FALLBACK_MODEL_ALIAS } from '../accounts.js'
import { buildCatalog, clientModelRows, codexCatalogBody } from '../models.js'
import { parsePlatform, requireCapability, TARGET_APPS } from '../platforms.js'
import { claudeClientConfig, selectedClientKeys } from '../settings.js'
import { uuid } from '../sdk.js'
import { ADAPTERS, CODEX_CATALOG_FILE, adapterByTargetKey, adaptersForPlatform } from './adapters.js'
import {
  PathLocks,
  inspect,
  normalizePath,
  removeIfHashMatches,
  sha256,
  writeAtomicIfUnchanged,
  writePrivateBackup,
} from './safewrite.js'

/** Snapshot rows the ledger keeps; older ones fall off with their backups orphaned. */
const SNAPSHOT_LIMIT = 500

/** Claude's four slot aliases, in the order the env keys are written. */
const CLAUDE_SLOT_ALIASES = [
  'claude-sonnet-alias',
  'claude-opus-alias',
  'claude-fable-alias',
  'claude-haiku-alias',
]

/** The coordinator. One instance per host. */
export class ConfigWriteService {
  /**
   * @param options.stores - the JSON stores (snapshots, keys, settings, pool, accounts).
   * @param options.accounts - the AccountService, for pool membership and model mappings.
   * @param options.keys - the ProxyKeyService.
   * @param options.proxy - the RouteProxy, for the base URL when the caller sends none.
   * @param options.home - the user's home directory (every adapter path hangs off it).
   */
  constructor({ stores, accounts, keys, proxy, home, env = process.env }) {
    this.stores = stores
    this.accounts = accounts
    this.keys = keys
    this.proxy = proxy
    this.home = home
    this.env = env
    this.locks = new PathLocks()
    this.startedAt = nowIso()
  }

  pathFor(adapter) {
    return adapter.resolvePath(this.home, this.env)
  }

  /** `list_target_apps`: the seeded client rows, in registry order. */
  listTargetApps() {
    return TARGET_APPS.map((target, index) => ({
      // The reference keys these rows by a database uuid; the key is already unique and
      // stable, and nothing in the panel does anything with the id but pass it back.
      id: target.key,
      key: target.key,
      platform: target.platform,
      display_name: target.display_name,
      enabled: 1,
      sort_order: index,
      created_at: this.startedAt,
      updated_at: this.startedAt,
    }))
  }

  /** `list_target_config_statuses`: one row per client, with its file's state. */
  async listTargetConfigStatuses() {
    const snapshots = await this.#snapshots()
    const rows = []
    for (const target of this.listTargetApps()) {
      const adapter = adapterByTargetKey(target.key)
      const mine = snapshots.filter((row) => row.target_app_id === target.key)
      const latest = mine.length === 0 ? null : mine[mine.length - 1]
      if (adapter === undefined) {
        rows.push({
          target,
          support_level: null,
          adapter_available: false,
          config_path: null,
          file_status: 'adapter_unavailable',
          last_write_status: null,
          last_error_code: null,
          last_written_at: null,
          snapshot_count: mine.length,
          latest_snapshot: latest === null ? null : projectSnapshot(latest),
        })
        continue
      }
      const path = this.pathFor(adapter)
      let fileStatus = 'missing'
      try {
        const state = await inspect(path)
        const text = state.existed ? state.bytes.toString('utf8') : null
        fileStatus = adapter.inspect(path, text).file_status
      } catch (error) {
        fileStatus = 'error'
        void error
      }
      rows.push({
        target,
        support_level: adapter.native ? 'supported' : 'partial',
        adapter_available: true,
        config_path: path,
        file_status: fileStatus,
        last_write_status: latest?.status ?? null,
        last_error_code: latest?.error_code ?? null,
        last_written_at: latest?.updated_at ?? null,
        snapshot_count: mine.length,
        latest_snapshot: latest === null ? null : projectSnapshot(latest),
      })
    }
    return rows
  }

  /** `list_config_write_clients`: the rows the write dialog offers for one platform. */
  async listConfigWriteClients(platform) {
    const id = parsePlatform(platform)
    const clients = []
    for (const adapter of adaptersForPlatform(id)) {
      const path = this.pathFor(adapter)
      let fileStatus = 'missing'
      let errorCode = null
      try {
        const state = await inspect(path)
        const text = state.existed ? state.bytes.toString('utf8') : null
        const result = adapter.inspect(path, text)
        fileStatus = result.file_status
        errorCode = result.error_code
      } catch (error) {
        fileStatus = 'error'
        errorCode = error instanceof ApiError ? error.code : null
      }
      clients.push({
        client_key: adapter.clientKey,
        display_name: adapter.clientDisplayName,
        native: adapter.native,
        restart_required: adapter.restartRequired,
        target_key: adapter.targetKey,
        platform: adapter.platform,
        config_path: path,
        file_status: fileStatus,
        error_code: errorCode,
      })
    }
    return clients
  }

  async #snapshots() {
    const document = await this.stores.snapshots.read()
    if (!Array.isArray(document.snapshots)) {
      document.snapshots = []
    }
    return document.snapshots
  }

  /** `list_config_snapshots`: newest first, capped, without the private fields. */
  async listSnapshots({ targetAppId = null, limit = null } = {}) {
    const rows = await this.#snapshots()
    const filtered = targetAppId === null ? rows : rows.filter((row) => row.target_app_id === targetAppId)
    const capped = Math.min(200, Math.max(1, Number.parseInt(String(limit ?? 50), 10) || 50))
    return filtered
      .slice()
      .reverse()
      .slice(0, capped)
      .map(projectSnapshot)
  }

  /**
   * Which clients a write targets: the explicit list, else the remembered selection, else
   * the platform's single native client.
   */
  async #resolveAdapters(platform, clientKeys) {
    const explicit = Array.isArray(clientKeys)
      ? clientKeys.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0)
      : []
    const settings = await this.stores.settings.read()
    const remembered = explicit.length > 0 ? null : selectedClientKeys(settings, platform)
    const wanted = explicit.length > 0 ? explicit : remembered
    const available = adaptersForPlatform(platform)
    if (wanted === null) {
      const native = available.filter((adapter) => adapter.native)
      return native.length > 0 ? native.slice(0, 1) : available.slice(0, 1)
    }
    return wanted.map((key) => {
      const adapter = available.find((item) => item.clientKey === key)
      if (adapter === undefined) {
        throw new ApiError('config.client_unavailable', 'That client cannot be written for this platform', {
          details: `${key}:${platform}`,
          recoverable: false,
        })
      }
      return adapter
    })
  }

  /** The base URL every adapter renders, from the caller or from the running proxy. */
  async #resolveBaseUrl(baseUrl) {
    const explicit = String(baseUrl ?? '').trim()
    const candidate = explicit.length > 0 ? explicit : (this.proxy?.status()?.base_url ?? '')
    if (String(candidate ?? '').trim().length === 0) {
      throw new ApiError('validation.route_proxy_not_running', 'Start the route proxy first', {
        details: 'base_url',
        recoverable: true,
      })
    }
    const normalized = String(candidate).trim().replace(/\/+$/, '')
    if (normalized.length === 0) {
      throw new ApiError('validation.route_proxy_base_url_required', 'A base URL is required', { details: 'base_url' })
    }
    return normalized
  }

  /**
   * The model rows and the Claude env plan the adapters render from.
   *
   * `[1M]` is appended to a slot alias only when every configuring account claims the
   * larger tier, because the suffix is a promise to the client about the whole pool.
   */
  async #buildInput(platform, baseUrl, adapters) {
    const proxyKey = await this.keys.ensure(platform)
    const aliases = await this.keys.aliases(platform)
    const pool = await this.accounts.getPool(platform)
    const members = []
    for (const accountId of pool.account_ids) {
      const row = await this.accounts.requireRow(accountId).catch(() => null)
      if (row !== null && row.archived_at === null) {
        members.push(row)
      }
    }
    const catalog = buildCatalog({ platform, members, mode: pool.model_mode })
    const needsModels = adapters.some((adapter) => adapter.requiresClientModels)
    if (needsModels && catalog.length === 0) {
      throw new ApiError('config.pool_models_empty', 'This pool advertises no models yet', {
        details: platform,
        recoverable: true,
      })
    }
    const settings = await this.stores.settings.read()
    const oneMillion = members.length > 0 && members.every((row) => claimsOneMillion(row))
    const suffix = oneMillion ? '[1M]' : ''
    return {
      baseUrl,
      proxyKey,
      keyAliases: aliases,
      claudeEnv: {
        subagentModel: '',
        fallbackModel: `${FALLBACK_MODEL_ALIAS}${suffix}`,
        slots: CLAUDE_SLOT_ALIASES.map((alias) => ({
          model: `${alias}${suffix}`,
          // No display name: the reference fills `…_MODEL_NAME` from a per-slot label the
          // pool does not always have, and an empty value DELETES the env key rather than
          // writing a blank one, which is the correct absence.
          displayName: '',
        })),
        clientConfig: claudeClientConfig(settings),
      },
      clientModels: needsModels ? clientModelRows(catalog) : [],
      catalog,
    }
  }

  /**
   * `write_route_proxy_configs`.
   *
   * Returns one outcome per selected client and only throws when NOTHING succeeded — a
   * partial success is a result the panel shows per row, not an error.
   */
  async writeConfigs({ baseUrl, platform, clientKeys }) {
    const id = parsePlatform(platform)
    requireCapability(id, 'config_write')
    const url = await this.#resolveBaseUrl(baseUrl)
    const adapters = await this.#resolveAdapters(id, clientKeys)
    const minted = await this.keys.mintedNow(id)
    let input
    try {
      input = await this.#buildInput(id, url, adapters)
    } catch (error) {
      if (minted) {
        await this.keys.dropIfUnused(id)
      }
      throw error
    }

    if (adapters.some((adapter) => adapter.clientKey === 'codex')) {
      // Written outside the snapshot machinery, exactly as in the reference: it is a file
      // only we create, and a rollback that left it behind is harmless because the
      // config.toml pointing at it is gone.
      await this.#writeCodexCatalog(input.catalog)
    }

    const outcomes = []
    let lastError = null
    for (const adapter of adapters) {
      try {
        outcomes.push(await this.#writeOne(adapter, id, input))
      } catch (error) {
        lastError = error
        outcomes.push({
          operation_id: '',
          snapshot_id: null,
          target_app_id: adapter.targetKey,
          target_key: adapter.targetKey,
          platform: id,
          path: '',
          status: 'failed',
          before_hash: null,
          after_hash: null,
          error_code: error instanceof ApiError ? error.code : 'filesystem.route_config_write',
        })
      }
    }
    if (!outcomes.some((outcome) => outcome.status === 'succeeded')) {
      if (minted) {
        await this.keys.dropIfUnused(id)
      }
      throw lastError ?? new ApiError('filesystem.route_config_write', 'No client configuration could be written')
    }
    return outcomes
  }

  async #writeCodexCatalog(catalog) {
    const path = join(this.home, '.codex', CODEX_CATALOG_FILE)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(codexCatalogBody(catalog), null, 2)}\n`, 'utf8')
  }

  /** Snapshot, then commit, one client's file. */
  async #writeOne(adapter, platform, input) {
    const path = this.pathFor(adapter)
    const operationId = uuid()
    return this.locks.withPaths([path], async () => {
      const before = await inspect(path)
      const text = before.existed ? before.bytes.toString('utf8') : null
      const replacement = adapter.render(path, text, input)
      const bytes = Buffer.from(replacement, 'utf8')
      const snapshotId = uuid()
      const backupPath = join(this.stores.backupDir, `${snapshotId}.backup`)
      if (before.existed) {
        await writePrivateBackup(backupPath, before.bytes)
      }
      await this.#insertSnapshot({
        id: snapshotId,
        target_app_id: adapter.targetKey,
        platform,
        operation: 'write',
        operation_group_id: operationId,
        source_snapshot_id: null,
        path,
        before_hash: before.hash,
        after_hash: sha256(bytes),
        backup_path: before.existed ? backupPath : null,
        original_file_existed: before.existed ? 1 : 0,
        status: 'prepared',
        error_code: null,
      })
      try {
        const result = await writeAtomicIfUnchanged(path, bytes, before)
        await this.#markSnapshot(snapshotId, { status: 'succeeded', after_hash: result.after_hash })
        return {
          operation_id: operationId,
          snapshot_id: snapshotId,
          target_app_id: adapter.targetKey,
          target_key: adapter.targetKey,
          platform,
          path,
          status: 'succeeded',
          before_hash: result.before_hash,
          after_hash: result.after_hash,
          error_code: null,
        }
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'filesystem.route_config_write'
        await this.#markSnapshot(snapshotId, {
          status: code === 'config.concurrent_modification' ? 'conflict' : 'failed',
          error_code: code,
        })
        throw error
      }
    })
  }

  async #insertSnapshot(row) {
    const stamp = nowIso()
    await this.stores.snapshots.update((document) => {
      const rows = Array.isArray(document.snapshots) ? document.snapshots : []
      rows.push({ ...row, metadata_json: JSON.stringify({ adapter_key: row.target_app_id, operation: row.operation }), created_at: stamp, updated_at: stamp })
      document.snapshots = rows.slice(-SNAPSHOT_LIMIT)
    })
  }

  async #markSnapshot(id, { status, error_code = null, after_hash = undefined }) {
    await this.stores.snapshots.update((document) => {
      const row = (document.snapshots ?? []).find((item) => item.id === id)
      if (row === undefined) {
        return
      }
      row.status = status
      row.error_code = error_code
      if (after_hash !== undefined) {
        row.after_hash = after_hash
      }
      row.updated_at = nowIso()
    })
  }

  /**
   * `route_config_write_is_stale`.
   *
   * Never throws: the nudge is a hint, and a hint that can fail a screen is worse than no
   * hint at all. A file we cannot read counts as stale, because writing it would change it.
   */
  async isStale({ baseUrl, platform, clientKeys }) {
    try {
      const id = parsePlatform(platform)
      const url = await this.#resolveBaseUrl(baseUrl)
      if (!(await this.keys.has(id))) {
        return false
      }
      const adapters = await this.#resolveAdapters(id, clientKeys)
      const input = await this.#buildInput(id, url, adapters)
      for (const adapter of adapters) {
        const path = this.pathFor(adapter)
        let current = null
        try {
          const state = await inspect(path)
          current = state.existed ? state.bytes.toString('utf8') : null
        } catch {
          return true
        }
        if (current === null) {
          return true
        }
        let rendered
        try {
          rendered = adapter.render(path, current, input)
        } catch {
          continue
        }
        if (!sameConfig(current, rendered)) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * `rollback_config_snapshot`: put the file back exactly as it was, or refuse.
   *
   * Every guard here exists because the alternative is destroying work: the adapter has to
   * still resolve to the same path, the file has to still hash to what we wrote, and the
   * backup has to still hash to what we replaced.
   */
  async rollback(id) {
    const snapshotId = String(id ?? '').trim()
    const rows = await this.#snapshots()
    const source = rows.find((row) => row.id === snapshotId)
    if (source === undefined || source.status !== 'succeeded' || source.operation !== 'write') {
      throw new ApiError('config.rollback_unavailable', 'That snapshot cannot be rolled back', {
        details: snapshotId,
        recoverable: false,
      })
    }
    const adapter = adapterByTargetKey(source.target_app_id)
    if (adapter === undefined) {
      throw new ApiError('config.adapter_unavailable', 'No writer for that client any more', {
        details: String(source.target_app_id),
        recoverable: false,
      })
    }
    if (source.platform !== null && source.platform !== adapter.platform) {
      throw new ApiError('config.adapter_target_mismatch', 'That snapshot belongs to another platform', {
        details: `${source.platform}:${adapter.platform}`,
        recoverable: false,
      })
    }
    const path = this.pathFor(adapter)
    if (normalizePath(path) !== normalizePath(source.path)) {
      throw new ApiError('config.path_unsafe', 'That client now writes somewhere else', {
        details: `${source.path} -> ${path}`,
        recoverable: false,
      })
    }

    return this.locks.withPaths([path], async () => {
      const current = await inspect(path)
      if (source.after_hash === null || !current.existed || current.hash !== source.after_hash) {
        throw new ApiError('config.rollback_conflict', 'The file changed since it was written; not rolling back', {
          details: path,
          recoverable: true,
        })
      }
      const newId = uuid()
      const operationId = uuid()
      const backupPath = join(this.stores.backupDir, `${newId}.backup`)
      await writePrivateBackup(backupPath, current.bytes)
      await this.#insertSnapshot({
        id: newId,
        target_app_id: adapter.targetKey,
        platform: adapter.platform,
        operation: 'rollback',
        operation_group_id: operationId,
        source_snapshot_id: source.id,
        path,
        before_hash: current.hash,
        after_hash: source.before_hash,
        backup_path: backupPath,
        original_file_existed: 1,
        status: 'prepared',
        error_code: null,
      })
      try {
        if (source.original_file_existed === 1) {
          const bytes = await readFile(join(this.stores.backupDir, `${source.id}.backup`))
          if (sha256(bytes) !== source.before_hash) {
            throw new ApiError('config.snapshot_failed', 'The stored backup no longer matches the snapshot', {
              details: source.id,
              recoverable: false,
            })
          }
          await writeAtomicIfUnchanged(path, bytes, current)
        } else {
          await removeIfHashMatches(path, source.after_hash)
        }
        await this.#markSnapshot(newId, { status: 'succeeded' })
        return {
          operation_id: operationId,
          snapshot_id: newId,
          target_app_id: adapter.targetKey,
          target_key: adapter.targetKey,
          platform: adapter.platform,
          path,
          status: 'succeeded',
          before_hash: current.hash,
          after_hash: source.before_hash,
          error_code: null,
        }
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'config.rollback_failed'
        await this.#markSnapshot(newId, {
          status: ['config.concurrent_modification', 'config.rollback_conflict'].includes(code) ? 'conflict' : 'failed',
          error_code: code,
        })
        throw error
      }
    })
  }
}

/**
 * A snapshot row as the panel sees it.
 *
 * `backup_path` and `metadata_json` are deliberately dropped: the first is a path to a file
 * holding someone's previous credentials, and neither is anything the UI renders.
 */
function projectSnapshot(row) {
  return {
    id: row.id,
    target_app_id: row.target_app_id,
    platform: row.platform,
    operation: row.operation,
    operation_group_id: row.operation_group_id,
    source_snapshot_id: row.source_snapshot_id,
    path: row.path,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    original_file_existed: row.original_file_existed,
    status: row.status,
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Does every mapping on this account claim the 1M tier? */
function claimsOneMillion(row) {
  try {
    const config = JSON.parse(String(row.config_json ?? '{}'))
    const mappings = Array.isArray(config.model_mappings) ? config.model_mappings : []
    return mappings.length > 0 && mappings.every((mapping) => mapping?.supports_1m === true)
  } catch {
    return false
  }
}

/**
 * Are these two config files the same for our purposes?
 *
 * JSON is compared as data so key order and indentation cannot make a file look stale
 * forever; TOML and YAML are compared as bytes, because our own writer produced both sides
 * and any difference there is a real difference.
 */
export function sameConfig(left, right) {
  if (left === right) {
    return true
  }
  try {
    const a = JSON.parse(left)
    const b = JSON.parse(right)
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export { ADAPTERS, adapterByTargetKey, adaptersForPlatform }

