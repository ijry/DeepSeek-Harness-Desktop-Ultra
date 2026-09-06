/**
 * Config-write tests: the part of this plugin that edits files it did not create.
 *
 * Every test gets a temp USER home, so `~/.codex` here is never the real one. What is being
 * checked is mostly the promise the reference makes and this port has to keep: a write adds
 * a provider entry and changes NOTHING else, a rollback restores byte for byte, and anything
 * unexpected about the file on disk stops the write instead of overwriting it.
 *
 * @module dsh-plugin-ai-switch/test/configwrite
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { ADAPTERS, adapterByTargetKey } from '../src/host/configwrite/adapters.js'
import { buildCommands, createContext } from '../src/host/routes.js'

const NL = '\n'
let homes = []

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ais-home-'))
  const userHomeDir = await mkdtemp(join(tmpdir(), 'ais-user-'))
  homes.push(home, userHomeDir)
  const context = createContext({ home, userHomeDir })
  const commands = buildCommands(context)
  const account = await commands.create_api_route_credential({
    input: {
      platform: 'codex',
      display_name: 'relay',
      api_key: 'sk-upstream',
      base_url: 'https://relay.example.com/v1',
      interface_format: 'openai',
      model_mappings_json: JSON.stringify([{ from: 'gpt-5.6-sol', to: 'glm-5.3' }]),
    },
  })
  await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [account.id] } })
  return { context, commands, home, userHomeDir, account }
}

after(async () => {
  for (const dir of homes) {
    await rm(dir, { recursive: true, force: true })
  }
  homes = []
})

/** The render input the adapters take, without going through a real write. */
const renderInput = {
  baseUrl: 'http://127.0.0.1:19527',
  proxyKey: 'sk-ai-switch-0123456789abcdef0123456789abcdef',
  keyAliases: [],
  claudeEnv: { subagentModel: '', fallbackModel: 'claude-model', slots: [], clientConfig: {} },
  clientModels: [{ id: 'glm-5.3', context_window: 200_000, max_output_tokens: 128_000 }],
}

