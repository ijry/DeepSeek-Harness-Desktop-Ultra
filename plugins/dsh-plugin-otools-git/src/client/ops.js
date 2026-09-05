/**
 * Long-running operations: the progress dialog, and the push / pull / fetch
 * dialogs that start them.
 *
 * The dialog is the reference's OperationDialog — a bar, the command being run,
 * a growing output pane — but the operation lives on the host, so closing the
 * dialog does not abort the push and re-opening it shows where the push got to.
 *
 * An authentication failure is turned into an offer: the credential dialog opens
 * pre-filled with the host that refused, and saving it re-runs the same operation.
 */

/** Start one host operation and show its dialog. */
async function startOperation(route, body) {
  if (model.workspaceId.length === 0) return undefined
  let record
  try {
    record = await apiPost(route, { workspaceId: model.workspaceId, ...body })
  } catch (error) {
    toastError(error)
    return undefined
  }
  mergeOperation(record)
  openOperationDialog(record.id, { route, body })
  return record
}

/** Which operation dialog is open, so SSE updates can re-render it. */
let operationDialogHandle = null
let operationDialogId = null
let operationRetry = null

/** Show the progress dialog for one operation. */
function openOperationDialog(id, retry) {
  operationDialogId = id
  operationRetry = retry ?? null
  if (operationDialogHandle !== null) {
    operationDialogHandle.render()
    return
  }
  operationDialogHandle = openDialog({
    title: 'Git 操作进行中',
    width: 'wide',
    build: () => operationDialogBody(),
    footer: (handle) => operationDialogFooter(handle),
    onClose: () => {
      operationDialogHandle = null
      operationDialogId = null
      operationRetry = null
    },
  })
}

/** The record the dialog is showing. */
function currentOperation() {
  return model.ops.find((row) => row.id === operationDialogId)
}

/** The dialog body: bar, status line, command, output. */
function operationDialogBody() {
  const record = currentOperation()
  if (record === undefined) return el('div', { class: 'dsh-og-loading' }, '操作已过期')
  const statusText = record.status === 'running'
    ? (record.phase.length > 0 ? record.phase + '...' : '正在执行...')
    : record.status === 'done' ? '完成'
      : record.status === 'canceled' ? '已取消' : '失败'

  const nodes = [
    progressBar(record.percent, record.status),
    el('p', { class: 'dsh-og-op-status' }, record.title + ' — ' + statusText),
  ]
  if (record.error !== undefined && record.error !== null) {
    nodes.push(alertBox('error', '操作失败', friendlyError(record.error)))
    const dubious = dubiousHint(record.error)
    if (dubious !== undefined) nodes.push(dubious)
    const hint = authHint(record)
    if (hint !== undefined) nodes.push(hint)
  }
  nodes.push(el('div', { class: 'dsh-og-op-section' },
    el('h4', {}, '执行命令:'),
    el('pre', { class: 'dsh-og-op-out' }, record.command)))
  nodes.push(el('div', { class: 'dsh-og-op-section' },
    el('h4', {}, '输出信息:'),
    outputPane(record)))
  return nodes
}

/** The output pane, tailing itself as lines arrive. */
function outputPane(record) {
  const pane = el('pre', { class: 'dsh-og-op-out' })
  for (const line of record.log) {
    const tone = /^(error|fatal|remote: error)/i.test(line) ? 'error'
      : /done\.$|completed|Everything up-to-date/i.test(line) ? 'done' : undefined
    pane.append(el('span', { class: 'dsh-og-op-line', 'data-tone': tone }, line + '\n'))
  }
  if (record.truncated === true) pane.append(el('span', {}, '（输出过长，已截断前面的内容）\n'))
  // Tail on the next frame, once the pane has a scroll height.
  requestAnimationFrame(() => {
    pane.scrollTop = pane.scrollHeight
  })
  return pane
}

/**
 * When a network operation failed on authentication, offer the credential dialog
 * for the host that refused instead of only reporting the error.
 */
