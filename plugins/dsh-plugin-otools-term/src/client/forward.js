/**
 * The forwarding dialog: local port forwards and the SOCKS5 proxy for one server.
 *
 * Same two sections the reference had, same buttons (add rule / save / start / stop /
 * delete, and start / stop for the proxy). Two things are different because they were
 * wrong rather than merely different:
 *
 *  - a listener binds to 127.0.0.1 unless "allow access from other machines" is
 *    ticked. The reference took whatever was in the field, so a `0.0.0.0` left over
 *    from a previous rule silently published a hole into the remote network;
 *  - a running rule shows its live byte counters, which is how you tell a tunnel that
 *    is up from one that is up AND being used.
 */

/** Open the dialog for one server. */
function openForwardingDialog(serverId) {
  const server = serverById(serverId)
  if (server === undefined) return
  // A working copy: nothing is written until Save, exactly like the reference's draft.
  const draft = {
    portForwards: (server.portForwards ?? []).map((row) => ({ ...row })),
    socks5Proxy: { ...(server.socks5Proxy ?? { listenHost: '127.0.0.1', listenPort: 1080, allowPublic: false }) },
  }
  const body = el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '14px' } })
  let unbind = null
  const record = openDialog({
    title: t('main.forwarding.title'),
    size: 'large',
    build: () => body,
    footer: (close) => [
      button({ label: t('main.close'), onClick: () => close(undefined) }),
      button({ label: t('main.forwarding.saveConfig'), variant: 'primary', onClick: () => void saveForwarding(serverId, draft) }),
    ],
    onClose: () => {
      if (unbind !== null) unbind()
    },
  })
  const repaint = () => {
    fill(body, renderForwardingBody(serverId, draft, repaint))
  }
  // The dialog follows the live tunnel state, so a rule started here flips to
  // "running" without a manual refresh.
  unbind = onModel(() => {
    if (record.overlay.isConnected) repaint()
  })
  repaint()
}

/** The two sections. */
function renderForwardingBody(serverId, draft, repaint) {
  const server = serverById(serverId)
  const rows = []
  rows.push(el('div', { class: 'dsh-ot-field-hint' },
    (server?.name ?? '') + ' · ' + (server?.username ?? '') + '@' + (server?.host ?? '') + ':' + (server?.port ?? '')))

  const ruleCards = draft.portForwards.length === 0
    ? [el('div', { class: 'dsh-ot-empty' }, t('main.forwarding.emptyRules'))]
    : draft.portForwards.map((rule) => renderRuleCard(serverId, draft, rule, repaint))
  rows.push(section(t('main.forwarding.portForwardTitle'), [
    button({ label: t('main.forwarding.addRule'), icon: 'plus', onClick: () => {
      draft.portForwards.push({
        id: newId('rule'),
        name: '',
        listenHost: '127.0.0.1',
        listenPort: 3307,
        remoteHost: '127.0.0.1',
        remotePort: 3306,
        allowPublic: false,
        enabled: false,
      })
      repaint()
    } }),
    button({ label: t('main.forwarding.saveRules'), onClick: () => void saveForwarding(serverId, draft) }),
  ], ...ruleCards))

  rows.push(renderSocksSection(serverId, draft, repaint))
  return rows
}

/** One forwarding rule. */
function renderRuleCard(serverId, draft, rule, repaint) {
  const running = isForwardRunning(serverId, rule.id)
  const runtime = model.tunnels.portForwards.find((row) => row.serverId === serverId && row.ruleId === rule.id)
  return el('div', { class: 'dsh-ot-section' },
    el('div', { class: 'dsh-ot-section-head' },
      el('span', { class: 'dsh-ot-section-title' },
        rule.name.length > 0 ? rule.name : t('main.forwarding.portRuleName', { port: rule.listenPort })),
      el('div', { class: 'dsh-ot-toolbar-group' },
        runtime === undefined ? undefined : el('span', { class: 'dsh-ot-field-hint' }, t('main.forwarding.traffic', {
          out: formatBytes(runtime.bytesOut),
          in: formatBytes(runtime.bytesIn),
          connections: runtime.connections,
        })),
        tag(running ? t('main.forwarding.running') : t('main.forwarding.stopped'), running ? 'success' : undefined))),
    field(t('main.forwarding.ruleName'), input({
      value: rule.name,
      placeholder: t('main.forwarding.ruleNamePlaceholder'),
      onInput: (event) => {
        rule.name = event.target.value
      },
    })),
    el('div', { class: 'dsh-ot-row' },
      field(t('main.forwarding.localHost'), input({
        value: rule.listenHost,
        placeholder: '127.0.0.1',
        onInput: (event) => {
          rule.listenHost = event.target.value
        },
      })),
      field(t('main.forwarding.localPort'), input({
        type: 'number',
        value: rule.listenPort,
        min: 1,
        max: 65535,
        onInput: (event) => {
          rule.listenPort = Number(event.target.value)
        },
      }))),
    el('div', { class: 'dsh-ot-row' },
      field(t('main.forwarding.remoteHost'), input({
        value: rule.remoteHost,
        placeholder: '127.0.0.1',
        onInput: (event) => {
          rule.remoteHost = event.target.value
        },
      })),
      field(t('main.forwarding.remotePort'), input({
        type: 'number',
        value: rule.remotePort,
        min: 1,
        max: 65535,
        onInput: (event) => {
          rule.remotePort = Number(event.target.value)
        },
      }))),
    checkbox(t('main.forwarding.allowPublic'), rule.allowPublic === true, (value) => {
      rule.allowPublic = value
      repaint()
    }),
    rule.allowPublic === true ? el('div', { class: 'dsh-ot-field-hint' }, t('main.forwarding.allowPublicHint')) : undefined,
    el('div', { class: 'dsh-ot-toolbar-group', style: { 'justify-content': 'flex-end' } },
      button({
        label: t('main.forwarding.start'),
        variant: 'primary',
        disabled: running,
        onClick: () => void startForward(serverId, rule),
      }),
      button({ label: t('main.forwarding.stop'), disabled: !running, onClick: () => void stopForward(serverId, rule.id) }),
      button({
        label: t('main.forwarding.delete'),
        variant: 'danger',
        onClick: async () => {
          try {
            await apiPost('/tunnel/forward/delete', { serverId, ruleId: rule.id })
            draft.portForwards = draft.portForwards.filter((row) => row.id !== rule.id)
            await loadState()
            repaint()
          } catch (error) {
            toastError(error)
          }
        },
      })))
}

