/**
 * The engine contract, in one place, for the fourteen engines the panel offers.
 *
 * This file is documentation with a runtime helper at the bottom; there is no base
 * class, because a Redis engine and a MySQL engine share almost no implementation
 * and pretending otherwise would mean a base full of `unsupported()`.
 *
 * ## What every engine must have
 *
 *   kind          'sql' | 'redis' | 'mongodb' | 'elasticsearch' | 'kafka'
 *   dbType        the panel's engine name ('mysql', 'redis', …)
 *   dialect?      a SqlDialect — only the SQL engines
 *   close()       release every handle; idempotent
 *   ping()        → boolean, never throws
 *   listDatabases()                          → string[]
 *   listSchemas(database)                    → string[]   ([] when it has none)
 *   listTables(database, schema)             → string[]
 *   listViews(database, schema)              → string[]
 *   listProcedures(database, schema)         → string[]
 *   viewDefinition(database, name, schema)   → string
 *   procedureDefinition(database, name, schema) → string
 *   tableStruct(database, table, schema)     → TableStruct
 *   createTableStatement(database, table, schema) → string
 *   tableData({database, schema, table, limit, offset, orderBy, filters}) → QueryResult
 *   executeScript(script, {database, stopOnError}) → QueryResult + statements[]
 *   run(sql, {database, values})             → QueryResult
 *   stats()                                  → {databases: [...]}
 *
 * ## What a non-SQL engine adds
 *
 *   saveRows({database, schema, table, changes}) → {inserted, updated, deleted}
 *       Called by save_table_data instead of the generated SQL path. Only define
 *       it when the engine cannot be driven by INSERT/UPDATE/DELETE.
 *
 * Redis additionally:
 *   keyInfo(database, key)                   → RedisKeyInfo
 *   treeChildren({database, prefix, cursor, limit, keywords}) → RedisTreeChildrenPage
 *   setKey(database, mutation)               → RedisKeyInfo
 *   deleteKey(database, key)                 → void
 *
 * ## Shapes (exactly as the panel's TypeScript declares them)
 *
 *   QueryResult    { columns: string[], rows: any[][], row_count: number|null,
 *                    execution_time: number|null, statements?: [...],
 *                    has_errors?: boolean, batch_error_message?: string|null,
 *                    failed_statement_index?: number|null }
 *   TableStruct    { table_name, columns: ColumnSchema[], primary_keys: string[],
 *                    foreign_keys: ForeignKey[], indexes: IndexInfo[], comment }
 *   ColumnSchema   { name, data_type, is_nullable, default_value,
 *                    is_primary_key, character_maximum_length, column_comment }
 *   ForeignKey     { constraint_name, column_name, referenced_schema,
 *                    referenced_table, referenced_column }
 *   IndexInfo      { name, columns: string[], is_unique }
 *   RedisKeyInfo   { key, database, value_type, ttl_seconds, ttl_label,
 *                    columns: string[], rows: any[][] }
 *   RedisKeyEntry  { field?, value, score? }
 *   RedisKeyMutation { key_name, value_type, ttl_seconds?, entries: RedisKeyEntry[] }
 *   RedisTreeNode  { node_type: 'prefix'|'key', label, full_path }
 *
 * An operation an engine genuinely lacks must throw `DbmError(ERR.unsupported, …)`
 * with a Chinese message naming the engine — the panel shows it verbatim, and a
 * plain "not implemented" tells the user nothing.
 *
 * @module dsh-plugin-otools-dbm/host/engines/contract
 */
import { DbmError, ERR } from '../../shared/protocol.js'

/** Throw the "this engine cannot do that" error, uniformly worded. */
export function unsupported(engine, what) {
  throw new DbmError(ERR.unsupported, `${engine} 不支持${what}`)
}

/** Every method a route may call, so a new engine can be checked against it. */
export const ENGINE_METHODS = [
  'close',
  'ping',
  'listDatabases',
  'listSchemas',
  'listTables',
  'listViews',
  'listProcedures',
  'viewDefinition',
  'procedureDefinition',
  'tableStruct',
  'createTableStatement',
  'tableData',
  'executeScript',
  'run',
  'stats',
]

/** True when `engine` implements every method a route may call. */
export function isCompleteEngine(engine) {
  return ENGINE_METHODS.every((name) => typeof engine?.[name] === 'function')
}
