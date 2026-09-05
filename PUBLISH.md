# 插件发布指南

本文档说明如何将内置插件发布到 npm。

## 发布前检查清单

每个插件发布前必须确认：

- [ ] `npm run build` 成功，`lib/` 目录已生成
- [ ] `npm test` 通过（如果有测试）
- [ ] `package.json` 版本号已更新
- [ ] `README.md` 完整且准确
- [ ] `dsh.compatibility.dshReleases` 包含当前锁定的 dsh 版本
- [ ] 暗黑模式支持已实现（所有插件已支持）
- [ ] 有运行时依赖的插件（墨鱼终端、鲨鱼数据库）：`npm ci` 干净、`package-lock.json` 已提交，
      且 `optionalDependencies` 装不上时功能会降级而不是崩
- [ ] 鲨鱼数据库额外确认：`npm install` 装过、`lib/webview` 已构建并在 `npm pack` 清单里

## 各插件的发布命令

所有插件都已配置 `prepack` 脚本，执行 `npm publish` 前会自动构建。

### 1. 任务看板

```bash
cd plugins/dsh-plugin-taskboard
npm run build
npm test
npm publish
```

### 2. 无限画布

```bash
cd plugins/dsh-plugin-canvas
npm run build
npm test
npm publish
```

### 3. 手机遥控

```bash
cd plugins/dsh-plugin-mobile-bridge
npm run build
npm test
npm publish
```

### 4. 仓库面板

```bash
cd plugins/dsh-plugin-repopanel
npm run build
npm test
npm publish
```

### 5. 章鱼Git

```bash
cd plugins/dsh-plugin-otools-git
npm run build
npm test
npm publish
```

### 6. 墨鱼终端

```bash
cd plugins/dsh-plugin-otools-term
npm install
npm run build
npm test
npm publish
```

### 7. 自动化

```bash
cd plugins/dsh-plugin-automation
npm run build
npm test
npm publish
```

### 8. 长文阅读

```bash
cd plugins/dsh-plugin-longread
npm run build
npm test
npm publish
```

### 9. 鲨鱼数据库

驱动是运行时依赖，Vue + Vite 是构建时依赖，所以发布前要先装依赖。`files` 里带着
`lib/webview`（Vite 打出来的面板，约 3.7 MB），确认它在包里，否则装上以后面板是空白页。

```bash
cd plugins/dsh-plugin-otools-dbm
npm install
npm run build          # 含 vite 打包面板 → lib/webview
npm test
npm pack --dry-run     # 确认 lib/webview/assets/*.js 在文件清单里
npm publish
```

## 版本号规范

遵循 [Semantic Versioning](https://semver.org/)：

- **补丁版本** (0.1.0 → 0.1.1)：修复 bug，不改行为
- **次版本** (0.1.0 → 0.2.0)：新增功能，向后兼容
- **主版本** (0.1.0 → 1.0.0)：破坏性变更

所有插件当前版本：`0.1.0`

更新版本号：

```bash
# 在插件目录下
npm version patch   # 0.1.0 → 0.1.1
npm version minor   # 0.1.0 → 0.2.0
npm version major   # 0.1.0 → 1.0.0
```

## 发布到 npm

首次发布需要 npm 账号：

```bash
# 登录（只需一次）
npm login

# 发布
npm publish
```

发布后验证：

```bash
# 检查包是否可安装
npm info dsh-plugin-taskboard
npm info dsh-plugin-canvas
npm info dsh-plugin-mobile-bridge
npm info dsh-plugin-repopanel
npm info dsh-plugin-otools-git
npm info dsh-plugin-otools-term
npm info dsh-plugin-automation
npm info dsh-plugin-longread
```

## 提交到插件市场

包发布到 npm 后，要让它出现在 dsh 内置插件市场，需要在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 registry 条目：

1. Fork 该仓库
2. 在 `registry/` 目录下为每个插件创建一个 JSON 文件：

```json
{
  "name": "dsh-plugin-taskboard",
  "version": "0.1.0",
  "description": "Agent-first task kanban for DeepSeek Harness",
  "author": "ijry (DSH Desktop Ultra contributors)",
  "repository": "https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra",
  "npmPackage": "dsh-plugin-taskboard",
  "category": "productivity",
  "tags": ["taskboard", "kanban", "agent", "workflow"]
}
```

3. 提交 PR

通常 24 小时内会被合并，之后插件就会出现在市场里。

## 更新现有插件

1. 修改代码
2. 更新 `package.json` 版本号
3. 更新 `README.md`（如有 API 变更）
4. 构建并测试
5. `npm publish`
6. 提交 git commit 并打 tag：

```bash
git add .
git commit -m "chore(plugin-name): release v0.1.1"
git tag plugin-name@0.1.1
git push origin task/107
git push origin plugin-name@0.1.1
```

## 包含文件控制

`package.json` 的 `files` 字段控制哪些文件进包：

```json
{
  "files": [
    "lib",
    "src",
    "cordis.patch.yml",
    "LICENSE",
    "README.md"
  ]
}
```

`.npmignore` 可排除不想发布的文件（但 `files` 白名单更明确）。

## 常见问题

### Q: 发布后如何撤销？

```bash
# 撤销最近发布的版本（72 小时内）
npm unpublish dsh-plugin-taskboard@0.1.1

# 不建议撤销，而是发布修复版本
npm version patch
npm publish
```

### Q: 如何发布 beta 版本？

```bash
npm version 0.2.0-beta.1
npm publish --tag beta

# 用户安装：
dsh plugin --profile web add dsh-plugin-taskboard@beta
```

### Q: 如何同步发布所有插件？

```bash
# 脚本示例（需要在项目根目录）
for plugin in taskboard canvas mobile-bridge repopanel otools-git automation longread; do
  cd plugins/dsh-plugin-$plugin
  npm version patch
  npm publish
  cd ../..
done
```

### Q: 发布前如何本地测试？

```bash
# 打包为 tarball
npm pack

# 在 dsh 里安装这个 tarball
dsh plugin --profile web add ./dsh-plugin-taskboard-0.1.0.tgz
```

## 发布记录

维护发布日志在各插件的 `CHANGELOG.md`（待创建）或 git tags：

```bash
# 查看所有插件相关的 tags
git tag | grep plugin
```

## 自动化发布（未来）

可考虑用 GitHub Actions 自动发布：

1. PR 合并到 main
2. 检测 `plugins/*/package.json` 版本变化
3. 自动运行 `npm publish`
4. 创建 GitHub Release

当前所有发布都是手动执行。
