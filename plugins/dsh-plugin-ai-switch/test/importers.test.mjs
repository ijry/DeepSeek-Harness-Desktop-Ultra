import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  credentialFingerprint,
  importOfficialFromText,
  importTransferCredentials,
  parseDeeplink,
  previewTransferImport,
} from '../src/host/importers.js'
import { pickJsonPath, refreshQuota, refreshRelayBalance } from '../src/host/quota.js'

const homes = []

after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
})

function memoryStore(value) {
  return {
    value: structuredClone(value),
    async read() {
      return this.value
    },
    async update(mutate) {
      return mutate(this.value)
    },
  }
}

function deps() {
  const stores = {
    accounts: memoryStore({ credentials: [], models: [] }),
    pool: memoryStore({ members: [], cursors: {}, modes: {} }),
    batches: memoryStore({ batches: [], jobs: [] }),
    settings: memoryStore({ installation_id: 'local-instance' }),
  }
  return { stores, accounts: accountFacade(stores) }
}

function accountFacade(stores) {
  return {
    async requireRow(id) {
      const row = stores.accounts.value.credentials.find((item) => item.id === id)
      if (!row) throw new Error('not found')
      return row
    },
    async get(id) {
      return this.requireRow(id)
    },
    async update(id, input) {
      const row = await this.requireRow(id)
      Object.assign(row, {
        display_name: input.display_name,
        email: input.email,
        status: input.status,
        route_priority: input.route_priority,
        max_concurrency: input.max_concurrency,
        secret_payload_json: input.secret_payload_json,
        config_json: input.config_json,
        preview_json: input.preview_json,
      })
      return row
    },
    async addPoolMember(platform, id) {
      stores.pool.value.members.push({ platform, route_credential_id: id, enabled: 1 })
    },
  }
}

function official(platform, name, token, source = null) {
  const item = {
    type: platform,
    email: `${name.toLowerCase()}@example.com`,
    access_token: token,
    refresh_token: `refresh-${token}`,
  }
  if (source) {
    item['x-ai-switch'] = {
      format: 'ai-switch.route-credential',
      schema_version: 1,
      platform,
      kind: 'official',
      display_name: name,
      source_instance_id: source.instance,
      source_credential_id: source.id,
    }
  }
  return item
}

function fingerprintPayloadForTest(item) {
  const payload = structuredClone(item)
  for (const key of ['display_name', 'batch_name', 'source_batch_id', 'in_pool', 'origin_format']) {
    delete payload['x-ai-switch']?.[key]
  }
  return payload
}

function api(name, key) {
  return {
    'api-key': key,
    'base-url': 'https://relay.example/v1',
    'x-ai-switch': {
      format: 'ai-switch.route-credential',
      schema_version: 1,
      platform: 'codex',
      kind: 'api',
      cpa_section: 'codex-api-key',
      interface_format: 'openai-responses',
      display_name: name,
    },
  }
}