/** The SOCKS5 section. */
function renderSocksSection(serverId, draft, repaint) {
  const running = isSocksRunning(serverId)
  const runtime = model.tunnels.socks5.find((row) => row.serverId === serverId)
  const proxy = draft.socks5Proxy
  return section(t('main.forwarding.socks5Title'), [
    button({ label: t('main.forwarding.saveConfig'), onClick: () => void saveForwarding(serverId, draft) }),
  ],
  el('div', { class: 'dsh-ot-section-head' },
    el('span', { class: 'dsh-ot-section-title' }, t('main.forwarding.socks5Listen')),
    el('div', { class: 'dsh-ot-toolbar-group' },
      runtime === undefined ? undefined : el('span', { class: 'dsh-ot-field-hint' }, t('main.forwarding.traffic', {
        out: formatBytes(runtime.bytesOut),
        in: formatBytes(runtime.bytesIn),
        connections: runtime.connections,
      })),
      tag(running ? t('main.forwarding.running') : t('main.forwarding.stopped'), running ? 'success' : undefined))),
  el('div', { class: 'dsh-ot-row' },
    field(t('main.forwarding.listenHost'), input({
      value: proxy.listenHost,
      placeholder: '127.0.0.1',
      onInput: (event) => {
        proxy.listenHost = event.target.value
      },
    })),
    field(t('main.forwarding.listenPort'), input({
      type: 'number',
      value: proxy.listenPort,
      min: 1,
      max: 65535,
      onInput: (event) => {
        proxy.listenPort = Number(event.target.value)
      },
    }))),
  checkbox(t('main.forwarding.allowPublic'), proxy.allowPublic === true, (value) => {
    proxy.allowPublic = value
    repaint()
  }),
  proxy.allowPublic === true ? el('div', { class: 'dsh-ot-field-hint' }, t('main.forwarding.allowPublicHint')) : undefined,
  el('div', { class: 'dsh-ot-toolbar-group', style: { 'justify-content': 'flex-end' } },
    button({
      label: t('main.forwarding.start'),
      variant: 'primary',
      disabled: running,
      onClick: async () => {
        try {
          const runtimeInfo = await withBusy(() => apiPost('/tunnel/socks/start', { serverId, proxy }))
          toast(t('main.forwarding.socks5Started', { host: runtimeInfo.listenHost, port: runtimeInfo.listenPort }), 'success')
          await loadState()
        } catch (error) {
          toastError(error)
        }
      },
    }),
    button({
      label: t('main.forwarding.stop'),
      disabled: !running,
      onClick: async () => {
        try {
          await apiPost('/tunnel/socks/stop', { serverId })
          toast(t('main.forwarding.socks5Stopped'), 'success')
          await loadState()
        } catch (error) {
          toastError(error)
        }
      },
    })))
}

/** Start one rule. */
async function startForward(serverId, rule) {
  try {
    const runtime = await withBusy(() => apiPost('/tunnel/forward/start', { serverId, rule }))
    toast(t('main.forwarding.started', { host: runtime.listenHost, port: runtime.listenPort }), 'success')
    await loadState()
  } catch (error) {
    toastError(error)
  }
}

/** Stop one rule. */
async function stopForward(serverId, ruleId) {
  try {
    await apiPost('/tunnel/forward/stop', { serverId, ruleId })
    toast(t('main.forwarding.stoppedMessage'), 'success')
    await loadState()
  } catch (error) {
    toastError(error)
  }
}

/** Persist the draft rules and proxy config. */
async function saveForwarding(serverId, draft) {
  try {
    await apiPost('/tunnel/forward/save', { serverId, rules: draft.portForwards })
    await loadState()
    toast(t('main.forwarding.saved'), 'success')
  } catch (error) {
    toastError(error)
  }
}
