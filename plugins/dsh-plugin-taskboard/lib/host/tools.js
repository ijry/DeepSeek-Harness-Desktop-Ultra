/**
 * The taskboard_* agent tools (the six-tool closed loop). All writes require a
 * calling agent session (ownership audit), carry optimistic-version checks,
 * and enforce the protocol gates in CODE, not in prompt text:
 *
 * - `move → done/canceled` is rejected for agent callers (human only)
 * - claiming (todo/queued → preparing) binds the task to the calling session;
 *   a task held by another session cannot be taken over
 * - claiming a workspace-bound task requires the caller's session workspace
 * - agents may update title/description/prompt but never the workspace binding
 *
 * OUTPUT CONTRACT: the registry renders `output.render(args, value)` into the
 * model-visible content — render() IS the model-facing tool result and must
 * carry every fact an agent needs (ids, versions, statuses).
 *
 * @module dsh-plugin-taskboard/host/tools
 */
import { defineTool } from './sdk.js'
import {
  HOLD_STATUSES,
  agentCanMove,
  columnForStatus,
  createTaskRecord,
  isClaim,
  isClaimedBy,
  isValidStatus,
  newCommentId,
  normalizeOptionalText,
  normalizeTitle,
  normalizeWorkspaceId,
  summarizeTask,
} from '../shared/protocol.js'

/** Stable error codes used by both tools and routes. */
export const ERR = {
  requiresAgent: 'requires_agent',
  invalidInput: 'invalid_input',
  invalidTransition: 'invalid_transition',
  notFound: 'not_found',
  versionConflict: 'version_conflict',
  forbidden: 'forbidden',
  internal: 'internal',
}

/** Error carrying a stable code; message renders `Error: <code>: <detail>`. */
export class ToolError extends Error {
  constructor(code, detail) {
    super(`Error: ${code}: ${detail}`)
    this.code = code
  }
}

/** Adapt a workspace registry (dsh-workspace) to a narrow synchronous face. */
export function workspaceFace(registry) {
  if (registry === undefined) return undefined
  const toView = (ws) => (ws === undefined ? undefined : { id: ws.id, path: ws.path, title: ws.title })
  return {
    async resolveByPath(path) {
      try {
        const ws = await registry.resolveByPath(path)
        return ws === undefined ? undefined : toView(ws)
      } catch {
        return undefined
      }
    },
    get(id) {
      try {
        return toView(registry.get(id))
      } catch {
        return undefined
      }
    },
    list() {
      try {
        return registry.list().map(toView)
      } catch {
        return []
      }
    },
  }
}

/** One compact task line (id/status/version/column are load-bearing). */
function taskLine(t, workspaces) {
  const workspace = workspaces !== undefined ? workspaces.get(t.workspaceId ?? '') : undefined
  const parts = [
    `- ${t.id} [${t.status}/${columnForStatus(t.status)}] v${t.version} · ${t.title}`,
  ]
  if (t.workspaceId !== undefined && t.workspaceId !== '') {
    parts.push(`项目 ${workspace !== undefined ? `${workspace.title}(${workspace.id})` : t.workspaceId}`)
  } else {
    parts.push('无项目')
  }
  if (isClaimedBy(t)) parts.push('已被认领')
  if (Array.isArray(t.comments) && t.comments.length > 0) parts.push(`评论${t.comments.length}`)
  return parts.join(' ')
}

/** Render side: the full task detail block. */
function taskDetail(t, workspaces) {
  const workspace = workspaces !== undefined ? workspaces.get(t.workspaceId ?? '') : undefined
  const lines = [
    `任务 ${t.id} 「${t.title}」`,
    `状态: ${t.status}（看板列 ${columnForStatus(t.status)}）v${t.version}`,
    `项目: ${t.workspaceId !== undefined && t.workspaceId !== '' ? (workspace !== undefined ? `${workspace.title} (${t.workspaceId}, ${workspace.path})` : t.workspaceId) : '（无）'}`,
    `创建: ${new Date(t.createdAt).toISOString()}${t.createdBy?.kind !== undefined ? ` by ${actorLabel(t.createdBy)}` : ''}`,
    `更新: ${new Date(t.updatedAt).toISOString()}${t.updatedBy?.kind !== undefined ? ` by ${actorLabel(t.updatedBy)}` : ''}`,
  ]
  if (t.claimedBy !== undefined) lines.push(`认领: agent ${t.claimedBy}`)
  if (t.description !== undefined && t.description.length > 0) lines.push(`描述: ${t.description}`)
  if (t.prompt !== undefined && t.prompt.length > 0) lines.push(`执行 Prompt: ${t.prompt}`)
  const comments = Array.isArray(t.comments) ? t.comments : []
  lines.push(`评论 (${comments.length}):`)
  for (const comment of comments) {
    lines.push(`  [${new Date(comment.createdAt).toISOString()} ${actorLabel(comment.actor)}] ${comment.body}`)
  }
  return lines.join('\n')
}

