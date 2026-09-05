/**
 * The remote-desktop card: the reference's hero panel, field for field (protocol,
 * address, user, credential state) plus a launch button.
 *
 * Two additions, both because the reference put a password on a command line: the
 * card lists which native clients this machine actually has, and handing the stored
 * password to the client is a checkbox that says what it costs.
 */

/** Build the desktop pane for one server tab. */
function buildDesktopPane(tab) {
  const pane = el('div', { class: 'dsh-ot-pane', 'data-tab': tab.id })
  renderDesktopPane(pane, tab)
  return pane
}

/** Repaint the card. */
function renderDesktopPane(pane, tab) {
  const server = serverById(tab.serverId)
  if (server === undefined) {
    fill(pane, el('div', { class: 'dsh-ot-empty' }, t('main.emptySelectServer')))
    return
  }
  const clients = server.protocol === 'rdp' ? model.desktop.rdp : model.desktop.vnc
  const available = Array.isArray(clients) ? clients : []
  const sendPassword = tab.sendPassword === true

  fill(pane, el('div', { class: 'dsh-ot-editor', style: { gap: '14px' } },
    el('div', { class: 'dsh-ot-section' },
      el('div', { class: 'dsh-ot-section-head' },
        el('div', {},
          el('div', { class: 'dsh-ot-field-hint' }, t('main.desktop.title')),
          el('div', { style: { 'font-size': '18px', 'font-weight': '600' } }, server.name)),
        button({
          label: tab.launching === true ? t('main.desktop.launching') : t('main.desktop.launch'),
          variant: 'primary',
          icon: 'monitor',
          disabled: tab.launching === true || available.length === 0,
          onClick: () => void launchDesktop(tab, server),
        })),
      el('div', { class: 'dsh-ot-field-hint' }, t('main.desktop.subtitle')),
      el('div', { class: 'dsh-ot-row', style: { 'flex-wrap': 'wrap' } },
        infoCard(t('main.desktop.protocol'), String(server.protocol).toUpperCase()),
        infoCard(t('main.desktop.address'), server.host + ':' + server.port),
        infoCard(t('main.serverDialog.username'), server.username.length > 0 ? server.username : '-'),
        infoCard(t('main.desktop.auth'), server.hasPassword === true ? t('main.desktop.passwordAuth') : t('main.desktop.noPassword'))),
      el('div', { class: 'dsh-ot-field-hint' },
        t('main.desktop.clients') + '：' + (available.length > 0 ? available.join('、') : t('main.desktop.noClients'))),
      server.hasPassword === true
        ? el('div', {},
          checkbox(t('main.desktop.sendPassword'), sendPassword, (value) => {
            tab.sendPassword = value
            renderDesktopPane(pane, tab)
          }),
          sendPassword ? el('div', { class: 'dsh-ot-field-hint' }, t('main.desktop.sendPasswordHint')) : undefined)
        : undefined)))
}

/** One labelled value box. */
function infoCard(label, value) {
  return el('div', { class: 'dsh-ot-section', style: { gap: '4px', 'min-width': '160px' } },
    el('div', { class: 'dsh-ot-field-hint' }, label),
    el('div', { style: { 'font-size': '14px', 'font-weight': '600' } }, value))
}

/** Ask the host to spawn a client. */
async function launchDesktop(tab, server) {
  tab.launching = true
  emit()
  try {
    const value = await apiPost('/desktop/launch', { serverId: server.id, sendPassword: tab.sendPassword === true })
    toast(t('main.desktop.launchSuccess', { client: value.client, host: value.host, port: value.port }), 'success')
  } catch (error) {
    toast(t('main.desktop.launchFailed', { message: friendlyError(error) }), 'error')
  } finally {
    tab.launching = false
    emit()
  }
}
