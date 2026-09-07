/**
 * Host-half tests: the command table, the account domain, and the pool.
 *
 * Every test gets its own temp DSH home and its own temp USER home, so nothing here can see
 * or touch the real `~/.codex` — which matters more than usual for this plugin, since its
 * whole job is writing files in a user's home directory.
 *
 * @module dsh-plugin-ai-switch/test/host
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { buildCommands, createContext } from '../src/host/routes.js'

let homes = []

async function freshCommands() {
  const home = await mkdtemp(join(tmpdir(), 'ais-home-'))
  const userHomeDir = await mkdtemp(join(tmpdir(), 'ais-user-'))
  homes.push(home, userHomeDir)
  const context = createContext({ home, userHomeDir })
  return { context, commands: buildCommands(context), home, userHomeDir }
}

after(async () => {
  for (const dir of homes) {
    await rm(dir, { recursive: true, force: true })
  }
  homes = []
})

/** The api-account shape every test starts from. */
const apiInput = (overrides = {}) => ({
  platform: 'codex',
  display_name: 'relay',
  api_key: 'sk-upstream-secret',
  base_url: 'https://relay.example.com/v1',
  interface_format: 'openai',
  model_mappings_json: JSON.stringify([{ from: 'gpt-5.6-sol', to: 'glm-5.3' }]),
  ...overrides,
})

