/**
 * A real end-to-end model probe: fake upstream -> local route proxy -> test outcome.
 *
 * @module dsh-plugin-ai-switch/test/model-test
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it } from 'node:test'

import { buildCommands, createContext } from '../src/host/routes.js'

const cleanup = []
after(async () => {
  for (const fn of cleanup) await fn()
})

it('tests a selected account through the local proxy and returns the full outcome', async () => {
  const upstream = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(body.model, 'glm-5.3')
    assert.equal(req.headers.authorization, 'Bearer sk-upstream')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'probe-1',
      choices: [{ message: { role: 'assistant', content: 'ai-switch-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const state = await mkdtemp(join(tmpdir(), 'ais-test-'))
  const home = await mkdtemp(join(tmpdir(), 'ais-user-'))
  const context = createContext({ home: state, userHomeDir: home })
  const commands = buildCommands(context)
  cleanup.push(async () => {
    await commands.stop_route_proxy({})
    await new Promise((resolve) => upstream.close(resolve))
    await rm(state, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  const account = await commands.create_api_route_credential({ input: {
    platform: 'codex',
    display_name: 'relay',
    api_key: 'sk-upstream',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    interface_format: 'openai',
    model_mappings_json: JSON.stringify([{ from: 'gpt-5.6-sol', to: 'glm-5.3' }]),
  } })
  await commands.set_route_pool_members({ input: { platform: 'codex', account_ids: [account.id] } })
  const outcome = await commands.route_pool_test_model({ request: {
    platform: 'codex',
    account_id: account.id,
    model: 'gpt-5.6-sol',
    interface_format: 'openai',
  } })

  assert.equal(outcome.success, true)
  assert.equal(outcome.selected_account_id, account.id)
  assert.equal(outcome.response_text, 'ai-switch-ok')
  assert.equal(outcome.response_status, 200)
  assert.equal(outcome.via_route_proxy, true)
  assert.equal(outcome.route_proxy_entry_path, '/v1/chat/completions')
  assert.match(outcome.target_url, /^http:\/\/127\.0\.0\.1:/)
  assert.equal(outcome.stats.request_count, 1)
})
