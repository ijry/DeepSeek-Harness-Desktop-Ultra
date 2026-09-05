/**
 * The sync centre: making a target database's structure and data match a source's.
 *
 * Two things here are deliberately not the reference's:
 *
 * 1. **Data is merged over pages, never loaded.** The reference read both tables
 *    into arrays and diffed them, so a ten-million-row table meant a
 *    ten-million-row array on the host — the panel died long before the sync did.
 *    Here both sides are paged in primary-key order and walked in lockstep like two
 *    sorted files, so a table of any size costs two pages of memory. Where that
 *    ordering cannot be trusted — an engine that refuses ORDER BY, or one that
 *    accepts it and answers in some other order — the merge degrades to a capped
 *    in-memory compare that SAYS SO in `skippedReason` rather than quietly syncing
 *    a slice of the table.
 * 2. **Preview and execution are one code path.** `dryRun` decides whether a
 *    statement is executed or only collected; two paths would drift, and a preview
 *    that no longer matches what runs is worse than no preview at all.
 *
 * Nothing here drops anything. A column, a table or an index the target has and the
 * source does not is REPORTED, never removed: a sync button that can drop a column
 * is one stale source away from losing a production column, and no number in a
 * summary line buys that back.
 *
 * @module dsh-plugin-otools-dbm/host/sync
 */
import { createHash, randomUUID } from 'node:crypto'

import { DbmError, ERR } from '../shared/protocol.js'

import { inTransaction } from './crud.js'
import { messageOf, throwIfAborted } from './tasks.js'

/** Rows per page on each side of the merge. */
const PAGE_SIZE = 1000

/** Rows the unordered fallback may hold per side before it stops comparing. */
const MAX_UNORDERED_ROWS = 200_000

/** Statements the preview list carries; the rest are counted, not kept. */
const MAX_PREVIEW_SQL = 500

/** Data statements per transaction while applying one table. */
const WRITE_BATCH = 200

/**
 * Engine pairs a sync is offered for.
 *
 * The same engine on both ends, plus the two pairs that are one engine wearing two
 * names: MariaDB speaks MySQL's dialect and KingbaseES speaks PostgreSQL's. Anything
 * else needs DDL translation — MySQL's `int unsigned auto_increment` becomes Oracle's
 * NUMBER plus a sequence plus a trigger, its `datetime` becomes a TIMESTAMP with a
 * different idea of the zero date — and that is a migration product, not a sync
 * button. Doing it silently is how a "sync" quietly changes a column's type.
 */
const ENGINE_FAMILIES = {
  mysql: 'mysql',
  mariadb: 'mysql',
  postgresql: 'postgres',
  kingbasees: 'postgres',
}

/** The family two engines must share before they may be synced. */
function familyOf(dbType) {
  const normalized = String(dbType ?? '').toLowerCase().trim()
  return ENGINE_FAMILIES[normalized] ?? normalized
}

/** Internal signal: the pages stopped arriving in key order, so the merge stops. */
class OrderMismatch extends Error {}

// ------------------------------------------------------------------- public API
/** Everything a real sync would do, with nothing written. */
export async function previewSyncPlan(context, params) {
  const plan = await preparePlan(context, params)
  const state = newState(plan, { dryRun: true })
  await runSync(state)
  return { ...summarize(state), planToken: plan.planToken }
}

/** Start the sync in the background; the task id comes back at once. */
export async function syncDatabasesAsTask(context, params) {
  const plan = await preparePlan(context, params)
  const supplied = String(params?.planToken ?? '').trim()
  // No token means the user never previewed, which is their call. A token that no
  // longer matches means they previewed a different plan — most often a table
  // appeared or vanished in the source between the two clicks — so the SQL they
  // read in the preview dialog is not the SQL that would run.
  if (supplied.length > 0 && supplied !== plan.planToken) {
    throw new DbmError(ERR.conflict, '同步配置已变化，请先重新预览后再执行同步')
  }

  return context.tasks.start(
    {
      name: `数据库同步 ${plan.sourceLabel}:${plan.sourceDatabaseName} -> ${plan.targetLabel}:${plan.targetDatabaseName}`,
      type: 'Sync',
      metadata: {
        source_connection_id: plan.sourceConnectionId,
        source_database_name: plan.sourceDatabaseName,
        target_connection_id: plan.targetConnectionId,
        target_database_name: plan.targetDatabaseName,
        sync_structure: plan.syncStructure ? '1' : '0',
        sync_data: plan.syncData ? '1' : '0',
        plan_token: plan.planToken,
      },
    },
    async ({ signal, progress, task }) => {
      const state = newState(plan, { dryRun: false, signal, progress })
      const createdAt = new Date().toISOString()
      try {
        await runSync(state)
      } catch (error) {
        // The log is written either way: a sync that died halfway is exactly the
        // one whose per-table detail the user needs to read.
        await appendLog(context, plan, state, {
          taskId: task.id,
          createdAt,
          status: signal?.aborted === true ? 'Cancelled' : 'Failed',
          message: `${messageOf(error)}（${summaryMessage(state)}）`,
        })
        throw error
      }
      // The task itself completed — it walked every table. The log row is red when
      // any table failed, because that is the row a user scans for trouble.
      await appendLog(context, plan, state, {
        taskId: task.id,
        createdAt,
        status: state.failedTableCount > 0 ? 'Failed' : 'Completed',
      })
      return undefined
    },
  )
}

