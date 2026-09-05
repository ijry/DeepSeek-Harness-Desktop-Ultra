/**
 * Widgets: the buttons, tags, context menus, dialogs and toasts the panel is built
 * from.
 *
 * The reference had Element Plus for all of this (`el-button`, `el-dropdown`,
 * `el-dialog`, `ElMessage`, `ElMessageBox`). A dsh client bundle ships no component
 * library, so each one is re-implemented here at the size the panel actually uses —
 * which is why the dialogs are promises rather than a component tree: every call
 * site in the reference was `await ElMessageBox.confirm(...)`.
 */

/** One button. */
function button(options) {
  const node = el('button', {
    type: 'button',
    class: 'dsh-ot-btn',
    'data-variant': options.variant,
    'data-icon': options.iconOnly === true ? 'true' : undefined,
    'data-active': options.active === true ? 'true' : undefined,
    title: options.title ?? (options.iconOnly === true ? options.label : undefined),
    'aria-label': options.iconOnly === true ? (options.title ?? options.label) : undefined,
    disabled: options.disabled === true,
    onClick: options.onClick,
  })
  if (options.icon !== undefined) node.append(icon(options.icon, options.iconSize ?? 15))
  if (options.iconOnly !== true && options.label !== undefined) node.append(el('span', {}, options.label))
  if (options.badge !== undefined && options.badge !== null && options.badge !== 0) {
    node.append(el('span', { class: 'dsh-ot-badge' }, String(options.badge)))
  }
  return node
}

/** A square icon-only button. */
function iconButton(name, options) {
  return button({ ...options, icon: name, iconOnly: true })
}

/** A coloured pill. */
function tag(label, tone, options) {
  return el('span', {
    class: 'dsh-ot-tag',
    'data-tone': tone,
    title: options?.title,
    onClick: options?.onClick,
    style: options?.onClick === undefined ? undefined : { cursor: 'pointer' },
  }, label)
}

/** A labelled form row. */
function field(label, control, hint) {
  return el('div', { class: 'dsh-ot-field' },
    label === undefined ? undefined : el('label', {}, label),
    control,
    hint === undefined ? undefined : el('div', { class: 'dsh-ot-field-hint' }, hint))
}

/** A text input. */
function input(options) {
  return el('input', {
    class: 'dsh-ot-input',
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder,
    autocomplete: options.type === 'password' ? 'new-password' : 'off',
    spellcheck: 'false',
    min: options.min,
    max: options.max,
    disabled: options.disabled === true,
    onInput: options.onInput,
    onKeydown: options.onKeydown,
    onChange: options.onChange,
  })
}

/** A textarea. */
function textarea(options) {
  const node = el('textarea', {
    class: 'dsh-ot-textarea',
    placeholder: options.placeholder,
    rows: options.rows ?? 4,
    spellcheck: 'false',
    onInput: options.onInput,
  })
  node.value = options.value ?? ''
  return node
}

/** A checkbox row. */
function checkbox(label, checked, onChange) {
  const box = el('input', { type: 'checkbox', onChange: (event) => onChange(event.target.checked) })
  box.checked = checked === true
  return el('label', { class: 'dsh-ot-check' }, box, el('span', {}, label))
}

/** A radio group rendered as a row of labelled radios. */
function radioGroup(name, options, value, onChange) {
  return el('div', { class: 'dsh-ot-row', style: { gap: '14px' } }, ...options.map((option) => {
    const dot = el('input', { type: 'radio', name, value: option.id, onChange: () => onChange(option.id) })
    dot.checked = option.id === value
    return el('label', { class: 'dsh-ot-check' }, dot, el('span', {}, option.label))
  }))
}

/** A select. */
function select(options, value, onChange) {
  const node = el('select', { class: 'dsh-ot-select', onChange: (event) => onChange(event.target.value) })
  for (const option of options) {
    const item = el('option', { value: option.id }, option.label)
    if (option.id === value) item.selected = true
    node.append(item)
  }
  return node
}

/** A determinate progress bar. */
function progressBar(percent, state) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  return el('div', { class: 'dsh-ot-progress', 'data-state': state }, el('span', { style: { width: value + '%' } }))
}

// ------------------------------------------------------------------ toasts
let toastHost = null

/** Show a transient message. */
function toast(message, tone, ms) {
  if (typeof document === 'undefined') return
  if (toastHost === null || !toastHost.isConnected) {
    toastHost = el('div', { class: 'dsh-ot-toasts dsh-ot-overlay-tokens' })
    document.body.append(toastHost)
  }
  const node = el('div', { class: 'dsh-ot-toast', 'data-tone': tone }, String(message))
  toastHost.append(node)
  const timer = setTimeout(() => node.remove(), ms ?? (tone === 'error' ? 6000 : 2600))
  node.addEventListener('click', () => {
    clearTimeout(timer)
    node.remove()
  })
}

/** Report a rejected request. */
function toastError(error) {
  toast(friendlyError(error), 'error')
}

// ------------------------------------------------------------------- menus
let openMenu = null

/** Close the context menu. */
function closeMenu() {
  if (openMenu === null) return
  openMenu.remove()
  openMenu = null
}

