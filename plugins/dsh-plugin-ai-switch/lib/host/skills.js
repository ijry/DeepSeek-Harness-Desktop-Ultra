/**
 * Agent Skills: eleven CLIs, each with its own set of skill directories on disk.
 *
 * A "skill" is a Markdown file with YAML front matter that an agent CLI loads as an
 * instruction pack — `<dir>/<id>/SKILL.md` for ten of the eleven agents, and additionally a
 * bare `<dir>/<id>.md` for Codex, which is the only one that reads loose files. Like the MCP
 * module, there is no database: the state IS the directories, so listing is a scan and
 * saving is a write into somebody else's tool's directory.
 *
 * This is a port of `src-tauri/src/skills/**` (paths.rs, service.rs, frontmatter.rs,
 * packages.rs). The directory tables are transcribed exactly, read-only roots included,
 * because a wrong path here means the panel shows an empty list for a CLI that has skills,
 * and a missing read-only flag means the delete button offers to remove Codex's built-ins.
 *
 * Two deliberate deviations from the reference:
 *
 * 1. **Front matter is read by a 60-line reader, not a YAML library.** The key set is fixed
 *    and tiny (`name`, `display_name`, `description`, `category`, `tags`, `language`), all
 *    scalars except `tags`, and this plugin takes no runtime dependencies. Anything the
 *    reader does not understand is simply absent metadata, and the skill still lists under
 *    its directory name — the same fallback the reference uses for a file with no front
 *    matter at all. It never rewrites the file, so an exotic document cannot be damaged.
 * 2. **`installPackage` needs a bundled source tree this plugin does not ship.** The
 *    reference copies the two built-in packs out of `src-tauri/resources/skill-packages/`.
 *    A dsh plugin has no Tauri resource bundle, so the tree is looked for in
 *    `AI_SWITCH_SKILL_PACKAGES_DIR`, in `<plugin>/resources/skill-packages`, and in
 *    `~/.dsh/dsh-plugin-ai-switch/skill-packages`; when none of them holds both packs,
 *    install refuses with `skills.package_source_missing` and says where to put them. That
 *    is a refusal, not a silent no-op, because "install" reporting success without copying
 *    anything is worse than an error. UNINSTALL is ported faithfully and does work: it only
 *    ever deletes paths a listing already reported, so it needs no source tree at all, and
 *    refusing it would strand a pack the desktop app installed.
 *
 * Security, since every path here comes from the panel: a skill id must be a safe file name
 * (no separator, no drive colon, no leading dot, no whitespace, no control characters) and
 * the resolved path must still sit inside its storage root WITH the separator included in
 * the comparison, so `<root>-secrets` cannot masquerade as a child of `<root>`. Deletion
 * additionally only ever targets a path a prior listing reported, and never one in a
 * read-only directory.
 *
 * @module dsh-plugin-ai-switch/host/skills
 */
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

import { ApiError, requireText, validation } from '../shared/protocol.js'

import { dshHomePath, pluginHomePath, userHome, writeFileAtomic } from './sdk.js'
import { envPath } from './sessions.js'

/**
 * The eleven agent ids, in `SkillAgentType::ALL` order — Codex first, because it is the one
 * the packages screen defaults to.
 */
export const SKILL_AGENTS = [
  'codex',
  'claude_code',
  'gemini',
  'grok',
  'open_code',
  'open_claw',
  'hermes',
  'cline',
  'cursor',
  'kimi_code',
  'code_buddy',
]

/** `SkillAgentType::display_name`. */
const AGENT_DISPLAY_NAMES = {
  codex: 'Codex CLI',
  claude_code: 'Claude Code',
  gemini: 'Gemini CLI',
  grok: 'Grok',
  open_code: 'OpenCode',
  open_claw: 'OpenClaw',
  hermes: 'Hermes Agent',
  cline: 'Cline',
  cursor: 'Cursor',
  kimi_code: 'Kimi Code',
  code_buddy: 'CodeBuddy',
}

/** The two scopes and the two on-disk layouts, as the panel spells them. */
const SCOPES = ['global', 'project']
const LAYOUTS = ['markdown_file', 'skill_directory']

/** The file a `skill_directory` keeps its content in. */
const SKILL_FILE = 'SKILL.md'

/** Only Codex reads a bare `<id>.md`; everyone else needs a directory. */
const DIRECTORY_ONLY = 'skill_directory_only'
const DIRECTORY_OR_FILE = 'skill_directory_or_markdown_file'

const readOnlySkill = () =>
  validation('skills.read_only', 'Built-in Skill is read-only')

const skillIo = (message, details) =>
  new ApiError('skills.config_io', message, { details, recoverable: true })

/** Normalize an agent id, or throw. */
function requireAgent(value) {
  const id = String(value ?? '').trim()
  if (!SKILL_AGENTS.includes(id)) {
    throw validation('skills.unknown_agent', `Unknown Skills agent: ${id || '(blank)'}`, id)
  }
  return id
}

