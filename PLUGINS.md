# 内置插件安装指南

DSH Desktop Ultra 安装包内置了三个插件（任务看板、无限画布、手机遥控），另有一个插件（仓库面板）发布到 npm。本指南说明如何在其他 DSH 版本（官方 CLI、自建）上安装这些插件。

## 四个插件概览

| 插件 | 包名 | 功能 | 改变 Agent 行为 | 暗黑模式 |
| --- | --- | --- | --- | --- |
| [任务看板](./plugins/dsh-plugin-taskboard) | `dsh-plugin-taskboard` | Agent 工具 + 看板 UI | ✓ 增加 6 个工具 | ✓ |
| [无限画布](./plugins/dsh-plugin-canvas) | `dsh-plugin-canvas` | 会话空间布局 | ✗ 纯 GUI | ✓ |
| [手机遥控](./plugins/dsh-plugin-mobile-bridge) | `dsh-plugin-mobile-bridge` | 手机 App 远程控制 | ✗ 纯接口 | ✓ |
| [仓库面板](./plugins/dsh-plugin-repopanel) | `dsh-plugin-repopanel` | GitHub/GitLab issue/PR | ✗ 纯 GUI | ✓ |

所有插件都支持暗黑模式，自动跟随系统主题（`prefers-color-scheme`）。

## 从 npm 安装（推荐）

这些插件已发布到 npm，直接按包名安装：

```bash
# 任务看板
dsh plugin --profile web add dsh-plugin-taskboard

# 无限画布
dsh plugin --profile web add dsh-plugin-canvas

# 手机遥控
dsh plugin --profile web add dsh-plugin-mobile-bridge

# 仓库面板
dsh plugin --profile web add dsh-plugin-repopanel
```

安装后重启 dsh 服务生效：

```bash
# 如果 dsh web 在前台运行，Ctrl+C 停止后重新启动
dsh web

# 如果在后台运行（如 systemd 服务），重启服务
systemctl --user restart dsh-web  # 示例，实际命令视部署方式而定
```

## 从源码安装（开发用）

克隆本仓库后，用 `link:` 协议指向源码目录：

```bash
# 克隆仓库
git clone https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra.git
cd DeepSeek-Harness-Desktop-Ultra

# 构建插件（每个插件都需要先构建）
cd plugins/dsh-plugin-taskboard
npm run build
cd ../..

cd plugins/dsh-plugin-canvas
npm run build
cd ../..

cd plugins/dsh-plugin-mobile-bridge
npm run build
cd ../..

cd plugins/dsh-plugin-repopanel
npm run build
cd ../..

# 安装（指向本地目录）
dsh plugin --profile web add link:plugins/dsh-plugin-taskboard
dsh plugin --profile web add link:plugins/dsh-plugin-canvas
dsh plugin --profile web add link:plugins/dsh-plugin-mobile-bridge
dsh plugin --profile web add link:plugins/dsh-plugin-repopanel
```

## 卸载插件

```bash
dsh plugin --profile web remove dsh-plugin-taskboard
dsh plugin --profile web remove dsh-plugin-canvas
dsh plugin --profile web remove dsh-plugin-mobile-bridge
dsh plugin --profile web remove dsh-plugin-repopanel
```

## 验证安装

安装后，检查插件是否在 profile 清单里：

```bash
# 查看 web profile 的 package.json
cat ~/.dsh/profiles/web/package.json
```

`dsh.profile.bundles` 数组里应该出现相应的包名。

重启后，打开 dsh web 界面，侧栏应该出现：

- **任务看板** 图标（📋）
- **无限画布** 图标（🎨）
- **手机遥控** 图标（📱）
- **仓库面板** 图标（🗂）

## 兼容性

所有插件在以下 dsh 版本上测试通过：

- `0.1.1-rc.2` ✓
- `0.1.2-alpha.2` ✓（canvas 待验证）

package.json 的 `dsh.compatibility.dshReleases` 字段记录了详细兼容性。

## 注意事项

1. **pnpm 依赖**：`dsh plugin` 命令需要 pnpm。如果系统上没有：
   ```bash
   npm install -g pnpm
   ```

2. **任务看板改变 agent 行为**：装上后 agent 会多 6 个 `taskboard_*` 工具，系统提示里会加入工作协议。其他三个插件纯 GUI，不影响 agent。

3. **手机遥控开启网络监听**：默认监听 `0.0.0.0:8790`。如不需要可在首启时取消勾选，或装完后在设置里移除。详见 [mobile-bridge README](./plugins/dsh-plugin-mobile-bridge/README.md#安全边界)。

4. **仓库面板需要令牌**：GitHub 访问需要 `GITHUB_TOKEN` 环境变量或在设置里配置。GitLab 同理需要 `GITLAB_TOKEN`。

## 发布到插件市场

这些插件已发布到 npm：

- https://www.npmjs.com/package/dsh-plugin-taskboard
- https://www.npmjs.com/package/dsh-plugin-canvas
- https://www.npmjs.com/package/dsh-plugin-mobile-bridge
- https://www.npmjs.com/package/dsh-plugin-repopanel

要让它们出现在 dsh 内置插件市场，需要在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 registry 条目。

## 问题反馈

- 插件功能问题：[本仓库 issues](https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra/issues)
- dsh 本身问题：[上游 issues](https://github.com/deepseek-ai/deepseek-harness/issues)
