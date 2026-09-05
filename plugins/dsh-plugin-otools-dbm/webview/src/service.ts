import { invoke } from '@tauri-apps/api/core'
import type { DbmBackgroundTask } from './shared'
import { DBM_PLUGIN_STATE_NAME, DBM_UI_STATE_SCHEME } from './shared'
import {
  DbmApi,
  createDefaultDbSshConfig,
  dbTypeLabels,
  exportMultipleTables,
  extractDbmErrorMessage,
  generateConnectionString as generateDbmConnectionString,
  getDbTypeLabel,
  normalizeDbSshConfig,
  toDbmError,
} from '@/utils/dbm'

export {
  DbmApi,
  createDefaultDbSshConfig,
  dbTypeLabels,
  exportMultipleTables,
  extractDbmErrorMessage,
  getDbTypeLabel,
  normalizeDbSshConfig,
  toDbmError,
}

export const generateConnectionString = generateDbmConnectionString

export type {
  BackupPlan,
  BackupStorageInfo,
  ColumnModifySchema,
  ColumnSchema,
  DbConnection,
  DbMongoConfig,
  DbOdbcConfig,
  DbSshAuthType,
  DbSshConfig,
  DbSyncLog,
  DbSyncPreviewResult,
  DbSyncTableDetail,
  ForeignKey,
  IndexInfo,
  QueryResult,
  QueryStatementResult,
  RedisKeyEntry,
  RedisKeyInfo,
  RedisKeyMutation,
  RedisTreeChildrenPage,
  RedisTreeNode,
  TableStruct,
} from '@/utils/dbm'

export const roundDbmTaskProgress = (value: number) =>
  Number((Number(value) || 0).toFixed(2))

export const normalizeDbmTask = (
  task: DbmBackgroundTask,
): DbmBackgroundTask => ({
  ...task,
  progress: roundDbmTaskProgress(task.progress),
})

export const getDbmPluginLegacyState = async <T = unknown>(): Promise<T> => {
  return invoke<T>('get_otools_plugin_localstate', {
    plugin: DBM_PLUGIN_STATE_NAME,
  })
}

export const getDbmPluginUiState = async <T = unknown>(): Promise<T> => {
  return invoke<T>('get_otools_plugin_localstate_with_scheme', {
    plugin: DBM_PLUGIN_STATE_NAME,
    scheme: DBM_UI_STATE_SCHEME,
  })
}

export const saveDbmPluginLegacyState = async (state: unknown): Promise<void> => {
  await invoke('save_otools_plugin_localstate', {
    plugin: DBM_PLUGIN_STATE_NAME,
    state,
  })
}

export const saveDbmPluginUiState = async (state: unknown): Promise<void> => {
  await invoke('save_otools_plugin_localstate_with_scheme', {
    plugin: DBM_PLUGIN_STATE_NAME,
    scheme: DBM_UI_STATE_SCHEME,
    state,
  })
}

export const getDbmBackgroundTasks = async (): Promise<DbmBackgroundTask[]> => {
  return invoke<DbmBackgroundTask[]>('get_all_tasks')
}

export const clearCompletedDbmTasks = async (): Promise<number> => {
  return invoke<number>('clear_completed_tasks')
}

export const cancelDbmTask = async (taskId: string): Promise<void> => {
  await invoke('cancel_task', { taskId })
}

export const retryDbmTask = async (taskId: string): Promise<string> => {
  return invoke<string>('retry_task', { taskId })
}

export const copyDbmExportedFile = async (
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> => {
  return invoke<boolean>('copy_exported_file', {
    sourcePath,
    destinationPath,
  })
}
