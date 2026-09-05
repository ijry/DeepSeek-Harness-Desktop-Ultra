/**
 * Vocabulary shared by the whole browser bundle: ids, labels, and the parts of
 * src/shared/protocol.js this side needs.
 *
 * This is a hand-kept COPY of the host's protocol module — the bundle has no
 * module resolution, so it cannot import it. The two copies MUST change
 * together; a drift is a wire break.
 *
 * Every user-visible string in the panel lives here or in the view that owns it,
 * verbatim from the reference plugin (otools-git) so the port reads identically.
 */

const PLUGIN_ID = 'dsh-plugin-otools-git'
const ROUTE_PREFIX = '/dsh-plugin-otools-git'
const SSE_PATH = '/dsh-plugin-otools-git/events'
const STYLE_ID = 'dsh-plugin-otools-git-style'
const PANEL_NAME = 'dsh-plugin-otools-git'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const OPEN_ATTR = 'data-dsh-og-open'
const ENTRY_SELECTOR = '[data-dsh-otools-git-entry]'
const LOG = '[' + PLUGIN_ID + ']'

/** Seats in the DSH shell, across the layout generations it has shipped. */
const CONVERSATION_SELECTOR =
  '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
const SIDEBAR_SELECTOR =
  '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
/** Sibling panel plugins: their entries stay grouped and only one panel is open. */
const SIBLING_ENTRIES =
  '[data-dsh-cgtb-entry], [data-dsh-taskboard-entry], [data-dsh-repopanel-entry], [data-dsh-ssh-entry]'

/** localStorage keys. Repository choice is remembered; nothing else is. */
const STORAGE_PREFIX = PLUGIN_ID + ':'
const STORE_KEYS = {
  workspaceId: STORAGE_PREFIX + 'workspaceId',
}

/** The main tabs, in toolbar order. */
const TABS = [
  { id: 'status', label: '工作区', icon: 'files' },
  { id: 'history', label: '历史', icon: 'clock' },
  { id: 'branches', label: '分支', icon: 'branch' },
  { id: 'tags', label: '标签', icon: 'tag' },
  { id: 'stashes', label: '贮藏', icon: 'stash' },
  { id: 'remotes', label: '远端', icon: 'remote' },
  { id: 'submodules', label: '子模块', icon: 'submodule' },
  { id: 'worktrees', label: '工作树', icon: 'worktree' },
]

/** Working-tree sections, in display order, with the reference's headings. */
const SECTIONS = [
  { id: 'conflicted', label: '冲突文件', tag: 'danger' },
  { id: 'staged', label: '已暂存文件', tag: 'success' },
  { id: 'unstaged', label: '未暂存文件', tag: 'warning' },
  { id: 'untracked', label: '未跟踪文件', tag: 'info' },
]

/** XY letter → badge text, matching the reference's Chinese status labels. */
const STATUS_TEXT = {
  M: '已修改',
  T: '类型变更',
  A: '新增',
  D: '已删除',
  R: '已重命名',
  C: '已复制',
  U: '冲突',
  '?': '未跟踪',
  '!': '已忽略',
  ' ': '未变更',
}

/** XY letter → the one-character indicator the diff file list shows. */
const STATUS_MARK = { M: '~', A: '+', D: '-', R: '→', C: '⎘', T: '±', U: '!', '?': '?' }

/** Which repository operation is half-finished, and how to say so. */
const REPO_STATE_TEXT = {
  clean: '',
  merging: '正在合并',
  rebasing: '正在变基',
  cherry_picking: '正在挑选提交',
  reverting: '正在回滚',
  bisecting: '正在二分查找',
}

/** Reset modes, verbatim from the reference's dialog. */
const RESET_MODES = [
  { id: 'soft', label: '软重置 (--soft)', hint: '软重置仅移动 HEAD，保留暂存区与工作区改动。', tone: 'info' },
  { id: 'mixed', label: '混合重置 (--mixed)', hint: '混合重置会重置暂存区，并保留工作区改动。', tone: 'warning' },
  { id: 'hard', label: '硬重置 (--hard)', hint: '硬重置会丢弃工作区和暂存区改动，且不可恢复，请再次确认。', tone: 'error' },
  { id: 'keep', label: '保留重置 (--keep)', hint: '保留重置会尽量保留本地改动，遇到冲突时中止。', tone: 'info' },
]

