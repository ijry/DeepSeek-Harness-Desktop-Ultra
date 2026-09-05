/**
 * DOM helpers. Everything the panel builds goes through `el`, and every piece of
 * repository text (a path, a branch name, a commit message, a diff line) reaches
 * the page as a TEXT NODE.
 *
 * Security stance: a commit message, a branch name and a diff are attacker
 * controlled — anyone who can get a commit into a repository the user opens
 * writes them. `innerHTML` is therefore used for exactly one thing in this
 * bundle: this plugin's own static icon markup in icons.js. Nothing derived from
 * a repository ever goes near it.
 */

/**
 * Build one element. Attributes go in the second argument (`class`, `style`,
 * `data-*`, aria, and `on<Event>` handlers); children are the rest.
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  if (attrs !== null && attrs !== undefined && typeof attrs === 'object' && !(attrs instanceof Node) &&
      !Array.isArray(attrs) && typeof attrs !== 'string') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
        continue
      }
      if (key === 'style' && typeof value === 'object') {
        for (const [prop, styleValue] of Object.entries(value)) {
          if (styleValue !== undefined && styleValue !== null) node.style.setProperty(prop, String(styleValue))
        }
        continue
      }
      if (value === true) {
        node.setAttribute(key, '')
        continue
      }
      node.setAttribute(key, String(value))
    }
    appendAll(node, children)
    return node
  }
  appendAll(node, [attrs, ...children])
  return node
}

/** Append children, flattening arrays and skipping nullish entries. */
function appendAll(node, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue
    if (Array.isArray(child)) {
      appendAll(node, child)
      continue
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Replace an element's children in one go. */
function fill(node, ...children) {
  if (node === null || node === undefined) return node
  node.replaceChildren()
  appendAll(node, children)
  return node
}

/** An SVG element (createElement would give an unknown HTML element). */
function svg(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (attrs !== null && attrs !== undefined && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
        continue
      }
      node.setAttribute(key, String(value))
    }
  }
  appendAll(node, children)
  return node
}

/** Toggle a data attribute that CSS keys on. */
function setData(node, key, on) {
  if (node === null || node === undefined) return
  if (on) node.dataset[key] = 'true'
  else delete node.dataset[key]
}

/** Read a persisted preference, tolerating a blocked localStorage. */
function storeGet(key, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** Write a persisted preference, tolerating a blocked localStorage. */
function storeSet(key, value) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch { /* private mode, quota, or a policy — not worth reporting */ }
}

/** Debounce a function on a trailing edge. */
function debounce(fn, delayMs) {
  let timer
  return (...args) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn(...args)
    }, delayMs)
  }
}

/**
 * A pointer-driven splitter. Returns the handle element; `onMove` receives the
 * new value in pixels, already clamped.
 *
 * Uses pointer capture so the drag survives the cursor leaving the handle, and
 * sets the body cursor for the duration — without that, a fast drag flickers
 * between the resize cursor and whatever is underneath.
 */
function resizeHandle(options) {
  const axis = options.axis === 'y' ? 'y' : 'x'
  const handle = el('div', {
    class: 'dsh-og-resizer dsh-og-resizer-' + axis,
    role: 'separator',
    'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
  })
  let start = 0
  let base = 0
  let dragging = false

  const clamp = (value) => Math.max(options.min, Math.min(options.max(), value))

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragging = true
    start = axis === 'x' ? event.clientX : event.clientY
    base = options.value()
    handle.setPointerCapture(event.pointerId)
    handle.dataset.dragging = 'true'
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  })
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const delta = (axis === 'x' ? event.clientX : event.clientY) - start
    options.onMove(clamp(base + (options.invert === true ? -delta : delta)))
  })
  const stop = (event) => {
    if (!dragging) return
    dragging = false
    delete handle.dataset.dragging
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    try {
      handle.releasePointerCapture(event.pointerId)
    } catch { /* already released */ }
    if (options.onCommit !== undefined) options.onCommit(options.value())
  }
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
  handle.addEventListener('lostpointercapture', stop)
  if (options.onReset !== undefined) {
    handle.addEventListener('dblclick', () => options.onReset())
  }
  return handle
}
