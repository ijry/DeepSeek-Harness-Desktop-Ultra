import { fileURLToPath, URL } from 'node:url'
import { readFile } from 'node:fs/promises'

import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Build config for the AI Switch panel.
 *
 * The panel is the reference app's React 18 + UnoCSS front end, copied file for
 * file out of `ai-switch/src`. Everything it used to get from the Tauri shell is
 * redirected here rather than edited into the sources:
 *
 *   `@tauri-apps/api/core`        -> shims/tauri-core.ts     (invoke is not available)
 *   `@tauri-apps/api/event`      -> shims/tauri-event.ts     (events arrive over the panel socket)
 *   `@tauri-apps/plugin-dialog`  -> shims/tauri-dialog.ts    (in-panel host file browser)
 *   `@tauri-apps/plugin-opener`  -> shims/tauri-opener.ts    (window.open)
 *   `@tauri-apps/plugin-autostart`/`-process`/`-updater` -> shims that say "not here"
 *
 * The single copied file that IS edited is `src/lib/transport/index.ts`: the app has
 * to talk to `/dsh-plugin-ai-switch/api/...` instead of the origin's `/api/...`,
 * because the origin's `/api` belongs to dsh itself. See that file's header.
 *
 * `base: './'` matters: the built index.html is served from
 * `/dsh-plugin-ai-switch/app/`, so every asset URL has to be relative to it.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * ocrad.js ships legacy octal literals (`0644`) and assigns `this.Module`, neither of
 * which survives strict-mode ESM. The reference app patches the source at load time;
 * the same patch is needed here or the OCR screen breaks the whole bundle.
 */
function patchOcradSource(code: string) {
  return code
    .replace(/\b0([0-7]{3})\b/g, '0o$1')
    .replace(/this\[['"]Module['"]\]\s*=\s*Module;/g, 'globalThis["Module"] = Module;')
}

function ocradOptimizeDepsPlugin() {
  return {
    name: 'ocrad-optimize-deps',
    setup(build: {
      onLoad: (
        options: { filter: RegExp },
        callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' }>,
      ) => void
    }) {
      build.onLoad({ filter: /ocrad\.js[\\/]ocrad\.js$/ }, async (args) => ({
        contents: patchOcradSource(await readFile(args.path, 'utf8')),
        loader: 'js',
      }))
    },
  }
}

function ocradLegacyOctalPlugin(): Plugin {
  return {
    name: 'ocrad-legacy-octal',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/')
      const isOcradModule =
        normalizedId.endsWith('/ocrad.js') || normalizedId.includes('/.vite/deps/ocrad__js.js')
      if (!isOcradModule) {
        return null
      }
      return { code: patchOcradSource(code), map: null }
    },
  }
}

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [
    ocradLegacyOctalPlugin(),
    UnoCSS({ configFile: here('./uno.config.ts') }),
    react(),
  ],
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: here('./src/shims/tauri-core.ts') },
      { find: '@tauri-apps/api/event', replacement: here('./src/shims/tauri-event.ts') },
      { find: '@tauri-apps/plugin-dialog', replacement: here('./src/shims/tauri-dialog.ts') },
      { find: '@tauri-apps/plugin-opener', replacement: here('./src/shims/tauri-opener.ts') },
      { find: '@tauri-apps/plugin-autostart', replacement: here('./src/shims/tauri-autostart.ts') },
      { find: '@tauri-apps/plugin-process', replacement: here('./src/shims/tauri-process.ts') },
      { find: '@tauri-apps/plugin-updater', replacement: here('./src/shims/tauri-updater.ts') },
    ],
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [ocradOptimizeDepsPlugin()],
    },
  },
  build: {
    outDir: here('../lib/webview'),
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // The 3D cockpit and the terminal emulator are each big enough that a panel
        // code change should not invalidate their cache entries.
        manualChunks: {
          three: ['three'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