/**
 * Open a context menu at a point. `items` are `{label, icon, tone, disabled, onClick}`
 * or `{separator: true}`.
 *
 * Positioning clamps to the viewport, the way the reference's hand-rolled menu did:
 * a right-click near the bottom edge must not open a menu that runs off screen.
 */
function openContextMenu(x, y, items, title) {
  closeMenu()
  const menu = el('div', { class: 'dsh-ot-menu dsh-ot-overlay', role: 'menu' })
  if (title !== undefined) menu.append(el('div', { class: 'dsh-ot-menu-title' }, title))
  for (const item of items) {
    if (item === undefined || item === null || item === false) continue
    if (item.separator === true) {
      menu.append(el('div', { class: 'dsh-ot-menu-sep' }))
      continue
    }
    menu.append(el('button', {
      type: 'button',
      class: 'dsh-ot-menu-item',
      'data-tone': item.tone,
      disabled: item.disabled === true,
      onClick: () => {
        closeMenu()
        try {
          item.onClick()
        } catch (error) {
          toastError(error)
        }
      },
    }, item.icon === undefined ? undefined : icon(item.icon, 14), el('span', {}, item.label)))
  }
  // Measured off-screen first, then clamped: the height depends on the item count.
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  const width = box.width > 0 ? box.width : 200
  const height = box.height > 0 ? box.height : 240
  const maxX = Math.max(8, (window.innerWidth ?? 1024) - width - 8)
  const maxY = Math.max(8, (window.innerHeight ?? 768) - height - 8)
  menu.style.left = Math.min(Math.max(8, x), maxX) + 'px'
  menu.style.top = Math.min(Math.max(8, y), maxY) + 'px'
  openMenu = menu
  return menu
}

// ----------------------------------------------------------------- dialogs
const overlays = []

/**
 * Open a modal. `build(close)` returns the body; `footer(close)` the buttons.
 * Returns `{close}`.
 */
function openDialog(options) {
  const overlay = el('div', { class: 'dsh-ot-overlay' })
  const record = { overlay, close: null }
  const close = (result) => {
    const index = overlays.indexOf(record)
    if (index !== -1) overlays.splice(index, 1)
    overlay.remove()
    if (options.onClose !== undefined) options.onClose(result)
  }
  record.close = close
  const body = el('div', { class: 'dsh-ot-dialog-body' })
  appendAll(body, [options.build(close)])
  const dialog = el('div', { class: 'dsh-ot-dialog', 'data-size': options.size, role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'dsh-ot-dialog-head' },
      el('span', {}, options.title),
      iconButton('close', { variant: 'ghost', title: t('main.close'), onClick: () => close(undefined) })),
    body,
    options.footer === undefined ? undefined : el('div', { class: 'dsh-ot-dialog-foot' }, options.footer(close)))
  overlay.append(dialog)
  overlay.addEventListener('mousedown', (event) => {
    // A click on the backdrop closes; a drag that started inside must not.
    if (event.target === overlay && options.dismissable !== false) close(undefined)
  })
  document.body.append(overlay)
  overlays.push(record)
  const focusTarget = dialog.querySelector('input, textarea, select, button')
  if (focusTarget !== null) {
    try {
      focusTarget.focus()
    } catch { /* not focusable yet */ }
  }
  return record
}

/** Close every open dialog (panel teardown). */
function closeAllOverlays() {
  for (const record of [...overlays]) record.close(undefined)
}

/** A yes/no question. Resolves true when confirmed. */
function confirmDialog(options) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    openDialog({
      title: options.title,
      size: 'small',
      build: () => [
        el('div', {}, options.message),
        options.detail === undefined ? undefined : el('div', { class: 'dsh-ot-field-hint' }, options.detail),
      ],
      footer: (close) => [
        button({ label: options.cancelLabel ?? t('main.cancel'), onClick: () => close(false) }),
        button({
          label: options.confirmLabel ?? t('main.confirm'),
          variant: options.danger === true ? 'danger' : 'primary',
          onClick: () => close(true),
        }),
      ],
      onClose: (value) => finish(value === true),
    })
  })
}

/** A one-line text prompt. Resolves the trimmed value, or undefined when cancelled. */
function promptDialog(options) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    let box
    const submit = (close) => {
      const value = String(box.value ?? '').trim()
      if (value.length === 0) {
        toast(options.required ?? t('sftp.promptNameRequired'), 'warning')
        return
      }
      close(value)
    }
    openDialog({
      title: options.title,
      size: 'small',
      build: (close) => {
        box = input({
          value: options.value ?? '',
          placeholder: options.placeholder,
          onKeydown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit(close)
            }
          },
        })
        return [field(options.label, box, options.hint)]
      },
      footer: (close) => [
        button({ label: t('main.cancel'), onClick: () => close(undefined) }),
        button({ label: options.confirmLabel ?? t('main.confirm'), variant: 'primary', onClick: () => submit(close) }),
      ],
      onClose: (value) => finish(typeof value === 'string' ? value : undefined),
    })
  })
}

/** A section box with a heading and actions. */
function section(title, actions, ...children) {
  return el('div', { class: 'dsh-ot-section' },
    el('div', { class: 'dsh-ot-section-head' },
      el('span', { class: 'dsh-ot-section-title' }, title),
      el('div', { class: 'dsh-ot-toolbar-group' }, actions)),
    ...children)
}
