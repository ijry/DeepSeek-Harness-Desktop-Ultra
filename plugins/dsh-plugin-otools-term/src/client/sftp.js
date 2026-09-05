/**
 * The SFTP pane: a lazy tree in the sidebar, exactly the shape the reference had.
 *
 * Worth knowing what the reference's SFTP browser was NOT, because this is a faithful
 * port of it rather than of some ideal file manager: it has no breadcrumb, no
 * detail-view columns, no multi-select, no sort control and no hidden-file toggle.
 * One `el-tree`, one search box, one context menu. The additions here are the ones a
 * browser forces or clearly deserves: drag-and-drop upload from the desktop, a
 * folder download (as a tar, since a page cannot write a tree), chmod (the reference
 * fetched the mode and never showed it), and the workspace-scoped recursive
 * transfers that replace its native file dialogs.
 */

/** The tree's per-path children cache and expansion set live in `model.sftp`. */
function sftpState() {
  return model.sftp
}

/** Reset the pane onto one server. */
function openSftpFor(serverId, path) {
  const state = sftpState()
  if (state.serverId !== serverId) {
    state.serverId = serverId
    state.children = {}
    state.expanded = {}
    state.error = ''
    state.search = { keyword: '', loading: false, items: [], truncated: false, active: false }
    state.path = typeof path === 'string' ? path : ''
  }
  void loadSftpRoot(path)
}

/** Close the pane. */
function closeSftp() {
  const state = sftpState()
  state.serverId = ''
  state.children = {}
  state.expanded = {}
  state.path = ''
  emit()
}

/** Load the starting directory (the login directory unless one was asked for). */
async function loadSftpRoot(path) {
  const state = sftpState()
  if (state.serverId.length === 0) return
  state.loading = true
  state.error = ''
  emit()
  try {
    let target = path
    if (typeof target !== 'string' || target.length === 0) target = state.path
    if (typeof target !== 'string' || target.length === 0) {
      const home = await apiGet('/sftp/home', { serverId: state.serverId })
      target = home.path
    }
    await expandTo(target)
    state.path = target
  } catch (error) {
    state.error = friendlyError(error)
  } finally {
    state.loading = false
    emit()
  }
}

/** Read one directory into the cache. */
async function loadDirectory(path, force) {
  const state = sftpState()
  if (state.children[path] !== undefined && force !== true) return state.children[path]
  const value = await apiGet('/sftp/list', { serverId: state.serverId, path })
  state.children[value.path] = { entries: value.entries, truncated: value.truncated, parent: value.parent }
  return state.children[value.path]
}

/** Expand every ancestor of a path and select it. */
async function expandTo(path) {
  const state = sftpState()
  const clean = String(path ?? '/').replace(/\\/g, '/')
  const parts = clean.split('/').filter((part) => part.length > 0)
  const chain = ['/']
  let current = ''
  for (const part of parts) {
    current += '/' + part
    chain.push(current)
  }
  for (const dir of chain) {
    try {
      await loadDirectory(dir)
      state.expanded[dir] = true
    } catch (error) {
      // A path that no longer exists must not wedge the tree at a blank pane.
      state.error = friendlyError(error)
      break
    }
  }
  state.path = clean.length === 0 ? '/' : clean
}

/** Toggle one directory. */
async function toggleDirectory(entry) {
  const state = sftpState()
  if (state.expanded[entry.path] === true) {
    delete state.expanded[entry.path]
    emit()
    return
  }
  state.expanded[entry.path] = true
  state.path = entry.path
  emit()
  try {
    await loadDirectory(entry.path)
  } catch (error) {
    toastError(error)
  }
  emit()
}

/** Re-read one directory (and the tree below it stays collapsed-as-is). */
async function refreshDirectory(path) {
  try {
    await loadDirectory(path, true)
  } catch (error) {
    toastError(error)
  }
  emit()
}

/** The directory a context action applies to. */
function contextDirectory(entry) {
  if (entry === undefined) return sftpState().path
  return entry.isDirectory ? entry.path : parentPath(entry.path)
}