function authHint(record) {
  const code = record.error?.code
  if (code !== 'auth_required' && code !== 'ssh_auth') return undefined
  const host = hostFromLog(record)
  if (code === 'ssh_auth') {
    return el('div', { style: { 'margin-top': '8px', display: 'flex', gap: '8px', 'align-items': 'center' } },
      el('span', { style: { 'font-size': '12px', color: 'var(--og-text-2)' } },
        'SSH 认证失败。如果是首次连接这台主机，可以核对指纹后信任它。'),
      host === undefined ? undefined : button('检查主机密钥...', {
        size: 'mini',
        onClick: () => openSshTrustDialog(host),
      }))
  }
  return el('div', { style: { 'margin-top': '8px', display: 'flex', gap: '8px', 'align-items': 'center' } },
    el('span', { style: { 'font-size': '12px', color: 'var(--og-text-2)' } }, '这个远端需要账号和密码/Token。'),
    host === undefined ? undefined : button('填写凭证并重试', {
      kind: 'primary',
      size: 'mini',
      onClick: () => {
        const retry = operationRetry
        openCredentialDialog(host, {
          error: record.error.message,
          retry: retry === null ? undefined : async () => {
            operationDialogHandle?.close()
            await startOperation(retry.route, retry.body)
          },
        })
      },
    }))
}

/** The host a failed operation was talking to, dug out of its own log/command. */
function hostFromLog(record) {
  const blob = record.command + '\n' + record.log.join('\n')
  const url = blob.match(/https?:\/\/([^/\s@]+@)?([^/\s:]+)/)
  if (url !== null) return url[2].toLowerCase()
  const scp = blob.match(/(?:^|\s)(?:[^@\s]+@)([^:\s]+):/)
  if (scp !== null) return scp[1].toLowerCase()
  // Fall back to the remote named in the command, resolved against the list.
  const remote = model.remotes.find((row) => record.command.includes(' ' + row.name))
  return remote === undefined ? undefined : remote.host
}

/**
 * git's "dubious ownership" refusal has a one-click repair, so it is offered as
 * one. The host already extracted the paths git named; adding them to
 * `safe.directory` touches the user's GLOBAL config, so it says so and asks.
 */
function dubiousHint(error) {
  const dubious = error?.dubious
  if (dubious === undefined || dubious === null || !Array.isArray(dubious.paths) || dubious.paths.length === 0) {
    return undefined
  }
  return el('div', { style: { 'margin-top': '8px' } },
    alertBox('warning', 'Git 因为仓库所有权不匹配拒绝了这次操作',
      '把下面的目录加入 safe.directory 就能继续。这会写入你的全局 git 配置：\n' +
      dubious.paths.join('\n')),
    el('div', { style: { 'margin-top': '8px' } },
      button('一键修复（写入全局配置）', {
        kind: 'primary',
        size: 'mini',
        onClick: async () => {
          try {
            const result = await apiPost('/safe-directory', {
              workspaceId: model.workspaceId,
              paths: dubious.paths,
            })
            toast(result.message ?? '已更新 safe.directory', 'success', 4200)
            const retry = operationRetry
            if (retry !== null) {
              operationDialogHandle?.close()
              await startOperation(retry.route, retry.body)
            }
          } catch (retryError) {
            toastError(retryError)
          }
        },
      })))
}

/** The dialog footer: cancel while running, close when finished. */
function operationDialogFooter(handle) {
  const record = currentOperation()
  const running = record !== undefined && record.status === 'running'
  return [
    el('div', { class: 'dsh-og-dialog-foot-left' },
      running ? undefined : el('span', { style: { 'font-size': '11px', color: 'var(--og-text-3)' } },
        record === undefined ? '' : durationText(record))),
    running && record.cancelable
      ? button('取消操作', {
        kind: 'danger',
        onClick: async () => {
          try {
            await apiPost('/ops/cancel', { id: record.id })
          } catch (error) {
            toastError(error)
          }
        },
      })
      : undefined,
    button(running ? '后台运行' : '关闭', { kind: running ? 'default' : 'primary', onClick: () => handle.close() }),
  ]
}

/** How long an operation took. */
function durationText(record) {
  if (record.finishedAt === undefined || record.finishedAt === null) return ''
  const seconds = Math.max(0, Math.round((record.finishedAt - record.startedAt) / 100) / 10)
  return '耗时 ' + seconds + ' 秒'
}