test('CPA text imports an official token blob through build defaults', async () => {
  const state = deps()
  const secret = 'plain-official-access'
  const result = await importOfficialFromText({
    platform: 'claude',
    text: JSON.stringify({ type: 'claude', email: 'a@example.com', access_token: secret, refresh_token: 'refresh-a' }),
    batchName: 'OAuth accounts',
  }, state)

  assert.equal(result.imported.length, 1)
  const stored = state.stores.accounts.value.credentials[0]
  assert.equal(stored.kind, 'official')
  assert.equal(JSON.parse(stored.secret_payload_json).access_token, secret)
  assert.equal(stored.route_priority, 3)
  assert.equal(stored.max_concurrency, 5)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('CPA text imports an api-key entry and never returns its plaintext key', async () => {
  const state = deps()
  const secret = 'plain-api-key-material'
  const result = await importOfficialFromText({
    platform: 'codex',
    text: JSON.stringify({
      name: 'Relay',
      'base-url': 'https://relay.example',
      'api-key-entries': [{ 'api-key': secret }],
    }),
    batchName: 'API accounts',
  }, state)

  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].display_name, 'Relay')
  assert.equal(JSON.parse(state.stores.accounts.value.credentials[0].secret_payload_json).api_key, secret)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('transfer fingerprint is key-order stable and preview reports all five dispositions', async () => {
  assert.equal(credentialFingerprint({ z: 1, a: { d: 4, b: 2 } }), credentialFingerprint({ a: { b: 2, d: 4 }, z: 1 }))

  const state = deps()
  const sourceDuplicate = official('claude', 'Source duplicate', 'source-secret', { instance: 'remote', id: 'same' })
  const sourceConflict = official('claude', 'Source conflict', 'new-secret', { instance: 'remote', id: 'changed' })
  state.stores.accounts.value.credentials.push({
    id: 'existing-source',
    platform: 'claude',
    kind: 'official',
    display_name: 'Existing',
    external_source_client: 'ai-switch-transfer:remote',
    external_source_id: 'same',
    source_fingerprint: credentialFingerprint(fingerprintPayloadForTest(sourceDuplicate)),
    archived_at: null,
  }, {
    id: 'existing-conflict',
    platform: 'claude',
    kind: 'official',
    display_name: 'Existing conflict',
    external_source_client: 'ai-switch-transfer:remote',
    external_source_id: 'changed',
    source_fingerprint: 'different',
    archived_at: null,
  })

  const importable = api('Importable', 'transfer-importable-secret')
  const inputDuplicate = structuredClone(importable)
  inputDuplicate['x-ai-switch'].display_name = 'Input duplicate'
  const invalid = { type: 'claude', email: 'Broken Person' }
  const text = JSON.stringify([importable, inputDuplicate, sourceDuplicate, sourceConflict, invalid])
  const preview = await previewTransferImport({ text, ambiguousPlatformChoices: [] }, state)

  assert.deepEqual(preview.items.map((item) => item.disposition), [
    'importable',
    'input_duplicate',
    'source_duplicate',
    'conflict',
    'error',
  ])
  assert.equal(preview.counts.importable, 1)
  assert.equal(preview.counts.duplicates, 2)
  assert.equal(preview.counts.conflicts, 1)
  assert.equal(preview.counts.errors, 1)
  assert.doesNotMatch(JSON.stringify(preview), /transfer-importable-secret|source-secret|new-secret/)

  const outcome = await importTransferCredentials({
    text,
    ambiguousPlatformChoices: [],
    restorePoolMembership: false,
  }, state)
  assert.deepEqual(outcome, {
    imported: 1,
    skipped_duplicates: 2,
    conflicts: 1,
    failed: 1,
    restored_pool_members: 0,
  })
  assert.doesNotMatch(JSON.stringify(outcome), /transfer-importable-secret/)
})

test('deeplink parser accepts supported schemes and rejects a hostile URL', () => {
  const parsed = parseDeeplink('aiswitch://v1/import?resource=provider&app=claude&name=Safe&endpoint=https%3A%2F%2Fapi.example&apiKey=secret-key&sonnetModel=sonnet-upstream')
  assert.equal(parsed.platform, 'claude')
  assert.equal(parsed.interface_format, 'anthropic')
  assert.equal(parsed.api_key, 'secret-key')
  assert.equal(JSON.parse(parsed.model_mappings_json)[0].to, 'sonnet-upstream')
  assert.ok(parsed.source_url_sanitized.includes('secr***-key'))
  assert.throws(() => parseDeeplink('javascript:alert(1)'), /scheme|deep link/i)
  assert.throws(() => parseDeeplink('aiswitch://v1/import?resource=provider&app=claude&name=x&endpoint=file%3A%2F%2F%2Fetc%2Fpasswd&apiKey=x'), /endpoint/i)
})

test('pickJsonPath traverses objects and numeric array segments', () => {
  const value = { data: { plans: [{ quota: { remaining: '12.5' } }] } }
  assert.equal(pickJsonPath(value, 'data.plans.0.quota.remaining'), '12.5')
  assert.equal(pickJsonPath(value, 'data.plans.1.quota.remaining'), undefined)
  assert.equal(pickJsonPath(value, '__proto__.polluted'), undefined)
})

async function relayFixture(provider, body) {
  const state = deps()
  const row = {
    id: `relay-${provider}`,
    platform: 'codex',
    kind: 'api',
    display_name: provider,
    email: null,
    status: 'ok',
    route_priority: 3,
    max_concurrency: 5,
    secret_payload_json: JSON.stringify({ api_key: 'relay-secret-key' }),
    config_json: JSON.stringify({
      base_url: 'https://panel.example/v1',
      interface_format: 'openai',
      relay_balance: { provider, divisor: provider === 'new_api' ? 100 : undefined },
    }),
    preview_json: '{}',
  }
  state.stores.accounts.value.credentials.push(row)
  const calls = []
  const outcome = await refreshRelayBalance(row, {
    ...state,
    fetch: async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { outcome, calls, row }
}

test('official quota supports a Codex agent-identity credential', async () => {
  const state = deps()
  const pair = generateKeyPairSync('ed25519')
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const row = {
    id: 'agent-identity',
    platform: 'codex',
    kind: 'official',
    display_name: 'Agent identity',
    email: null,
    status: 'ok',
    route_priority: 3,
    max_concurrency: 5,
    secret_payload_json: JSON.stringify({
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'runtime',
      agent_private_key: privateKey,
      task_id: 'task',
      account_id: 'account',
    }),
    config_json: '{}',
    preview_json: '{}',
  }
  state.stores.accounts.value.credentials.push(row)
  let authorization = null
  const outcome = await refreshQuota(row, {
    ...state,
    fetch: async (_url, init) => {
      authorization = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({ rate_limit: { primary_window: { remaining: 90 } } }), { status: 200 })
    },
  })

  assert.equal(outcome.source, 'codex.config_usage')
  assert.match(authorization, /^AgentAssertion /)
})

test('relay balance parses new_api fixture body', async () => {
  const { outcome, calls } = await relayFixture('new_api', {
    code: true,
    data: { name: 'key', total_granted: 1000, total_used: 250, total_available: 750, unlimited_quota: false },
  })
  assert.equal(outcome.source, 'new_api')
  assert.equal(JSON.parse(outcome.credential.config_json).relay_balance_snapshot.remaining, 7.5)
  assert.ok(calls[0].endsWith('/api/usage/token/'))
})

test('relay balance parses sub2api fixture body', async () => {
  const { outcome, calls } = await relayFixture('sub2api', {
    isValid: true,
    planName: 'Pro',
    remaining: 12.5,
    quota: { used: 2.5, limit: 15 },
    unit: 'USD',
  })
  assert.equal(outcome.source, 'sub2api')
  const snapshot = JSON.parse(outcome.credential.config_json).relay_balance_snapshot
  assert.deepEqual({ remaining: snapshot.remaining, used: snapshot.used, limit: snapshot.limit }, { remaining: 12.5, used: 2.5, limit: 15 })
  assert.ok(calls[0].endsWith('/v1/usage'))
})