describe('the command table', () => {
  it('answers every command the panel calls, and nothing it does not', async () => {
    const { commands } = await freshCommands()
    // The panel's own command list, minus the desktop-only surface this plugin documents as
    // absent (Tailscale, mobile pairing, local HTTPS, the web-service settings, the signed
    // updater and the two save-file dialogs).
    const required = [
      'health',
      'get_settings',
      'save_settings',
      'list_platform_capabilities',
      'list_target_apps',
      'list_target_config_statuses',
      'list_config_write_clients',
      'list_config_snapshots',
      'rollback_config_snapshot',
      'write_route_proxy_configs',
      'route_config_write_is_stale',
      'get_route_proxy_status',
      'start_route_proxy',
      'stop_route_proxy',
      'get_route_proxy_key',
      'subscribe_route_proxy_live_log',
      'unsubscribe_route_proxy_live_log',
      'list_route_credentials',
      'list_route_credentials_page',
      'get_route_credential',
      'create_api_route_credential',
      'update_route_credential',
      'copy_route_credential',
      'delete_route_credential',
      'archive_route_credentials',
      'restore_route_credentials',
      'set_route_credential_statuses',
      'reorder_route_credentials',
      'set_route_credential_cooldown',
      'clear_route_credential_failure_state',
      'set_route_credential_model_status',
      'clear_route_credential_model_state',
      'set_route_credential_recovery',
      'get_route_pool',
      'set_route_pool_members',
      'set_route_pool_model_mode',
      'route_pool_route_once',
      'list_sessions',
      'get_session_messages',
      'get_session_usage_stats',
      'get_usage_overview',
      'get_model_price_configs',
      'save_model_price_configs',
      'list_agent_launch_options',
      'list_terminal_sessions',
      'create_terminal_session',
      'write_terminal_input',
      'resize_terminal',
      'kill_terminal_session',
      'list_batch_groups',
      'create_batch',
      'mcp_scan_local',
      'mcp_list_marketplaces',
      'mcp_search_marketplace',
      'mcp_get_marketplace_server_detail',
      'mcp_install_from_marketplace',
      'mcp_upsert_local_server',
      'mcp_set_server_apps',
      'mcp_remove_server',
      'skills_list_agents',
      'skills_list',
      'skills_list_packages',
      'skills_read_package',
      'skills_install_package',
      'skills_uninstall_package',
      'skills_read',
      'skills_save',
      'skills_delete',
    ]
    for (const name of required) {
      assert.equal(typeof commands[name], 'function', `${name} must be answerable`)
    }
  })

  it('reports the seven platforms and the seventeen client targets', async () => {
    const { commands } = await freshCommands()
    const capabilities = await commands.list_platform_capabilities({})
    assert.deepEqual(
      capabilities.map((row) => row.platform),
      ['codex', 'claude', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes'],
    )
    // The three harnesses are `partial`, and that means exactly one thing: no vendor login.
    const partial = capabilities.filter((row) => row.support_level === 'partial').map((row) => row.platform)
    assert.deepEqual(partial, ['opencode', 'openclaw', 'hermes'])
    for (const row of capabilities) {
      assert.equal(row.operations.config_write.availability, 'supported', `${row.platform} writes configs`)
    }
    assert.equal((await commands.list_target_apps({})).length, 17)
  })

  it('says gemini has no official quota rather than pretending it does', async () => {
    const { commands } = await freshCommands()
    const gemini = (await commands.list_platform_capabilities({})).find((row) => row.platform === 'gemini')
    assert.equal(gemini.operations.official_quota.availability, 'unavailable')
    assert.equal(gemini.operations.official_quota.reason_code, 'capability.quota_unavailable')
    assert.equal(gemini.operations.official_import.availability, 'supported')
  })

  it('rejects an unknown command name with the code the panel knows', async () => {
    const { commands } = await freshCommands()
    assert.equal(commands.definitely_not_a_command, undefined)
  })
})

describe('accounts', () => {
  it('creates an api account with the reference defaults', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    assert.equal(row.kind, 'api')
    assert.equal(row.platform, 'codex')
    assert.equal(row.status, 'ok')
    assert.equal(row.route_priority, 3)
    // The COLUMN default in the reference's schema is 1, but every insert path binds 5.
    assert.equal(row.max_concurrency, 5)
    assert.equal(row.email, null)
    assert.equal(row.sort_order, 0)
    assert.equal(row.transient_failure_count, 0)
    assert.deepEqual(row.model_states, [])
  })

  it('carries the three json blobs as strings, not objects', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    for (const field of ['secret_payload_json', 'config_json', 'preview_json']) {
      assert.equal(typeof row[field], 'string', `${field} crosses the wire as a string`)
    }
    assert.equal(JSON.parse(row.secret_payload_json).api_key, 'sk-upstream-secret')
    assert.equal(JSON.parse(row.config_json).base_url, 'https://relay.example.com/v1')
  })

  it('refuses the model-mapping placeholder and a blank required field', async () => {
    const { commands } = await freshCommands()
    await assert.rejects(
      () =>
        commands.create_api_route_credential({
          input: apiInput({ model_mappings_json: JSON.stringify([{ from: 'x', to: 'upstream-model' }]) }),
        }),
      (error) => error.code === 'validation.model_mapping',
    )
    await assert.rejects(
      () => commands.create_api_route_credential({ input: apiInput({ display_name: '   ' }) }),
      (error) => error.code === 'validation.required' && error.details === 'display_name',
    )
    await assert.rejects(
      () => commands.create_api_route_credential({ input: apiInput({ interface_format: 'openai_responses' }) }),
      (error) => error.code === 'validation.interface_format',
    )
    await assert.rejects(
      () => commands.create_api_route_credential({ input: apiInput({ platform: 'nope' }) }),
      (error) => error.code === 'platform.unknown',
    )
  })

  it('only lets an anthropic upstream choose its key header', async () => {
    const { commands } = await freshCommands()
    await assert.rejects(
      () => commands.create_api_route_credential({ input: apiInput({ api_key_field: 'ANTHROPIC_API_KEY' }) }),
      (error) => error.code === 'validation.api_key_field',
    )
    const row = await commands.create_api_route_credential({
      input: apiInput({ platform: 'claude', interface_format: 'anthropic', api_key_field: 'ANTHROPIC_AUTH_TOKEN' }),
    })
    assert.equal(JSON.parse(row.config_json).api_key_field, 'ANTHROPIC_AUTH_TOKEN')
  })

  it('keeps the stored secret when the browser posts back a masked payload', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    const updated = await commands.update_route_credential({
      id: row.id,
      input: {
        display_name: 'renamed',
        email: null,
        status: 'ok',
        route_priority: 2,
        max_concurrency: 3,
        // Exactly what the edit drawer round-trips: the marker plus an empty key.
        secret_payload_json: JSON.stringify({ __masked: true, api_key: '' }),
        config_json: row.config_json,
        preview_json: row.preview_json,
      },
    })
    assert.equal(updated.display_name, 'renamed')
    assert.equal(JSON.parse(updated.secret_payload_json).api_key, 'sk-upstream-secret')
  })

  it('reports a revoked account as missing rather than as a distinct refusal', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await commands.set_route_credential_statuses({ ids: [row.id], status: 'revoked' })
    await assert.rejects(
      () =>
        commands.update_route_credential({
          id: row.id,
          input: {
            display_name: 'x',
            email: null,
            status: 'ok',
            route_priority: 3,
            max_concurrency: 5,
            secret_payload_json: '{}',
            config_json: '{}',
            preview_json: '{}',
          },
        }),
      (error) => error.code === 'validation.route_credential_not_found',
    )
  })

  it('archives out of every list and out of the pool, and restores', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [row.id] } })
    await commands.archive_route_credentials({ ids: [row.id] })
    assert.equal((await commands.list_route_credentials({ platform: 'codex' })).length, 0)
    assert.equal((await commands.get_route_pool({ platform: 'codex' })).account_ids.length, 0)
    const archived = await commands.list_route_credentials_page({
      input: { platform: 'codex', page: 1, page_size: 20, pool_scope: 'archived' },
    })
    assert.equal(archived.total, 1)
    await commands.restore_route_credentials({ ids: [row.id] })
    assert.equal((await commands.list_route_credentials({ platform: 'codex' })).length, 1)
  })

  it('inherits pool membership on a copy, and converts a cross-platform one', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [row.id] } })
    const copy = await commands.copy_route_credential({ id: row.id })
    assert.match(copy.display_name, /^relay \d{4}-\d{2}-\d{2}$/)
    assert.equal((await commands.get_route_pool({ platform: 'codex' })).account_ids.length, 2)

    // A cross-platform copy keeps the endpoint but rewrites it for the target dialect and
    // drops the mappings, which are meaningless on the other platform.
    const claude = await commands.copy_route_credential({ id: row.id, input: { target_platform: 'claude' } })
    const config = JSON.parse(claude.config_json)
    assert.equal(config.interface_format, 'anthropic')
    assert.equal(config.base_url, 'https://relay.example.com')
    assert.deepEqual(config.model_mappings, [])
  })

  it('rejects a page size the list screen never offers', async () => {
    const { commands } = await freshCommands()
    await assert.rejects(
      () => commands.list_route_credentials_page({ input: { platform: 'codex', page: 1, page_size: 25 } }),
      (error) => error.code === 'validation.route_credential_page_size',
    )
  })

  it('answers a reorder with the page the moved account landed on', async () => {
    const { commands } = await freshCommands()
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const created = await commands.create_api_route_credential({
        input: apiInput({ display_name: `relay ${index}` }),
      })
      ids.push(created.id)
    }
    const page = await commands.reorder_route_credentials({
      input: {
        platform: 'codex',
        moved_account_id: ids[2],
        previous_account_id: null,
        next_account_id: ids[0],
        filters: [],
        pool_scope: 'out_of_pool',
        page_size: 20,
      },
    })
    assert.equal(page.page, 1)
    assert.deepEqual(
      page.items.map((row) => row.id),
      [ids[2], ids[0], ids[1]],
    )
  })

  it('lifts a cooldown on zero but keeps the failure count', async () => {
    const { commands, context } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await context.accounts.recordFailure(row.id, { kind: 'upstream.http_429', message: 'slow down' })
    const cooling = await commands.set_route_credential_cooldown({ id: row.id, seconds: 60 })
    assert.notEqual(cooling.cooldown_until, null)
    assert.equal(cooling.transient_failure_count, 1)
    const lifted = await commands.set_route_credential_cooldown({ id: row.id, seconds: 0 })
    assert.equal(lifted.cooldown_until, null)
    assert.equal(lifted.transient_failure_count, 1)
    const cleared = await commands.clear_route_credential_failure_state({ id: row.id })
    assert.equal(cleared.transient_failure_count, 0)
    assert.equal(cleared.last_failure_kind, null)
    await assert.rejects(
      () => commands.set_route_credential_cooldown({ id: row.id, seconds: 90_000 }),
      (error) => error.code === 'validation.route_credential_cooldown_seconds',
    )
  })

  it('accepts ok and paused for a model, never error', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    const paused = await commands.set_route_credential_model_status({
      id: row.id,
      model_key: 'glm-5.3',
      status: 'paused',
    })
    const state = paused.model_states.find((item) => item.model_key === 'glm-5.3')
    assert.equal(state.status, 'paused')
    // `aliases` is the reverse map: which client-facing name points at this upstream model.
    assert.deepEqual(state.aliases, ['gpt-5.6-sol'])
    await assert.rejects(
      () => commands.set_route_credential_model_status({ id: row.id, model_key: 'glm-5.3', status: 'error' }),
      (error) => error.code === 'validation.route_credential_model_status',
    )
    const ok = await commands.set_route_credential_model_status({ id: row.id, model_key: 'glm-5.3', status: 'ok' })
    assert.equal(ok.model_states.find((item) => item.model_key === 'glm-5.3').status, 'ok')
  })

  it('normalizes a recovery rule and removes it from config_json when it is off', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    const scheduled = await commands.set_route_credential_recovery({
      id: row.id,
      rule: { mode: 'scheduled', times: ['9:05', '09:05', '23:30'] },
    })
    assert.deepEqual(JSON.parse(scheduled.config_json).recovery.times, ['09:05', '23:30'])
    const off = await commands.set_route_credential_recovery({ id: row.id, rule: { mode: 'off' } })
    assert.equal(JSON.parse(off.config_json).recovery, undefined)
    await assert.rejects(
      () => commands.set_route_credential_recovery({ id: row.id, rule: { mode: 'scheduled', times: ['9am'] } }),
      (error) => error.code === 'validation.recovery_times',
    )
  })
})

