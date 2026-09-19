/**
 * The route proxy is a local credential broker: every generation it serves spends the
 * user's stored upstream key. So the bearer key — not a request header — has to decide
 * which platform pool a request reaches. These tests pin that: a request must present a
 * key that maps to a platform, and the `x-ai-switch-platform` hint (which the reference
 * front end sends alongside the key) may only agree with that key, never stand in for it.
 *
 * @module dsh-plugin-ai-switch/test/proxy-auth
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { buildCommands, createContext } from '../src/host/routes.js'

let context
let commands
let base
let key
let upstream
let upstreamHits = 0
const dirs = []

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const home = await mkdtemp(join(tmpdir(), 'ais-auth-'))
  const userHomeDir = await mkdtemp(join(tmpdir(), 'ais-auth-user-'))
  dirs.push(home, userHomeDir)
  context = createContext({ home, userHomeDir })
  commands = buildCommands(context)
  const account = await commands.create_api_route_credential({ input: {
    platform: 'codex',
    display_name: 'relay',
    api_key: 'sk-upstream',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    interface_format: 'openai',
    model_mappings_json: JSON.stringify([{ from: 'gpt-5.6-sol', to: 'glm-5.3' }]),
  } })
  await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [account.id] } })
  const status = await commands.start_route_proxy({})
  base = status.base_url
  key = await commands.get_route_proxy_key({ platform: 'codex' })
})

after(async () => {
  await commands.stop_route_proxy({})
  await new Promise((resolve) => upstream.close(resolve))
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function chat(headers) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'ping' }] }),
  })
}

describe('proxy authentication', () => {
  it('refuses a request that carries only a platform header and no key', async () => {
    const before = upstreamHits
    const response = await chat({ 'x-ai-switch-platform': 'codex' })
    assert.equal(response.status, 401)
    // The upstream credential must not have been spent.
    assert.equal(upstreamHits, before)
  })

  it('refuses a bogus key even when a valid platform header is supplied', async () => {
    const response = await chat({ authorization: 'Bearer sk-not-a-real-key', 'x-ai-switch-platform': 'codex' })
    assert.equal(response.status, 401)
  })

  it('refuses a valid key whose platform header points at another platform', async () => {
    const before = upstreamHits
    // `anthropic` is a real alias for the claude platform, so this is a valid-but-mismatched
    // hint rather than a garbage string — the request must still be rejected.
    const response = await chat({ authorization: `Bearer ${key}`, 'x-ai-switch-platform': 'anthropic' })
    assert.equal(response.status, 403)
    assert.equal(upstreamHits, before)
  })

  it('serves a request with a valid key and no header, resolving the platform from the key', async () => {
    const response = await chat({ authorization: `Bearer ${key}` })
    assert.equal(response.status, 200)
  })

  it('serves a request whose header agrees with the key, including via an alias', async () => {
    const response = await chat({ authorization: `Bearer ${key}`, 'x-ai-switch-platform': 'openai' })
    assert.equal(response.status, 200)
  })

  it('refuses GET /v1/models without a key even under a platform header', async () => {
    const response = await fetch(`${base}/v1/models`, { headers: { 'x-ai-switch-platform': 'codex' } })
    assert.equal(response.status, 401)
  })

  it('leaves the unauthenticated health probe open', async () => {
    const response = await fetch(`${base}/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
  })
})
