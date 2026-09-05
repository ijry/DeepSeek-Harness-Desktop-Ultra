/**
 * Diffs: the file lists and the unified-diff text the viewer renders, for the
 * three sources the panel offers — a commit, the index (staged) and the worktree
 * (unstaged) — plus binary/image handling.
 *
 * Diff TEXT is returned as lines already classified (`add` / `del` / `meta` /
 * `context` / `hunk`), because the browser renders thousands of them and doing
 * the classification per repaint there is the difference between a smooth panel
 * and a janky one.
 *
 * @module dsh-plugin-otools-git/host/diff
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  DEFAULT_DIFF_CONTEXT,
  ERR,
  GitError,
  MAX_DIFF_LINES,
} from '../shared/protocol.js'
import { isInside } from './commit.js'
import { runGit, tryGit } from './git.js'

/** Extensions the viewer shows as an image instead of as text. */
export const IMAGE_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i

/** Cap on an inlined image preview (base64 inflates by 4/3). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Mime type for an image path, for the data: URL the browser builds. */
export function imageMime(path) {
  const ext = String(path ?? '').toLowerCase().split('.').pop()
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'avif': return 'image/avif'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    case 'svg': return 'image/svg+xml'
    case 'tif':
    case 'tiff': return 'image/tiff'
    default: return 'application/octet-stream'
  }
}

/** Whether a path renders as an image. */
export function isImagePath(path) {
  return IMAGE_RE.test(String(path ?? ''))
}

/**
 * The invocation for one diff source: which subcommand, the flags that select the
 * two sides, and the revisions.
 *
 * A commit uses `diff-tree`, NOT `diff`. `git diff <rev>^!` — the obvious
 * shorthand, and what the reference's libgit2 equivalent implies — is wrong twice
 * over: on a ROOT commit it silently degenerates into a diff against the current
 * HEAD (so the first commit in a repository appears to change everything since),
 * and on a MERGE commit it produces nothing at all. `diff-tree --root
 * --diff-merges=first-parent` is the one form that answers correctly for a root,
 * a normal and a merge commit alike.
 *
 * `--diff-merges` needs git >= 2.31 (2021-03); host/config.js reports a version
 * below that so the panel can say so instead of showing an empty diff.
 */
export function diffInvocation(source) {
  const kind = source?.kind
  if (kind === 'commit') {
    return {
      command: 'diff-tree',
      lead: ['--no-commit-id', '-r', '--root', '--diff-merges=first-parent'],
      revs: [source.rev],
    }
  }
  if (kind === 'range') return { command: 'diff', lead: [], revs: [`${source.from}...${source.to}`] }
  if (kind === 'two-dot') return { command: 'diff', lead: [], revs: [`${source.from}..${source.to}`] }
  if (kind === 'staged') return { command: 'diff', lead: [], revs: ['--cached'] }
  if (kind === 'worktree') return { command: 'diff', lead: [], revs: [] }
  if (kind === 'head') return { command: 'diff', lead: [], revs: ['HEAD'] }
  throw new GitError(ERR.invalidInput, `unknown diff source ${String(kind)}`)
}

/**
 * `git diff --numstat --name-status -z` for one source, merged into one row per
 * file. Two calls rather than `--raw` parsing: numstat gives the +/- counts the
 * summary strip shows and name-status gives the letter and the rename pair.
 */
export async function diffSummary(root, source) {
  const call = diffInvocation(source)
  const base = [call.command, '--no-color', '-M', '-C', '--find-renames', ...call.lead]
  const [nameStatus, numstat] = await Promise.all([
    runGit({ cwd: root, args: [...base, '--name-status', '-z', ...call.revs], timeoutMs: 120_000 }),
    runGit({ cwd: root, args: [...base, '--numstat', '-z', ...call.revs], timeoutMs: 120_000 }),
  ])
  const rows = parseNameStatusZ(nameStatus.stdout)
  const stats = parseNumstatZ(numstat.stdout)
  for (const row of rows) {
    const stat = stats.get(row.path)
    row.additions = stat === undefined ? 0 : stat.additions
    row.deletions = stat === undefined ? 0 : stat.deletions
    row.binary = stat === undefined ? false : stat.binary
    row.image = isImagePath(row.path)
  }
  return rows
}

