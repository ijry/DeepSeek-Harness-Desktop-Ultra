/**
 * The command table.
 *
 * One POST route (`/api/<command>`) carrying the same command names the reference
 * plugin's Tauri backend answered, because the panel's Vue sources are byte-copies
 * of the reference's and still call `invoke('get_tables', …)`. That is the whole
 * trick of this port: the transport changed, the vocabulary did not.
 *
 * Three other routes: the SSE stream the task list and the progress bars listen to,
 * the built panel bundle under `/app/`, and uploaded markdown images under
 * `/static/images/`.
 *
 * @module dsh-plugin-otools-dbm/host/routes
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  DbmError,
  ERR,
  boundedInt,
  optionalIdentifier,
  optionalText,
  requireIdentifier,
  requireText,
} from '../shared/protocol.js'

import { generateText, loadChatHistory, saveChatHistory, aiAvailability } from './ai.js'
import { BackupScheduler, getBackupPlans, getBackupStorageInfo, saveBackupPlans, triggerBackupPlan } from './backup.js'
import { ConnectionManager } from './connections.js'
import { bulkInsert, deleteRecord, insertRecord, paginatedQuery, saveTableData, updateRecord } from './crud.js'
import { exportDataDictionaryDocx } from './dictionary.js'
import { backupDatabase, exportMultipleTables, exportTableData } from './exporter.js'
import {
  copyExportedFile,
  createDir,
  fileHeaders,
  homeDir,
  IMAGE_DIR,
  joinPath,
  listDir,
  revealPath,
  saveImage,
  writeBase64File,
} from './fs.js'
import { fail, ok, readJsonBody, serveStatic } from './http.js'
import {
  importDatabaseFromSql,
  importTableFromDataFile,
  importTableFromSql,
  restoreDatabaseFromBackup,
} from './importer.js'
import { assertReadOnly } from './sql/split.js'
import {
  addColumn,
  allTableStructs,
  createIndex,
  createTable,
  dropColumn,
  dropIndex,
  dropTable,
  invalidateSchemaCache,
  modifyColumn,
  tableStruct,
  updateTableComment,
} from './schema.js'
import { hostLocale } from './sdk.js'
import {
  BackupPlanStore,
  ConnectionStore,
  PluginStateStore,
  SyncLogStore,
  mergeSecrets,
  redactConnection,
} from './store.js'
import { getSyncLogs, previewSyncPlan, syncDatabasesAsTask } from './sync.js'
import { TaskManager } from './tasks.js'
import { closeAllTunnels } from './tunnel.js'

export const ROUTE_PREFIX = '/dsh-plugin-otools-dbm'
export const SSE_PATH = `${ROUTE_PREFIX}/events`

/** Where `npm run build` puts the panel bundle. */
const WEBVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'webview')

/** Heartbeat so a proxy does not close an idle event stream. */
const HEARTBEAT_MS = 20_000

/**
 * Mount every route.
 * @param ctx - the cordis context (needs `webServer`).
 * @param options.ai - the mutable `{ llm, defaultModel }` holder.
 * @returns a disposer.
 */
