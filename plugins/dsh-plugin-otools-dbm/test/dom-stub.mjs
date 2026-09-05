/**
 * A hand-written DOM stand-in, enough to boot the client bundle for real.
 *
 * Deliberately narrow: what is implemented is exactly what `src/client/index.js`
 * touches. If the client starts using something new, the test fails loudly here
 * instead of passing against a stub that silently returns undefined.
 *
 * Selector support is narrow too — tag, `.class`, `#id`, `[attr]`,
 * `[attr="value"]`, `[class*="value"]`, one tag+qualifier pair, and
 * comma-separated lists of those. No descendant combinators.
 */

class ClassList {
  constructor(owner) {
    this.owner = owner
    this.tokens = new Set()
  }

  add(...names) {
    for (const name of names) {
      this.tokens.add(name)
    }
  }

  remove(...names) {
    for (const name of names) {
      this.tokens.delete(name)
    }
  }

  contains(name) {
    return this.tokens.has(name)
  }

  toggle(name, force) {
    const next = force === undefined ? !this.tokens.has(name) : force === true
    if (next) {
      this.tokens.add(name)
    } else {
      this.tokens.delete(name)
    }
    return next
  }

  toString() {
    return Array.from(this.tokens).join(' ')
  }
}

/** Parse one simple selector into a predicate. */
function compile(selector) {
  const parts = String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const matchers = parts.map((part) => {
    const attribute = /^([a-z0-9-]*)\[([a-zA-Z0-9_-]+)(?:([*^$]?)=\s*"([^"]*)")?\]$/i.exec(part)
    if (attribute !== null) {
      const [, tag, name, operator, value] = attribute
      return (node) => {
        if (tag.length > 0 && node.tagName !== tag.toUpperCase()) {
          return false
        }
        const actual = node.getAttribute(name)
        if (actual === null) {
          return false
        }
        if (value === undefined) {
          return true
        }
        if (operator === '*') {
          return actual.includes(value)
        }
        if (operator === '^') {
          return actual.startsWith(value)
        }
        if (operator === '$') {
          return actual.endsWith(value)
        }
        return actual === value
      }
    }
    if (part.startsWith('.')) {
      const name = part.slice(1)
      return (node) => node.classList.contains(name)
    }
    if (part.startsWith('#')) {
      const id = part.slice(1)
      return (node) => node.id === id
    }
    const tagOnly = /^([a-z0-9-]+)$/i.exec(part)
    if (tagOnly !== null) {
      return (node) => node.tagName === tagOnly[1].toUpperCase()
    }
    // Unsupported selector: never matches, but does not throw — the client tries
    // several layout generations' selectors on purpose.
    return () => false
  })
  return (node) => matchers.some((matcher) => matcher(node))
}

class StubNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentElement = null
    this.classList = new ClassList(this)
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.listeners = new Map()
    this.id = ''
    this.textContent = ''
    this.innerHTMLValue = ''
    this.src = ''
    this.type = ''
    this.title = ''
  }

  get className() {
    return this.classList.toString()
  }

  set className(value) {
    this.classList.tokens = new Set(
      String(value)
        .split(/\s+/)
        .filter((token) => token.length > 0),
    )
  }

  get innerHTML() {
    return this.innerHTMLValue
  }

  set innerHTML(value) {
    this.innerHTMLValue = String(value)
  }

  get isConnected() {
    let node = this
    while (node.parentElement !== null) {
      node = node.parentElement
    }
    return node === this.ownerDocument?.documentElement || node.tagName === 'HTML'
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get nextElementSibling() {
    if (this.parentElement === null) {
      return null
    }
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] ?? null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') {
      this.className = value
    }
    if (name.startsWith('data-')) {
      this.dataset[camel(name.slice(5))] = String(value)
    }
  }

  getAttribute(name) {
    if (name === 'class') {
      const text = this.classList.toString()
      return text.length === 0 ? null : text
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null
  }

  removeAttribute(name) {
    this.attributes.delete(name)
    if (name.startsWith('data-')) {
      delete this.dataset[camel(name.slice(5))]
    }
  }

  appendChild(child) {
    child.parentElement?.removeChild(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }

  insertBefore(child, reference) {
    child.parentElement?.removeChild(child)
    child.parentElement = this
    const index = reference === null || reference === undefined ? -1 : this.children.indexOf(reference)
    if (index === -1) {
      this.children.push(child)
    } else {
      this.children.splice(index, 0, child)
    }
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) {
      this.children.splice(index, 1)
      child.parentElement = null
    }
    return child
  }

  remove() {
    this.parentElement?.removeChild(this)
  }

  replaceChildren(...nodes) {
    for (const child of this.children.slice()) {
      child.parentElement = null
    }
    this.children = []
    for (const node of nodes) {
      this.appendChild(node)
    }
  }

  matches(selector) {
    return compile(selector)(this)
  }

  closest(selector) {
    const predicate = compile(selector)
    let node = this
    while (node !== null) {
      if (predicate(node)) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const predicate = compile(selector)
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (predicate(child)) {
          found.push(child)
        }
        walk(child)
      }
    }
    walk(this)
    return found
  }

  addEventListener(type, handler) {
    const bucket = this.listeners.get(type) ?? new Set()
    bucket.add(handler)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event) {
    let node = this
    while (node !== null) {
      for (const handler of Array.from(node.listeners.get(event.type) ?? [])) {
        handler.call(node, event)
      }
      node = node.parentElement
    }
    return true
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this })
  }
}

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

