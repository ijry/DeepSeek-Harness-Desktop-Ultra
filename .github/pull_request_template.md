## 变更说明

<!-- 这个 PR 做了什么,以及为什么 -->

## 关联 Issue

<!-- Closes #123 -->

## 类型

- [ ] 🐛 修复
- [ ] ✨ 新功能
- [ ] ⬆️ 升级上游 dsh 版本
- [ ] 📝 文档
- [ ] ♻️ 重构
- [ ] 🔧 构建/CI

## 检查项

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过
- [ ] `npm run rust:check` 通过
- [ ] `npm run rust:test` 通过
- [ ] `npm run rust:fmt:check` 通过

## 如果是升级上游 dsh 版本

- [ ] 只改了 `src-tauri/src/upstream.rs` 里的 `DSH_VERSION`
- [ ] 确认该版本在 npm 上存在(`npm view @deepseek-ai/dsh@<版本> version`)
- [ ] 本地删掉 `<数据目录>/dsh-desktop-ultra/runtime/` 后跑过一次完整冷启动
- [ ] 确认 dsh 的 CLI 参数(`web --port --host`)在新版本里没有变化

<!--
最后一条容易漏但很关键:外壳靠 `dsh web --port N --host 127.0.0.1` 拉起服务。
上游改了这几个参数的名字,外壳会静默卡在「等待就绪」直到超时。
-->

## 如果动了发版流程

- [ ] 三处版本号一致:`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`
- [ ] 没有把私钥或 `*.key` 提交进来

## 如果动了窗口/启动逻辑

- [ ] 在至少一个平台上验证过退出后没有残留的 node 进程
