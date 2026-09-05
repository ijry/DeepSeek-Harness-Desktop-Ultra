/**
 * Browser half of dsh-plugin-mobile-bridge: a sidebar entry and a panel that
 * shows the two QR codes, the reachable addresses, and the paired phones.
 *
 * Dependency-free vanilla DOM on purpose. The host serves everything this file
 * needs at `/dsh-mobile-bridge/admin/*` on the same origin, so the panel needs no
 * React runtime and no `@deepseek-ai/*` package in the browser — which also means
 * it cannot be broken by an npm-mirror copy of a CLI-internal build.
 *
 * The QR codes arrive as SVG path geometry rather than being encoded here: the
 * encoder lives in the host half's `shared/qr.js`, and this bundle is a single
 * wrapped file with no module resolution, so a browser copy would be a second
 * implementation of the only real maths in the package.
 *
 * The panel speaks Chinese or English. It cannot read the desktop shell's
 * `DSH_DESKTOP_LANG` — a page has no environment — so the host half resolves the
 * language and reports it as `language` in `/admin/state`, and until that answers
 * (or forever, on an install without the shell) `navigator.language` decides.
 *
 * Export shape is `name` / `inject` / `apply` (no default export). The build
 * (scripts/wrap-client.mjs) wraps this file in the DSH module loader, which
 * provides a CommonJS `module`, so this file assigns `module.exports` when
 * present and is otherwise inert.
 *
 * @module dsh-plugin-mobile-bridge/client
 */
