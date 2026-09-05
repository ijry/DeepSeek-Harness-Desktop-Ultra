/**
 * The mutating half of the panel API: everything that changes a repository.
 *
 * Split out of host/routes.js purely for size — the GET side is reads with no
 * validation beyond a repository lookup, while every route here validates its
 * arguments through shared/protocol.js before a `git` process sees them. That
 * validation is the security boundary: a branch name, a path or a URL arriving
 * from the browser is checked for leading `-`, `..` segments and executable
 * transports here, not inside the git helpers.
 *
 * Long-running network work does not answer inline. Those routes hand the job to
 * the operation registry and answer with its record, so the browser follows
 * progress on the SSE stream and a closed tab does not abort a push.
 *
 * @module dsh-plugin-otools-git/host/actions
 */
import {
  ERR,
  GitError,
  normalizeEnum,
  normalizeFlag,
  normalizeMessage,
  normalizeOptionalText,
  normalizePaths,
  normalizeRefName,
  normalizeRemoteName,
  normalizeRemoteUrl,
  normalizeRepoPath,
  normalizeRevision,
  normalizeText,
} from '../shared/protocol.js'
import { AI_LANGUAGES, AI_STYLES, writeCommitMessage } from './ai.js'
import { deleteCredential, envCredentialSources, inspectHostKey, resolveCredential, saveCredential, trustHostKey } from './auth.js'
import {
  commit,
  discardAll,
  discardPaths,
  markResolved,
  resolveConflict,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
} from './commit.js'
import { addSafeDirectories, writeConfig } from './config.js'
import {
  addSubmodule,
  addWorktree,
  lockWorktree,
  pruneWorktrees,
  removeSubmodule,
  removeWorktree,
  syncSubmodules,
  updateSubmodules,
} from './nested.js'
import {
  cherryPick,
  createBranch,
  createTag,
  checkoutBranch,
  deleteBranches,
  deleteRemoteBranch,
  deleteRemoteTags,
  deleteTags,
  merge,
  rebase,
  renameBranch,
  reset,
  revert,
  sequencer,
  setUpstream,
  validateCheckout,
} from './refs.js'
import {
  addRemote,
  fetch as gitFetch,
  hostOf,
  isHttpRemote,
  listRemotes,
  pruneRemote,
  pull,
  push,
  removeRemote,
  renameRemote,
  setRemoteUrl,
} from './remotes.js'
import { applyStash, clearStashes, createStash, stashToBranch } from './stash.js'
import { ok } from './http.js'