// -------------------------------------------------------------------- search
/** Run the remote search (Enter, like the reference). */
async function runSearch(keyword) {
  const state = sftpState()
  const term = String(keyword ?? '').trim()
  state.search.keyword = term
  if (term.length === 0) {
    state.search = { keyword: '', loading: false, items: [], truncated: false, active: false }
    emit()
    return
  }
  state.search.active = true
  state.search.loading = true
  emit()
  try {
    const value = await apiGet('/sftp/search', { serverId: state.serverId, path: '/', keyword: term })
    state.search.items = value.items
    state.search.truncated = value.truncated === true
  } catch (error) {
    state.search.items = []
    state.search.truncated = false
    toastError(error)
  } finally {
    state.search.loading = false
    emit()
  }
}

/** Jump to one search hit. */
async function openSearchResult(item) {
  const state = sftpState()
  state.search = { keyword: '', loading: false, items: [], truncated: false, active: false }
  if (item.isDirectory) {
    await expandTo(item.path)
    emit()
    return
  }
  await expandTo(parentPath(item.path))
  emit()
  openRemoteFile(state.serverId, item.path)
}

// ------------------------------------------------------------------ actions
/** Create a directory under `dir`. */
async function createDirectory(dir) {
  const name = await promptDialog({ title: t('sftp.createDirectory'), label: t('sftp.promptName') })
  if (name === undefined) return
  try {
    await apiPost('/sftp/mkdir', { serverId: sftpState().serverId, path: joinPath(dir, name) })
    await refreshDirectory(dir)
    toast(t('sftp.createDirectorySuccess'), 'success')
  } catch (error) {
    toastError(error)
  }
}

/** Create an empty file under `dir`, then open it in the editor. */
async function createFile(dir) {
  const name = await promptDialog({ title: t('sftp.createFile'), label: t('sftp.promptName') })
  if (name === undefined) return
  const path = joinPath(dir, name)
  try {
    await apiPost('/sftp/create-file', { serverId: sftpState().serverId, path })
    await refreshDirectory(dir)
    toast(t('sftp.createFileSuccess'), 'success')
    openRemoteFile(sftpState().serverId, path)
  } catch (error) {
    toastError(error)
  }
}

/** Rename one entry. */
async function renameEntry(entry) {
  const name = await promptDialog({ title: t('sftp.rename'), label: t('sftp.promptName'), value: entry.name })
  if (name === undefined || name === entry.name) return
  const dir = parentPath(entry.path)
  try {
    const value = await apiPost('/sftp/rename', { serverId: sftpState().serverId, from: entry.path, to: joinPath(dir, name) })
    renamePathInTabs(value.from, value.to, entry.isDirectory)
    await refreshDirectory(dir)
    toast(t('sftp.renameSuccess'), 'success')
  } catch (error) {
    toastError(error)
  }
}

/** Delete one entry, with the reference's two confirmation texts. */
async function deleteEntry(entry) {
  const go = await confirmDialog({
    title: t('sftp.deleteConfirmTitle'),
    message: entry.isDirectory
      ? t('sftp.deleteDirectoryConfirm', { name: entry.name })
      : t('sftp.deleteFileConfirm', { name: entry.name }),
    danger: true,
    confirmLabel: t('main.delete'),
  })
  if (!go) return
  const dir = parentPath(entry.path)
  try {
    await apiPost('/sftp/delete', { serverId: sftpState().serverId, path: entry.path })
    closeTabsUnder(entry.path, entry.isDirectory)
    await refreshDirectory(dir)
    toast(t('sftp.deleteSuccess'), 'success')
  } catch (error) {
    toastError(error)
  }
}

/** Change one entry's mode. */
async function chmodEntry(entry) {
  const value = await promptDialog({
    title: t('sftp.chmodTitle', { name: entry.name }),
    label: t('sftp.chmodMode'),
    value: (entry.mode ?? 0o644).toString(8).padStart(3, '0'),
    hint: entry.permissions,
  })
  if (value === undefined) return
  try {
    const result = await apiPost('/sftp/chmod', { serverId: sftpState().serverId, path: entry.path, mode: value })
    await refreshDirectory(parentPath(entry.path))
    toast(t('sftp.chmodSuccess', { mode: result.permissions }), 'success')
  } catch (error) {
    toastError(error)
  }
}

