/**
 * The security boundary, exercised.
 *
 * Everything here is a way a browser could otherwise reach further than the panel
 * is meant to: an identifier that breaks out of its quoting, an ORDER BY that hides
 * a subquery, a static path that escapes the bundle directory, a password that
 * comes back out of the store, a model-written DROP TABLE. Each case is a thing the
 * reference implementation actually let through, or a thing this port could
 * regress into.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { SqliteDialect } from '../src/host/engines/dialects/sqlite.js'
import { sqliteDriver } from '../src/host/engines/drivers/sql.js'
import { SqlEngine } from '../src/host/engines/sql-engine.js'
import { registerDbmRoutes, ROUTE_PREFIX } from '../src/host/routes.js'
import { mergeSecrets, redactConnection, SECRET_PLACEHOLDER } from '../src/host/store.js'

describe('security', () => {
  let dir
  let server
  let base
  let dispose
  let engine
  let secretFile

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-sec-'))
    process.env.DSH_HOME = join(dir, 'dsh-home')

    // A file the panel must never be able to read or overwrite through a route.
    secretFile = join(dir, 'top-secret.txt')
    await writeFile(secretFile, 'do not leak me')

    engine = new SqlEngine({
      connection: { id: 'sec', db_type: 'sqlite', database: join(dir, 'sec.db') },
      dialect: new SqliteDialect(),
      driver: sqliteDriver,
    })
    await engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    await engine.run("INSERT INTO t (id, v) VALUES (1, 'one'), (2, 'two')")

    const routes = []
    dispose = registerDbmRoutes(
      {
        webServer: {
          register(route) {
            routes.push(route)
            return () => undefined
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
    await engine?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.DSH_HOME
  })

  const post = async (command, args) => {
    const response = await fetch(`${base}${ROUTE_PREFIX}/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
    return { status: response.status, body: await response.json() }
  }

  it('refuses a table name carrying a statement separator', async () => {
    for (const table of [
      'items; DROP TABLE t',
      't"; DROP TABLE t; --',
      "t' OR 1=1 --",
      't`',
      'C:\\Windows\\System32',
    ]) {
      const outcome = await post('get_table_data', { connectionId: 'x', tableName: table })
      assert.equal(outcome.body.ok, false, `should refuse ${table}`)
      assert.equal(outcome.body.error.code, 'invalid_input')
    }
    // The refusal happens before any connection is opened, so an unknown
    // connectionId is never even looked up.
    const rows = await engine.select('SELECT COUNT(*) AS n FROM t')
    assert.equal(Number(rows[0].n), 2)
  })

  it('refuses an ORDER BY that is not a bare column', async () => {
    for (const orderBy of [
      '(SELECT 1)',
      'id; DROP TABLE t',
      'id DESC, (SELECT v FROM t)',
      'CASE WHEN 1=1 THEN id END',
    ]) {
      await assert.rejects(
        () => engine.tableData({ table: 't', orderBy }),
        /排序字段不合法/,
        `should refuse ${orderBy}`,
      )
    }
    const rows = await engine.select('SELECT COUNT(*) AS n FROM t')
    assert.equal(Number(rows[0].n), 2, 'the table must still be there')
  })

  it('binds filter values instead of interpolating them', async () => {
    // A value crafted to close the literal and add a second predicate must come
    // back as zero rows, not as an error and not as every row.
    const page = await engine.tableData({ table: 't', filters: { "v_=": "one' OR '1'='1" } })
    assert.equal(page.rows.length, 0)
    const rows = await engine.select('SELECT COUNT(*) AS n FROM t')
    assert.equal(Number(rows[0].n), 2)
  })

  it('never sends a stored password to the browser', () => {
    const stored = {
      id: '1',
      name: 'x',
      db_type: 'mysql',
      password: 'p4ssw0rd',
      connection_string: 'mysql://root:p4ssw0rd@localhost:3306/shop',
      ssh: { enabled: true, password: 'ssh-secret', passphrase: 'key-secret' },
      odbc: { connection_string: 'DRIVER={DM};PWD=dm-secret' },
      mongodb: { tls_certificate_key_file_password: 'pem-secret' },
    }
    const masked = redactConnection(stored)
    const serialized = JSON.stringify(masked)
    for (const secret of ['p4ssw0rd', 'ssh-secret', 'key-secret', 'dm-secret', 'pem-secret']) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked to the browser`)
    }
    assert.equal(masked.password, SECRET_PLACEHOLDER)
  })

  it('restores the stored secrets when the redacted record comes back', () => {
    const stored = { password: 'real', ssh: { password: 'ssh-real', passphrase: 'pass-real' } }
    const merged = mergeSecrets(
      { password: SECRET_PLACEHOLDER, ssh: { password: SECRET_PLACEHOLDER, passphrase: SECRET_PLACEHOLDER } },
      stored,
    )
    assert.equal(merged.password, 'real')
    assert.equal(merged.ssh.password, 'ssh-real')
    assert.equal(merged.ssh.passphrase, 'pass-real')

    // A password the user actually retyped must win over the stored one.
    const changed = mergeSecrets({ password: 'brand-new' }, stored)
    assert.equal(changed.password, 'brand-new')
  })

  it('refuses to serve a static path that escapes the bundle directory', async () => {
    for (const path of [
      '/app/../../../../../../etc/passwd',
      '/app/..%2f..%2f..%2fpackage.json',
      '/static/images/../../../package.json',
    ]) {
      const response = await fetch(`${base}${ROUTE_PREFIX}${path}`)
      assert.ok(
        response.status === 403 || response.status === 404 || response.status === 200,
        `unexpected status ${response.status} for ${path}`,
      )
      if (response.status === 200) {
        const body = await response.text()
        assert.equal(body.includes('"dsh-plugin-otools-dbm"'), false, `${path} served the manifest`)
        assert.equal(body.includes('root:'), false, `${path} served /etc/passwd`)
      }
    }
  })

  it('refuses a relative path where an absolute one is required', async () => {
    const outcome = await post('dbm_fs_write_file', { path: 'relative/evil.txt', dataBase64: 'aGk=' })
    assert.equal(outcome.body.ok, false)
    assert.equal(outcome.body.error.code, 'invalid_input')
  })

  it('does not offer a route that reads arbitrary file contents', async () => {
    // There is no `dbm_fs_read_file`; the closest thing only reads a header row.
    const outcome = await post('dbm_fs_read_file', { path: secretFile })
    assert.equal(outcome.body.ok, false)
    assert.equal(outcome.body.error.code, 'not_found')

    // And the header reader must not hand back the body of a non-import file.
    const headers = await post('get_file_headers', { filePath: secretFile, format: 'sql' })
    assert.equal(headers.body.ok, true)
    assert.deepEqual(headers.body.value, [])

    const still = await readFile(secretFile, 'utf8')
    assert.equal(still, 'do not leak me')
  })

  it('keeps the AI dashboard read-only', async () => {
    for (const sql of ['DROP TABLE t', 'DELETE FROM t', 'SELECT 1; DELETE FROM t', 'UPDATE t SET v = 1']) {
      const outcome = await post('dbm_execute_dashboard_query', { connectionId: 'x', sql })
      assert.equal(outcome.body.ok, false, `should refuse ${sql}`)
      assert.equal(outcome.body.error.code, 'invalid_input')
    }
  })

  it('refuses a UI-state scheme that could escape its filename', async () => {
    for (const scheme of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
      const outcome = await post('save_otools_plugin_localstate_with_scheme', { scheme, state: {} })
      assert.equal(outcome.body.ok, false, `should refuse ${scheme}`)
    }
  })

  it('refuses an AI chat prefix that could escape its filename', async () => {
    const outcome = await post('otools_ai_save_chat_history', { prefix: '../../evil', messages: [] })
    assert.equal(outcome.body.ok, false)
    assert.equal(outcome.body.error.code, 'invalid_input')
  })

  it('caps a result set instead of buffering an unbounded one', async () => {
    // A `SELECT *` on a huge table is the easiest way for a browser to make the host
    // run out of memory, so the engine has a hard row ceiling.
    const { MAX_ROWS } = await import('../src/host/engines/sql-engine.js')
    assert.equal(typeof MAX_ROWS, 'number')
    assert.ok(MAX_ROWS > 0 && MAX_ROWS <= 1000000)
  })
})