/** Human label for an actor. */
function actorLabel(actor) {
  if (actor === undefined || actor === null) return 'unknown'
  return actor.kind === 'agent' ? `agent:${String(actor.sessionId ?? '').slice(0, 24)}` : 'user'
}

/** The calling agent session id; throws when the tool runs outside an agent. */
function callerSession(exec) {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ToolError(ERR.requiresAgent, 'taskboard tools require a calling agent session')
  }
  return sessionId
}

/** The calling session's workspace id (undefined when unaffiliated/unresolvable). */
async function callerWorkspace(deps, exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0 || deps.workspaces === undefined) return undefined
  const ws = await deps.workspaces.resolveByPath(cwd)
  return ws?.id
}

/** Guard: ifVersion matches the live task (throw inside the mutator). */
export function versionGuard(task, ifVersion) {
  if (ifVersion === undefined) {
    throw new ToolError(ERR.versionConflict, 'this write requires ifVersion; read the task first')
  }
  if (ifVersion !== task.version) {
    throw new ToolError(ERR.versionConflict, `stale version ${ifVersion} (current ${task.version}); re-read the task and retry once`)
  }
}

/** Find a task inside a mutator (not_found for missing). */
export function liveTaskAt(ledger, id) {
  const task = ledger.tasks.find((t) => t.id === id)
  if (task === undefined) throw new ToolError(ERR.notFound, `no task ${id}`)
  return task
}

/** A task is currently held by a session. */
function heldBy(task) {
  return HOLD_STATUSES.includes(task.status) && isClaimedBy(task) !== undefined
    ? isClaimedBy(task)
    : undefined
}

/** The workspace claim boundary: may this session claim this task? */
async function checkClaimBoundary(deps, task, sessionId) {
  if (task.workspaceId === undefined || task.workspaceId === '') return
  const callerWs = await callerWorkspace(deps, { agent: { id: sessionId } })
  if (callerWs === undefined) {
    // Session is outside every registered workspace — cannot verify the
    // boundary, so refuse to claim a project-bound task.
    throw new ToolError(ERR.forbidden,
      `task ${task.id} belongs to workspace ${task.workspaceId}; your session is not attached to a workspace, cannot claim`)
  }
  if (callerWs !== task.workspaceId) {
    throw new ToolError(ERR.forbidden,
      `task ${task.id} belongs to workspace ${task.workspaceId} but your session is in ${callerWs}; cannot claim across projects`)
  }
}

/** Everything the tool set needs. */
export class ToolDeps {
  constructor(store, workspaces, now) {
    this.store = store
    this.workspaces = workspaces
    this.now = now
  }
}