/** Add one directory to the favourites. */
async function favoriteDirectory(path) {
  const state = sftpState()
  const current = favoriteDirsOf(state.serverId)
  if (current.includes(path)) {
    toast(t('main.directoryAlreadyFavorited'), 'warning')
    return
  }
  try {
    await apiPost('/favorites', { serverId: state.serverId, paths: [...current, path] })
    await loadState()
    toast(t('sftp.favoriteAdded'), 'success')
  } catch (error) {
    toastError(error)
  }
}

/** Drop one favourite. */
async function unfavoriteDirectory(serverId, path) {
  try {
    await apiPost('/favorites', { serverId, paths: favoriteDirsOf(serverId).filter((row) => row !== path) })
    await loadState()
  } catch (error) {
    toastError(error)
  }
}

/** Upload a FileList into one remote directory, one request per file. */
async function uploadFiles(dir, files) {
  const state = sftpState()
  if (files.length === 0) return
  let done = 0
  for (const file of files) {
    try {
      // `webkitRelativePath` is set when a whole folder was picked or dropped, and it
      // is what lets the host recreate the tree instead of flattening it.
      const name = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : file.name
      await uploadFile(state.serverId, dir, file, name)
      done += 1
    } catch (error) {
      toast(t('sftp.uploadFailed', { message: friendlyError(error) }), 'error')
    }
  }
  await refreshDirectory(dir)
  if (done > 0) toast(t('sftp.uploadDone', { count: done }), 'success')
}

/** Open the browser's file picker and upload into `dir`. */
function pickAndUpload(dir, directory) {
  const picker = el('input', { type: 'file', multiple: true, style: { display: 'none' } })
  if (directory === true) {
    // Chromium-only; on a browser without it the picker simply stays file-wise.
    picker.setAttribute('webkitdirectory', '')
    picker.setAttribute('directory', '')
  }
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])]
    picker.remove()
    void uploadFiles(dir, files)
  })
  document.body.append(picker)
  picker.click()
}

/** Start a workspace-scoped transfer (the replacement for the native dialogs). */
function openWorkspaceTransfer(kind, remotePath) {
  const state = sftpState()
  if (model.workspaces.length === 0) {
    toast(t('sftp.workspaceEmpty'), 'warning')
    return
  }
  let workspaceId = model.workspaces[0].id
  let relative = ''
  openDialog({
    title: kind === 'upload' ? t('sftp.context.uploadFromWorkspace') : t('sftp.context.downloadToWorkspace'),
    size: 'small',
    build: () => [
      el('div', { class: 'dsh-ot-field-hint' }, remotePath),
      field(t('sftp.selectWorkspace'),
        select(model.workspaces.map((row) => ({ id: row.id, label: row.title + ' — ' + row.path })), workspaceId, (value) => {
          workspaceId = value
        })),
      field(t('sftp.workspaceRelative'), input({ value: '', onInput: (event) => {
        relative = event.target.value
      } })),
    ],
    footer: (close) => [
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      button({
        label: t('main.confirm'),
        variant: 'primary',
        onClick: async () => {
          close(undefined)
          try {
            if (kind === 'upload') {
              await apiPost('/transfer/upload-workspace', {
                serverId: state.serverId,
                workspaceId,
                relative,
                remoteDir: remotePath,
              })
            } else {
              await apiPost('/transfer/download-workspace', {
                serverId: state.serverId,
                path: remotePath,
                workspaceId,
                relative,
              })
            }
            model.drawerOpen = true
            toast(t('sftp.transferStarted'), 'success')
            emit()
          } catch (error) {
            toastError(error)
          }
        },
      }),
    ],
  })
}

// ------------------------------------------------------------------ render
/**
 * The search box, built once and reused.
 *
 * A repaint is triggered by anything that changes the model — a transfer frame every
 * 250 ms, a session status — and rebuilding this input would throw away whatever the
 * user was halfway through typing. So the element is kept and only re-parented.
 */