export function registerDbmRoutes(ctx, options = {}) {
  const subscribers = new Set()
  let heartbeat

  const emit = (name, payload) => {
    if (subscribers.size === 0) {
      return
    }
    const frame = `data: ${JSON.stringify({ name, payload })}\n\n`
    for (const res of Array.from(subscribers)) {
      try {
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  const store = new ConnectionStore()
  const context = {
    store,
    connections: new ConnectionManager({ store }),
    tasks: new TaskManager({ emit }),
    state: new PluginStateStore(),
    plans: new BackupPlanStore(),
    syncLogs: new SyncLogStore(),
    emit,
    ai: options.ai ?? {},
  }

  const scheduler = new BackupScheduler(context)
  scheduler.start()

  const commands = buildCommands(context)

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(ROUTE_PREFIX.length)

      if (req.method === 'GET') {
        if (route === '' || route === '/') {
          res.writeHead(302, { location: `${ROUTE_PREFIX}/app/` })
          res.end()
          return
        }
        // The exact route below normally claims this (dsh's webServer matches the
        // exact table before the prefix table), but answering it here too means a
        // change in that order cannot silently kill the task progress stream.
        if (route === '/events') {
          sse(req, res)
          return
        }
        if (route === '/app' || route.startsWith('/app/')) {
          const relative = route.slice('/app'.length) || '/'
          // Any unknown path inside the app falls back to index.html, so a reload
          // of a deep link still boots the panel.
          await serveStatic(res, WEBVIEW_DIR, relative === '/' ? 'index.html' : relative, {
            fallback: 'index.html',
          })
          return
        }
        if (route.startsWith('/static/images/')) {
          await serveStatic(res, IMAGE_DIR, route.slice('/static/images/'.length))
          return
        }
        if (route === '/health') {
          ok(res, { ok: true, locale: hostLocale(), ai: aiAvailability(context.ai) })
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }

      if (!route.startsWith('/api/')) {
        res.writeHead(404)
        res.end()
        return
      }
      const name = decodeURIComponent(route.slice('/api/'.length))
      const command = commands[name]
      if (command === undefined) {
        fail(res, new DbmError(ERR.notFound, `未知命令: ${name}`))
        return
      }
      const args = await readJsonBody(req)
      ok(res, await command(args))
    } catch (error) {
      fail(res, error)
    }
  }

  const sse = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    res.write(`data: ${JSON.stringify({ name: 'hello', payload: { locale: hostLocale() } })}\n\n`)
    subscribers.add(res)

    // A socket that dies between 'close' and the next write throws on write;
    // dropping it here keeps the broadcast loop clean.
    res.on('error', () => subscribers.delete(res))
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const client of Array.from(subscribers)) {
          try {
            client.write(': ping\n\n')
          } catch {
            subscribers.delete(client)
          }
        }
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
    }
    req.on('close', () => {
      subscribers.delete(res)
      if (subscribers.size === 0 && heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
  ]

  return () => {
    scheduler.stop()
    context.tasks.disposeAll()
    for (const dispose of disposers) {
      dispose()
    }
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    for (const res of subscribers) {
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }
    subscribers.clear()
    void context.connections.closeAll()
    void closeAllTunnels()
  }
}

/** Build the command table. Split out so the tests can drive it directly. */
export function buildCommands(context) {
  const { connections, store, tasks, state } = context

  /** Run `fn` with the engine for `connectionId`. */
  const withEngine = (args, fn) =>
    connections.with(requireText(args?.connectionId, '连接 ID'), fn)

  /** The `{database, schema, table}` triple every table route carries. */
  const target = (args) => ({
    database: optionalIdentifier(args?.databaseName, '数据库名'),
    schema: optionalIdentifier(args?.schemaName, 'Schema 名'),
    table: requireIdentifier(args?.tableName, '表名'),
  })

  return {
    // ------------------------------------------------------------ connections
    async add_db_connection(args) {
      return store.add(args?.connection ?? {})
    },
    async get_db_connections() {
      return (await store.list()).map((row) => redactConnection(row))
    },
    async get_db_connection(args) {
      const found = await store.get(requireText(args?.id, '连接 ID'))
      return found === undefined ? null : redactConnection(found)
    },
    async update_db_connection(args) {
      const id = requireText(args?.id, '连接 ID')
      const stored = await store.require(id)
      await store.replace(id, mergeSecrets(args?.connection ?? {}, stored))
      // The engine holds the old credentials and the old tunnel.
      await connections.close(id)
      invalidateSchemaCache(id)
      return null
    },
    async delete_db_connection(args) {
      const id = requireText(args?.id, '连接 ID')
      await connections.close(id)
      invalidateSchemaCache(id)
      await store.remove(id)
      return null
    },
    async open_db_connection(args) {
      const incoming = args?.connection ?? {}
      const id = String(incoming.id ?? '').trim()
      // The tree sends the redacted record it was given, so the stored secrets
      // have to be merged back in before anything is dialled.
      const stored = id.length > 0 ? await store.get(id) : undefined
      return connections.open(stored === undefined ? incoming : mergeSecrets(incoming, stored))
    },
    async close_db_connection(args) {
      const id = requireText(args?.id, '连接 ID')
      invalidateSchemaCache(id)
      return connections.close(id)
    },
    async is_db_connection_active(args) {
      return connections.isActive(requireText(args?.id, '连接 ID'))
    },

    // ----------------------------------------------------------------- queries
    async execute_query(args) {
      return withEngine(args, (engine) =>
        engine.executeScript(requireText(args?.sql, 'SQL', { max: 4 * 1024 * 1024 }), {
          database: optionalIdentifier(args?.databaseName, '数据库名'),
          stopOnError: true,
        }),
      )
    },
    async execute_query_workbench(args) {
      return withEngine(args, (engine) =>
        engine.executeScript(requireText(args?.sql, 'SQL', { max: 4 * 1024 * 1024 }), {
          database: optionalIdentifier(args?.databaseName, '数据库名'),
          // The workbench reports every statement, including the ones that failed.
          stopOnError: false,
        }),
      )
    },
    async dbm_execute_dashboard_query(args) {
      const sql = requireText(args?.sql, 'SQL', { max: 64 * 1024 })
      assertReadOnly(sql)
      return withEngine(args, (engine) =>
        engine.executeScript(sql, {
          database: optionalIdentifier(args?.databaseName, '数据库名'),
          stopOnError: true,
        }),
      )
    },
    async explain_query(args) {
      const sql = requireText(args?.sql, 'SQL', { max: 1024 * 1024 })
      return withEngine(args, (engine) => {
        const prefix = explainPrefix(engine.dbType)
        if (prefix === null) {
          throw new DbmError(ERR.unsupported, `${engine.dbType} 不支持执行计划`)
        }
        return engine.executeScript(`${prefix} ${sql.replace(/;\s*$/, '')}`, {
          database: optionalIdentifier(args?.databaseName, '数据库名'),
          stopOnError: true,
        })
      })
    },

    // -------------------------------------------------------------- catalogue
    async get_databases(args) {
      return withEngine(args, (engine) => engine.listDatabases())
    },
    async get_schemas(args) {
      return withEngine(args, (engine) =>
        engine.listSchemas(optionalIdentifier(args?.databaseName, '数据库名')),
      )
    },
    async get_tables(args) {
      return withEngine(args, (engine) =>
        engine.listTables(
          optionalIdentifier(args?.databaseName, '数据库名'),
          optionalIdentifier(args?.schemaName, 'Schema 名'),
        ),
      )
    },
    async get_views(args) {
      return withEngine(args, (engine) =>
        engine.listViews(
          optionalIdentifier(args?.databaseName, '数据库名'),
          optionalIdentifier(args?.schemaName, 'Schema 名'),
        ),
      )
    },
    async get_stored_procedures(args) {
      return withEngine(args, (engine) =>
        engine.listProcedures(
          optionalIdentifier(args?.databaseName, '数据库名'),
          optionalIdentifier(args?.schemaName, 'Schema 名'),
        ),
      )
    },
    async get_view_definition(args) {
      return withEngine(args, (engine) =>
        engine.viewDefinition(
          optionalIdentifier(args?.databaseName, '数据库名'),
          requireIdentifier(args?.viewName, '视图名'),
          optionalIdentifier(args?.schemaName, 'Schema 名'),
        ),
      )
    },
    async get_procedure_definition(args) {
      return withEngine(args, (engine) =>
        engine.procedureDefinition(
          optionalIdentifier(args?.databaseName, '数据库名'),
          requireIdentifier(args?.procedureName, '存储过程名'),
          optionalIdentifier(args?.schemaName, 'Schema 名'),
        ),
      )
    },
    async get_database_stats(args) {
      return withEngine(args, (engine) => engine.stats())
    },

    // ------------------------------------------------------------- table data
    async get_table_data(args) {
      const parts = target(args)
      return withEngine(args, (engine) =>
        engine.tableData({
          ...parts,
          limit: boundedInt(args?.limit, 100, 1, 5000),
          offset: boundedInt(args?.offset, 0, 0, Number.MAX_SAFE_INTEGER),
          orderBy: optionalText(args?.orderBy),
          filters: args?.filters ?? {},
        }),
      )
    },
    async paginated_query(args) {
      const parts = target(args)
      return withEngine(args, (engine) =>
        paginatedQuery(engine, {
          ...parts,
          page: args?.page,
          pageSize: args?.pageSize,
          orderBy: optionalText(args?.orderBy),
          filters: args?.filters ?? {},
        }),
      )
    },

    // ------------------------------------------------------------- structure
    async get_table_struct(args) {
      const connectionId = requireText(args?.connectionId, '连接 ID')
      const parts = target(args)
      return connections.with(connectionId, (engine) =>
        tableStruct(engine, { connectionId, ...parts }),
      )
    },
    async get_all_table_structs(args) {
      const connectionId = requireText(args?.connectionId, '连接 ID')
      return connections.with(connectionId, (engine) =>
        allTableStructs(engine, {
          connectionId,
          database: optionalIdentifier(args?.databaseName, '数据库名'),
          schema: optionalIdentifier(args?.schemaName, 'Schema 名'),
          force: args?.forceRefresh === true,
        }),
      )
    },
    async get_create_table_statement(args) {
      const parts = target(args)
      return withEngine(args, (engine) =>
        engine.createTableStatement(parts.database, parts.table, parts.schema),
      )
    },
    async create_table(args) {
      return runDdl(args, (engine) =>
        createTable(engine, { ...target(args), columns: args?.columns, comment: args?.comment }),
      )
    },
    async drop_table(args) {
      return runDdl(args, (engine) => dropTable(engine, target(args)))
    },
    async add_column(args) {
      return runDdl(args, (engine) => addColumn(engine, { ...target(args), column: args?.column }))
    },
    async modify_column(args) {
      return runDdl(args, (engine) => modifyColumn(engine, { ...target(args), column: args?.column }))
    },
    async delete_column(args) {
      return runDdl(args, (engine) => dropColumn(engine, { ...target(args), columnName: args?.columnName }))
    },
    async update_table_comment(args) {
      return runDdl(args, (engine) =>
        updateTableComment(engine, { ...target(args), comment: args?.comment }),
      )
    },
    async create_index(args) {
      return runDdl(args, (engine) =>
        createIndex(engine, {
          ...target(args),
          indexName: args?.indexName,
          columns: args?.columns,
          isUnique: args?.isUnique === true,
        }),
      )
    },
    async drop_index(args) {
      return runDdl(args, (engine) => dropIndex(engine, { ...target(args), indexName: args?.indexName }))
    },

    // ------------------------------------------------------------------- CRUD
    async insert_record(args) {
      const parts = target(args)
      return withEngine(args, (engine) => insertRecord(engine, { ...parts, data: args?.data ?? {} }))
    },
    async update_record(args) {
      const parts = target(args)
      return withEngine(args, (engine) =>
        updateRecord(engine, { ...parts, id: args?.id, data: args?.data ?? {} }),
      )
    },
    async delete_record(args) {
      const parts = target(args)
      return withEngine(args, (engine) => deleteRecord(engine, { ...parts, id: args?.id }))
    },
    async bulk_insert(args) {
      const parts = target(args)
      return withEngine(args, (engine) => bulkInsert(engine, { ...parts, records: args?.records ?? [] }))
    },
    async save_table_data(args) {
      const connectionId = requireText(args?.connectionId, '连接 ID')
      const parts = target(args)
      return connections.with(connectionId, async (engine) => {
        const outcome = await saveTableData(engine, { ...parts, changes: args?.changes ?? {} })
        invalidateSchemaCache(connectionId)
        return outcome
      })
    },

    // ---------------------------------------------------------------- Redis
    async get_redis_key_info(args) {
      return withEngine(args, (engine) =>
        requireRedis(engine).keyInfo(optionalText(args?.databaseName), requireText(args?.keyName, '键名')),
      )
    },
    async get_redis_tree_children(args) {
      return withEngine(args, (engine) =>
        requireRedis(engine).treeChildren({
          database: optionalText(args?.databaseName),
          prefix: typeof args?.prefix === 'string' ? args.prefix : '',
          cursor: optionalText(args?.cursor),
          limit: boundedInt(args?.limit, 100, 20, 2000),
          keywords: Array.isArray(args?.keywords) ? args.keywords.map((word) => String(word)) : [],
        }),
      )
    },
    async set_redis_key(args) {
      return withEngine(args, (engine) =>
        requireRedis(engine).setKey(optionalText(args?.databaseName), args?.payload ?? {}),
      )
    },
    async delete_redis_key(args) {
      return withEngine(args, async (engine) => {
        await requireRedis(engine).deleteKey(optionalText(args?.databaseName), requireText(args?.keyName, '键名'))
        return null
      })
    },

    // -------------------------------------------------------- export / import
    async export_table_data(args) {
      return exportTableData(context, args?.params ?? args ?? {})
    },
    async export_multiple_tables(args) {
      return exportMultipleTables(context, args?.params ?? args ?? {})
    },
    async backup_database_as_task(args) {
      return backupDatabase(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        databaseName: optionalText(args?.databaseName),
        tableNames: Array.isArray(args?.tableNames) ? args.tableNames.map((name) => String(name)) : [],
        exportPath: optionalText(args?.exportPath),
      })
    },
    async import_database_from_sql_as_task(args) {
      return importDatabaseFromSql(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        databaseName: optionalText(args?.databaseName),
        filePath: requireText(args?.filePath, '文件路径'),
      })
    },
    async import_table_from_sql_as_task(args) {
      return importTableFromSql(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        databaseName: optionalText(args?.databaseName),
        tableName: optionalText(args?.tableName),
        schemaName: optionalText(args?.schemaName),
        filePath: requireText(args?.filePath, '文件路径'),
      })
    },
    async import_table_from_data_file_as_task(args) {
      return importTableFromDataFile(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        databaseName: optionalText(args?.databaseName),
        tableName: requireIdentifier(args?.tableName, '表名'),
        schemaName: optionalIdentifier(args?.schemaName, 'Schema 名'),
        filePath: requireText(args?.filePath, '文件路径'),
        columnMappings: args?.columnMappings ?? {},
      })
    },
    async restore_database_from_backup_as_task(args) {
      return restoreDatabaseFromBackup(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        databaseName: optionalText(args?.databaseName),
        filePath: requireText(args?.filePath, '文件路径'),
      })
    },
    async export_data_dictionary_docx(args) {
      return exportDataDictionaryDocx(context, {
        connectionId: requireText(args?.connectionId, '连接 ID'),
        outputPath: requireText(args?.outputPath, '输出路径'),
        databaseName: optionalIdentifier(args?.databaseName, '数据库名'),
        schemaName: optionalIdentifier(args?.schemaName, 'Schema 名'),
        progressToken: optionalText(args?.progressToken),
      })
    },
    async get_file_headers(args) {
      return fileHeaders(requireText(args?.filePath, '文件路径'), optionalText(args?.format))
    },

    // ------------------------------------------------------------ backup plans
    async dbm_get_backup_plans() {
      return getBackupPlans(context)
    },
    async dbm_save_backup_plans(args) {
      return saveBackupPlans(context, Array.isArray(args?.plans) ? args.plans : [])
    },
    async dbm_trigger_backup_plan(args) {
      return triggerBackupPlan(context, requireText(args?.planId, '计划 ID'))
    },
    async dbm_get_backup_storage_info(args) {
      return getBackupStorageInfo(context, optionalText(args?.path))
    },

    // -------------------------------------------------------------------- sync
    async dbm_preview_sync_plan(args) {
      return previewSyncPlan(context, syncArgs(args))
    },
    async dbm_sync_databases_as_task(args) {
      return syncDatabasesAsTask(context, { ...syncArgs(args), planToken: optionalText(args?.planToken) })
    },
    async dbm_get_sync_logs() {
      return getSyncLogs(context)
    },

    // ------------------------------------------------------------------- tasks
    async get_all_tasks() {
      return tasks.list()
    },
    async clear_completed_tasks() {
      return tasks.clearCompleted()
    },
    async cancel_task(args) {
      tasks.cancel(requireText(args?.taskId, '任务 ID'))
      return null
    },
    async retry_task(args) {
      return retryTask(context, requireText(args?.taskId, '任务 ID'))
    },
    async copy_exported_file(args) {
      return copyExportedFile(args?.sourcePath, args?.destinationPath)
    },

    // ------------------------------------------------------------- plugin state
    async get_otools_plugin_localstate() {
      return state.read('')
    },
    async get_otools_plugin_localstate_with_scheme(args) {
      return state.read(args?.scheme)
    },
    async save_otools_plugin_localstate(args) {
      await state.write('', args?.state)
      return null
    },
    async save_otools_plugin_localstate_with_scheme(args) {
      await state.write(args?.scheme, args?.state)
      return null
    },

    // ---------------------------------------------------------------------- AI
    async otools_ai_generate_text(args) {
      return generateText(context.ai, args?.request ?? {})
    },
    async otools_ai_load_chat_history(args) {
      return loadChatHistory(args?.prefix)
    },
    async otools_ai_save_chat_history(args) {
      await saveChatHistory(args?.prefix, args?.messages)
      return null
    },

    // ---------------------------------------------------------------- host FS
    async dbm_fs_home_dir() {
      return homeDir()
    },
    async dbm_fs_join_path(args) {
      return joinPath(args?.paths)
    },
    async dbm_fs_list_dir(args) {
      return listDir(args?.path)
    },
    async dbm_fs_create_dir(args) {
      await createDir(args?.path)
      return null
    },
    async dbm_fs_write_file(args) {
      await writeBase64File(args?.path, args?.dataBase64)
      return null
    },
    async dbm_fs_reveal(args) {
      return revealPath(args?.path)
    },
    async upload_save_image(args) {
      return saveImage({
        fileName: args?.fileName,
        mime: args?.mime,
        dataBase64: args?.dataBase64,
      })
    },
  }

  /** DDL runs, then the structure cache for that connection is dropped. */
  async function runDdl(args, fn) {
    const connectionId = requireText(args?.connectionId, '连接 ID')
    return connections.with(connectionId, async (engine) => {
      const outcome = await fn(engine)
      invalidateSchemaCache(connectionId)
      return outcome
    })
  }
}

