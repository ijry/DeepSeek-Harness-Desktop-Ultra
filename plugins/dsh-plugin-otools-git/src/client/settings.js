/**
 * The settings dialog: the git identity, the config keys the panel exposes, the
 * stored HTTPS credentials, and the AI writer's options.
 *
 * Config keys are the reference's plus the ones a Git GUI needs to be honest
 * about (autocrlf, pull.rebase, proxy). Each is shown with its LOCAL and GLOBAL
 * value so "why is this repository different" has an answer on screen.
 */

/** Open the settings dialog. */
function openSettingsDialog() {
  const state = { tab: 'general', config: null, loading: true }
  const handle = openDialog({
    title: '设置',
    width: 'wide',
    build: (dialogHandle) => {
      const tabs = el('div', { class: 'dsh-og-tabs' })
      for (const row of [
        { id: 'general', label: '身份与常规' },
        { id: 'config', label: 'Git 配置' },
        { id: 'credentials', label: '账号凭证' },
        { id: 'ai', label: 'AI 提交信息' },
        { id: 'about', label: '关于' },
      ]) {
        tabs.append(el('button', {
          type: 'button',
          class: 'dsh-og-tab',
          'data-active': state.tab === row.id ? 'true' : undefined,
          onClick: () => {
            state.tab = row.id
            dialogHandle.render()
          },
        }, row.label))
      }
      const body = state.tab === 'general' ? settingsGeneral(dialogHandle, state)
        : state.tab === 'config' ? settingsConfig(dialogHandle, state)
          : state.tab === 'credentials' ? settingsCredentials(dialogHandle)
            : state.tab === 'ai' ? settingsAi(dialogHandle)
              : settingsAbout()
      return [tabs, body]
    },
    footer: (dialogHandle) => [button('关闭', { kind: 'primary', onClick: () => dialogHandle.close() })],
  })
  void (async () => {
    await Promise.all([loadIdentity(), loadCredentials(), loadAiAvailability()])
    try {
      state.config = await apiGet('/config', { workspaceId: model.workspaceId })
    } catch { /* the tab reports it */ }
    state.loading = false
    handle.render()
  })()
}

/** The identity tab. */
function settingsGeneral(handle, state) {
  const identity = model.identity
  if (identity === null) return el('div', { class: 'dsh-og-loading' }, '正在读取身份配置...')
  const local = { name: identity.localName ?? '', email: identity.localEmail ?? '' }
  const useGlobal = { value: identity.useGlobal === true }

  const nodes = [
    identity.configured === true
      ? undefined
      : alertBox('warning', 'Git 身份还没配好', '没有 user.name 或 user.email 时，git 会拒绝创建提交。'),
    field('全局 user.name', input({ value: identity.globalName ?? '未设置', readonly: true })),
    field('全局 user.email', input({ value: identity.globalEmail ?? '未设置', readonly: true })),
    checkbox('这个仓库采用全局身份', {
      checked: useGlobal.value,
      onChange: async (checked) => {
        if (checked) {
          await saveConfig('user.name', undefined, 'local')
          await saveConfig('user.email', undefined, 'local')
        } else {
          await saveConfig('user.name', identity.globalName ?? '', 'local')
          await saveConfig('user.email', identity.globalEmail ?? '', 'local')
        }
        await loadIdentity()
        handle.render()
      },
    }),
  ]
  if (useGlobal.value !== true) {
    nodes.push(field('本仓库 user.name', input({
      value: local.name,
      onChange: (event) => void saveConfig('user.name', event.target.value, 'local').then(() => loadIdentity()),
    })))
    nodes.push(field('本仓库 user.email', input({
      value: local.email,
      onChange: (event) => void saveConfig('user.email', event.target.value, 'local').then(() => loadIdentity()),
    })))
  }

  nodes.push(el('h4', { style: { margin: '18px 0 8px', 'font-size': '13px' } }, '面板行为'))
  nodes.push(checkbox('操作成功后自动关闭进度弹窗', {
    checked: pref('autoCloseOnSuccess') !== false,
    onChange: (checked) => void savePrefs({ autoCloseOnSuccess: checked }),
  }))
  nodes.push(field('未跟踪文件', select({
    value: pref('untrackedMode') ?? 'all',
    options: [
      { id: 'all', label: '全部列出（包括目录里的每个文件）' },
      { id: 'normal', label: '只列出目录' },
      { id: 'no', label: '不显示' },
    ],
    onChange: (value) => {
      void savePrefs({ untrackedMode: value })
      void loadStatus()
    },
  })))
  return el('div', {}, ...nodes.filter((node) => node !== undefined))
}

