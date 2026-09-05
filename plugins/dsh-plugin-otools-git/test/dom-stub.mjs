/**
 * A minimal synthetic DOM, enough to run the client bundle in `node --test`.
 *
 * Deliberately hand-rolled rather than jsdom: this package has no dependencies,
 * and the panel uses a small, fixed slice of the DOM API. What is implemented is
 * exactly what the bundle touches — if the panel starts using something new, the
 * test fails loudly here instead of silently passing on a stub.
 *
 * Selector support is intentionally narrow: tag, `.class`, `#id`, `[attr]`,
 * `[attr="value"]`, `[class*="value"]`, one tag+qualifier combination, and
 * comma-separated lists of those. No descendant combinators — the bundle does
 * not use any.
 *
 * @module dsh-plugin-otools-git/test/dom-stub
 */

/**
 * The `Node` base the bundle's `instanceof` checks look for. Real browsers give
 * it for free; here it has to exist so `el()` can tell a node from a plain
 * attribute object.
 */
class Node {}

/** One element. */
class El extends Node {
  constructor(tag, namespace) {
    super()
    this.tagName = String(tag).toUpperCase()
    this.localName = String(tag)
    this.namespaceURI = namespace
    this.attributes = new Map()
    this.childNodes = []
    this.parentElement = null
    this.listeners = new Map()
    this.style = makeStyle()
    this.dataset = makeDataset(this)
    this.value = ''
    this.checked = false
    this.indeterminate = false
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.clientWidth = 800
    this.selectionStart = 0
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof El)
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get isConnected() {
    let node = this
    while (node.parentElement !== null) node = node.parentElement
    return node.__isRoot === true
  }

  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  /** `element.id = x` must reach the attribute — injectStyles assigns it. */
  get id() {
    return this.attributes.get('id') ?? ''
  }

  set id(value) {
    this.attributes.set('id', String(value))
  }

  get classList() {
    const self = this
    return {
      add(...names) {
        const set = new Set(self.className.split(/\s+/).filter((name) => name.length > 0))
        for (const name of names) set.add(name)
        self.className = [...set].join(' ')
      },
      remove(...names) {
        const set = new Set(self.className.split(/\s+/).filter((name) => name.length > 0))
        for (const name of names) set.delete(name)
        self.className = [...set].join(' ')
      },
      contains(name) {
        return self.className.split(/\s+/).includes(name)
      },
    }
  }

  get textContent() {
    return this.childNodes.map((node) => (node instanceof El ? node.textContent : node.data)).join('')
  }

  set textContent(value) {
    this.childNodes = []
    if (value !== '' && value !== null && value !== undefined) this.append(new TextNode(String(value)))
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof El || node instanceof TextNode ? node : new TextNode(String(node))
      if (child.parentElement !== null) child.parentElement.removeChild(child)
      child.parentElement = this
      this.childNodes.push(child)
    }
  }

  insertBefore(node, reference) {
    if (reference === null || reference === undefined) {
      this.append(node)
      return node
    }
    const index = this.childNodes.indexOf(reference)
    if (node.parentElement !== null) node.parentElement.removeChild(node)
    node.parentElement = this
    this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node)
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentElement = null
    return node
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.parentElement = null
    this.childNodes = []
    this.append(...nodes)
  }

  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this)
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }

  /** Dispatch synchronously, bubbling to the parents like a real event would. */
  dispatchEvent(event) {
    const payload = {
      preventDefault() {},
      stopPropagation() {},
      ...event,
      target: event.target ?? this,
      currentTarget: this,
    }
    let node = this
    let stopped = false
    payload.stopPropagation = () => {
      stopped = true
    }
    while (node !== null && !stopped) {
      payload.currentTarget = node
      for (const handler of [...(node.listeners.get(payload.type) ?? [])]) handler(payload)
      node = node.parentElement
    }
    return true
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (node instanceof El && matchesSelector(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }
  }

  focus() {}
  blur() {}
  setPointerCapture() {}
  releasePointerCapture() {}
}

/** A text node. */
class TextNode extends Node {
  constructor(data) {
    super()
    this.data = String(data)
    this.parentElement = null
  }

  get textContent() {
    return this.data
  }
}

/** `element.style` with the setProperty the bundle uses. */
function makeStyle() {
  const store = {}
  return new Proxy(store, {
    get(target, key) {
      if (key === 'setProperty') {
        return (name, value) => {
          target[name] = String(value)
        }
      }
      if (key === 'removeProperty') {
        return (name) => {
          delete target[name]
        }
      }
      return target[key] ?? ''
    },
    set(target, key, value) {
      target[key] = String(value)
      return true
    },
  })
}

/** `element.dataset`, mapped onto data-* attributes. */
function makeDataset(element) {
  const toAttr = (key) => 'data-' + String(key).replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())
  return new Proxy({}, {
    get(_target, key) {
      const value = element.attributes.get(toAttr(key))
      return value === undefined ? undefined : value
    },
    set(_target, key, value) {
      element.attributes.set(toAttr(key), String(value))
      return true
    },
    deleteProperty(_target, key) {
      element.attributes.delete(toAttr(key))
      return true
    },
    has(_target, key) {
      return element.attributes.has(toAttr(key))
    },
  })
}