/** The sync centre's history, newest first. */
export async function getSyncLogs(context) {
  const logs = await context.syncLogs.list()
  return logs.map((entry) => normalizeLog(entry))
}

// ---------------------------------------------------------------------- the plan
/**
 * Validate the six arguments, resolve both engines, and list the source's tables.
 *
 * Everything that can be refused is refused HERE, before a task exists: an error
 * returned from the route becomes a dialog the user reads, where the same error one
 * tick later is a red row they have to go looking for.
 */
async function preparePlan(context, params) {
  const syncStructure = params?.syncStructure === true
  const syncData = params?.syncData === true
  if (!syncStructure && !syncData) {
    throw new DbmError(ERR.invalidInput, '请至少选择结构或数据中的一项')
  }

  const sourceConnectionId = String(params?.sourceConnectionId ?? '')
  const targetConnectionId = String(params?.targetConnectionId ?? '')
  const sourceConnection = await context.store.require(sourceConnectionId)
  const targetConnection = await context.store.require(targetConnectionId)
  const sourceDatabaseName = databaseOf(params?.sourceDatabaseName, sourceConnection)
  const targetDatabaseName = databaseOf(params?.targetDatabaseName, targetConnection)

  // The same connection and the same database is a no-op; the same connection and
  // two different databases is a perfectly ordinary sync (staging → scratch).
  if (sourceConnectionId === targetConnectionId && sourceDatabaseName === targetDatabaseName) {
    throw new DbmError(ERR.invalidInput, '源和目标相同，无需同步')
  }
  if (familyOf(sourceConnection.db_type) !== familyOf(targetConnection.db_type)) {
    throw new DbmError(ERR.unsupported, '跨数据库类型同步暂不支持，请选择同类型（或 MySQL 与 MariaDB）')
  }

  const sourceEngine = await context.connections.engineFor(sourceConnectionId)
  const targetEngine = await context.connections.engineFor(targetConnectionId)
  const tableNames = Array.from(
    new Set((await sourceEngine.listTables(sourceDatabaseName)).map((name) => String(name))),
  ).sort()

  const plan = {
    sourceConnectionId,
    targetConnectionId,
    sourceDatabaseName,
    targetDatabaseName,
    sourceLabel: labelOf(sourceConnection, sourceConnectionId),
    targetLabel: labelOf(targetConnection, targetConnectionId),
    syncStructure,
    syncData,
    sourceEngine,
    targetEngine,
    tableNames,
    planToken: '',
  }
  plan.planToken = planTokenOf(plan)
  return plan
}

/** The database a side runs against: what the panel sent, else the connection's own. */
function databaseOf(value, connection) {
  const named = String(value ?? '').trim()
  return named.length > 0 ? named : String(connection?.database ?? '').trim()
}

/** How a connection is named in a task title. */
function labelOf(connection, fallback) {
  const name = String(connection?.name ?? '').trim()
  return name.length > 0 ? name : fallback
}

/**
 * A fingerprint of "the plan the user previewed".
 *
 * The table list is part of it on purpose: a table created in the source between the
 * preview and the start is a plan nobody has seen, and the SQL copied out of the
 * preview dialog no longer describes what would run.
 */
