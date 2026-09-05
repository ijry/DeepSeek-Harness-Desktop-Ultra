/**
 * Every command, called once.
 *
 * The panel reaches 74 commands, wired across a dozen host modules. A signature
 * that drifted — `exportTableData(context, params)` called as
 * `exportTableData(params)` — is invisible until a user clicks the button, and then
 * it is a 500 with `TypeError: x is not a function` rather than something they can
 * act on.
 *
 * So: call all of them with empty arguments and assert the failure is a DELIBERATE
 * one. A validation refusal is a pass. A TypeError, a missing function, or an
 * `undefined` reaching a property access is a fail.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { buildCommands } from '../src/host/routes.js'
import { ConnectionManager } from '../src/host/connections.js'
import { BackupPlanStore, ConnectionStore, PluginStateStore, SyncLogStore } from '../src/host/store.js'
import { TaskManager } from '../src/host/tasks.js'

/** Commands that legitimately succeed with no arguments at all. */
const NO_ARGUMENT_COMMANDS = new Set([
  'get_db_connections',
  'get_all_tasks',
  'clear_completed_tasks',
  'dbm_get_backup_plans',
  'dbm_get_sync_logs',
  'dbm_save_backup_plans',
  'get_otools_plugin_localstate',
  'get_otools_plugin_localstate_with_scheme',
  'save_otools_plugin_localstate',
  'save_otools_plugin_localstate_with_scheme',
  'dbm_fs_home_dir',
  'dbm_fs_join_path',
  'dbm_fs_list_dir',
  'dbm_get_backup_storage_info',
  'otools_ai_load_chat_history',
  'add_db_connection',
])

/** Error shapes that mean "the code path is broken", not "the input was bad". */
const BROKEN_PATTERNS = [
  /is not a function/i,
  /Cannot read properties of (undefined|null)/i,
  /is not defined/i,
  /is not iterable/i,
  /Cannot destructure/i,
  /Assignment to constant/i,
]

describe('command table', () => {
  let dir
  let commands
  let context

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-dbm-cmd-'))
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
  })

  after(async () => {
    context?.tasks?.disposeAll()
    await context?.connections?.closeAll()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.DSH_HOME
  })

  it('covers every command the panel invokes', () => {
    // Kept in sync by hand with the panel; a command the UI calls and the host does
    // not answer is a 404 the user sees as a dead button.
    const expected = [
      'add_db_connection', 'get_db_connections', 'get_db_connection', 'update_db_connection',
      'delete_db_connection', 'open_db_connection', 'close_db_connection', 'is_db_connection_active',
      'execute_query', 'execute_query_workbench', 'dbm_execute_dashboard_query', 'explain_query',
      'get_databases', 'get_schemas', 'get_tables', 'get_views', 'get_stored_procedures',
      'get_view_definition', 'get_procedure_definition', 'get_database_stats',
      'get_table_data', 'paginated_query',
      'get_table_struct', 'get_all_table_structs', 'get_create_table_statement',
      'create_table', 'drop_table', 'add_column', 'modify_column', 'delete_column',
      'update_table_comment', 'create_index', 'drop_index',
      'insert_record', 'update_record', 'delete_record', 'bulk_insert', 'save_table_data',
      'get_redis_key_info', 'get_redis_tree_children', 'set_redis_key', 'delete_redis_key',
      'export_table_data', 'export_multiple_tables', 'backup_database_as_task',
      'import_database_from_sql_as_task', 'import_table_from_sql_as_task',
      'import_table_from_data_file_as_task', 'restore_database_from_backup_as_task',
      'export_data_dictionary_docx', 'get_file_headers',
      'dbm_get_backup_plans', 'dbm_save_backup_plans', 'dbm_trigger_backup_plan',
      'dbm_get_backup_storage_info',
      'dbm_preview_sync_plan', 'dbm_sync_databases_as_task', 'dbm_get_sync_logs',
      'get_all_tasks', 'clear_completed_tasks', 'cancel_task', 'retry_task', 'copy_exported_file',
      'get_otools_plugin_localstate', 'get_otools_plugin_localstate_with_scheme',
      'save_otools_plugin_localstate', 'save_otools_plugin_localstate_with_scheme',
      'otools_ai_generate_text', 'otools_ai_load_chat_history', 'otools_ai_save_chat_history',
      'dbm_fs_home_dir', 'dbm_fs_join_path', 'dbm_fs_list_dir', 'dbm_fs_create_dir',
      'dbm_fs_write_file', 'dbm_fs_reveal', 'upload_save_image',
    ]
    const missing = expected.filter((name) => typeof commands[name] !== 'function')
    assert.deepEqual(missing, [], `commands the panel calls but the host does not answer: ${missing.join(', ')}`)
  })

  it('fails deliberately, never with a TypeError', async () => {
    const broken = []
    for (const [name, handler] of Object.entries(commands)) {
      try {
        await handler({})
        if (!NO_ARGUMENT_COMMANDS.has(name)) {
          // Succeeding with no arguments is suspicious for a command that needs a
          // connection, but not proof of a bug — record it rather than fail.
          broken.push(`${name}: unexpectedly succeeded with no arguments`)
        }
      } catch (error) {
        const message = String(error?.message ?? error)
        if (BROKEN_PATTERNS.some((pattern) => pattern.test(message))) {
          broken.push(`${name}: ${message}`)
          continue
        }
        assert.equal(
          typeof error.code,
          'string',
          `${name} threw without a stable code: ${message}`,
        )
      }
    }
    assert.deepEqual(broken, [], `broken command paths:\n${broken.join('\n')}`)
  })
})