/**
 * Build a document shaped like the DSH web shell: a sidebar column with a logo row
 * and a conversation column with one existing child.
 */
export function installDom(options = {}) {
  const observers = new Set()

  const document_ = {
    /**
     * Fire every observer once.
     *
     * NOT called from appendChild the way a real MutationObserver would be: the
     * client's observer callback mounts nodes, so a synchronous notify-on-mutation
     * recurses forever. The real thing is async and batched; here a test asks for a
     * repaint explicitly through `fireRepaint()`.
     */
    notify() {
      for (const observer of Array.from(observers)) {
        observer.fire()
      }
    },
    createElement(tag) {
      return new StubNode(tag, document_)
    },
    createTextNode(text) {
      const node = new StubNode('#text', document_)
      node.textContent = String(text)
      return node
    },
    listeners: new Map(),
    addEventListener(type, handler) {
      const bucket = document_.listeners.get(type) ?? new Set()
      bucket.add(handler)
      document_.listeners.set(type, bucket)
    },
    removeEventListener(type, handler) {
      document_.listeners.get(type)?.delete(handler)
    },
    dispatchEvent(event) {
      for (const handler of Array.from(document_.listeners.get(event.type) ?? [])) {
        handler(event)
      }
      return true
    },
    getElementById(id) {
      return document_.documentElement.querySelectorAll(`#${id}`)[0] ?? null
    },
    querySelector(selector) {
      return document_.documentElement.querySelector(selector)
    },
    querySelectorAll(selector) {
      return document_.documentElement.querySelectorAll(selector)
    },
  }

  const html = new StubNode('html', document_)
  const head = new StubNode('head', document_)
  const body = new StubNode('body', document_)
  html.appendChild(head)
  html.appendChild(body)
  document_.documentElement = html
  document_.head = head
  document_.body = body
  document_.activeElement = body

  const sidebar = new StubNode('div', document_)
  sidebar.setAttribute('data-pane', 'sidebar')
  const sidebarInner = new StubNode('div', document_)
  const logoRow = new StubNode('div', document_)
  logoRow.className = 'logoRow_x1'
  sidebarInner.appendChild(logoRow)
  sidebar.appendChild(sidebarInner)
  body.appendChild(sidebar)

  const conversation = new StubNode('div', document_)
  conversation.setAttribute('data-pane', 'conversation')
  const existing = new StubNode('div', document_)
  existing.className = 'someExistingChild'
  conversation.appendChild(existing)
  body.appendChild(conversation)

  class StubMutationObserver {
    constructor(callback) {
      this.callback = callback
      observers.add(this)
    }

    observe() {}

    disconnect() {
      observers.delete(this)
    }

    fire() {
      // Synchronous, unlike the real thing: a test wants the effect of a repaint
      // to be visible on the next line, not on the next microtask.
      this.callback([], this)
    }
  }

  const mediaListeners = new Set()
  const window_ = {
    document: document_,
    location: { search: '' },
    matchMedia(query) {
      return {
        media: query,
        matches: options.prefersDark === true,
        addEventListener(_, handler) {
          mediaListeners.add(handler)
        },
        removeEventListener(_, handler) {
          mediaListeners.delete(handler)
        },
      }
    },
    addEventListener(type, handler) {
      document_.addEventListener(type, handler)
    },
    removeEventListener(type, handler) {
      document_.removeEventListener(type, handler)
    },
    MutationObserver: StubMutationObserver,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: options.fetch ?? (() => Promise.reject(new Error('fetch not stubbed'))),
    getComputedStyle: () => ({
      getPropertyValue: (name) => options.tokens?.[name] ?? '',
    }),
    URLSearchParams,
    fireMediaChange() {
      for (const handler of mediaListeners) {
        handler({ matches: true })
      }
    },
  }

  return {
    window: window_,
    document: document_,
    sidebarRoot: sidebarInner,
    conversation,
    MutationObserver: StubMutationObserver,
    CustomEvent: window_.CustomEvent,
    fireRepaint: () => document_.notify(),
  }
}
