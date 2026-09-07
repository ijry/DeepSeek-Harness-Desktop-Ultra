/**
 * The command table.
 *
 * One POST route per command (`/dsh-plugin-ai-switch/api/<command>`), carrying the same
 * command names the reference's Tauri backend answered — because the panel is that app's
 * React front end unmodified and still calls `call("list_route_credentials", …)`. That is
 * the whole trick of this port: the transport changed, the vocabulary did not.
 *
 * Three other routes: the WebSocket the panel subscribes to (with an SSE fallback for a dsh
 * build without an upgrade hook), the built panel bundle under `/app/`, and `/health`, which
 * is how the client half learns which language to open the panel in.
 *
 * Argument casing follows the reference exactly, quirks included: most commands take
 * camelCase (`baseUrl`, `clientKeys`, `targetAppId`), but five opt out and take snake_case
 * (`model_key`, `request_page`…). The panel sends whichever the reference sent, so both
 * spellings are accepted where they differ and neither is "the" name.
 *
 * @module dsh-plugin-ai-switch/host/routes
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ApiError, nowIso, requireText } from '../shared/protocol.js'

import { AccountService } from './accounts.js'
import { ConfigWriteService } from './configwrite/index.js'
import { fail, json as okJson, readJsonBody, serveStatic } from './http.js'
import * as importers from './importers.js'
import { ProxyKeyService } from './keys.js'
import { Activity, UsageLedger } from './ledger.js'
import * as mcp from './mcp.js'
import { fetchRouteModels } from './model-fetch.js'
import { buildCatalog } from './models.js'
import { listPlatformCapabilities, parsePlatform, PLATFORM_IDS } from './platforms.js'
import * as quota from './quota.js'
import * as skills from './skills.js'
import { RouteProxy } from './proxy.js'
import {
  desktopOnly,
  getDiskSpaceStatus,
  getRouteProxyHttpsStatus,
  getTailscaleStatus,
  getWebServerStatus,
  getWebServiceConfig,
} from './runtime-status.js'
import { PLUGIN_ID, panelLanguage, pluginHomePath, userHome, uuid } from './sdk.js'
import { getSettings, saveSettings } from './settings.js'
import { getSessionMessages, listSessions } from './sessions.js'
import { EventHub, registerSockets } from './socket.js'
import { createStores } from './store.js'
import { listAgentLaunchOptions, ptyAvailable, TerminalManager } from './terminals.js'
import { getSessionUsageStats, getUsageOverview } from './usage.js'

export const ROUTE_PREFIX = `/${PLUGIN_ID}`
export const SSE_PATH = `${ROUTE_PREFIX}/events`

/**
 * Where the built panel lives.
 *
 * In the published package this file is `lib/host/routes.js` and the bundle is its sibling
 * `lib/webview`. Running straight from `src/` — which the tests and a `link:` install both
 * do — that path does not exist, because Vite only ever writes into `lib/`. So the sibling
 * is preferred and `../../lib/webview` is the fallback, rather than making the source tree
 * carry a copy of a 3 MB bundle.
 */
const WEBVIEW_DIR = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  const sibling = join(here, '..', 'webview')
  return existsSync(sibling) ? sibling : join(here, '..', '..', 'lib', 'webview')
})()

/**
 * Build everything the routes need. Split out so the tests can drive the command table
 * without a web server.
 */
export function createContext({ home = pluginHomePath(), userHomeDir = userHome(), emit = () => {}, webServer = null } = {}) {
  const stores = createStores(home)
  const activity = new Activity(emit)
  const ledger = new UsageLedger({ store: stores.usage })
  const keys = new ProxyKeyService({ store: stores.keys })
  const accounts = new AccountService({ stores, activity, ledger })
  const proxy = new RouteProxy({ accounts, keys, ledger, activity, emit })
  const configWrite = new ConfigWriteService({ stores, accounts, keys, proxy, home: userHomeDir })
  const terminals = new TerminalManager({ emit })
  return {
    stores,
    activity,
    ledger,
    keys,
    accounts,
    proxy,
    configWrite,
    terminals,
    home,
    userHomeDir,
    webServer,
    emit,
  }
}