/** Register the POST dispatch. Returns `{ handlePost }`. */
export function registerActionRoutes(options) {
  const { prefs, repos, operations, credentialsFile } = options

  /** The repository a body names. */
  const rootOf = (body) => repos.resolve(body.workspaceId ?? body.root)

  /**
   * Refuse a second mutation while a network operation is running on the same
   * repository. Two pushes at once is a user mistake; two `git` processes racing
   * for index.lock is a corrupted index.
   */
  const requireIdle = (root) => {
    const busy = operations.busy(root)
    if (busy !== undefined) {
      throw new GitError(ERR.locked, `该仓库正在执行「${busy.title}」，请等它结束`)
    }
  }

  /** Start a network operation and answer with its record. */
  const startOp = (input, run) => operations.start(input, run)

  /**
   * The credential to use for a remote, when one is available. Only http(s)
   * remotes take a username/password; an ssh remote authenticates by key and a
   * stored password would be meaningless there.
   */
  const credentialFor = async (root, remoteName) => {
    const remotes = await listRemotes(root)
    const row = remotes.find((entry) => entry.name === remoteName)
    if (row === undefined || !isHttpRemote(row.url)) return undefined
    const host = hostOf(row.url)
    if (host === undefined) return undefined
    const credential = await resolveCredential(credentialsFile, host)
    return credential === undefined
      ? undefined
      : { username: credential.username, password: credential.password }
  }

  /** A reporter-backed progress pair for `runNetwork`. */
  const wire = (reporter) => ({
    onProgress: (update) => reporter.progress(update),
    onLog: (line) => reporter.log(line),
    signal: reporter.signal,
  })

  const handlePost = async (req, res, route, body) => {
    // ------------------------------------------------------------ preferences
    if (route === '/prefs') {
      const workspaceId = normalizeOptionalText(body.workspaceId, 'workspaceId', 200)
      ok(res, await prefs.save(body.prefs ?? body.patch ?? {}, workspaceId))
      return true
    }

    // ----------------------------------------------------------------- index
    if (route === '/stage') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await stagePaths(root, normalizePaths(body.paths)))
      repos.invalidate(root)
      return true
    }
    if (route === '/stage-all') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await stageAll(root))
      repos.invalidate(root)
      return true
    }
    if (route === '/unstage') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await unstagePaths(root, normalizePaths(body.paths)))
      repos.invalidate(root)
      return true
    }
    if (route === '/unstage-all') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await unstageAll(root))
      repos.invalidate(root)
      return true
    }
    if (route === '/discard') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await discardPaths(root, {
        tracked: Array.isArray(body.tracked) && body.tracked.length > 0 ? normalizePaths(body.tracked) : [],
        untracked: Array.isArray(body.untracked) && body.untracked.length > 0 ? normalizePaths(body.untracked) : [],
        staged: normalizeFlag(body.staged),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/discard-all') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await discardAll(root, {
        includeUntracked: normalizeFlag(body.includeUntracked),
        includeIgnored: normalizeFlag(body.includeIgnored),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/conflict/resolve') {
      const root = await rootOf(body)
      requireIdle(root)
      const paths = normalizePaths(body.paths)
      ok(res, body.side === 'mark'
        ? await markResolved(root, paths)
        : await resolveConflict(root, paths, body.side))
      repos.invalidate(root)
      return true
    }

    // ---------------------------------------------------------------- commit
    if (route === '/commit') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await commit(root, {
        message: normalizeMessage(body.message),
        amend: normalizeFlag(body.amend),
        allowEmpty: normalizeFlag(body.allowEmpty),
        signoff: normalizeFlag(body.signoff),
        noVerify: normalizeFlag(body.noVerify),
        resetAuthor: normalizeFlag(body.resetAuthor),
        authorName: normalizeOptionalText(body.authorName, 'authorName', 200),
        authorEmail: normalizeOptionalText(body.authorEmail, 'authorEmail', 200),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/ai/commit-message') {
      const root = await rootOf(body)
      const style = body.style === undefined ? 'conventional' : normalizeEnum(body.style, AI_STYLES, 'style')
      const language = body.language === undefined ? 'zh' : normalizeEnum(body.language, AI_LANGUAGES, 'language')
      const hint = normalizeOptionalText(body.hint, 'hint', 2_000)
      const source = body.source === undefined ? 'staged' : normalizeEnum(body.source, ['staged', 'worktree'], 'source')
      // An operation rather than an inline answer: the model streams, and the box
      // shows the text arriving instead of a spinner.
      ok(res, startOp({
        kind: 'ai-commit-message',
        title: 'AI 生成提交信息',
        command: 'dsh llm.stream (commit message)',
        root,
      }, async (reporter) => {
        reporter.progress({ percent: 8, label: '读取改动' })
        const result = await writeCommitMessage({
          llm: options.ai?.llm,
          defaultModel: options.ai?.defaultModel,
          root,
          style,
          language,
          hint,
          source,
          signal: reporter.signal,
          onDelta: (text) => {
            reporter.progress({ percent: 60, label: '模型生成中' })
            // `partial`, not `log`: the deltas ARE the commit message, and the
            // log channel strips the newlines that give it its shape.
            reporter.partial(text)
          },
        })
        reporter.progress({ percent: 100, label: '完成' })
        return result
      }), 202)
      return true
    }

    // ---------------------------------------------------------------- branches
    if (route === '/branch/create') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await createBranch(root, {
        name: normalizeRefName(body.name, 'name'),
        startPoint: body.startPoint === undefined ? undefined : normalizeRevision(body.startPoint, 'startPoint'),
        checkout: normalizeFlag(body.checkout, true),
        force: normalizeFlag(body.force),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/branch/checkout') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await checkoutBranch(root, {
        name: normalizeRevision(body.name, 'name'),
        newBranch: body.newBranch === undefined ? undefined : normalizeRefName(body.newBranch, 'newBranch'),
        detach: normalizeFlag(body.detach),
        force: normalizeFlag(body.force),
        track: body.track === undefined ? undefined : normalizeFlag(body.track),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/branch/validate-checkout') {
      const root = await rootOf(body)
      ok(res, await validateCheckout(root, normalizeRevision(body.name, 'name')))
      return true
    }
    if (route === '/branch/rename') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await renameBranch(
        root,
        normalizeRefName(body.from, 'from'),
        normalizeRefName(body.to, 'to'),
        normalizeFlag(body.force),
      ))
      repos.invalidate(root)
      return true
    }
    if (route === '/branch/delete') {
      const root = await rootOf(body)
      requireIdle(root)
      const names = requireList(body.names, 'names').map((name) => normalizeRefName(name, 'name'))
      ok(res, await deleteBranches(root, names, normalizeFlag(body.force)))
      repos.invalidate(root)
      return true
    }
    if (route === '/branch/upstream') {
      const root = await rootOf(body)
      ok(res, await setUpstream(
        root,
        normalizeRefName(body.branch, 'branch'),
        body.upstream === undefined || body.upstream === null
          ? undefined
          : normalizeRevision(body.upstream, 'upstream'),
      ))
      repos.invalidate(root)
      return true
    }
    if (route === '/branch/delete-remote') {
      const root = await rootOf(body)
      const remote = normalizeRemoteName(body.remote)
      const branch = normalizeRefName(body.branch, 'branch')
      ok(res, startOp({
        kind: 'delete-remote-branch',
        title: `删除远端分支 ${remote}/${branch}`,
        command: `git push ${remote} --delete ${branch}`,
        root,
      }, async (reporter) => deleteRemoteBranch(root, remote, branch, {
        ...wire(reporter),
        credential: await credentialFor(root, remote),
      })), 202)
      return true
    }

    // -------------------------------------------------------- history rewrites
    if (route === '/merge') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await merge(root, {
        ref: normalizeRevision(body.ref, 'ref'),
        mode: body.mode,
        noCommit: normalizeFlag(body.noCommit),
        message: normalizeOptionalText(body.message, 'message', 5_000),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/rebase') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await rebase(root, {
        ref: normalizeRevision(body.ref, 'ref'),
        onto: body.onto === undefined ? undefined : normalizeRevision(body.onto, 'onto'),
        autostash: normalizeFlag(body.autostash),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/sequencer') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await sequencer(root, body.operation, body.action))
      repos.invalidate(root)
      return true
    }
    if (route === '/reset') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await reset(root, { ref: normalizeRevision(body.ref, 'ref'), mode: body.mode }))
      repos.invalidate(root)
      return true
    }
    if (route === '/cherry-pick') {
      const root = await rootOf(body)
      requireIdle(root)
      const revs = requireList(body.revs, 'revs').map((rev) => normalizeRevision(rev, 'rev'))
      ok(res, await cherryPick(root, revs, {
        noCommit: normalizeFlag(body.noCommit),
        mainline: body.mainline,
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/revert') {
      const root = await rootOf(body)
      requireIdle(root)
      const revs = requireList(body.revs, 'revs').map((rev) => normalizeRevision(rev, 'rev'))
      ok(res, await revert(root, revs, {
        noCommit: normalizeFlag(body.noCommit),
        mainline: body.mainline,
      }))
      repos.invalidate(root)
      return true
    }

    // ------------------------------------------------------------------- tags
    if (route === '/tag/create') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await createTag(root, {
        name: normalizeRefName(body.name, 'name'),
        target: body.target === undefined ? undefined : normalizeRevision(body.target, 'target'),
        message: normalizeOptionalText(body.message, 'message', 5_000),
        sign: normalizeFlag(body.sign),
        force: normalizeFlag(body.force),
      }))
      return true
    }
    if (route === '/tag/delete') {
      const root = await rootOf(body)
      const names = requireList(body.names, 'names').map((name) => normalizeRefName(name, 'name'))
      ok(res, await deleteTags(root, names))
      return true
    }
    if (route === '/tag/delete-remote') {
      const root = await rootOf(body)
      const remote = normalizeRemoteName(body.remote)
      const names = requireList(body.names, 'names').map((name) => normalizeRefName(name, 'name'))
      ok(res, startOp({
        kind: 'delete-remote-tag',
        title: `删除远端标签 ${names.join(', ')}`,
        command: `git push ${remote} --delete ${names.map((name) => `refs/tags/${name}`).join(' ')}`,
        root,
      }, async (reporter) => deleteRemoteTags(root, remote, names, {
        ...wire(reporter),
        credential: await credentialFor(root, remote),
      })), 202)
      return true
    }

    // ---------------------------------------------------------------- stashes
    if (route === '/stash/create') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await createStash(root, {
        message: normalizeOptionalText(body.message, 'message', 2_000),
        includeUntracked: normalizeFlag(body.includeUntracked),
        all: normalizeFlag(body.all),
        keepIndex: normalizeFlag(body.keepIndex),
        paths: Array.isArray(body.paths) && body.paths.length > 0 ? normalizePaths(body.paths) : undefined,
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/stash/apply') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await applyStash(root, stashRef(body.ref), body.action, {
        restoreIndex: normalizeFlag(body.restoreIndex),
      }))
      repos.invalidate(root)
      return true
    }
    if (route === '/stash/branch') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await stashToBranch(root, stashRef(body.ref), normalizeRefName(body.branch, 'branch')))
      repos.invalidate(root)
      return true
    }
    if (route === '/stash/clear') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await clearStashes(root))
      return true
    }

    // ---------------------------------------------------------------- remotes
    if (route === '/remote/add') {
      const root = await rootOf(body)
      ok(res, await addRemote(root, normalizeRemoteName(body.name), normalizeRemoteUrl(body.url)))
      return true
    }
    if (route === '/remote/rename') {
      const root = await rootOf(body)
      ok(res, await renameRemote(root, normalizeRemoteName(body.from, 'from'), normalizeRemoteName(body.to, 'to')))
      return true
    }
    if (route === '/remote/remove') {
      const root = await rootOf(body)
      ok(res, await removeRemote(root, normalizeRemoteName(body.name)))
      return true
    }
    if (route === '/remote/set-url') {
      const root = await rootOf(body)
      ok(res, await setRemoteUrl(
        root,
        normalizeRemoteName(body.name),
        normalizeRemoteUrl(body.url),
        body.which === undefined ? 'both' : normalizeEnum(body.which, ['both', 'fetch', 'push'], 'which'),
      ))
      return true
    }

    // ------------------------------------------------------------ network ops
    if (route === '/fetch') {
      const root = await rootOf(body)
      const remote = body.remote === undefined ? undefined : normalizeRemoteName(body.remote)
      const all = normalizeFlag(body.all)
      // Read once: the label the dialog shows and the flags git gets must be the
      // same decision, or the progress pane says something the run did not do.
      const prune = normalizeFlag(body.prune, true)
      const tags = normalizeFlag(body.tags)
      ok(res, startOp({
        kind: 'fetch',
        title: all ? '拉取所有远端更新' : `拉取 ${remote ?? 'origin'} 的更新`,
        command: ['git fetch', all ? '--all' : '', prune ? '--prune' : '', tags ? '--tags' : '', remote ?? '']
          .filter((part) => part.length > 0).join(' '),
        root,
      }, async (reporter) => gitFetch(root, {
        remote,
        all,
        prune,
        tags,
        ...wire(reporter),
        credential: remote === undefined ? undefined : await credentialFor(root, remote),
      })), 202)
      return true
    }
    if (route === '/pull') {
      const root = await rootOf(body)
      requireIdle(root)
      const remote = body.remote === undefined ? undefined : normalizeRemoteName(body.remote)
      const branch = body.branch === undefined ? undefined : normalizeRefName(body.branch, 'branch')
      const mode = body.mode === undefined ? 'merge' : normalizeEnum(body.mode, ['merge', 'rebase', 'ff-only', 'no-ff'], 'mode')
      ok(res, startOp({
        kind: 'pull',
        title: `拉取 ${remote ?? ''}${branch === undefined ? '' : `/${branch}`}`.trim() || '拉取',
        command: `git pull ${mode === 'rebase' ? '--rebase ' : ''}${remote ?? ''} ${branch ?? ''}`.trim(),
        root,
      }, async (reporter) => {
        const result = await pull(root, {
          remote,
          branch,
          mode,
          autostash: normalizeFlag(body.autostash),
          prune: normalizeFlag(body.prune),
          tags: normalizeFlag(body.tags),
          ...wire(reporter),
          credential: remote === undefined ? undefined : await credentialFor(root, remote),
        })
        repos.invalidate(root)
        return result
      }), 202)
      return true
    }
    if (route === '/push') {
      const root = await rootOf(body)
      const remote = normalizeRemoteName(body.remote)
      const localBranch = body.localBranch === undefined ? undefined : normalizeRefName(body.localBranch, 'localBranch')
      const remoteBranch = body.remoteBranch === undefined ? undefined : normalizeRefName(body.remoteBranch, 'remoteBranch')
      const forceMode = body.forceMode === undefined ? 'none' : normalizeEnum(body.forceMode, ['none', 'lease', 'force'], 'forceMode')
      const refspec = localBranch === undefined
        ? undefined
        : `${localBranch}:${remoteBranch ?? localBranch}`
      const flags = [
        forceMode === 'force' ? '--force' : forceMode === 'lease' ? '--force-with-lease' : '',
        normalizeFlag(body.setUpstream) ? '--set-upstream' : '',
        normalizeFlag(body.followTags) ? '--follow-tags' : '',
        normalizeFlag(body.tags) ? '--tags' : '',
        normalizeFlag(body.dryRun) ? '--dry-run' : '',
      ].filter((flag) => flag.length > 0)
      ok(res, startOp({
        kind: 'push',
        title: `推送到 ${remote}${refspec === undefined ? '' : ` (${refspec})`}`,
        command: `git push ${flags.join(' ')} ${remote} ${refspec ?? ''}`.replace(/\s+/g, ' ').trim(),
        root,
      }, async (reporter) => {
        const credential = await credentialFor(root, remote)
        const result = await push(root, {
          remote,
          refspec,
          force: forceMode === 'force',
          forceWithLease: forceMode === 'lease',
          setUpstream: normalizeFlag(body.setUpstream),
          followTags: normalizeFlag(body.followTags),
          tags: normalizeFlag(body.tags),
          dryRun: normalizeFlag(body.dryRun),
          ...wire(reporter),
          credential,
        })
        repos.invalidate(root)
        return result
      }), 202)
      return true
    }
    if (route === '/prune') {
      const root = await rootOf(body)
      const remote = normalizeRemoteName(body.remote)
      ok(res, startOp({
        kind: 'prune',
        title: `清理 ${remote} 的失效引用`,
        command: `git remote prune ${remote}`,
        root,
      }, async (reporter) => pruneRemote(root, remote, {
        ...wire(reporter),
        credential: await credentialFor(root, remote),
      })), 202)
      return true
    }

    // ------------------------------------------------------------- submodules
    if (route === '/submodule/update') {
      const root = await rootOf(body)
      const path = body.path === undefined ? undefined : normalizeRepoPath(body.path)
      ok(res, startOp({
        kind: 'submodule-update',
        title: path === undefined ? '初始化并更新子模块' : `初始化子模块 ${path}`,
        command: `git submodule update --init${normalizeFlag(body.recursive) ? ' --recursive' : ''}${path === undefined ? '' : ` -- ${path}`}`,
        root,
      }, async (reporter) => updateSubmodules(root, {
        path,
        recursive: normalizeFlag(body.recursive, true),
        remote: normalizeFlag(body.remote),
        force: normalizeFlag(body.force),
        ...wire(reporter),
      })), 202)
      return true
    }
    if (route === '/submodule/add') {
      const root = await rootOf(body)
      const url = normalizeRemoteUrl(body.url)
      const path = normalizeRepoPath(body.path)
      ok(res, startOp({
        kind: 'submodule-add',
        title: `添加子模块 ${path}`,
        command: `git submodule add ${url} ${path}`,
        root,
      }, async (reporter) => addSubmodule(root, {
        url,
        path,
        branch: body.branch === undefined ? undefined : normalizeRefName(body.branch, 'branch'),
        ...wire(reporter),
      })), 202)
      return true
    }
    if (route === '/submodule/remove') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await removeSubmodule(root, normalizeRepoPath(body.path)))
      return true
    }
    if (route === '/submodule/sync') {
      const root = await rootOf(body)
      ok(res, await syncSubmodules(root, body.path === undefined ? undefined : normalizeRepoPath(body.path)))
      return true
    }

    // -------------------------------------------------------------- worktrees
    if (route === '/worktree/add') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await addWorktree(root, {
        path: normalizeText(body.path, 'path', 4_096),
        mode: normalizeEnum(body.mode ?? 'new-branch', ['new-branch', 'existing-branch', 'detached'], 'mode'),
        branch: body.branch === undefined ? undefined : normalizeRefName(body.branch, 'branch'),
        startPoint: body.startPoint === undefined ? undefined : normalizeRevision(body.startPoint, 'startPoint'),
        force: normalizeFlag(body.force),
      }))
      repos.invalidate()
      return true
    }
    if (route === '/worktree/remove') {
      const root = await rootOf(body)
      requireIdle(root)
      ok(res, await removeWorktree(root, normalizeText(body.path, 'path', 4_096), normalizeFlag(body.force)))
      repos.invalidate()
      return true
    }
    if (route === '/worktree/lock') {
      const root = await rootOf(body)
      ok(res, await lockWorktree(
        root,
        normalizeText(body.path, 'path', 4_096),
        normalizeFlag(body.lock, true),
        normalizeOptionalText(body.reason, 'reason', 500),
      ))
      return true
    }
    if (route === '/worktree/prune') {
      const root = await rootOf(body)
      ok(res, await pruneWorktrees(root))
      repos.invalidate()
      return true
    }

    // ----------------------------------------------------------------- config
    if (route === '/config/set') {
      const root = await rootOf(body)
      const entries = Array.isArray(body.entries) ? body.entries : [body]
      const written = []
      for (const entry of entries) {
        written.push(await writeConfig(
          root,
          normalizeText(entry.key, 'key', 200),
          entry.value === null || entry.value === undefined ? undefined : String(entry.value),
          entry.scope,
        ))
      }
      ok(res, written)
      return true
    }
    if (route === '/safe-directory') {
      const root = await rootOf(body)
      // Every entry must resolve to a repository DSH already knows about. Without
      // this the route would take any absolute path the browser named — and the
      // thing it writes is the user's GLOBAL git config.
      const requested = requireList(body.paths, 'paths').map((path) => normalizeText(path, 'path', 4_096))
      const paths = []
      for (const path of requested) {
        paths.push(await repos.resolvePath(path))
      }
      ok(res, await addSafeDirectories(root, paths))
      return true
    }

    // ------------------------------------------------------------ credentials
    if (route === '/credentials') {
      const host = normalizeText(body.host, 'host', 253)
      ok(res, {
        hosts: await saveCredential(credentialsFile, host, body.username, body.password),
        env: envCredentialSources(),
      })
      return true
    }
    if (route === '/credentials/delete') {
      const host = normalizeText(body.host, 'host', 253)
      ok(res, { hosts: await deleteCredential(credentialsFile, host), env: envCredentialSources() })
      return true
    }
    if (route === '/ssh/inspect') {
      ok(res, await inspectHostKey(normalizeText(body.host, 'host', 253), portOf(body.port)))
      return true
    }
    if (route === '/ssh/trust') {
      ok(res, await trustHostKey(normalizeText(body.host, 'host', 253), portOf(body.port)))
      return true
    }

    // ------------------------------------------------------------- operations
    if (route === '/ops/cancel') {
      ok(res, operations.cancel(normalizeText(body.id, 'id', 100)))
      return true
    }

    return false
  }

  return { handlePost }
}

/** A non-empty array of strings. */
function requireList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GitError(ERR.invalidInput, `${label} must be a non-empty array`)
  }
  if (value.length > 500) throw new GitError(ERR.invalidInput, `${label} holds too many entries`)
  return value
}

/**
 * A `stash@{N}` reference. Validated by shape rather than as a ref name, because
 * `@{` is exactly what normalizeRefName rejects — and only that shape is accepted,
 * so nothing else can ride in on a stash argument.
 */
function stashRef(value) {
  const text = String(value ?? '').trim()
  if (!/^stash@\{\d{1,6}\}$/.test(text)) {
    throw new GitError(ERR.invalidInput, 'ref must look like stash@{0}')
  }
  return text
}

/** A TCP port, defaulting to 22. */
function portOf(value) {
  if (value === undefined || value === null || value === '') return 22
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new GitError(ERR.invalidInput, 'port must be between 1 and 65535')
  }
  return parsed
}
