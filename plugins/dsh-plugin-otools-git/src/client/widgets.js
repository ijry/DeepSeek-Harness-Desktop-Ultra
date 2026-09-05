/**
 * The hand-rolled widget set. The reference is built on Element Plus; this bundle
 * ships no component library, so the pieces it used — button, input, select,
 * checkbox, tag, dialog, drawer, dropdown, message box, table, progress, alert,
 * toast — are re-created here at the same sizes and with the same behaviour.
 *
 * Overlays are stacked: `Escape` closes the TOPMOST one only, never two at once
 * and never the panel itself, which is the rule the reference's dialogs follow.
 */
const overlays = []

/** A button. `kind` is default | primary | danger | warning | text | link. */
function button(label, options) {
  const opts = options ?? {}
  const node = el('button', {
    type: 'button',
    class: 'dsh-og-btn',
    'data-kind': opts.kind,
    'data-size': opts.size,
    title: opts.title,
    disabled: opts.disabled === true,
    onClick: opts.onClick,
  })
  if (opts.icon !== undefined) node.append(el('span', { class: 'dsh-og-btn-icon' }, icon(opts.icon)))
  if (label !== undefined && label !== null && label !== '') node.append(document.createTextNode(String(label)))
  return node
}

/** A small square icon-only button, as the row hover actions use. */
function iconButton(name, options) {
  const opts = options ?? {}
  return el('button', {
    type: 'button',
    class: 'dsh-og-file-act',
    title: opts.title,
    'aria-label': opts.title,
    disabled: opts.disabled === true,
    onClick: opts.onClick,
  }, icon(name))
}

/** A text input. */
function input(options) {
  const opts = options ?? {}
  return el('input', {
    class: 'dsh-og-input',
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder,
    title: opts.title,
    readonly: opts.readonly === true,
    disabled: opts.disabled === true,
    maxlength: opts.maxLength,
    style: opts.width === undefined ? undefined : { width: typeof opts.width === 'number' ? opts.width + 'px' : opts.width },
    onInput: opts.onInput,
    onChange: opts.onChange,
    onKeydown: opts.onKeydown,
  })
}

/** A textarea. */
function textarea(options) {
  const opts = options ?? {}
  const node = el('textarea', {
    class: 'dsh-og-textarea',
    placeholder: opts.placeholder,
    rows: opts.rows ?? 4,
    maxlength: opts.maxLength,
    disabled: opts.disabled === true,
    onInput: opts.onInput,
    onKeydown: opts.onKeydown,
  })
  node.value = opts.value ?? ''
  return node
}

/** A select. `options` is `[{id, label, disabled?}]` or `[string]`. */
function select(options) {
  const opts = options ?? {}
  const node = el('select', {
    class: 'dsh-og-select',
    title: opts.title,
    disabled: opts.disabled === true,
    style: opts.width === undefined ? undefined : { width: typeof opts.width === 'number' ? opts.width + 'px' : opts.width },
    onChange: (event) => {
      if (opts.onChange !== undefined) opts.onChange(event.target.value)
    },
  })
  for (const row of opts.options ?? []) {
    const id = typeof row === 'string' ? row : row.id
    const label = typeof row === 'string' ? row : (row.label ?? row.id)
    node.append(el('option', { value: id, disabled: row.disabled === true }, label))
  }
  node.value = opts.value ?? ''
  return node
}

/** A checkbox with a label. */
function checkbox(label, options) {
  const opts = options ?? {}
  const box = el('input', {
    type: 'checkbox',
    disabled: opts.disabled === true,
    onChange: (event) => {
      if (opts.onChange !== undefined) opts.onChange(event.target.checked)
    },
  })
  box.checked = opts.checked === true
  if (opts.indeterminate === true) box.indeterminate = true
  return el('label', { class: 'dsh-og-check', title: opts.title }, box, label)
}

/** A pill tag. `tone` is info | success | warning | danger | primary. */
function tag(label, tone, options) {
  const opts = options ?? {}
  return el('span', {
    class: 'dsh-og-tag',
    'data-tone': tone,
    'data-clickable': opts.onClick !== undefined ? 'true' : undefined,
    title: opts.title,
    onClick: opts.onClick,
  }, label)
}

/** A labelled form field. */
function field(label, control, hint) {
  return el('div', { class: 'dsh-og-field' },
    label === undefined ? undefined : el('label', { class: 'dsh-og-field-label' }, label),
    control,
    hint === undefined ? undefined : el('div', { class: 'dsh-og-field-hint' }, hint))
}

/** An inline alert box. */
function alertBox(tone, title, description) {
  return el('div', { class: 'dsh-og-alert', 'data-tone': tone },
    title === undefined ? undefined : el('div', { class: 'dsh-og-alert-title' }, title),
    description === undefined ? undefined : el('div', {}, description))
}