/** The advertised catalog for one platform — shared by the proxy and the launch options. */
async function catalogFor(context, platform) {
  const pool = await context.accounts.getPool(platform)
  const members = []
  for (const accountId of pool.account_ids) {
    const row = await context.accounts.requireRow(accountId).catch(() => null)
    if (row !== null && row.archived_at === null) {
      members.push(row)
    }
  }
  return buildCatalog({ platform, members, mode: pool.model_mode })
}

/**
 * Read a command argument that the reference spells differently in different commands.
 *
 * Five of its commands opt out of Tauri's camelCase rewriting, so the panel sends
 * `model_key` to one command and `targetAppId` to another. Accepting both spellings costs
 * nothing and removes a whole class of "why is this argument undefined" bug.
 */
function arg(args, ...names) {
  for (const name of names) {
    if (args?.[name] !== undefined) {
      return args[name]
    }
  }
  return undefined
}

/**
 * The command table: the reference's `dispatch_command`, as a plain object.
 *
 * Every entry takes the args object and returns the value the panel expects. Anything absent
 * from this table answers `web.command_unknown`, the same code the reference uses, so the
 * panel's own "this build cannot do that" handling still works.
 */
export function buildCommands(context) {
  const { accounts, configWrite, keys, ledger, proxy, stores, terminals } = context

  return {
    // ------------------------------------------------------------------ health
    health: async () => ({ ok: true }),

    // ---------------------------------------------------------------- settings
    get_settings: () => getSettings(stores.settings, context.home),
    save_settings: (args) => saveSettings(stores.settings, context.home, arg(args, 'settings')),

    // ------------------------------------------------------- runtime status
    get_disk_space_status: () => getDiskSpaceStatus(context.home),
    get_route_proxy_https_status: () => getRouteProxyHttpsStatus(context.home),
    enable_route_proxy_https: () => desktopOnly('enable_route_proxy_https'),
    disable_route_proxy_https: () => desktopOnly('disable_route_proxy_https'),
    reimport_route_proxy_root_ca: () => desktopOnly('reimport_route_proxy_root_ca'),
    regenerate_route_proxy_https_certificates: () =>
      desktopOnly('regenerate_route_proxy_https_certificates'),
    uninstall_route_proxy_root_ca: () => desktopOnly('uninstall_route_proxy_root_ca'),
    delete_route_proxy_https_certificates: () => desktopOnly('delete_route_proxy_https_certificates'),
    get_web_service_config: () => getWebServiceConfig(),
    save_web_service_config: () => desktopOnly('save_web_service_config'),
    get_web_server_status: () => getWebServerStatus(context.webServer),
    start_web_server: () => desktopOnly('start_web_server'),
    stop_web_server: () => desktopOnly('stop_web_server'),
    get_tailscale_status: () => getTailscaleStatus(),
    create_mobile_pairing: () => desktopOnly('create_mobile_pairing'),
    start_tailscale_login: () => desktopOnly('start_tailscale_login'),
    start_tailscale_with_auth_key: () => desktopOnly('start_tailscale_with_auth_key'),
    disconnect_tailscale: () => desktopOnly('disconnect_tailscale'),

    // ------------------------------------------------------ platform + targets
    list_platform_capabilities: () => listPlatformCapabilities(),
    list_target_apps: () => configWrite.listTargetApps(),
    list_target_config_statuses: () => configWrite.listTargetConfigStatuses(),
    list_config_write_clients: (args) => configWrite.listConfigWriteClients(arg(args, 'platform')),
    list_config_snapshots: (args) =>
      configWrite.listSnapshots({
        targetAppId: arg(args, 'targetAppId', 'target_app_id') ?? null,
        limit: arg(args, 'limit') ?? null,
      }),
    rollback_config_snapshot: (args) => configWrite.rollback(arg(args, 'id')),
    write_route_proxy_configs: (args) =>
      configWrite.writeConfigs({
        baseUrl: arg(args, 'baseUrl', 'base_url') ?? null,
        platform: arg(args, 'platform'),
        clientKeys: arg(args, 'clientKeys', 'client_keys') ?? null,
      }),
    route_config_write_is_stale: (args) =>
      configWrite.isStale({
        baseUrl: arg(args, 'baseUrl', 'base_url') ?? null,
        platform: arg(args, 'platform'),
        clientKeys: arg(args, 'clientKeys', 'client_keys') ?? null,
      }),

    // ----------------------------------------------------------- route proxy
    get_route_proxy_status: () => proxy.status(),
    start_route_proxy: () => proxy.start(),
    stop_route_proxy: () => proxy.stop(),
    get_route_proxy_key: (args) => keys.ensure(parsePlatform(arg(args, 'platform'))),
    subscribe_route_proxy_live_log: (args) => proxy.subscribeLiveLog(parsePlatform(arg(args, 'platform'))),
    unsubscribe_route_proxy_live_log: () => proxy.unsubscribeLiveLog(),

    // -------------------------------------------------------------- accounts
    list_route_credentials: (args) => accounts.list(arg(args, 'platform')),
    list_route_credentials_page: (args) => accounts.page(arg(args, 'input')),
    get_route_credential: (args) => accounts.get(arg(args, 'id')),
    create_api_route_credential: (args) => accounts.createApi(arg(args, 'input')),
    update_route_credential: (args) => accounts.update(arg(args, 'id'), arg(args, 'input')),
    copy_route_credential: (args) => accounts.copy(arg(args, 'id'), arg(args, 'input') ?? {}),
    delete_route_credential: (args) => accounts.remove(arg(args, 'id')),
    archive_route_credentials: (args) => accounts.archive(arg(args, 'ids')),
    restore_route_credentials: (args) => accounts.restore(arg(args, 'ids')),
    set_route_credential_statuses: (args) => accounts.setStatuses(arg(args, 'ids'), arg(args, 'status')),
    reorder_route_credentials: (args) => accounts.reorder(arg(args, 'input')),
    set_route_credential_cooldown: (args) => accounts.setCooldown(arg(args, 'id'), arg(args, 'seconds')),
    clear_route_credential_failure_state: (args) => accounts.clearFailureState(arg(args, 'id')),
    set_route_credential_model_status: (args) =>
      accounts.setModelStatus(arg(args, 'id'), arg(args, 'model_key', 'modelKey'), arg(args, 'status')),
    clear_route_credential_model_state: (args) =>
      accounts.clearModelState(arg(args, 'id'), arg(args, 'model_key', 'modelKey')),
    set_route_credential_recovery: (args) => accounts.setRecovery(arg(args, 'id'), arg(args, 'rule')),

    // ------------------------------------------------------ import / export
    export_route_credentials: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.exportCredentials(
        {
          selectionContext: input.selection_context,
          credentialIds: input.credential_ids,
          includeEnhancedMetadata: input.include_enhanced_metadata,
        },
        { stores, accounts },
      )
    },
    preview_route_credential_import: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.previewTransferImport(
        { text: input.text, ambiguousPlatformChoices: input.ambiguous_platform_choices ?? [] },
        { stores, accounts },
      )
    },
    import_route_credentials: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.importTransferCredentials(
        {
          text: input.text,
          ambiguousPlatformChoices: input.ambiguous_platform_choices ?? [],
          restorePoolMembership: input.restore_pool_membership === true,
        },
        { stores, accounts },
      )
    },
    preview_external_client_import: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.previewExternalClientImport(
        { client: input.client, platform: input.platform, sourcePath: input.source_path ?? null },
        { stores, accounts },
      )
    },
    import_external_client_accounts: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.importExternalClientAccounts(
        {
          client: input.client,
          platform: input.platform,
          sourcePath: input.source_path ?? null,
          sourceIds: input.source_ids ?? [],
        },
        { stores, accounts },
      )
    },
    import_official_route_credentials_from_text: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.importOfficialFromText(
        { platform: input.platform, text: input.text, batchName: input.batch_name },
        { stores, accounts },
      )
    },
    import_official_route_credentials_from_files: (args) => {
      const input = arg(args, 'input') ?? {}
      return importers.importOfficialFromFiles(
        { platform: input.platform, filePaths: input.file_paths ?? [], batchName: input.batch_name },
        { stores, accounts },
      )
    },

    // ------------------------------------------------------- quota / balance
    refresh_route_credential_quota: async (args) =>
      quota.refreshQuota(await accounts.requireRow(requireText(arg(args, 'id'), 'id')), { accounts }),
    refresh_route_credentials_quota: async (args) => {
      const rows = await accounts.list(parsePlatform(arg(args, 'platform')))
      const outcomes = []
      for (const row of rows) {
        if (row.kind === 'official') outcomes.push(await quota.refreshQuota(row, { accounts }))
      }
      return outcomes
    },
    refresh_route_credential_relay_balance: async (args) =>
      quota.refreshRelayBalance(await accounts.requireRow(requireText(arg(args, 'id'), 'id')), { accounts }),
    refresh_route_credentials_relay_balance: async (args) => {
      const rows = await accounts.list(parsePlatform(arg(args, 'platform')))
      const outcomes = []
      for (const row of rows) outcomes.push(await quota.refreshRelayBalance(row, { accounts }))
      return outcomes
    },

    // ------------------------------------------------------------------ pool
    get_route_pool: (args) =>
      accounts.getPool(arg(args, 'platform'), {
        since: arg(args, 'since') ?? null,
        requestPage: arg(args, 'request_page', 'requestPage') ?? null,
        requestPageSize: arg(args, 'request_page_size', 'requestPageSize') ?? null,
      }),
    set_route_pool_members: (args) => {
      const input = arg(args, 'input') ?? {}
      return accounts.setMembers(input.platform, input.account_ids ?? input.accountIds ?? [])
    },
    set_route_pool_model_mode: (args) => {
      const input = arg(args, 'input') ?? {}
      return accounts.setModelMode(input.platform, input.mode)
    },
    route_pool_route_once: (args) => accounts.routeOnce(arg(args, 'request')),
    fetch_route_models: (args) => fetchRouteModels(arg(args, 'request')),

    // --------------------------------------------------------------- sessions
    list_sessions: (args) => listSessions({ platform: arg(args, 'platform') ?? null }),
    get_session_messages: (args) =>
      getSessionMessages({
        providerId: arg(args, 'providerId', 'provider_id'),
        sourcePath: arg(args, 'sourcePath', 'source_path'),
      }),

    // ------------------------------------------------------------------ usage
    get_session_usage_stats: (args) => getSessionUsageStats({ since: arg(args, 'since') ?? null }),
    get_usage_overview: async (args) => {
      await ledger.load()
      return getUsageOverview({
        since: arg(args, 'since') ?? null,
        page: arg(args, 'page') ?? 1,
        pageSize: arg(args, 'page_size', 'pageSize') ?? 20,
        utcOffsetMinutes: arg(args, 'utc_offset_minutes', 'utcOffsetMinutes') ?? 0,
        proxyEvents: ledger.all(),
        prices: await stores.prices.read(),
      })
    },
    get_model_price_configs: () => stores.prices.read(),
    save_model_price_configs: async (args) => {
      const configs = arg(args, 'configs') ?? {}
      await stores.prices.update((document) => {
        for (const key of Object.keys(document)) {
          delete document[key]
        }
        Object.assign(document, configs)
      })
      return Object.keys(configs).length
    },
    reload_model_price_overrides: async () => {
      stores.prices.reset()
      return Object.keys(await stores.prices.read()).length
    },

    // -------------------------------------------------------------- terminals
    list_agent_launch_options: async () => {
      const catalogs = new Map()
      for (const platform of PLATFORM_IDS) {
        catalogs.set(platform, await catalogFor(context, platform))
      }
      return listAgentLaunchOptions({ catalogFor: (platform) => catalogs.get(platform) ?? [] })
    },
    list_terminal_sessions: () => terminals.list(),
    create_terminal_session: (args) => terminals.create(arg(args, 'input')),
    write_terminal_input: (args) =>
      terminals.write(arg(args, 'sessionId', 'session_id'), arg(args, 'data')),
    resize_terminal: (args) =>
      terminals.resize(arg(args, 'sessionId', 'session_id'), arg(args, 'cols'), arg(args, 'rows')),
    kill_terminal_session: (args) => terminals.kill(arg(args, 'sessionId', 'session_id')),

    // ---------------------------------------------------------------- batches
    list_batch_groups: (args) => listBatchGroups(context, arg(args, 'search') ?? null),
    create_batch: (args) => createBatch(context, arg(args, 'input')),

    // -------------------------------------------------------------------- MCP
    mcp_scan_local: () => mcp.scanLocal(),
    mcp_list_marketplaces: () => mcp.listMarketplaces(),
    mcp_search_marketplace: (args) =>
      mcp.searchMarketplace({
        providerId: arg(args, 'providerId', 'provider_id'),
        query: arg(args, 'query') ?? '',
        limit: arg(args, 'limit') ?? null,
      }),
    mcp_get_marketplace_server_detail: (args) =>
      mcp.getMarketplaceServerDetail({
        providerId: arg(args, 'providerId', 'provider_id'),
        serverId: arg(args, 'serverId', 'server_id'),
      }),
    mcp_install_from_marketplace: (args) =>
      mcp.installFromMarketplace({
        providerId: arg(args, 'providerId', 'provider_id'),
        serverId: arg(args, 'serverId', 'server_id'),
        apps: arg(args, 'apps') ?? [],
        optionId: arg(args, 'optionId', 'option_id') ?? null,
        protocol: arg(args, 'protocol') ?? null,
        parameterValues: arg(args, 'parameterValues', 'parameter_values') ?? {},
      }),
    mcp_upsert_local_server: (args) =>
      mcp.upsertLocalServer({
        serverId: arg(args, 'serverId', 'server_id'),
        spec: arg(args, 'spec'),
        apps: arg(args, 'apps') ?? [],
      }),
    mcp_set_server_apps: (args) =>
      mcp.setServerApps({ serverId: arg(args, 'serverId', 'server_id'), apps: arg(args, 'apps') ?? [] }),
    mcp_remove_server: (args) =>
      mcp.removeServer({ serverId: arg(args, 'serverId', 'server_id'), apps: arg(args, 'apps') ?? null }),

    // ----------------------------------------------------------------- skills
    skills_list_agents: () => skills.listAgents(),
    skills_list: (args) =>
      skills.listSkills({
        agentType: arg(args, 'agentType', 'agent_type'),
        scope: arg(args, 'scope'),
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
    skills_list_packages: (args) =>
      skills.listPackages({
        agentType: arg(args, 'agentType', 'agent_type') ?? null,
        scope: arg(args, 'scope') ?? null,
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
    skills_read_package: (args) =>
      skills.readPackage({
        packageId: arg(args, 'packageId', 'package_id'),
        agentType: arg(args, 'agentType', 'agent_type') ?? null,
        scope: arg(args, 'scope') ?? null,
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
    skills_install_package: (args) =>
      skills.installPackage({
        packageId: arg(args, 'packageId', 'package_id'),
        agentType: arg(args, 'agentType', 'agent_type') ?? null,
        scope: arg(args, 'scope') ?? null,
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
        skillIds: arg(args, 'skillIds', 'skill_ids') ?? null,
      }),
    skills_uninstall_package: (args) =>
      skills.uninstallPackage({
        packageId: arg(args, 'packageId', 'package_id'),
        agentType: arg(args, 'agentType', 'agent_type') ?? null,
        scope: arg(args, 'scope') ?? null,
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
        skillIds: arg(args, 'skillIds', 'skill_ids') ?? null,
      }),
    skills_read: (args) =>
      skills.readSkill({
        agentType: arg(args, 'agentType', 'agent_type'),
        scope: arg(args, 'scope'),
        skillId: arg(args, 'skillId', 'skill_id'),
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
    skills_save: (args) =>
      skills.saveSkill({
        agentType: arg(args, 'agentType', 'agent_type'),
        scope: arg(args, 'scope'),
        skillId: arg(args, 'skillId', 'skill_id'),
        content: arg(args, 'content'),
        layout: arg(args, 'layout') ?? null,
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
    skills_delete: (args) =>
      skills.deleteSkill({
        agentType: arg(args, 'agentType', 'agent_type'),
        scope: arg(args, 'scope'),
        skillId: arg(args, 'skillId', 'skill_id'),
        workspacePath: arg(args, 'workspacePath', 'workspace_path') ?? null,
      }),
  }
}

/**
 * `list_batch_groups`.
 *
 * The reference joins batches to the two LEGACY tables (`providers`, `official_accounts`),
 * which nothing writes any more, so its Batches screen is effectively always empty. Here the
 * children are the route credentials that carry the batch id — which is what a user who
 * grouped their accounts during an import actually expects to see.
 */
async function listBatchGroups(context, search) {
  const document = await context.stores.batches.read()
  const rows = await context.stores.accounts.read()
  const needle = String(search ?? '').trim().toLowerCase()
  const groups = []
  for (const batch of document.batches ?? []) {
    if (needle.length > 0 && !batch.name.toLowerCase().includes(needle)) {
      continue
    }
    const children = (rows.credentials ?? [])
      .filter((row) => row.batch_id === batch.id && row.archived_at === null)
      .map((row) => ({
        item_type: row.kind === 'official' ? 'official_account' : 'provider',
        id: row.id,
        title: row.display_name,
        subtitle: row.email ?? null,
        platform: row.platform,
        status: row.status,
      }))
    const health = children.some((child) => child.status === 'error' || child.status === 'revoked')
      ? 'error'
      : children.some((child) => child.status === 'warning' || child.status === 'paused')
        ? 'warning'
        : 'ok'
    groups.push({ batch, health, children })
  }
  return groups
}

async function createBatch(context, input) {
  const name = requireText(input?.name, 'name', 200)
  const batch = {
    id: uuid(),
    name,
    source: String(input?.source ?? 'manual').trim() || 'manual',
    notes: typeof input?.notes === 'string' && input.notes.trim().length > 0 ? input.notes.trim() : null,
    sort_order: (await context.stores.batches.read()).batches?.length ?? 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  await context.stores.batches.update((document) => {
    document.batches = [...(document.batches ?? []), batch]
  })
  return batch
}

/**
 * Mount every route.
 *
 * @param ctx - the cordis context (needs `webServer`).
 * @returns a disposer.
 */
export function registerAiSwitchRoutes(ctx, options = {}) {
  const hub = new EventHub()
  const context = createContext({ ...options, webServer: ctx.webServer, emit: hub.emit })
  const commands = buildCommands(context)

  // The ledger is read once so the usage screen and the per-account statistics have history
  // from the first request rather than after the first write.
  void context.ledger.load()

  // The proxy is started eagerly: a CLI whose config points here should work after a dsh
  // restart without anyone opening the panel first. A bind failure is logged, not thrown —
  // the panel still has to load so the user can see why.
  void context.proxy.start().catch((error) => {
    console.warn(`[${PLUGIN_ID}] the route proxy could not start: ${String(error?.message ?? error)}`)
  })

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(ROUTE_PREFIX.length)

      if (req.method === 'GET') {
        if (route === '' || route === '/') {
          res.writeHead(302, { location: `${ROUTE_PREFIX}/app/` })
          res.end()
          return
        }
        if (route === '/health') {
          okJson(res, {
            ok: true,
            language: panelLanguage(),
            proxy: context.proxy.status(),
            pty: await ptyAvailable(),
          })
          return
        }
        // Normally claimed by the exact route below; answering it here too means a change in
        // dsh's route-matching order cannot silently kill the event stream.
        if (route === '/events') {
          hub.addStream(req, res)
          return
        }
        if (route === '/app' || route.startsWith('/app/')) {
          const relative = route.slice('/app'.length) || '/'
          // Any unknown path inside the app falls back to index.html, so a reload of a deep
          // link still boots the panel.
          await serveStatic(res, WEBVIEW_DIR, relative === '/' ? 'index.html' : relative, {
            fallback: 'index.html',
          })
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }
      if (!route.startsWith('/api/')) {
        res.writeHead(404)
        res.end()
        return
      }
      const name = decodeURIComponent(route.slice('/api/'.length))
      const command = commands[name]
      if (command === undefined) {
        throw new ApiError('web.command_unknown', 'Web command is not recognized', {
          details: name,
          recoverable: false,
          status: 404,
        })
      }
      const args = await readJsonBody(req)
      okJson(res, await command(args))
    } catch (error) {
      fail(res, error)
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: (req, res) => hub.addStream(req, res) }),
  ]
  const socketDispose = registerSockets(ctx, { hub })
  if (socketDispose === undefined) {
    console.warn(
      `[${PLUGIN_ID}] this dsh build has no upgrade hook, so panel events use SSE and hold`
      + ' one of the browser\'s six per-origin connections while the panel is open',
    )
  }

  return async () => {
    socketDispose?.()
    for (const dispose of disposers) {
      dispose()
    }
    hub.close()
    context.terminals.disposeAll()
    await context.proxy.stop().catch(() => {})
    await context.ledger.dispose().catch(() => {})
  }
}

export { WEBVIEW_DIR }
