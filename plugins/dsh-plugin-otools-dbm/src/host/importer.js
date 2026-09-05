/**
 * Imports: replaying a .sql script, and loading a CSV/Excel/JSON file into a table.
 *
 * Two things here are deliberately not the reference's:
 *
 * 1. **A .sql file is streamed, never read whole.** A dump is routinely hundreds of
 *    megabytes; `readFile` on one is an out-of-memory crash that takes the whole
 *    dsh process with it. Statements are cut out of a rolling buffer instead, by
 *    `sql/split.js` — the same splitter the workbench uses, because a second,
 *    dumber one would disagree with it about where a statement ends.
 * 2. **Rows go in 500 at a time, one INSERT per batch.** The reference sent one
 *    statement per row, which against a remote server is one round trip per row:
 *    an hour where this takes a minute.
 *
 * Everything here is long-running, so everything here is a task — the panel gets a
 * progress bar and a cancel button that actually stops the work. Each entry point
 * returns the task id and nothing else.
 *
 * @module dsh-plugin-otools-dbm/host/importer
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { DbmError, ERR, optionalIdentifier, optionalText, requireIdentifier } from '../shared/protocol.js'

import { inTransaction } from './crud.js'
import { requireAbsolute } from './fs.js'
import { invalidateSchemaCache, tableStruct } from './schema.js'
import { leadingKeyword, previewOf, splitStatements } from './sql/split.js'
import { messageOf, throwIfAborted } from './tasks.js'

/** Beyond this a file is a mistake, not an import. */
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024

/** JSON has to be parsed whole, so its ceiling is much lower than a CSV's. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

/** How much file to pull per read. Big enough that a dump is few chunks. */
const READ_CHUNK_BYTES = 1024 * 1024

/** A single statement (or header row) larger than this is not SQL/CSV at all. */
const MAX_PENDING_CHARS = 256 * 1024 * 1024

/** Rows per INSERT. */
const BATCH_ROWS = 500

/** Bind slots one statement may carry: MySQL stops at 65535, SQL Server at 2100. */
const MAX_BINDS = { mysql: 60_000, mariadb: 60_000, sqlserver: 2_000 }
const DEFAULT_MAX_BINDS = 60_000

/** Engines whose DDL commits implicitly, so a rollback cannot undo the script. */
const IMPLICIT_COMMIT_ENGINES = new Set(['mysql', 'mariadb'])
const IMPLICIT_COMMIT_KEYWORDS = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME'])

// ---------------------------------------------------------------- entry points
/** `import_database_from_sql_as_task`: replay a .sql file into one database. */
export async function importDatabaseFromSql(context, { connectionId, databaseName, filePath }) {
  const database = optionalIdentifier(databaseName, '数据库名')
  const file = await requireImportFile(filePath)
  return startSqlReplay(context, {
    connectionId,
    database,
    file,
    name: `从 SQL 文件导入数据库 ${database ?? ''}`,
    type: 'Import',
  })
}

/**
 * `import_table_from_sql_as_task`: the same replay, started from a table node.
 *
 * The table name reaches the task's name and nothing else. A .sql file names its
 * own targets in every statement, so there is nothing here to point them at a
 * different table with — the reference ignored the argument for the same reason,
 * and rewriting every INSERT's target silently would be worse than ignoring it.
 */
export async function importTableFromSql(context, { connectionId, databaseName, tableName, schemaName, filePath }) {
  const database = optionalIdentifier(databaseName, '数据库名')
  const schema = optionalIdentifier(schemaName, 'Schema 名')
  const table = optionalText(tableName) ?? ''
  const file = await requireImportFile(filePath)
  return startSqlReplay(context, {
    connectionId,
    database,
    file,
    name: `导入表 ${table} 数据`,
    type: 'Import',
    metadata: { schema_name: schema ?? '', table_name: table },
  })
}

/** `restore_database_from_backup_as_task`: the same replay, worded as a restore. */
export async function restoreDatabaseFromBackup(context, { connectionId, databaseName, filePath }) {
  const database = optionalIdentifier(databaseName, '数据库名')
  const file = await requireImportFile(filePath)
  return startSqlReplay(context, {
    connectionId,
    database,
    file,
    name: `从备份文件还原数据库 ${database ?? ''} <- ${basename(file.path)}`,
    type: 'Restore',
  })
}