/** An empty state. */
function emptyState(text, hint) {
  return el('div', { class: 'dsh-og-empty' },
    el('div', { class: 'dsh-og-empty-icon' }, icon('inbox', 32)),
    el('div', {}, text),
    hint === undefined ? undefined : el('div', { style: { 'font-size': '11px' } }, hint))
}

// ------------------------------------------------------------------- toast
let toastWrap = null

/** A transient message. `kind` is error | success | warning | info. */
function toast(message, kind, timeoutMs) {
  if (typeof document === 'undefined') return
  if (toastWrap === null || !toastWrap.isConnected) {
    toastWrap = el('div', { class: 'dsh-og-toast-wrap', 'aria-live': 'polite', role: 'status' })
    document.body.append(toastWrap)
  }
  const item = el('div', { class: 'dsh-og-toast', 'data-kind': kind ?? 'info' }, String(message))
  toastWrap.append(item)
  setTimeout(() => {
    try {
      item.remove()
    } catch { /* already gone */ }
  }, typeof timeoutMs === 'number' ? timeoutMs : 3600)
}

/** Report a failure with the host's code localized. */
function toastError(error) {
  toast(friendlyError(error), 'error', 5200)
}

// ----------------------------------------------------------------- overlays
/**
 * Open one overlay. `build(close)` returns the inner element; the returned handle
 * has `.close()` and `.body` for callers that re-render in place.
 */
function openOverlay(build, options) {
  const opts = options ?? {}
  const backdrop = el('div', {
    class: 'dsh-og-overlay',
    'data-drawer': opts.drawer === true ? 'true' : undefined,
    onMousedown: (event) => {
      // Only a click on the backdrop itself closes; a drag that started inside
      // the dialog and ended outside must not.
      if (event.target === backdrop && opts.dismissable !== false) handle.close()
    },
  })
  const handle = {
    body: undefined,
    close() {
      const index = overlays.indexOf(handle)
      if (index >= 0) overlays.splice(index, 1)
      try {
        backdrop.remove()
      } catch { /* already gone */ }
      if (opts.onClose !== undefined) opts.onClose()
    },
  }
  const inner = build(handle)
  backdrop.append(inner)
  document.body.append(backdrop)
  overlays.push(handle)
  const focusTarget = inner.querySelector('input, textarea, select, button')
  if (focusTarget !== null) {
    try {
      focusTarget.focus()
    } catch { /* not focusable after all */ }
  }
  return handle
}

/** Close every overlay (panel teardown). */
function closeAllOverlays() {
  while (overlays.length > 0) overlays[overlays.length - 1].close()
}

/**
 * A dialog. `build(handle)` fills the body; `footer(handle)` returns the buttons.
 * `width` is default | wide | xwide.
 */
function openDialog(options) {
  return openOverlay((handle) => {
    const body = el('div', { class: 'dsh-og-dialog-body' })
    const foot = el('div', { class: 'dsh-og-dialog-foot' })
    const dialog = el('div', {
      class: 'dsh-og-dialog',
      'data-width': options.width,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': options.title,
    },
    el('div', { class: 'dsh-og-dialog-head' },
      el('div', { class: 'dsh-og-dialog-title' }, options.title),
      options.closable === false ? undefined : iconButton('close', { title: '关闭', onClick: () => handle.close() })),
    body,
    foot)
    handle.body = body
    handle.foot = foot
    handle.render = () => {
      fill(body, options.build(handle))
      fill(foot, options.footer === undefined ? undefined : options.footer(handle))
    }
    handle.render()
    return dialog
  }, { dismissable: options.dismissable, onClose: options.onClose })
}

/** A right-side drawer, as the reference's stash panel is. */
function openDrawer(options) {
  return openOverlay((handle) => {
    const body = el('div', { class: 'dsh-og-dialog-body' })
    const drawer = el('div', { class: 'dsh-og-drawer', role: 'dialog', 'aria-label': options.title },
      el('div', { class: 'dsh-og-dialog-head' },
        el('div', { class: 'dsh-og-dialog-title' }, options.title),
        options.head === undefined ? undefined : options.head(handle),
        iconButton('close', { title: '关闭', onClick: () => handle.close() })),
      body)
    handle.body = body
    handle.render = () => fill(body, options.build(handle))
    handle.render()
    return drawer
  }, { drawer: true, onClose: options.onClose })
}

/**
 * A confirmation box, resolving true/false. `tone` colours the confirm button, so
 * a hard reset reads as dangerous the way the reference's does.
 */
function confirmBox(options) {
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    openDialog({
      title: options.title,
      width: options.width,
      build: () => [
        options.alert === undefined ? undefined : alertBox(options.alert.tone, options.alert.title, options.alert.description),
        el('div', { style: { 'margin-top': options.alert === undefined ? '0' : '10px', 'line-height': '1.7', 'word-break': 'break-word' } },
          options.message),
      ],
      footer: (handle) => [
        button(options.cancelText ?? '取消', {
          onClick: () => {
            finish(false)
            handle.close()
          },
        }),
        button(options.confirmText ?? '确定', {
          kind: options.tone ?? 'primary',
          onClick: () => {
            finish(true)
            handle.close()
          },
        }),
      ],
      onClose: () => finish(false),
    })
  })
}