describe('the pool', () => {
  it('rotates through a band and skips a cooling account', async () => {
    const { commands, context } = await freshCommands()
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const created = await commands.create_api_route_credential({
        input: apiInput({ display_name: `relay ${index}` }),
      })
      ids.push(created.id)
    }
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: ids } })

    // Round robin, in the order the user dragged them into.
    const picks = []
    for (let index = 0; index < 4; index += 1) {
      picks.push((await context.accounts.selectAccount('codex')).id)
    }
    assert.deepEqual(picks, [ids[0], ids[1], ids[2], ids[0]])

    // A cooling account is skipped entirely rather than retried.
    await commands.set_route_credential_cooldown({ id: ids[1], seconds: 600 })
    const after = []
    for (let index = 0; index < 4; index += 1) {
      after.push((await context.accounts.selectAccount('codex')).id)
    }
    assert.equal(after.includes(ids[1]), false)
  })

  it('prefers the best priority band present and ignores the rest', async () => {
    const { commands, context } = await freshCommands()
    const low = await commands.create_api_route_credential({ input: apiInput({ display_name: 'backup' }) })
    const high = await commands.create_api_route_credential({ input: apiInput({ display_name: 'primary' }) })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [low.id, high.id] } })
    await commands.update_route_credential({
      id: high.id,
      input: {
        display_name: 'primary',
        email: null,
        status: 'ok',
        route_priority: 1,
        max_concurrency: 5,
        secret_payload_json: JSON.stringify({ __masked: true }),
        config_json: high.config_json,
        preview_json: high.preview_json,
      },
    })
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await context.accounts.selectAccount('codex')).id, high.id)
    }
  })

  it('distinguishes an empty pool from an exhausted one', async () => {
    const { commands, context } = await freshCommands()
    await assert.rejects(
      () => context.accounts.selectAccount('codex'),
      (error) => error.code === 'validation.route_pool_empty',
    )
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [row.id] } })
    // Fill every slot the account allows; the answer must be "come back", not "nothing here".
    for (let index = 0; index < row.max_concurrency; index += 1) {
      context.activity.begin(row.id, { platform: 'codex', maxConcurrency: row.max_concurrency })
    }
    await assert.rejects(
      () => context.accounts.selectAccount('codex'),
      (error) => error.code === 'route_pool.concurrency_exhausted',
    )
  })

  it('skips an account whose row for THIS model is paused', async () => {
    const { commands, context } = await freshCommands()
    const paused = await commands.create_api_route_credential({ input: apiInput({ display_name: 'paused' }) })
    const healthy = await commands.create_api_route_credential({ input: apiInput({ display_name: 'healthy' }) })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [paused.id, healthy.id] } })
    await commands.set_route_credential_model_status({ id: paused.id, model_key: 'glm-5.3', status: 'paused' })
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await context.accounts.selectAccount('codex', { modelKey: 'glm-5.3' })).id, healthy.id)
    }
    // The same account is still fine for a model it did not pause.
    const other = await context.accounts.selectAccount('codex', { modelKey: 'something-else' })
    assert.ok([paused.id, healthy.id].includes(other.id))
  })

  it('refuses a member from another platform', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput() })
    await assert.rejects(
      () => commands.set_route_pool_members({ input: { platform: 'claude', account_ids: [row.id] } }),
      (error) => error.code === 'validation.route_pool_platform_mismatch',
    )
  })

  it('advertises the pool catalog in both modes', async () => {
    const { commands } = await freshCommands()
    const row = await commands.create_api_route_credential({ input: apiInput({ display_name: 'A' }) })
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [row.id] } })
    const precise = await commands.set_route_pool_model_mode({ input: { platform: 'codex', mode: 'precise' } })
    assert.equal(precise.model_mode, 'precise')
    const back = await commands.set_route_pool_model_mode({ input: { platform: 'codex', mode: 'aggregate' } })
    assert.equal(back.model_mode, 'aggregate')
  })
})