/** Merge modes offered by the merge dialog. */
const MERGE_MODES = [
  { id: 'default', label: '默认（可快进则快进）' },
  { id: 'no-ff', label: '总是创建合并提交 (--no-ff)' },
  { id: 'ff-only', label: '仅允许快进 (--ff-only)' },
  { id: 'squash', label: '压缩合并 (--squash)' },
]

/** Pull modes offered by the pull dialog. */
const PULL_MODES = [
  { id: 'merge', label: '合并 (merge)' },
  { id: 'rebase', label: '变基 (rebase)' },
  { id: 'ff-only', label: '仅快进 (ff-only)' },
]

/** Push force modes. `lease` is offered first because it is the safe one. */
const PUSH_FORCE_MODES = [
  { id: 'none', label: '不强制' },
  { id: 'lease', label: '带租约强制 (--force-with-lease)' },
  { id: 'force', label: '强制 (--force)' },
]

/** The AI writer's two styles and two languages. */
const AI_STYLES = [
  { id: 'conventional', label: 'Conventional Commits' },
  { id: 'plain', label: '普通描述' },
]
const AI_LANGUAGES = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
]

/** History page sizes. */
const PAGE_SIZES = [50, 100, 200, 500]

/** Diff context-line choices. */
const CONTEXT_CHOICES = [0, 1, 3, 6, 12, 25]

/** Lane palette for the commit graph, verbatim from the reference. */
const LANE_COLORS = [
  '#0A66C2', '#F57C00', '#2E7D32', '#C62828',
  '#6A1B9A', '#00838F', '#455A64', '#AD1457',
]

/** Graph geometry, verbatim from the reference's BranchGraph. */
const GRAPH = { laneGap: 14, sidePadding: 20, rowHeight: 28, nodeRadius: 4, topY: -1 }

/** How many branch chips a history row shows before collapsing into "+N". */
const BRANCH_CHIP_LIMIT = 3

/** Localize the host's stable error codes; unknown codes keep their prose. */
function friendlyError(error) {
  const message = messageOf(error)
  switch (codeOf(error)) {
    case 'not_repo': return '这个工作区不是一个 git 仓库'
    case 'git_missing': return '找不到 git，可执行程序没装或不在 PATH 上'
    case 'auth_required': return '需要账号密码或 Token：' + message
    case 'ssh_auth': return 'SSH 认证失败：' + message
    case 'network': return '网络不通或远端不可达：' + message
    case 'locked': return message
    case 'conflict': return '存在冲突：' + message
    case 'rejected': return '远端拒绝了这次推送：' + message
    case 'nothing_to_do': return message
    case 'timeout': return '操作超时：' + message
    case 'too_large': return '内容太大，已放弃：' + message
    case 'ai_unavailable': return message
    case 'invalid_input': return '请求不合法：' + message
    case 'not_found': return message
    default: return message
  }
}

/** Message of an unknown throwable, never `[object Object]`. */
function messageOf(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Stable code of an error envelope, or ''. */
function codeOf(error) {
  return error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
}

/** Short form of an object id. */
function shortOid(oid, length) {
  const text = String(oid ?? '')
  const size = typeof length === 'number' ? length : 7
  return text.length <= size ? text : text.slice(0, size)
}

/** The subject line of a commit message. */
function subjectOf(message) {
  const text = String(message ?? '')
  const cut = text.search(/\n\s*\n/)
  const head = cut === -1 ? text : text.slice(0, cut)
  return head.replace(/\s+/g, ' ').trim()
}

/** `ahead 2 / behind 1` as the compact string the badges show. */
function trackText(ahead, behind) {
  const parts = []
  if (ahead > 0) parts.push('↑' + ahead)
  if (behind > 0) parts.push('↓' + behind)
  return parts.join(' ')
}

/** The basename of a path, for a row that shows a file's own name. */
function baseName(path) {
  const text = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = text.lastIndexOf('/')
  return cut === -1 ? text : text.slice(cut + 1)
}

/** The directory part of a path, or '' at the root. */
function dirName(path) {
  const text = String(path ?? '').replace(/\\/g, '/')
  const cut = text.lastIndexOf('/')
  return cut === -1 ? '' : text.slice(0, cut)
}

/** A byte count as the panel shows it. */
function formatBytes(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / (1024 * 1024)).toFixed(1) + ' MB'
}
