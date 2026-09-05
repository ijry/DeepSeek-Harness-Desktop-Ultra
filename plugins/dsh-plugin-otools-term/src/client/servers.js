/**
 * The server list and its dialogs: add / edit, the per-row context menu, the delete
 * confirmation, the host-key review, and the ~/.ssh/config import.
 *
 * The dialog is the reference's field for field (name, protocol radio, host, port,
 * user, auth radio, password / key path + passphrase), plus what a browser needs
 * instead of a native file dialog: a "paste the key" textarea, an SSH-agent checkbox,
 * and the import.
 */

/** Blank draft, with the reference's defaults. */
function emptyServerDraft() {
  return {
    id: '',
    name: '',
    protocol: 'ssh',
    host: '',
    port: DEFAULT_PORTS.ssh,
    username: '',
    authType: 'password',
    privateKeyPath: '',
    useAgent: false,
    keepaliveSeconds: 30,
    group: '',
    note: '',
    secrets: {},
  }
}

/** Open the add/edit dialog. */
function openServerDialog(existing) {
  const draft = existing === undefined
    ? emptyServerDraft()
    : { ...emptyServerDraft(), ...existing, secrets: {} }
  const body = el('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } })
  const record = openDialog({
    title: existing === undefined ? t('main.serverDialog.addTitle') : t('main.serverDialog.editTitle'),
    build: () => body,
    footer: (close) => [
      existing === undefined
        ? button({ label: t('main.serverDialog.importSshConfig'), onClick: () => {
          close(undefined)
          void openImportDialog()
        } })
        : undefined,
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      button({ label: t('main.save'), variant: 'primary', onClick: () => void submitServer(draft, existing, close) }),
    ],
  })
  const repaint = () => fill(body, ...serverFields(draft, existing, repaint))
  repaint()
  return record
}

/** The dialog's fields, rebuilt when the protocol or auth type changes. */
function serverFields(draft, existing, repaint) {
  const rows = []
  rows.push(field(t('main.serverDialog.name'), input({
    value: draft.name,
    placeholder: t('main.serverDialog.namePlaceholder'),
    onInput: (event) => {
      draft.name = event.target.value
    },
  })))
  rows.push(field(t('main.serverDialog.protocol'), radioGroup('dsh-ot-protocol', [
    { id: 'ssh', label: t('main.serverDialog.protocolSsh') },
    { id: 'rdp', label: t('main.serverDialog.protocolRdp') },
    { id: 'vnc', label: t('main.serverDialog.protocolVnc') },
  ], draft.protocol, (value) => {
    // Moving the protocol moves the port with it, unless the user typed one.
    if (draft.port === DEFAULT_PORTS[draft.protocol]) draft.port = DEFAULT_PORTS[value]
    draft.protocol = value
    repaint()
  })))
  rows.push(el('div', { class: 'dsh-ot-row' },
    field(t('main.serverDialog.host'), input({
      value: draft.host,
      placeholder: t('main.serverDialog.hostPlaceholder'),
      onInput: (event) => {
        draft.host = event.target.value
      },
    })),
    field(t('main.serverDialog.port'), input({
      type: 'number',
      value: draft.port,
      min: 1,
      max: 65535,
      onInput: (event) => {
        draft.port = Number(event.target.value)
      },
    }))))
  rows.push(el('div', { class: 'dsh-ot-row' },
    field(t('main.serverDialog.username'), input({
      value: draft.username,
      placeholder: t('main.serverDialog.usernamePlaceholder'),
      onInput: (event) => {
        draft.username = event.target.value
      },
    })),
    field(t('main.serverDialog.group'), input({
      value: draft.group,
      onInput: (event) => {
        draft.group = event.target.value
      },
    }))))

  if (draft.protocol === 'ssh') {
    rows.push(field(t('main.serverDialog.authType'), radioGroup('dsh-ot-auth', [
      { id: 'password', label: t('main.serverDialog.authPassword') },
      { id: 'private_key', label: t('main.serverDialog.authPrivateKey') },
    ], draft.authType, (value) => {
      draft.authType = value
      repaint()
    })))
  }

  if (draft.protocol !== 'ssh' || draft.authType === 'password') {
    rows.push(field(t('main.serverDialog.password'), input({
      type: 'password',
      placeholder: t('main.serverDialog.passwordPlaceholder'),
      onInput: (event) => {
        draft.secrets.password = event.target.value
      },
    }), existing !== undefined && existing.hasPassword === true ? t('main.serverDialog.passwordKept') : undefined))
  } else {
    rows.push(field(t('main.serverDialog.privateKeyPath'), input({
      value: draft.privateKeyPath,
      placeholder: t('main.serverDialog.privateKeyPathPlaceholder'),
      onInput: (event) => {
        draft.privateKeyPath = event.target.value
      },
    })))
    rows.push(field(t('main.serverDialog.privateKeyBody'), textarea({
      placeholder: t('main.serverDialog.privateKeyBodyPlaceholder'),
      rows: 4,
      onInput: (event) => {
        draft.secrets.privateKeyBody = event.target.value
      },
    }), existing !== undefined && existing.hasPrivateKeyBody === true ? t('main.serverDialog.privateKeyStored') : undefined))
    rows.push(field(t('main.serverDialog.passphrase'), input({
      type: 'password',
      placeholder: t('main.serverDialog.passphrasePlaceholder'),
      onInput: (event) => {
        draft.secrets.passphrase = event.target.value
      },
    })))
  }

  if (draft.protocol === 'ssh') {
    rows.push(el('div', { class: 'dsh-ot-row' },
      el('div', {}, checkbox(t('main.serverDialog.useAgent'), draft.useAgent === true, (value) => {
        draft.useAgent = value
      })),
      field(t('main.serverDialog.keepalive'), input({
        type: 'number',
        value: draft.keepaliveSeconds,
        min: 0,
        max: 600,
        onInput: (event) => {
          draft.keepaliveSeconds = Number(event.target.value)
        },
      }))))
  }
  rows.push(field(t('main.serverDialog.note'), input({
    value: draft.note,
    onInput: (event) => {
      draft.note = event.target.value
    },
  })))
  return rows
}

/** Validate and save one draft. */
async function submitServer(draft, existing, close) {
  if (draft.name.trim().length === 0 || draft.host.trim().length === 0) {
    toast(t('main.serverDialog.requiredFields'), 'warning')
    return
  }
  if (draft.protocol !== 'vnc' && draft.username.trim().length === 0) {
    toast(t('main.serverDialog.requiredFields'), 'warning')
    return
  }
  const hasStoredPassword = existing !== undefined && existing.hasPassword === true
  const hasStoredKey = existing !== undefined && (existing.hasPrivateKeyBody === true || (existing.privateKeyPath ?? '').length > 0)
  if (draft.protocol === 'ssh' && draft.authType === 'private_key') {
    const keyGiven = (draft.privateKeyPath ?? '').trim().length > 0 ||
      (draft.secrets.privateKeyBody ?? '').trim().length > 0 || hasStoredKey || draft.useAgent === true
    if (!keyGiven) {
      toast(t('main.serverDialog.privateKeyRequired'), 'warning')
      return
    }
  } else if ((draft.secrets.password ?? '').length === 0 && !hasStoredPassword && draft.useAgent !== true) {
    toast(t('main.serverDialog.passwordRequired'), 'warning')
    return
  }
  const server = { ...draft }
  delete server.secrets
  // Only the secrets the user actually typed are sent: an untouched password field
  // must not clear the stored one.
  const secrets = {}
  for (const key of ['password', 'passphrase', 'privateKeyBody']) {
    const value = draft.secrets[key]
    if (typeof value === 'string' && value.length > 0) secrets[key] = value
  }
  try {
    await withBusy(() => apiPost('/servers/save', {
      server,
      secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
      reconnect: existing !== undefined,
    }))
    await loadState()
    close(undefined)
  } catch (error) {
    toastError(error)
  }
}

/** The ~/.ssh/config import dialog: candidates with checkboxes. */
async function openImportDialog() {
  let value
  try {
    value = await withBusy(() => apiPost('/servers/import-ssh-config', {}))
  } catch (error) {
    toastError(error)
    return
  }
  const chosen = new Set(value.hosts.map((row) => row.alias))
  openDialog({
    title: t('main.serverDialog.importTitle'),
    build: () => {
      if (value.hosts.length === 0) return el('div', { class: 'dsh-ot-empty' }, t('main.serverDialog.importEmpty'))
      return [
        el('div', { class: 'dsh-ot-field-hint' }, value.file),
        ...value.hosts.map((row) => el('div', { class: 'dsh-ot-section' },
          checkbox(row.alias, true, (on) => {
            if (on) chosen.add(row.alias)
            else chosen.delete(row.alias)
          }),
          el('div', { class: 'dsh-ot-field-hint' },
            (row.username.length > 0 ? row.username + '@' : '') + row.host + ':' + row.port +
            (row.privateKeyPath.length > 0 ? ' · ' + row.privateKeyPath : '') +
            (row.unsupported.length > 0 ? ' · ' + t('main.serverDialog.importUnsupported', { list: row.unsupported.join(', ') }) : '')))),
      ]
    },
    footer: (close) => [
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      button({
        label: t('main.serverDialog.importSelected', { count: chosen.size }),
        variant: 'primary',
        disabled: value.hosts.length === 0,
        onClick: async () => {
          let count = 0
          for (const row of value.hosts) {
            if (!chosen.has(row.alias)) continue
            try {
              await apiPost('/servers/save', {
                server: {
                  name: row.name,
                  protocol: 'ssh',
                  host: row.host,
                  port: row.port,
                  username: row.username,
                  authType: row.authType,
                  privateKeyPath: row.privateKeyPath,
                  useAgent: row.authType === 'private_key' && row.privateKeyPath.length === 0,
                },
              })
              count += 1
            } catch (error) {
              toastError(error)
            }
          }
          await loadState()
          close(undefined)
          toast(t('main.serverDialog.imported', { count }), 'success')
        },
      }),
    ],
  })
}

/** The host-key review dialog: first contact, or a mismatch. */
function openHostKeyDialog(detail) {
  const mismatch = detail.mismatch === true
  openDialog({
    title: t('hostkey.title'),
    size: 'small',
    build: () => [
      el('div', {}, mismatch
        ? t('hostkey.mismatch', { host: detail.host, port: detail.port })
        : t('hostkey.firstTime', { host: detail.host, port: detail.port })),
      mismatch
        ? el('div', { class: 'dsh-ot-field-hint' }, t('hostkey.pinned') + ': ' + (detail.pinnedFingerprint ?? ''))
        : undefined,
      el('div', { class: 'dsh-ot-mono' }, t('hostkey.incoming') + ': ' + (detail.keyType ?? '') + ' ' + (detail.fingerprint ?? '')),
      mismatch ? el('div', { class: 'dsh-ot-field-hint' }, t('hostkey.forgetHint')) : undefined,
    ],
    footer: (close) => [
      button({ label: t('main.cancel'), onClick: () => close(undefined) }),
      mismatch
        ? button({
          label: t('hostkey.forget'),
          variant: 'danger',
          onClick: async () => {
            try {
              await apiPost('/connection/host-key/forget', { host: detail.host, port: detail.port })
              await loadState()
              close(undefined)
              toast(t('hostkey.forgotten'), 'success')
            } catch (error) {
              toastError(error)
            }
          },
        })
        : button({
          label: t('hostkey.accept'),
          variant: 'primary',
          onClick: async () => {
            try {
              await apiPost('/connection/host-key/accept', {
                serverId: detail.serverId,
                fingerprint: detail.fingerprint,
                keyType: detail.keyType,
              })
              close(undefined)
              toast(t('hostkey.accepted'), 'success')
              await connectServer(detail.serverId)
            } catch (error) {
              toastError(error)
            }
          },
        }),
    ],
  })
}
