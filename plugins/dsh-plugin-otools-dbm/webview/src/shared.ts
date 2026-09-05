export const DBM_PLUGIN_STATE_NAME = 'dbm'
export const DBM_UI_STATE_SCHEME = 'ui'

export interface DbmBackgroundTask {
  id: string
  name: string
  task_type: string
  status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled'
  progress: number
  created_at: string
  updated_at: string
  duration: number
  result_path?: string
  error_message?: string
  metadata: Record<string, string>
}