/** The six sync arguments, validated. */
function syncArgs(args) {
  return {
    sourceConnectionId: requireText(args?.sourceConnectionId, '源连接 ID'),
    sourceDatabaseName: optionalIdentifier(args?.sourceDatabaseName, '源数据库名'),
    targetConnectionId: requireText(args?.targetConnectionId, '目标连接 ID'),
    targetDatabaseName: optionalIdentifier(args?.targetDatabaseName, '目标数据库名'),
    syncStructure: args?.syncStructure !== false,
    syncData: args?.syncData === true,
  }
}

/** The engine has to actually be Redis for the four Redis routes. */
function requireRedis(engine) {
  if (engine?.kind !== 'redis') {
    throw new DbmError(ERR.invalidInput, '当前连接不是 Redis')
  }
  return engine
}

/** `EXPLAIN` spelling per engine; null where there is none. */
function explainPrefix(dbType) {
  switch (dbType) {
    case 'mysql':
    case 'mariadb':
    case 'postgresql':
    case 'kingbasees':
    case 'clickhouse':
      return 'EXPLAIN'
    case 'sqlite':
      return 'EXPLAIN QUERY PLAN'
    case 'oracle':
    case 'dameng':
      return 'EXPLAIN PLAN FOR'
    case 'sqlserver':
    case 'snowflake':
      return null
    default:
      return null
  }
}

