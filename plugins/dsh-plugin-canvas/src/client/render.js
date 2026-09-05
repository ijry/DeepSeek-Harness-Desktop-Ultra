/**
 * Node DOM: build once per element, update in place afterwards.
 *
 * In-place updates are not an optimization here, they are a correctness
 * requirement: a note being edited holds a `<textarea>` with the caret in it and
 * a region being renamed holds a focused `<input>`, and rebuilding their subtree
 * on the next frame would throw both away mid-keystroke. Each element caches its
 * child references on itself (`el._parts`).
 *
 * Interaction lives in client/interact.js; this module only paints, and marks
 * clickable chrome with `data-act` for one delegated click handler.
 *
 * @module dsh-plugin-canvas/client/render
 */

/**
 * Every user-visible string in both languages, mirroring codeg-plus's `Canvas`
 * i18n namespace.
 *
 * Entries that carry a value are functions: the counts in the chrome, and the
 * failure toasts, which take the message the host sent. The punctuation belongs
 * inside the entry — a Chinese toast joins its detail with a full-width colon and
 * an English one does not.
 */
export const STRINGS = {
  zh: {
    title: '无限会话',
    untitled: '未命名会话',
    unresolvedSession: '会话已删除',
    removeCard: '移除卡片',
    unresolvedWorkspace: '工作区不可用',
    unresolvedWorkspaceHint: '绑定的工作区已从注册表移除。重新添加后此区域会自动恢复。',
    customRegion: '收藏区',
    workspaceRegion: '工作区',
    agentRegion: '智能体',
    runningCount: (n) => `${n} 个进行中`,
    rename: '重命名',
    collapse: '折叠',
    expand: '展开',
    color: '颜色',
    removeRegion: '移除区域',
    removeNote: '删除便签',
    showMore: (n) => `还有 ${n} 个`,
    showAllMembers: '显示全部会话',
    showFewerMembers: '收起多余会话',
    emptyRegion: '这里还没有会话',
    emptyCustomHint: '把会话卡片拖到这里收集',
    notePlaceholder: '写点什么…',
    noteEmptyHint: '双击开始编辑',
    addNode: '添加到画布',
    newSession: '新建会话',
    newSessionIn: '在哪个工作区新建',
    addWorkspaceRegion: '工作区区域',
    addAgentRegion: '智能体区域',
    addSessionCard: '会话卡片',
    addCustomRegion: '自定义区域',
    addNote: '便签卡片',
    searchSessions: '搜索会话…',
    noWorkspaces: '没有工作区',
    noSessions: '未找到会话',
    noAgents: '没有智能体预设',
    fitView: '适应视图',
    zoomIn: '放大',
    zoomOut: '缩小',
    resetZoom: '重置缩放为 100%',
    showMinimap: '显示导航地图',
    hideMinimap: '隐藏导航地图',
    autoArrange: '自动整理',
    empty: '画布还是空的',
    emptyHint: '用空间方式梳理工作：区域对应工作区和智能体，卡片对应会话，便签记录其它。',
    seedFromWorkspaces: '从当前工作区生成',
    grid: '网格',
    gridColumns: '列数',
    gridRows: '行数',
    gridAuto: '自动',
    createRegionFromSelection: '收进新区域',
    selectedCount: (n) => `已选 ${n} 个`,
    openInGui: '在会话界面打开',
    expandSession: '展开会话',
    collapseSession: '收起会话',
    removeFromRegion: '从区域移除',
    detachToCanvas: '移出到画布',
    deleteSelected: '删除所选',
    confirmDeleteTitle: '删除选中内容？',
    confirmDeleteNotes: (n) => `你写下的 ${n} 条便签将被永久删除，此操作无法撤销。`,
    confirmDeleteCancel: '取消',
    confirmDeleteConfirm: '删除',
    canvasActions: '画布操作',
    viewportControls: '视图',
    mergeIntoNewRegion: '新建区域',
    transcriptEmpty: '这个会话还没有内容',
    transcriptFailed: '读取会话内容失败',
    loading: '载入中…',
    saveFailed: (m) => `保存失败：${m}`,
    createFailed: (m) => `创建失败：${m}`,
    moveFailed: (m) => `移动失败：${m}`,
    deleteFailed: (m) => `删除失败：${m}`,
    detachFailed: (m) => `移出失败：${m}`,
    groupFailed: (m) => `收进区域失败：${m}`,
    noSessionNav: '这个 dsh 版本没有暴露会话导航接口',
    openSessionFailed: (m) => `打开会话失败：${m}`,
    newSessionFailed: (m) => `新建会话失败：${m}`,
  },
  en: {
    title: 'Infinite Sessions',
    untitled: 'Untitled session',
    unresolvedSession: 'Session deleted',
    removeCard: 'Remove card',
    unresolvedWorkspace: 'Workspace unavailable',
    unresolvedWorkspaceHint:
      'The bound workspace was removed from the registry. Add it back and this region returns on its own.',
    customRegion: 'Collection',
    workspaceRegion: 'Workspace',
    agentRegion: 'Agent',
    runningCount: (n) => `${n} running`,
    rename: 'Rename',
    collapse: 'Collapse',
    expand: 'Expand',
    color: 'Color',
    removeRegion: 'Remove region',
    removeNote: 'Delete note',
    showMore: (n) => `${n} more`,
    showAllMembers: 'Show all sessions',
    showFewerMembers: 'Show fewer sessions',
    emptyRegion: 'No sessions here yet',
    emptyCustomHint: 'Drag session cards here to collect them',
    notePlaceholder: 'Write something…',
    noteEmptyHint: 'Double-click to edit',
    addNode: 'Add to canvas',
    newSession: 'New session',
    newSessionIn: 'New session in',
    addWorkspaceRegion: 'Workspace region',
    addAgentRegion: 'Agent region',
    addSessionCard: 'Session card',
    addCustomRegion: 'Custom region',
    addNote: 'Sticky note',
    searchSessions: 'Search sessions…',
    noWorkspaces: 'No workspaces',
    noSessions: 'No sessions found',
    noAgents: 'No agent presets',
    fitView: 'Fit to view',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetZoom: 'Reset zoom to 100%',
    showMinimap: 'Show minimap',
    hideMinimap: 'Hide minimap',
    autoArrange: 'Auto arrange',
    empty: 'The canvas is empty',
    emptyHint:
      'Lay your work out in space: regions for workspaces and agents, cards for sessions, notes for everything else.',
    seedFromWorkspaces: 'Build from current workspaces',
    grid: 'Grid',
    gridColumns: 'Columns',
    gridRows: 'Rows',
    gridAuto: 'Auto',
    createRegionFromSelection: 'Collect into a new region',
    selectedCount: (n) => `${n} selected`,
    openInGui: 'Open in the session view',
    expandSession: 'Expand session',
    collapseSession: 'Collapse session',
    removeFromRegion: 'Remove from region',
    detachToCanvas: 'Move out to the canvas',
    deleteSelected: 'Delete selection',
    confirmDeleteTitle: 'Delete the selection?',
    confirmDeleteNotes: (n) =>
      `${n} note${n === 1 ? '' : 's'} you wrote will be deleted for good. This cannot be undone.`,
    confirmDeleteCancel: 'Cancel',
    confirmDeleteConfirm: 'Delete',
    canvasActions: 'Canvas actions',
    viewportControls: 'View',
    mergeIntoNewRegion: 'New region',
    transcriptEmpty: 'Nothing in this session yet',
    transcriptFailed: 'Could not read the session',
    loading: 'Loading…',
    saveFailed: (m) => `Save failed: ${m}`,
    createFailed: (m) => `Create failed: ${m}`,
    moveFailed: (m) => `Move failed: ${m}`,
    deleteFailed: (m) => `Delete failed: ${m}`,
    detachFailed: (m) => `Move out failed: ${m}`,
    groupFailed: (m) => `Collect into a region failed: ${m}`,
    noSessionNav: 'This dsh build exposes no session navigation api',
    openSessionFailed: (m) => `Could not open the session: ${m}`,
    newSessionFailed: (m) => `Could not create the session: ${m}`,
  },
}