/**
 * `import_table_from_data_file_as_task`: a CSV/TSV, .xlsx or JSON file into one table.
 *
 * `columnMappings` reads backwards from what most people assume: the KEY is the
 * database column and the VALUE is the header in the file, with `null` meaning
 * "leave this column alone". Round the wrong way it produces an import that
 * succeeds with every value in the wrong column, so `buildPlan` is the only place
 * that touches it.
 */
export async function importTableFromDataFile(
  context,
  { connectionId, databaseName, tableName, schemaName, filePath, columnMappings },
) {
  const database = optionalIdentifier(databaseName, '数据库名')
  const schema = optionalIdentifier(schemaName, 'Schema 名')
  const table = requireIdentifier(tableName, '表名')
  const file = await requireImportFile(filePath)
  const format = formatOf(file.path)
  if (format === 'json' && file.size > MAX_JSON_BYTES) {
    throw new DbmError(
      ERR.tooLarge,
      `JSON 文件 ${formatBytes(file.size)} 超过 64 MB：JSON 只能整体解析才能拿到数组，请导出成 CSV 再导入`,
    )
  }

  return context.tasks.start(
    {
      name: `导入表 ${table} 数据`,
      type: 'Import',
      // `retry_task` replays from metadata, and the mapping is part of the job:
      // without it a retry would have to guess which file column feeds which
      // column, and guessing wrong writes real data into the wrong place.
      metadata: {
        connection_id: connectionId,
        database_name: database ?? '',
        schema_name: schema ?? '',
        table_name: table,
        file_path: file.path,
        format,
        column_mappings: JSON.stringify(columnMappings ?? {}),
      },
    },
    async ({ signal, progress }) =>
      context.connections.with(connectionId, async (engine) => {
        if (engine.dialect === undefined || engine.dialect === null) {
          throw new DbmError(ERR.unsupported, `${engine.dbType} 不支持从数据文件导入表`)
        }
        const struct = await tableStruct(engine, { connectionId, database, schema, table })
        const loader = createLoader(engine, {
          target: { database, schema, table },
          struct,
          mappings: columnMappings,
          signal,
        })
        const options = { file, signal, progress }
        // Each batch is one atomic INSERT, but the file as a whole is NOT one
        // transaction: a million-row CSV in a single transaction is an undo log
        // and a lock set nobody wants on a live server. So a failure stops the
        // task with the row range it died on, and the rows before it stay.
        const rows = await PARSERS[format](loader, options)
        progress(95, `共读取 ${rows} 行，写入 ${loader.inserted} 行`)
        // The panel links a task's result_path; for an import the only file in
        // play is the source, so that is what it points at.
        return file.path
      }),
  )
}

// ------------------------------------------------------------------ sql replay
/** Register the replay task the three .sql entry points share. */
async function startSqlReplay(context, { connectionId, database, file, name, type, metadata = {} }) {
  const record = await context.store.require(connectionId)
  const dbType = String(record.db_type ?? '').toLowerCase()

  return context.tasks.start(
    {
      name,
      type,
      metadata: {
        connection_id: connectionId,
        database_name: database ?? '',
        file_path: file.path,
        format: 'sql',
        ...metadata,
      },
    },
    async ({ signal, progress }) =>
      context.connections.with(connectionId, async (engine) => {
        try {
          // One transaction around the whole replay where the engine has them.
          // The reference did NOT do this: a dump that failed on statement 4000
          // left the database half-imported with nothing to roll back to. The
          // honest exception is DDL on MySQL/MariaDB — CREATE/DROP/ALTER commit
          // implicitly, so a script full of DDL (which is exactly what mysqldump
          // writes) still leaves partial state behind when it fails. That cannot
          // be fixed from here; the task note below at least says so out loud.
          await inTransaction(engine, database, () =>
            replayStatements(engine, { dbType, database, file, signal, progress }),
          )
        } finally {
          // The script almost certainly created or dropped something, so every
          // cached structure for this connection is now a guess.
          invalidateSchemaCache(connectionId)
        }
        return file.path
      }),
  )
}

