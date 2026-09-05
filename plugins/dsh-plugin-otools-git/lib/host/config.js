/**
 * Git configuration the settings dialog edits, plus the `git` installation probe
 * the empty state shows.
 *
 * Only the keys the panel actually offers are read, and each is read at both
 * scopes so the dialog can show "this repository / global" the way the reference
 * does. Writes always name their scope explicitly — a `git config` without
 * `--local` or `--global` silently picks one.
 *
 * @module dsh-plugin-otools-git/host/config
 */
import { execFile } from 'node:child_process'
import { ERR, GitError, normalizeEnum } from '../shared/protocol.js'
import { gitFailure, gitLines, runGit, tryGit } from './git.js'

/** The keys the settings dialog exposes. Anything else stays out of reach. */
export const EDITABLE_KEYS = [
  'user.name',
  'user.email',
  'core.autocrlf',
  'core.ignorecase',
  'core.longpaths',
  'pull.rebase',
  'push.default',
  'push.autoSetupRemote',
  'merge.ff',
  'commit.gpgsign',
  'init.defaultBranch',
  'diff.renames',
  'fetch.prune',
  'credential.helper',
  'http.proxy',
  'https.proxy',
  'http.sslVerify',
]

/** Scopes a write may name. */
export const SCOPES = ['local', 'global']

/** Read one key at one scope, or undefined when unset. */
export async function readConfig(root, key, scope) {
  const args = ['config']
  if (scope !== undefined) args.push(`--${scope}`)
  args.push('--get', key)
  const result = await tryGit(root, args, { timeoutMs: 15_000 })
  if (result.code !== 0) return undefined
  const value = result.stdout.replace(/\r?\n$/, '')
  return value.length === 0 ? undefined : value
}

/** Every editable key at both scopes plus the effective value. */
export async function readSettings(root) {
  const out = {}
  await Promise.all(EDITABLE_KEYS.map(async (key) => {
    const [local, global, effective] = await Promise.all([
      readConfig(root, key, 'local'),
      readConfig(root, key, 'global'),
      readConfig(root, key, undefined),
    ])
    out[key] = { local, global, effective }
  }))
  return out
}

/** Write (or unset, when `value` is undefined) one key at one scope. */
export async function writeConfig(root, key, value, scope) {
  if (!EDITABLE_KEYS.includes(key)) {
    throw new GitError(ERR.invalidInput, `${key} 不在可编辑的配置项里`)
  }
  const where = normalizeEnum(scope ?? 'local', SCOPES, 'scope')
  if (value === undefined || value === null || String(value).length === 0) {
    const result = await tryGit(root, ['config', `--${where}`, '--unset-all', key], { timeoutMs: 15_000 })
    // Unsetting something already unset is success, not failure.
    if (result.code !== 0 && !/no such|does not contain a value/i.test(result.stderr) && result.code !== 5) {
      throw gitFailure(['config', '--unset-all', key], result)
    }
    return { key, scope: where, value: undefined }
  }
  const text = String(value)
  if (text.length > 4_096) throw new GitError(ERR.invalidInput, `${key} 的值太长`)
  await runGit({ cwd: root, args: ['config', `--${where}`, key, text], timeoutMs: 15_000 })
  return { key, scope: where, value: text }
}

/** The identity a commit would carry right now. */
export async function readIdentity(root) {
  const [localName, localEmail, globalName, globalEmail] = await Promise.all([
    readConfig(root, 'user.name', 'local'),
    readConfig(root, 'user.email', 'local'),
    readConfig(root, 'user.name', 'global'),
    readConfig(root, 'user.email', 'global'),
  ])
  return {
    localName,
    localEmail,
    globalName,
    globalEmail,
    // "This repository follows the global identity" is exactly "no local override".
    useGlobal: localName === undefined && localEmail === undefined,
    effectiveName: localName ?? globalName,
    effectiveEmail: localEmail ?? globalEmail,
    configured: (localName ?? globalName) !== undefined && (localEmail ?? globalEmail) !== undefined,
  }
}

