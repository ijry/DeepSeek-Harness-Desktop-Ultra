/**
 * 一个够用的 DOM 替身：只为在 node:test 里把浏览器半边真的跑起来。
 *
 * 插件是零依赖的，所以这里不引 jsdom，而是手写到刚好能覆盖 client 用到的那些
 * 接口：createElement/append/dataset/classList、closest/matches/querySelector
 * （支持代码里实际用到的那几种选择器形式）、事件派发、rAF、localStorage、
 * fetch 与 EventSource。做不到的地方宁可显式抛错，也不要静默返回 undefined 让
 * 测试通过。
 *
 * 与 dsh-plugin-canvas 的同名替身同源（那边先写的），逐字复制过来而不是抽成共享
 * 包：插件之间零依赖是这个仓库的硬规矩，一份 200 行的测试替身比一个包更便宜。
 *
 * @module dsh-plugin-longread/test/dom-stub
 */

/** 把 `data-foo-bar` 与 `fooBar` 互转。 */
function toAttr(key) {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/** 解析一个简单选择器序列（不含组合器）为判定函数。 */
function simpleMatcher(part) {
  const tests = []
  const rest = part.replace(/\[([^\]]+)\]/g, (_, body) => {
    const exact = /^([\w-]+)="([^"]*)"$/.exec(body)
    const contains = /^([\w-]+)\*="([^"]*)"$/.exec(body)
    if (contains !== null) {
      tests.push((el) => (el.getAttribute(contains[1]) ?? '').includes(contains[2]))
    } else if (exact !== null) {
      tests.push((el) => el.getAttribute(exact[1]) === exact[2])
    } else {
      tests.push((el) => el.getAttribute(body) !== null)
    }
    return ''
  })
  for (const token of rest.split(/(?=[.#])/)) {
    const value = token.trim()
    if (value === '') continue
    if (value.startsWith('.')) tests.push((el) => el.classList.contains(value.slice(1)))
    else if (value.startsWith('#')) tests.push((el) => el.id === value.slice(1))
    else tests.push((el) => el.tagName === value.toUpperCase())
  }
  return (el) => tests.every((fn) => fn(el))
}

/** 只支持逗号分隔、以及 `:scope > X` 这一种组合器——正是 client 用到的形态。 */
function compile(selector) {
  const branches = selector.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return branches.map((branch) => {
    const scoped = /^:scope\s*>\s*(.+)$/.exec(branch)
    if (scoped !== null) return { direct: true, match: simpleMatcher(scoped[1]) }
    if (branch.includes(' ') || branch.includes('>')) {
      // 组合器没实现：出现即报错，而不是悄悄匹配不到。
      throw new Error(`dom-stub: unsupported selector ${branch}`)
    }
    return { direct: false, match: simpleMatcher(branch) }
  })
}

class ClassList {
  constructor(el) {
    this.el = el
  }
  get set() {
    return new Set(String(this.el._class).split(/\s+/).filter((c) => c !== ''))
  }
  contains(name) {
    return this.set.has(name)
  }
  add(...names) {
    const set = this.set
    for (const name of names) set.add(name)
    this.el._class = [...set].join(' ')
  }
  remove(...names) {
    const set = this.set
    for (const name of names) set.delete(name)
    this.el._class = [...set].join(' ')
  }
}

export class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = new Proxy({}, { set: () => true, get: () => '' })
    this.listeners = new Map()
    this._class = ''
    this._text = ''
    this.value = ''
    this.disabled = false
    this.classList = new ClassList(this)
    this.dataset = new Proxy(
      {},
      {
        get: (_, key) => this.attributes.get(toAttr(String(key))),
        set: (_, key, value) => {
          this.attributes.set(toAttr(String(key)), String(value))
          return true
        },
        deleteProperty: (_, key) => this.attributes.delete(toAttr(String(key))) || true,
        has: (_, key) => this.attributes.has(toAttr(String(key))),
      }
    )
  }

  get className() {
    return this._class
  }
  set className(value) {
    this._class = String(value)
  }
  get textContent() {
    return this.children.length === 0 ? this._text : this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) {
    for (const child of this.children) child.parentElement = null
    this.children = []
    this._text = String(value)
  }
  get firstElementChild() {
    return this.children[0] ?? null
  }
  setAttribute(name, value) {
    if (name === 'class') this._class = String(value)
    else this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    if (name === 'class') return this._class
    return this.attributes.get(name) ?? null
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement !== null) node.parentElement.remove(node)
      node.parentElement = this
      this.children.push(node)
    }
  }
  prepend(node) {
    node.parentElement = this
    this.children.unshift(node)
  }
  insertBefore(node, anchor) {
    const index = this.children.indexOf(anchor)
    node.parentElement = this
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
  }
  remove(child) {
    if (child === undefined) {
      if (this.parentElement !== null) this.parentElement.remove(this)
      return
    }
    const index = this.children.indexOf(child)
    if (index >= 0) {
      this.children.splice(index, 1)
      child.parentElement = null
    }
  }
  replaceWith(other) {
    if (this.parentElement === null) return
    const parent = this.parentElement
    const index = parent.children.indexOf(this)
    parent.children.splice(index, 1, other)
    other.parentElement = parent
    this.parentElement = null
  }
  get isConnected() {
    let node = this
    while (node.parentElement !== null) node = node.parentElement
    return node.tagName === 'HTML'
  }
  descendants() {
    const out = []
    for (const child of this.children) {
      out.push(child, ...child.descendants())
    }
    return out
  }
  matches(selector) {
    return compile(selector).some((branch) => branch.match(this))
  }
  closest(selector) {
    const branches = compile(selector)
    let node = this
    while (node !== null) {
      if (branches.some((branch) => branch.match(node))) return node
      node = node.parentElement
    }
    return null
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector) {
    const branches = compile(selector)
    const pool = branches.every((b) => b.direct) ? this.children : this.descendants()
    return pool.filter((el) => branches.some((branch) => branch.match(el)))
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(handler)
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }
  focus() {
    this.ownerDocumentActive = true
  }
  blur() {}
  setSelectionRange() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }
  }
  /** 派发一个事件：先本级，再冒泡到祖先。 */
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
      key: '',
      deltaX: 0,
      deltaY: 0,
      detail: undefined,
      preventDefault() {},
      stopPropagation() {},
      ...init,
    }
    let node = this
    while (node !== null) {
      for (const handler of [...(node.listeners.get(type) ?? [])]) handler.call(node, event)
      node = node.parentElement
    }
    return event
  }
}