/** Stream the file and run its statements in order, stopping at the first error. */
async function replayStatements(engine, { dbType, database, file, signal, progress }) {
  const stream = createReadStream(file.path, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES })
  let buffer = ''
  let delimiterLine = ''
  let consumed = 0
  let executed = 0
  let warned = false
  let percent = 10

  /** Run one statement, or fail the task naming which one and why. */
  const runStatement = async (sql) => {
    throwIfAborted(signal)
    executed += 1
    if (!warned && IMPLICIT_COMMIT_ENGINES.has(dbType) && IMPLICIT_COMMIT_KEYWORDS.has(leadingKeyword(sql))) {
      warned = true
      progress(percent, '脚本含 DDL：MySQL 会隐式提交，失败时已执行的部分回滚不掉')
    }
    try {
      await engine.run(sql, { database })
    } catch (error) {
      // stopOnError, always: a dump replayed past its first failure is a database
      // nobody can reason about. The preview is what makes the message actionable.
      throw new DbmError(
        ERR.internal,
        `第 ${executed} 条语句失败: ${previewOf(sql, 80)} — ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * Run everything the splitter is sure about; keep the rest for the next chunk.
   *
   * This is the subtle part of streaming a script. A chunk can end anywhere — in
   * the middle of a quoted string, inside a `$$ … $$` body, halfway through a
   * keyword — and the splitter treats end-of-input as a statement end, so the LAST
   * statement it produced mid-stream may be a fragment. Only the statements before
   * it are executed; the raw text from where that last one starts goes back into
   * the buffer for the next chunk to finish. `final` is the end of the stream:
   * nothing more can arrive, so everything runs.
   */
  const drain = async (final) => {
    const text = delimiterLine + buffer
    const statements = splitStatements(text, { dbType })
    const runnable = final ? statements : statements.slice(0, -1)
    for (const statement of runnable) {
      // Not `statement.index`: that counter restarts with every split call, and
      // the user needs the number the statement has in the file.
      await runStatement(statement.sql)
    }
    if (final) {
      buffer = ''
      return
    }
    if (statements.length === 0) {
      return
    }
    const tail = statements[statements.length - 1].sql
    // Each statement's text is a verbatim slice of the input, so the last one can
    // be found again — and slicing from its start keeps the delimiter and any
    // trailing comment after it, which a fresh split has to see again to get the
    // next boundary right.
    const start = text.lastIndexOf(tail)
    // `DELIMITER $$` is state inside one split call, and the line that set it is
    // in the text about to be dropped — a dump's second routine would then be cut
    // apart at the semicolons inside its body. Carry the directive forward.
    const directive = lastDelimiterOf(text.slice(0, start))
    if (directive !== undefined) {
      delimiterLine = `DELIMITER ${directive}\n`
    }
    buffer = text.slice(start)
  }

  let first = true
  for await (const chunk of stream) {
    throwIfAborted(signal)
    consumed += Buffer.byteLength(chunk, 'utf8')
    // A UTF-8 BOM is not SQL: left in place it becomes part of the first
    // statement's leading keyword and the server rejects the whole thing.
    buffer += first ? stripBom(chunk) : chunk
    first = false
    await drain(false)
    if (buffer.length > MAX_PENDING_CHARS) {
      throw new DbmError(
        ERR.tooLarge,
        `单条语句超过 ${formatBytes(MAX_PENDING_CHARS)}，这通常说明选中的不是 SQL 脚本`,
      )
    }
    // Bytes consumed, not statements run: one INSERT in a dump can be a megabyte
    // and the next forty bytes, so a statement count makes the bar lurch.
    percent = percentOf(consumed / file.size)
    progress(percent)
  }
  await drain(true)
  return executed
}

/** The last `DELIMITER x` directive in a stretch of script, or undefined. */
function lastDelimiterOf(text) {
  const pattern = /^[ \t]*delimiter[ \t]+(\S+)[ \t\r]*$/gim
  let found
  let match = pattern.exec(text)
  while (match !== null) {
    found = match[1]
    match = pattern.exec(text)
  }
  return found
}

// --------------------------------------------------------------- row batching
/**
 * The sink the three parsers feed: rows in, batched INSERTs out.
 *
 * `begin(headers)` once the file's header names are known, then `push(values)` per
 * row with values keyed by source header, then `flush()`.
 */
function createLoader(engine, { target, struct, mappings, signal }) {
  let plan = []
  let batchRows = BATCH_ROWS
  let rows = []
  let inserted = 0

  const flush = async () => {
    if (rows.length === 0) {
      return
    }
    throwIfAborted(signal)
    const from = inserted + 1
    const to = inserted + rows.length
    const statement = batchInsert(engine, target, plan, rows)
    try {
      await engine.run(statement.sql, { database: target.database, values: statement.values })
    } catch (error) {
      throw new DbmError(ERR.internal, `第 ${from}-${to} 行写入失败: ${messageOf(error)}`, { cause: error })
    }
    inserted = to
    rows = []
  }

  return {
    get inserted() {
      return inserted
    },
    begin(headers) {
      plan = buildPlan({ struct, mappings, headers })
      batchRows = batchSizeFor(engine.dbType, plan.length)
    },
    async push(values) {
      rows.push(plan.map((item) => coerce(values[item.header], item.kind)))
      if (rows.length >= batchRows) {
        await flush()
      }
    },
    flush,
  }
}

/**
 * Which destination columns get written, and from which source column.
 *
 * A destination column whose source header is not in the file is left out of the
 * INSERT entirely, so the database's own DEFAULT applies. Writing NULL into it
 * instead would quietly override the default the user set up.
 */
function buildPlan({ struct, mappings, headers }) {
  const columns = new Map((struct?.columns ?? []).map((column) => [column.name, column]))
  const available = new Set(headers.map((header) => String(header)))
  const mapped = Object.entries(mappings ?? {}).filter(
    ([, header]) => header !== null && header !== undefined && String(header).length > 0,
  )
  // No mapping at all is what a `retry_task` with trimmed metadata hands us; the
  // only other honest guess is "same name in, same name out".
  const chosen =
    mapped.length > 0
      ? mapped
      : Array.from(columns.keys())
          .filter((name) => available.has(name))
          .map((name) => [name, name])

  const plan = []
  for (const [column, header] of chosen) {
    const schema = columns.get(column)
    if (schema === undefined || !available.has(String(header))) {
      continue
    }
    plan.push({ column, header: String(header), kind: columnKind(schema.data_type) })
  }
  if (plan.length === 0) {
    throw new DbmError(ERR.invalidInput, '没有可导入的字段：字段映射是空的，或者文件里找不到映射到的列')
  }
  return plan
}

/**
 * One INSERT for a whole batch.
 *
 * `INSERT … VALUES (…),(…),…` instead of the reference's statement-per-row. Against
 * a remote server the round trip dominates everything else, so 500 rows in one
 * statement is roughly 50× faster — minutes instead of an hour for a big file.
 */
function batchInsert(engine, target, plan, rows) {
  const dialect = engine.dialect
  const names = plan.map((item) => dialect.quote(item.column)).join(', ')
  const values = []
  const tuples = rows.map((row) => {
    const cells = row.map((cell) => {
      if (dialect.supportsBind) {
        values.push(cell)
        return dialect.placeholder(values.length)
      }
      return literalOf(dialect, cell)
    })
    return `(${cells.join(', ')})`
  })
  return {
    sql: `INSERT INTO ${dialect.qualify(target)} (${names}) VALUES ${tuples.join(', ')}`,
    values,
  }
}

/** Rows per statement: 500, unless the driver's bind budget says fewer. */
function batchSizeFor(dbType, columnCount) {
  const budget = MAX_BINDS[dbType] ?? DEFAULT_MAX_BINDS
  // A 200-column table would blow past MySQL's 65535 placeholders at 500 rows, and
  // past SQL Server's 2100 long before that; SQL Server also caps a VALUES list at
  // 1000 rows however few binds it uses.
  const byBinds = Math.floor(budget / Math.max(1, columnCount))
  const byRows = dbType === 'sqlserver' ? 1000 : BATCH_ROWS
  return Math.max(1, Math.min(BATCH_ROWS, byRows, byBinds))
}

/** One source cell, as its destination column wants to receive it. */
function coerce(raw, kind) {
  if (raw === undefined || raw === null) {
    return null
  }
  if (raw instanceof Date || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'object') {
    // A nested object or array out of a JSON file goes in as its own text.
    return JSON.stringify(raw)
  }
  const text = String(raw)
  if (text.length === 0) {
    // The trap this whole function exists for: `''` handed to an INT column is a
    // MySQL 0, and to a DATE column `0000-00-00`. A blank cell means "no value"
    // everywhere except a text column, where the empty string IS the value — and
    // the difference between NULL and 0 in a numeric column is data corruption
    // nobody notices until a SUM comes out wrong.
    return kind === 'text' ? '' : null
  }
  if (kind === 'boolean') {
    const flag = booleanOf(text)
    if (flag !== undefined) {
      return flag
    }
  }
  if (kind === 'number') {
    const number = numberOf(text)
    if (number !== undefined) {
      return number
    }
  }
  return text
}

/** How a destination column's declared type should read a text cell. */
function columnKind(dataType) {
  const type = String(dataType ?? '').toLowerCase()
  if (/^(bool|boolean|bit)/.test(type)) {
    return 'boolean'
  }
  if (/int|serial|dec|numeric|number|float|double|real|money/.test(type)) {
    return 'number'
  }
  if (/char|text|clob|string|uuid|json|xml|enum|set/.test(type)) {
    return 'text'
  }
  // Dates, timestamps, blobs, geometry: the driver and the server know their own
  // formats better than a guess here would, so the string passes through.
  return 'other'
}

/** `true`/`false`/`1`/`0`/`yes`/`no`, or undefined when it is none of those. */
function booleanOf(text) {
  if (/^(true|t|yes|y|1)$/i.test(text)) {
    return true
  }
  if (/^(false|f|no|n|0)$/i.test(text)) {
    return false
  }
  return undefined
}

/** A numeric string as a number, or undefined when a double would change it. */
function numberOf(text) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return undefined
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return undefined
  }
  // A 20-digit id or a DECIMAL(30,10) does not survive a double, and `'1.50'` into
  // a DECIMAL is not the same text as `1.5`. Anything that does not round-trip
  // stays a string and lets the server parse it exactly.
  return String(value) === text.replace(/^\+/, '') ? value : undefined
}

/** An inline literal, for the engines whose driver takes no binds. */
function literalOf(dialect, value) {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  if (value instanceof Date) {
    return dialect.literal(value.toISOString().replace('T', ' ').replace('Z', ''))
  }
  return dialect.literal(String(value))
}

// ------------------------------------------------------------------- data files
/** Format → parser. Declared after them; function declarations hoist. */
const PARSERS = { csv: loadCsv, excel: loadExcel, json: loadJson }

/** Which parser handles this file, by extension. */
function formatOf(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    return 'csv'
  }
  if (extension === '.xlsx') {
    return 'excel'
  }
  if (extension === '.json') {
    return 'json'
  }
  if (extension === '.xls') {
    // exceljs reads OOXML only. Starting the import and failing three minutes in
    // with an XML parse error is a worse answer than this one.
    throw new DbmError(ERR.unsupported, '只支持 .xlsx（.xls 是旧二进制格式）')
  }
  throw new DbmError(
    ERR.unsupported,
    `不支持的数据文件格式 ${extension.length > 0 ? extension : '（没有扩展名）'}，请用 .csv / .tsv / .xlsx / .json`,
  )
}

/** CSV/TSV: streamed, with the delimiter sniffed from the header row. */
async function loadCsv(loader, { file, signal, progress }) {
  const stream = createReadStream(file.path, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES })
  let headers = null
  let reader = null
  let head = ''
  let consumed = 0
  let seen = 0

  const takeRow = async (cells) => {
    if (headers === null) {
      headers = normalizeHeaders(cells)
      loader.begin(headers)
      return
    }
    const values = {}
    for (let index = 0; index < headers.length; index += 1) {
      values[headers[index]] = cells[index]
    }
    seen += 1
    await loader.push(values)
  }

  for await (const chunk of stream) {
    throwIfAborted(signal)
    consumed += Buffer.byteLength(chunk, 'utf8')
    let text = reader === null && head.length === 0 ? stripBom(chunk) : chunk
    if (reader === null) {
      // The delimiter has to be known before the first character is parsed, so the
      // header line is buffered whole first.
      head += text
      const cut = head.search(/\r|\n/)
      if (cut === -1 && head.length < MAX_PENDING_CHARS) {
        continue
      }
      reader = createCsvReader({ delimiter: detectDelimiter(cut === -1 ? head : head.slice(0, cut)), onRow: takeRow })
      text = head
      head = ''
    }
    await reader.push(text)
    progress(percentOf(consumed / file.size), `已写入 ${loader.inserted} 行`)
  }

  if (reader === null) {
    if (head.length === 0) {
      throw new DbmError(ERR.invalidInput, '文件是空的')
    }
    // A single line with no break at all: still a header row, and maybe nothing else.
    reader = createCsvReader({ delimiter: detectDelimiter(head), onRow: takeRow })
    await reader.push(head)
  }
  await reader.end()
  await loader.flush()
  return seen
}

/**
 * An incremental CSV/TSV reader.
 *
 * Not a regex split, and not `line.split(delimiter)`: a quoted field may hold the
 * delimiter, a line break, or `""` meaning one literal quote — and the file arrives
 * in chunks, so any of those can straddle a chunk boundary. That is why the state
 * (`quoted`, `escaped`, `pendingLf`) lives outside `push` and survives between
 * calls, and why `push` walks one character at a time.
 */
function createCsvReader({ delimiter, onRow }) {
  let field = ''
  let cells = []
  let quoted = false
  let escaped = false
  let pendingLf = false
  let started = false

  const endRow = async () => {
    cells.push(field)
    const row = cells
    field = ''
    cells = []
    started = false
    // A blank line is not a row of one empty column.
    if (row.length === 1 && row[0].length === 0) {
      return
    }
    await onRow(row)
  }

  return {
    async push(text) {
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (quoted) {
          if (escaped) {
            escaped = false
            if (char === '"') {
              field += '"'
              continue
            }
            // A single quote closed the field; this character is already outside it.
            quoted = false
          } else if (char === '"') {
            escaped = true
            continue
          } else {
            field += char
            continue
          }
        }
        if (pendingLf) {
          pendingLf = false
          if (char === '\n') {
            continue
          }
        }
        if (char === '"' && field.length === 0) {
          quoted = true
          started = true
          continue
        }
        if (char === delimiter) {
          cells.push(field)
          field = ''
          started = true
          continue
        }
        if (char === '\r') {
          // One row end for `\r\n`, for a lone `\r`, and for a lone `\n`.
          pendingLf = true
          await endRow()
          continue
        }
        if (char === '\n') {
          await endRow()
          continue
        }
        field += char
        started = true
      }
    },
    async end() {
      if (started || quoted || field.length > 0 || cells.length > 0) {
        await endRow()
      }
    },
  }
}

/** `,`, tab or `;` — whichever separates the most fields in the header row. */
function detectDelimiter(line) {
  let best = ','
  let bestCount = 0
  for (const candidate of [',', '\t', ';']) {
    let count = 0
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"') {
        quoted = !quoted
        continue
      }
      if (!quoted && char === candidate) {
        count += 1
      }
    }
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/**
 * Header names, the way `csvHeaders()` in host/fs.js produces them.
 *
 * That function filled the mapping dropdown the user picked from, so a name that
 * comes out differently here is a column silently skipped: same trimming, same
 * `Column_N` for an unnamed one.
 */
function normalizeHeaders(cells) {
  return cells.map((cell, index) => {
    const text = cell === null || cell === undefined ? '' : String(cell).trim()
    return text.length > 0 ? text : `Column_${index + 1}`
  })
}

/** .xlsx: exceljs' streaming reader, first worksheet, row 1 is the header. */
async function loadExcel(loader, { file, signal, progress }) {
  const ExcelJS = await import('exceljs').then((module) => module?.default ?? module)
  // The reader takes a stream, which is also how the progress bar gets a number:
  // see below.
  const source = createReadStream(file.path)
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'ignore',
  })
  let headers = null
  let seen = 0

  try {
    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        throwIfAborted(signal)
        const cells = excelCells(row, headers === null ? 0 : headers.length)
        if (headers === null) {
          headers = normalizeHeaders(cells)
          loader.begin(headers)
          continue
        }
        const values = {}
        for (let index = 0; index < headers.length; index += 1) {
          values[headers[index]] = cells[index]
        }
        seen += 1
        await loader.push(values)
        if (seen % 200 === 0) {
          // The streaming reader never learns the row count — it does not parse the
          // sheet's `<dimension>` — so progress rides the bytes the zip stream has
          // eaten and the row count goes in the note.
          progress(percentOf(source.bytesRead / file.size), `已写入 ${loader.inserted} 行`)
        }
      }
      // Only the first worksheet: the header the user mapped came from that one.
      break
    }
  } finally {
    source.destroy()
  }

  if (headers === null) {
    throw new DbmError(ERR.invalidInput, 'Excel 文件里没有工作表，或者第一张表是空的')
  }
  await loader.flush()
  return seen
}

/** One worksheet row as plain values, padded to the header's width. */
function excelCells(row, width) {
  const present = Array.isArray(row?.values) ? row.values.length - 1 : 0
  const count = Math.max(width, present)
  const cells = []
  for (let index = 1; index <= count; index += 1) {
    const cell = row.getCell(index)
    const value = cell?.value
    if (value === null || value === undefined) {
      cells.push(null)
    } else if (value instanceof Date || typeof value !== 'object') {
      cells.push(value)
    } else {
      // Formula, rich-text, hyperlink and error cells all arrive as objects; what
      // the user saw in the sheet is what they mapped.
      cells.push(typeof cell.text === 'string' ? cell.text : null)
    }
  }
  return cells
}

/** JSON: an array of objects, read whole because that is the only way to parse it. */
async function loadJson(loader, { file, signal, progress }) {
  const raw = await readFile(file.path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch (error) {
    throw new DbmError(ERR.invalidInput, `JSON 文件解析失败: ${messageOf(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new DbmError(ERR.invalidInput, 'JSON 导入需要一个对象数组，例如 [{"id": 1}, {"id": 2}]')
  }
  if (parsed.length === 0) {
    throw new DbmError(ERR.invalidInput, 'JSON 文件里没有数据')
  }
  if (!isPlainRecord(parsed[0])) {
    throw new DbmError(ERR.invalidInput, 'JSON 数组里的元素必须是对象')
  }
  // The mapping dropdown was filled from the first record's keys (host/fs.js), so
  // those are the source names here too.
  loader.begin(Object.keys(parsed[0]))

  let seen = 0
  for (const record of parsed) {
    throwIfAborted(signal)
    if (!isPlainRecord(record)) {
      throw new DbmError(ERR.invalidInput, `第 ${seen + 1} 条记录不是对象`)
    }
    seen += 1
    await loader.push(record)
    if (seen % 200 === 0) {
      progress(percentOf(seen / parsed.length), `已写入 ${loader.inserted} 行`)
    }
  }
  await loader.flush()
  return seen
}

/** A JSON object that can stand in for a row. */
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------- shared
/**
 * The file, checked before any task exists.
 *
 * Deliberately not inside the worker: a missing path or a 6 GB file is the caller's
 * mistake and belongs in the reply to the request, not in a task that appears in
 * the panel and immediately goes red.
 */
async function requireImportFile(filePath) {
  const target = requireAbsolute(filePath, '文件路径')
  let info
  try {
    info = await stat(target)
  } catch {
    throw new DbmError(ERR.notFound, `导入文件不存在: ${target}`)
  }
  if (!info.isFile()) {
    throw new DbmError(ERR.invalidInput, `不是文件: ${target}`)
  }
  if (info.size === 0) {
    throw new DbmError(ERR.invalidInput, `文件是空的: ${target}`)
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new DbmError(
      ERR.tooLarge,
      `文件 ${formatBytes(info.size)} 超过 4 GB，请先用 split 之类的工具拆开再导入`,
    )
  }
  return { path: target, size: info.size }
}

/** Drop a UTF-8 BOM. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** The 10 % … 95 % band a running import reports inside. */
function percentOf(fraction) {
  const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return 10 + 85 * value
}

/** Bytes as the panel writes them. */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}