/** Normalize a scope; absent means `global`, as in the reference's command layer. */
function requireScope(value) {
  const scope = String(value ?? '').trim()
  if (scope.length === 0) {
    return 'global'
  }
  if (!SCOPES.includes(scope)) {
    throw validation('skills.invalid_scope', `Unknown Skills scope: ${scope}`, scope)
  }
  return scope
}

/** Normalize a layout, or `null` when the caller did not choose one. */
function requireLayout(value) {
  const layout = String(value ?? '').trim()
  if (layout.length === 0) {
    return null
  }
  if (!LAYOUTS.includes(layout)) {
    throw validation('skills.invalid_layout', `Unknown Skill layout: ${layout}`, layout)
  }
  return layout
}

// ---------------------------------------------------------------------------
// paths.rs
// ---------------------------------------------------------------------------

/**
 * Every agent's skill directories, transcribed from `skill_storage_spec`.
 *
 * `global` is absolute paths in scan order; `project` is paths relative to the workspace
 * root; `readOnly` is the roots we may read but never write, which is Codex's bundled
 * `.system` pack and Cursor's own `skills-cursor`. Resolved on call so a changed
 * `CODEX_HOME` / `GROK_HOME` / `HERMES_HOME` / `KIMI_CODE_HOME` is honoured (and so the
 * tests can point them at a temporary directory).
 */
function storageSpec(agent) {
  const home = userHome()
  switch (agent) {
    case 'claude_code':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.claude', 'skills')],
        project: [join('.claude', 'skills')],
        readOnly: [],
      }
    case 'codex': {
      const root = envPath('CODEX_HOME', join(home, '.codex'))
      return {
        // The only agent that also loads a loose `<id>.md`.
        kind: DIRECTORY_OR_FILE,
        global: [join(root, 'skills'), join(root, 'skills', '.system'), join(home, '.agents', 'skills')],
        project: [join('.codex', 'skills'), join('.agents', 'skills')],
        readOnly: [join(root, 'skills', '.system')],
      }
    }
    case 'gemini':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.gemini', 'skills'), join(home, '.agents', 'skills')],
        project: [join('.gemini', 'skills'), join('.agents', 'skills')],
        readOnly: [],
      }
    case 'grok': {
      const root = envPath('GROK_HOME', join(home, '.grok'))
      return {
        kind: DIRECTORY_ONLY,
        global: [join(root, 'skills')],
        project: [join('.grok', 'skills')],
        readOnly: [],
      }
    }
    case 'open_code':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.config', 'opencode', 'skills'), join(home, '.agents', 'skills')],
        // Note the order: `.agents/skills` before `.opencode/skills`, as in the reference.
        project: [join('.agents', 'skills'), join('.opencode', 'skills')],
        readOnly: [],
      }
    case 'open_claw':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.openclaw', 'skills')],
        // OpenClaw reads a bare `skills/` at the project root, not a dotted directory.
        project: ['skills'],
        readOnly: [],
      }
    case 'hermes':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(envPath('HERMES_HOME', join(home, '.hermes')), 'skills')],
        // Hermes has no project-scoped skills at all; the panel shows an empty list.
        project: [],
        readOnly: [],
      }
    case 'cline':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.agents', 'skills'), join(home, '.cline', 'skills')],
        project: [
          join('.agents', 'skills'),
          join('.cline', 'skills'),
          join('.clinerules', 'skills'),
          join('.claude', 'skills'),
        ],
        readOnly: [],
      }
    case 'cursor':
      return {
        kind: DIRECTORY_ONLY,
        global: [
          join(home, '.cursor', 'skills'),
          join(home, '.agents', 'skills'),
          join(home, '.cursor', 'skills-cursor'),
        ],
        project: [join('.cursor', 'skills'), join('.agents', 'skills')],
        // Cursor ships its own pack here and rewrites it on update; ours to read only.
        readOnly: [join(home, '.cursor', 'skills-cursor')],
      }
    case 'kimi_code': {
      const root = envPath('KIMI_CODE_HOME', join(home, '.kimi-code'))
      return {
        kind: DIRECTORY_ONLY,
        global: [join(root, 'skills')],
        project: [join('.kimi-code', 'skills')],
        readOnly: [],
      }
    }
    case 'code_buddy':
      return {
        kind: DIRECTORY_ONLY,
        global: [join(home, '.codebuddy', 'skills')],
        project: [join('.codebuddy', 'skills')],
        readOnly: [],
      }
    default:
      throw validation('skills.unknown_agent', `Unknown Skills agent: ${agent}`, agent)
  }
}

