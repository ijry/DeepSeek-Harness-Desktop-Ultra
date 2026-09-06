/**
 * `@tauri-apps/plugin-dialog` stand-in: an in-panel browser over the HOST filesystem.
 *
 * A browser tab cannot open an OS file dialog, and the paths these dialogs produce are
 * consumed by the host anyway — `import_official_route_credentials_from_files` reads
 * `~/.codex/auth.json` on the machine dsh runs on, not a blob the browser uploaded.
 * So the picker is drawn here and the listing comes from the host over
 * `panel_fs_browse`.
 *
 * Deliberately dependency-free vanilla DOM: it is opened from callbacks all over the
 * React tree, so it must not need a mount point, a portal, or a render pass.
 */
import { panelCall } from './panel-base'

type Filter = { name: string; extensions: string[] }

export type OpenDialogOptions = {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
  filters?: Filter[]
  recursive?: boolean
}

type Entry = { name: string; path: string; directory: boolean }
type Listing = { path: string; parent: string | null; home: string; entries: Entry[] }

const STYLE_ID = 'dsh-ai-switch-picker-style'

const STYLES = `
.dsw-pick-backdrop {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(28, 25, 23, .45);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1917;
}
.dsw-pick-card {
  display: flex; flex-direction: column; gap: 10px; width: min(680px, 100%);
  max-height: min(560px, 100%); padding: 16px; border-radius: 16px; background: #fff;
  box-shadow: 0 24px 60px rgba(28, 25, 23, .28);
}
.dsw-pick-title { font-size: 14px; font-weight: 600; }
.dsw-pick-path {
  width: 100%; padding: 7px 10px; border: 1px solid #d6d3d1; border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.dsw-pick-list {
  flex: 1; overflow: auto; min-height: 160px; border: 1px solid #e7e5e4;
  border-radius: 12px; background: #fafaf9;
}
.dsw-pick-row {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px;
  border: 0; border-bottom: 1px solid #f5f5f4; background: transparent; font: inherit;
  color: inherit; text-align: left; cursor: pointer;
}
.dsw-pick-row:hover { background: #f5f5f4; }
.dsw-pick-row[data-selected="true"] { background: #dbeafe; }
.dsw-pick-row-icon { flex: none; width: 16px; text-align: center; color: #78716c; }
.dsw-pick-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsw-pick-empty { padding: 16px; color: #78716c; }
.dsw-pick-error { color: #b91c1c; font-weight: 600; }
.dsw-pick-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsw-pick-hint { color: #78716c; font-size: 12px; }
.dsw-pick-btn {
  padding: 7px 14px; border: 1px solid #d6d3d1; border-radius: 10px; background: #fff;
  font: inherit; font-weight: 600; cursor: pointer;
}
.dsw-pick-btn[data-primary="true"] { border-color: #1d4ed8; background: #1d4ed8; color: #fff; }
.dsw-pick-btn:disabled { opacity: .5; cursor: not-allowed; }
`

function ensureStyles() {
  if (document.getElementById(STYLE_ID) !== null) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
}

function allowed(entry: Entry, filters: Filter[]) {
  if (entry.directory || filters.length === 0) {
    return true
  }
  const lower = entry.name.toLowerCase()
  return filters.some((filter) =>
    filter.extensions.some(
      (extension) => extension === '*' || lower.endsWith(`.${extension.toLowerCase().replace(/^\./, '')}`),
    ),
  )
}

/**
 * The picker. Resolves with host paths, or null when the user cancels — the exact
 * contract the reference's call sites already handle.
 */
