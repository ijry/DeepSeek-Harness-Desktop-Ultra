/**
 * Direct model discovery tests. A local fake server proves endpoint fallback and credential
 * placement without ever sending the fixture key to the network.
 *
 * @module dsh-plugin-ai-switch/test/model-fetch
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, describe, it } from 'node:test'

import {
  fetchRouteModels,
  modelFetchHeaders,
  modelListCandidates,
  normalizeModelsResponse,
} from '../src/host/model-fetch.js'

const servers = []
after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve))
  }
})

async function fake(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

describe('direct model discovery', () => {
  it('normalizes nested provider shapes, strips models/, sorts and deduplicates', () => {
    const rows = normalizeModelsResponse({
      data: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', supports1m: true },
        { id: 'gpt-4o', owned_by: 'openai' },
        'gpt-4o',
        { nope: true },
      ],
    })
    assert.deepEqual(rows, [
      { id: 'gemini-2.5-flash', owned_by: 'Gemini Flash', supports_1m: true },
      { id: 'gpt-4o', owned_by: 'openai', supports_1m: null },
    ])
  })

  it('uses the right endpoints for each dialect', () => {
    assert.deepEqual(modelListCandidates('https://relay.test/v1', 'openai'), ['https://relay.test/v1/models'])
    assert.deepEqual(modelListCandidates('https://relay.test/v1', 'anthropic'), [
      'https://relay.test/v1/models',
      'https://relay.test/models',
    ])
    assert.deepEqual(modelListCandidates('https://relay.test', 'gemini'), [
      'https://relay.test/v1beta/models',
      'https://relay.test/v1/models',
    ])
  })

  it('places credentials in protocol-specific headers', () => {
    assert.equal(modelFetchHeaders('sk-a', 'openai').authorization, 'Bearer sk-a')
    assert.equal(modelFetchHeaders('sk-a', 'anthropic')['x-api-key'], 'sk-a')
    assert.equal(modelFetchHeaders('sk-a', 'anthropic', 'ANTHROPIC_AUTH_TOKEN').authorization, 'Bearer sk-a')
  })

  it('falls back across anthropic endpoints and returns the normalized rows', async () => {
    const seen = []
    const base = await fake((req, res) => {
      seen.push({ url: req.url, key: req.headers['x-api-key'] })
      if (req.url === '/v1/models') {
        res.writeHead(404)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }] }))
    })
    const rows = await fetchRouteModels({
      base_url: base,
      api_key: 'sk-secret',
      interface_format: 'anthropic',
      api_key_field: 'ANTHROPIC_API_KEY',
    })
    assert.deepEqual(rows, [{ id: 'claude-sonnet-4', owned_by: 'Claude Sonnet 4', supports_1m: null }])
    assert.deepEqual(seen, [
      { url: '/v1/models', key: 'sk-secret' },
      { url: '/models', key: 'sk-secret' },
    ])
  })

  it('puts a Gemini key in the query string, never in an auth header', async () => {
    let seen
    const base = await fake((req, res) => {
      seen = { url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }))
    })
    const rows = await fetchRouteModels({ base_url: base, api_key: 'gm-key', interface_format: 'gemini' })
    assert.equal(rows[0].id, 'gemini-2.5-flash')
    assert.match(seen.url, /\/v1beta\/models\?key=gm-key$/)
    assert.equal(seen.auth, undefined)
    assert.equal(seen.key, undefined)
  })
})
