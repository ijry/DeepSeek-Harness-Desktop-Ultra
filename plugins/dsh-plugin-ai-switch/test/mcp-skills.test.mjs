/**
 * The parts of the MCP and Skills ports that are expensive to get wrong: transport
 * normalization, the comment-preserving round trips through a TOML and a JSON client, the
 * "unticking a client deletes the entry" rule, and the two path guards in Skills.
 *
 * Every case runs against a temporary home with `HOME`/`USERPROFILE` and the four `*_HOME`
 * variables pointed into it, so the scans exercise the same path resolution the panel uses
 * and never read the developer's own `~/.codex`. No network: the marketplace search and
 * detail paths are covered by their pure helpers (spec normalization, parameter folding)
 * rather than by hitting a registry.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  MCP_APPS,
  appCanHostSpec,
  normalizeMcpType,
  normalizeSpec,
  removeServer,
  scanLocal,
  setServerApps,
  upsertLocalServer,
} from '../src/host/mcp.js'
import { listMarketplaces } from '../src/host/mcp.js'
import {
  SKILL_AGENTS,
  installPackage,
  listAgents,
  listPackages,
  listSkills,
  parseFrontmatter,
  pathIsInsideRoot,
  readPackage,
  readSkill,
  saveSkill,
  skillDirs,
  deleteSkill,
  uninstallPackage,
  validateSkillId,
} from '../src/host/skills.js'

const temporaryHomes = []

after(async () => {
  for (const home of temporaryHomes) {
    await rm(home, { recursive: true, force: true })
  }
})

/** Run `body` against a hermetic home directory, restoring the environment after. */
async function withTempHome(body) {
  const home = await mkdtemp(join(tmpdir(), 'ai-switch-mcpskills-'))
  temporaryHomes.push(home)
  const keys = [
    'HOME',
    'USERPROFILE',
    'CODEX_HOME',
    'GROK_HOME',
    'HERMES_HOME',
    'KIMI_CODE_HOME',
    'AI_SWITCH_SKILL_PACKAGES_DIR',
    'DSH_HOME',
  ]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.GROK_HOME = join(home, '.grok')
  process.env.HERMES_HOME = join(home, '.hermes')
  process.env.KIMI_CODE_HOME = join(home, '.kimi-code')
  process.env.DSH_HOME = join(home, '.dsh')
  delete process.env.AI_SWITCH_SKILL_PACKAGES_DIR
  try {
    return await body(home)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function writeText(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

// ---------------------------------------------------------------------------
// Spec normalization
// ---------------------------------------------------------------------------

test('the eleven clients and eleven agents are the reference ids in the reference order', () => {
  assert.deepEqual(MCP_APPS, [
    'claude_code',
    'codex',
    'gemini',
    'open_claw',
    'open_code',
    'hermes',
    'cline',
    'cursor',
    'kimi_code',
    'code_buddy',
    'grok',
  ])
  // Skills uses the same eleven ids but its own order, Codex first.
  assert.equal(SKILL_AGENTS.length, 11)
  assert.equal(SKILL_AGENTS[0], 'codex')
  assert.deepEqual([...SKILL_AGENTS].sort(), [...MCP_APPS].sort())
})

test('a stdio spec is inferred from command and its arguments are trimmed', () => {
  const spec = normalizeSpec({ command: '  npx  ', args: ['  -y  ', 'server', '   ', 7] })
  assert.equal(spec.type, 'stdio')
  assert.equal(spec.command, 'npx')
  assert.deepEqual(spec.args, ['-y', 'server'])
})

test('a remote spec is inferred from url, and every transport spelling collapses to three', () => {
  assert.equal(normalizeSpec({ url: 'https://example.test/mcp' }).type, 'http')
  assert.equal(normalizeSpec({ type: 'streamableHttp', url: 'https://example.test/mcp' }).type, 'http')
  assert.equal(normalizeSpec({ transport: 'SSE', url: 'https://example.test/sse' }).type, 'sse')
  assert.equal(normalizeMcpType('server-sent-events'), 'sse')
  assert.equal(normalizeMcpType('nonsense'), null)
})

test('unknown keys survive normalization but the transport alias does not', () => {
  const spec = normalizeSpec({ transport: 'http', url: 'https://example.test', disabled: true })
  assert.equal(spec.disabled, true)
  assert.equal(spec.transport, undefined)
})

test('a spec with neither type, command nor url is refused', () => {
  assert.throws(() => normalizeSpec({ env: { A: '1' } }), (error) => error.code === 'mcp.invalid_spec')
  assert.throws(() => normalizeSpec('nope'), (error) => error.code === 'mcp.invalid_spec')
  assert.throws(
    () => normalizeSpec({ type: 'stdio', command: '   ' }),
    (error) => error.code === 'mcp.invalid_spec',
  )
})

test('Codex cannot host SSE, and everyone else can', () => {
  const sse = normalizeSpec({ type: 'sse', url: 'https://example.test/sse' })
  assert.equal(appCanHostSpec('codex', sse), false)
  for (const app of MCP_APPS.filter((item) => item !== 'codex')) {
    assert.equal(appCanHostSpec(app, sse), true)
  }
  // Codex hosts the other two transports fine.
  assert.equal(appCanHostSpec('codex', normalizeSpec({ command: 'npx' })), true)
  assert.equal(appCanHostSpec('codex', normalizeSpec({ url: 'https://example.test' })), true)
})

test('an SSE server targeting only Codex is refused, not written half-way', async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      upsertLocalServer({
        serverId: 'remote',
        spec: { type: 'sse', url: 'https://example.test/sse' },
        apps: ['codex'],
      }),
      (error) => error.code === 'mcp.no_compatible_client',
    )
    // And nothing was created on the way to the refusal.
    assert.deepEqual(await scanLocal(), [])
    await assert.rejects(readFile(join(home, '.codex', 'config.toml'), 'utf8'))
  })
})