/**
 * Fold one operation record into the open dialog. Called for EVERY record, so a
 * background operation finishing while the dialog shows another one is ignored
 * here and reported by the toast below.
 */
function applyOperationToUi(record) {
  applyAiOperation(record)
  if (operationDialogId === record.id) {
    operationDialogHandle?.render()
    if (record.status === 'done' && pref('autoCloseOnSuccess') !== false) {
      // Give the user a beat to see the bar hit 100%, as the reference does.
      setTimeout(() => {
        if (operationDialogId === record.id) operationDialogHandle?.close()
      }, 1200)
    }
  }
  if (record.status === 'done' && record.kind !== 'ai-commit-message') {
    void refreshTab()
    void loadRepos()
  }
  if (record.status === 'failed' && operationDialogId !== record.id && record.kind !== 'ai-commit-message') {
    toast(record.title + ' 失败：' + friendlyError(record.error), 'error', 5200)
  }
}

/** The SSH host-key trust dialog. */
function openSshTrustDialog(host) {
  const state = { info: null, loading: true, error: null }
  const handle = openDialog({
    title: '检查 SSH 主机密钥',
    build: () => {
      if (state.loading) return el('div', { class: 'dsh-og-loading' }, '正在读取 ' + host + ' 的主机密钥...')
      if (state.error !== null) return alertBox('error', '读取失败', state.error)
      const info = state.info
      const rows = [
        field('主机', input({ value: info.displayHost ?? info.host, readonly: true })),
        field('算法', input({ value: info.keyType ?? '未知', readonly: true })),
        field('指纹 (SHA256)', input({ value: info.fingerprint ?? '未知', readonly: true })),
        field('写入位置', input({ value: info.knownHostsPath ?? '', readonly: true })),
      ]
      if (info.status === 'trusted') {
        rows.unshift(alertBox('success', '这台主机已经在 known_hosts 里', '指纹与本地记录一致，不需要再做什么。'))
      } else if (info.status === 'mismatch') {
        rows.unshift(alertBox('error', '指纹与本地记录不一致',
          '这通常意味着服务端更换了密钥，也可能是中间人攻击。请先通过其它渠道核实，再手工修改 known_hosts —— 这里不会自动改写。'))
      } else if (info.status === 'unknown') {
        rows.unshift(alertBox('warning', '首次连接这台主机',
          '请把上面的指纹和服务提供方公布的值对一下，一致再信任。'))
      } else {
        rows.unshift(alertBox('error', '无法连接读取主机密钥', info.message ?? ''))
      }
      return rows
    },
    footer: (dialogHandle) => [
      button('关闭', { onClick: () => dialogHandle.close() }),
      state.info !== null && state.info.status === 'unknown'
        ? button('指纹无误，信任这台主机', {
          kind: 'primary',
          onClick: async () => {
            try {
              await apiPost('/ssh/trust', { host })
              toast('已信任 ' + host + '，可以重试刚才的操作了', 'success', 4200)
              dialogHandle.close()
            } catch (error) {
              toastError(error)
            }
          },
        })
        : undefined,
    ],
  })
  void (async () => {
    try {
      state.info = await apiPost('/ssh/inspect', { host })
    } catch (error) {
      state.error = friendlyError(error)
    }
    state.loading = false
    handle.render()
  })()
}