/** Parse `--name-status -z`: a letter record then one or two path records. */
export function parseNameStatusZ(text) {
  const parts = String(text ?? '').split('\0')
  const rows = []
  let index = 0
  while (index < parts.length) {
    const code = parts[index]
    index += 1
    if (code === undefined || code.length === 0) continue
    const letter = code[0]
    const path = parts[index]
    index += 1
    if (path === undefined) break
    if (letter === 'R' || letter === 'C') {
      const target = parts[index]
      index += 1
      rows.push({
        path: target ?? path,
        origPath: path,
        status: letter,
        similarity: Number.parseInt(code.slice(1), 10) || undefined,
      })
      continue
    }
    rows.push({ path, status: letter })
  }
  return rows
}

/** Parse `--numstat -z`. `-` counts mean a binary file. */
export function parseNumstatZ(text) {
  const parts = String(text ?? '').split('\0')
  const out = new Map()
  let index = 0
  while (index < parts.length) {
    const record = parts[index]
    index += 1
    if (record === undefined || record.length === 0) continue
    const match = record.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/)
    if (match === null) continue
    const binary = match[1] === '-' || match[2] === '-'
    let path = match[3]
    // A rename in `-z` numstat leaves the path empty and follows with two more
    // records: the source then the destination.
    if (path.length === 0) {
      index += 1
      path = parts[index] ?? ''
      index += 1
    }
    out.set(path, {
      additions: binary ? 0 : Number.parseInt(match[1], 10),
      deletions: binary ? 0 : Number.parseInt(match[2], 10),
      binary,
    })
  }
  return out
}

/**
 * The unified diff of ONE file, classified per line.
 *
 * @param options - `{ source, path, origPath?, context?, ignoreWhitespace?,
 *   ignoreBlankLines?, wordDiff? }`
 */
export async function fileDiff(root, options) {
  const context = Number.isInteger(options.context) && options.context >= 0
    ? Math.min(options.context, 100)
    : DEFAULT_DIFF_CONTEXT
  const call = diffInvocation(options.source)
  const args = [call.command, '--no-color', '-M', '-C', `--unified=${context}`, ...call.lead]
  if (options.ignoreWhitespace === true) args.push('--ignore-all-space')
  if (options.ignoreBlankLines === true) args.push('--ignore-blank-lines')
  if (options.wordDiff === true) args.push('--word-diff=plain', '--word-diff-regex=[^[:space:]]')
  // `diff-tree` needs `-p` to emit a patch at all; `diff` already does.
  if (call.command === 'diff-tree') args.push('-p')
  args.push(...call.revs)
  args.push('--')
  args.push(options.path)
  if (typeof options.origPath === 'string' && options.origPath.length > 0 && options.origPath !== options.path) {
    args.push(options.origPath)
  }

  const result = await runGit({ cwd: root, args, timeoutMs: 120_000, allowFailure: true })
  // An untracked path is INVISIBLE to `git diff`: it exits 0 with no output, so
  // "empty" — not "failed" — is the signal to synthesize the whole-file diff.
  // Getting this wrong is why a lot of git GUIs show nothing for a new file.
  if (result.stdout.length === 0 && options.source?.kind === 'worktree') {
    const untracked = await untrackedDiff(root, options.path, context)
    if (untracked !== undefined) return untracked
  }
  if (result.code !== 0 && result.stdout.length === 0) {
    return { lines: [], truncated: false, binary: false, empty: true }
  }
  return classifyDiff(result.stdout)
}

/**
 * An untracked file has no diff at all, so one is synthesized against the
 * platform's empty file: the panel shows "the whole file is new", which is the
 * truth. `--no-index` makes git diff two paths outside its own index.
 */
async function untrackedDiff(root, path, context) {
  const result = await tryGit(root, [
    'diff', '--no-color', `--unified=${context}`, '--no-index', '--', devNull(), path,
  ], { timeoutMs: 60_000 })
  if (result.stdout.length === 0) return undefined
  return classifyDiff(result.stdout)
}

/** The platform's empty-file path for `--no-index`. */
function devNull() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

/**
 * Split a unified diff into rendered lines. Line numbers are tracked per hunk so
 * the gutter can show old/new columns exactly as the reference's DiffPanel does.
 */
