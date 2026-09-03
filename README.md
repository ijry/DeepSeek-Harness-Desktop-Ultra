# DSH Desktop Ultra

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Tauri 桌面外壳

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app/)

把官方开源的 DeepSeek Harness（`dsh`）装进一个原生窗口。**不重新实现 harness 的任何功能** —— 因此上游发新版时，这里只需要改一个版本号。

## 设计取舍

这是一个**瘦外壳**（thin shell）。dsh 自带完整的 Web UI，外壳只负责它做不到的那部分：

| 外壳负责 | 交给 dsh |
| --- | --- |
| 原生窗口、图标、任务栏 | 全部 UI 与主题 |
| 找到并校验 Node 运行时 | 模型、工具、会话、插件 |
| 安装/锁定 dsh 版本 | API Key 与所有配置 |
| 拉起并监护 dsh 进程 | 聊天、Agent 循环 |
| 外壳自身的自动更新 | — |

两个关键决定：

**1. 不分发 Node，用用户系统上的。**
安装包因此只有几 MB，但要求用户自备 Node ^22.19 或 >= 24。找不到或版本过低时，外壳给出带下载链接的指引页，而不是一句「启动失败」。可用环境变量 `DSH_DESKTOP_NODE` 指定 node 路径（图形化启动时继承到的 `PATH` 常常看不到 nvm/fnm 装的 node）。

**2. 不加载 dsh 的 UI 之外的自定义界面。**
外壳自带的前端只有一个启动/错误页；dsh 就绪后 webview 整体跳转到 `http://127.0.0.1:<port>`。代价是外壳无法定制 UI 外观、跳转之后也无法再显示外壳自己的错误页（详见下面的「已知限制」）。

## 上游更新怎么做

改一个常量，就这样：

```rust
// src-tauri/src/upstream.rs
pub const DSH_VERSION: &str = "0.1.0";  // ← 改这里
```

然后照常发版。用户下次启动时，外壳发现私有目录里装的版本和锁定值不一致，就会自动重装。

查看当前锁定的版本：

```bash
npm run upstream:version
```

**为什么锁定精确版本而不用 `npx @deepseek-ai/dsh`**：`npx` 会解析到用户全局缓存里的任意版本，等于每台机器跑的上游代码都可能不同，出问题无法复现。私有 npm prefix（`<数据目录>/dsh-desktop-ultra/runtime/`）让「我们测过的版本」和「用户跑的版本」严格一致，也让回滚一个坏版本成为可能 —— 装的版本比锁定值**新**时同样会被重装回去。

## 启动流程

```
查找 Node ──失败──→ 指引页（下载 / 升级 / 指定路径）
    │
  校验版本 ──过低──→ 指引页
    │
检查 dsh 版本 ──不匹配──→ npm install 到私有 prefix ──失败──→ 指引页（网络 / registry）
    │
分配空闲端口 → node <dsh> web --port <port> --host 127.0.0.1
    │
轮询端口就绪（最多 90s，进程提前退出则立即报错）
    │
webview 跳转到 http://127.0.0.1:<port>
```

服务只绑定 `127.0.0.1`，不对外暴露。退出时杀掉整棵进程树（Windows 用 `taskkill /T`，Unix 先 `SIGTERM` 进程组再 `SIGKILL`）—— 只 kill 直接子进程会留下占着端口的孤儿 node，下次启动就撞车。

## 开发

需要 Node 22+ 与 Rust 1.77+。

```bash
npm install
npm run tauri:dev
```

检查：

```bash
npm run typecheck      # 前端类型
npm test               # 发布脚本的单测
npm run rust:check     # Rust 编译检查
npm run rust:test      # Rust 单测
```

构建：

```bash
npm run tauri:build
```

## 发布

1. 生成更新签名密钥（只需一次）：

   ```bash
   npm run generate-keys
   ```

   私钥写到 `D:\Repos\xyito\config\dsh-desktop\`（仓库外，`.gitignore` 已排除 `*.key`），公钥自动填进 `src-tauri/tauri.conf.json`。
   **私钥丢了就再也无法给已发布的版本推更新** —— 覆盖已有密钥需要显式加 `--force`。

2. 在 GitHub 仓库加 secret：

   - `TAURI_SIGNING_PRIVATE_KEY` —— 私钥文件的完整内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` —— 未设密码则留空

3. 三处版本号必须一致（CI 会校验）：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。

4. 打 tag 推送，其余交给 CI：

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   带 `-rc` / `-beta` / `-alpha` 的 tag 发布为预览版。tag commit 的 message 就是发布说明。

CI 还会拒绝：tag 不在默认分支上、`updater.pubkey` 仍是占位值、产物里没有 `.sig` 签名、更新清单平台列表为空。

## 已知限制

- **跳转后外壳失去 UI 控制权。** dsh 就绪后窗口交给它的页面，此时若 dsh 进程崩溃，外壳无法再显示错误页 —— 需要重启应用。要修的话得改成 dsh 跑在独立 webview 里、外壳保留一层容器。
- **Node 版本要求会拦住一部分用户。** 这是「不分发 Node」的直接代价。若要改成零依赖，需要在安装包里内置 Node 运行时（体积涨到 60–100MB）。
- **首次启动需要联网**从 npm 拉取 dsh。
- **端口分配存在竞态窗口**：拿到空闲端口后立即释放再交给 dsh，极端情况下可能被别的进程抢占，此时 dsh 会启动失败并显示日志。

## 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 上游，MIT
- [Cordis](https://cordisjs.org/) —— harness 的插件内核
- [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) —— 插件生态
- [Tauri](https://tauri.app/)

## 许可证

MIT，见 [LICENSE](./LICENSE)。上游 DeepSeek Harness 亦为 MIT。