// ------------------------------------------------------- push / pull / fetch
/** The push dialog. */
function openPushDialog(options) {
  const opts = options ?? {}
  const state = {
    remote: '',
    localBranch: '',
    remoteBranch: '',
    forceMode: pref('pushForceMode') ?? 'none',
    setUpstream: false,
    followTags: pref('pushFollowTags') === true,
    tags: opts.tagsOnly === true,
    dryRun: false,
    confirmText: '',
    defaults: null,
  }
  const handle = openDialog({
    title: '推送设置',
    width: 'wide',
    build: (dialogHandle) => {
      if (state.defaults === null) return el('div', { class: 'dsh-og-loading' }, '加载推送配置...')
      const rows = [
        field('远端', select({
          value: state.remote,
          options: state.defaults.remotes.map((row) => ({ id: row.name, label: row.name + '　' + row.url })),
          onChange: (value) => {
            state.remote = value
          },
        })),
        field('本地分支', input({ value: state.localBranch, readonly: true })),
        field('远端分支', input({
          value: state.remoteBranch,
          placeholder: '留空则与本地同名',
          onInput: (event) => {
            state.remoteBranch = event.target.value
          },
        })),
        field('强制方式', select({
          value: state.forceMode,
          options: PUSH_FORCE_MODES,
          onChange: (value) => {
            state.forceMode = value
            void savePrefs({ pushForceMode: value })
            dialogHandle.render()
          },
        }), state.forceMode === 'lease'
          ? '带租约的强制推送在远端有别人新提交时会拒绝，比 --force 安全。'
          : undefined),
      ]
      if (state.defaults.hasTracking !== true) {
        rows.push(checkbox('同时设置上游（--set-upstream）', {
          checked: state.setUpstream,
          onChange: (checked) => {
            state.setUpstream = checked
          },
        }))
      }
      rows.push(checkbox('一并推送指向这些提交的标签（--follow-tags）', {
        checked: state.followTags,
        onChange: (checked) => {
          state.followTags = checked
          void savePrefs({ pushFollowTags: checked })
        },
      }))
      rows.push(checkbox('推送全部标签（--tags）', {
        checked: state.tags,
        onChange: (checked) => {
          state.tags = checked
        },
      }))
      rows.push(checkbox('只试运行，不真的推送（--dry-run）', {
        checked: state.dryRun,
        onChange: (checked) => {
          state.dryRun = checked
        },
      }))
      rows.push(checkbox('推送成功后自动关闭进度弹窗', {
        checked: pref('autoCloseOnSuccess') !== false,
        onChange: (checked) => void savePrefs({ autoCloseOnSuccess: checked }),
      }))
      if (state.forceMode === 'force') {
        rows.push(el('div', { style: { 'margin-top': '10px' } },
          alertBox('error', '强制推送会覆盖远端历史',
            '别人已经拉走的提交会消失。请输入 yes 确认。')))
        rows.push(el('div', { style: { 'margin-top': '8px' } }, input({
          placeholder: '要强制推送请输入 yes 确认',
          onInput: (event) => {
            state.confirmText = event.target.value
            dialogHandle.render()
          },
        })))
      }
      return rows
    },
    footer: (dialogHandle) => [
      button('取消', { onClick: () => dialogHandle.close() }),
      button('开始推送', {
        kind: 'primary',
        disabled: state.defaults === null || state.remote.length === 0 ||
          (state.forceMode === 'force' && state.confirmText.trim() !== 'yes'),
        onClick: async () => {
          dialogHandle.close()
          await startOperation('/push', {
            remote: state.remote,
            localBranch: state.localBranch.length === 0 ? undefined : state.localBranch,
            remoteBranch: state.remoteBranch.trim().length === 0 ? undefined : state.remoteBranch.trim(),
            forceMode: state.forceMode,
            setUpstream: state.setUpstream,
            followTags: state.followTags,
            tags: state.tags,
            dryRun: state.dryRun,
          })
        },
      }),
    ],
  })
  void (async () => {
    try {
      state.defaults = await apiGet('/push/defaults', { workspaceId: model.workspaceId })
      state.remote = state.defaults.remote ?? ''
      state.localBranch = state.defaults.localBranch ?? ''
      state.remoteBranch = state.defaults.targetBranch ?? ''
      state.setUpstream = state.defaults.hasTracking !== true
    } catch (error) {
      handle.close()
      toastError(error)
      return
    }
    handle.render()
  })()
}