/**
 * Replay a finished task from its metadata.
 *
 * Only exports, backups, imports and restores can be replayed; a sync depends on
 * both databases still being in the state the preview saw, so it has to be
 * previewed again rather than blindly repeated.
 */
async function retryTask(context, taskId) {
  const task = context.tasks.get(taskId)
  if (task === undefined) {
    throw new DbmError(ERR.notFound, `任务不存在: ${taskId}`)
  }
  if (task.status !== 'Failed' && task.status !== 'Cancelled') {
    throw new DbmError(ERR.conflict, '仅失败或已取消的任务支持重试')
  }
  const meta = task.metadata ?? {}
  const shared = {
    connectionId: meta.connection_id,
    databaseName: meta.database_name,
    schemaName: meta.schema_name,
  }

  if (task.task_type === 'Export') {
    const tableNames = parseList(meta.table_names)
    if (tableNames.length > 0) {
      return exportMultipleTables(context, {
        ...shared,
        tableNames,
        format: meta.format ?? 'sql',
        exportPath: meta.export_path,
        remarks: `重试任务 ${taskId}`,
      })
    }
    return exportTableData(context, {
      ...shared,
      tableName: meta.table_name,
      format: meta.format ?? 'csv',
      exportPath: meta.export_path,
      remarks: `重试任务 ${taskId}`,
    })
  }
  if (task.task_type === 'Backup') {
    return backupDatabase(context, {
      ...shared,
      tableNames: parseList(meta.table_names),
      exportPath: meta.export_path,
    })
  }
  if (task.task_type === 'Restore') {
    return restoreDatabaseFromBackup(context, { ...shared, filePath: meta.file_path })
  }
  if (task.task_type === 'Import') {
    if (meta.table_name !== undefined && meta.format !== undefined && meta.format !== 'sql') {
      return importTableFromDataFile(context, {
        ...shared,
        tableName: meta.table_name,
        filePath: meta.file_path,
        columnMappings: parseObject(meta.column_mappings),
      })
    }
    return importDatabaseFromSql(context, { ...shared, filePath: meta.file_path })
  }
  throw new DbmError(ERR.unsupported, '当前任务类型不支持重试')
}

/** Task metadata is a string map, so a list comes back as JSON text. */
function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item))
  }
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function parseObject(value) {
  if (value !== null && typeof value === 'object') {
    return value
  }
  try {
    const parsed = JSON.parse(String(value ?? '{}'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
