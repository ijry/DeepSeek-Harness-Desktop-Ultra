import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 两个入口:启动/错误页和托盘拉起来的设置窗口。
    //
    // index.html 必须显式列出来 —— 一旦写了 input,vite 的隐式
    // 「root/index.html」入口就没了,而 tauri dev 察觉不到(dev 下 HTML 由
    // vite 直接服务),只有 tauri build 出来的包会少一个页面。
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
