# DSH Desktop Ultra

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Tauri 桌面外壳

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app/)

把官方开源的 DeepSeek Harness（`dsh`）装进一个原生窗口。**只做桌面打包，不做任何功能改动。**

## 项目边界（硬约束）

这是一条不可协商的项目原则，不是权衡后的取舍：

> **完全尊重上游官方功能。本项目不修改、不增删、不"改良" DeepSeek Harness 的任何功能行为，只把它打包成桌面应用。**

具体含义：

- **不 fork、不改上游代码。** 直接安装 npm 上未经修改的 `@deepseek-ai/dsh`，只锁定版本号。
- **不代理、不拦截、不转换。** 外壳不碰模型请求、不改提示词、不插手工具调用、不动会话数据。dsh 怎么跑，装了这个外壳还是怎么跑。
- **不做自己的 UI。** dsh 自带完整 Web UI，外壳原样加载它，不注入 CSS、不替换组件、不加自定义主题。
- **不"顺手修" bug。** 上游的行为哪怕看起来是错的，也不在这里绕过。修 bug 请提到 [上游仓库](https://github.com/deepseek-ai/deepseek-harness/issues)。
- **不加功能。** 觉得 harness 缺什么，请去上游提；写成 harness 插件也行 —— 那是它设计好的扩展方式（[插件生态](https://github.com/0xsline/awesome-deepseek-harness)）。

外壳**只**做 dsh 自己做不到的事：原生窗口、找到 Node、装对版本、把进程拉起来并在退出时收干净、给外壳自身推更新。

**为什么要立这条规矩**：偏离它的成本会立刻显现 —— 一旦外壳里存在任何一处对上游行为的改动，「上游更新」就不再是改一个版本号，而是每次都要重新对齐一遍改动、处理冲突、回归测试。这个项目的全部价值就在于升级成本接近于零。加一个"小小的改良"，等于把这个价值换掉。

功能上的问题请分清归属：**进入 dsh 界面之前**的问题（窗口起不来、找不到 Node、装不上、更新异常）属于本仓库；**进入之后**的一切（模型、工具、会话、插件、界面）属于上游。

### 唯一的例外：首启问一次要不要装内置插件

安装包里带了九个本仓库自己写的 dsh 插件，首次启动时在启动页各问一次要不要装，复选框**默认全部勾选**。一栏一栏写清它们对 agent 做了什么 —— 这才是需要单独说明的地方：

| 插件 | 它对 agent 做了什么 |
| --- | --- |
| [任务看板](./plugins/dsh-plugin-taskboard) | **确实会改变 dsh 的行为**：给 agent 增加六个 `taskboard_*` 工具，往系统提示里加一段工作协议，在侧栏加入口。 |
| [无限会话画布](./plugins/dsh-plugin-canvas) | 只在侧栏加一块画布：区域按工作区/智能体聚会话、卡片钉住单个会话、便签记想法。不注册工具、不写系统提示，**agent 的行为一个字都不变**。 |
| [手机遥控](./plugins/dsh-plugin-mobile-bridge) | 扫码把 [MCode](https://getmcode.lingyun.net) 手机 App 配对到这台机器，在手机上看会话、发消息、批准工具调用。不注册工具、不碰系统提示，但确实在 dsh 里多开了一个只认令牌的监听，另有一条自己的边界，见下。 |
| [仓库面板](./plugins/dsh-plugin-repopanel) | 看工作区 origin 远端那个仓库的 issue / PR，把其中一条交给 agent 变成任务。不注册工具，但**会往系统提示里加一段纪律**：从远端取回的内容是不可信数据。 |
| [章鱼Git](./plugins/dsh-plugin-otools-git) | 完整的本地 Git 客户端：暂存、提交、历史与分支图、diff、分支标签贮藏远端子模块工作树、推送拉取。不注册工具、不碰系统提示，但**会在你的仓库上执行写操作**。 |
| [自动化](./plugins/dsh-plugin-automation) | 存一段提示词加一张时间表，到点**在没人看着的时候起一次 agent**（或往任务看板上开一张卡）。不注册工具、不碰系统提示，护栏与边界见它自己的 README。 |
| [长文阅读](./plugins/dsh-plugin-longread) | 把一本小说读成一场会话的样子。纯 GUI，不注册工具、不碰系统提示，**agent 的行为一个字都不变**。 |
| [墨鱼终端](./plugins/dsh-plugin-otools-term) | SSH 终端、SFTP 文件管理、端口转发与 SOCKS5、远程桌面启动，AI 命令栏用你在 DSH 里选好的模型。不注册工具、不碰系统提示，但**会拿着你所有服务器的口令**。 |
| [鲨鱼数据库](./plugins/dsh-plugin-otools-dbm) | 十四种数据库的客户端：连接树、数据网格直接改行、表设计器、SQL 工作台、导入导出、备份与同步、AI 大屏。不注册工具、不碰系统提示，但**会存数据库账号密码，并且能对生产库执行写操作与 DDL**。 |

九个都不是必需品：取消勾选就什么都不装，也可以只留想要的那几个。全部支持暗黑模式，自动跟随系统主题。

它为什么还在边界之内：

- **不 fork、不打补丁。** 装的还是 npm 上未经修改的 `@deepseek-ai/dsh`；插件是上游设计好的扩展点，走的是官方入口 `dsh plugin --profile web add`（上游把参数转发给 profile 目录里的 pnpm，再由它自己登记进 `dsh.profile.bundles`）。外壳不碰上游的 profile 清单结构。
- **只问一次，随时可拒。** 每个插件一个复选框，全都取消就什么都不装，并且不再问。没有 pnpm 时连问都不问 —— `dsh plugin` 依赖它。
- **可以移除。** 托盘 → 设置 → 插件里逐个装卸，或者 `dsh plugin --profile web remove <包名>`。装的是打好的 tarball 而不是指向安装目录的符号链接，所以卸载外壳不会弄坏你的 dsh profile。
- **手机遥控不改 dsh 的绑定方式。** dsh 自己照旧只听 `127.0.0.1`；插件另起一个监听，每个有状态请求都要 Bearer token，管理接口只挂在 loopback 载体上。细节与外网接入教程见它的 [README](./plugins/dsh-plugin-mobile-bridge/README.md) 与 [docs/public-access.md](./plugins/dsh-plugin-mobile-bridge/docs/public-access.md)。

代价也写明：升级 `DSH_VERSION` 时要顺手回归这九个插件。`cargo test` 里有一条守卫盯着这件事 —— 任一插件 `package.json` 的 `dsh.compatibility.dshReleases` 里没把锁定版本标成 `compatible`，测试就红。

### 默认全勾上意味着什么

v0.1.5 之前只有前三个进安装包，其余六个只能自己 `dsh plugin add`。现在九个都在安装包里、
默认都勾上，所以把代价一次写清：

- **首启会变慢，慢在最后两个。** 前七个没有运行时依赖，pnpm 解一个本地 tarball 就完事，是
  秒级的。墨鱼终端要 `ssh2`、`ws`、`@xterm/*` 以及可选的 `node-pty` —— SSH 协议与终端模拟器
  都不该手搓；PTY 是可选依赖，装不上时本地终端退化成管道模式并明说。鲨鱼数据库要一整套数据库
  驱动（`mysql2`、`pg`、`ioredis`、`mongodb`、`tedious`…，全是纯 JS，SQLite 用 Node 内置的
  `node:sqlite`），Oracle 与 Snowflake 是可选依赖，缺了在界面上说明。这两个要从 npm 拉包，
  所以外壳给它们的耐心是 10 分钟，其余七个是 3 分钟。不想等就在首启取消勾选，之后在设置页
  里随时能装。
- **一个装失败不拖累别的。** 每个插件都是独立的一次 `dsh plugin add`，失败只记一笔日志，
  服务照常拉起；失败的那个之后可以在托盘 → 设置 → 插件里重试。
- **它们仍然是 npm 上的独立插件。** 这个仓库是源码与发布出口，走 npm 发布到插件市场，和任何
  第三方 dsh 插件一样；在别的 DSH 版本上手动安装见 [PLUGINS.md](./PLUGINS.md)。CI 会检查九个
  都能构建、测试通过、`lib/` 与 `src/` 同步，这样它们不会烂在仓库里。
- **拿着你口令的是那两个。** 墨鱼终端存服务器口令，鲨鱼数据库存数据库账号密码 —— 都在 DSH
  家目录下单独的 0600 文件里，浏览器只知道「有没有」，细节见各自的 README
  （[墨鱼终端](./plugins/dsh-plugin-otools-term/README.md)、
  [鲨鱼数据库](./plugins/dsh-plugin-otools-dbm/README.md#安全边界)）。勾上它们等于同意这件事。
- **有几件事默认装进每台机器都值得你先看一眼**：仓库面板要连 GitHub、要存令牌；章鱼Git 会在
  你的仓库上执行写操作（提交、重置、推送）；鲨鱼数据库能对生产库执行写操作与 DDL；自动化会在
  **没人看着的时候启动 agent**（它自己的 README 写清了护栏与边界）；长文阅读是个摸鱼工具。
  这些都写在启动页每张卡片的说明里，不勾就不装。
- **界面语言参差。** 任务看板、无限画布、手机遥控、仓库面板、墨鱼终端是中英双语；鲨鱼数据库
  自带八种语言（复用了参考实现的词表）；章鱼Git、自动化与长文阅读目前只有中文，见「界面语言」。

## 职责划分

| 外壳负责 | 交给 dsh（外壳完全不介入） |
| --- | --- |
| 原生窗口、图标、任务栏、托盘 | 全部 UI 与主题外观 |
| 窗口生命周期（关窗缩托盘） | 模型、工具、技能、会话、插件 |
| 找到并校验 Node 运行时 | API Key 与所有配置 |
| 安装并锁定 dsh 版本 | 聊天、Agent 循环、沙盒 |
| 拉起并监护 dsh 进程 | — |
| 外壳自身的自动更新 | — |

### 窗口与托盘

点关闭按钮**不退出**，而是把窗口收进系统托盘，dsh 服务继续在后台运行 —— 下次打开是秒开，不用再等启动。

- 单击托盘图标：显示窗口
- 右键托盘图标 → **设置**：打开一个独立的设置窗口（更新、插件、版本信息、复制诊断信息）
- 右键托盘图标 → **退出**：这是**唯一**真正退出的入口，会停掉 dsh 进程

### 设置窗口

跳转到 dsh 界面之后，那个 webview 就是 dsh 的页面（远程源，按 capability 设计拿不到任何 IPC 权限），
所以外壳自己的东西都收在这个独立窗口里：

- **更新**：外壳每 30 分钟自动检查一次；发现新版本会把托盘 tooltip 与菜单项文字改掉
  （不弹系统通知、也不自动下载——那两件事该由你决定）。点「下载并安装」才会动手，带下载进度。
  安装前会先收掉 dsh 子进程：Windows 上更新器启动安装器后会直接结束进程，那是唯一的机会，
  否则会留下占着端口的孤儿 node。装完 Windows 由安装器自己把应用拉起来，macOS / Linux 由外壳重启。
- **语言**：中文 / English，见下面「界面语言」。
- **插件**：内置插件都可以在这里逐个装或卸，不必开命令行。状态以 dsh profile 落盘的 `bundles` 为准，
  所以你自己在命令行改过它，这里显示的也是真实状态。改完要重启 dsh 服务才生效，窗口里有按钮。
- **版本信息**：外壳版本、dsh 锁定/已装版本、实际选中的 Node 路径与版本、运行时目录。
- **复制诊断信息**：和启动失败页那个按钮同一份内容。

这一条是窗口生命周期，属于外壳职责，不涉及 harness 的功能行为：dsh 不知道也不关心自己的 UI 是否可见，没有改它一行代码、没有拦截任何请求。顺带一提，上游 `dsh web` 本来就是"关掉浏览器标签页、服务继续跑"，所以关窗不杀服务反而更接近上游语义。

### 界面语言

外壳自己的界面支持中文和英文，设置窗口和启动页都能切。首次启动没有偏好时按系统语言猜一次
（读 `DSH_DESKTOP_LANG` / `LC_ALL` / `LC_MESSAGES` / `LANG`，都认不出就用中文），
选择存在 `preferences.json` 里——和插件的决定档一样放在运行时目录**外面**，升级 dsh 不会洗掉它。

切完立刻生效的是：托盘菜单与 tooltip、设置窗口、启动/错误页、以及外壳自己抛出的所有报错。

**dsh 自己的界面不在范围内**，那是上游的东西（见「项目边界」）。任务看板、无限画布、手机遥控、
仓库面板、墨鱼终端这五个插件的界面则跟着走：外壳在拉起 dsh 时把语言写进子进程的 `DSH_DESKTOP_LANG`，
插件的 host 半边读它，再通过各自的接口发给浏览器半边。这条路只在**启动时**读一次，所以在设置里
切完语言，要按一下「重启 dsh 服务」插件才会跟着变——设置页会在切换后直接把那个按钮显示出来。

单独安装（不经外壳）的插件也能用：环境变量不存在时它们退化到 `navigator.language`，认不出再退到中文。

**章鱼Git、自动化与长文阅读还只有中文。** 它们是双语化那一轮之后并行加进来的，没跟上；
v0.1.5 起三个都进安装包，所以英文界面下会看到三块中文面板。补齐是一件独立的事。

## 打包层面的两个取舍

上面那条边界不容变动；下面这两个是纯粹的打包/分发决策：

**1. 不分发 Node，用用户系统上的。**
安装包因此只有几 MB，但要求用户自备 Node ^22.19 或 >= 24。找不到或版本过低时，外壳给出带下载链接的指引页，而不是一句「启动失败」。可用环境变量 `DSH_DESKTOP_NODE` 指定 node 路径（图形化启动时继承到的 `PATH` 常常看不到 nvm/fnm 装的 node）。

**2. 外壳自带的前端只有一个启动/错误页。**
dsh 就绪后 webview 整体跳转到 `http://127.0.0.1:<port>`，此后画面完全属于 dsh。代价是跳转之后外壳无法再显示自己的错误页（详见「已知限制」）。

## 上游更新怎么做

改一个常量，就这样：

```rust
// src-tauri/src/upstream.rs
pub const DSH_VERSION: &str = "0.1.1-rc.2";  // ← 改这里
```

然后照常发版。用户下次启动时，外壳发现私有目录里装的版本和锁定值不一致，就会自动重装。

因为外壳对 harness 零改动，升级不需要对齐任何 diff —— 这正是上面那条硬约束换来的东西。

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
检查 dsh 版本 ──不匹配──→ npm install 到私有 prefix ──失败/超时──→ 指引页（网络 / registry）
    │                        ↑ 首次约 200MB、450+ 个包，实测可达数十分钟
    │
首启且有 pnpm → 启动页问一次内置插件（默认勾选）→ dsh plugin --profile web add file:<tarball>
    │              ↑ 与安装进度同屏，装完按当前勾选继续；失败只记进诊断，不阻断启动
    │
分配空闲端口 → node <dsh>/lib/bin.js web --port <port> --host 127.0.0.1 --no-open
    │
轮询端口就绪（实测约 2s；超时上限 90s，进程提前退出则立即报错）
    │
webview 跳转到 http://127.0.0.1:<port>
```

`--no-open` 是必须的：否则 dsh 会在应用窗口之外再拉起系统浏览器。`web` 是上游认可的 `--profile web` 别名 —— 但那个别名只存在于启动路径上，`plugin` 子命令必须写全 `--profile web`。

插件那一步必须在服务起来之前完成：`dsh.profile.bundles` 每次 boot 只读一次（只有 `cordis.patch.yml` 会热重载），装晚了要重启才生效。上游 `add` 成功时不打印任何东西，所以外壳事后读 `~/.dsh/profiles/web/package.json`，确认包名真的进了 `bundles` 才算成功。

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

内置插件会在 `npm run dev` / `npm run build` 前逐个被打成 tarball（`scripts/pack-plugins.mjs` → `plugins/.pack/`），Tauri 以资源形式带进安装包。因此**直接**跑 `cargo check` 需要那个 tarball 已经存在，否则 tauri 的构建脚本会报 `resource path ... doesn't exist`；上面的 `npm run rust:*` 已经替你先打好包。

构建：

```bash
npm run tauri:build
```

## 已知限制

- **关窗后进程仍在后台。** 这是关窗缩托盘的直接代价：dsh 会一直占着内存（node_modules 有 204MB，常驻内存视会话而定）。真正退出必须走托盘右键 → 退出。忘记退出的话它会一直留在后台。
- **首次启动很慢。** dsh 是「一切皆插件」架构，一次要装 450+ 个包、约 200MB。在 npm 缓存已热的机器上实测耗时 **55 分钟**；冷缓存或网络较差会更久。安装期间界面显示已获取包数与已耗时，超过 20 分钟视为卡死并中止。装完之后每次启动只需约 2 秒。
  这是「不分发 Node、运行时装 dsh」的直接代价。要去掉这段等待，得把依赖树预装进安装包（体积涨到几百 MB）。
- **跳转后外壳失去 UI 控制权。** dsh 就绪后窗口交给它的页面，此时若 dsh 进程崩溃，外壳无法再显示错误页 —— 需要从托盘退出再重开。要修的话得改成 dsh 跑在独立 webview 里、外壳保留一层容器。
- **会话格式与 dsh 版本绑定。** 用更新版本的 dsh 写出的会话，当前锁定版本会拒绝加载（报 `SessionFormatUnsupportedError`）。这是上游的保护机制，不是外壳的问题 —— 拒绝加载比错误解析安全。跟进上游版本即可。
- **Node 版本要求会拦住一部分用户。** dsh 的 `engines` 字段是空的，npm 不会代为拦截，外壳的检查是唯一一道闸。
- **内置插件的卸载界面在外壳这边。** 锁定的这个 dsh 版本里，Settings 下的插件页面都是只读的（没有插件市场、也没有卸载按钮），所以移除走托盘 → 设置 → 插件：九个插件在那里逐个有装/卸按钮，每个也列着自己的命令行写法 `dsh plugin --profile web remove <插件名>`（需要 pnpm）。
- **手机遥控插件会开一个局域网监听。** 默认 `0.0.0.0:8790`，只服务带 Bearer token 的窄接口，管理接口不挂在上面。不想要就在首启取消勾选、在设置页移除，或给它配 `lan: false`。往公网暴露前请读它的 [README 安全边界](./plugins/dsh-plugin-mobile-bridge/README.md#安全边界)——**永远不要把 dsh 自己的端口暴露出去**。
- **内置插件依赖 pnpm。** `dsh plugin` 是把参数转发给 pnpm 的，而 Node 只自带 npm。探测不到 pnpm 时外壳干脆不问 —— 不承诺做不到的事。
- **端口分配存在几毫秒的竞态窗口**：拿到空闲端口后立即释放再交给 dsh，极端情况下可能被别的进程抢占，此时 dsh 启动失败并在错误页显示日志。上游支持 `--port 0` 可消除该窗口，但需要解析其 stdout 文本，属于对上游日志格式的静默耦合，故未采用。
- **切语言不会顺带重启 dsh。** 语言是在拉起 dsh 时通过环境变量传给插件的，切换后插件仍是旧语言，要按一下设置页的「重启 dsh 服务」。不自动重启是有意的：那会打断正在跑的会话。dsh 自己的界面不在双语范围内 —— 那是上游的东西。

## 贡献

欢迎打包层面的改进：Node 探测、进程监护、安装包体积、平台兼容、CI、错误指引。

**不接受**任何改动 harness 功能行为的 PR —— 见上面的「项目边界」。想改功能请去 [上游](https://github.com/deepseek-ai/deepseek-harness)，或写成 harness 插件。

## 与上游的关系

本项目是**非官方**的第三方桌面打包，与 DeepSeek 官方无隶属关系。

- DeepSeek Harness 由 DeepSeek AI 开发并以 MIT 许可开源，全部功能与版权归上游
- 本仓库只提供打包与分发，不改动上游任何代码
- harness 自身的问题请提到 [上游 issues](https://github.com/deepseek-ai/deepseek-harness/issues)，不要提到这里 —— 提错地方只会延误修复

## 相关链接

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 上游，MIT
- [Cordis](https://cordisjs.org/) —— harness 的插件内核
- [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) —— 插件生态
- [内置插件安装指南](./PLUGINS.md) —— 在其他 DSH 版本上安装本仓库的九个插件
- [Tauri](https://tauri.app/)

## 许可证

外壳代码：MIT，见 [LICENSE](./LICENSE)。

上游 DeepSeek Harness 亦为 MIT，版权归 DeepSeek AI。本项目在运行时从 npm 安装未经修改的 `@deepseek-ai/dsh`，不重新分发、不内置其代码。