function planTokenOf(plan) {
  const canonical = JSON.stringify([
    {
      sourceConnectionId: plan.sourceConnectionId,
      sourceDatabaseName: plan.sourceDatabaseName,
      targetConnectionId: plan.targetConnectionId,
      targetDatabaseName: plan.targetDatabaseName,
      syncStructure: plan.syncStructure,
      syncData: plan.syncData,
    },
    plan.tableNames,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

// ----------------------------------------------------------------------- the run
/** The totals one run accumulates, and the two switches every step reads. */
function newState(plan, { dryRun, signal, progress } = {}) {
  return {
    plan,
    dryRun: dryRun === true,
    signal,
    progress: typeof progress === 'function' ? progress : () => {},
    details: [],
    sqlStatements: [],
    sqlCount: 0,
    createdTableCount: 0,
    alteredTableCount: 0,
    failedTableCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
  }
}

/**
 * Walk the source's tables once, structure then data for each.
 *
 * One table's failure costs that table only: its detail row carries the message and
 * the walk goes on, because 39 synced tables plus one named failure is a better
 * answer than an abort on the first permission gap.
 */
async function runSync(state) {
  const { plan } = state
  const targetTables = new Set(
    (await plan.targetEngine.listTables(plan.targetDatabaseName)).map((name) => String(name)),
  )
  const total = Math.max(1, plan.tableNames.length)

  for (let index = 0; index < plan.tableNames.length; index += 1) {
    throwIfAborted(state.signal)
    const tableName = plan.tableNames[index]
    // 1..99: the task manager owns 100, and a bar that reads 100 while the last
    // table is still writing is exactly the reference's own bug.
    state.progress(Math.min(99, Math.max(1, Math.round((index / total) * 100))), `同步 ${tableName}`)

    const detail = newDetail(tableName, plan)
    const startedAt = Date.now()
    try {
      const sourceStruct = await plan.sourceEngine.tableStruct(plan.sourceDatabaseName, tableName)
      let exists = targetTables.has(tableName)
      const targetStruct = exists
        ? await plan.targetEngine.tableStruct(plan.targetDatabaseName, tableName)
        : undefined
      if (plan.syncStructure) {
        exists = await syncTableStructure(state, detail, { tableName, sourceStruct, targetStruct })
      }
      if (plan.syncData) {
        await syncTableData(state, detail, { tableName, sourceStruct, targetStruct, exists })
      }
    } catch (error) {
      // A cancel is not a table failure: it ends the whole run.
      if (state.signal?.aborted === true) {
        throw error
      }
      detail.errorMessage = messageOf(error)
      if (plan.syncStructure && detail.structureStatus === 'unchanged') {
        detail.structureStatus = 'failed'
      }
      if (plan.syncData && detail.dataStatus === 'unchanged') {
        detail.dataStatus = 'failed'
      }
      state.failedTableCount += 1
    }
    detail.elapsedMs = Date.now() - startedAt
    state.details.push(detail)
  }
  return state
}

/** One row of the panel's per-table detail table, before anything has run. */
function newDetail(tableName, plan) {
  return {
    tableName,
    structureStatus: plan.syncStructure ? 'unchanged' : 'skipped',
    dataStatus: plan.syncData ? 'unchanged' : 'skipped',
    structureActions: [],
    insertedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    skippedReason: null,
    errorMessage: null,
    elapsedMs: 0,
    sqlCount: 0,
  }
}

// --------------------------------------------------------------------- structure
/**
 * Bring one table's structure across.
 *
 * @returns whether the target has that table when this returns — or would have it,
 *   in a preview, which is what lets the data step below run either way.
 */
async function syncTableStructure(state, detail, { tableName, sourceStruct, targetStruct }) {
  const { targetEngine, targetDatabaseName } = state.plan
  const dialect = targetEngine.dialect
  const target = { database: targetDatabaseName, schema: undefined, table: tableName }

  if (targetStruct === undefined) {
    await applyDdl(state, detail, dialect.createTable({
      ...target,
      columns: sourceStruct.columns,
      comment: sourceStruct.comment,
    }))
    detail.structureActions.push(`创建目标表 ${tableName}`)
    detail.structureStatus = 'created'
    state.createdTableCount += 1
    // A table created here also gets the source's secondary indexes. Leaving them
    // for "the next sync" means the target runs without them until someone notices.
    await syncIndexes(state, detail, { target, sourceStruct, targetIndexes: [] })
    return true
  }

  const targetColumns = new Map(targetStruct.columns.map((column) => [String(column.name), column]))
  let changed = false

  for (const column of sourceStruct.columns) {
    const current = targetColumns.get(String(column.name))
    if (current === undefined) {
      const added = await tryDdl(state, detail, `新增字段 ${column.name}`, () =>
        dialect.addColumn({ ...target, column }))
      changed = added || changed
      continue
    }
    if (columnDiffers(column, current)) {
      const altered = await tryDdl(state, detail, `更新字段 ${column.name}`, () =>
        dialect.modifyColumn({ ...target, column: { ...column, old_name: column.name } }))
      changed = altered || changed
    }
  }

  const sourceColumns = new Set(sourceStruct.columns.map((column) => String(column.name)))
  for (const column of targetStruct.columns) {
    if (sourceColumns.has(String(column.name))) {
      continue
    }
    // DROP COLUMN is the one difference this never applies. It cannot be undone, the
    // column's data goes with it, and the usual reason a target has an extra column
    // is that the target is AHEAD of the source, not behind it.
    detail.structureActions.push(`目标表多出字段 ${column.name}，未自动删除`)
  }

  const indexChanged = await syncIndexes(state, detail, {
    target,
    sourceStruct,
    targetIndexes: targetStruct.indexes ?? [],
  })
  if (changed || indexChanged) {
    detail.structureStatus = 'altered'
    state.alteredTableCount += 1
  }
  return true
}

/**
 * Build one DDL statement and apply it, tolerating the dialects that cannot.
 *
 * `modifyColumn` genuinely does not exist for SQLite — its ALTER TABLE has no MODIFY,
 * and the documented rebuild is a twelve-step dance nobody should run behind a Sync
 * button. Such a refusal is recorded as an action naming it; failing the whole table
 * instead would also cost that table its data sync.
 *
 * @returns whether a statement was actually produced.
 */
async function tryDdl(state, detail, action, build) {
  let statements
  try {
    statements = build()
  } catch (error) {
    if (error instanceof DbmError && error.code === ERR.unsupported) {
      detail.structureActions.push(`${action} 未执行：${messageOf(error)}`)
      return false
    }
    throw error
  }
  await applyDdl(state, detail, statements)
  detail.structureActions.push(action)
  return true
}

/** Add the indexes the target lacks; report the ones whose definition differs. */
async function syncIndexes(state, detail, { target, sourceStruct, targetIndexes }) {
  const dialect = state.plan.targetEngine.dialect
  const primaryKeys = (sourceStruct.primary_keys ?? []).map((name) => String(name))
  const existing = new Map((targetIndexes ?? []).map((index) => [String(index?.name ?? ''), index]))
  let changed = false

  for (const index of sourceStruct.indexes ?? []) {
    // The primary key travels inside CREATE TABLE, and every engine names its PK
    // index differently ('PRIMARY' on MySQL, '<table>_pkey' on pg), so it is matched
    // by its columns as well as by its name.
    if (columnsOf(index).length === 0 || isPrimaryIndex(index, primaryKeys)) {
      continue
    }
    const current = existing.get(String(index.name))
    if (current === undefined) {
      const created = await tryDdl(state, detail, `新增索引 ${index.name}`, () =>
        dialect.createIndex({
          ...target,
          index: index.name,
          columns: columnsOf(index),
          unique: index.is_unique === true,
        }))
      changed = created || changed
      continue
    }
    if (!sameIndex(index, current)) {
      // Rebuilding means DROP + CREATE: minutes of degraded reads on a large table,
      // and a UNIQUE rebuild fails outright on rows the target already holds. Report
      // it and let a human pick the window.
      detail.structureActions.push(`索引 ${index.name} 定义不同，未自动重建`)
    }
  }
  return changed
}

const columnsOf = (index) =>
  (Array.isArray(index?.columns) ? index.columns : []).map((name) => String(name)).filter((name) => name.length > 0)

function isPrimaryIndex(index, primaryKeys) {
  const name = String(index?.name ?? '').toUpperCase()
  if (name === 'PRIMARY' || name === 'PRIMARY_KEY') {
    return true
  }
  const columns = columnsOf(index)
  return primaryKeys.length > 0
    && columns.length === primaryKeys.length
    && columns.every((column, position) => column === primaryKeys[position])
}

const sameIndex = (left, right) =>
  (left?.is_unique === true) === (right?.is_unique === true)
  && columnsOf(left).join(',') === columnsOf(right).join(',')

/**
 * Whether the target's column has to be altered to match the source's.
 *
 * Only the three properties every engine in a family reports the same way are
 * compared. The integer display width is normalized away because MySQL 8.0.19
 * stopped reporting it: a 5.7 source against an 8.0 target would otherwise call
 * every `int(11)` column different, and each false positive is an ALTER TABLE that
 * rewrites the whole table.
 */
function columnDiffers(source, target) {
  return normalizeType(source?.data_type) !== normalizeType(target?.data_type)
    || (source?.is_nullable !== false) !== (target?.is_nullable !== false)
    || normalizeDefault(source?.default_value) !== normalizeDefault(target?.default_value)
}

function normalizeType(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return text.replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1')
}

function normalizeDefault(value) {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value).trim()
  if (text.length === 0 || text.toLowerCase() === 'null') {
    return ''
  }
  const quoted = /^'(.*)'$/.exec(text)
  // `CURRENT_TIMESTAMP` and `current_timestamp()` are one default written by two
  // server versions.
  return (quoted === null ? text : quoted[1]).toLowerCase().replace(/\(\s*\)$/, '')
}

// -------------------------------------------------------------------------- data
/**
 * Bring one table's rows across, keyed on the SOURCE table's primary key.
 */
async function syncTableData(state, detail, { tableName, sourceStruct, targetStruct, exists }) {
  const keys = (sourceStruct.primary_keys ?? []).map((name) => String(name)).filter((name) => name.length > 0)
  if (keys.length === 0) {
    // Without a key there is no way to say "the same row" twice. Matching on every
    // column instead turns one edited cell into a delete plus an insert, and two
    // identical rows into one.
    detail.dataStatus = 'skipped'
    detail.skippedReason = '源表没有主键，无法按主键对齐数据'
    return
  }
  if (!exists) {
    detail.dataStatus = 'skipped'
    detail.skippedReason = '目标库还没有这张表，请同时勾选结构后再同步'
    return
  }

  const sourceColumns = sourceStruct.columns.map((column) => String(column.name))
  const targetColumns = new Set((targetStruct?.columns ?? []).map((column) => String(column.name)))
  // With structure sync on, every source column is present or was just added; without
  // it, only the columns both sides already have can be written.
  const columns = state.plan.syncStructure || targetStruct === undefined
    ? sourceColumns
    : sourceColumns.filter((name) => targetColumns.has(name))

  if (columns.length === 0) {
    detail.dataStatus = 'skipped'
    detail.skippedReason = '两侧没有同名字段，无法同步数据'
    return
  }
  const missingKey = keys.find((name) => !columns.includes(name))
  if (missingKey !== undefined) {
    detail.dataStatus = 'skipped'
    detail.skippedReason = `目标表缺少主键字段 ${missingKey}，无法按主键对齐数据`
    return
  }

  await mergeTableRows(state, detail, {
    tableName,
    keys,
    columns,
    // A table this run created is empty on the target — really, after the CREATE, and
    // by definition in a preview, where the CREATE never ran and paging it would fail.
    freshTarget: detail.structureStatus === 'created',
  })

  const touched = detail.insertedCount + detail.updatedCount + detail.deletedCount
  if (touched > 0) {
    detail.dataStatus = 'synced'
    return
  }
  detail.dataStatus = detail.skippedReason === null ? 'unchanged' : 'skipped'
}

/**
 * The merge.
 *
 * Both sides are paged in key order and walked in lockstep, so the host holds two
 * pages instead of two tables — that is the whole reason a ten-million-row table is
 * survivable here. The only state carried between rounds is the last key seen, which
 * is also what catches a side that stops coming back in order.
 */
async function mergeTableRows(state, detail, { tableName, keys, columns, freshTarget }) {
  const { plan } = state
  const orderBy = keys.join(', ')
  const source = newCursor(plan.sourceEngine, plan.sourceDatabaseName, tableName, { orderBy, keys })
  const target = freshTarget
    ? undefined
    : newCursor(plan.targetEngine, plan.targetDatabaseName, tableName, { orderBy, keys })
  const writer = newWriter(state, detail, { tableName, keys, columns })

  const ordered = await probeOrdering(target === undefined ? [source] : [source, target])
  if (!ordered) {
    await mergeInMemory(state, detail, { source, target, writer })
    return
  }
  try {
    await mergeStreaming(state, { source, target, writer })
  } catch (error) {
    if (error instanceof OrderMismatch) {
      // Stop rather than guess: the pages are no longer a sorted merge, so every
      // further comparison could invent an insert or a delete. What was applied up to
      // here is counted, and the reason is on the table's detail row.
      detail.skippedReason = '分页顺序与主键顺序不一致（通常是排序规则差异），已停止这张表的数据同步，请改用导出/导入'
      return
    }
    throw error
  }
}

/** One side of the merge: a page, a position in it, and the offset of the next one. */
function newCursor(engine, database, table, { orderBy, keys }) {
  return { engine, database, table, orderBy, keys, columns: [], rows: [], index: 0, offset: 0, done: false, lastKey: undefined }
}

/** Load the next page when the current one is spent. */
async function fillCursor(cursor) {
  if (cursor.index < cursor.rows.length || cursor.done) {
    return
  }
  const page = await cursor.engine.tableData({
    database: cursor.database,
    schema: undefined,
    table: cursor.table,
    limit: PAGE_SIZE,
    offset: cursor.offset,
    orderBy: cursor.orderBy,
  })
  const columns = (Array.isArray(page?.columns) ? page.columns : []).map((name) => String(name))
  const rows = Array.isArray(page?.rows) ? page.rows : []
  if (columns.length > 0) {
    cursor.columns = columns
  }
  cursor.rows = rows.map((row) => decodeRow(cursor.columns, row, cursor.keys))
  cursor.index = 0
  cursor.offset += rows.length
  // A short page is the last page. Asking for one more just to see an empty answer is
  // a whole extra round trip per table.
  cursor.done = rows.length < PAGE_SIZE
}

const currentRow = (cursor) => (cursor === undefined ? undefined : cursor.rows[cursor.index])

/** One row as `{ values, key }`, from either an array row or an object row. */
function decodeRow(columns, row, keys) {
  const values = {}
  if (Array.isArray(row)) {
    columns.forEach((name, index) => {
      values[name] = row[index] === undefined ? null : row[index]
    })
  } else {
    for (const [name, value] of Object.entries(row ?? {})) {
      values[name] = value === undefined ? null : value
    }
  }
  return { values, key: keys.map((name) => (values[name] === undefined ? null : values[name])) }
}

/**
 * Read each side's first page with the key ORDER BY and decide whether a streaming
 * merge is safe.
 *
 * Two ways it is not: the engine throws on the ORDER BY (the SQL engine refuses an
 * order expression it cannot sanitize, and the non-SQL engines have no ordering at
 * all), or it accepts the ORDER BY and hands back rows this file's comparator does not
 * consider sorted — a collation whose order is not the comparator's. Either way the
 * caller falls back to the capped in-memory compare, and the pages already read are
 * reused rather than fetched twice.
 */
async function probeOrdering(cursors) {
  let ordered = true
  for (const cursor of cursors) {
    try {
      await fillCursor(cursor)
    } catch (error) {
      if (cursor.orderBy === undefined) {
        throw error
      }
      cursor.orderBy = undefined
      resetCursor(cursor)
      await fillCursor(cursor)
      ordered = false
      continue
    }
    if (!isSortedPage(cursor.rows)) {
      ordered = false
    }
  }
  return ordered
}

function resetCursor(cursor) {
  cursor.rows = []
  cursor.index = 0
  cursor.offset = 0
  cursor.done = false
  cursor.lastKey = undefined
}

const isSortedPage = (rows) =>
  rows.every((row, index) => index === 0 || compareKeys(rows[index - 1].key, row.key) <= 0)

/** The sorted-merge walk: insert what the target lacks, update what differs, delete the rest. */
async function mergeStreaming(state, { source, target, writer }) {
  for (;;) {
    throwIfAborted(state.signal)
    await advanceCursor(source)
    if (target !== undefined) {
      await advanceCursor(target)
    }
    const left = currentRow(source)
    const right = currentRow(target)
    if (left === undefined && right === undefined) {
      break
    }
    if (right === undefined) {
      await writer.insert(left)
      source.index += 1
      continue
    }
    if (left === undefined) {
      await writer.remove(right)
      target.index += 1
      continue
    }
    const order = compareKeys(left.key, right.key)
    if (order === 0) {
      await writer.update(left, right)
      source.index += 1
      target.index += 1
      continue
    }
    if (order < 0) {
      await writer.insert(left)
      source.index += 1
      continue
    }
    await writer.remove(right)
    target.index += 1
  }
  await writer.flush()
}

/** Fill, then check: a stream that goes backwards ends the merge instead of lying. */
async function advanceCursor(cursor) {
  await fillCursor(cursor)
  const row = currentRow(cursor)
  if (row === undefined) {
    return
  }
  if (cursor.lastKey !== undefined && compareKeys(cursor.lastKey, row.key) > 0) {
    throw new OrderMismatch('分页顺序与主键顺序不一致')
  }
  cursor.lastKey = row.key
}

/**
 * The fallback: up to MAX_UNORDERED_ROWS rows per side, compared in a Map.
 *
 * Paging without an ORDER BY is not stable — the same row can come back on two pages
 * or on none — so this path is deliberately capped and deliberately loud. When the cap
 * is hit the table is only partly compared, `skippedReason` says exactly that, and the
 * DELETE half is dropped: a source row past the cap looks identical to a row the
 * source no longer has, and acting on that guess deletes live data.
 */
async function mergeInMemory(state, detail, { source, target, writer }) {
  const sourceRows = await drainCursor(state, source)
  const targetRows = target === undefined ? { rows: new Map(), capped: false } : await drainCursor(state, target)

  for (const [keyText, row] of sourceRows.rows) {
    throwIfAborted(state.signal)
    const current = targetRows.rows.get(keyText)
    if (current === undefined) {
      await writer.insert(row)
      continue
    }
    await writer.update(row, current)
  }

  if (sourceRows.capped || targetRows.capped) {
    detail.skippedReason = `无法按主键排序分页，本次只比对了前 ${MAX_UNORDERED_ROWS} 行，其余行未同步，目标表多出的行也未删除`
  } else {
    for (const [keyText, row] of targetRows.rows) {
      throwIfAborted(state.signal)
      if (!sourceRows.rows.has(keyText)) {
        await writer.remove(row)
      }
    }
  }
  await writer.flush()
}

/** Drain a cursor into a key → row map, stopping at the cap. */
async function drainCursor(state, cursor) {
  const rows = new Map()
  let capped = false
  for (;;) {
    throwIfAborted(state.signal)
    await fillCursor(cursor)
    const row = currentRow(cursor)
    if (row === undefined) {
      break
    }
    cursor.index += 1
    rows.set(keyTextOf(row.key), row)
    if (rows.size >= MAX_UNORDERED_ROWS) {
      capped = true
      break
    }
  }
  return { rows, capped }
}

/** A composite key as one Map key, separated by control characters no cell can hold. */
const keyTextOf = (key) =>
  key.map((value) => (value === null || value === undefined ? '\u0000' : String(value))).join('\u0001')

/** Compare two composite keys, part by part. */
function compareKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const order = compareValues(left[index], right[index])
    if (order !== 0) {
      return order
    }
  }
  return 0
}

