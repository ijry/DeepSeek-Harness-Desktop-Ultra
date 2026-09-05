/**
 * The command table, driven the way the panel drives it.
 *
 * A real `node:http` server, the real route handler, and a real SQLite database in
 * a temp directory — so this proves the wire contract end to end: the envelope, the
 * argument validation, the engine dispatch, the task lifecycle and the SSE stream.
 * The panel's own `invoke()` shim speaks exactly this protocol, so a break here is
 * a break in the UI.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { registerDbmRoutes, ROUTE_PREFIX } from '../src/host/routes.js'

describe('host routes', () => {
  let home
  let dir
  let server
  let base
  let dispose
  let connectionId

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-host-'))
    home = join(dir, 'dsh-home')
    // Every file the plugin writes has to land under DSH_HOME, so the test owns it.
    process.env.DSH_HOME = home

    const routes = []
    dispose = registerDbmRoutes(
      {
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index !== -1) {
                routes.splice(index, 1)
              }
            }
          },
        },
      },
      { ai: {} },
    )

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const exact = routes.find((route) => route.kind === 'exact' && route.path === url.pathname)
      const prefix = routes.find((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
      const route = exact ?? prefix
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    dispose?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.DSH_HOME
  })

  /** One command call, asserting success and returning the value. */
  const call = async (command, args) => {
    const response = await fetch(`${base}${ROUTE_PREFIX}/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
    const payload = await response.json()
    assert.equal(payload.ok, true, `${command} failed: ${JSON.stringify(payload.error)}`)
    return payload.value
  }

  /** One command call that is expected to fail; returns the error envelope. */
  const callFail = async (command, args) => {
    const response = await fetch(`${base}${ROUTE_PREFIX}/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
    const payload = await response.json()
    assert.equal(payload.ok, false, `${command} should have failed`)
    return payload.error
  }

  it('refuses an unknown command instead of hanging', async () => {
    const error = await callFail('no_such_command')
    assert.equal(error.code, 'not_found')
    assert.match(error.message, /未知命令/)
  })

  it('saves a connection and hides its password from the browser', async () => {
    connectionId = await call('add_db_connection', {
      connection: {
        name: '本地 SQLite',
        db_type: 'sqlite',
        host: '',
        port: 0,
        username: '',
        password: 'top-secret',
        database: join(dir, 'shop.db'),
      },
    })
    assert.equal(typeof connectionId, 'string')

    const list = await call('get_db_connections')
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '本地 SQLite')
    assert.notEqual(list[0].password, 'top-secret', 'the real password must never reach the browser')
    assert.equal(list[0].password, '__dsh_dbm_secret__')
  })

  it('refuses a duplicate connection name', async () => {
    const error = await callFail('add_db_connection', {
      connection: { name: '本地 SQLite', db_type: 'sqlite', database: join(dir, 'other.db') },
    })
    assert.equal(error.code, 'conflict')
  })

  it('keeps the stored password when the redacted record is saved back', async () => {
    const list = await call('get_db_connections')
    await call('update_db_connection', { id: connectionId, connection: { ...list[0], name: '本地库' } })
    // The proof that the merge worked is that the connection still opens.
    assert.equal(await call('open_db_connection', { connection: { ...list[0], id: connectionId } }), true)
    assert.equal(await call('is_db_connection_active', { id: connectionId }), true)
  })

  it('runs DDL and lists what it created', async () => {
    await call('execute_query', {
      connectionId,
      sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER)',
    })
    assert.deepEqual(await call('get_tables', { connectionId }), ['items'])
    assert.deepEqual(await call('get_databases', { connectionId }), ['main'])
    assert.deepEqual(await call('get_schemas', { connectionId }), [])
  })

  it('reports a statement error as a failure envelope, not a 200', async () => {
    const error = await callFail('execute_query', { connectionId, sql: 'SELECT * FROM missing_table' })
    assert.match(error.message, /missing_table/)
  })

  it('reads a page of rows with the total count', async () => {
    await call('execute_query', {
      connectionId,
      sql: "INSERT INTO items (id, label, qty) VALUES (1, 'bolt', 10), (2, 'nut', 20), (3, 'washer', 30)",
    })
    const page = await call('get_table_data', { connectionId, tableName: 'items', limit: 2, offset: 0 })
    assert.deepEqual(page.columns, ['id', 'label', 'qty'])
    assert.equal(page.rows.length, 2)
    assert.equal(page.row_count, 3)
  })

  it('rejects an identifier that could break out of quoting', async () => {
    const error = await callFail('get_table_data', { connectionId, tableName: 'items; DROP TABLE items' })
    assert.equal(error.code, 'invalid_input')
    // And the table is still there.
    assert.deepEqual(await call('get_tables', { connectionId }), ['items'])
  })

  it('serves the table structure the designer needs', async () => {
    const struct = await call('get_table_struct', { connectionId, tableName: 'items' })
    assert.equal(struct.table_name, 'items')
    assert.deepEqual(struct.primary_keys, ['id'])
    assert.deepEqual(struct.columns.map((column) => column.name), ['id', 'label', 'qty'])
  })

  it('alters a table through the designer commands', async () => {
    await call('add_column', {
      connectionId,
      tableName: 'items',
      column: { name: 'note', data_type: 'TEXT', is_nullable: true },
    })
    const struct = await call('get_table_struct', { connectionId, tableName: 'items' })
    assert.ok(struct.columns.some((column) => column.name === 'note'))

    await call('create_index', {
      connectionId,
      tableName: 'items',
      indexName: 'idx_items_label',
      columns: ['label'],
      isUnique: false,
    })
    const withIndex = await call('get_table_struct', { connectionId, tableName: 'items' })
    assert.ok(withIndex.indexes.some((index) => index.name === 'idx_items_label'))

    await call('drop_index', { connectionId, tableName: 'items', indexName: 'idx_items_label' })
  })

  it('refuses to modify a column on SQLite instead of rebuilding the table', async () => {
    const error = await callFail('modify_column', {
      connectionId,
      tableName: 'items',
      column: { name: 'qty', data_type: 'TEXT', is_nullable: true },
    })
    assert.equal(error.code, 'unsupported')
    assert.match(error.message, /SQLite/)
  })

  it('saves grid edits and reports what it did', async () => {
    const outcome = await call('save_table_data', {
      connectionId,
      databaseName: 'main',
      tableName: 'items',
      changes: {
        added: [{ id: 4, label: 'screw', qty: 40 }],
        modified: [{ original: { id: 1, label: 'bolt', qty: 10 }, current: { id: 1, label: 'BOLT', qty: 11 } }],
        deleted: [{ id: 3, label: 'washer', qty: 30 }],
      },
    })
    assert.deepEqual(outcome, { inserted: 1, updated: 1, deleted: 1 })
    const rows = await call('get_table_data', { connectionId, tableName: 'items', limit: 100 })
    assert.equal(rows.row_count, 3)
  })

  it('answers the workbench with one result per statement', async () => {
    const result = await call('execute_query_workbench', {
      connectionId,
      sql: 'SELECT 1 AS a; SELECT * FROM nope; SELECT 2 AS b;',
    })
    assert.equal(result.has_errors, true)
    assert.equal(result.statements.length, 3, 'the workbench keeps going past a failure')
    assert.equal(result.statements[1].success, false)
    assert.equal(result.statements[2].success, true)
  })

  it('guards the AI dashboard query', async () => {
    const error = await callFail('dbm_execute_dashboard_query', { connectionId, sql: 'DROP TABLE items' })
    assert.equal(error.code, 'invalid_input')
    const ok_ = await call('dbm_execute_dashboard_query', { connectionId, sql: 'SELECT COUNT(*) AS n FROM items' })
    assert.equal(ok_.rows[0][0], 3)
  })

  it('reports the AI as unavailable rather than crashing when DSH has no model', async () => {
    const error = await callFail('otools_ai_generate_text', { request: { userPrompt: 'hi' } })
    assert.equal(error.code, 'ai_unavailable')
    assert.match(error.message, /模型/)
  })

  it('round-trips the panel UI state', async () => {
    await call('save_otools_plugin_localstate_with_scheme', {
      plugin: 'dbm',
      scheme: 'ui',
      state: { sidebarWidth: 260 },
    })
    const state = await call('get_otools_plugin_localstate_with_scheme', { plugin: 'dbm', scheme: 'ui' })
    assert.deepEqual(state, { sidebarWidth: 260 })
  })

  it('runs an export as a task and streams its progress', async () => {
    const events = []
    const stream = await fetch(`${base}${ROUTE_PREFIX}/events`)
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    const pump = (async () => {
      let buffer = ''
      while (events.filter((event) => event.name === 'task-updated').length < 1) {
        const chunk = await reader.read()
        if (chunk.done) {
          break
        }
        buffer += decoder.decode(chunk.value, { stream: true })
        for (const frame of buffer.split('\n\n')) {
          const match = /^data: (.*)$/m.exec(frame)
          if (match !== null) {
            try {
              events.push(JSON.parse(match[1]))
            } catch {
              /* partial frame */
            }
          }
        }
        buffer = ''
      }
    })()

    const taskId = await call('export_table_data', {
      params: {
        connectionId,
        databaseName: 'main',
        tableName: 'items',
        format: 'csv',
        useFilters: false,
        filters: {},
        remarks: '',
        exportPath: join(dir, 'out'),
      },
    })
    assert.equal(typeof taskId, 'string')

    await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 5000))])
    await reader.cancel().catch(() => undefined)

    assert.ok(events.some((event) => event.name === 'hello'), 'the stream opens with a hello frame')
    assert.ok(events.some((event) => event.name === 'task-updated'), 'task progress must reach the panel')

    // The task itself must reach a terminal state with a file behind it.
    let task
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const tasks = await call('get_all_tasks')
      task = tasks.find((row) => row.id === taskId)
      if (task !== undefined && task.status !== 'Pending' && task.status !== 'Running') {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(task.status, 'Completed', task?.error_message ?? '')
    assert.match(String(task.result_path), /\.csv$/)

    const { readFile } = await import('node:fs/promises')
    const csv = await readFile(task.result_path, 'utf8')
    assert.match(csv, /label/)
    assert.match(csv, /BOLT/)
  })

  it('clears finished tasks', async () => {
    const removed = await call('clear_completed_tasks')
    assert.ok(removed >= 1)
    assert.deepEqual(await call('get_all_tasks'), [])
  })

  it('lists a host directory for the path picker', async () => {
    const listing = await call('dbm_fs_list_dir', { path: dir })
    assert.equal(listing.path, dir)
    assert.ok(Array.isArray(listing.entries))
    assert.ok(listing.entries.some((entry) => entry.name === 'shop.db'))
  })

  it('serves the panel bundle, or says plainly that it is not built', async () => {
    const response = await fetch(`${base}${ROUTE_PREFIX}/app/`)
    // `npm run build` produces lib/webview; `npm run check` does not, so both
    // outcomes are legitimate here — what matters is that neither is a crash.
    assert.ok(response.status === 200 || response.status === 404, `unexpected status ${response.status}`)
    if (response.status !== 200) {
      return
    }

    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    const html = await response.text()
    assert.match(html, /<div id="app">/)

    // The asset URLs must be RELATIVE, or the browser resolves them against the
    // shell's origin root instead of `/dsh-plugin-otools-dbm/app/` and gets a 404.
    const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)
    assert.notEqual(asset, null, 'the entry script must be a relative URL')

    const script = await fetch(`${base}${ROUTE_PREFIX}/app/${asset[1]}`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
    // Hashed file names can be cached hard; the HTML must not be.
    assert.match(script.headers.get('cache-control') ?? '', /immutable/)
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/)

    // A deep link inside the app falls back to index.html rather than 404ing.
    const deep = await fetch(`${base}${ROUTE_PREFIX}/app/some/deep/route`)
    assert.equal(deep.status, 200)
  })

  it('closes the connection and drops it', async () => {
    assert.equal(await call('close_db_connection', { id: connectionId }), true)
    assert.equal(await call('is_db_connection_active', { id: connectionId }), false)
    await call('delete_db_connection', { id: connectionId })
    assert.deepEqual(await call('get_db_connections'), [])
  })
})