test('the two marketplace providers are fixed', async () => {
  const providers = await listMarketplaces()
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['official_registry', 'smithery'],
  )
})

// ---------------------------------------------------------------------------
// Client round trips
// ---------------------------------------------------------------------------

test('a Codex round trip keeps the file comment and the sibling root key', async () => {
  await withTempHome(async (home) => {
    const config = join(home, '.codex', 'config.toml')
    await writeText(
      config,
      ['# my hand-written codex config', 'model = "gpt-5"', '', '[mcp_servers.keeper]', 'command = "npx"', 'args = ["-y", "keep"]', ''].join('\n'),
    )

    const written = await upsertLocalServer({
      serverId: 'fresh',
      spec: { command: 'uvx', args: ['thing'], env: { TOKEN: 'x' } },
      apps: ['codex'],
    })
    assert.deepEqual(written.apps, ['codex'])
    assert.equal(written.spec.type, 'stdio')

    const text = await readFile(config, 'utf8')
    assert.match(text, /# my hand-written codex config/)
    assert.match(text, /model = "gpt-5"/)
    assert.match(text, /\[mcp_servers\.keeper\]/)
    assert.match(text, /\[mcp_servers\.fresh\]/)
    assert.match(text, /env = \{ TOKEN = "x" \}/)
    // The hand-written entry is byte-identical, quote style and spacing included.
    assert.match(text, /^args = \["-y", "keep"\]$/m)

    const scanned = await scanLocal()
    assert.deepEqual(
      scanned.map((server) => server.id),
      ['fresh', 'keeper'],
    )
    assert.deepEqual(scanned.find((server) => server.id === 'fresh').spec, {
      command: 'uvx',
      args: ['thing'],
      env: { TOKEN: 'x' },
      type: 'stdio',
    })

    // Removing the new one leaves the hand-written entry and the comment intact.
    assert.equal(await removeServer({ serverId: 'fresh' }), true)
    const after = await readFile(config, 'utf8')
    assert.match(after, /# my hand-written codex config/)
    assert.match(after, /\[mcp_servers\.keeper\]/)
    assert.doesNotMatch(after, /\[mcp_servers\.fresh\]/)
  })
})

test('removing a middle Codex entry takes its own comment and leaves the next one alone', async () => {
  await withTempHome(async (home) => {
    const config = join(home, '.codex', 'config.toml')
    await writeText(
      config,
      [
        '# top of file',
        'model = "gpt-5"',
        '',
        '# describes first',
        '[mcp_servers.first]',
        'command = "one"',
        '',
        '# describes second',
        '[mcp_servers.second]',
        'command = "two"',
        '',
        '[other]',
        'k = 1',
        '',
      ].join('\n'),
    )

    assert.equal(await removeServer({ serverId: 'first', apps: ['codex'] }), true)
    const text = await readFile(config, 'utf8')
    assert.doesNotMatch(text, /# describes first/)
    assert.doesNotMatch(text, /\[mcp_servers\.first\]/)
    // The next entry keeps its own introducing comment and its blank-line separation.
    assert.match(text, /\n\n# describes second\n\[mcp_servers\.second\]\n/)
    assert.match(text, /\n\n\[other\]\n/)
    assert.match(text, /# top of file/)
  })
})

test('Codex writes headers as http_headers and reads them back as headers', async () => {
  await withTempHome(async () => {
    await upsertLocalServer({
      serverId: 'remote',
      spec: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Token': 'secret' } },
      apps: ['codex'],
    })
    const text = await readFile(join(process.env.CODEX_HOME, 'config.toml'), 'utf8')
    // `X-Token` is a legal TOML bare key, so it is written unquoted.
    assert.match(text, /http_headers = \{ X-Token = "secret" \}/)
    const server = (await scanLocal()).find((item) => item.id === 'remote')
    assert.deepEqual(server.spec, {
      url: 'https://example.test/mcp',
      headers: { 'X-Token': 'secret' },
      type: 'http',
    })
  })
})

test('a Gemini JSON round trip keeps the sibling keys of the settings file', async () => {
  await withTempHome(async (home) => {
    const config = join(home, '.gemini', 'settings.json')
    await writeText(
      config,
      `${JSON.stringify({ theme: 'dark', selectedAuthType: 'oauth-personal', mcpServers: { keeper: { command: 'npx' } } }, null, 2)}\n`,
    )

    await upsertLocalServer({ serverId: 'fresh', spec: { url: 'https://example.test/mcp' }, apps: ['gemini'] })

    const root = JSON.parse(await readFile(config, 'utf8'))
    assert.equal(root.theme, 'dark')
    assert.equal(root.selectedAuthType, 'oauth-personal')
    assert.deepEqual(Object.keys(root.mcpServers).sort(), ['fresh', 'keeper'])
    assert.equal(root.mcpServers.fresh.type, 'http')

    assert.equal(await removeServer({ serverId: 'fresh', apps: ['gemini'] }), true)
    const after = JSON.parse(await readFile(config, 'utf8'))
    assert.equal(after.theme, 'dark')
    assert.deepEqual(Object.keys(after.mcpServers), ['keeper'])
  })
})

test('a Hermes YAML round trip keeps the comment and the sibling top-level key', async () => {
  await withTempHome(async (home) => {
    const config = join(home, '.hermes', 'config.yaml')
    await writeText(
      config,
      ['# hermes, edited by hand', 'model: sonnet', 'mcp_servers:', '  keeper:', '    command: npx', '    args:', '      - -y', '      - keep', ''].join('\n'),
    )

    await upsertLocalServer({ serverId: 'remote', spec: { type: 'sse', url: 'https://example.test/sse' }, apps: ['hermes'] })

    const text = await readFile(config, 'utf8')
    assert.match(text, /# hermes, edited by hand/)
    assert.match(text, /^model: sonnet$/m)
    assert.match(text, /^ {2}keeper:$/m)
    // SSE is spelled `transport: sse` in a Hermes config.
    assert.match(text, /^ {4}transport: sse$/m)

    const scanned = await scanLocal()
    assert.deepEqual(scanned.map((server) => server.id), ['keeper', 'remote'])
    assert.equal(scanned.find((server) => server.id === 'remote').spec.type, 'sse')
    assert.deepEqual(scanned.find((server) => server.id === 'keeper').spec.args, ['-y', 'keep'])
  })
})

test('each client gets its own dialect of the same stdio server', async () => {
  await withTempHome(async (home) => {
    await upsertLocalServer({
      serverId: 'shared',
      spec: { command: 'uvx', args: ['pkg'], env: { A: '1' } },
      apps: ['cline', 'cursor', 'kimi_code', 'open_claw', 'open_code'],
    })

    const cline = JSON.parse(await readFile(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'))
    assert.equal(cline.mcpServers.shared.type, 'stdio')

    // Cursor infers the transport and rejects an explicit `type`.
    const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.equal(cursor.mcpServers.shared.type, undefined)
    assert.equal(cursor.mcpServers.shared.command, 'uvx')

    const kimi = JSON.parse(await readFile(join(home, '.kimi-code', 'mcp.json'), 'utf8'))
    assert.equal(kimi.mcpServers.shared.type, 'stdio')

    // OpenClaw namespaces everything under `mcp.servers`.
    const openClaw = JSON.parse(await readFile(join(home, '.openclaw', 'openclaw.json'), 'utf8'))
    assert.equal(openClaw.mcpServers, undefined)
    assert.equal(openClaw.mcp.servers.shared.command, 'uvx')

    // A brand new OpenCode config gets the old `mcp` shape with an argv array.
    const openCode = JSON.parse(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'))
    assert.deepEqual(openCode.mcp.shared, { type: 'local', command: ['uvx', 'pkg'], environment: { A: '1' } })

    const scanned = await scanLocal()
    assert.deepEqual(scanned.length, 1)
    assert.deepEqual(scanned[0].apps, ['open_claw', 'open_code', 'cline', 'cursor', 'kimi_code'])
  })
})

test('Cline writes streamableHttp for an http server and still reads it as http', async () => {
  await withTempHome(async (home) => {
    await upsertLocalServer({ serverId: 'remote', spec: { type: 'http', url: 'https://example.test/mcp' }, apps: ['cline'] })
    const config = JSON.parse(await readFile(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'))
    assert.equal(config.mcpServers.remote.type, 'streamableHttp')
    assert.equal((await scanLocal())[0].spec.type, 'http')
  })
})

test('an OpenCode config that already uses mcpServers keeps using it', async () => {
  await withTempHome(async (home) => {
    const config = join(home, '.config', 'opencode', 'opencode.json')
    await writeText(config, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)
    await upsertLocalServer({ serverId: 'fresh', spec: { command: 'npx', args: ['-y', 'x'] }, apps: ['open_code'] })
    const root = JSON.parse(await readFile(config, 'utf8'))
    assert.equal(root.mcp, undefined)
    assert.equal(root.mcpServers.fresh.command, 'npx')
  })
})

test('an unreadable entry or a broken config file costs only that entry, not the scan', async () => {
  await withTempHome(async (home) => {
    // A multi-line string is outside what the line-oriented TOML reader understands, so
    // this entry is skipped rather than half-parsed — and left untouched on disk.
    await writeText(
      join(home, '.codex', 'config.toml'),
      ['[mcp_servers.weird]', 'command = """', 'npx', '"""', '', '[mcp_servers.fine]', 'command = "ok"', ''].join('\n'),
    )
    // And a config file that is not valid JSON at all reports nothing instead of throwing.
    await writeText(join(home, '.gemini', 'settings.json'), '{ this is not json')

    const scanned = await scanLocal()
    assert.deepEqual(scanned.map((server) => server.id), ['fine'])
    // The unreadable entry is still in the file.
    assert.match(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.weird\]/)
  })
})

test('a legacy OpenCode entry reads as a canonical stdio spec', async () => {
  await withTempHome(async (home) => {
    await writeText(
      join(home, '.config', 'opencode', 'opencode.json'),
      `${JSON.stringify({ mcp: { legacy: { type: 'local', command: ['npx', '-y', 'old'], environment: { A: '1' } } } }, null, 2)}\n`,
    )
    const scanned = await scanLocal()
    assert.deepEqual(scanned[0].spec, { type: 'stdio', command: 'npx', args: ['-y', 'old'], env: { A: '1' } })
  })
})

test('Claude Code and CodeBuddy flip their enabledPlugins entry on and off', async () => {
  await withTempHome(async (home) => {
    await upsertLocalServer({ serverId: 'demo', spec: { command: 'npx' }, apps: ['claude_code', 'code_buddy'] })
    assert.equal(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins['demo@local'], true)
    assert.equal(JSON.parse(await readFile(join(home, '.codebuddy', 'settings.json'), 'utf8')).enabledPlugins['demo@local'], true)

    await removeServer({ serverId: 'demo' })
    assert.equal(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins['demo@local'], undefined)
    assert.equal(JSON.parse(await readFile(join(home, '.codebuddy', 'settings.json'), 'utf8')).enabledPlugins['demo@local'], undefined)
  })
})

// ---------------------------------------------------------------------------
// upsert removes from unselected clients
// ---------------------------------------------------------------------------

test('upsertLocalServer removes the server from clients the caller did not select', async () => {
  await withTempHome(async (home) => {
    const spec = { command: 'npx', args: ['-y', 'demo'] }
    await upsertLocalServer({ serverId: 'demo', spec, apps: ['codex', 'gemini', 'cursor'] })
    assert.deepEqual((await scanLocal())[0].apps, ['codex', 'gemini', 'cursor'])

    // Re-saving with a narrower selection has to delete the other two entries.
    const narrowed = await upsertLocalServer({ serverId: 'demo', spec, apps: ['gemini'] })
    assert.deepEqual(narrowed.apps, ['gemini'])

    const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8').catch(() => '')
    assert.doesNotMatch(codex, /mcp_servers\.demo/)
    const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(cursor.mcpServers), [])
    const gemini = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8'))
    assert.deepEqual(Object.keys(gemini.mcpServers), ['demo'])
  })
})

test('setServerApps to an empty list removes the server everywhere and returns null', async () => {
  await withTempHome(async () => {
    await upsertLocalServer({ serverId: 'demo', spec: { command: 'npx' }, apps: ['gemini', 'cursor'] })
    assert.equal(await setServerApps({ serverId: 'demo', apps: [] }), null)
    assert.deepEqual(await scanLocal(), [])
    await assert.rejects(
      setServerApps({ serverId: 'demo', apps: ['gemini'] }),
      (error) => error.code === 'mcp.server_not_found',
    )
  })
})

test('removeServer scoped to one client leaves the others alone', async () => {
  await withTempHome(async () => {
    await upsertLocalServer({ serverId: 'demo', spec: { command: 'npx' }, apps: ['gemini', 'cursor'] })
    assert.equal(await removeServer({ serverId: 'demo', apps: ['cursor'] }), true)
    assert.deepEqual((await scanLocal())[0].apps, ['gemini'])
    // A second removal of the same client finds nothing left to do.
    assert.equal(await removeServer({ serverId: 'demo', apps: ['cursor'] }), false)
  })
})

// ---------------------------------------------------------------------------
// Skills: ids and paths
// ---------------------------------------------------------------------------

test('an unsafe skill id is rejected', () => {
  for (const id of ['', '   ', '.', '..', '../outside', 'nested/skill', 'nested\\skill', 'C:evil', '.hidden', 'a b', 'a\tb']) {
    assert.throws(
      () => validateSkillId(id),
      (error) => error.code === 'validation.skill_id',
      `expected ${JSON.stringify(id)} to be rejected`,
    )
  }
  // A control character, written as an escape rather than typed into the source.
  assert.throws(() => validateSkillId(`a${String.fromCharCode(10)}b`), (error) => error.code === 'validation.skill_id')
  assert.throws(() => validateSkillId(`a${String.fromCharCode(0)}b`), (error) => error.code === 'validation.skill_id')
  assert.equal(validateSkillId('  demo-skill  '), 'demo-skill')
  assert.equal(validateSkillId('under_score.v2'), 'under_score.v2')
})

test('a sibling directory sharing the root prefix is not inside the root', () => {
  const root = join('/tmp', 'skills')
  assert.equal(pathIsInsideRoot(root, join(root, 'demo')), true)
  assert.equal(pathIsInsideRoot(root, root), true)
  // The separator is part of the prefix, so this must NOT pass.
  assert.equal(pathIsInsideRoot(root, `${root}-secrets`), false)
  assert.equal(pathIsInsideRoot(root, `${root}-secrets${join('/', 'demo')}`), false)
  assert.equal(pathIsInsideRoot(root, join('/tmp', 'other')), false)
})

test('a skill id that escapes its directory is refused before anything is written', async () => {
  await withTempHome(async () => {
    for (const skillId of ['../escape', 'a/b', '.system']) {
      await assert.rejects(
        saveSkill({ agentType: 'codex', scope: 'global', skillId, content: 'x' }),
        (error) => error.code === 'validation.skill_id',
      )
      await assert.rejects(
        deleteSkill({ agentType: 'codex', scope: 'global', skillId }),
        (error) => error.code === 'validation.skill_id',
      )
    }
  })
})

test('the per-agent directories are the reference tables, read-only roots included', async () => {
  await withTempHome(async (home) => {
    const codex = skillDirs('codex', 'global')
    assert.deepEqual(
      codex.map((dir) => dir.path),
      [join(home, '.codex', 'skills'), join(home, '.codex', 'skills', '.system'), join(home, '.agents', 'skills')],
    )
    assert.deepEqual(
      codex.map((dir) => dir.read_only),
      [false, true, false],
    )
    assert.deepEqual(
      codex.map((dir) => dir.source),
      ['codex', 'builtin', 'agents'],
    )

    const cursor = skillDirs('cursor', 'global')
    assert.equal(cursor.at(-1).path, join(home, '.cursor', 'skills-cursor'))
    assert.equal(cursor.at(-1).read_only, true)

    // Hermes has no project-scoped skills at all.
    assert.deepEqual(skillDirs('hermes', 'project', home), [])
    // OpenClaw reads a bare `skills/` at the project root.
    assert.deepEqual(skillDirs('open_claw', 'project', home).map((dir) => dir.path), [join(home, 'skills')])
    // And the four *_HOME overrides are honoured.
    assert.deepEqual(skillDirs('grok', 'global').map((dir) => dir.path), [join(home, '.grok', 'skills')])
    assert.deepEqual(skillDirs('kimi_code', 'global').map((dir) => dir.path), [join(home, '.kimi-code', 'skills')])
    assert.deepEqual(skillDirs('hermes', 'global').map((dir) => dir.path), [join(home, '.hermes', 'skills')])

    assert.throws(() => skillDirs('codex', 'project'), (error) => error.code === 'skills.path_invalid')
    assert.throws(() => skillDirs('nope', 'global'), (error) => error.code === 'skills.unknown_agent')
  })
})

test('every agent reports itself as skills capable, with its reference display name', async () => {
  const agents = await listAgents()
  assert.equal(agents.length, 11)
  assert.equal(agents[0].agent_type, 'codex')
  assert.equal(agents[0].display_name, 'Codex CLI')
  assert.ok(agents.every((agent) => agent.skills_capable === true))
})

// ---------------------------------------------------------------------------
// Skills: front matter
// ---------------------------------------------------------------------------

test('front matter yields name, description, category, tags and language', () => {
  const metadata = parseFrontmatter(
    [
      '---',
      'name: demo',
      'display_name: Demo Skill',
      'description: "A quoted: description"',
      'category: tools',
      'tags: filesystem, io, filesystem',
      'language: en',
      '---',
      '# Body',
    ].join('\n'),
  )
  assert.equal(metadata.name, 'demo')
  assert.equal(metadata.display_name, 'Demo Skill')
  assert.equal(metadata.description, 'A quoted: description')
  assert.equal(metadata.category, 'tools')
  // Comma-separated tags, trimmed and deduplicated in first-seen order.
  assert.deepEqual(metadata.tags, ['filesystem', 'io'])
  assert.equal(metadata.language, 'en')
})

test('front matter tags also arrive as a block sequence or a flow list', () => {
  const block = parseFrontmatter(['---', 'name: demo', 'tags:', '  - alpha', '  - beta', '---', ''].join('\n'))
  assert.deepEqual(block.tags, ['alpha', 'beta'])
  const flow = parseFrontmatter(['---', 'tags: [alpha, "beta"]', '---', ''].join('\n'))
  assert.deepEqual(flow.tags, ['alpha', 'beta'])
})

test('a document without front matter has no metadata, and unknown keys are ignored', () => {
  assert.equal(parseFrontmatter('# Just a heading\n'), null)
  assert.equal(parseFrontmatter('---\nname: demo\nno terminator here\n'), null)
  const metadata = parseFrontmatter(
    ['---', 'name: demo', 'license: MIT license', 'metadata: {"version": "1.1"}', '---', ''].join('\n'),
  )
  assert.equal(metadata.name, 'demo')
  assert.deepEqual(metadata.tags, [])
  assert.equal(metadata.category, null)
})

// ---------------------------------------------------------------------------
// Skills: listing, saving, deleting
// ---------------------------------------------------------------------------

test('a Codex listing covers both layouts and flags the built-in directory read-only', async () => {
  await withTempHome(async (home) => {
    const skills = join(home, '.codex', 'skills')
    await writeText(join(skills, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: hi\n---\n# demo\n')
    await writeText(join(skills, 'loose.md'), '---\nname: loose\n---\n')
    await writeText(join(skills, '.system', 'imagegen', 'SKILL.md'), '---\nname: imagegen\n---\n')

    const listing = await listSkills({ agentType: 'codex', scope: 'global' })
    assert.equal(listing.supported, true)
    assert.equal(listing.message, null)
    assert.deepEqual(listing.locations.map((location) => location.exists), [true, true, false])
    assert.deepEqual(listing.skills.map((skill) => skill.id), ['demo', 'imagegen', 'loose'])

    const byId = new Map(listing.skills.map((skill) => [skill.id, skill]))
    assert.equal(byId.get('demo').layout, 'skill_directory')
    assert.equal(byId.get('demo').description, 'hi')
    assert.equal(byId.get('loose').layout, 'markdown_file')
    assert.equal(byId.get('imagegen').read_only, true)
    assert.equal(byId.get('imagegen').source, 'builtin')
    assert.deepEqual(byId.get('demo').target_clients, ['codex'])
  })
})

test('a loose markdown file is only a skill for Codex', async () => {
  await withTempHome(async (home) => {
    await writeText(join(home, '.claude', 'skills', 'loose.md'), '---\nname: loose\n---\n')
    await writeText(join(home, '.claude', 'skills', 'proper', 'SKILL.md'), '---\nname: proper\n---\n')
    const listing = await listSkills({ agentType: 'claude_code', scope: 'global' })
    assert.deepEqual(listing.skills.map((skill) => skill.id), ['proper'])
  })
})

test('the first directory in scan order wins for a duplicated id', async () => {
  await withTempHome(async (home) => {
    await writeText(join(home, '.codex', 'skills', 'dup', 'SKILL.md'), '---\ndisplay_name: Codex copy\n---\n')
    await writeText(join(home, '.agents', 'skills', 'dup', 'SKILL.md'), '---\ndisplay_name: Shared copy\n---\n')
    const listing = await listSkills({ agentType: 'codex', scope: 'global' })
    assert.equal(listing.skills.length, 1)
    assert.equal(listing.skills[0].name, 'Codex copy')
  })
})

test('a skill saves, reads back, and deletes; a built-in one refuses to be touched', async () => {
  await withTempHome(async (home) => {
    const saved = await saveSkill({
      agentType: 'codex',
      scope: 'global',
      skillId: 'demo',
      content: '---\nname: demo\ndescription: saved\n---\n# body\n',
    })
    assert.equal(saved.path, join(home, '.codex', 'skills', 'demo'))
    assert.equal(saved.layout, 'skill_directory')
    assert.equal(saved.description, 'saved')

    const read = await readSkill({ agentType: 'codex', scope: 'global', skillId: 'demo' })
    assert.match(read.content, /# body/)
    assert.equal(read.skill.id, 'demo')

    // An edit keeps the layout it already has rather than converting it.
    const loose = join(home, '.codex', 'skills', 'solo.md')
    await writeText(loose, '---\nname: solo\n---\n')
    const resaved = await saveSkill({
      agentType: 'codex',
      scope: 'global',
      skillId: 'solo',
      content: '---\nname: solo\ndescription: edited\n---\n',
      layout: 'skill_directory',
    })
    assert.equal(resaved.layout, 'markdown_file')
    assert.equal(resaved.path, loose)

    assert.equal(await deleteSkill({ agentType: 'codex', scope: 'global', skillId: 'demo' }), true)
    // Already gone is `false`, not an error.
    assert.equal(await deleteSkill({ agentType: 'codex', scope: 'global', skillId: 'demo' }), false)

    await writeText(join(home, '.codex', 'skills', '.system', 'builtin', 'SKILL.md'), '---\nname: builtin\n---\n')
    await assert.rejects(
      deleteSkill({ agentType: 'codex', scope: 'global', skillId: 'builtin' }),
      (error) => error.code === 'skills.read_only',
    )
    await assert.rejects(
      saveSkill({ agentType: 'codex', scope: 'global', skillId: 'builtin', content: 'x' }),
      (error) => error.code === 'skills.read_only',
    )
  })
})

test('an agent that only reads directories refuses a markdown_file layout', async () => {
  await withTempHome(async () => {
    await assert.rejects(
      saveSkill({ agentType: 'gemini', scope: 'global', skillId: 'demo', content: 'x', layout: 'markdown_file' }),
      (error) => error.code === 'skills.invalid_layout',
    )
    const saved = await saveSkill({ agentType: 'gemini', scope: 'global', skillId: 'demo', content: 'x' })
    assert.equal(saved.layout, 'skill_directory')
  })
})

test('a project-scoped listing needs a workspace that exists', async () => {
  await withTempHome(async (home) => {
    await assert.rejects(
      listSkills({ agentType: 'codex', scope: 'project', workspacePath: join(home, 'nowhere') }),
      (error) => error.code === 'skills.directory_missing',
    )
    const project = join(home, 'work')
    await writeText(join(project, '.codex', 'skills', 'local', 'SKILL.md'), '---\nname: local\n---\n')
    const listing = await listSkills({ agentType: 'codex', scope: 'project', workspacePath: project })
    assert.deepEqual(listing.skills.map((skill) => skill.id), ['local'])
    assert.equal(listing.skills[0].scope, 'project')
    assert.equal(listing.skills[0].source, 'project')
  })
})

// ---------------------------------------------------------------------------
// Skills: packages
// ---------------------------------------------------------------------------

test('the two built-in packs carry the reference ids and member counts', async () => {
  await withTempHome(async () => {
    const result = await listPackages({ agentType: 'codex', scope: 'global' })
    assert.deepEqual(result.packages.map((item) => item.id), ['ai-switch.core', 'ai-switch.science'])
    const core = result.packages[0]
    assert.equal(core.skill_count, 14)
    assert.equal(core.installed_count, 0)
    assert.equal(core.source, 'builtin')
    assert.equal(core.read_only, true)
    assert.deepEqual(core.target_clients, ['codex'])
    assert.ok(core.skill_ids.includes('brainstorming'))
    assert.equal(result.packages[1].skill_count, 13)
    assert.ok(result.packages[1].skill_ids.includes('statistical-analysis'))
    assert.deepEqual(result.warnings, [])
  })
})

test('an installed member is annotated with its pack and counted', async () => {
  await withTempHome(async (home) => {
    await writeText(join(home, '.codex', 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n')
    const listing = await listSkills({ agentType: 'codex', scope: 'global' })
    assert.equal(listing.skills[0].package_id, 'ai-switch.core')
    assert.equal(listing.skills[0].package_name, 'AI Switch Core Skill Pack')

    const packages = await listPackages({ agentType: 'codex', scope: 'global' })
    assert.deepEqual(packages.packages[0].installed_skill_ids, ['brainstorming'])
    assert.equal(packages.packages[0].installed_count, 1)
    assert.deepEqual(packages.skills.map((skill) => skill.id), ['brainstorming'])

    const detail = await readPackage({ packageId: 'ai-switch.core' })
    assert.equal(detail.members.length, 14)
    assert.equal(detail.members.find((member) => member.id === 'brainstorming').installed, true)
    assert.equal(detail.members.find((member) => member.id === 'writing-plans').installed, false)
    assert.equal(detail.members.find((member) => member.id === 'writing-plans').skill, null)
    assert.deepEqual(detail.skills.map((skill) => skill.id), ['brainstorming'])
  })
})

test('package operations are Codex only, and an unknown pack is not found', async () => {
  await withTempHome(async () => {
    assert.deepEqual(await listPackages({ agentType: 'gemini' }), { packages: [], skills: [], warnings: [] })
    await assert.rejects(
      readPackage({ packageId: 'ai-switch.core', agentType: 'gemini' }),
      (error) => error.code === 'skills.package_not_found',
    )
    for (const call of [installPackage, uninstallPackage]) {
      await assert.rejects(
        call({ packageId: 'ai-switch.core', agentType: 'cline' }),
        (error) => error.code === 'skills.package_operation_unsupported',
      )
    }
    await assert.rejects(
      uninstallPackage({ packageId: 'ai-switch.nope' }),
      (error) => error.code === 'skills.package_not_found',
    )
    await assert.rejects(
      uninstallPackage({ packageId: 'ai-switch.core', skillIds: ['statistical-power'] }),
      (error) => error.code === 'skills.package_member_missing',
    )
    await assert.rejects(
      uninstallPackage({ packageId: 'ai-switch.core', skillIds: ['../../evil'] }),
      (error) => error.code === 'validation.skill_id',
    )
  })
})

test('install refuses with package_source_missing when the pack files are absent', async () => {
  await withTempHome(async () => {
    await assert.rejects(
      installPackage({ packageId: 'ai-switch.core', skillIds: ['brainstorming'] }),
      (error) => error.code === 'skills.package_source_missing' && typeof error.details === 'string',
    )
  })
})

test('install copies from a source tree without overwriting an edited member', async () => {
  await withTempHome(async (home) => {
    const source = join(home, 'packs')
    for (const [pack, id] of [
      ['ai-switch.core', 'brainstorming'],
      ['ai-switch.core', 'writing-plans'],
      ['ai-switch.science', 'peer-review'],
    ]) {
      await writeText(join(source, pack, id, 'SKILL.md'), `---\nname: bundled-${id}\n---\n`)
    }
    process.env.AI_SWITCH_SKILL_PACKAGES_DIR = source

    // An already-installed member the user edited must survive untouched.
    await writeText(join(home, '.codex', 'skills', 'brainstorming', 'SKILL.md'), '---\nname: my own version\n---\n')

    const result = await installPackage({
      packageId: 'ai-switch.core',
      skillIds: ['brainstorming', 'writing-plans'],
    })
    assert.deepEqual(result, {
      package_id: 'ai-switch.core',
      installed_skill_ids: ['writing-plans'],
      skipped_skill_ids: ['brainstorming'],
    })
    assert.match(await readFile(join(home, '.codex', 'skills', 'brainstorming', 'SKILL.md'), 'utf8'), /my own version/)
    assert.match(await readFile(join(home, '.codex', 'skills', 'writing-plans', 'SKILL.md'), 'utf8'), /bundled-writing-plans/)

    // Uninstall removes only what a listing reported, and skips what was never there.
    const removed = await uninstallPackage({
      packageId: 'ai-switch.core',
      skillIds: ['writing-plans', 'using-superpowers'],
    })
    assert.deepEqual(removed, {
      package_id: 'ai-switch.core',
      removed_skill_ids: ['writing-plans'],
      skipped_skill_ids: ['using-superpowers'],
    })
    await assert.rejects(readFile(join(home, '.codex', 'skills', 'writing-plans', 'SKILL.md'), 'utf8'))
  })
})

test('a read-only member is skipped by uninstall rather than failing the pack', async () => {
  await withTempHome(async (home) => {
    await writeText(join(home, '.codex', 'skills', '.system', 'brainstorming', 'SKILL.md'), '---\nname: builtin\n---\n')
    const result = await uninstallPackage({ packageId: 'ai-switch.core', skillIds: ['brainstorming'] })
    assert.deepEqual(result.removed_skill_ids, [])
    assert.deepEqual(result.skipped_skill_ids, ['brainstorming'])
    // Still there.
    assert.match(await readFile(join(home, '.codex', 'skills', '.system', 'brainstorming', 'SKILL.md'), 'utf8'), /builtin/)
  })
})