export function classifyDiff(text, limit = MAX_DIFF_LINES) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const lines = []
  let oldNo = 0
  let newNo = 0
  let binary = false
  let truncated = false

  for (const line of raw) {
    if (lines.length >= limit) {
      truncated = true
      break
    }
    if (line.startsWith('diff --git ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('old mode ') || line.startsWith('new mode ') ||
        line.startsWith('similarity index ') || line.startsWith('rename from ') ||
        line.startsWith('rename to ') || line.startsWith('copy from ') ||
        line.startsWith('copy to ') || line.startsWith('deleted file mode ') ||
        line.startsWith('new file mode ')) {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+/)
      if (match !== null) {
        oldNo = Number.parseInt(match[1], 10)
        newNo = Number.parseInt(match[3], 10)
      }
      lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\')) {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    const marker = line[0]
    const body = line.slice(1)
    if (marker === '+') {
      lines.push({ kind: 'add', text: body, newNo })
      newNo += 1
      continue
    }
    if (marker === '-') {
      lines.push({ kind: 'del', text: body, oldNo })
      oldNo += 1
      continue
    }
    lines.push({ kind: 'context', text: marker === ' ' ? body : line, oldNo, newNo })
    oldNo += 1
    newNo += 1
  }

  return { lines, truncated, binary, empty: lines.length === 0 }
}

/**
 * One file's bytes at a revision, base64-encoded, for the image preview. `rev` of
 * `:0` reads the index, `undefined` reads the worktree file.
 *
 * The worktree case reads the file directly rather than `git hash-object -w`:
 * writing a blob into the object database as a side effect of LOOKING at an image
 * would leave a loose object behind for every preview.
 */
export async function fileBlob(root, path, rev) {
  if (rev === undefined) {
    const full = resolve(join(root, path))
    if (!isInside(root, full)) return undefined
    const buffer = await readFile(full).catch(() => undefined)
    if (buffer === undefined || buffer.length > MAX_IMAGE_BYTES) return undefined
    return { base64: buffer.toString('base64'), bytes: buffer.length }
  }
  const spec = rev === ':0' ? ':0:' + path : `${rev}:${path}`
  const result = await runGit({
    cwd: root,
    args: ['show', spec],
    timeoutMs: 60_000,
    maxBytes: MAX_IMAGE_BYTES,
    allowFailure: true,
  })
  if (result.code !== 0) return undefined
  return { base64: result.stdoutBuffer.toString('base64'), bytes: result.stdoutBuffer.length }
}

/**
 * Both sides of an image change, for the before/after preview cards. Either side
 * is undefined when the file was added or deleted.
 */
export async function imagePreview(root, options) {
  const { path, source } = options
  const dataUrl = (blob) => (blob === undefined ? undefined : `data:${imageMime(path)};base64,${blob.base64}`)
  if (source?.kind === 'commit') {
    const [before, after] = await Promise.all([
      fileBlob(root, options.origPath ?? path, `${source.rev}^`),
      fileBlob(root, path, source.rev),
    ])
    return { before: dataUrl(before), after: dataUrl(after) }
  }
  if (source?.kind === 'staged') {
    const [before, after] = await Promise.all([
      fileBlob(root, options.origPath ?? path, 'HEAD'),
      fileBlob(root, path, ':0'),
    ])
    return { before: dataUrl(before), after: dataUrl(after) }
  }
  const [before, after] = await Promise.all([
    fileBlob(root, options.origPath ?? path, ':0'),
    fileBlob(root, path, undefined),
  ])
  return { before: dataUrl(before), after: dataUrl(after) }
}

/**
 * `git diff --shortstat` for the strip above the file list.
 */
export async function diffShortstat(root, source) {
  const call = diffInvocation(source)
  const result = await tryGit(root, [
    call.command, '--no-color', ...call.lead, '--shortstat', ...call.revs,
  ], { timeoutMs: 60_000 })
  const text = result.stdout.trim()
  const files = Number.parseInt((text.match(/(\d+) files? changed/) ?? [])[1] ?? '0', 10)
  const additions = Number.parseInt((text.match(/(\d+) insertions?/) ?? [])[1] ?? '0', 10)
  const deletions = Number.parseInt((text.match(/(\d+) deletions?/) ?? [])[1] ?? '0', 10)
  return { files, additions, deletions, text }
}