/** `git --version` and where the binary lives, for the empty state. */
export async function installationStatus() {
  const version = await tryGit(process.cwd(), ['--version'], { timeoutMs: 15_000 })
  if (version.code !== 0) {
    return {
      installed: false,
      version: '',
      os: osName(),
      message: '未检测到 Git 可执行程序',
    }
  }
  const path = await whichGit()
  const text = version.stdout.trim()
  // `--diff-merges` (git 2.31, 2021-03) is what makes a merge commit's diff
  // correct; below that the commit viewer would show an empty diff for merges and
  // there would be nothing on screen to explain why.
  const supported = atLeast(text, 2, 31)
  return {
    installed: true,
    version: text,
    binaryPath: path,
    os: osName(),
    tooOld: !supported,
    message: supported ? 'Git 已安装' : `${text} 太旧了，合并提交的差异需要 git 2.31 以上`,
  }
}

/** Is the reported git version at least major.minor? */
export function atLeast(versionText, major, minor) {
  const match = String(versionText ?? '').match(/(\d+)\.(\d+)/)
  if (match === null) return true
  const foundMajor = Number.parseInt(match[1], 10)
  const foundMinor = Number.parseInt(match[2], 10)
  if (foundMajor !== major) return foundMajor > major
  return foundMinor >= minor
}

/** The platform label the install guide switches on. */
export function osName() {
  switch (process.platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    default: return 'Unknown'
  }
}

/** Locate the git binary without a shell. */
async function whichGit() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  return new Promise((resolveResult) => {
    execFile(finder, ['git'], { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolveResult('')
        return
      }
      resolveResult(String(stdout).split(/\r?\n/)[0].trim())
    })
  })
}

/**
 * The `safe.directory` repair the "dubious ownership" error asks for.
 *
 * Narrow on purpose, and the narrowness is enforced rather than merely intended:
 * `*` (which switches git's ownership check off machine-wide) and any relative
 * path are refused, and the caller must have already resolved each entry to a
 * repository root DSH knows about. This writes to the user's GLOBAL git config,
 * so it is the one route where "the browser asked for it" is not enough.
 */
export async function addSafeDirectories(root, paths) {
  const existing = new Set(await gitLines(root, [
    'config', '--global', '--get-all', 'safe.directory',
  ], { timeoutMs: 15_000, allowFailure: true }).then(
    (lines) => lines.map((line) => normalizeSafePath(line)),
  ))
  let added = 0
  let skipped = 0
  for (const path of paths) {
    if (path === '*' || path === '%(prefix)' || path.startsWith('-')) {
      throw new GitError(ERR.invalidInput, `拒绝把 ${path} 写进 safe.directory —— 那会关掉 git 的所有权检查`)
    }
    if (!isAbsolutePath(path)) {
      throw new GitError(ERR.invalidInput, `safe.directory 只接受绝对路径：${path}`)
    }
    const normalized = normalizeSafePath(path)
    if (normalized.length === 0 || existing.has(normalized)) {
      skipped += 1
      continue
    }
    await runGit({ cwd: root, args: ['config', '--global', '--add', 'safe.directory', path], timeoutMs: 15_000 })
    existing.add(normalized)
    added += 1
  }
  return {
    added,
    skipped,
    message: added > 0
      ? `safe.directory 配置完成：新增 ${added} 项，跳过 ${skipped} 项`
      : `safe.directory 已存在，无需修改（跳过 ${skipped} 项）`,
  }
}

/** Is this an absolute path on either platform convention? */
function isAbsolutePath(value) {
  const text = String(value ?? '')
  return text.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')
}

/** Compare key for safe.directory entries (Windows paths are case-insensitive). */
function normalizeSafePath(value) {
  const text = String(value ?? '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? text.toLowerCase() : text
}
