import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 项目 GitHub Pages 部署在 https://ijry.github.io/DeepSeek-Harness-Desktop-Ultra/
export default defineConfig({
  base: "/DeepSeek-Harness-Desktop-Ultra/",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
  },
  build: {
    outDir: "dist",
  },
});