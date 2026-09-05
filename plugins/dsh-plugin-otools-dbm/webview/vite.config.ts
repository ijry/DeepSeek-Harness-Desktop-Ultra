import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Build config for the 鲨鱼数据库 panel.
 *
 * The panel is the reference plugin's Vue 3 + Element Plus app, copied file for
 * file. Everything it used to get from the OTools shell is redirected here
 * instead of edited into the sources:
 *
 *   `@/…`                       → webview/src (the ported platform shims)
 *   `@tauri-apps/api/core`      → shims/tauri-core.ts   (invoke over HTTP)
 *   `@tauri-apps/api/event`     → shims/tauri-event.ts  (listen over SSE)
 *   `@tauri-apps/plugin-dialog` → shims/tauri-dialog.ts (in-app host browser)
 *
 * `base: './'` matters: the built index.html is served from
 * `/dsh-plugin-otools-dbm/app/`, so every asset URL has to be relative to it.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: [
      { find: 'otools-plugin-sdk/runtime', replacement: here('./src/shims/tauri-core.ts') },
      { find: '@tauri-apps/api/core', replacement: here('./src/shims/tauri-core.ts') },
      { find: '@tauri-apps/api/event', replacement: here('./src/shims/tauri-event.ts') },
      { find: '@tauri-apps/plugin-dialog', replacement: here('./src/shims/tauri-dialog.ts') },
      { find: /^@\//, replacement: here('./src') + '/' },
    ],
  },
  build: {
    outDir: here('../lib/webview'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Keep the heavyweight editors and the chart library in their own files
        // so a browser cache hit on the panel code survives an editor bump.
        // (echarts is deliberately NOT listed: rollup already places it with the
        // dashboard code that is its only importer, and naming it here produced an
        // empty chunk plus a build warning.)
        manualChunks: {
          editors: ['vditor', 'quill', '@vueup/vue-quill'],
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-sql',
            '@codemirror/lang-json',
            '@codemirror/lang-javascript',
            '@codemirror/lang-html',
            '@codemirror/lang-css',
            '@codemirror/lang-python',
            '@codemirror/lang-php',
            '@codemirror/theme-one-dark',
          ],
        },
      },
    },
  },
})
