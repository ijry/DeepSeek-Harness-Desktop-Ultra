/**
 * Every board command, as one optimistic write followed by the host's answer.
 *
 * The pattern is codeg-plus's: apply what the user just did to the local cache
 * immediately (so the board never lags the pointer), send the mutation, then feed
 * the response through `applyResponse` — which only lands while the matching
 * broadcast has not arrived yet. A failure toasts and refetches, because the
 * optimistic state is now a lie.
 *
 * @module dsh-plugin-canvas/client/commands
 */

/** Ledger rows of the current selection, plus what can be done with them. */
export function selectionFacts() {
  const nodeIds = []
  const members = []
  for (const id of model.selected) {
    const member = parseMemberElementId(id)
    if (member !== null) {
      members.push(member)
      continue
    }
    const nodeId = parseNodeElementId(id)
    if (nodeId !== null && model.nodes.has(nodeId)) nodeIds.push(nodeId)
  }
  const rows = nodeIds.map((id) => model.nodes.get(id))
  const sessionIds = new Set()
  for (const row of rows) if (row.kind === 'session' && row.sessionId) sessionIds.add(row.sessionId)
  for (const m of members) sessionIds.add(m.sessionId)
  return {
    nodeIds,
    rows,
    members,
    sessionIds: [...sessionIds],
    // Pins the selection would swallow when it becomes a region.
    consumeNodeIds: rows.filter((r) => r.kind === 'session').map((r) => r.id),
    count: nodeIds.length + members.length,
  }
}

/** Notes in this id set that hold prose — the only thing a delete stops to ask
 *  about, because the board has no undo. */
export function notesAtRisk(ids) {
  return ids.filter((id) => noteHoldsProse(model.nodes.get(id))).length
}

async function run(label, apply, request) {
  const rollback = new Map(model.nodes)
  if (apply !== undefined) {
    const nodes = new Map(model.nodes)
    apply(nodes)
    model.nodes = nodes
    emit()
  }
  try {
    return await request()
  } catch (error) {
    model.nodes = rollback
    emit()
    toast(`${label}：${error?.message ?? error}`)
    void refetchState()
    return undefined
  }
}

/** Patch one node. */
export async function patchNode(id, patch) {
  const before = model.nodes.get(id)
  if (before === undefined) return
  // `memberAdd` / `memberRemove` are server-side list ops, not fields: copying
  // them onto the cached row would leave junk keys and no visible change, so the
  // optimistic step applies them to `memberIds` instead.
  const optimistic = { ...patch }
  delete optimistic.memberAdd
  delete optimistic.memberRemove
  let memberIds = before.memberIds
  if (patch.memberRemove !== undefined) {
    memberIds = memberIds.filter((m) => m !== String(patch.memberRemove))
  }
  if (patch.memberAdd !== undefined && !memberIds.includes(String(patch.memberAdd))) {
    memberIds = [...memberIds, String(patch.memberAdd)]
  }
  const result = await run(
    '保存失败',
    (nodes) => nodes.set(id, { ...before, ...optimistic, memberIds }),
    () => api(`/nodes/${id}/update`, patch)
  )
  if (result === undefined) return
  applyResponse(result.revision, (nodes) => {
    if (result.value !== undefined && result.value !== null) nodes.set(result.value.id, result.value)
  })
}

/** Create one node and select it. */
export async function createNode(input) {
  const result = await run('创建失败', undefined, () => api('/nodes', input))
  if (result === undefined) return undefined
  applyResponse(result.revision, (nodes) => nodes.set(result.value.id, result.value))
  selectOnly(nodeElementId(result.value.id))
  return result.value
}

/** Batch geometry write for a finished drag / auto-arrange. */
export async function moveNodesCmd(moves) {
  if (moves.length === 0) return
  const result = await run(
    '移动失败',
    (nodes) => {
      for (const move of moves) {
        const existing = nodes.get(move.id)
        if (existing !== undefined) nodes.set(move.id, { ...existing, x: move.x, y: move.y })
      }
    },
    () => api('/nodes/move', { moves })
  )
  if (result === undefined) return
  applyResponse(result.revision, (nodes) => {
    for (const move of result.value ?? []) {
      const existing = nodes.get(move.id)
      if (existing !== undefined) nodes.set(move.id, { ...existing, x: move.x, y: move.y })
    }
  })
}

export async function deleteNodeCmd(id) {
  const result = await run('删除失败', (nodes) => nodes.delete(id), () => api(`/nodes/${id}/delete`, {}))
  if (result === undefined) return
  applyResponse(result.revision, (nodes) => nodes.delete(id))
  model.selected.delete(nodeElementId(id))
  emit()
}

