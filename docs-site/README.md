# docs-site — DSH Desktop Ultra 官网

`docs-site/` 是独立的 Vite + React + TypeScript 单页工程，产出中英双语的
DSH Desktop Ultra 官网，部署到项目 GitHub Pages：

<https://ijry.github.io/DeepSeek-Harness-Desktop-Ultra/>

## 本地开发

```bash
cd docs-site
npm install
npm run dev      # http://localhost:1422/DeepSeek-Harness-Desktop-Ultra/ (vite base 与 Pages 一致)
```

## 检查与构建

```bash
cd docs-site
npm run typecheck
npm run build    # 产物在 docs-site/dist
```

构建时 `vite.config.ts` 会把 `base` 设为 `/DeepSeek-Harness-Desktop-Ultra/`，与项目 Pages 地址保持一致；因此 dev/preview 也要通过该前缀访问。

## 发布到 GitHub Pages

推送 `main` 分支（或手动触发 `.github/workflows/docs-site.yml`）即可自动部署。
首次使用前需要在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**。

## 维护约定

- 中英文案集中在 `src/i18n.tsx`，新增文案必须同时补齐 `zh` 与 `en`。
- 动效全部基于 CSS 与 `IntersectionObserver`，没有第三方脚本/字体依赖；
  尊重 `prefers-reduced-motion`。
- Logo 使用 `public/logo.svg`（与根目录 `public/logo.svg` 同源，改动需同步）。
- 下载入口统一指向 GitHub Releases，不硬编码安装包文件名。