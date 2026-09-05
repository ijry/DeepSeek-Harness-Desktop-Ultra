/**
 * The settings dialog: the reference's one SSH setting, the terminal preferences that
 * used to be hard-coded, and the host-key list.
 *
 * The reference's dialog had exactly one control (what happens to tabs when a
 * connection closes) plus three lines of explanation, and the explanation is
 * reproduced verbatim. The terminal tab exists because the reference's font size,
 * scrollback and cursor blink were constants in its component; there is no reason for
 * them to be.
 */

/** Open the dialog. */
function openSettingsDialog() {
  let activeTab = 'ssh'
  const body = el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } })
  openDialog({
    title: t('settings.dialogTitle'),
    build: () => body,
    footer: (close) => [button({ label: t('main.close'), variant: 'primary', onClick: () => close(undefined) })],
  })
  const repaint = () => {
    const tabs = [
      { id: 'ssh', label: t('settings.tabSsh') },
      { id: 'terminal', label: t('settings.tabTerminal') },
      { id: 'hostkeys', label: t('settings.tabHostKeys') },
    ]
    fill(body,
      el('div', { class: 'dsh-ot-toolbar-group' }, ...tabs.map((tab) => button({
        label: tab.label,
        active: activeTab === tab.id,
        onClick: () => {
          activeTab = tab.id
          repaint()
        },
      }))),
      activeTab === 'ssh' ? renderSshSettings() : undefined,
      activeTab === 'terminal' ? renderTerminalSettings(repaint) : undefined,
      activeTab === 'hostkeys' ? renderHostKeySettings(repaint) : undefined)
  }
  repaint()
}

/** The one setting the reference had, with its three hint lines. */
function renderSshSettings() {
  return el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
    field(t('settings.closeBehavior'), radioGroup('dsh-ot-close', [
      { id: 'close-tabs', label: t('settings.closeTabs') },
      { id: 'keep-tabs', label: t('settings.keepTabs') },
    ], pref('closeBehavior', 'close-tabs'), (value) => void savePrefs({ closeBehavior: value }))),
    el('div', { class: 'dsh-ot-section', style: { gap: '6px' } },
      el('div', { class: 'dsh-ot-field-hint' }, t('settings.hint1')),
      el('div', { class: 'dsh-ot-field-hint' }, t('settings.hint2')),
      el('div', { class: 'dsh-ot-field-hint' }, t('settings.hint3'))),
    el('div', { class: 'dsh-ot-field-hint' },
      model.local.pty === true
        ? t('settings.ptyOk')
        : t('settings.ptyMissing', { reason: model.local.reason ?? '' })))
}

/** Terminal look and feel. */
function renderTerminalSettings(repaint) {
  return el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
    el('div', { class: 'dsh-ot-row' },
      field(t('settings.fontSize'), input({
        type: 'number',
        value: pref('fontSize', 13),
        min: 8,
        max: 32,
        onChange: (event) => {
          void savePrefs({ fontSize: Number(event.target.value) }).then(restyleTerminals)
        },
      })),
      field(t('settings.scrollback'), input({
        type: 'number',
        value: pref('scrollback', 2000),
        min: 200,
        max: 200000,
        onChange: (event) => {
          void savePrefs({ scrollback: Number(event.target.value) }).then(restyleTerminals)
        },
      }))),
    field(t('main.theme'), select(themeOptions().map((name) => ({ id: name, label: name })), pref('themeName', 'default'), (value) => {
      void savePrefs({ themeName: value }).then(restyleTerminals)
    })),
    checkbox(t('settings.cursorBlink'), pref('cursorBlink', true) === true, (value) => {
      void savePrefs({ cursorBlink: value }).then(restyleTerminals)
    }),
    checkbox(t('settings.copyOnSelect'), pref('copyOnSelect', false) === true, (value) => void savePrefs({ copyOnSelect: value })),
    checkbox(t('settings.confirmDangerous'), pref('confirmDangerousCommands', true) === true, (value) => (
      void savePrefs({ confirmDangerousCommands: value })
    )),
    field(t('settings.localShell'), input({
      value: pref('localShell', ''),
      placeholder: t('settings.localShellPlaceholder'),
      onChange: (event) => void savePrefs({ localShell: event.target.value }),
    }), model.local.shell),
    field(t('settings.aiLanguage'), select([
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ], pref('aiLanguage', 'zh'), (value) => void savePrefs({ aiLanguage: value }))))
}

/** The accepted host keys, with a delete button each. */
function renderHostKeySettings(repaint) {
  const rows = model.knownHosts.length === 0
    ? [el('div', { class: 'dsh-ot-empty' }, t('hostkey.empty'))]
    : model.knownHosts.map((row) => el('div', { class: 'dsh-ot-section', style: { gap: '6px' } },
      el('div', { class: 'dsh-ot-section-head' },
        el('span', { class: 'dsh-ot-section-title' }, row.endpoint),
        button({
          label: t('hostkey.forget'),
          variant: 'danger',
          onClick: async () => {
            const parsed = parseEndpoint(row.endpoint)
            try {
              await apiPost('/connection/host-key/forget', parsed)
              await loadState()
              repaint()
              toast(t('hostkey.forgotten'), 'success')
            } catch (error) {
              toastError(error)
            }
          },
        })),
      el('div', { class: 'dsh-ot-mono' }, (row.keyType ?? '') + ' ' + row.fingerprint),
      el('div', { class: 'dsh-ot-field-hint' }, formatTime(row.acceptedAt))))
  return el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } },
    el('div', { class: 'dsh-ot-section-title' }, t('hostkey.listTitle')),
    ...rows)
}

/** `[host]:port` or `host` back into `{host, port}`. */
function parseEndpoint(endpoint) {
  const match = String(endpoint).match(/^\[(.+)\]:(\d+)$/)
  if (match !== null) return { host: match[1], port: Number(match[2]) }
  return { host: String(endpoint), port: 22 }
}