export async function deleteNodesCmd(ids) {
  if (ids.length === 0) return
  const result = await run(
    '删除失败',
    (nodes) => {
      for (const id of ids) nodes.delete(id)
    },
    () => api('/nodes/delete', { nodeIds: ids })
  )
  if (result === undefined) return
  applyResponse(result.revision, (nodes) => {
    for (const id of result.value ?? []) nodes.delete(id)
  })
  model.selected.clear()
  emit()
}

/** Selection helpers. Selection is view state, not ledger state, so every verb
 *  reads one source. */
export function selectOnly(elementId) {
  model.selected.clear()
  if (elementId !== undefined) model.selected.add(elementId)
  emit()
}

/** Drag a member out of its region onto open canvas. `expand` immediately opens
 *  the new pin as a transcript card — a member cannot expand in place, because a
 *  520-wide surface inside a uniform grid would tear the row apart. */
export async function detachMemberCmd(regionId, sessionId, x, y, options = {}) {
  const result = await run('移出失败', undefined, () =>
    api(`/nodes/${regionId}/detach`, { sessionId, x, y })
  )
  if (result === undefined) return undefined
  const { node, removedFrom } = result.value
  applyResponse(result.revision, (nodes) => {
    if (removedFrom !== null) {
      const region = nodes.get(removedFrom)
      if (region !== undefined) {
        nodes.set(removedFrom, {
          ...region,
          memberIds: region.memberIds.filter((m) => m !== sessionId),
        })
      }
    }
    nodes.set(node.id, node)
  })
  if (options.expand === true) {
    model.detailCards.add(node.id)
    saveExpanded()
    void loadTranscript(sessionId)
  }
  selectOnly(nodeElementId(node.id))
  return node
}

/** Collect sessions into a region: the box-select gesture, a card dropped into a
 *  custom region, and two cards dropped onto each other. */
export async function groupCmd(input) {
  const result = await run('收进区域失败', undefined, () => api('/group', input))
  if (result === undefined) return undefined
  const { node, deletedIds } = result.value
  applyResponse(result.revision, (nodes) => {
    for (const id of deletedIds) nodes.delete(id)
    nodes.set(node.id, node)
  })
  selectOnly(nodeElementId(node.id))
  return node
}

/** Box-select → a new region sized to what was selected (the dock's ✨ / Cmd+G). */
export async function groupSelection() {
  const facts = selectionFacts()
  if (facts.sessionIds.length === 0) return
  const boxes = []
  for (const element of model.board?.elements ?? []) {
    if (!model.selected.has(element.id)) continue
    boxes.push({ ...element.position, width: element.width, height: element.height })
  }
  // A selection can name elements the board no longer derives (a member removed
  // by another client, a prune). Without a box there is no frame, and the reduce
  // below would hand the host ±Infinity — which it rejects, so the gesture would
  // fail with a toast instead of doing nothing.
  if (boxes.length === 0) return
  const bounds = boxes.reduce(
    (acc, b) => ({
      x: Math.min(acc.x, b.x),
      y: Math.min(acc.y, b.y),
      right: Math.max(acc.right, b.x + b.width),
      bottom: Math.max(acc.bottom, b.y + b.height),
    }),
    { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity }
  )
  const columns = Math.max(1, Math.min(6, columnsForRegionWidth(bounds.right - bounds.x + REGION_PADDING * 2)))
  const rows = Math.max(1, Math.ceil(facts.sessionIds.length / columns))
  await groupCmd({
    memberIds: facts.sessionIds,
    consumeNodeIds: facts.consumeNodeIds,
    gridColumns: columns,
    gridRows: rows,
    x: bounds.x - REGION_PADDING,
    y: bounds.y - REGION_PADDING,
    width: regionWidthForColumns(columns),
    height: regionHeightForRows(rows),
  })
}

/** Delete the selection. Member cards are not rows — removing one from a custom
 *  region is a membership patch, not a delete. */
export async function deleteSelection() {
  const facts = selectionFacts()
  for (const member of facts.members) {
    const region = model.nodes.get(member.regionId)
    if (region?.kind === 'custom') {
      await patchNode(member.regionId, { memberRemove: member.sessionId })
    }
  }
  if (facts.nodeIds.length === 1) await deleteNodeCmd(facts.nodeIds[0])
  else if (facts.nodeIds.length > 1) await deleteNodesCmd(facts.nodeIds)
}

