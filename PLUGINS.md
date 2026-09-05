# 内置插件安装指南

DSH Desktop Ultra 安装包内置了三个插件（任务看板、无限画布、手机遥控），另有三个插件（仓库面板、章鱼Git、自动化）只能自己装 —— 前两个已发布到 npm，自动化暂时只能从源码装。本指南说明如何在其他 DSH 版本（官方 CLI、自建）上安装这些插件。

## 六个插件概览

| 插件 | 包名 | 功能 | 改变 Agent 行为 | 暗黑模式 |
| --- | --- | --- | --- | --- |
| [任务看板](./plugins/dsh-plugin-taskboard) | `dsh-plugin-taskboard` | Agent 工具 + 看板 UI | ✓ 增加 6 个工具 | ✓ |
| [无限画布](./plugins/dsh-plugin-canvas) | `dsh-plugin-canvas` | 会话空间布局 | ✗ 纯 GUI | ✓ |
| [手机遥控](./plugins/dsh-plugin-mobile-bridge) | `dsh-plugin-mobile-bridge` | 手机 App 远程控制 | ✗ 纯接口 | ✓ |
| [仓库面板](./plugins/dsh-plugin-repopanel) | `dsh-plugin-repopanel` | GitHub/GitLab issue/PR | ✗ 纯 GUI | ✓ |
| [章鱼Git](./plugins/dsh-plugin-otools-git) | `dsh-plugin-otools-git` | 完整本地 Git 客户端 | ✗ 纯 GUI | ✓ |
| [自动化](./plugins/dsh-plugin-automation) | `dsh-plugin-automation` | 定时跑 agent + 运行历史 | ✗ 不加工具，但会无人值守执行 | ✓ |

所有插件都支持暗黑模式，自动跟随系统主题（`prefers-color-scheme`）。前四个插件的界面是中英双语；章鱼Git 与自动化目前只有中文，见下面「界面语言」。

## 界面语言

任务看板、无限画布、手机遥控、仓库面板这四个插件的界面都支持中文和英文（章鱼Git 与自动化还没跟上，它们是双语化之后并行加进来的）。语言按这个顺序定：

1. **`DSH_DESKTOP_LANG`**（`zh` / `en`）。装了 DSH Desktop Ultra 时由外壳设置：它在拉起 dsh
   子进程时把用户在设置里选的语言写进去，插件的 host 半边读它，再通过各自的接口发给浏览器半边。
2. 没有那个变量时看 `LC_ALL` / `LC_MESSAGES` / `LANG`——独立部署（官方 CLI、自建、容器）走这条。
3. 浏览器半边拿不到语言时退到 `navigator.language`。
4. 都认不出就用中文。

所以在别的 dsh 上想要英文界面，起服务时带上环境变量即可：

```bash
DSH_DESKTOP_LANG=en dsh web
```

语言只在**启动时**读一次。装了外壳的话，在设置里切完语言要按一下「重启 dsh 服务」插件才会跟着变。

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

# 章鱼Git
dsh plugin --profile web add dsh-plugin-otools-git

# 自动化
dsh plugin --profile web add dsh-plugin-automation
```

> 自动化还没发布到 npm，上面这条现在会失败；从源码装见下一节。

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

cd plugins/dsh-plugin-otools-git
npm run build
cd ../..

cd plugins/dsh-plugin-automation
npm run build
cd ../..

# 安装（指向本地目录）
dsh plugin --profile web add link:plugins/dsh-plugin-taskboard
dsh plugin --profile web add link:plugins/dsh-plugin-canvas
dsh plugin --profile web add link:plugins/dsh-plugin-mobile-bridge
dsh plugin --profile web add link:plugins/dsh-plugin-repopanel
dsh plugin --profile web add link:plugins/dsh-plugin-otools-git
dsh plugin --profile web add link:plugins/dsh-plugin-automation
```

## 卸载插件

```bash
dsh plugin --profile web remove dsh-plugin-taskboard
dsh plugin --profile web remove dsh-plugin-canvas
dsh plugin --profile web remove dsh-plugin-mobile-bridge
dsh plugin --profile web remove dsh-plugin-repopanel
dsh plugin --profile web remove dsh-plugin-otools-git
dsh plugin --profile web remove dsh-plugin-automation
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
- **章鱼Git** 图标（Git 标志）
- **自动化** 图标（⏱）

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

2. **任务看板改变 agent 行为**：装上后 agent 会多 6 个 `taskboard_*` 工具，系统提示里会加入工作协议。其他五个插件不注册工具、不写系统提示，普通会话里 agent 的行为不变。

3. **手机遥控开启网络监听**：默认监听 `0.0.0.0:8790`。如不需要可在首启时取消勾选，或装完后在设置里移除。详见 [mobile-bridge README](./plugins/dsh-plugin-mobile-bridge/README.md#安全边界)。

4. **仓库面板需要令牌**：GitHub 访问需要 `GITHUB_TOKEN` 环境变量或在设置里配置。GitLab 同理需要 `GITLAB_TOKEN`。

5. **自动化会在没人看着的时候启动 agent**：这是它的全部意义，也是它唯一的风险。它不加工具、不改系统提示，但到点后会在你选的项目目录里真的跑一次 agent（`dsh --profile headless`）。护栏（总开关、超时、并发上限、连续失败自动暂停、无人值守说明、宿主退出即终止子进程）与边界都写在 [automation README](./plugins/dsh-plugin-automation/README.md#安全边界)，装之前值得读一遍。

6. **语言只在启动时读一次**：改 `DSH_DESKTOP_LANG` 之后要重启 dsh 服务。见上面「界面语言」。

7. **章鱼Git 需要 git 可执行程序**：面板会检测，缺失时在界面上直接说明。建议 git 2.31 以上 —— 合并提交的差异需要 `--diff-merges`。仓库列表来自 DSH 的工作区，不需要手动添加；AI 写提交信息用的是 DSH 里已选好的默认模型，不用另配 key。

8. **章鱼Git 与自动化目前只有中文界面**：双语化那一轮做的是外壳与前四个插件，这两个是之后并行加进来的，还没跟上，见上面「界面语言」的说明。

## 发布到插件市场

这些插件已发布到 npm：

- https://www.npmjs.com/package/dsh-plugin-taskboard
- https://www.npmjs.com/package/dsh-plugin-canvas
- https://www.npmjs.com/package/dsh-plugin-mobile-bridge
- https://www.npmjs.com/package/dsh-plugin-repopanel
- https://www.npmjs.com/package/dsh-plugin-otools-git

`dsh-plugin-automation` 还没发布，暂时只能用 `link:plugins/dsh-plugin-automation` 从源码装。

要让它们出现在 dsh 内置插件市场，需要在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 registry 条目。

## 问题反馈

- 插件功能问题：[本仓库 issues](https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra/issues)
- dsh 本身问题：[上游 issues](https://github.com/deepseek-ai/deepseek-harness/issues)