/**
 * Build a window/document pair plus the browser APIs the client touches.
 *
 * `routes` maps a path prefix to a JSON value, so a test can hand the board a
 * ledger and a session list without a server.
 */
export function createStubDom(routes = {}) {
  const html = new StubElement('html')
  const head = new StubElement('head')
  const body = new StubElement('body')
  html.append(head, body)

  const store = new Map()
  const calls = []
  const timers = []

  const document = {
    documentElement: html,
    head,
    body,
    activeElement: body,
    createElement: (tag) => new StubElement(tag),
    createEvent: () => ({}),
    getElementById: (id) => html.descendants().find((el) => el.id === id) ?? null,
    querySelector: (selector) => html.querySelector(selector),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    addEventListener: (type, handler) => html.addEventListener(type, handler),
    removeEventListener: (type, handler) => html.removeEventListener(type, handler),
    dispatchEvent: (event) => html.dispatch(event.type, event),
  }

  class StubEventSource {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      calls.push({ kind: 'sse', url })
      window.__lastEventSource = this
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(handler)
    }
    emit(type, data) {
      for (const handler of this.listeners.get(type) ?? []) handler({ data: JSON.stringify(data) })
    }
    close() {
      this.closed = true
    }
  }

  const window = {
    document,
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    requestAnimationFrame: (fn) => {
      timers.push(fn)
      return timers.length
    },
    getSelection: () => ({ removeAllRanges() {} }),
    addEventListener: (type, handler) => html.addEventListener(type, handler),
    removeEventListener: (type, handler) => html.removeEventListener(type, handler),
    EventSource: StubEventSource,
    innerWidth: 1200,
    innerHeight: 800,
  }

  const fetch = async (path) => {
    calls.push({ kind: 'fetch', path })
    // Longest prefix wins, like the real dsh webserver's route table — otherwise
    // `/sessions` would swallow `/sessions/<id>/transcript`.
    let best
    for (const [prefix, value] of Object.entries(routes)) {
      if (!String(path).startsWith(prefix)) continue
      if (best === undefined || prefix.length > best.prefix.length) best = { prefix, value }
    }
    if (best !== undefined) {
      return { status: 200, json: async () => ({ ok: true, value: best.value }) }
    }
    return { status: 404, json: async () => ({ ok: false, error: { code: 'not_found', message: path } }) }
  }

  return {
    window,
    document,
    html,
    body,
    calls,
    routes,
    /** Run every queued animation frame (the client coalesces paints into one). */
    flush() {
      while (timers.length > 0) timers.splice(0).forEach((fn) => fn())
    },
    globals: {
      window,
      document,
      fetch,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      CustomEvent: class {
        constructor(type, init = {}) {
          this.type = type
          this.detail = init.detail
        }
      },
      HTMLElement: StubElement,
      getComputedStyle: () => ({ position: 'relative' }),
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeout: () => {},
      console,
      Math,
      Date,
      JSON,
      Set,
      Map,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Error,
      Promise,
      encodeURIComponent,
    },
  }
}
