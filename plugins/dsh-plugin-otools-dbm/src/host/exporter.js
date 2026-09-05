/**
 * Export writers: one table, many tables, and a whole-database SQL backup.
 *
 * Each command registers a task and hands its id back immediately; the writing
 * happens inside the task worker, which is given the `AbortSignal` that makes cancel
 * mean something and returns the absolute path it wrote — the path the panel shows
 * behind 另存为.
 *
 * Four things differ from the reference on purpose:
 *
 * 1. **Pages, not rows.** The reference read the source table with a chunk size of
 *    ONE: one round trip and one progress event per row, so a 100k-row export was
 *    100k queries. Every reader here takes 1000 rows at a time and appends to a
 *    write stream, so host memory stays flat whatever the table's size.
 * 2. **File names carry milliseconds.** The reference stamped a name with seconds
 *    only, so two exports of one table inside the same second produced the same
 *    name and the second silently overwrote the first.
 * 3. **Multi-table CSV/JSON is refused, not fudged.** One CSV file cannot hold five
 *    tables; SQL and Excel can, and those are the two the multi-table dialog offers.
 * 4. **A failed or cancelled export leaves no file behind.** Half a CSV opens
 *    without complaint and is short by however many rows never arrived.
 *
 * @module dsh-plugin-otools-dbm/host/exporter
 */
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import { DbmError, ERR, optionalIdentifier, requireIdentifier, requireText } from '../shared/protocol.js'

import { unsupported } from './engines/contract.js'
import { requireAbsolute } from './fs.js'
import { pluginHomePath } from './sdk.js'
import { throwIfAborted } from './tasks.js'

/** Rows per read. */
const PAGE_SIZE = 1000

/** Rows per multi-row INSERT in a .sql file. */
const INSERT_BATCH = 200

/** format → file extension; `excel` is the one whose name is not its suffix. */
const EXTENSIONS = { csv: '.csv', json: '.json', sql: '.sql', excel: '.xlsx' }

/** RFC 4180 says CRLF, and Excel means it. */
const CRLF = '\r\n'

/** UTF-8 byte order mark (U+FEFF), the first thing every CSV gets. */
const BOM = String.fromCharCode(0xfeff)

/** Characters no Windows file name may contain. */
const ILLEGAL_IN_FILENAME = '\\/:*?"<>|'

/** Characters Excel rejects in a worksheet name. */
const ILLEGAL_IN_SHEET_NAME = ':\\/?*[]'

// -------------------------------------------------------------- panel commands
/** `export_table_data`: one table, any of the four formats. Returns the task id. */
export async function exportTableData(context, params) {
  const request = buildRequest(params, { multiple: false })
  return context.tasks.start(
    {
      name: `导出表 ${request.tables[0]} 数据为 ${request.format.toUpperCase()} 格式`,
      type: 'Export',
      metadata: metadataOf(request),
    },
    (control) => runExport(context, request, control),
  )
}

/** `export_multiple_tables`: many tables into one SQL or Excel file. */
export async function exportMultipleTables(context, params) {
  const request = buildRequest(params, { multiple: true })
  return context.tasks.start(
    {
      name: `导出数据库 ${request.database ?? '当前数据库'} 的 ${request.tables.length} 张表为 ${request.format.toUpperCase()} 格式`,
      type: 'Export',
      metadata: metadataOf(request),
    },
    (control) => runExport(context, request, control),
  )
}

/**
 * `backup_database_as_task`: one .sql file with CREATE TABLE + INSERTs per table.
 *
 * An empty `tableNames` means "every table in the database", resolved inside the
 * worker — a scheduled plan says which database to back up, not which tables.
 */
export async function backupDatabase(context, options) {
  const request = buildRequest({ ...(options ?? {}), format: 'sql', useFilters: false }, {
    multiple: true,
    backup: true,
  })
  return context.tasks.start(
    {
      name: `备份数据库 ${request.database ?? '当前数据库'} 为 SQL 文件`,
      type: 'Backup',
      metadata: metadataOf(request),
    },
    (control) => runExport(context, request, control),
  )
}

// ------------------------------------------------------------------- the request
/**
 * Validate whatever the panel sent into one internal request.
 *
 * Everything that can be refused is refused HERE, before the task exists, so the
 * user gets a red toast on the button they pressed instead of a Failed row in the
 * task list.
 */