/**
 * Order two key cells the way a database's ORDER BY would.
 *
 * Integers are compared as BigInt rather than as numbers: an id past 2^53 loses
 * digits through `Number`, and two different ids that compare equal would make the
 * merge treat two rows as one. Everything else falls back to text, which is where a
 * collation can disagree with us — hence the ordering checks in `advanceCursor`.
 */
function compareValues(left, right) {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1
  }
  if (right === null || right === undefined) {
    return 1
  }
  const leftText = String(left)
  const rightText = String(right)
  if (isInteger(leftText) && isInteger(rightText)) {
    const leftNumber = BigInt(leftText)
    const rightNumber = BigInt(rightText)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  const leftNumber = Number(leftText)
  const rightNumber = Number(rightText)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftText.trim().length > 0 && rightText.trim().length > 0) {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

const isInteger = (text) => /^-?\d{1,38}$/.test(text)

/**
 * Loose equality for two cells.
 *
 * Both sides arrive already flattened to JSON-safe scalars, but two servers of the
 * same family still disagree on whether a DECIMAL comes back as a string or a number
 * and on whether an empty text column is '' or null — and a strict compare would then
 * rewrite every row of every table. Long integers are exempted from the numeric
 * fallback: `Number('9007199254740993')` equals `Number('9007199254740992')`, and
 * calling those two ids equal would silently skip a real difference.
 */
function sameCell(left, right) {
  if (left === right) {
    return true
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined || right === ''
  }
  if (right === null || right === undefined) {
    return left === ''
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return boolText(left) === boolText(right)
  }
  const leftText = String(left)
  const rightText = String(right)
  if (leftText === rightText) {
    return true
  }
  if (/^-?\d{16,}$/.test(leftText) || /^-?\d{16,}$/.test(rightText)) {
    return false
  }
  const leftNumber = Number(leftText)
  const rightNumber = Number(rightText)
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber
}

/** A boolean-ish cell as '1' / '0', since one driver's true is another's 1. */
function boolText(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return '1'
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return '0'
  }
  return String(value)
}