/** Shelf-pack every top-level node against its RENDERED size. */
export async function autoArrange() {
  const rows = [...model.nodes.values()]
  const sizes = model.board?.renderedSizes ?? new Map()
  await moveNodesCmd(packLayout(rows, sizes))
}

/** The empty-board CTA: one region per registered workspace. */
export async function seedFromWorkspaces() {
  const seeds = seedRegionsFromWorkspaces(model.workspaces)
  for (const seed of seeds) {
    // Sequential on purpose: each create is its own revision, and the host
    // serializes writes anyway — firing them together only reorders the ids.
    await createNode({ kind: 'workspace', workspace: seed.workspace, ...seed })
  }
  return seeds.length
}

/** Expand / collapse one pinned card into a transcript surface. */
export function setCardDetail(nodeId, open) {
  if (open) model.detailCards.add(nodeId)
  else model.detailCards.delete(nodeId)
  saveExpanded()
  if (open) {
    const row = model.nodes.get(nodeId)
    if (row?.sessionId) void loadTranscript(row.sessionId)
  }
  emit()
}

/**
 * Load the transcript of every card that is already expanded.
 *
 * Cards restored from device-local storage were never opened in THIS visit, so
 * nothing else would ever ask for their text — they would sit on "载入中…"
 * forever. Called once the ledger lands, when the rows those ids name exist.
 */
export function loadOpenTranscripts() {
  for (const nodeId of model.detailCards) {
    const row = model.nodes.get(nodeId)
    if (row?.sessionId && !model.transcripts.has(row.sessionId)) {
      void loadTranscript(row.sessionId)
    }
  }
}

/** Open / close a region's "+N more" expander. */
export function setRegionExpanded(nodeId, open) {
  if (open) model.expandedRegions.add(nodeId)
  else model.expandedRegions.delete(nodeId)
  saveExpanded()
  emit()
}

/**
 * Read a session's transcript for a detail card.
 *
 * Cached per session and refreshed on demand: a canvas showing six expanded cards
 * must not re-read six logs on every render pass.
 */
export async function loadTranscript(sessionId, force = false) {
  if (sessionId === undefined || sessionId === null) return
  const known = model.transcripts.get(sessionId)
  if (!force && known !== undefined && known.state !== 'failed') return
  model.transcripts.set(sessionId, { state: 'loading', turns: [] })
  emit()
  try {
    const value = await api(`/sessions/${encodeURIComponent(sessionId)}/transcript`)
    model.transcripts.set(sessionId, { state: 'ready', turns: value.turns ?? [] })
  } catch (error) {
    console.warn('[dsh-plugin-canvas] transcript failed:', error?.message ?? error)
    model.transcripts.set(sessionId, { state: 'failed', turns: [] })
  }
  emit()
}

/** Hand a session to the GUI's own conversation view. */
export function openInGui(sessionId) {
  if (sessionId === undefined || sessionId === null) return
  if (model.host?.openSession === undefined) {
    toast('这个 dsh 版本没有暴露会话导航接口')
    return
  }
  try {
    model.host.openSession(sessionId)
    // The board is an overlay over the conversation column, so it has to step
    // aside for the session it just opened.
    model.open = false
    emit()
  } catch (error) {
    toast(`打开会话失败：${error?.message ?? error}`)
  }
}

/**
 * Start a new session and pin it on the board.
 *
 * This is the GUI's OWN api (`POST /api/session.create`, the documented rpc
 * envelope), not something this plugin invents: creating a session means minting
 * a log, attaching it to a workspace and composing an agent, all of which belong
 * to the harness. The board only asks for one and then arranges it.
 *
 * codeg-plus goes further and lets you type the first message into the card. That
 * needs the composer, which is part of the host app's compiled conversation
 * surface — so here the new card is opened in the session view instead.
 */
export async function createSession(options) {
  const rpcId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dshc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let value
  try {
    const response = await fetch('/api/session.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'session.create',
        payload: {
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
        },
      }),
    })
    const payload = await response.json()
    // Business failures come back as 200 with ok:false; only the carrier uses
    // status codes.
    const result = payload?.result
    if (result?.ok !== true) {
      throw new Error(result?.error?.message ?? `HTTP ${response.status}`)
    }
    value = result.value
  } catch (error) {
    toast(`新建会话失败：${error?.message ?? error}`)
    return undefined
  }
  // The new session has to be in the view before the ledger will accept a card
  // bound to it — the host checks liveness at the write.
  await refetchSessions(true)
  return createNode({ kind: 'session', sessionId: value.sessionId, ...options.at })
}
