/**
 * Loading xterm.js at runtime.
 *
 * The bundle cannot `import` anything, so the terminal emulator arrives as three
 * script tags pointed at this plugin's own `/vendor` route (host/vendor.js serves the
 * exact files npm installed). That keeps a 290 KB minified library out of a generated
 * source file while still pinning its version, and it never touches the network.
 *
 * The UMD wrappers differ by package: `xterm.js` copies its exports onto the global,
 * so `window.Terminal` is the class; the addons assign their whole namespace, so
 * `window.FitAddon.FitAddon` is the class. Both shapes are accepted below because a
 * future xterm release could switch either way.
 */

let vendorPromise = null

/** Load xterm and its addons once. Resolves with the constructors. */
function ensureXterm() {
  if (vendorPromise !== null) return vendorPromise
  vendorPromise = (async () => {
    loadStylesheet(VENDOR_PREFIX + '/xterm.css')
    await loadScript(VENDOR_PREFIX + '/xterm.js')
    // The addons are optional extras: a missing search addon must not cost the user
    // a terminal, so each one is loaded on its own and its absence tolerated.
    const optional = async (file) => {
      try {
        await loadScript(VENDOR_PREFIX + file)
        return true
      } catch (error) {
        console.warn(LOG + ' optional addon missing:', messageOf(error))
        return false
      }
    }
    await optional('/addon-fit.js')
    await optional('/addon-search.js')
    await optional('/addon-web-links.js')

    const Terminal = window.Terminal
    if (typeof Terminal !== 'function') throw new Error(t('term.vendorMissing'))
    return {
      Terminal,
      FitAddon: pickClass(window.FitAddon, 'FitAddon'),
      SearchAddon: pickClass(window.SearchAddon, 'SearchAddon'),
      WebLinksAddon: pickClass(window.WebLinksAddon, 'WebLinksAddon'),
    }
  })()
  vendorPromise.catch(() => {
    // A failed load must not be cached as a permanent failure: the user may run
    // `npm install` and reopen the panel.
    vendorPromise = null
  })
  return vendorPromise
}

/** Unwrap `X` or `{X}` into the constructor. */
function pickClass(value, name) {
  if (typeof value === 'function') return value
  if (value !== null && value !== undefined && typeof value[name] === 'function') return value[name]
  return undefined
}