// ------------------------------------------------------------------ the writer
/**
 * The statement buffer for one table.
 *
 * Data statements go out in batches of WRITE_BATCH inside one transaction, NOT one
 * transaction per table: ten million rows in a single transaction is an undo log no
 * server has room for, and a sync is restartable by design. A preview sends nothing —
 * the batch is only counted and its text kept.
 *
 * Values are inlined as literals rather than bound, so the SQL the preview dialog
 * shows is byte-for-byte the SQL that runs. Two renderings of the same statement is
 * how a preview starts lying about what it will do.
 */
function newWriter(state, detail, { tableName, keys, columns }) {
  const dialect = state.plan.targetEngine.dialect
  const target = { database: state.plan.targetDatabaseName, schema: undefined, table: tableName }
  const pending = []

  const flush = async () => {
    if (pending.length === 0) {
      return
    }
    const batch = pending.splice(0, pending.length)
    if (!state.dryRun) {
      await inTransaction(state.plan.targetEngine, state.plan.targetDatabaseName, async () => {
        for (const entry of batch) {
          await state.plan.targetEngine.run(entry.sql, { database: state.plan.targetDatabaseName })
        }
      })
    }
    // Counted after the batch went through, so a failed transaction is never
    // reported as rows applied.
    recordSql(state, detail, batch.map((entry) => entry.sql))
    for (const entry of batch) {
      detail[entry.kind] += 1
      state[entry.kind] += 1
    }
  }

  const push = async (kind, sql) => {
    pending.push({ kind, sql })
    if (pending.length >= WRITE_BATCH) {
      await flush()
    }
  }

  return {
    async insert(row) {
      await push('insertedCount', insertSql(dialect, target, row.values, columns))
    },
    async update(row, current) {
      // Only the columns that actually changed: a full rewrite of every column is how
      // someone else's concurrent edit gets reverted, and it is slower besides.
      const changed = columns.filter(
        (name) => !keys.includes(name) && !sameCell(row.values[name], current.values[name]),
      )
      if (changed.length === 0) {
        return
      }
      await push('updatedCount', updateSql(dialect, target, { values: row.values, keys, changed }))
    },
    async remove(row) {
      await push('deletedCount', deleteSql(dialect, target, { values: row.values, keys }))
    },
    flush,
  }
}