/** Register all six tools; returns disposers, one per tool. */
export function registerTaskboardTools(ctx, deps) {
  const disposers = []
  const { store, workspaces, now } = deps
  const register = (tool) => disposers.push(ctx.tools.register(tool))

  // ---------------------------------------------------------------- list
  register(defineTool({
    name: 'taskboard_list',
    description:
      'List tasks on the shared task board (codeg-plus-style columns). Optional filters: '
      + 'workspaceId (project), status, column (todo|inProgress|attention|done), search '
      + '(title/id substring). Canceled tasks are excluded unless includeCanceled=true. '
      + 'Check the board before starting work and claim an available task.',
    parameters: {
      workspaceId: { type: 'string', description: 'Only tasks bound to this workspace id.' },
      status: { type: 'string', description: 'Only tasks with this exact status.' },
      column: { type: 'string', enum: ['todo', 'inProgress', 'attention', 'done'], description: 'Only tasks in this board column.' },
      search: { type: 'string', description: 'Case-insensitive substring over title and id.' },
      includeCanceled: { type: 'boolean', description: 'Include canceled tasks (default false).' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const tasks = store.snapshot().tasks
      const includeCanceled = args.includeCanceled === true
      const status = typeof args.status === 'string' && isValidStatus(args.status) ? args.status : undefined
      const column = typeof args.column === 'string' ? args.column : undefined
      const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.length > 0 ? args.workspaceId : undefined
      const search = typeof args.search === 'string' && args.search.length > 0 ? args.search.toLowerCase() : undefined
      const rows = tasks.filter((task) => {
        if (task.status === 'canceled' && !includeCanceled) return false
        if (status !== undefined && task.status !== status) return false
        if (column !== undefined && columnForStatus(task.status) !== column) return false
        if (workspaceId !== undefined && (task.workspaceId ?? '') !== workspaceId) return false
        if (search !== undefined) {
          const hay = `${task.title} ${task.id}`.toLowerCase()
          if (!hay.includes(search)) return false
        }
        return true
      }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      const lines = rows.map((task) => taskLine(task, workspaces))
      const text = rows.length === 0
        ? '任务看板为空（当前过滤下没有任务）。'
        : `任务看板共 ${rows.length} 个任务（按最近更新排序）：\n${lines.join('\n')}`
      return { tasks: rows.map(summarizeTask), text }
    },
  }))

  // ----------------------------------------------------------------- get
  register(defineTool({
    name: 'taskboard_get',
    description:
      'Read one task in full: title, description, prompt, status, version, workspace binding, '
      + 'claim holder and the whole comment thread. Always read a task (and its comments) before '
      + 'moving or working on it; comments carry the latest requirements.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const task = store.get(args.id)
      if (task === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
      return { task: { ...task }, text: taskDetail(task, workspaces) }
    },
  }))

  // ------------------------------------------------------------- create
  register(defineTool({
    name: 'taskboard_create',
    description:
      'Create a new task on the shared task board. Starts in status todo. When workspaceId is '
      + 'omitted the caller’s own workspace (from the session working directory) is used when '
      + 'resolvable. Agents can create tasks but can never complete them — done is user-only.',
    parameters: {
      title: { type: 'string', required: true, description: 'Task title (1..200 chars).' },
      description: { type: 'string', description: 'Optional background / context.' },
      prompt: { type: 'string', description: 'Optional execution prompt / instructions.' },
      workspaceId: { type: 'string', description: 'Project (DSH workspace) this task belongs to.' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const sessionId = callerSession(exec)
      let workspaceId = normalizeWorkspaceId(args.workspaceId)
      if (workspaceId === '') workspaceId = (await callerWorkspace(deps, exec)) ?? ''
      const task = createTaskRecord({
        title: args.title,
        description: args.description,
        prompt: args.prompt,
        workspaceId,
        actor: { kind: 'agent', sessionId },
        now: now(),
      })
      await store.mutate('task-created', (ledger) => {
        ledger.tasks.push(task)
        return [task]
      })
      const text = `已创建任务 ${task.id} 「${task.title}」（status=todo, v${task.version}）。`
      return { task: { ...task }, text }
    },
  }))

  // ------------------------------------------------------------- update
  register(defineTool({
    name: 'taskboard_update',
    description:
      'Update a task’s title/description/prompt. Requires ifVersion (read the task first). '
      + 'Workspace binding is owned by the user and cannot be changed by agents.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: { type: 'number', required: true, description: 'Task version you read.' },
      title: { type: 'string', description: 'New title.' },
      description: { type: 'string', description: 'New description (pass empty string to clear).' },
      prompt: { type: 'string', description: 'New prompt (pass empty string to clear).' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const sessionId = callerSession(exec)
      const changed = await store.mutate('task-updated', (ledger) => {
        const task = liveTaskAt(ledger, args.id)
        versionGuard(task, args.ifVersion)
        if (args.title !== undefined) task.title = normalizeTitle(args.title)
        if (args.description !== undefined) task.description = normalizeOptionalText(args.description, 'description')
        if (args.prompt !== undefined) task.prompt = normalizeOptionalText(args.prompt, 'prompt')
        task.version += 1
        task.updatedAt = now()
        task.updatedBy = { kind: 'agent', sessionId }
        return [task]
      })
      const task = changed.changed.length > 0 ? store.get(args.id) : undefined
      return {
        task: task === undefined ? undefined : { ...task },
        text: task === undefined ? '没有变化，任务未更新。' : `已更新任务 ${task.id}「${task.title}」到 v${task.version}。`,
      }
    },
  }))

  // --------------------------------------------------------------- move
  register(defineTool({
    name: 'taskboard_move',
    description:
      'Move a task between agent-side statuses. The allowed flow mirrors codeg-plus: '
      + 'todo/queued → preparing (claim; binds the task to your session), preparing → running, '
      + 'running → awaiting_input (waiting on the user) | review (done, hand off for acceptance) '
      + '| failed, awaiting_input → running/review, failed → todo/queued (retry). '
      + 'You can NEVER move a task to done or canceled — those are the user’s acceptance actions. '
      + 'Requires ifVersion. Tasks held by another session cannot be moved.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: { type: 'number', required: true, description: 'Task version you read.' },
      status: { type: 'string', required: true, enum: ['todo', 'queued', 'preparing', 'running', 'awaiting_input', 'review', 'failed'], description: 'Target status.' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const sessionId = callerSession(exec)
      if (!isValidStatus(args.status) || args.status === 'done' || args.status === 'canceled' || args.status === 'merging') {
        throw new ToolError(ERR.invalidTransition,
          'agents may only move tasks between agent-side statuses; done/canceled are user actions')
      }
      const task = store.get(args.id)
      if (task === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
      if (isClaim(task.status, args.status) && heldBy(task) === undefined && task.status !== args.status) {
        await checkClaimBoundary(deps, task, sessionId)
      }
      const changed = await store.mutate('task-moved', (ledger) => {
        const live = liveTaskAt(ledger, args.id)
        versionGuard(live, args.ifVersion)
        const currentHolder = heldBy(live)
        if (currentHolder !== undefined && currentHolder !== sessionId) {
          throw new ToolError(ERR.forbidden, `task ${args.id} is held by another session; do not take it over`)
        }
        if (args.status !== live.status && !agentCanMove(live.status, args.status)) {
          throw new ToolError(ERR.invalidTransition,
            `agent cannot move task ${args.id} from ${live.status} to ${args.status}; done/canceled are user-only`)
        }
        if (args.status !== live.status) {
          live.status = args.status
          live.version += 1
          live.updatedAt = now()
          live.updatedBy = { kind: 'agent', sessionId }
          if (HOLD_STATUSES.includes(args.status)) {
            if (live.claimedBy !== sessionId) {
              live.claimedBy = sessionId
              live.claimedAt = now()
            }
          } else {
            delete live.claimedBy
            delete live.claimedAt
          }
        }
        return [live]
      })
      const after = changed.changed.length > 0 ? store.get(args.id) : undefined
      const text = after === undefined
        ? '没有变化，任务未移动。'
        : `任务 ${after.id}「${after.title}」→ ${after.status}（看板列 ${columnForStatus(after.status)}），v${after.version}。`
      return { task: after === undefined ? undefined : { ...after }, text }
    },
  }))

  // ------------------------------------------------------------ comment
  register(defineTool({
    name: 'taskboard_comment',
    description:
      'Append a comment to a task. Use this to report progress, ask the user questions, or submit '
      + 'the structured hand-off report (summary / changed files / how you verified / remaining '
      + 'risk) before moving the task to review. Requires ifVersion. Comments bump the task so it '
      + 'floats to the top of its column.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: { type: 'number', required: true, description: 'Task version you read.' },
      body: { type: 'string', required: true, description: 'Comment body (1..4000 chars).' },
    },
    output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const sessionId = callerSession(exec)
      const body = normalizeOptionalText(args.body, 'body', 4000)
      if (body.length === 0) throw new ToolError(ERR.invalidInput, 'comment body must not be empty')
      const changed = await store.mutate('comment-added', (ledger) => {
        const task = liveTaskAt(ledger, args.id)
        versionGuard(task, args.ifVersion)
        task.comments = task.comments ?? []
        task.comments.push({
          id: newCommentId(),
          body,
          createdAt: now(),
          actor: { kind: 'agent', sessionId },
        })
        task.version += 1
        task.updatedAt = now()
        task.updatedBy = { kind: 'agent', sessionId }
        return [task]
      })
      const after = changed.changed.length > 0 ? store.get(args.id) : undefined
      return {
        task: after === undefined ? undefined : { ...after },
        text: after === undefined ? '评论未提交。' : `已评论任务 ${after.id}「${after.title}」（现 v${after.version}）。`,
      }
    },
  }))

  return disposers
}
