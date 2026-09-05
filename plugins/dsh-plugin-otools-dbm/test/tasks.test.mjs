/**
 * The long-running task modules, against a real database.
 *
 * Export, import, backup, restore, sync and the data dictionary are five separate
 * modules that only meet at the task manager, so they are exercised end to end
 * here: write a real file, read it back, and check the rows landed. SQLite makes
 * that possible without a server, and every other engine goes through the same
 * writers.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { inflateRawSync } from 'node:zlib'

import { buildCommands } from '../src/host/routes.js'
import { ConnectionManager } from '../src/host/connections.js'
import { BackupPlanStore, ConnectionStore, PluginStateStore, SyncLogStore } from '../src/host/store.js'
import { TaskManager } from '../src/host/tasks.js'

/**
 * Inflate one entry out of a zip, without a zip library.
 *
 * A .docx is a zip whose parts are deflate-compressed, so asserting on the raw
 * bytes would pass for any zip at all. This walks the local file headers, finds the
 * wanted name and inflates its data — enough for a test, not a general unzip.
 */
function inflateZipEntry(bytes, wanted) {
  let offset = 0
  while (offset < bytes.length - 4) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) {
      break
    }
    const method = bytes.readUInt16LE(offset + 8)
    const compressedSize = bytes.readUInt32LE(offset + 18)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if (name === wanted) {
      const data = bytes.subarray(dataStart, dataStart + compressedSize)
      return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
    }
    offset = dataStart + compressedSize
  }
  throw new Error(`entry ${wanted} not found in the archive`)
}