/** Write one config key. */
async function saveConfig(key, value, scope) {
  try {
    await apiPost('/config/set', {
      workspaceId: model.workspaceId,
      key,
      value: value === undefined || value === null || String(value).length === 0 ? null : String(value),
      scope,
    })
    toast('已保存 ' + key, 'success', 1600)
  } catch (error) {
    toastError(error)
  }
}

/** The raw-config tab: every exposed key, with both scopes visible. */
function settingsConfig(handle, state) {
  if (state.config === null) {
    return el('div', { class: 'dsh-og-loading' }, state.loading ? '正在读取配置...' : '无法读取 git 配置')
  }
  const wrap = el('div', {})
  wrap.append(alertBox('info', '只列出这个面板会用到的配置项',
    '写入时会明确指定 --local 或 --global；留空表示取消设置。'))
  const scopeState = { scope: 'local' }
  wrap.append(el('div', { style: { display: 'flex', gap: '10px', margin: '12px 0', 'align-items': 'center' } },
    el('span', { style: { 'font-size': '12px', color: 'var(--og-text-2)' } }, '写入范围'),
    select({
      value: scopeState.scope,
      width: 200,
      options: [
        { id: 'local', label: '本仓库 (--local)' },
        { id: 'global', label: '全局 (--global)' },
      ],
      onChange: (value) => {
        scopeState.scope = value
      },
    })))

  for (const [key, row] of Object.entries(state.config)) {
    const control = input({
      value: row.local ?? row.global ?? '',
      placeholder: row.effective === undefined ? '未设置' : row.effective,
      onChange: async (event) => {
        await saveConfig(key, event.target.value, scopeState.scope)
        state.config = await apiGet('/config', { workspaceId: model.workspaceId }).catch(() => state.config)
        handle.render()
      },
    })
    control.style.width = '100%'
    wrap.append(el('div', { class: 'dsh-og-setting-row' },
      el('div', {},
        el('div', { class: 'dsh-og-setting-key' }, key),
        el('div', { class: 'dsh-og-setting-scope' },
          '本仓库: ' + (row.local ?? '—') + '　全局: ' + (row.global ?? '—'))),
      control))
  }
  return wrap
}

/** The credentials tab. */
function settingsCredentials(handle) {
  const wrap = el('div', {})
  wrap.append(alertBox('info', 'HTTPS 凭证保存在 DSH 家目录下的单独文件里',
    '文件权限是 0600（Windows 上跟随目录 ACL）。浏览器只会拿到"哪个主机有凭证、用户名是什么"，永远拿不到密码本身。'))
  wrap.append(el('div', { style: { display: 'flex', gap: '8px', margin: '12px 0' } },
    button('添加凭证...', {
      kind: 'primary',
      icon: 'plus',
      onClick: async () => {
        const host = await promptBox({
          title: '添加 HTTPS 凭证',
          message: '主机名（例如 github.com、gitlab.com、git.company.com）：',
          placeholder: 'github.com',
          emptyMessage: '主机名不能为空',
        })
        if (host === undefined) return
        openCredentialDialog(host.toLowerCase())
      },
    })))

  const env = model.credentials.env ?? []
  if (env.length > 0) {
    wrap.append(el('h4', { style: { margin: '14px 0 6px', 'font-size': '12px' } }, '来自环境变量（优先于保存的凭证）'))
    for (const row of env) {
      wrap.append(el('div', { class: 'dsh-og-cred-row' },
        el('span', { class: 'dsh-og-cred-host' }, row.host === '*' ? '（所有主机）' : row.host),
        tag(row.variable, 'primary'),
        el('span', { style: { 'font-size': '11px', color: 'var(--og-text-3)' } }, '由启动环境提供，这里不能修改')))
    }
  }

  const hosts = model.credentials.hosts ?? []
  wrap.append(el('h4', { style: { margin: '14px 0 6px', 'font-size': '12px' } }, '已保存的凭证'))
  if (hosts.length === 0) {
    wrap.append(el('div', { class: 'dsh-og-loading' }, '还没有保存任何 HTTPS 凭证'))
  }
  for (const row of hosts) {
    wrap.append(el('div', { class: 'dsh-og-cred-row' },
      el('span', { class: 'dsh-og-cred-host' }, row.host),
      el('span', { style: { 'font-size': '12px', color: 'var(--og-text-2)' } }, row.username ?? ''),
      el('div', { style: { 'margin-left': 'auto', display: 'flex', gap: '6px' } },
        button('修改', {
          size: 'mini',
          onClick: () => openCredentialDialog(row.host, { username: row.username }),
        }),
        button('删除', {
          size: 'mini',
          kind: 'danger',
          onClick: async () => {
            try {
              model.credentials = await apiPost('/credentials/delete', { host: row.host })
              toast('已删除 ' + row.host + ' 的凭证', 'success')
              handle.render()
            } catch (error) {
              toastError(error)
            }
          },
        }))))
  }
  return wrap
}

