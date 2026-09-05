/**
 * End-to-end test against a real database.
 *
 * SQLite is the one engine that needs no server: `node:sqlite` is built into Node
 * 22.5+, so this exercises the whole stack for real — driver, dialect, SqlEngine,
 * introspection mapping, the DDL builders, the grid's save path and the filter
 * translation — with no mocks anywhere. Every other engine shares that stack, so a
 * regression here is a regression everywhere.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { SqliteDialect } from '../src/host/engines/dialects/sqlite.js'
import { sqliteDriver } from '../src/host/engines/drivers/sql.js'
import { SqlEngine } from '../src/host/engines/sql-engine.js'
import { saveTableData } from '../src/host/crud.js'
import { createTable, tableStruct } from '../src/host/schema.js'

describe('sqlite engine', () => {
  let dir
  let engine

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-sqlite-'))
    engine = new SqlEngine({
      connection: { id: 'test', db_type: 'sqlite', database: join(dir, 'test.db') },
      dialect: new SqliteDialect(),
      driver: sqliteDriver,
    })
  })

  after(async () => {
    await engine?.close()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('opens and answers a ping', async () => {
    assert.equal(await engine.ping(), true)
  })

  it('creates a table through the designer path', async () => {
    await createTable(engine, {
      table: 'people',
      comment: '',
      columns: [
        { name: 'id', data_type: 'INTEGER', is_nullable: false, is_primary_key: true },
        { name: 'name', data_type: 'TEXT', character_maximum_length: 64, is_nullable: false },
        { name: 'age', data_type: 'INTEGER', is_nullable: true },
        { name: 'note', data_type: 'TEXT', is_nullable: true, default_value: "'none'" },
      ],
    })
    const tables = await engine.listTables()
    assert.deepEqual(tables, ['people'])
  })

  it('rejects an identifier that could break out of quoting', async () => {
    await assert.rejects(
      () => createTable(engine, { table: 'bad"name', columns: [{ name: 'a', data_type: 'TEXT' }] }),
      /不允许的字符/,
    )
  })

  it('reports the structure it just created', async () => {
    const struct = await tableStruct(engine, { connectionId: 'test', table: 'people', force: true })
    assert.equal(struct.table_name, 'people')
    assert.deepEqual(struct.columns.map((column) => column.name), ['id', 'name', 'age', 'note'])
    assert.deepEqual(struct.primary_keys, ['id'])
    const age = struct.columns.find((column) => column.name === 'age')
    assert.equal(age.is_nullable, true)
    const name = struct.columns.find((column) => column.name === 'name')
    assert.equal(name.is_nullable, false)
  })

  it('runs a multi-statement script and reports each statement', async () => {
    const result = await engine.executeScript(`
      INSERT INTO people (id, name, age) VALUES (1, 'Ada', 36);
      INSERT INTO people (id, name, age) VALUES (2, 'Grace; not a split', 45);
      SELECT COUNT(*) AS total FROM people;
    `)
    assert.equal(result.has_errors, false)
    assert.equal(result.statements.length, 3)
    assert.deepEqual(result.columns, ['total'])
    assert.deepEqual(result.rows, [[2]])
  })

  it('keeps a semicolon inside a string literal in one statement', async () => {
    const rows = await engine.select("SELECT name FROM people WHERE id = 2")
    assert.equal(rows[0].name, 'Grace; not a split')
  })

  it('reports a failing statement instead of throwing, in workbench mode', async () => {
    const result = await engine.executeScript('SELECT 1 AS a; SELECT * FROM nope;', { stopOnError: false })
    assert.equal(result.has_errors, true)
    assert.equal(result.failed_statement_index, 1)
    assert.match(result.batch_error_message, /第 2 条 SQL 执行失败/)
    assert.equal(result.statements[0].success, true)
    assert.equal(result.statements[1].success, false)
  })

  it('pages a table and reports the TOTAL row count, not the page length', async () => {
    const page = await engine.tableData({ table: 'people', limit: 1, offset: 0 })
    assert.equal(page.rows.length, 1)
    assert.equal(page.row_count, 2)
  })

  it('translates the panel filter map into a WHERE clause', async () => {
    const equals = await engine.tableData({ table: 'people', filters: { 'name_=': 'Ada' } })
    assert.equal(equals.rows.length, 1)

    const like = await engine.tableData({ table: 'people', filters: { 'name_LIKE': 'Grace' } })
    assert.equal(like.rows.length, 1)

    const notNull = await engine.tableData({ table: 'people', filters: { 'age_IS_NOT_NULL': '' } })
    assert.equal(notNull.rows.length, 2)

    // `note` was created with DEFAULT 'none', so the two inserts that omitted it
    // are not null — which is also the proof that the designer's DEFAULT landed.
    const isNull = await engine.tableData({ table: 'people', filters: { 'note_IS_NULL': '' } })
    assert.equal(isNull.rows.length, 0)
    const defaulted = await engine.tableData({ table: 'people', filters: { 'note_=': 'none' } })
    assert.equal(defaulted.rows.length, 2)

    // A field name containing an underscore must not be mistaken for an operator.
    await engine.run('ALTER TABLE people ADD COLUMN home_city TEXT')
    await engine.run("UPDATE people SET home_city = 'Bath' WHERE id = 1")
    const underscored = await engine.tableData({ table: 'people', filters: { 'home_city_=': 'Bath' } })
    assert.equal(underscored.rows.length, 1)
  })

  it('refuses an ORDER BY that is not a plain column', async () => {
    await assert.rejects(
      () => engine.tableData({ table: 'people', orderBy: '(SELECT 1)' }),
      /排序字段不合法/,
    )
    const sorted = await engine.tableData({ table: 'people', orderBy: 'age DESC' })
    assert.equal(sorted.rows[0][0], 2)
  })

  it('saves grid edits keyed on the primary key', async () => {
    const struct = await tableStruct(engine, { connectionId: 'test', table: 'people', force: true })
    assert.deepEqual(struct.primary_keys, ['id'])

    const outcome = await saveTableData(engine, {
      table: 'people',
      changes: {
        added: [{ id: 3, name: 'Edsger', age: 72 }],
        modified: [{ original: { id: 1, name: 'Ada', age: 36 }, current: { id: 1, name: 'Ada L.', age: 36 } }],
        deleted: [{ id: 2, name: 'Grace; not a split' }],
      },
    })
    assert.deepEqual(outcome, { inserted: 1, updated: 1, deleted: 1 })

    const rows = await engine.select('SELECT id, name FROM people ORDER BY id')
    assert.deepEqual(rows, [{ id: 1, name: 'Ada L.' }, { id: 3, name: 'Edsger' }])
  })

  it('validate_only writes nothing', async () => {
    const before_ = await engine.select('SELECT COUNT(*) AS n FROM people')
    const outcome = await saveTableData(engine, {
      table: 'people',
      changes: { added: [{ id: 99, name: 'ghost' }], modified: [], deleted: [], validate_only: true },
    })
    assert.equal(outcome.inserted, 0)
    const after_ = await engine.select('SELECT COUNT(*) AS n FROM people')
    assert.deepEqual(after_, before_)
  })

  it('rolls a failed save back whole', async () => {
    await assert.rejects(() =>
      saveTableData(engine, {
        table: 'people',
        changes: {
          added: [{ id: 4, name: 'ok' }, { id: 1, name: 'duplicate key' }],
          modified: [],
          deleted: [],
        },
      }),
    )
    const rows = await engine.select('SELECT id FROM people WHERE id = 4')
    assert.deepEqual(rows, [], 'the first insert must not survive the second one failing')
  })

  it('refuses to edit a table with no primary key', async () => {
    await engine.run('CREATE TABLE keyless (a TEXT, b TEXT)')
    await engine.run("INSERT INTO keyless VALUES ('x', 'y')")
    await assert.rejects(
      () =>
        saveTableData(engine, {
          table: 'keyless',
          changes: { added: [], modified: [], deleted: [{ a: 'x', b: 'y' }] },
        }),
      /没有主键/,
    )
  })

  it('reads back the CREATE TABLE statement', async () => {
    const ddl = await engine.createTableStatement(undefined, 'people')
    assert.match(ddl, /CREATE TABLE/i)
    assert.match(ddl, /people/)
  })

  it('lists indexes it created', async () => {
    await engine.run('CREATE UNIQUE INDEX idx_people_name ON people (name)')
    const struct = await tableStruct(engine, { connectionId: 'test', table: 'people', force: true })
    const index = struct.indexes.find((row) => row.name === 'idx_people_name')
    assert.notEqual(index, undefined)
    assert.deepEqual(index.columns, ['name'])
    assert.equal(index.is_unique, true)
  })

  it('normalizes values the grid cannot render', async () => {
    await engine.run('CREATE TABLE odd (a BLOB, b REAL, c TEXT)')
    await engine.run("INSERT INTO odd VALUES (x'00ff', 1.5, NULL)")
    const result = await engine.run('SELECT a, b, c FROM odd')
    assert.equal(result.rows[0][0], '0x00ff')
    assert.equal(result.rows[0][1], 1.5)
    assert.equal(result.rows[0][2], null)
  })
})
