/**
 * Panel bootstrap.
 *
 * Three things happen before the app mounts, all of them driven by the query
 * string the client entry puts on the iframe URL:
 *
 *   `?lang=…`  → the locale DSH resolved (DSH_DESKTOP_LANG, then LC_ALL/LANG).
 *   `?theme=…` → `dark` or `light`, so Element Plus's dark tokens are on from the
 *                first paint instead of flashing white.
 *
 * The shell can change either at runtime; it posts `dbm:locale` / `dbm:theme` into
 * the frame and both are applied without a reload.
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

import App from './App.vue'
import { applyLocaleSettings } from './platform/i18n'

const params = new URLSearchParams(window.location.search)

const applyTheme = (value?: string | null) => {
  const dark =
    value === 'dark'
    || (!value && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

applyLocaleSettings({ locale: params.get('lang') })
applyTheme(params.get('theme'))

// Follow the OS when the shell did not pin a theme.
if (!params.get('theme') && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    applyTheme(event.matches ? 'dark' : 'light')
  })
}

window.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; value?: unknown } | null
  if (!data || typeof data.type !== 'string') {
    return
  }
  if (data.type === 'dbm:theme') {
    applyTheme(typeof data.value === 'string' ? data.value : null)
    return
  }
  if (data.type === 'dbm:locale') {
    applyLocaleSettings({ locale: typeof data.value === 'string' ? data.value : null })
  }
})

createApp(App).use(ElementPlus).mount('#app')