/** The AI tab. */
function settingsAi(handle) {
  const availability = model.aiAvailability
  const wrap = el('div', {})
  if (availability === null) {
    wrap.append(el('div', { class: 'dsh-og-loading' }, '正在检查模型可用性...'))
    return wrap
  }
  wrap.append(availability.available === true
    ? alertBox('success', '已接入 DSH 的模型',
      '提供方 ' + availability.provider + '，模型 ' + availability.model +
      '。用的就是 DSH 里已经选好的默认模型，这个面板不需要另外配 API key。')
    : alertBox('warning', '暂时不能生成提交信息', availability.reason ?? ''))

  wrap.append(el('div', { style: { 'margin-top': '14px' } },
    field('提交信息风格', select({
      value: pref('aiStyle') ?? 'conventional',
      options: AI_STYLES,
      onChange: (value) => void savePrefs({ aiStyle: value }),
    }), 'Conventional Commits 会写成 feat(scope): subject 的形式。'),
    field('语言', select({
      value: pref('aiLanguage') ?? 'zh',
      options: AI_LANGUAGES,
      onChange: (value) => void savePrefs({ aiLanguage: value }),
    }))))

  wrap.append(alertBox('info', '模型看到的是什么',
    '已暂存的改动（没有暂存时退回到工作区改动）的文件清单和 diff，最多 48000 个字符。' +
    'diff 是带围栏的数据，不是指令 —— 一份写着"忽略前面的要求"的补丁不会改变它的行为。'))
  wrap.append(el('div', { style: { 'margin-top': '10px' } },
    button('刷新可用性', {
      size: 'mini',
      icon: 'refresh',
      onClick: async () => {
        await loadAiAvailability()
        handle.render()
      },
    })))
  return wrap
}

/** The about tab: the git installation and what this panel deliberately omits. */
function settingsAbout() {
  const install = model.install
  const wrap = el('div', {})
  wrap.append(field('Git 版本', input({
    value: install === null ? '检测中...' : (install.installed === true ? install.version : install.message),
    readonly: true,
  })))
  if (install !== null && install.binaryPath !== undefined) {
    wrap.append(field('Git 路径', input({ value: install.binaryPath, readonly: true })))
  }
  wrap.append(field('平台', input({ value: install === null ? '' : (install.os ?? ''), readonly: true })))
  wrap.append(alertBox('info', '仓库列表来自 DSH 的工作区',
    '这个面板不维护自己的仓库清单：在 DSH 里打开的每个文件夹，只要是 git 仓库就会出现在左边。' +
    '所以没有"添加仓库"、拖动排序和重命名 —— 那些都由 DSH 的工作区管理。'))
  wrap.append(el('div', { style: { 'margin-top': '10px' } },
    alertBox('info', '这个移植版没有的三块功能',
      '软著申请助手、内置终端、文件编辑器。它们不属于 Git，交给 DSH 自己的对应能力更合适。')))
  return wrap
}