function buildRequest(params, { multiple, backup = false }) {
  const payload = params ?? {}
  const format = requireFormat(payload.format)
  const request = {
    connectionId: requireText(payload.connectionId, '连接 ID'),
    database: optionalIdentifier(payload.databaseName, '数据库名'),
    schema: optionalIdentifier(payload.schemaName, 'Schema 名'),
    format,
    multiple,
    withDdl: backup,
    // The path AS REQUESTED, not the file finally written: replaying a retry with
    // the resolved name would overwrite the first run's file, which is the very
    // thing the millisecond stamp exists to prevent.
    exportPath: String(payload.exportPath ?? '').trim(),
    filters: undefined,
    tables: [],
  }

  if (!multiple) {
    request.tables = [requireIdentifier(payload.tableName, '表名')]
    // A filter map is `{"<field>_<OPERATOR>": value}` over ONE table's columns, so
    // it only makes sense for the single-table export; `engine.tableData` already
    // knows how to read it.
    if (payload.useFilters !== false) {
      request.filters = filterMap(payload.filters)
    }
    return request
  }

  request.tables = (Array.isArray(payload.tableNames) ? payload.tableNames : []).map((name) =>
    requireIdentifier(name, '表名'),
  )
  if (request.tables.length === 0 && !backup) {
    throw new DbmError(ERR.invalidInput, '请至少选择一张要导出的表')
  }
  if (format === 'csv' || format === 'json') {
    const label = format.toUpperCase()
    throw new DbmError(
      ERR.invalidInput,
      `多表导出不支持 ${label} 格式：一个 ${label} 文件只能容纳一张表的数据。请选择 SQL 或 Excel 格式。`,
    )
  }
  return request
}

/** One of the four formats the panel offers, lowercased. */
function requireFormat(value) {
  const format = String(value ?? '').trim().toLowerCase()
  if (EXTENSIONS[format] === undefined) {
    throw new DbmError(
      ERR.invalidInput,
      `不支持的导出格式: ${String(value ?? '')}，可选 csv / json / sql / excel`,
    )
  }
  return format
}

/** The panel's filter map, or undefined when there is nothing to filter by. */
function filterMap(filters) {
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    return undefined
  }
  return Object.keys(filters).length === 0 ? undefined : filters
}

/** Task metadata: a string map `retry_task` can replay the request from. */
function metadataOf(request) {
  return {
    connection_id: request.connectionId,
    database_name: request.database ?? '',
    schema_name: request.schema ?? '',
    // JSON, not a comma-joined list: a table name may itself contain a comma, and a
    // retry that split on one would ask for two tables that do not exist.
    ...(request.multiple
      ? { table_names: JSON.stringify(request.tables) }
      : { table_name: request.tables[0] }),
    format: request.format,
    export_path: request.exportPath,
  }
}

// ------------------------------------------------------------------- the worker
/** Resolve the file, open the connection, write, and report the path. */
async function runExport(context, request, { signal, progress }) {
  const file = await resolveOutputFile(request)
  progress(5)

  return context.connections.with(request.connectionId, async (engine) => {
    throwIfAborted(signal)
    const tables = await resolveTables(engine, request)
    const control = { file, signal, progress }
    try {
      if (request.format === 'excel') {
        await writeExcel(engine, request, tables, control)
      } else if (request.format === 'sql') {
        await writeSql(engine, request, tables, control)
      } else if (request.format === 'json') {
        await writeJson(engine, request, tables[0], control)
      } else {
        await writeCsv(engine, request, tables[0], control)
      }
    } catch (error) {
      // Half a file is worse than no file: it opens without complaint and is short
      // by however many rows never arrived.
      await unlink(file).catch(() => {})
      throw error
    }
    progress(95)
    return file
  })
}

/** The tables to write; an empty backup list means every table in the database. */
async function resolveTables(engine, request) {
  if (request.tables.length > 0) {
    return request.tables
  }
  const found = await engine.listTables(request.database, request.schema)
  const tables = (Array.isArray(found) ? found : []).map((name) => String(name))
  if (tables.length === 0) {
    throw new DbmError(ERR.notFound, `数据库 ${request.database ?? ''} 里没有可备份的表`)
  }
  return tables
}

// --------------------------------------------------------------------- the path
/**
 * Where the file goes.
 *
 * `exportPath` is one of three things: empty (use the plugin's own dated export
 * directory), a directory (write into it) or a file path (use it verbatim). A path
 * that does not exist yet counts as a directory when it has no extension — which is
 * exactly what the panel sends, since it pre-fills a dated directory nobody has
 * created yet.
 */