let searchInputEl = null

/** The persistent search input. */
function sftpSearchInput() {
  if (searchInputEl !== null) return searchInputEl
  searchInputEl = input({
    placeholder: t('sftp.searchPlaceholder'),
    onInput: (event) => {
      // Remembered without a repaint: Enter is what starts the search, exactly as the
      // reference did it.
      sftpState().search.keyword = event.target.value
    },
    onKeydown: (event) => {
      if (event.key === 'Enter') void runSearch(event.target.value)
      if (event.key === 'Escape') {
        event.target.value = ''
        void runSearch('')
      }
    },
  })
  return searchInputEl
}

/** The whole pane: head, path, search, then the tree or the search results. */
function renderSftpPane(host) {
  const state = sftpState()
  const server = serverById(state.serverId)
  if (server === undefined) {
    fill(host)
    return
  }
  const status = connectionState(state.serverId)
  const head = el('div', { class: 'dsh-ot-sftp-head' },
    el('span', { class: 'dsh-ot-sftp-title' }, t('sftp.title')),
    tag(t('sftp.status.' + (status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : 'disconnected')),
      status === 'connected' ? 'success' : status === 'error' ? 'danger' : undefined),
    el('span', { style: { flex: '1' } }),
    iconButton('arrowUp', { variant: 'ghost', title: t('sftp.goUp'), onClick: () => void expandThenEmit(parentPath(state.path)) }),
    iconButton('home', { variant: 'ghost', title: t('sftp.goHome'), onClick: () => void loadSftpRoot('') }),
    iconButton('upload', { variant: 'ghost', title: t('sftp.uploadFile'), onClick: () => pickAndUpload(state.path, false) }),
    iconButton('refresh', { variant: 'ghost', title: t('sftp.refreshDirectory'), onClick: () => void refreshDirectory(state.path) }))

  const body = state.search.active ? renderSearchResults() : renderTree()
  fill(host,
    head,
    el('div', { class: 'dsh-ot-sftp-path', title: state.path }, state.path),
    el('div', { class: 'dsh-ot-sftp-search' }, sftpSearchInput()),
    body)
  wireDrop(host, () => state.path)
}

/** Expand to a path and repaint. */
async function expandThenEmit(path) {
  try {
    await expandTo(path)
  } catch (error) {
    toastError(error)
  }
  emit()
}

/** The lazy tree, rooted at '/' and pre-expanded down to the current path. */
function renderTree() {
  const state = sftpState()
  const wrap = el('div', { class: 'dsh-ot-sftp-tree' })
  if (state.error.length > 0) wrap.append(el('div', { class: 'dsh-ot-sftp-error' }, state.error))
  const root = { name: '/', path: '/', isDirectory: true }
  wrap.append(...renderNode(root, 0))
  if (state.loading) wrap.append(el('div', { class: 'dsh-ot-sftp-hint' }, t('main.connecting')))
  return wrap
}