describe('tasks', () => {
  let dir
  let out
  let commands
  let context
  let sourceId
  let targetId

  /** Wait for a task to reach a terminal state, then return it. */
  const settle = async (taskId) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = context.tasks.get(taskId)
      if (task !== undefined && task.status !== 'Pending' && task.status !== 'Running') {
        return task
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`task ${taskId} never finished`)
  }

  /** Run a task command and assert it completed. */
  const run = async (command, args) => {
    const taskId = await commands[command](args)
    const task = await settle(taskId)
    assert.equal(task.status, 'Completed', `${command} failed: ${task.error_message ?? ''}`)
    return task
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-tasks-'))
    out = join(dir, 'out')
    process.env.DSH_HOME = join(dir, 'dsh-home')

    const store = new ConnectionStore()
    context = {
      store,
      connections: new ConnectionManager({ store }),
      tasks: new TaskManager({ emit: () => {} }),
      state: new PluginStateStore(),
      plans: new BackupPlanStore(),
      syncLogs: new SyncLogStore(),
      emit: () => {},
      ai: {},
    }
    commands = buildCommands(context)

    sourceId = await commands.add_db_connection({
      connection: { name: 'source', db_type: 'sqlite', database: join(dir, 'source.db') },
    })
    targetId = await commands.add_db_connection({
      connection: { name: 'target', db_type: 'sqlite', database: join(dir, 'target.db') },
    })

    await commands.execute_query({
      connectionId: sourceId,
      sql: `CREATE TABLE goods (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL,
        note TEXT
      )`,
    })
    // A value with a comma, a quote, a newline and a NULL — the four things every
    // export format gets wrong in a different way.
    await commands.execute_query({
      connectionId: sourceId,
      sql: `INSERT INTO goods (id, name, price, note) VALUES
        (1, 'bolt, hex', 1.5, 'says "hi"'),
        (2, 'nut', 0.25, NULL),
        (3, 'multi
line', 9.99, ' padded ')`,
    })
  })

  after(async () => {
    context?.tasks?.disposeAll()
    await context?.connections?.closeAll()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.DSH_HOME
  })

  it('exports CSV that survives a comma, a quote and a newline', async () => {
    const task = await run('export_table_data', {
      params: { connectionId: sourceId, tableName: 'goods', format: 'csv', exportPath: out },
    })
    const csv = await readFile(task.result_path, 'utf8')
    assert.match(csv, /^﻿/, 'Excel needs the BOM to read UTF-8')
    assert.match(csv, /"bolt, hex"/)
    assert.match(csv, /"says ""hi"""/)
    assert.match(csv, /"multi\r?\nline"/)
    assert.match(csv, /" padded "/)
    // A NULL is an empty field, not the text "null".
    assert.doesNotMatch(csv, /,null(,|\r|\n)/i)
  })

  it('exports JSON that parses back', async () => {
    const task = await run('export_table_data', {
      params: { connectionId: sourceId, tableName: 'goods', format: 'json', exportPath: out },
    })
    const rows = JSON.parse(await readFile(task.result_path, 'utf8'))
    assert.equal(rows.length, 3)
    assert.equal(rows[0].name, 'bolt, hex')
    assert.equal(rows[1].note, null)
  })

  it('exports SQL that replays into an empty database', async () => {
    const task = await run('export_table_data', {
      params: { connectionId: sourceId, tableName: 'goods', format: 'sql', exportPath: out },
    })
    const sql = await readFile(task.result_path, 'utf8')
    assert.match(sql, /INSERT INTO/i)
    assert.match(sql, /'says "hi"'/, 'a double quote inside a SQL literal needs no escaping')
    assert.match(sql, /'bolt, hex'/)

    // Replay it for real, into a table with the same shape.
    await commands.execute_query({
      connectionId: targetId,
      sql: 'CREATE TABLE goods (id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)',
    })
    await run('import_table_from_sql_as_task', {
      connectionId: targetId,
      tableName: 'goods',
      filePath: task.result_path,
    })
    const page = await commands.get_table_data({ connectionId: targetId, tableName: 'goods', limit: 100 })
    assert.equal(page.row_count, 3)
    const names = page.rows.map((row) => row[1]).sort()
    assert.deepEqual(names, ['bolt, hex', 'multi\nline', 'nut'])
  })

  it('exports an Excel workbook that is a real xlsx', async () => {
    const task = await run('export_table_data', {
      params: { connectionId: sourceId, tableName: 'goods', format: 'excel', exportPath: out },
    })
    const info = await stat(task.result_path)
    assert.ok(info.size > 1000, 'an xlsx is a zip, so it is never tiny')
    const head = await readFile(task.result_path)
    // Every xlsx is a ZIP: local file header magic `PK\x03\x04`.
    assert.equal(head.subarray(0, 4).toString('hex'), '504b0304')
  })

  it('refuses CSV for a multi-table export', async () => {
    await assert.rejects(
      () =>
        commands.export_multiple_tables({
          params: { connectionId: sourceId, tableNames: ['goods'], format: 'csv', exportPath: out },
        }),
      /CSV|csv/,
    )
  })

  it('imports a CSV through the column mapping', async () => {
    const exported = await run('export_table_data', {
      params: { connectionId: sourceId, tableName: 'goods', format: 'csv', exportPath: out },
    })
    await commands.execute_query({
      connectionId: targetId,
      sql: 'CREATE TABLE imported (id INTEGER, label TEXT, price REAL)',
    })

    const headers = await commands.get_file_headers({ filePath: exported.result_path, format: 'csv' })
    assert.deepEqual(headers, ['id', 'name', 'price', 'note'])

    await run('import_table_from_data_file_as_task', {
      connectionId: targetId,
      tableName: 'imported',
      filePath: exported.result_path,
      // Destination column → source header. `note` is deliberately dropped.
      columnMappings: { id: 'id', label: 'name', price: 'price' },
    })

    const page = await commands.get_table_data({ connectionId: targetId, tableName: 'imported', limit: 100 })
    assert.equal(page.row_count, 3)
    const byId = new Map(page.rows.map((row) => [Number(row[0]), row]))
    assert.equal(byId.get(1)[1], 'bolt, hex')
    assert.equal(Number(byId.get(2)[2]), 0.25)
  })

  it('backs the database up and restores it into another file', async () => {
    const backup = await run('backup_database_as_task', {
      connectionId: sourceId,
      databaseName: 'main',
      tableNames: ['goods'],
      exportPath: out,
    })
    const dump = await readFile(backup.result_path, 'utf8')
    assert.match(dump, /CREATE TABLE/i, 'a backup carries the schema, not only the rows')
    assert.match(dump, /INSERT INTO/i)

    const restoreId = await commands.add_db_connection({
      connection: { name: 'restored', db_type: 'sqlite', database: join(dir, 'restored.db') },
    })
    await run('restore_database_from_backup_as_task', {
      connectionId: restoreId,
      databaseName: 'main',
      filePath: backup.result_path,
    })
    const tables = await commands.get_tables({ connectionId: restoreId })
    assert.ok(tables.includes('goods'))
    const page = await commands.get_table_data({ connectionId: restoreId, tableName: 'goods', limit: 100 })
    assert.equal(page.row_count, 3)
  })

  it('previews a sync without writing anything', async () => {
    const emptyId = await commands.add_db_connection({
      connection: { name: 'empty', db_type: 'sqlite', database: join(dir, 'empty.db') },
    })
    // Make the file exist and be reachable.
    await commands.execute_query({ connectionId: emptyId, sql: 'CREATE TABLE placeholder (a INTEGER)' })

    const preview = await commands.dbm_preview_sync_plan({
      sourceConnectionId: sourceId,
      sourceDatabaseName: 'main',
      targetConnectionId: emptyId,
      targetDatabaseName: 'main',
      syncStructure: true,
      syncData: false,
    })

    assert.ok(preview.tableCount >= 1)
    assert.ok(preview.createdTableCount >= 1, 'goods is missing in the target, so it would be created')
    assert.ok(Array.isArray(preview.sqlStatements) && preview.sqlStatements.length > 0)
    assert.match(preview.sqlStatements.join('\n'), /CREATE TABLE/i)
    assert.equal(typeof preview.planToken, 'string')
    assert.match(preview.message, /处理表/)

    // Nothing was written: the target still has only its placeholder.
    const tables = await commands.get_tables({ connectionId: emptyId })
    assert.deepEqual(tables, ['placeholder'])

    // The token is stable for the same request, which is what the run path checks.
    const again = await commands.dbm_preview_sync_plan({
      sourceConnectionId: sourceId,
      sourceDatabaseName: 'main',
      targetConnectionId: emptyId,
      targetDatabaseName: 'main',
      syncStructure: true,
      syncData: false,
    })
    assert.equal(again.planToken, preview.planToken)
  })

  it('refuses a sync whose plan token is stale', async () => {
    await assert.rejects(
      () =>
        commands.dbm_sync_databases_as_task({
          sourceConnectionId: sourceId,
          sourceDatabaseName: 'main',
          targetConnectionId: targetId,
          targetDatabaseName: 'main',
          syncStructure: true,
          syncData: false,
          planToken: 'not-the-token',
        }),
      /重新预览|已变化/,
    )
  })

  it('writes a data dictionary that is a real docx', async () => {
    const path = join(out, 'dictionary.docx')
    const written = await commands.export_data_dictionary_docx({
      connectionId: sourceId,
      outputPath: path,
      databaseName: 'main',
    })
    assert.match(written, /\.docx$/)
    const bytes = await readFile(written)
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304', 'a docx is a zip')
    // Entry names are stored uncompressed, so this is readable without a zip library.
    assert.ok(bytes.includes(Buffer.from('word/document.xml')), 'a docx must have a document part')

    // The part itself is deflated, so it has to be inflated before the table name
    // can be looked for — searching the raw file would silently pass on any zip.
    const xml = inflateZipEntry(bytes, 'word/document.xml')
    assert.ok(xml.includes('goods'), 'the dictionary must mention the table')
    assert.ok(xml.includes('数据库数据字典'), 'and carry its own title')
    assert.ok(xml.includes('字段名'), 'and the column table header')
  })

  it('reports backup storage on this platform', async () => {
    const info = await commands.dbm_get_backup_storage_info({ path: out })
    assert.equal(typeof info.path, 'string')
    assert.ok(info.totalBytes > 0, 'statfs must answer on every platform, including Windows')
    assert.ok(info.availableBytes >= 0)
    assert.ok(info.usagePercent >= 0 && info.usagePercent <= 100)
    assert.ok(info.estimatedBackupCount >= 0)
  })

  it('normalizes and persists backup plans', async () => {
    const saved = await commands.dbm_save_backup_plans({
      plans: [
        {
          id: 'p1',
          name: '  nightly  ',
          connectionId: sourceId,
          databaseName: 'main',
          exportPath: out,
          scheduleType: 'daily',
          dailyTime: '99:99',
          intervalHours: 0,
          enabled: true,
          retentionDays: -5,
        },
        { id: '', connectionId: '', name: 'dropped' },
      ],
    })
    assert.equal(saved.length, 1, 'a plan with no id or no connection is dropped')
    assert.equal(saved[0].name, 'nightly')
    assert.equal(saved[0].dailyTime, '02:00', 'an impossible time falls back')
    assert.ok(saved[0].intervalHours >= 1)
    assert.equal(saved[0].retentionDays, 0)

    const reread = await commands.dbm_get_backup_plans()
    assert.equal(reread.length, 1)
    assert.equal(reread[0].id, 'p1')
  })

  it('cancels a task instead of pretending to', async () => {
    const taskId = await commands.export_table_data({
      params: { connectionId: sourceId, tableName: 'goods', format: 'sql', exportPath: out },
    })
    context.tasks.cancel(taskId)
    const task = context.tasks.get(taskId)
    assert.equal(task.status, 'Cancelled')
    // And it stays cancelled: a late worker must not overwrite the verdict.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(context.tasks.get(taskId).status, 'Cancelled')
  })
})