;(function () {
  'use strict'

  var PLUGIN_ID = 'dsh-plugin-mobile-bridge'

  /**
   * Mirrors `ROUTE_PREFIX` in src/shared/protocol.js. It cannot be imported —
   * see the module comment — so test/client.test.mjs asserts the two agree.
   */
  var ROUTE_PREFIX = '/dsh-mobile-bridge'

  var OPEN_ATTR = 'data-dsh-mbridge-open'
  var ENTRY_SELECTOR = '[data-dsh-mbridge-entry]'

  /** Sibling panels announce themselves with this; whoever hears it stands down. */
  var ACTIVATE_EVENT = 'dsh-panel-activate'

  /** Open-attributes owned by sibling plugins, cleared when this panel opens. */
  var OTHER_OPEN_ATTRS = [
    'data-dsh-cgtb-open',
    'data-dsh-taskboard-active',
    'data-dsh-atb-active',
    'data-dsh-ssh-active',
  ]

  /**
   * Sidebar and conversation containers across dsh GUI generations. dsh exposes
   * no panel-registration service, so the entry is injected by selector with a
   * fallback chain; a generation that matches none simply shows no entry rather
   * than throwing inside someone's chat.
   */
  var SIDEBAR_SELECTOR =
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
  var CONVERSATION_SELECTOR =
    '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'

  var STYLE_ID = PLUGIN_ID + '-style'

  var model = { open: false, state: null, qr: null, busy: false, error: null, drawnCode: null }

  var entry = null
  var panel = null
  var observer = null
  var timer = null

  /* ------------------------------------------------------------------ lang */

  /**
   * Every string the panel paints, in both languages.
   *
   * It lives inside this file rather than in src/shared/lang.js for the reason
   * the module comment gives: the bundle is one wrapped file with no module
   * resolution, so an import is not available at any price. `{}` is the single
   * placeholder {@link t} fills.
   */
  var STRINGS = {
    zh: {
      title: '手机遥控',
      entryHint: '用手机 App 遥控这台机器上的 dsh',
      close: '关闭',
      loading: '正在读取状态…',

      never: '从未',
      secondsAgo: '{} 秒前',
      minutesAgo: '{} 分钟前',
      hoursAgo: '{} 小时前',
      daysAgo: '{} 天前',

      step1Title: '1 · 装 MCode App',
      step1Note: '手机扫这个码打开下载页，或直接访问下面的地址。',
      downloadQrLabel: 'MCode 下载页二维码',

      step2Title: '2 · 配对手机',
      step2Note: '在 App 里「新增连接 → 扫码连接」，扫下面这个码。',
      lanDown: '局域网监听没有起来，手机暂时连不上。',
      lanDownWhy: '局域网监听没有起来：{}，手机暂时连不上。',
      lanOff: '配置里关掉了局域网监听（lan: false），手机连不上。',
      pairingQrLabel: '配对二维码',
      codeHint: '扫码失败时，可以在 App 里手动输入这个配对码',
      codeNote: '配对码一次只能用一次，配对成功后会自动换新；{} 分钟后过期。',
      noLanAddress: '没有找到可用的局域网地址',
      urlsLabel: '手机可以访问的地址',
      rotate: '换一个配对码',

      step3Title: '3 · 从外网连（可选）',
      step3Note:
        '默认只在局域网可用。要在外面连，用隧道把下面这个端口暴露出去，然后在 App 里把地址改成隧道给的 https 地址。',
      portPending: '<端口未就绪>',
      tunnelOutput: '# 输出里会有一个 https://xxx.trycloudflare.com',
      tunnelAddress: '# App 里的服务地址填 https://xxx.trycloudflare.com',
      portWarning:
        '只暴露这个端口（{}）。不要把 dsh 自己的端口放到外网——那个端口上的界面没有任何认证，' +
        '拿到它就等于拿到这台机器的 shell。',
      publicDocs: '完整教程（含固定域名、Tailscale、反向代理）见插件目录里的 docs/public-access.md。',

      devicesTitle: '已配对的手机（{}）',
      devicesEmpty: '还没有手机配对过。',
      lastSeen: '最近活动 {}',
      revoke: '解除',
      revokeAll: '全部解除并换码',
      revokeAllHint: '屏幕被别人看到过、或手机丢了，就点这个',

      nameTitle: '这台机器的名字',
      nameNote: '手机上的连接名。改了之后请重新出码。',
      save: '保存',
      versionUnknown: '版本未知',
      protocol: '协议 v',
    },
    en: {
      title: 'Mobile Remote',
      entryHint: 'Drive the dsh on this machine from your phone',
      close: 'Close',
      loading: 'Loading status…',

      never: 'never',
      secondsAgo: '{}s ago',
      minutesAgo: '{}m ago',
      hoursAgo: '{}h ago',
      daysAgo: '{}d ago',

      step1Title: '1 · Install MCode App',
      step1Note: 'Scan this code with your phone to open the download page, or visit the address below.',
      downloadQrLabel: 'MCode download page QR code',

      step2Title: '2 · Pair your phone',
      step2Note: 'In the app, tap Add connection → Scan to connect (新增连接 → 扫码连接), then scan the code below.',
      lanDown: 'The LAN listener did not come up, so your phone cannot connect yet.',
      lanDownWhy: 'The LAN listener did not come up: {}, so your phone cannot connect yet.',
      lanOff: 'LAN listening is turned off in the config (lan: false), so your phone cannot connect.',
      pairingQrLabel: 'Pairing QR code',
      codeHint: 'If scanning fails, type this pairing code into the app by hand',
      codeNote: 'A pairing code is good for one phone and is replaced after a successful pair; it expires in {} min.',
      noLanAddress: 'No usable LAN address found',
      urlsLabel: 'Addresses your phone can reach',
      rotate: 'New pairing code',

      step3Title: '3 · Connect from outside (optional)',
      step3Note:
        'LAN only by default. To connect from elsewhere, expose the port below through a tunnel, then point the ' +
        'app at the https address the tunnel hands you.',
      portPending: '<port not ready>',
      tunnelOutput: '# the output contains a https://xxx.trycloudflare.com URL',
      tunnelAddress: '# set the server address in the app to https://xxx.trycloudflare.com',
      portWarning:
        'Expose only this port ({}). Never expose the port dsh itself serves on — that UI has no authentication ' +
        'at all, and reaching it is the same as having a shell on this machine.',
      publicDocs:
        'See docs/public-access.md in the plugin directory for the full guide (fixed domain, Tailscale, ' +
        'reverse proxy).',

      devicesTitle: 'Paired phones ({})',
      devicesEmpty: 'No phone has paired yet.',
      lastSeen: 'Last seen {}',
      revoke: 'Remove',
      revokeAll: 'Remove all and rotate the code',
      revokeAllHint: 'Use this if someone saw your screen or you lost your phone',

      nameTitle: 'Name of this computer',
      nameNote: 'The connection name shown on your phone. Rotate the code after changing it.',
      save: 'Save',
      versionUnknown: 'version unknown',
      protocol: 'protocol v',
    },
  }

  /**
   * The language in force. Resolved from `navigator` before the first paint and
   * replaced by the host's own as soon as the admin state answers, which is the
   * only way this half can learn what the desktop shell was told.
   */
  var lang = 'zh'

  /**
   * Mirrors `normalizeLang` in src/shared/lang.js. Restated for the same reason
   * ROUTE_PREFIX is, and test/lang.test.mjs runs both over the same spellings so
   * the two cannot drift.
   */
  function normalizeLang(value) {
    if (value === undefined || value === null) return null
    var base = String(value).trim().toLowerCase().split(/[-_.]/)[0]
    return base === 'zh' || base === 'en' ? base : null
  }

  /**
   * One string, with `{}` replaced when an argument is given.
   *
   * The table is looked up through `lang` on every call and never captured: a
   * dictionary held in a closure would keep painting the language the panel
   * started in after the host reported a different one.
   */
  function t(key, arg) {
    var table = STRINGS[lang] || STRINGS.zh
    var value = table[key] !== undefined ? table[key] : STRINGS.zh[key]
    if (value === undefined) return key
    if (arg === undefined) return value
    return value.replace('{}', function () {
      return String(arg)
    })
  }

  /** Adopt a language the host reported; true when something painted is now stale. */
  function adoptLang(value) {
    var next = normalizeLang(value)
    if (next === null || next === lang) return false
    lang = next
    return true
  }

  /* ------------------------------------------------------------------- api */

  var api = {
    request: function (path, options) {
      return fetch(ROUTE_PREFIX + path, options).then(function (res) {
        return res
          .json()
          .catch(function () {
            return null
          })
          .then(function (body) {
            if (!res.ok || body === null || body.ok !== true) {
              var detail = body !== null && body.error ? body.error.message : 'HTTP ' + res.status
              throw new Error(String(detail))
            }
            return body.value
          })
      })
    },
    post: function (path, payload) {
      return api.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
    },
    state: function () {
      return api.request('/admin/state')
    },
    qr: function () {
      return api.request('/admin/qr')
    },
    rotate: function () {
      return api.post('/admin/rotate')
    },
    revoke: function (payload) {
      return api.post('/admin/revoke', payload)
    },
    rename: function (displayName) {
      return api.post('/admin/name', { displayName: displayName })
    },
  }

  /* ------------------------------------------------------------------- dom */

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  /** One QR as an inline SVG from `{ path, extent }` geometry. */
  function qrSvg(geometry, label) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 ' + geometry.extent + ' ' + geometry.extent)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
    svg.setAttribute('class', 'mbridge__qr')
    var background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('width', String(geometry.extent))
    background.setAttribute('height', String(geometry.extent))
    background.setAttribute('fill', '#ffffff')
    svg.appendChild(background)
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', geometry.path)
    path.setAttribute('fill', '#000000')
    svg.appendChild(path)
    return svg
  }

  function timeAgo(at) {
    if (!at) return t('never')
    var seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (seconds < 60) return t('secondsAgo', seconds)
    if (seconds < 3600) return t('minutesAgo', Math.round(seconds / 60))
    if (seconds < 86400) return t('hoursAgo', Math.round(seconds / 3600))
    return t('daysAgo', Math.round(seconds / 86400))
  }

  /* ----------------------------------------------------------------- panel */

  function section(title, note) {
    var wrap = el('section', 'mbridge__card')
    wrap.appendChild(el('div', 'mbridge__cardTitle', title))
    if (note) wrap.appendChild(el('p', 'mbridge__note', note))
    return wrap
  }

  /** Step 1: get the app. Always shown — a user without it cannot do step 2. */
  function downloadCard() {
    var card = section(t('step1Title'), t('step1Note'))
    if (model.qr && model.qr.download) {
      card.appendChild(qrSvg(model.qr.download, t('downloadQrLabel')))
    }
    var link = el('a', 'mbridge__link', model.state ? model.state.downloadUrl : '')
    if (model.state) {
      link.href = model.state.downloadUrl
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
    }
    card.appendChild(link)
    return card
  }

  /** Step 2: pair. The QR carries the one-shot code, so it is regenerated freely. */
  function pairCard() {
    var reach = model.state.reach
    var card = section(t('step2Title'), t('step2Note'))

    if (!reach.listening) {
      var bad = el(
        'p',
        'mbridge__note mbridge__note--bad',
        reach.lan ? (reach.error ? t('lanDownWhy', reach.error) : t('lanDown')) : t('lanOff'),
      )
      card.appendChild(bad)
      return card
    }

    if (model.qr && model.qr.pairing) {
      card.appendChild(qrSvg(model.qr.pairing, t('pairingQrLabel')))
    }

    var code = el('div', 'mbridge__code', model.state.pairing.code)
    code.title = t('codeHint')
    card.appendChild(code)
    card.appendChild(
      el(
        'p',
        'mbridge__note',
        t('codeNote', Math.max(0, Math.round((model.state.pairing.expiresAt - Date.now()) / 60000))),
      ),
    )

    var urls = el('ul', 'mbridge__urls')
    reach.urls.forEach(function (url) {
      urls.appendChild(el('li', null, url))
    })
    if (reach.urls.length === 0) {
      urls.appendChild(el('li', 'mbridge__note--bad', t('noLanAddress')))
    }
    card.appendChild(el('div', 'mbridge__label', t('urlsLabel')))
    card.appendChild(urls)

    var actions = el('div', 'mbridge__actions')
    var rotate = el('button', 'mbridge__button', t('rotate'))
    rotate.type = 'button'
    rotate.disabled = model.busy
    rotate.addEventListener('click', function () {
      act(function () {
        return api.rotate()
      })
    })
    actions.appendChild(rotate)
    card.appendChild(actions)
    return card
  }

  /** Step 3: outside the LAN. The bridge cannot do this for the user, so it explains it. */
  function publicCard() {
    var reach = model.state.reach
    var card = section(t('step3Title'), t('step3Note'))
    var port = reach.port === null ? t('portPending') : String(reach.port)
    var command = el(
      'pre',
      'mbridge__pre',
      'cloudflared tunnel --url http://127.0.0.1:' + port + '\n' +
        t('tunnelOutput') + '\n' +
        t('tunnelAddress') + ROUTE_PREFIX,
    )
    card.appendChild(command)
    card.appendChild(el('p', 'mbridge__note mbridge__note--bad', t('portWarning', port)))
    card.appendChild(el('p', 'mbridge__note', t('publicDocs')))
    return card
  }

  /** Paired phones, with the two revoke gestures. */
  function devicesCard() {
    var devices = model.state.devices
    var card = section(t('devicesTitle', devices.length), devices.length === 0 ? t('devicesEmpty') : null)
    var list = el('ul', 'mbridge__devices')
    devices.forEach(function (device) {
      var row = el('li', 'mbridge__device')
      var text = el('div', 'mbridge__deviceText')
      text.appendChild(el('div', 'mbridge__deviceName', device.name))
      text.appendChild(el('div', 'mbridge__note', t('lastSeen', timeAgo(device.lastSeenAt))))
      row.appendChild(text)
      var kick = el('button', 'mbridge__button mbridge__button--quiet', t('revoke'))
      kick.type = 'button'
      kick.disabled = model.busy
      kick.addEventListener('click', function () {
        act(function () {
          return api.revoke({ deviceId: device.deviceId })
        })
      })
      row.appendChild(kick)
      list.appendChild(row)
    })
    if (devices.length > 0) card.appendChild(list)

    var actions = el('div', 'mbridge__actions')
    var all = el('button', 'mbridge__button mbridge__button--danger', t('revokeAll'))
    all.type = 'button'
    all.disabled = model.busy || devices.length === 0
    all.title = t('revokeAllHint')
    all.addEventListener('click', function () {
      act(function () {
        return api.revoke({ all: true })
      })
    })
    actions.appendChild(all)
    card.appendChild(actions)
    return card
  }

  /** Host identity: the name the phone will show for this connection. */
  function nameCard() {
    var card = section(t('nameTitle'), t('nameNote'))
    var row = el('div', 'mbridge__actions')
    var input = el('input', 'mbridge__input')
    input.type = 'text'
    input.value = model.state.displayName
    input.maxLength = 64
    row.appendChild(input)
    var save = el('button', 'mbridge__button', t('save'))
    save.type = 'button'
    save.disabled = model.busy
    save.addEventListener('click', function () {
      act(function () {
        return api.rename(input.value)
      })
    })
    row.appendChild(save)
    card.appendChild(row)
    card.appendChild(
      el(
        'p',
        'mbridge__note',
        'dsh ' +
          (model.state.dshVersion || t('versionUnknown')) +
          ' · ' +
          t('protocol') +
          model.state.protocolVersion,
      ),
    )
    return card
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    if (panel === null) return
    panel.textContent = ''

    var head = el('div', 'mbridge__head')
    head.appendChild(el('div', 'mbridge__title', t('title')))
    var close = el('button', 'mbridge__button mbridge__button--quiet', t('close'))
    close.type = 'button'
    close.addEventListener('click', function () {
      setOpen(false)
    })
    head.appendChild(close)
    panel.appendChild(head)

    if (model.error !== null) {
      panel.appendChild(el('p', 'mbridge__note mbridge__note--bad', model.error))
    }
    if (model.state === null) {
      panel.appendChild(el('p', 'mbridge__note', t('loading')))
      return
    }

    panel.appendChild(downloadCard())
    panel.appendChild(pairCard())
    panel.appendChild(publicCard())
    panel.appendChild(devicesCard())
    panel.appendChild(nameCard())
  }

  /** Run one mutation, then re-read state and QR together. */
  function act(run) {
    if (model.busy) return
    model.busy = true
    model.error = null
    render()
    run()
      .then(function (next) {
        model.state = next
        if (adoptLang(next && next.language)) relabelEntry()
        model.drawnCode = null
        return refreshQr()
      })
      .catch(function (error) {
        model.error = String(error && error.message ? error.message : error)
      })
      .then(function () {
        model.busy = false
        render()
      })
  }

  function refreshState() {
    return api
      .state()
      .then(function (state) {
        model.state = state
        if (adoptLang(state.language)) relabelEntry()
        model.error = null
      })
      .catch(function (error) {
        model.error = String(error && error.message ? error.message : error)
      })
  }

  /**
   * Re-read the QR geometry only when the pairing code changed. The state poll is
   * cheap; the two path strings are tens of kilobytes, and redrawing an identical
   * QR every few seconds would also make the code un-scannable on a slow machine.
   */
  function refreshQr() {
    if (model.state === null) return Promise.resolve()
    var code = model.state.pairing.code
    if (model.drawnCode === code && model.qr !== null) return Promise.resolve()
    return api
      .qr()
      .then(function (qr) {
        model.qr = qr
        model.drawnCode = qr.code
      })
      .catch(function (error) {
        model.error = String(error && error.message ? error.message : error)
      })
  }

  function refreshAll() {
    return refreshState()
      .then(refreshQr)
      .then(function () {
        render()
      })
  }

  /**
   * Learn the language from the host half.
   *
   * The sidebar entry is built and painted before anything is fetched, so the
   * first paint uses the browser's own language; this call corrects it as soon as
   * the admin state answers. Without the shell there is no `DSH_DESKTOP_LANG` to
   * report, the field is absent, and `navigator.language` stands — which is what
   * a standalone install should do.
   */
  function refreshLang() {
    return api
      .state()
      .then(function (state) {
        if (adoptLang(state.language)) {
          relabelEntry()
          render()
        }
      })
      .catch(function () {
        /* no host language to be had; the browser's own is already in force */
      })
  }

  /* ------------------------------------------------------------------ mount */

  function sidebarRoot() {
    var column = document.querySelector(SIDEBAR_SELECTOR)
    if (column === null) return undefined
    var logoRow = column.querySelector('[class*="logoRow"]')
    return (logoRow !== null ? logoRow.parentElement : column.firstElementChild) || undefined
  }

  function buildEntry() {
    var button = el('button', 'mbridge__entry', t('title'))
    button.type = 'button'
    button.setAttribute('data-dsh-mbridge-entry', '')
    button.title = t('entryHint')
    button.addEventListener('click', function () {
      setOpen(!model.open)
    })
    return button
  }

  /**
   * Repaint the two labels that outlive a render: the sidebar entry is built once
   * and kept, so a language that arrives later has to be written onto it by hand.
   */
  function relabelEntry() {
    if (entry !== null) {
      entry.textContent = t('title')
      entry.title = t('entryHint')
    }
    if (panel !== null) panel.setAttribute('aria-label', t('title'))
  }

  /** Place the entry next to the sidebar's own family of plugin entries. */
  function placeEntry() {
    if (entry === null) return false
    var root = sidebarRoot()
    if (root === undefined || !root.isConnected) return false
    if (entry.parentElement === root && root.contains(entry)) return true
    var family = Array.prototype.filter.call(root.children, function (child) {
      return (
        child instanceof HTMLElement &&
        child.matches(ENTRY_SELECTOR + ', [data-dsh-cgtb-entry], [data-dsh-taskboard-entry]')
      )
    })
    if (family.length > 0) {
      root.insertBefore(entry, family[family.length - 1].nextElementSibling)
      return true
    }
    var nested = root.querySelector('button[class*="newSession"]')
    var row = nested !== null && nested.parentElement !== null
      ? nested.parentElement === root
        ? nested
        : nested.closest('[class*="logoRow"]')
      : null
    if (row !== null) {
      root.insertBefore(entry, row.nextElementSibling)
      return true
    }
    root.appendChild(entry)
    return true
  }

  function placePanel() {
    if (panel === null) return false
    var host = document.querySelector(CONVERSATION_SELECTOR) || document.body
    if (host === null) return false
    if (panel.parentElement === host) return true
    host.appendChild(panel)
    return true
  }

  function ensureMounted() {
    if (entry === null) entry = buildEntry()
    if (panel === null) {
      panel = el('aside', 'mbridge')
      panel.setAttribute('aria-label', t('title'))
    }
    placeEntry()
    placePanel()
  }

  function setOpen(open) {
    if (model.open === open) return
    model.open = open
    var root = document.documentElement
    if (open) {
      OTHER_OPEN_ATTRS.forEach(function (attr) {
        root.removeAttribute(attr)
      })
      root.setAttribute(OPEN_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PLUGIN_ID }))
      void refreshAll()
    } else {
      root.removeAttribute(OPEN_ATTR)
    }
    render()
  }

  function onActivate(event) {
    if (event.detail !== PLUGIN_ID) setOpen(false)
  }

  /* ----------------------------------------------------------------- styles */

  /**
   * One injected stylesheet. Colours come from dsh's own runtime theme tokens
   * with literal fallbacks, so the panel follows a theme switch without reading
   * any dsh state — and still looks deliberate in a generation that renames them.
   */
  function injectStyles() {
    if (document.getElementById(STYLE_ID) !== null) return
    var style = el('style')
    style.id = STYLE_ID
    style.textContent = [
      '.mbridge__entry{display:block;width:100%;box-sizing:border-box;margin:2px 8px;padding:8px 10px;',
      'border:0;border-radius:8px;background:transparent;color:var(--dsw-text-primary,#e8e8ea);',
      'font:inherit;text-align:left;cursor:pointer}',
      '.mbridge__entry:hover{background:var(--dsw-hover,rgba(255,255,255,.07))}',
      'html[' + OPEN_ATTR + '] .mbridge__entry{background:var(--dsw-active,rgba(255,255,255,.12))}',
      '.mbridge{display:none}',
      'html[' + OPEN_ATTR + '] .mbridge{display:block;position:absolute;inset:0;z-index:40;overflow:auto;',
      'padding:20px;box-sizing:border-box;background:var(--dsw-bg,#17171a);color:var(--dsw-text-primary,#e8e8ea)}',
      '.mbridge__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}',
      '.mbridge__title{font-size:18px;font-weight:600}',
      '.mbridge__card{margin:0 0 16px;padding:14px 16px;border:1px solid var(--dsw-border,rgba(255,255,255,.12));',
      'border-radius:12px;max-width:560px}',
      '.mbridge__cardTitle{font-weight:600;margin-bottom:6px}',
      '.mbridge__note{margin:6px 0;font-size:13px;line-height:1.6;color:var(--dsw-text-secondary,#a5a5ad)}',
      '.mbridge__note--bad{color:var(--dsw-danger,#e5484d)}',
      '.mbridge__label{margin-top:10px;font-size:12px;color:var(--dsw-text-secondary,#a5a5ad)}',
      '.mbridge__qr{display:block;width:240px;height:240px;margin:10px 0;border-radius:8px}',
      '.mbridge__code{display:inline-block;margin:4px 0;padding:6px 10px;border-radius:8px;',
      'background:var(--dsw-hover,rgba(255,255,255,.07));font-family:ui-monospace,monospace;',
      'font-size:20px;letter-spacing:.16em}',
      '.mbridge__urls{margin:4px 0 0;padding-left:18px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.8}',
      '.mbridge__pre{margin:8px 0;padding:10px;border-radius:8px;overflow:auto;',
      'background:var(--dsw-hover,rgba(255,255,255,.07));font-size:12px;line-height:1.6;white-space:pre-wrap}',
      '.mbridge__actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}',
      '.mbridge__button{padding:6px 12px;border:1px solid var(--dsw-border,rgba(255,255,255,.16));',
      'border-radius:8px;background:var(--dsw-hover,rgba(255,255,255,.07));',
      'color:var(--dsw-text-primary,#e8e8ea);font:inherit;font-size:13px;cursor:pointer}',
      '.mbridge__button:disabled{opacity:.5;cursor:default}',
      '.mbridge__button--quiet{background:transparent}',
      '.mbridge__button--danger{color:var(--dsw-danger,#e5484d)}',
      '.mbridge__input{flex:1;min-width:160px;padding:6px 10px;border-radius:8px;',
      'border:1px solid var(--dsw-border,rgba(255,255,255,.16));background:transparent;',
      'color:var(--dsw-text-primary,#e8e8ea);font:inherit;font-size:13px}',
      '.mbridge__devices{list-style:none;margin:8px 0 0;padding:0}',
      '.mbridge__device{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'padding:8px 0;border-top:1px solid var(--dsw-border,rgba(255,255,255,.08))}',
      '.mbridge__deviceName{font-size:14px}',
      '.mbridge__link{display:inline-block;margin-top:4px;font-size:13px;',
      'color:var(--dsw-primary,#5b8cff);word-break:break-all}',
    ].join('')
    document.head.appendChild(style)
  }

  /* ------------------------------------------------------------------ apply */

  function apply(ctx) {
    // Before anything is built: the entry's label is written once, so the
    // dictionary has to be chosen first. `navigator.language` is the only source a
    // page has synchronously; the host's own answer follows a moment later.
    lang = normalizeLang(typeof navigator === 'undefined' ? null : navigator.language) || 'zh'
    injectStyles()
    ensureMounted()
    void refreshLang()
    document.addEventListener(ACTIVATE_EVENT, onActivate)

    // dsh's GUI re-renders its columns freely, so the entry has to be re-placed
    // rather than placed once. The interval is the belt to the observer's braces:
    // a mutation batch that replaces the sidebar between frames can land while the
    // observer callback is already queued.
    observer = new MutationObserver(function () {
      ensureMounted()
    })
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true })
    timer = setInterval(function () {
      ensureMounted()
      if (model.open) void refreshState().then(render)
    }, 5000)

    var dispose = function () {
      if (observer !== null) observer.disconnect()
      observer = null
      if (timer !== null) clearInterval(timer)
      timer = null
      document.removeEventListener(ACTIVATE_EVENT, onActivate)
      document.documentElement.removeAttribute(OPEN_ATTR)
      if (entry !== null && entry.parentElement !== null) entry.parentElement.removeChild(entry)
      if (panel !== null && panel.parentElement !== null) panel.parentElement.removeChild(panel)
      entry = null
      panel = null
      var style = document.getElementById(STYLE_ID)
      if (style !== null && style.parentElement !== null) style.parentElement.removeChild(style)
    }

    if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
      ctx.effect(function () {
        return dispose
      }, PLUGIN_ID + ': client mount')
    } else {
      window.addEventListener('beforeunload', dispose, { once: true })
    }
  }

  if (typeof module !== 'undefined' && module !== null && module.exports !== undefined) {
    module.exports = { name: PLUGIN_ID + '/client', inject: [], apply: apply }
  }






})()