describe('the adapters', () => {
  it('covers all seventeen client targets, each rendering a file it then recognizes', () => {
    assert.equal(ADAPTERS.length, 17)
    for (const adapter of ADAPTERS) {
      const path = adapter.resolvePath('/home/tester', {})
      const rendered = adapter.render(path, null, renderInput)
      assert.equal(typeof rendered, 'string', `${adapter.targetKey} renders text`)
      const status = adapter.inspect(path, rendered)
      assert.equal(status.file_status, 'managed', `${adapter.targetKey} recognizes its own output`)
      // A file we have never touched must never read as managed.
      assert.equal(adapter.inspect(path, null).file_status, 'missing')
    }
  })

  it('writes the exact codex keys and preserves every other line', () => {
    const adapter = adapterByTargetKey('codex')
    const before = [
      '# a comment I wrote by hand',
      'approval_policy = "on-request"',
      '',
      '[model_providers.mine]',
      'name = "Mine"',
      'base_url = "https://mine.example/v1"',
      '',
      '[mcp_servers.fs]',
      'command = "npx"',
      '',
    ].join(NL)
    const after = adapter.render('/tmp/config.toml', before, renderInput)
    assert.match(after, /^# a comment I wrote by hand$/m)
    assert.match(after, /^approval_policy = "on-request"$/m)
    assert.match(after, /^\[mcp_servers\.fs\]$/m)
    assert.match(after, /^\[model_providers\.mine\]$/m)
    assert.match(after, /^model_provider = "ai-switch"$/m)
    assert.match(after, /^model_catalog_json = "ai-switch-model-catalog\.json"$/m)
    assert.match(after, /^\[model_providers\.ai-switch\]$/m)
    assert.match(after, /^wire_api = "responses"$/m)
    assert.match(after, /^experimental_bearer_token = "sk-ai-switch-[0-9a-f]{32}"$/m)
    // Legacy field: a stale value here outranks the bearer token, so it is always removed.
    assert.equal(/^api_key = /m.test(after), false)
    // Writing twice must not accumulate anything.
    assert.equal(adapter.render('/tmp/config.toml', after, renderInput), after)
  })

  it('writes claude code env vars and leaves unrelated root keys alone', () => {
    const adapter = adapterByTargetKey('claude_code')
    const before = JSON.stringify({ permissions: { allow: ['Bash'] }, env: { MY_OWN: '1' } }, null, 2)
    const after = JSON.parse(
      adapter.render('/tmp/settings.json', before, {
        ...renderInput,
        claudeEnv: {
          subagentModel: '',
          fallbackModel: 'claude-model[1M]',
          slots: [{ model: 'claude-sonnet-alias[1M]', displayName: '' }],
          clientConfig: {},
        },
      }),
    )
    assert.deepEqual(after.permissions, { allow: ['Bash'] })
    assert.equal(after.env.MY_OWN, '1')
    assert.equal(after.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:19527')
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, renderInput.proxyKey)
    assert.equal(after.env.ANTHROPIC_MODEL, 'claude-model[1M]')
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-alias[1M]')
    // An empty slot name DELETES the key rather than writing a blank string.
    assert.equal('ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' in after.env, false)
    assert.equal(after.aiSwitch.routeProxy.enabled, true)
    assert.equal(after.aiSwitch.routeProxy.platform, 'claude')
  })

  it('tracks the claude client config keys it manages, and drops the ones it stops managing', () => {
    const adapter = adapterByTargetKey('claude_code')
    const withConfig = adapter.render('/tmp/settings.json', '{}', {
      ...renderInput,
      claudeEnv: { subagentModel: '', fallbackModel: '', slots: [], clientConfig: { includeCoAuthoredBy: false } },
    })
    const first = JSON.parse(withConfig)
    assert.equal(first.includeCoAuthoredBy, false)
    assert.deepEqual(first.aiSwitch.managedClientKeys, ['includeCoAuthoredBy'])

    const removed = JSON.parse(
      adapter.render('/tmp/settings.json', withConfig, {
        ...renderInput,
        claudeEnv: { subagentModel: '', fallbackModel: '', slots: [], clientConfig: {} },
      }),
    )
    assert.equal('includeCoAuthoredBy' in removed, false)
    assert.equal('managedClientKeys' in removed.aiSwitch, false)
  })

  it('writes no credential for gemini or grok', () => {
    for (const key of ['gemini_cli', 'grok']) {
      const rendered = JSON.parse(adapterByTargetKey(key).render('/tmp/settings.json', null, renderInput))
      const values = Object.values(rendered.env)
      assert.equal(
        values.includes(renderInput.proxyKey),
        false,
        `${key} must not put the proxy key in an env var whose name was never verified`,
      )
      // It is still in `aiSwitch.routeProxy`, which the panel reads back — that is deliberate.
      assert.equal(rendered.aiSwitch.routeProxy.apiKey, renderInput.proxyKey)
    }
  })

  it('respects an existing opencode schema pin and openclaw mode', () => {
    const opencode = JSON.parse(
      adapterByTargetKey('opencode').render(
        '/tmp/opencode.json',
        JSON.stringify({ $schema: 'https://example.invalid/pinned.json' }),
        renderInput,
      ),
    )
    assert.equal(opencode.$schema, 'https://example.invalid/pinned.json')
    assert.equal(opencode.provider['ai-switch'].npm, '@ai-sdk/openai-compatible')
    assert.equal(opencode.model, 'ai-switch/glm-5.3')

    const openclaw = JSON.parse(
      adapterByTargetKey('openclaw').render(
        '/tmp/openclaw.json',
        JSON.stringify({ models: { mode: 'replace', providers: {} } }),
        renderInput,
      ),
    )
    // A deliberate `replace` is never downgraded to `merge`.
    assert.equal(openclaw.models.mode, 'replace')
    assert.equal(openclaw.models.providers['ai-switch'].api, 'openai-completions')
    assert.equal(openclaw.agents.defaults.model.primary, 'ai-switch/glm-5.3')
  })

  it('refuses a JSON config it cannot parse instead of overwriting it', () => {
    for (const key of ['claude_code', 'opencode', 'openclaw', 'qoder_cli_codex', 'zcode_codex']) {
      const adapter = adapterByTargetKey(key)
      assert.throws(
        () => adapter.render('/tmp/x.json', '{ "this": is not json }', renderInput),
        (error) => error.code === 'validation.route_config_existing_invalid',
        `${key} must refuse an unparsable file`,
      )
      assert.equal(adapter.inspect('/tmp/x.json', '{ oops }').file_status, 'invalid')
    }
  })

  it('never touches an entry marked for the sibling platform', () => {
    const codex = adapterByTargetKey('workbuddy_codex')
    const claude = adapterByTargetKey('workbuddy_claude')
    const first = codex.render('/tmp/models.json', null, renderInput)
    const both = JSON.parse(claude.render('/tmp/models.json', first, renderInput))
    const platforms = both.models.map((record) => record.aiSwitch.platform).sort()
    assert.deepEqual(platforms, ['claude', 'codex'])
  })

  it('normalizes a bare array root and keeps sibling keys', () => {
    const adapter = adapterByTargetKey('codebuddy_cli_codex')
    const rendered = JSON.parse(
      adapter.render('/tmp/models.json', JSON.stringify([{ id: 'mine', url: 'https://mine/v1/chat/completions' }]), renderInput),
    )
    assert.ok(Array.isArray(rendered.models))
    assert.equal(rendered.models.some((record) => record.id === 'mine'), true)
    assert.equal(rendered.models.some((record) => record.id === 'glm-5.3'), true)
  })

  it('strips the provider-level keys qoder rejects', () => {
    const adapter = adapterByTargetKey('qoder_cli_codex')
    const before = JSON.stringify({
      providers: { 'ai-switch-codex': { contextWindow: 1, thinking: true, displayName: 'Mine' } },
    })
    const entry = JSON.parse(adapter.render('/tmp/settings.json', before, renderInput)).providers['ai-switch-codex']
    assert.equal('contextWindow' in entry, false)
    assert.equal('thinking' in entry, false)
    // An existing display name is the user's, so it survives.
    assert.equal(entry.displayName, 'Mine')
    assert.equal(entry.model, 'glm-5.3')
  })

  it('keeps hermes comments and every section it does not own', () => {
    const adapter = adapterByTargetKey('hermes')
    const before = ['# my hermes notes', 'theme: dark', 'model:', '  provider: someone-else', ''].join(NL)
    const after = adapter.render('/tmp/config.yaml', before, renderInput)
    assert.match(after, /^# my hermes notes$/m)
    assert.match(after, /^theme: dark$/m)
    // Block sequences sit indented under their key, which is what dsh's own settings.yaml
    // looks like on disk. serde_yaml (the reference's emitter) puts `- ` at the parent's
    // indent instead; both parse identically, and staleness compares our render against our
    // own output, so the difference is cosmetic.
    assert.match(after, /^ +- name: ai-switch$/m)
    assert.match(after, /^ +api_mode: chat_completions$/m)
    assert.match(after, /^ +context_length: 200000$/m)
    // `model.provider` is ours now, and the old value is gone rather than duplicated.
    assert.equal(/someone-else/.test(after), false)
  })

  it('points dsh at the pool without eating the rest of settings.yaml', () => {
    const adapter = adapterByTargetKey('deepseek_harness_codex')
    const before = [
      '# hand-written',
      'dsh-desktop:',
      '  mode: compatibility',
      'agent-default-model:',
      '  provider: something',
      '',
    ].join(NL)
    const after = adapter.render('/tmp/settings.yaml', before, renderInput)
    assert.match(after, /^# hand-written$/m)
    assert.match(after, /^  mode: compatibility$/m)
    assert.match(after, /^  provider: something$/m)
    assert.match(after, /^    ai-switch-codex:$/m)
    assert.match(after, /^        Authorization: Bearer sk-ai-switch-[0-9a-f]{32}$/m)
    assert.match(after, /^      api: openai-completions$/m)
    // No apiKeyEnv: a dangling credential reference fails the harness with MISSING_CREDENTIAL.
    assert.equal(/apiKeyEnv/.test(after), false)
    // No per-model maxTokens: the harness reads that as a cap on the response.
    assert.equal(/maxTokens/.test(after), false)
  })
})

describe('safe write', () => {
  // Passed explicitly everywhere so no test depends on a proxy actually listening.
  const baseUrl = 'http://127.0.0.1:19527'

  it('writes, snapshots, and rolls back byte for byte', async () => {
    const { commands, userHomeDir } = await fixture()
    const configPath = join(userHomeDir, '.codex', 'config.toml')
    const original = ['# my own notes', 'approval_policy = "on-request"', '', '[model_providers.mine]', 'name = "Mine"', ''].join(NL)
    await mkdir(join(userHomeDir, '.codex'), { recursive: true })
    await writeFile(configPath, original)

    const outcomes = await commands.write_route_proxy_configs({
      baseUrl: 'http://127.0.0.1:19527',
      platform: 'codex',
      clientKeys: ['codex'],
    })
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, 'succeeded')
    assert.equal(outcomes[0].target_key, 'codex')
    assert.equal(typeof outcomes[0].before_hash, 'string')
    assert.notEqual(outcomes[0].before_hash, outcomes[0].after_hash)

    const snapshots = await commands.list_config_snapshots({ limit: 10 })
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'succeeded')
    assert.equal(snapshots[0].operation, 'write')
    assert.equal(snapshots[0].original_file_existed, 1)
    // Neither of these belongs in front of the browser: one is a path to a file holding the
    // user's previous credentials, the other is internal bookkeeping.
    assert.equal('backup_path' in snapshots[0], false)
    assert.equal('metadata_json' in snapshots[0], false)

    const rolled = await commands.rollback_config_snapshot({ id: snapshots[0].id })
    assert.equal(rolled.status, 'succeeded')
    assert.equal(await readFile(configPath, 'utf8'), original)
  })

  it('deletes a file it created when that write is rolled back', async () => {
    const { commands, userHomeDir } = await fixture()
    const configPath = join(userHomeDir, '.codex', 'config.toml')
    await commands.write_route_proxy_configs({
      baseUrl: 'http://127.0.0.1:19527',
      platform: 'codex',
      clientKeys: ['codex'],
    })
    assert.equal((await readFile(configPath, 'utf8')).includes('ai-switch'), true)
    const snapshots = await commands.list_config_snapshots({ limit: 10 })
    assert.equal(snapshots[0].original_file_existed, 0)
    await commands.rollback_config_snapshot({ id: snapshots[0].id })
    await assert.rejects(() => readFile(configPath, 'utf8'), (error) => error.code === 'ENOENT')
  })

  it('refuses a rollback once the CLI has touched the file again', async () => {
    const { commands, userHomeDir } = await fixture()
    const configPath = join(userHomeDir, '.codex', 'config.toml')
    await commands.write_route_proxy_configs({ baseUrl, platform: 'codex', clientKeys: ['codex'] })
    const snapshots = await commands.list_config_snapshots({ limit: 10 })
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}${NL}# someone edited this${NL}`)
    await assert.rejects(
      () => commands.rollback_config_snapshot({ id: snapshots[0].id }),
      (error) => error.code === 'config.rollback_conflict',
    )
    // And the edit is still there: refusing means refusing, not "restore anyway".
    assert.match(await readFile(configPath, 'utf8'), /# someone edited this/)
  })

  it('reports a per-client failure without losing the clients that worked', async () => {
    const { commands, userHomeDir } = await fixture()
    // A ZCode config that cannot be parsed must not cost the user their Codex write.
    await mkdir(join(userHomeDir, '.zcode', 'v2'), { recursive: true })
    await writeFile(join(userHomeDir, '.zcode', 'v2', 'config.json'), '{ not json at all }')
    const outcomes = await commands.write_route_proxy_configs({
      baseUrl: 'http://127.0.0.1:19527',
      platform: 'codex',
      clientKeys: ['codex', 'zcode_codex'],
    })
    const byTarget = Object.fromEntries(outcomes.map((row) => [row.target_key, row]))
    assert.equal(byTarget.codex.status, 'succeeded')
    assert.equal(byTarget.zcode_codex.status, 'failed')
    assert.equal(byTarget.zcode_codex.error_code, 'validation.route_config_existing_invalid')
    assert.match(await readFile(join(userHomeDir, '.codex', 'config.toml'), 'utf8'), /model_provider = "ai-switch"/)
  })

  it('throws only when nothing at all could be written', async () => {
    const { commands, userHomeDir } = await fixture()
    await mkdir(join(userHomeDir, '.zcode', 'v2'), { recursive: true })
    await writeFile(join(userHomeDir, '.zcode', 'v2', 'config.json'), '{ not json }')
    await assert.rejects(
      () => commands.write_route_proxy_configs({ baseUrl: 'http://127.0.0.1:19527', platform: 'codex', clientKeys: ['zcode_codex'] }),
      (error) => error.code === 'validation.route_config_existing_invalid',
    )
  })

  it('refuses to follow a symlink out of the config path', async () => {
    const { commands, userHomeDir } = await fixture()
    const { symlink } = await import('node:fs/promises')
    const elsewhere = join(userHomeDir, 'elsewhere.toml')
    await writeFile(elsewhere, '# not ours')
    await mkdir(join(userHomeDir, '.codex'), { recursive: true })
    try {
      await symlink(elsewhere, join(userHomeDir, '.codex', 'config.toml'))
    } catch {
      // Windows without developer mode refuses to create the link; nothing to test then.
      return
    }
    const outcomes = await commands.write_route_proxy_configs({ baseUrl, platform: 'codex', clientKeys: ['codex'] }).catch(
      (error) => [{ status: 'failed', error_code: error.code }],
    )
    assert.equal(outcomes[0].status, 'failed')
    assert.equal(outcomes[0].error_code, 'config.path_unsafe')
    assert.equal(await readFile(elsewhere, 'utf8'), '# not ours')
  })

  it('needs a running proxy or an explicit base url', async () => {
    const { commands } = await fixture()
    await assert.rejects(
      () => commands.write_route_proxy_configs({ platform: 'codex', clientKeys: ['codex'], baseUrl: '' }),
      (error) => error.code === 'validation.route_proxy_not_running',
    )
  })

  it('refuses a client that does not belong to the platform', async () => {
    const { commands } = await fixture()
    await assert.rejects(
      () =>
        commands.write_route_proxy_configs({
          baseUrl: 'http://127.0.0.1:19527',
          platform: 'codex',
          clientKeys: ['claude_code'],
        }),
      (error) => error.code === 'config.client_unavailable',
    )
  })

  it('will not write a models-hungry client for an empty pool', async () => {
    const { commands } = await fixture()
    await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [] } })
    await assert.rejects(
      () =>
        commands.write_route_proxy_configs({
          baseUrl: 'http://127.0.0.1:19527',
          platform: 'codex',
          clientKeys: ['zcode_codex'],
        }),
      (error) => error.code === 'config.pool_models_empty',
    )
  })

  it('goes stale when the pool changes, and not before', async () => {
    const { commands } = await fixture()
    const baseUrl = 'http://127.0.0.1:19527'
    await commands.write_route_proxy_configs({ baseUrl, platform: 'codex', clientKeys: ['codex'] })
    assert.equal(await commands.route_config_write_is_stale({ baseUrl, platform: 'codex', clientKeys: ['codex'] }), false)
    // A different address is exactly what the nudge exists for.
    assert.equal(
      await commands.route_config_write_is_stale({
        baseUrl: 'http://127.0.0.1:29999',
        platform: 'codex',
        clientKeys: ['codex'],
      }),
      true,
    )
  })

  it('reports a file status per client target', async () => {
    const { commands } = await fixture()
    await commands.write_route_proxy_configs({
      baseUrl: 'http://127.0.0.1:19527',
      platform: 'codex',
      clientKeys: ['codex'],
    })
    const statuses = await commands.list_target_config_statuses({})
    assert.equal(statuses.length, 17)
    const codex = statuses.find((row) => row.target.key === 'codex')
    assert.equal(codex.file_status, 'managed')
    assert.equal(codex.adapter_available, true)
    assert.equal(codex.last_write_status, 'succeeded')
    assert.equal(codex.snapshot_count, 1)
    const untouched = statuses.find((row) => row.target.key === 'openclaw')
    assert.equal(untouched.file_status, 'missing')
  })
})