export function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null)
  }
  ensureStyles()

  const directory = options.directory === true
  const multiple = options.multiple === true
  const filters = options.filters ?? []
  const selected = new Set<string>()
  let listing: Listing | null = null

  const backdrop = document.createElement('div')
  backdrop.className = 'dsw-pick-backdrop'
  const card = document.createElement('div')
  card.className = 'dsw-pick-card'
  const title = document.createElement('div')
  title.className = 'dsw-pick-title'
  title.textContent = options.title ?? (directory ? '选择文件夹 / Choose a folder' : '选择文件 / Choose a file')
  const pathInput = document.createElement('input')
  pathInput.className = 'dsw-pick-path'
  pathInput.spellcheck = false
  const list = document.createElement('div')
  list.className = 'dsw-pick-list'
  const foot = document.createElement('div')
  foot.className = 'dsw-pick-foot'
  const hint = document.createElement('div')
  hint.className = 'dsw-pick-hint'
  const buttons = document.createElement('div')
  const cancel = document.createElement('button')
  cancel.className = 'dsw-pick-btn'
  cancel.type = 'button'
  cancel.textContent = '取消 / Cancel'
  const confirmButton = document.createElement('button')
  confirmButton.className = 'dsw-pick-btn'
  confirmButton.dataset.primary = 'true'
  confirmButton.type = 'button'
  confirmButton.textContent = '选择 / Select'
  buttons.append(cancel, confirmButton)
  foot.append(hint, buttons)
  card.append(title, pathInput, list, foot)
  backdrop.append(card)
  document.body.appendChild(backdrop)

  return new Promise((resolve) => {
    let settled = false

    const close = (value: string | string[] | null) => {
      if (settled) {
        return
      }
      settled = true
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve(value)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        close(null)
      }
    }
    document.addEventListener('keydown', onKey, true)

    const paint = () => {
      list.replaceChildren()
      if (listing === null) {
        const empty = document.createElement('div')
        empty.className = 'dsw-pick-empty'
        empty.textContent = '正在读取… / Loading…'
        list.append(empty)
        return
      }
      const rows: HTMLElement[] = []
      if (listing.parent !== null) {
        rows.push(row({ name: '..', path: listing.parent, directory: true }, true))
      }
      for (const entry of listing.entries) {
        if (allowed(entry, filters)) {
          rows.push(row(entry, false))
        }
      }
      if (rows.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'dsw-pick-empty'
        empty.textContent = '这里没有可选项。 / Nothing selectable here.'
        list.append(empty)
        return
      }
      list.replaceChildren(...rows)
    }

    const row = (entry: Entry, up: boolean) => {
      const button = document.createElement('button')
      button.className = 'dsw-pick-row'
      button.type = 'button'
      button.dataset.selected = selected.has(entry.path) ? 'true' : 'false'
      const icon = document.createElement('span')
      icon.className = 'dsw-pick-row-icon'
      icon.textContent = up ? '↑' : entry.directory ? '▸' : '·'
      const name = document.createElement('span')
      name.className = 'dsw-pick-row-name'
      name.textContent = entry.name
      button.append(icon, name)
      button.addEventListener('click', () => {
        // Directory-mode selects folders and needs a double click to descend; file-mode
        // descends on a single click, because a folder is never a valid answer there.
        if (entry.directory && (up || !directory)) {
          void load(entry.path)
          return
        }
        if (multiple) {
          if (selected.has(entry.path)) {
            selected.delete(entry.path)
          } else {
            selected.add(entry.path)
          }
        } else {
          selected.clear()
          selected.add(entry.path)
        }
        updateFoot()
        paint()
      })
      if (entry.directory) {
        button.addEventListener('dblclick', () => {
          void load(entry.path)
        })
      }
      return button
    }

    const updateFoot = () => {
      const count = selected.size
      hint.textContent =
        count === 0
          ? directory
            ? '点选一个文件夹，双击进入。 / Click a folder to select, double-click to enter.'
            : '点选文件，双击文件夹进入。 / Click files, double-click folders to enter.'
          : `已选择 ${count} 项 / ${count} selected`
      confirmButton.disabled = count === 0
    }

    const load = async (path?: string) => {
      listing = null
      paint()
      try {
        listing = await panelCall<Listing>('panel_fs_browse', { path: path ?? null })
        selected.clear()
        pathInput.value = listing.path
        updateFoot()
        paint()
      } catch (error) {
        const box = document.createElement('div')
        box.className = 'dsw-pick-empty dsw-pick-error'
        box.textContent = error instanceof Error ? error.message : String(error)
        list.replaceChildren(box)
      }
    }

    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void load(pathInput.value.trim())
      }
    })
    cancel.addEventListener('click', () => close(null))
    confirmButton.addEventListener('click', () => {
      const values = Array.from(selected)
      close(multiple ? values : (values[0] ?? null))
    })
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        close(null)
      }
    })

    updateFoot()
    void load(options.defaultPath)
  })
}

/** Not offered: the panel downloads through the browser instead of writing host files. */
export async function save(_options?: unknown): Promise<string | null> {
  throw new Error('Saving to a host path is not available in the dsh panel; use the download button')
}

export async function message(text: string): Promise<void> {
  window.alert(text)
}

export async function ask(text: string): Promise<boolean> {
  return window.confirm(text)
}

export async function confirm(text: string): Promise<boolean> {
  return window.confirm(text)
}
