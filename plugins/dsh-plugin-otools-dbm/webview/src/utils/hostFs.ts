/**
 * Host filesystem access for the panel.
 *
 * In the reference plugin these were thin wrappers over the OTools shell's host
 * bridge. Here they are `dbm_fs_*` commands on the plugin's own host half, which
 * is the only process that can see the machine the databases actually live on.
 *
 * Only what the panel calls is implemented — listing, home, join, mkdir, write.
 * Deliberately absent: delete/rename/read, because no panel view uses them and a
 * database manager has no business shipping a general file manager.
 */
import { invoke } from '@tauri-apps/api/core'

export interface HostDirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedAt: number
}

export interface HostDirListing {
  path: string
  parent: string
  entries: HostDirEntry[]
}

export interface HostWriteFileRequest {
  path: string
  dataBase64: string
}

/** The host user's home directory. */
export const homeHostDir = async (): Promise<string> => invoke<string>('dbm_fs_home_dir')

/** Join path segments with the host's separator. */
export const joinHostPath = async (...paths: string[]): Promise<string> =>
  invoke<string>('dbm_fs_join_path', { paths: paths.filter((part) => part !== undefined && part !== null) })

/** List one directory; an empty path means the home directory. */
export const listHostDir = async (path: string): Promise<HostDirListing> =>
  invoke<HostDirListing>('dbm_fs_list_dir', { path })

/** Create a directory (recursively). */
export const createHostDir = async (path: string): Promise<void> => {
  await invoke('dbm_fs_create_dir', { path })
}

/** Write a file from base64 content. */
export const writeHostFile = async (request: HostWriteFileRequest): Promise<void> => {
  await invoke('dbm_fs_write_file', request)
}

/** Reveal a path in the host's file manager. */
export const revealHostPath = async (path: string): Promise<void> => {
  await invoke('dbm_fs_reveal', { path })
}