/** The pull dialog. */
function openPullDialog() {
  const state = {
    remote: '',
    branch: '',
    mode: pref('pullMode') ?? 'merge',
    autostash: pref('pullAutostash') === true,
    prune: false,
    defaults: null,
    branches: [],
  }
  const handle = openDialog({
    title: '拉取设置',
    build: () => {
      if (state.defaults === null) return el('div', { class: 'dsh-og-loading' }, '加载拉取配置...')
      return [
        field('拉取到本地分支', input({ value: state.defaults.localBranch ?? '（游离 HEAD）', readonly: true })),
        field('从远端', select({
          value: state.remote,
          options: state.defaults.remotes.map((row) => ({ id: row.name, label: row.name })),
          onChange: (value) => {
            state.remote = value
            void reloadRemoteBranches()
          },
        })),
        field('远端分支', select({
          value: state.branch,
          options: [
            { id: '', label: '（跟踪分支）' },
            ...state.branches.map((name) => ({ id: name, label: name })),
          ],
          onChange: (value) => {
            state.branch = value
          },
        })),
        field('合并方式', select({
          value: state.mode,
          options: PULL_MODES,
          onChange: (value) => {
            state.mode = value
            void savePrefs({ pullMode: value })
          },
        }), state.mode === 'rebase' ? '变基会重写本地未推送的提交。' : undefined),
        checkbox('自动贮藏未提交的改动（--autostash）', {
          checked: state.autostash,
          onChange: (checked) => {
            state.autostash = checked
            void savePrefs({ pullAutostash: checked })
          },
        }),
        checkbox('顺便清理远端已删除的分支（--prune）', {
          checked: state.prune,
          onChange: (checked) => {
            state.prune = checked
          },
        }),
        checkbox('拉取成功后自动关闭进度弹窗', {
          checked: pref('autoCloseOnSuccess') !== false,
          onChange: (checked) => void savePrefs({ autoCloseOnSuccess: checked }),
        }),
      ]
    },
    footer: (dialogHandle) => [
      button('取消', { onClick: () => dialogHandle.close() }),
      button('开始拉取', {
        kind: 'primary',
        disabled: state.defaults === null,
        onClick: async () => {
          dialogHandle.close()
          await startOperation('/pull', {
            remote: state.remote.length === 0 ? undefined : state.remote,
            branch: state.branch.length === 0 ? undefined : state.branch,
            mode: state.mode,
            autostash: state.autostash,
            prune: state.prune,
          })
        },
      }),
    ],
  })
  const reloadRemoteBranches = async () => {
    if (state.remote.length === 0) return
    try {
      state.branches = await apiGet('/remote/branches', { workspaceId: model.workspaceId, remote: state.remote })
    } catch {
      state.branches = []
    }
    handle.render()
  }
  void (async () => {
    try {
      state.defaults = await apiGet('/pull/defaults', { workspaceId: model.workspaceId })
      state.remote = state.defaults.remote ?? ''
      state.branch = ''
    } catch (error) {
      handle.close()
      toastError(error)
      return
    }
    handle.render()
    await reloadRemoteBranches()
  })()
}

/** The fetch dialog — small enough to be a confirmation with two toggles. */
function openFetchDialog() {
  const state = { all: true, prune: pref('fetchPrune') !== false, tags: false, remote: model.remotes[0]?.name ?? '' }
  openDialog({
    title: '抓取更新',
    build: (handle) => [
      checkbox('抓取所有远端', {
        checked: state.all,
        onChange: (checked) => {
          state.all = checked
          handle.render()
        },
      }),
      state.all
        ? undefined
        : field('远端', select({
          value: state.remote,
          options: model.remotes.map((row) => ({ id: row.name, label: row.name })),
          onChange: (value) => {
            state.remote = value
          },
        })),
      checkbox('清理远端已删除的分支（--prune）', {
        checked: state.prune,
        onChange: (checked) => {
          state.prune = checked
          void savePrefs({ fetchPrune: checked })
        },
      }),
      checkbox('一并抓取标签（--tags）', {
        checked: state.tags,
        onChange: (checked) => {
          state.tags = checked
        },
      }),
    ],
    footer: (handle) => [
      button('取消', { onClick: () => handle.close() }),
      button('开始抓取', {
        kind: 'primary',
        onClick: async () => {
          handle.close()
          await startOperation('/fetch', {
            all: state.all,
            remote: state.all ? undefined : state.remote,
            prune: state.prune,
            tags: state.tags,
          })
        },
      }),
    ],
  })
}