async function resolveOutputFile(request) {
  const now = new Date()
  const name = `${fileSegment(baseNameOf(request))}_${stampOf(now)}${EXTENSIONS[request.format]}`

  if (request.exportPath.length === 0) {
    const directory = requireAbsolute(
      pluginHomePath('export', dayOf(now), request.format),
      '导出目录',
    )
    await mkdir(directory, { recursive: true })
    return join(directory, name)
  }

  const target = requireAbsolute(request.exportPath, '导出路径')
  if ((await isDirectory(target)) || extname(target).length === 0) {
    await mkdir(target, { recursive: true })
    return join(target, name)
  }
  await mkdir(dirname(target), { recursive: true })
  return target
}

/** What the file is called before the timestamp. */
function baseNameOf(request) {
  if (request.withDdl) {
    return `${request.database ?? 'database'}_backup`
  }
  if (request.tables.length === 1) {
    return request.tables[0]
  }
  return `${request.database ?? 'database'}_${request.tables.length}_tables`
}

const pad = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD`, the dated folder under the default export directory. */
function dayOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * `YYYYMMDD_HHmmss_SSS`.
 *
 * The milliseconds are not decoration. The reference stamped seconds only, so two
 * exports of the same table inside one second built the same file name and the
 * second run silently replaced the first run's data.
 */
function stampOf(date) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}_${time}_${String(date.getMilliseconds()).padStart(3, '0')}`
}

/** A file-name segment every platform accepts — a table name may hold anything. */
function fileSegment(name) {
  const cleaned = Array.from(String(name ?? ''))
    // Control characters and the characters Windows forbids outright; `char < ' '`
    // is the whole control range without spelling any of it out.
    .map((char) => (char < ' ' || ILLEGAL_IN_FILENAME.includes(char) ? '_' : char))
    .join('')
    .trim()
    .slice(0, 80)
    // Windows silently drops a trailing dot or space, so a file written as `a.` is
    // then not the file anyone can find.
    .replace(/[\s.]+$/, '')
  return cleaned.length === 0 ? 'export' : cleaned
}

/** Whether the path is an existing directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// -------------------------------------------------------------------- the pager
/**
 * Read one table page by page, handing each page to `onPage`.
 *
 * `onPage` is called once with an empty page for an empty table, so a writer can
 * still emit its header row. `onProgress` gets a 0..1 fraction of THIS table, which
 * the caller maps into the task's own band — a five-table export moves the same bar.
 *
 * The total comes from `row_count`, which every engine reports as the total matching
 * rows rather than the page length. When an engine cannot count (a view without
 * statistics, a permission gap) the bar simply does not move, which beats inventing
 * a percentage.
 */
async function streamTable(engine, target, { signal, onPage, onProgress }) {
  let offset = 0
  let done = 0
  let total = 0
  let columns = []

  for (;;) {
    throwIfAborted(signal)
    const page = await engine.tableData({ ...target, limit: PAGE_SIZE, offset })
    const rows = Array.isArray(page?.rows) ? page.rows : []
    const first = offset === 0
    if (first) {
      columns = (Array.isArray(page?.columns) ? page.columns : []).map((name) => String(name))
      const counted = Number(page?.row_count)
      total = Number.isFinite(counted) && counted > 0 ? counted : 0
    }

    await onPage({ columns, rows, first })
    if (rows.length === 0) {
      break
    }
    done += rows.length
    offset += rows.length
    if (typeof onProgress === 'function' && total > 0) {
      onProgress(Math.min(1, done / total))
    }
    if (rows.length < PAGE_SIZE) {
      break
    }
  }
  return done
}

/** Map a per-table 0..1 fraction into the task's 10..90 band. */
function bandProgress(progress, index, count) {
  const tables = Math.max(1, count)
  return (fraction) => progress(10 + 80 * Math.min(1, (index + fraction) / tables))
}

/** The `{database, schema, table, filters}` one reader needs. */
function targetOf(request, table) {
  return { database: request.database, schema: request.schema, table, filters: request.filters }
}

// --------------------------------------------------------------------- the sink
/** A file the text writers append to, with backpressure and errors handled once. */
class Sink {
  constructor(file) {
    this.stream = createWriteStream(file, { encoding: 'utf8' })
    this.failure = null
    this.done = false
    // Without a listener a stream error is an unhandled 'error' event, which takes
    // the whole dsh process down instead of failing one export.
    this.stream.on('error', (error) => {
      this.failure = error
    })
  }

  /** Append text. */
  async write(text) {
    if (this.failure !== null) {
      throw this.failure
    }
    // `write` returning false means the kernel buffer is full; awaiting 'drain' is
    // what keeps a 2 GB export from becoming 2 GB of resident memory.
    if (!this.stream.write(text)) {
      await once(this.stream, 'drain')
    }
  }