/**
 * The dictionary every call site reads.
 *
 * One module-level binding rather than a `t(key)` indirection: the chrome reads
 * `L.something` while it PAINTS, and the board repaints on every state change, so
 * swapping the table swaps the whole surface and no call site can be left holding
 * the old one. Two places build DOM once and are relabelled on each paint for
 * exactly that reason — the sidebar entry (client/index.js) and the two toolbar
 * aria-labels (client/dock.js).
 */
export let L = STRINGS.zh

/**
 * Adopt a language, before anything paints with it.
 *
 * `value` is the `language` field of GET /state: the host half reads the shell's
 * environment, the browser half cannot reach it. Without that field — an older
 * host, or this plugin installed straight from npm — the browser's own locale
 * decides, and Chinese has the last word.
 */
export function setLanguage(value) {
  const resolved =
    normalizeLang(value) ??
    normalizeLang(typeof navigator === 'undefined' ? null : navigator.language) ??
    'zh'
  L = STRINGS[resolved]
}

/** Glyph per region kind / element type. Emoji rather than an icon font: the
 *  bundle stays dependency-free and renders in every dsh theme. */
const GLYPH = { workspace: '📁', agent: '🤖', custom: '✨', note: '📝', session: '💬' }

/** A stored colour name → the CSS custom property the stylesheet defines. */
export function colorOf(name) {
  return name === null || name === undefined || name === '' ? null : `var(--dshc-c-${name})`
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The colour wash every node paints behind its content. Never a background on
 *  the element itself — the palette values are fully saturated and would swallow
 *  the text. */
function wash(host, color, opacity) {
  let layer = host.querySelector(':scope > .dshc-wash')
  const tint = colorOf(color)
  if (tint === null) {
    if (layer !== null) layer.remove()
    return
  }
  if (layer === null) {
    layer = el('div', 'dshc-wash')
    host.prepend(layer)
  }
  layer.style.backgroundColor = tint
  layer.style.opacity = String(opacity)
}

/** A session's display title, with the same "untitled" fallback as codeg-plus. */
export function sessionTitle(session) {
  if (session === null || session === undefined) return L.unresolvedSession
  const title = typeof session.title === 'string' ? session.title.trim() : ''
  return title === '' ? L.untitled : title
}

/** The workspace label a card puts in its footer. */
export function workspaceLabel(session) {
  if (session === null || session === undefined) return ''
  const found = model.workspaces.find((w) => w.id === session.workspace)
  if (found !== undefined) return found.title
  // No workspace registration: the working directory is still the place.
  if (typeof session.cwd === 'string' && session.cwd !== '') {
    const parts = session.cwd.split(/[\\/]/).filter((p) => p !== '')
    return parts.length === 0 ? session.cwd : parts[parts.length - 1]
  }
  return ''
}

// ── region ──

function buildRegion() {
  const frame = el('div', 'dshc-region')
  const head = el('div', 'dshc-rhead')
  const glyph = el('span', 'dshc-rglyph')
  const title = el('span', 'dshc-rtitle')
  const badge = el('span', 'dshc-badge')
  badge.append(el('span', 'dshc-dot-run'), el('span', 'dshc-badge-text'))
  const count = el('span', 'dshc-rcount')
  head.append(glyph, title, badge, count)
  const hint = el('div', 'dshc-rhint')
  const more = el('button', 'dshc-rmore')
  more.type = 'button'
  more.dataset.act = 'more'
  frame.append(head, hint, more)
  frame._parts = { head, glyph, title, badge, count, hint, more }
  return frame
}

function updateRegion(frame, element) {
  const p = frame._parts
  const row = element.row
  frame.dataset.collapsed = String(row.collapsed)
  frame.dataset.unresolved = String(element.unresolved)
  frame.dataset.drop = String(model.dropTargetRegionId === row.id)
  p.glyph.textContent = GLYPH[row.kind] ?? GLYPH.custom
  const fallback =
    row.kind === 'workspace'
      ? (model.workspaces.find((w) => w.id === row.workspace)?.title ?? L.unresolvedWorkspace)
      : row.kind === 'agent'
        ? (model.agents.find((a) => a.id === row.agentType)?.name ?? row.agentType)
        : L.customRegion
  const editing = model.renaming === row.id
  if (editing && p.input === undefined) {
    const input = el('input', 'dshc-rname-input')
    input.value = row.title ?? ''
    input.placeholder = fallback
    input.dataset.act = 'rename-input'
    p.title.replaceWith(input)
    p.input = input
    input.focus()
    input.select()
  } else if (!editing && p.input !== undefined) {
    p.input.replaceWith(p.title)
    p.input = undefined
  }
  if (!editing) {
    p.title.textContent = row.title ?? fallback
    p.title.dataset.muted = String(element.unresolved)
  }
  const running = element.runningCount > 0 && !element.unresolved
  p.badge.style.display = running ? '' : 'none'
  if (running) p.badge.querySelector('.dshc-badge-text').textContent = String(element.runningCount)
  p.count.textContent = row.collapsed || element.memberTotal > 0 ? String(element.memberTotal) : ''
  const hintText = element.unresolved
    ? L.unresolvedWorkspaceHint
    : element.memberTotal === 0 && !row.collapsed
      ? row.kind === 'custom'
        ? L.emptyCustomHint
        : L.emptyRegion
      : ''
  p.hint.textContent = hintText
  p.hint.style.display = hintText === '' ? 'none' : ''
  const hidden = element.hiddenCount
  p.more.style.display = hidden > 0 && !row.collapsed ? '' : 'none'
  if (hidden > 0) p.more.textContent = `▾ ${L.showMore(hidden)}`
  wash(frame, row.color, 0.12)
}

// ── session summary card ──

function buildCard() {
  const card = el('div', 'dshc-card')
  const row = el('div', 'dshc-crow')
  const glyph = el('span', undefined, GLYPH.session)
  const dot = el('span', 'dshc-sdot')
  const agent = el('span', 'dshc-cagent')
  row.append(glyph, dot, agent)
  const title = el('div', 'dshc-ctitle')
  const foot = el('div', 'dshc-cfoot')
  const place = el('span')
  const when = el('span')
  foot.append(place, when)
  card.append(row, title, foot)
  card._parts = { dot, agent, title, place, when }
  return card
}

/** Local short timestamp for a card footer; empty for a session with no activity
 *  time (an assembly without session persistence). */
function shortTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

function updateCard(card, element) {
  const p = card._parts
  const session = element.session
  // A live session is one the harness currently has loaded and working — the only
  // activity signal a lightweight session listing carries.
  const running = session?.live === true
  card.dataset.running = String(running)
  card.dataset.unresolved = String(element.unresolved)
  card.dataset.mirrored = String(
    element.sessionId !== undefined &&
      element.sessionId !== null &&
      mirrorIds.has(element.sessionId) &&
      !model.selected.has(element.id)
  )
  p.dot.dataset.live = String(session?.live === true)
  p.dot.dataset.running = String(running)
  p.agent.textContent = session === null || session === undefined ? '' : session.agentType
  p.title.textContent = element.unresolved ? L.unresolvedSession : sessionTitle(session)
  p.place.textContent = workspaceLabel(session)
  p.when.textContent = session === null || session === undefined ? '' : shortTime(session.updatedAt)
  wash(card, element.color, 0.08)
}

/** Session ids covered by the current selection — what makes "the same session in
 *  two regions" legible: every OTHER card showing it wears a mirror ring. */
export function selectedSessionIds() {
  const ids = new Set()
  for (const id of model.selected) {
    const member = parseMemberElementId(id)
    if (member !== null) {
      ids.add(member.sessionId)
      continue
    }
    const nodeId = parseNodeElementId(id)
    if (nodeId === null) continue
    const row = model.nodes.get(nodeId)
    if (row?.kind === 'session' && row.sessionId) ids.add(row.sessionId)
  }
  return ids
}

/** Recomputed once per render pass — see updateCard. */
let mirrorIds = new Set()

// ── expanded (detail) card ──

function buildDetail() {
  const frame = el('div', 'dshc-detail')
  const bar = el('div', `dshc-dbar ${DRAG_HANDLE_CLASS}`)
  const glyph = el('span', undefined, GLYPH.session)
  const dot = el('span', 'dshc-sdot')
  const title = el('span', 'dshc-dtitle')
  const openBtn = el('button', 'dshc-btn')
  openBtn.type = 'button'
  openBtn.style.width = '24px'
  openBtn.style.height = '24px'
  openBtn.dataset.act = 'open'
  openBtn.title = L.openInGui
  openBtn.textContent = '↗'
  const collapseBtn = el('button', 'dshc-btn')
  collapseBtn.type = 'button'
  collapseBtn.style.width = '24px'
  collapseBtn.style.height = '24px'
  collapseBtn.dataset.act = 'collapse-card'
  collapseBtn.title = L.collapseSession
  collapseBtn.textContent = '⤡'
  bar.append(glyph, dot, title, openBtn, collapseBtn)
  const body = el('div', 'dshc-dbody')
  frame.append(bar, body)
  frame._parts = { dot, title, body }
  return frame
}

function updateDetail(frame, element) {
  const p = frame._parts
  const session = element.session
  p.dot.dataset.live = String(session?.live === true)
  p.title.textContent = sessionTitle(session)
  const transcript = model.transcripts.get(element.sessionId)
  if (p.shownState === transcript?.state && p.shownFor === element.sessionId) {
    wash(frame, element.color, 0.08)
    return
  }
  p.shownState = transcript?.state
  p.shownFor = element.sessionId
  p.body.textContent = ''
  if (transcript === undefined || transcript.state === 'loading') {
    p.body.append(el('div', 'dshc-turn-who', L.loading))
  } else if (transcript.state === 'failed') {
    p.body.append(el('div', 'dshc-turn-who', L.transcriptFailed))
  } else if (transcript.turns.length === 0) {
    p.body.append(el('div', 'dshc-turn-who', L.transcriptEmpty))
  } else {
    for (const turn of transcript.turns) {
      const block = el('div', 'dshc-turn')
      block.dataset.role = turn.role
      block.append(el('div', 'dshc-turn-who', turn.label), el('div', 'dshc-turn-body', turn.text))
      p.body.append(block)
    }
  }
  wash(frame, element.color, 0.08)
}

// ── note ──

function buildNote() {
  const frame = el('div', 'dshc-note')
  const text = el('div', 'dshc-ntext')
  frame.append(text)
  frame._parts = { text }
  return frame
}

function updateNote(frame, element) {
  const p = frame._parts
  const row = element.row
  const editing = model.editingNote === row.id
  if (editing && p.input === undefined) {
    const input = el('textarea', 'dshc-nedit')
    input.value = row.content ?? ''
    input.placeholder = L.notePlaceholder
    input.dataset.act = 'note-input'
    p.text.replaceWith(input)
    p.input = input
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  } else if (!editing && p.input !== undefined) {
    p.input.replaceWith(p.text)
    p.input = undefined
  }
  if (!editing) {
    const content = row.content ?? ''
    p.text.textContent = content === '' ? L.noteEmptyHint : content
    p.text.dataset.empty = String(content === '')
  }
  wash(frame, row.color, 0.12)
}

// ── the board ──

/** Element id → its wrapper div, so a frame updates in place. */
const wrappers = new Map()

const BUILDERS = {
  region: buildRegion,
  sessionCard: buildCard,
  sessionDetail: buildDetail,
  note: buildNote,
}
const UPDATERS = {
  region: updateRegion,
  sessionCard: updateCard,
  sessionDetail: updateDetail,
  note: updateNote,
}

/** Resize handles a node offers, by type. A draft-free board resizes regions,
 *  notes and expanded cards; a summary card is a fixed tile. */
const HANDLES = {
  region: ['e', 's', 'se'],
  note: ['e', 's', 'se'],
  sessionDetail: ['e', 's', 'se'],
}

/**
 * Paint the whole board. Wrappers are reused by element id and only the ones
 * that vanished are removed, so a note's caret and a rename input survive.
 */
export function renderBoard(boardEl, board) {
  mirrorIds = selectedSessionIds()
  const seen = new Set()
  for (const element of board.elements) {
    seen.add(element.id)
    let wrapper = wrappers.get(element.id)
    if (wrapper === undefined || wrapper.dataset.type !== element.type) {
      if (wrapper !== undefined) wrapper.remove()
      wrapper = el('div', 'dshc-node')
      wrapper.dataset.id = element.id
      wrapper.dataset.type = element.type
      wrapper.append(BUILDERS[element.type]())
      wrappers.set(element.id, wrapper)
      boardEl.append(wrapper)
    }
    const selected = model.selected.has(element.id)
    wrapper.dataset.selected = String(selected)
    wrapper.style.left = `${element.position.x}px`
    wrapper.style.top = `${element.position.y}px`
    wrapper.style.width = `${element.width}px`
    wrapper.style.height = `${element.height}px`
    // Regions paint under their member cards; a dragged node rides above both.
    wrapper.style.zIndex = model.overlay.has(element.id)
      ? '30'
      : element.type === 'region'
        ? '1'
        : '2'
    UPDATERS[element.type](wrapper.firstElementChild, element)
    syncHandles(wrapper, selected ? (HANDLES[element.type] ?? []) : [])
  }
  for (const [id, wrapper] of [...wrappers]) {
    if (seen.has(id)) continue
    wrapper.remove()
    wrappers.delete(id)
  }
  renderOverlays(boardEl, board)
}

function syncHandles(wrapper, dirs) {
  const existing = new Map(
    [...wrapper.querySelectorAll(':scope > .dshc-handle')].map((h) => [h.dataset.dir, h])
  )
  for (const [dir, handle] of existing) {
    if (!dirs.includes(dir)) handle.remove()
  }
  for (const dir of dirs) {
    if (existing.has(dir)) continue
    const handle = el('div', 'dshc-handle')
    handle.dataset.dir = dir
    handle.dataset.act = 'resize'
    wrapper.append(handle)
  }
}

/**
 * The transient layer: alignment guides and the merge ghost. Drawn INSIDE the
 * board layer so their coordinates are board units like everything else; the
 * hairline width is divided by the zoom so it stays one screen pixel.
 */
function renderOverlays(boardEl, board) {
  let layer = boardEl.querySelector(':scope > .dshc-overlays')
  if (layer === null) {
    layer = el('div', 'dshc-overlays')
    layer.style.position = 'absolute'
    layer.style.left = '0'
    layer.style.top = '0'
    layer.style.pointerEvents = 'none'
    layer.style.zIndex = '40'
    boardEl.append(layer)
  }
  layer.textContent = ''
  const hair = 1 / model.viewport.zoom
  for (const guide of model.guides) {
    const line = el('div', 'dshc-guide')
    if (guide.axis === 'x') {
      line.style.left = `${guide.at - hair / 2}px`
      line.style.top = `${guide.from}px`
      line.style.width = `${hair}px`
      line.style.height = `${Math.max(guide.to - guide.from, hair)}px`
    } else {
      line.style.left = `${guide.from}px`
      line.style.top = `${guide.at - hair / 2}px`
      line.style.width = `${Math.max(guide.to - guide.from, hair)}px`
      line.style.height = `${hair}px`
    }
    layer.append(line)
  }
  const hint = model.dropHint
  if (hint !== null && hint.type === 'merge') {
    const ghost = el('div', 'dshc-ghost')
    ghost.style.left = `${hint.rect.x}px`
    ghost.style.top = `${hint.rect.y}px`
    ghost.style.width = `${hint.rect.width}px`
    ghost.style.height = `${hint.rect.height}px`
    ghost.append(el('span', 'dshc-ghost-pill', L.mergeIntoNewRegion))
    layer.append(ghost)
  }
  // Keep the board layer's own box big enough that the browser does not clip an
  // absolutely-positioned child at a negative coordinate.
  const bounds = boardBounds(board.elements)
  if (bounds !== null) {
    boardEl.style.width = `${Math.max(bounds.x + bounds.width, 1)}px`
    boardEl.style.height = `${Math.max(bounds.y + bounds.height, 1)}px`
  }
}

/** Forget every cached wrapper (a full teardown). */
export function resetRender() {
  for (const wrapper of wrappers.values()) wrapper.remove()
  wrappers.clear()
}