/**
 * Is `child` inside `parent`?
 *
 * The separator is part of the prefix, so `<root>-secrets` is NOT inside `<root>`. This is
 * the check the reference gets from `Path::starts_with` (which compares components); the
 * string comparison needs the separator spelled out to mean the same thing.
 *
 * Lexical only, never `realpath`: resolving symlinks here would let a link inside the root
 * decide the answer, and we would rather refuse a legitimate link than follow a hostile one.
 *
 * Exported for the tests: it and `resolveSkillPath` are the whole path-safety surface, and
 * the sibling-prefix case they defend against is not reachable through a public call once
 * `validateSkillId` has run — which is exactly why it deserves a direct test.
 */
export function pathIsInsideRoot(parent, child) {
  const root = normalizeForCompare(parent)
  const target = normalizeForCompare(child)
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Absolute, and case-folded on Windows where two spellings are one file. */
function normalizeForCompare(path) {
  const absolute = resolve(String(path ?? ''))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Is this path one of the agent's read-only roots, or inside one? */
function isReadOnlyPath(spec, path) {
  return spec.readOnly.some((root) => pathIsInsideRoot(root, path))
}

/**
 * Which pack a global directory belongs to, per `source_for_path`.
 *
 * Only a read-only root literally named `.system` counts as `builtin`, and only an
 * `.agents/skills` directory counts as `agents`; everything else reports `codex` — which
 * reads oddly for, say, Gemini, but it is what the reference returns and what the panel's
 * badge copy is written against.
 */
function sourceForDir(spec, dir) {
  const matches = (root) => pathIsInsideRoot(root, dir)
  if (spec.readOnly.some((root) => matches(root) && basenameOf(root) === '.system')) {
    return 'builtin'
  }
  if (
    spec.global.some(
      (root) => matches(root) && basenameOf(root) === 'skills' && basenameOf(dirname(root)) === '.agents',
    )
  ) {
    return 'agents'
  }
  return 'codex'
}

/** The last path segment, separator-agnostic. */
function basenameOf(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * A skill id has to be a safe file name.
 *
 * Rejected: blank, `.`, `..`, anything starting with `.` (which is how the read-only
 * `.system` directory is spelled, so allowing it would let a caller address it), any `/`,
 * `\` or `:` (the last one is a Windows drive/stream separator), any whitespace, and any
 * control character. What is left cannot escape a directory or name a device.
 */
export function validateSkillId(value) {
  const id = String(value ?? '').trim()
  if (
    id.length === 0 ||
    id === '.' ||
    id === '..' ||
    id.startsWith('.') ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes(':') ||
    /\s/.test(id) ||
    // eslint-disable-next-line no-control-regex -- escapes only; never a literal control char.
    /[\u0000-\u001F\u007F]/.test(id)
  ) {
    throw validation('validation.skill_id', 'Skill id is not a safe file name', id)
  }
  return id
}

/**
 * The directories one (agent, scope) pair scans, in order, each with its read-only flag.
 *
 * @returns `[{path, read_only, source}]` — the shape `listSkills` and `installPackage` both
 *   need, so the read-only flag travels with the path instead of being recomputed.
 */
export function skillDirs(agentType, scope, workspacePath) {
  const agent = requireAgent(agentType)
  const which = requireScope(scope)
  const spec = storageSpec(agent)
  if (which === 'global') {
    return spec.global.map((path) => ({
      path,
      read_only: isReadOnlyPath(spec, path),
      source: sourceForDir(spec, path),
    }))
  }
  const root = String(workspacePath ?? '').trim()
  if (root.length === 0) {
    throw validation('skills.path_invalid', 'Project directory is required', 'workspace_path')
  }
  return spec.project.map((relative) => ({
    path: join(root, relative),
    read_only: false,
    // Everything project-scoped reports `project`, whatever directory it came from.
    source: 'project',
  }))
}

/** The content file of a skill: `<path>/SKILL.md`, or `<path>` for a loose `.md`. */
function contentPath(layout, path) {
  return layout === 'skill_directory' ? join(path, SKILL_FILE) : path
}

/**
 * Where a skill id lands under `root`, refusing anything that escapes it.
 *
 * Two checks, because they catch different things: the id validation stops `../evil` and
 * `C:\evil` before a path is built at all, and the containment check stops the case the
 * validation cannot see — a root that is itself a link, or a platform that normalizes the
 * name into something else.
 */
function resolveSkillPath(root, id, layout) {
  const safe = validateSkillId(id)
  const path = layout === 'markdown_file' ? join(root, `${safe}.md`) : join(root, safe)
  if (!pathIsInsideRoot(root, path) || normalizeForCompare(path) === normalizeForCompare(root)) {
    throw validation('validation.skill_path', 'Skill path escapes its storage directory', path)
  }
  return path
}

// ---------------------------------------------------------------------------
// frontmatter.rs
// ---------------------------------------------------------------------------

/** The six keys the panel reads out of front matter. Everything else is body text to us. */
const METADATA_KEYS = ['name', 'display_name', 'description', 'category', 'tags', 'language']

/**
 * Parse the leading `---` block of a skill document.
 *
 * Deliberately small: scalars and a `tags` value that is either a comma-separated string or
 * a block sequence. A key whose value spans lines (a `|` block, a flow mapping) is ignored
 * rather than guessed at, and `null` metadata is a valid answer — the caller falls back to
 * the directory name.
 */
export function parseFrontmatter(content) {
  const text = String(content ?? '')
  if (!text.startsWith('---')) {
    return null
  }
  const rest = text.slice(3)
  const end = rest.indexOf('\n---')
  if (end === -1) {
    return null
  }
  const metadata = { name: null, display_name: null, description: null, category: null, tags: [], language: null }
  const lines = rest.slice(0, end).replace(/\r\n/g, '\n').split('\n')
  let listKey = null
  const tags = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }
    if (trimmed.startsWith('- ')) {
      if (listKey === 'tags') {
        tags.push(unquoteScalar(trimmed.slice(2)))
      }
      continue
    }
    const at = trimmed.indexOf(':')
    if (at === -1) {
      continue
    }
    const key = trimmed.slice(0, at).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    // Only a top-level key counts; an indented one belongs to a structure we do not read.
    if (line.length - line.trimStart().length > 0 || !METADATA_KEYS.includes(key)) {
      listKey = null
      continue
    }
    const raw = trimmed.slice(at + 1).trim()
    if (raw.length === 0) {
      listKey = key
      continue
    }
    listKey = null
    if (key === 'tags') {
      if (raw.startsWith('[') && raw.endsWith(']')) {
        for (const item of raw.slice(1, -1).split(',')) {
          tags.push(unquoteScalar(item))
        }
      } else {
        for (const item of unquoteScalar(raw).split(',')) {
          tags.push(item)
        }
      }
      continue
    }
    const value = unquoteScalar(raw)
    metadata[key] = value.length === 0 ? null : value
  }
  const unique = []
  for (const tag of tags.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)) {
    if (!unique.includes(tag)) {
      unique.push(tag)
    }
  }
  metadata.tags = unique
  return metadata
}

/** One front-matter scalar with its quotes removed. */
function unquoteScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'string' ? parsed : text.slice(1, -1)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

// ---------------------------------------------------------------------------
// service.rs
// ---------------------------------------------------------------------------

/** Does this path exist, and is it a directory / a file? */
async function statKind(path) {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
  } catch {
    return null
  }
}

/** Read a text file, or `null` when it is not there. */
async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw skillIo('Could not read Skill content', `${path}: ${String(error?.code ?? error)}`)
  }
}

/** Build one `SkillItem` from a document's front matter. */
function skillItem({ id, scope, layout, path, content, readOnly, source, agent }) {
  const metadata = parseFrontmatter(content) ?? {
    name: null,
    display_name: null,
    description: null,
    category: null,
    tags: [],
    language: null,
  }
  return {
    id,
    // `display_name` wins over `name`, and the id is the last resort.
    name: metadata.display_name ?? metadata.name ?? id,
    scope,
    layout,
    path,
    description: metadata.description,
    read_only: readOnly,
    package_id: null,
    package_name: null,
    category: metadata.category,
    tags: metadata.tags,
    language: metadata.language,
    source,
    version: null,
    installed_at: null,
    target_clients: [agent],
  }
}

/**
 * Every skill in one directory, sorted by id.
 *
 * A missing directory is empty, not an error — most of the eleven agents are not installed
 * on any given machine. An entry we cannot read is skipped for the same reason the MCP scan
 * skips a bad config entry: one unreadable file must not blank the list.
 */
async function listSkillsInDir({ scope, dir, kind, readOnly, source, agent }) {
  if ((await statKind(dir)) !== 'dir') {
    return []
  }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw skillIo('Could not read Skills directory', `${dir}: ${String(error?.code ?? error)}`)
  }
  const found = new Map()
  for (const entry of entries) {
    const path = join(dir, entry.name)
    // `stat` rather than the dirent, so a symlinked skill directory lists like the
    // reference's `path.is_dir()` does.
    const entryKind = await statKind(path)
    if (entryKind === 'dir') {
      const content = await readTextOrNull(join(path, SKILL_FILE)).catch(() => null)
      if (content === null) {
        continue
      }
      found.set(
        entry.name,
        skillItem({ id: entry.name, scope, layout: 'skill_directory', path, content, readOnly, source, agent }),
      )
      continue
    }
    if (kind === DIRECTORY_OR_FILE && entryKind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
      const id = entry.name.slice(0, -3)
      if (id.length === 0 || found.has(id)) {
        continue
      }
      const content = await readTextOrNull(path).catch(() => null)
      if (content === null) {
        continue
      }
      found.set(id, skillItem({ id, scope, layout: 'markdown_file', path, content, readOnly, source, agent }))
    }
  }
  return Array.from(found.values()).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** The eleven agents; all of them support skills, which is why the flag is a constant. */
export async function listAgents() {
  return SKILL_AGENTS.map((agent) => ({
    agent_type: agent,
    display_name: AGENT_DISPLAY_NAMES[agent],
    skills_capable: true,
  }))
}

/**
 * Every skill one agent can see in one scope, plus the directories that were scanned.
 *
 * The FIRST directory (in scan order) that defines an id wins, which is what makes an
 * agent's own `skills/` shadow a shared `.agents/skills/` entry of the same name — the same
 * precedence the CLIs themselves apply.
 *
 * `locations` is returned even for directories that do not exist: the panel prints them with
 * a hollow bullet, which is how a user finds out WHERE to put a skill.
 */
export async function listSkills({ agentType, scope, workspacePath } = {}) {
  const agent = requireAgent(agentType)
  const which = requireScope(scope)
  const spec = storageSpec(agent)
  const dirs = skillDirs(agent, which, workspacePath)

  if (which === 'project') {
    const root = String(workspacePath ?? '').trim()
    if ((await statKind(root)) !== 'dir') {
      throw validation('skills.directory_missing', 'Project directory does not exist', root)
    }
  }

  const index = builtinPackageIndex()
  const skills = new Map()
  const locations = []
  for (const dir of dirs) {
    locations.push({ scope: which, path: dir.path, exists: (await statKind(dir.path)) === 'dir' })
    const items = await listSkillsInDir({
      scope: which,
      dir: dir.path,
      kind: spec.kind,
      readOnly: dir.read_only,
      source: dir.source,
      agent,
    })
    for (const item of items) {
      if (skills.has(item.id)) {
        continue
      }
      const owner = index.get(item.id)
      if (owner !== undefined) {
        item.package_id = owner.package_id
        item.package_name = owner.package_name
      }
      skills.set(item.id, item)
    }
  }
  return {
    supported: true,
    message: null,
    locations,
    skills: Array.from(skills.values()).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  }
}

/** One skill's metadata plus its full Markdown. */
export async function readSkill({ agentType, scope, skillId, workspacePath } = {}) {
  const id = validateSkillId(skillId)
  const listing = await listSkills({ agentType, scope, workspacePath })
  const skill = listing.skills.find((item) => item.id === id)
  if (skill === undefined) {
    throw validation('skills.not_found', 'Skill was not found', id)
  }
  const content = await readTextOrNull(contentPath(skill.layout, skill.path))
  if (content === null) {
    throw skillIo('Could not read Skill content', skill.path)
  }
  return { skill, content }
}

/**
 * Create or overwrite a skill in the FIRST directory of the scope.
 *
 * An existing skill keeps its layout wherever it already lives — editing a Codex `<id>.md`
 * must not silently convert it into a directory. A new skill gets `skill_directory` unless
 * the caller asks otherwise, which is the reference's default for both storage kinds.
 */
export async function saveSkill({ agentType, scope, skillId, content, layout, workspacePath } = {}) {
  const agent = requireAgent(agentType)
  const which = requireScope(scope)
  const id = validateSkillId(skillId)
  const requested = requireLayout(layout)
  const body = typeof content === 'string' ? content : ''
  const spec = storageSpec(agent)
  const dirs = skillDirs(agent, which, workspacePath)

  const existing = (await listSkills({ agentType: agent, scope: which, workspacePath })).skills.find(
    (item) => item.id === id,
  )
  if (existing !== undefined && existing.read_only) {
    throw readOnlySkill()
  }
  if (dirs.length === 0) {
    throw validation('skills.directory_missing', 'No Skill directory is configured', agent)
  }

  const chosen = existing?.layout ?? requested ?? 'skill_directory'
  if (chosen === 'markdown_file' && spec.kind !== DIRECTORY_OR_FILE) {
    throw validation(
      'skills.invalid_layout',
      'This agent only reads Skills stored as a directory with SKILL.md',
      agent,
    )
  }
  // An existing skill is rewritten where it already is; a new one lands in the first
  // directory, which is the agent's own rather than a shared `.agents/skills`.
  const target = existing === undefined ? resolveSkillPath(dirs[0].path, id, chosen) : existing.path
  const root = existing === undefined ? dirs[0].path : rootOf(dirs, existing.path)
  if (root === null || !pathIsInsideRoot(root, target)) {
    throw validation('validation.skill_path', 'Skill path escapes its storage directory', target)
  }
  if (isReadOnlyPath(spec, target) || (existing === undefined && dirs[0].read_only)) {
    throw readOnlySkill()
  }

  const file = contentPath(chosen, target)
  if (!pathIsInsideRoot(root, file)) {
    throw validation('validation.skill_path', 'Skill path escapes its storage directory', file)
  }
  try {
    await mkdir(dirname(file), { recursive: true })
  } catch (error) {
    throw skillIo('Could not create Skill directory', String(error?.code ?? error))
  }
  // 0o644: a skill is documentation the user edits, not a secret.
  await writeFileAtomic(file, body, 0o644)

  const saved = (await listSkills({ agentType: agent, scope: which, workspacePath })).skills.find(
    (item) => item.id === id,
  )
  if (saved === undefined) {
    throw validation('skills.config_invalid', 'Skill was saved but could not be reloaded', id)
  }
  return saved
}

/** Which scanned directory a listed path belongs to, or `null`. */
function rootOf(dirs, path) {
  for (const dir of dirs) {
    if (pathIsInsideRoot(dir.path, path)) {
      return dir.path
    }
  }
  return null
}

/**
 * Delete a skill.
 *
 * Only ever the path a listing just reported, and never a read-only one. `false` (not an
 * error) when it was already gone, so a double click is not a failure.
 */
export async function deleteSkill({ agentType, scope, skillId, workspacePath } = {}) {
  const id = validateSkillId(skillId)
  const listing = await listSkills({ agentType, scope, workspacePath })
  const skill = listing.skills.find((item) => item.id === id)
  if (skill === undefined) {
    return false
  }
  if (skill.read_only) {
    throw readOnlySkill()
  }
  await removeSkillItem(skill, listing.locations)
  return true
}

/**
 * Remove one already-resolved skill.
 *
 * `locations` is the listing the item came from; the path has to still be inside one of
 * them, which is the last line of defence against a listing entry that was built from
 * something other than a scan.
 */
async function removeSkillItem(skill, locations) {
  if (!locations.some((location) => pathIsInsideRoot(location.path, skill.path))) {
    throw validation('validation.skill_path', 'Skill path escapes its storage directory', skill.path)
  }
  try {
    if (skill.layout === 'skill_directory') {
      await rm(skill.path, { recursive: true, force: false })
    } else {
      await rm(skill.path, { force: false })
    }
  } catch (error) {
    throw skillIo('Could not delete Skill', `${skill.path}: ${String(error?.code ?? error)}`)
  }
}

// ---------------------------------------------------------------------------
// packages.rs
// ---------------------------------------------------------------------------

/** `ai-switch.core` — the fourteen workflow skills, ids transcribed from the reference. */
const CORE_SKILL_IDS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans',
  'writing-skills',
]

/** `ai-switch.science` — the thirteen research skills. */
const SCIENCE_SKILL_IDS = [
  'citation-management',
  'experimental-design',
  'exploratory-data-analysis',
  'hypothesis-generation',
  'paper-lookup',
  'peer-review',
  'scholar-evaluation',
  'scientific-brainstorming',
  'scientific-critical-thinking',
  'scientific-schematics',
  'scientific-visualization',
  'statistical-analysis',
  'statistical-power',
]

/** The two built-in packs. Hardcoded in the reference, hardcoded here. */
const PACKAGE_SPECS = [
  {
    id: 'ai-switch.core',
    name: 'AI Switch Core Skill Pack',
    description: 'Core agent workflow Skills bundled by AI Switch.',
    skillIds: CORE_SKILL_IDS,
  },
  {
    id: 'ai-switch.science',
    name: 'AI Switch Science Skill Pack',
    description: 'Scientific research and analysis Skills bundled by AI Switch.',
    skillIds: SCIENCE_SKILL_IDS,
  },
]

/** Package operations are Codex-only in the reference; the panel's UI assumes it too. */
const PACKAGE_AGENT = 'codex'

/** skill id -> the pack that owns it, so a listing can annotate members. */
function builtinPackageIndex() {
  const index = new Map()
  for (const spec of PACKAGE_SPECS) {
    for (const skillId of spec.skillIds) {
      index.set(skillId, { package_id: spec.id, package_name: spec.name })
    }
  }
  return index
}

const packageNotFound = (packageId) =>
  validation('skills.package_not_found', 'Skill package was not found', packageId)

const packageOperationUnsupported = (message, details) =>
  validation('skills.package_operation_unsupported', message, details)

/** One pack's spec, or a not-found refusal. */
function packageSpec(packageId) {
  const id = requireText(packageId, 'package_id', 200)
  const spec = PACKAGE_SPECS.find((item) => item.id === id)
  if (spec === undefined) {
    throw packageNotFound(id)
  }
  return spec
}

/**
 * The member ids one call acts on: the whole pack when the caller names none, otherwise
 * exactly the ones it named.
 *
 * An id the pack does not contain is REJECTED rather than ignored — silently doing less than
 * asked is how an "install this one skill" button reports success having installed nothing.
 */
function requestedMemberIds(spec, skillIds) {
  if (skillIds === undefined || skillIds === null) {
    return spec.skillIds.map((id) => validateSkillId(id))
  }
  const resolved = []
  for (const raw of Array.isArray(skillIds) ? skillIds : []) {
    const id = validateSkillId(raw)
    if (!spec.skillIds.includes(id)) {
      throw validation('skills.package_member_missing', 'Skill is not a member of this package', `${spec.id}/${id}`)
    }
    if (!resolved.includes(id)) {
      resolved.push(id)
    }
  }
  return resolved
}

/** The `SkillPackage` row for one pack, given what is installed. */
function packageRow(spec, installed) {
  const installedIds = spec.skillIds.filter((id) => installed.has(id))
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    source: 'builtin',
    version: null,
    manifest_path: null,
    skill_ids: [...spec.skillIds],
    skill_count: spec.skillIds.length,
    installed_skill_ids: installedIds,
    installed_count: installedIds.length,
    installed_at: null,
    read_only: true,
    target_clients: [PACKAGE_AGENT],
  }
}

/** One pack member, with the installed skill attached when there is one. */
function memberRow(skillId, skill) {
  return {
    id: skillId,
    name: skill?.name ?? skillId,
    description: skill?.description ?? null,
    category: skill?.category ?? null,
    tags: skill === undefined ? [] : [...skill.tags],
    language: skill?.language ?? null,
    installed: skill !== undefined,
    skill: skill ?? null,
  }
}

/** `id -> SkillItem` for one (agent, scope). */
async function installedIndex({ agentType, scope, workspacePath }) {
  const listing = await listSkills({ agentType, scope, workspacePath })
  const index = new Map()
  for (const skill of listing.skills) {
    index.set(skill.id, skill)
  }
  return { index, locations: listing.locations }
}

/**
 * The two packs and which of their members are installed.
 *
 * Empty for every agent but Codex, matching the reference — the packs are written for
 * Codex's skill loader and the panel hides the tab for the others.
 */
export async function listPackages({ agentType, scope, workspacePath } = {}) {
  const agent = agentType === undefined || agentType === null ? PACKAGE_AGENT : requireAgent(agentType)
  const which = requireScope(scope)
  if (agent !== PACKAGE_AGENT) {
    return { packages: [], skills: [], warnings: [] }
  }
  const { index } = await installedIndex({ agentType: agent, scope: which, workspacePath })
  const ownedPackageIds = new Set(PACKAGE_SPECS.map((spec) => spec.id))
  const skills = Array.from(index.values())
    .filter((skill) => skill.package_id !== null && ownedPackageIds.has(skill.package_id))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const packages = PACKAGE_SPECS.map((spec) => packageRow(spec, index)).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  // `warnings` exists for a manifest scanner the reference does not ship either; the panel
  // renders the array when it is non-empty, so an empty one is the honest value.
  return { packages, skills, warnings: [] }
}

/** One pack with every member listed, installed or not. */
export async function readPackage({ packageId, agentType, scope, workspacePath } = {}) {
  const agent = agentType === undefined || agentType === null ? PACKAGE_AGENT : requireAgent(agentType)
  const which = requireScope(scope)
  if (agent !== PACKAGE_AGENT) {
    throw packageNotFound(String(packageId ?? ''))
  }
  const spec = packageSpec(packageId)
  const { index } = await installedIndex({ agentType: agent, scope: which, workspacePath })
  const members = spec.skillIds.map((skillId) => memberRow(skillId, index.get(skillId)))
  return {
    package: packageRow(spec, index),
    skills: members.map((member) => member.skill).filter((skill) => skill !== null),
    members,
  }
}

/**
 * Where the bundled pack sources could be.
 *
 * `AI_SWITCH_SKILL_PACKAGES_DIR` first (the reference honours the same variable), then two
 * places a dsh install can actually have them: shipped inside the plugin, or dropped into
 * the plugin's own state directory by hand. Nothing here searches `process.cwd()` — for a
 * plugin loaded into a long-running host that is somebody else's directory.
 */
function packageResourceRoots() {
  const roots = []
  const configured = String(process.env.AI_SWITCH_SKILL_PACKAGES_DIR ?? '').trim()
  if (configured.length > 0) {
    roots.push(configured)
  }
  // `src/host/skills.js` -> the plugin root.
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  roots.push(join(pluginRoot, 'resources', 'skill-packages'))
  roots.push(pluginHomePath('skill-packages'))
  roots.push(dshHomePath('skill-packages'))
  return roots
}

/** The first candidate root that holds BOTH packs, or a refusal naming the candidates. */
async function resolvePackageResourceRoot() {
  const roots = packageResourceRoots()
  for (const root of roots) {
    const present = []
    for (const spec of PACKAGE_SPECS) {
      present.push((await statKind(join(root, spec.id))) === 'dir')
    }
    if (present.every(Boolean)) {
      return root
    }
  }
  throw new ApiError(
    'skills.package_source_missing',
    'The bundled Skill pack files are not installed with this plugin. Put the "ai-switch.core" and "ai-switch.science" directories in one of the locations listed in details, or set AI_SWITCH_SKILL_PACKAGES_DIR, then try again.',
    { details: roots.join(' | '), recoverable: true },
  )
}

/**
 * Copy a source tree, never overwriting a file that already exists.
 *
 * "Missing only" is the reference's rule and it matters: a user who edited an installed
 * skill keeps their edit when the pack is installed again.
 */
async function copyMissingOnly(source, target) {
  const kind = await statKind(target)
  if (kind !== null && kind !== 'dir') {
    throw validation('validation.skill_path', 'Skill install target is not a directory', target)
  }
  if (kind === null) {
    try {
      await mkdir(target, { recursive: true })
    } catch (error) {
      throw skillIo('Could not create Skill directory', String(error?.code ?? error))
    }
  }
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    throw skillIo('Could not read bundled Skill resource', `${source}: ${String(error?.code ?? error)}`)
  }
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    // Containment re-checked per entry: a link inside the source tree must not write
    // outside the target.
    if (!pathIsInsideRoot(target, to)) {
      throw validation('validation.skill_path', 'Skill path escapes its storage directory', to)
    }
    const fromKind = await statKind(from)
    if (fromKind === 'dir') {
      await copyMissingOnly(from, to)
      continue
    }
    if (fromKind === 'file' && (await statKind(to)) === null) {
      try {
        await copyFile(from, to)
      } catch (error) {
        throw skillIo('Could not copy bundled Skill resource', `${to}: ${String(error?.code ?? error)}`)
      }
    }
  }
}

/**
 * Install a pack's members that are not already there.
 *
 * Codex only, like the reference. Already-present members are `skipped`, not overwritten, so
 * the button is safe to press twice.
 */
export async function installPackage({ packageId, agentType, scope, workspacePath, skillIds } = {}) {
  const agent = agentType === undefined || agentType === null ? PACKAGE_AGENT : requireAgent(agentType)
  const which = requireScope(scope)
  if (agent !== PACKAGE_AGENT) {
    throw packageOperationUnsupported(
      'AI Switch Skill packages can currently be installed for Codex CLI only',
      agent,
    )
  }
  const spec = packageSpec(packageId)
  const targets = requestedMemberIds(spec, skillIds)

  const dirs = skillDirs(agent, which, workspacePath)
  const writable = dirs.find((dir) => !dir.read_only)
  if (writable === undefined) {
    throw packageOperationUnsupported('No writable Skill directory is available for package installation')
  }

  const { index } = await installedIndex({ agentType: agent, scope: which, workspacePath })
  const resourceRoot = await resolvePackageResourceRoot()
  const packageRoot = join(resourceRoot, spec.id)
  const installedSkillIds = []
  const skippedSkillIds = []
  for (const id of targets) {
    if (index.has(id)) {
      skippedSkillIds.push(id)
      continue
    }
    const source = join(packageRoot, id)
    if ((await statKind(join(source, SKILL_FILE))) !== 'file') {
      throw packageOperationUnsupported('Bundled Skill resource is missing SKILL.md', source)
    }
    await copyMissingOnly(source, resolveSkillPath(writable.path, id, 'skill_directory'))
    installedSkillIds.push(id)
  }
  return { package_id: spec.id, installed_skill_ids: installedSkillIds, skipped_skill_ids: skippedSkillIds }
}

/**
 * Remove a pack's installed members.
 *
 * One listing serves every member, and only paths it reported are deleted — that is what
 * makes "uninstall the whole pack" unable to reach anything outside a scanned skill
 * directory. A member that was not installed, or lives in a read-only directory, is
 * `skipped` rather than an error, so uninstalling a pack still removes everything it can.
 */
export async function uninstallPackage({ packageId, agentType, scope, workspacePath, skillIds } = {}) {
  const agent = agentType === undefined || agentType === null ? PACKAGE_AGENT : requireAgent(agentType)
  const which = requireScope(scope)
  if (agent !== PACKAGE_AGENT) {
    throw packageOperationUnsupported(
      'AI Switch Skill packages can currently be uninstalled for Codex CLI only',
      agent,
    )
  }
  const spec = packageSpec(packageId)
  const targets = requestedMemberIds(spec, skillIds)
  const { index, locations } = await installedIndex({ agentType: agent, scope: which, workspacePath })
  const removedSkillIds = []
  const skippedSkillIds = []
  for (const id of targets) {
    const skill = index.get(id)
    if (skill === undefined || skill.read_only) {
      skippedSkillIds.push(id)
      continue
    }
    await removeSkillItem(skill, locations)
    removedSkillIds.push(id)
  }
  return { package_id: spec.id, removed_skill_ids: removedSkillIds, skipped_skill_ids: skippedSkillIds }
}