/** INSERT for one row. */
function insertSql(dialect, target, values, columns) {
  const names = columns.map((name) => dialect.quote(name)).join(', ')
  const cells = columns.map((name) => literalOf(dialect, values[name])).join(', ')
  return `INSERT INTO ${dialect.qualify(target)} (${names}) VALUES (${cells})`
}

/** UPDATE for one row, keyed on every primary-key column. */
function updateSql(dialect, target, { values, keys, changed }) {
  const assignments = changed
    .map((name) => `${dialect.quote(name)} = ${literalOf(dialect, values[name])}`)
    .join(', ')
  return `UPDATE ${dialect.qualify(target)} SET ${assignments} WHERE ${whereKey(dialect, keys, values)}`
}

/** DELETE for one row. */
function deleteSql(dialect, target, { values, keys }) {
  return `DELETE FROM ${dialect.qualify(target)} WHERE ${whereKey(dialect, keys, values)}`
}

/** `pk1 = … AND pk2 = …`, with `IS NULL` for a null part. */
function whereKey(dialect, keys, values) {
  return keys
    .map((name) => {
      const value = values[name]
      return value === null || value === undefined
        ? `${dialect.quote(name)} IS NULL`
        : `${dialect.quote(name)} = ${literalOf(dialect, value)}`
    })
    .join(' AND ')
}