  /** Flush and close. Idempotent, and never hangs on an already-failed stream. */
  async close() {
    if (this.done) {
      return
    }
    this.done = true
    await new Promise((settle) => {
      // Either signal settles it: an errored stream may never call end()'s callback,
      // and 'close' fires whichever way the stream ended.
      this.stream.once('close', settle)
      this.stream.end(settle)
    })
    if (this.failure !== null) {
      throw this.failure
    }
  }
}

// ------------------------------------------------------------------------- CSV
/** RFC 4180 CSV, one table. */
async function writeCsv(engine, request, table, { file, signal, progress }) {
  const sink = new Sink(file)
  try {
    // The BOM is not decoration: Excel on Windows decodes a BOM-less UTF-8 CSV with
    // the system code page, so every Chinese header and value arrives as mojibake.
    await sink.write(BOM)
    await streamTable(engine, targetOf(request, table), {
      signal,
      onProgress: bandProgress(progress, 0, 1),
      onPage: async ({ columns, rows, first }) => {
        if (first) {
          await sink.write(`${columns.map(csvField).join(',')}${CRLF}`)
        }
        if (rows.length > 0) {
          await sink.write(`${rows.map((row) => row.map(csvField).join(',')).join(CRLF)}${CRLF}`)
        }
      },
    })
  } finally {
    await sink.close()
  }
}

/**
 * One CSV field.
 *
 * Quoted when it holds a quote, a comma, a line break or an edge space — an edge
 * space survives no other way, since a reader is entitled to trim. NULL is an EMPTY
 * UNQUOTED field and the empty string is `""`, which is the only way an importer can
 * still tell the two apart.
 */
function csvField(value) {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value)
  if (text.length === 0) {
    return '""'
  }
  const quoted = /["\r\n,]/.test(text) || text.startsWith(' ') || text.endsWith(' ')
  return quoted ? `"${text.replace(/"/g, '""')}"` : text
}

// ------------------------------------------------------------------------ JSON
/** A real JSON array of objects, written as the pages arrive. */
async function writeJson(engine, request, table, { file, signal, progress }) {
  const sink = new Sink(file)
  let written = 0
  try {
    // `[`, one object per row, `]` — incrementally, because building the array in
    // memory first would mean holding a million rows before writing byte one.
    await sink.write('[\n')
    await streamTable(engine, targetOf(request, table), {
      signal,
      onProgress: bandProgress(progress, 0, 1),
      onPage: async ({ columns, rows }) => {
        if (rows.length === 0) {
          return
        }
        const chunk = rows.map((row) => JSON.stringify(rowObject(columns, row))).join(',\n')
        await sink.write(written === 0 ? chunk : `,\n${chunk}`)
        written += rows.length
      },
    })
    await sink.write('\n]\n')
  } finally {
    await sink.close()
  }
}

/** One row as `{column: value}`; every cell is already JSON-safe. */
function rowObject(columns, row) {
  const record = {}
  columns.forEach((name, index) => {
    const value = row[index]
    record[name] = value === undefined ? null : value
  })
  return record
}

// ------------------------------------------------------------------------- SQL
/** INSERTs for every table, preceded by CREATE TABLE when this is a backup. */
async function writeSql(engine, request, tables, { file, signal, progress }) {
  const dialect = requireDialect(engine)
  const sink = new Sink(file)
  try {
    for (const [index, table] of tables.entries()) {
      throwIfAborted(signal)
      await sink.write(sqlHeader(engine, table))

      if (request.withDdl) {
        const ddl = String(await engine.createTableStatement(request.database, table, request.schema)).trim()
        // MySQL's SHOW CREATE TABLE hands the statement back without a terminator
        // and the composed path with one; normalize to exactly one so the file
        // replays whichever engine produced it.
        await sink.write(`${ddl.replace(/;\s*$/, '')};\n\n`)
      }

      const qualified = dialect.qualify({ database: request.database, schema: request.schema, table })
      await streamTable(engine, targetOf(request, table), {
        signal,
        onProgress: bandProgress(progress, index, tables.length),
        onPage: async ({ columns, rows }) => {
          if (rows.length === 0 || columns.length === 0) {
            return
          }
          const names = columns.map((name) => dialect.quote(name)).join(', ')
          // Up to 200 rows per statement. Replaying 200 single-row INSERTs costs 200
          // parses, 200 round trips and — under autocommit — 200 commits; one
          // multi-row INSERT costs one of each, which is minutes instead of hours on
          // a large table. 200 also keeps the statement well under any engine's
          // max_allowed_packet.
          for (let start = 0; start < rows.length; start += INSERT_BATCH) {
            const tuples = rows
              .slice(start, start + INSERT_BATCH)
              .map((row) => `(${row.map((value) => sqlLiteral(dialect, value)).join(', ')})`)
            await sink.write(`INSERT INTO ${qualified} (${names}) VALUES\n${tuples.join(',\n')};\n`)
          }
        },
      })
      await sink.write('\n')
    }
  } finally {
    await sink.close()
  }
}