/** Match one element against one simple selector (see the module header). */
function matchesSelector(element, selector) {
  for (const part of String(selector).split(',')) {
    if (matchesSimple(element, part.trim())) return true
  }
  return false
}

/** One comma-free selector. */
function matchesSimple(element, selector) {
  if (selector.length === 0) return false
  // Split into the leading tag (if any) and the trailing qualifiers.
  const match = selector.match(/^([a-zA-Z][\w-]*)?(.*)$/)
  const tag = match[1]
  let rest = match[2] ?? ''
  if (tag !== undefined && element.localName.toLowerCase() !== tag.toLowerCase()) return false

  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const name = rest.slice(1).match(/^[\w-]+/)
      if (name === null) return false
      if (!element.classList.contains(name[0])) return false
      rest = rest.slice(1 + name[0].length)
      continue
    }
    if (rest.startsWith('#')) {
      const name = rest.slice(1).match(/^[\w-]+/)
      if (name === null) return false
      if (element.getAttribute('id') !== name[0]) return false
      rest = rest.slice(1 + name[0].length)
      continue
    }
    if (rest.startsWith('[')) {
      const end = rest.indexOf(']')
      if (end === -1) return false
      const body = rest.slice(1, end)
      rest = rest.slice(end + 1)
      const attrMatch = body.match(/^([\w-]+)(?:(\*?=)"?([^"]*)"?)?$/)
      if (attrMatch === null) return false
      const [, name, operator, value] = attrMatch
      const actual = element.getAttribute(name)
      if (operator === undefined) {
        if (actual === null) return false
        continue
      }
      if (actual === null) return false
      if (operator === '*=' ? !actual.includes(value) : actual !== value) return false
      continue
    }
    // Anything else (a combinator, a pseudo-class) is out of scope on purpose.
    return false
  }
  return true
}

/**
 * Build a document that looks like the DSH web shell: a sidebar column with a
 * logo row, and a conversation column the panel takes over.
 */
export function installDom(options) {
  const html = new El('html')
  html.__isRoot = true
  const head = new El('head')
  const body = new El('body')
  html.append(head, body)

  const sidebar = new El('div')
  sidebar.setAttribute('data-pane', 'sidebar')
  const sidebarInner = new El('div')
  const logoRow = new El('div')
  logoRow.setAttribute('class', 'logoRow_x1')
  sidebarInner.append(logoRow)
  sidebar.append(sidebarInner)

  const conversation = new El('div')
  conversation.setAttribute('data-pane', 'conversation')
  const existing = new El('div')
  existing.setAttribute('class', 'someExistingChild')
  conversation.append(existing)

  body.append(sidebar, conversation)

  const document = {
    documentElement: html,
    head,
    body,
    listeners: new Map(),
    createElement(tag) {
      return new El(tag)
    },
    createElementNS(namespace, tag) {
      return new El(tag, namespace)
    },
    createTextNode(data) {
      return new TextNode(data)
    },
    getElementById(id) {
      return html.querySelectorAll('[id="' + id + '"]')[0] ?? null
    },
    querySelector(selector) {
      return html.querySelector(selector)
    },
    querySelectorAll(selector) {
      return html.querySelectorAll(selector)
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler)
    },
    dispatchEvent(event) {
      const payload = { preventDefault() {}, stopPropagation() {}, ...event, target: event.target ?? html }
      for (const handler of [...(this.listeners.get(payload.type) ?? [])]) handler(payload)
      return true
    },
  }

  const storage = new Map()
  const window = {
    document,
    innerWidth: 1440,
    innerHeight: 900,
    listeners: new Map(),
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    getSelection: () => null,
    requestAnimationFrame: (fn) => {
      setTimeout(fn, 0)
      return 0
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler)
    },
    // A CustomEvent that is just its own detail-carrying payload.
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init === undefined ? undefined : init.detail
      }
    },
    // The panel only ever observes and disconnects; nothing here has to fire.
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    // Never connects, so the panel simply reports "not connected".
    EventSource: class {
      constructor() {
        this.readyState = 0
      }
      addEventListener() {}
      close() {}
    },
    // Relative URLs are resolved against the host server this test started.
    fetch(url, init) {
      const absolute = String(url).startsWith('http') ? String(url) : options.origin + String(url)
      return globalThis.fetch(absolute, init)
    },
  }

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  }
  globalThis.window = window
  globalThis.document = document

  return {
    window,
    document,
    body,
    sidebar,
    conversation,
    // The constructors the bundle's instanceof checks need.
    Node,
    Element: El,
    HTMLElement: El,
    restore() {
      if (previous.window === undefined) delete globalThis.window
      else globalThis.window = previous.window
      if (previous.document === undefined) delete globalThis.document
      else globalThis.document = previous.document
    },
  }
}