/**
 * One value as SQL text.
 *
 * A BLOB reached this point as the `0x…` text the result normalizer produces, so it is
 * written back as that text and not as bytes. Binary columns therefore belong in an
 * export/import, not in a keyed sync — the panel's own grid has the same limit.
 */
function literalOf(dialect, value) {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0'
  }
  return dialect.literal(typeof value === 'string' ? value : JSON.stringify(value))
}

// ------------------------------------------------------------------- the report
/** Record a DDL batch and, outside a preview, run it. */
async function applyDdl(state, detail, statements) {
  const list = (Array.isArray(statements) ? statements : [statements]).filter(
    (sql) => typeof sql === 'string' && sql.trim().length > 0,
  )
  if (list.length === 0) {
    return
  }
  if (!state.dryRun) {
    await state.plan.targetEngine.runDdl(list, { database: state.plan.targetDatabaseName })
  }
  recordSql(state, detail, list)
}

/** Keep the first MAX_PREVIEW_SQL statements; count every one of them. */
function recordSql(state, detail, statements) {
  for (const sql of statements) {
    state.sqlCount += 1
    detail.sqlCount += 1
    // Semicolons because the panel's "copy SQL" and "export SQL" buttons hand this
    // text straight to a user who will paste it into a client.
    if (state.sqlStatements.length < MAX_PREVIEW_SQL) {
      state.sqlStatements.push(`${sql};`)
    }
  }
}