/** One row, plus its children when expanded. */
function renderNode(entry, depth) {
  const state = sftpState()
  const expanded = entry.isDirectory && state.expanded[entry.path] === true
  const row = el('div', {
    class: 'dsh-ot-node',
    'data-active': state.path === entry.path ? 'true' : undefined,
    style: { 'padding-left': (6 + depth * 12) + 'px' },
    onClick: () => {
      if (entry.isDirectory) void toggleDirectory(entry)
      else openRemoteFile(state.serverId, entry.path)
    },
    onContextmenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      openSftpMenu(entry, event.clientX, event.clientY)
    },
  },
  el('span', { class: 'dsh-ot-node-twist' }, entry.isDirectory ? (expanded ? '▾' : '▸') : ''),
  el('span', { class: 'dsh-ot-node-icon', 'data-kind': entry.isDirectory ? 'dir' : 'file' },
    icon(entry.isDirectory ? 'folder' : (entry.isSymlink === true ? 'link' : 'file'), 14)),
  el('span', { class: 'dsh-ot-node-name', title: entry.path }, entry.name),
  entry.isSymlink === true && typeof entry.linkTarget === 'string'
    ? el('span', { class: 'dsh-ot-node-link', title: entry.linkTarget }, t('sftp.linkTo', { target: entry.linkTarget }))
    : undefined,
  entry.isDirectory !== true && typeof entry.size === 'number'
    ? el('span', { class: 'dsh-ot-node-size' }, formatBytes(entry.size))
    : undefined)

  const rows = [row]
  if (!expanded) return rows
  const cached = state.children[entry.path]
  if (cached === undefined) {
    rows.push(el('div', { class: 'dsh-ot-sftp-hint', style: { 'padding-left': (18 + depth * 12) + 'px' } }, t('main.connecting')))
    return rows
  }
  if (cached.truncated === true) {
    rows.push(el('div', { class: 'dsh-ot-sftp-hint' }, t('sftp.truncated', { count: cached.entries.length })))
  }
  for (const child of cached.entries) rows.push(...renderNode(child, depth + 1))
  if (cached.entries.length === 0) {
    rows.push(el('div', { class: 'dsh-ot-sftp-hint', style: { 'padding-left': (18 + depth * 12) + 'px' } }, t('sftp.entryCount', { count: 0 })))
  }
  return rows
}
/** The search-results panel, with the reference's four states. */
function renderSearchResults() {
  const state = sftpState()
  const wrap = el('div', { class: 'dsh-ot-sftp-tree' })
  const meta = state.search.loading
    ? t('sftp.searching')
    : state.search.truncated
      ? t('sftp.searchResultTooMany')
      : t('sftp.searchResultCount', { count: state.search.items.length })
  wrap.append(el('div', { class: 'dsh-ot-sftp-head' },
    el('span', { class: 'dsh-ot-sftp-title' }, t('sftp.searchResults')),
    el('span', { style: { flex: '1' } }),
    el('span', { class: 'dsh-ot-field-hint' }, meta),
    iconButton('close', { variant: 'ghost', title: t('main.close'), onClick: () => void runSearch('') })))
  if (state.search.loading) {
    wrap.append(el('div', { class: 'dsh-ot-sftp-hint' }, t('sftp.searchingRemote')))
    return wrap
  }
  if (state.search.truncated) wrap.append(el('div', { class: 'dsh-ot-sftp-hint' }, t('sftp.searchTooMany')))
  if (state.search.items.length === 0) {
    wrap.append(el('div', { class: 'dsh-ot-sftp-hint' }, t('sftp.searchEmpty')))
    return wrap
  }
  for (const item of state.search.items) {
    wrap.append(el('div', {
      class: 'dsh-ot-search-row',
      onClick: () => void openSearchResult(item),
      onContextmenu: (event) => {
        event.preventDefault()
        openSftpMenu({ ...item, mode: undefined, permissions: undefined }, event.clientX, event.clientY)
      },
    },
    el('div', { class: 'dsh-ot-search-name' },
      el('span', { class: 'dsh-ot-node-icon', 'data-kind': item.isDirectory ? 'dir' : 'file' },
        icon(item.isDirectory ? 'folder' : 'file', 14)),
      el('span', {}, item.name)),
    el('div', { class: 'dsh-ot-search-path', title: item.path }, item.path)))
  }
  return wrap
}

/**
 * The context menu: the reference's ten items in the reference's order, plus the four
 * this port adds (edit, chmod, and the two workspace transfers).
 */
