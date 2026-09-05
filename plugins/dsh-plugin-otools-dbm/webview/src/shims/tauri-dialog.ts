/**
 * Tauri's file dialogs, re-implemented as an in-app browser over the host FS.
 *
 * The reference plugin opened the OS dialog through `@tauri-apps/plugin-dialog`.
 * A browser tab cannot do that, and it must not: the paths the panel needs
 * (export targets, .sql dumps, SQLite files, SSH keys) live on the machine the
 * *host* runs on, which is not necessarily the machine the browser runs on. So
 * `open()` and `save()` keep their signatures and their return contracts, but the
 * chooser is `HostPathPicker.vue` driving `dbm_fs_*` host routes.
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'

import HostPathPicker from '../platform/ui/common/HostPathPicker.vue'

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
  multiple?: boolean
  directory?: boolean
  recursive?: boolean
  canCreateDirectories?: boolean
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
  canCreateDirectories?: boolean
}

type PickerMode = 'open' | 'directory' | 'save'

const showPicker = (props: {
  mode: PickerMode
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
  multiple?: boolean
}): Promise<string | string[] | null> => {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let settled = false

    const finish = (value: string | string[] | null) => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
      window.setTimeout(() => {
        app.unmount()
        container.remove()
      }, 0)
    }

    const app = createApp(HostPathPicker, {
      ...props,
      onPicked: (value: string | string[] | null) => finish(value),
      onCancelled: () => finish(null),
    })
    app.use(ElementPlus)
    app.mount(container)
  })
}

/** Pick an existing file (or files), or a directory when `directory` is set. */
export const open = async (
  options: OpenDialogOptions = {},
): Promise<string | string[] | null> =>
  showPicker({
    mode: options.directory ? 'directory' : 'open',
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
    multiple: options.multiple === true,
  })

/** Pick a destination path, existing or not. */
export const save = async (options: SaveDialogOptions = {}): Promise<string | null> => {
  const picked = await showPicker({
    mode: 'save',
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  })
  return typeof picked === 'string' ? picked : null
}