/** The DbSyncPreviewResult body, shared by the preview and the log entry. */
function summarize(state) {
  return {
    tableCount: state.details.length,
    createdTableCount: state.createdTableCount,
    alteredTableCount: state.alteredTableCount,
    failedTableCount: state.failedTableCount,
    insertedCount: state.insertedCount,
    updatedCount: state.updatedCount,
    deletedCount: state.deletedCount,
    details: state.details,
    sqlStatements: previewSql(state),
    message: summaryMessage(state),
  }
}

/** The kept statements, with a note when there were more of them. */
function previewSql(state) {
  const hidden = state.sqlCount - state.sqlStatements.length
  if (hidden <= 0) {
    return state.sqlStatements
  }
  return [...state.sqlStatements, `-- 另有 ${hidden} 条语句未列出（预览最多显示 ${MAX_PREVIEW_SQL} 条）`]
}

/** The one-line summary, in the reference's wording: only non-zero parts appear. */
function summaryMessage(state) {
  const segments = [`处理表 ${state.details.length} 张`]
  const parts = [
    ['新建表', state.createdTableCount],
    ['变更表', state.alteredTableCount],
    ['新增数据', state.insertedCount],
    ['更新数据', state.updatedCount],
    ['删除数据', state.deletedCount],
    ['失败表', state.failedTableCount],
  ]
  for (const [label, value] of parts) {
    if (value > 0) {
      segments.push(`${label} ${value}`)
    }
  }
  return segments.join('，')
}

/** Write one history entry. A history file we cannot write must not fail the sync. */
async function appendLog(context, plan, state, { taskId, createdAt, status, message }) {
  const summary = summarize(state)
  const entry = {
    id: randomUUID(),
    taskId,
    sourceConnectionId: plan.sourceConnectionId,
    sourceDatabaseName: plan.sourceDatabaseName,
    targetConnectionId: plan.targetConnectionId,
    targetDatabaseName: plan.targetDatabaseName,
    syncStructure: plan.syncStructure,
    syncData: plan.syncData,
    tableCount: summary.tableCount,
    status,
    message: message ?? summary.message,
    createdAt,
    finishedAt: new Date().toISOString(),
    // A sync writes to a database, not to a file; the column stays for the shape the
    // panel shares with exports.
    resultFile: null,
    createdTableCount: summary.createdTableCount,
    alteredTableCount: summary.alteredTableCount,
    failedTableCount: summary.failedTableCount,
    insertedCount: summary.insertedCount,
    updatedCount: summary.updatedCount,
    deletedCount: summary.deletedCount,
    details: summary.details,
  }
  try {
    await context.syncLogs.append(entry)
  } catch (error) {
    console.warn('[dsh-plugin-otools-dbm] 写入同步日志失败:', messageOf(error))
  }
  return entry
}

/**
 * One stored entry, filled out to the shape the panel indexes.
 *
 * The history file outlives this plugin's versions, so an entry written by an older
 * one must not leave the log table rendering `undefined`.
 */
function normalizeLog(entry) {
  const record = entry ?? {}
  return {
    id: String(record.id ?? ''),
    taskId: String(record.taskId ?? ''),
    sourceConnectionId: String(record.sourceConnectionId ?? ''),
    sourceDatabaseName: String(record.sourceDatabaseName ?? ''),
    targetConnectionId: String(record.targetConnectionId ?? ''),
    targetDatabaseName: String(record.targetDatabaseName ?? ''),
    syncStructure: record.syncStructure === true,
    syncData: record.syncData === true,
    tableCount: countOf(record.tableCount),
    status: String(record.status ?? 'Completed'),
    message: record.message === null || record.message === undefined ? '' : String(record.message),
    createdAt: String(record.createdAt ?? ''),
    finishedAt: record.finishedAt === undefined ? null : record.finishedAt,
    resultFile: record.resultFile === undefined ? null : record.resultFile,
    createdTableCount: countOf(record.createdTableCount),
    alteredTableCount: countOf(record.alteredTableCount),
    failedTableCount: countOf(record.failedTableCount),
    insertedCount: countOf(record.insertedCount),
    updatedCount: countOf(record.updatedCount),
    deletedCount: countOf(record.deletedCount),
    details: Array.isArray(record.details) ? record.details : [],
  }
}

function countOf(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