function openSftpMenu(entry, x, y) {
  const state = sftpState()
  const dir = contextDirectory(entry)
  const isRoot = entry.path === '/'
  const items = []
  if (entry.isDirectory) {
    items.push({ label: t('sftp.context.createDirectory'), icon: 'folder', onClick: () => void createDirectory(entry.path) })
    items.push({ label: t('sftp.context.createFile'), icon: 'file', onClick: () => void createFile(entry.path) })
    items.push({ label: t('sftp.context.upload'), icon: 'upload', onClick: () => pickAndUpload(entry.path, false) })
    items.push({ label: t('sftp.uploadFolder'), icon: 'upload', onClick: () => pickAndUpload(entry.path, true) })
    items.push({ label: t('sftp.context.favoriteDirectory'), icon: 'folder-star', onClick: () => void favoriteDirectory(entry.path) })
    items.push({ label: t('sftp.context.openInTerminal'), icon: 'terminal', onClick: () => openTerminalAt(state.serverId, entry.path) })
    items.push({ separator: true })
    items.push({ label: t('sftp.context.download'), icon: 'download', onClick: () => downloadPath(state.serverId, entry.path, 'tar') })
    items.push({ label: t('sftp.context.uploadFromWorkspace'), icon: 'upload', onClick: () => openWorkspaceTransfer('upload', entry.path) })
    items.push({ label: t('sftp.context.downloadToWorkspace'), icon: 'download', onClick: () => openWorkspaceTransfer('download', entry.path) })
  } else {
    items.push({ label: t('sftp.context.edit'), icon: 'edit', onClick: () => openRemoteFile(state.serverId, entry.path) })
    items.push({ label: t('sftp.context.download'), icon: 'download', onClick: () => downloadPath(state.serverId, entry.path, 'file') })
    items.push({ label: t('sftp.context.downloadToWorkspace'), icon: 'download', onClick: () => openWorkspaceTransfer('download', entry.path) })
  }
  items.push({ separator: true })
  items.push({ label: t('sftp.context.copyPath'), icon: 'copy', onClick: () => void copyText(entry.path, t('sftp.pathCopied')) })
  items.push({ label: t('sftp.context.rename'), icon: 'edit', disabled: isRoot, onClick: () => void renameEntry(entry) })
  items.push({ label: t('sftp.context.chmod'), icon: 'lock', disabled: isRoot, onClick: () => void chmodEntry(entry) })
  items.push({ label: t('sftp.context.delete'), icon: 'trash', tone: 'danger', disabled: isRoot, onClick: () => void deleteEntry(entry) })
  items.push({ separator: true })
  items.push({ label: t('sftp.context.refresh'), icon: 'refresh', onClick: () => void refreshDirectory(dir) })
  openContextMenu(x, y, items, entry.name === '/' ? t('sftp.serverFile') : entry.name)
}

/**
 * Drag-and-drop upload.
 *
 * `webkitGetAsEntry` walks a dropped FOLDER, which is the only way a page can upload
 * a tree; browsers without it still get the flat file list.
 */
function wireDrop(host, dirOf) {
  host.addEventListener('dragover', (event) => {
    event.preventDefault()
    setData(host, 'drop', true)
  })
  host.addEventListener('dragleave', (event) => {
    if (event.target !== host) return
    delete host.dataset.drop
  })
  host.addEventListener('drop', (event) => {
    event.preventDefault()
    delete host.dataset.drop
    const dir = dirOf()
    void collectDropped(event.dataTransfer).then((files) => uploadFiles(dir, files))
  })
}

/** Flatten a DataTransfer into a list of files with relative paths. */
async function collectDropped(transfer) {
  if (transfer === null || transfer === undefined) return []
  const items = [...(transfer.items ?? [])]
  const entries = items.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((row) => row !== null)
  if (entries.length === 0) return [...(transfer.files ?? [])]
  const files = []
  const walkEntry = async (fsEntry, prefix) => {
    if (fsEntry.isFile) {
      const file = await new Promise((resolvePromise) => fsEntry.file(resolvePromise, () => resolvePromise(null)))
      if (file !== null) {
        // The relative path is carried on the File the same way the folder picker
        // does it, so the host takes one code path for both.
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: prefix + fsEntry.name, configurable: true })
        } catch { /* a File that refuses the property still uploads flat */ }
        files.push(file)
      }
      return
    }
    if (!fsEntry.isDirectory) return
    const reader = fsEntry.createReader()
    // readEntries returns at most 100 per call, so it has to be drained.
    for (;;) {
      const batch = await new Promise((resolvePromise) => reader.readEntries(resolvePromise, () => resolvePromise([])))
      if (batch.length === 0) break
      for (const child of batch) await walkEntry(child, prefix + fsEntry.name + '/')
    }
  }
  for (const fsEntry of entries) await walkEntry(fsEntry, '')
  return files
}