/** The comment block above one table's statements. */
function sqlHeader(engine, table) {
  return [
    `-- 表 ${table} 数据导出`,
    `-- 数据库引擎: ${engine.dbType}`,
    // UTC, spelled out: a backup file travels between machines, and a bare local
    // timestamp with no zone is unreadable once it gets there.
    `-- 导出时间: ${new Date().toISOString()} (UTC)`,
    '',
    '',
  ].join('\n')
}

/** The dialect a .sql export needs, or a refusal naming the engine. */
function requireDialect(engine) {
  const dialect = engine?.dialect
  if (dialect === undefined || dialect === null || typeof dialect.literal !== 'function') {
    unsupported(engine?.dbType ?? '该连接', '导出为 SQL 格式')
  }
  return dialect
}

/**
 * One value inside a VALUES tuple.
 *
 * Strings go through the engine's OWN `literal()`, so MySQL's backslash escaping and
 * Postgres's doubled quotes each happen where they belong instead of in a shared
 * "escape it somehow" helper here.
 */
function sqlLiteral(dialect, value) {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    // Infinity and NaN have no portable SQL spelling, so they go in as text rather
    // than as a literal no engine will parse.
    return Number.isFinite(value) ? String(value) : dialect.literal(String(value))
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0'
  }
  return dialect.literal(String(value))
}

// ----------------------------------------------------------------------- Excel
/** One .xlsx with a worksheet per table, written straight into the zip. */
async function writeExcel(engine, request, tables, { file, signal, progress }) {
  // Imported on demand: exceljs is the heaviest dependency this host has and an
  // export is rare, so the plugin's own start-up should not pay for it.
  const ExcelJS = await import('exceljs').then((module) => module?.default ?? module)
  // The STREAMING writer. `new ExcelJS.Workbook()` keeps every row in memory until
  // `xlsx.writeFile`, so one big table is an out-of-memory crash instead of a file.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: file,
    useStyles: false,
    useSharedStrings: false,
  })
  const taken = new Set()

  try {
    for (const [index, table] of tables.entries()) {
      throwIfAborted(signal)
      const sheet = workbook.addWorksheet(sheetName(table, taken))
      await streamTable(engine, targetOf(request, table), {
        signal,
        onProgress: bandProgress(progress, index, tables.length),
        onPage: async ({ columns, rows, first }) => {
          if (first) {
            sheet.addRow(columns).commit()
          }
          for (const row of rows) {
            // One commit per row is what streaming means: the row goes into the
            // sheet's zip entry and is dropped, never accumulated.
            sheet.addRow(row.map(excelValue)).commit()
          }
        },
      })
      sheet.commit()
    }
    await workbook.commit()
  } catch (error) {
    // Drop the zip's file handle by hand: on Windows the caller's unlink fails with
    // EBUSY while the writer still holds the file open.
    try {
      workbook.stream?.destroy?.()
    } catch {
      /* there is nothing better to try */
    }
    throw error
  }
}

/**
 * A worksheet name Excel will actually open.
 *
 * exceljs's streaming writer does not validate names, so an over-long one or one
 * carrying `[` produces a file Excel refuses with "unreadable content" rather than
 * an error here. 31 characters is the real limit, and two sheets may not share a
 * name — which truncation can cause — so a collision gets a numbered suffix.
 */
function sheetName(table, taken) {
  const cleaned = Array.from(String(table ?? ''))
    .filter((char) => char >= ' ' && !ILLEGAL_IN_SHEET_NAME.includes(char))
    .join('')
    .trim()
    .slice(0, 31)
  const base = cleaned.length === 0 ? 'Sheet' : cleaned
  let name = base
  let serial = 2
  while (taken.has(name.toLowerCase())) {
    const suffix = `_${serial}`
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`
    serial += 1
  }
  taken.add(name.toLowerCase())
  return name
}

/** exceljs writes strings, numbers, booleans and null; the rest becomes text. */
function excelValue(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  return typeof value === 'string' || typeof value === 'boolean' ? value : String(value)
}