/** A single-line prompt, resolving the trimmed string or undefined. */
function promptBox(options) {
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    const control = input({
      value: options.value ?? '',
      placeholder: options.placeholder,
      onKeydown: (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submit()
      },
    })
    let handleRef
    const submit = () => {
      const value = control.value.trim()
      if (value.length === 0) {
        toast(options.emptyMessage ?? '不能为空', 'warning')
        return
      }
      finish(value)
      handleRef.close()
    }
    handleRef = openDialog({
      title: options.title,
      build: () => [
        options.message === undefined ? undefined : el('div', { style: { 'margin-bottom': '10px' } }, options.message),
        control,
      ],
      footer: (handle) => [
        button('取消', {
          onClick: () => {
            finish(undefined)
            handle.close()
          },
        }),
        button('确定', { kind: 'primary', onClick: submit }),
      ],
      onClose: () => finish(undefined),
    })
  })
}

// -------------------------------------------------------------------- menus
let openMenu = null

/**
 * A floating menu, used for both the context menus and the dropdown buttons.
 * `items` is `[{label, tone?, disabled?, onClick} | 'sep' | {head}]`.
 *
 * Position is clamped to the viewport before the first paint, so a right-click
 * near the bottom edge does not open a menu half off-screen.
 */
function showMenu(x, y, items, options) {
  closeMenu()
  const opts = options ?? {}
  const menu = el('div', { class: 'dsh-og-menu', role: 'menu' })
  for (const row of items) {
    if (row === undefined || row === null || row === false) continue
    if (row === 'sep') {
      menu.append(el('div', { class: 'dsh-og-menu-sep' }))
      continue
    }
    if (row.head !== undefined) {
      menu.append(el('div', { class: 'dsh-og-menu-head' }, row.head))
      continue
    }
    menu.append(el('div', {
      class: 'dsh-og-menu-item',
      role: 'menuitem',
      'data-tone': row.tone,
      'data-disabled': row.disabled === true ? 'true' : undefined,
      onClick: () => {
        closeMenu()
        if (row.onClick !== undefined) row.onClick()
      },
    }, row.icon === undefined ? undefined : el('span', { class: 'dsh-og-btn-icon' }, icon(row.icon)), row.label))
  }
  // Measured off-screen first: a menu's height depends on how many items it got.
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  document.body.append(menu)
  const rect = menu.getBoundingClientRect()
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))
  const top = opts.above === true
    ? Math.max(4, y - rect.height)
    : Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))
  menu.style.left = left + 'px'
  menu.style.top = top + 'px'
  openMenu = menu
  return menu
}

function closeMenu() {
  if (openMenu !== null) {
    try {
      openMenu.remove()
    } catch { /* already gone */ }
    openMenu = null
  }
}

/** Open a menu anchored under an element (a dropdown button). */
function menuUnder(anchor, items) {
  const rect = anchor.getBoundingClientRect()
  return showMenu(rect.left, rect.bottom + 4, items)
}

/** A progress bar. */
function progressBar(percent, status) {
  const track = el('div', { class: 'dsh-og-progress', 'data-status': status })
  const bar = el('div', { class: 'dsh-og-progress-bar' })
  bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%'
  track.append(bar)
  return track
}

/** A table. `columns` is `[{key, label, width?, align?, render?}]`. */
function table(columns, rows, options) {
  const opts = options ?? {}
  const head = el('tr')
  for (const column of columns) {
    head.append(el('th', {
      style: {
        width: column.width === undefined ? undefined : (typeof column.width === 'number' ? column.width + 'px' : column.width),
        'text-align': column.align,
      },
      class: column.headClass,
    }, column.label))
  }
  const body = el('tbody')
  for (const row of rows) {
    const tr = el('tr', {
      'data-clickable': opts.onRowClick === undefined ? undefined : 'true',
      'data-active': opts.isActive !== undefined && opts.isActive(row) ? 'true' : undefined,
      'data-selected': opts.isSelected !== undefined && opts.isSelected(row) ? 'true' : undefined,
      onClick: opts.onRowClick === undefined ? undefined : (event) => opts.onRowClick(row, event),
      onContextmenu: opts.onRowMenu === undefined ? undefined : (event) => {
        event.preventDefault()
        event.stopPropagation()
        opts.onRowMenu(row, event)
      },
    })
    for (const column of columns) {
      tr.append(el('td', {
        class: column.cellClass,
        style: { 'text-align': column.align },
      }, column.render === undefined ? String(row[column.key] ?? '') : column.render(row)))
    }
    body.append(tr)
  }
  return el('table', { class: 'dsh-og-table' }, el('thead', {}, head), body)
}
