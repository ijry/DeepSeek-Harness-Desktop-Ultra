# dsh-plugin-ai-switch · AI 切换

把 [ai-switch](https://github.com/ijry/ai-switch) 搬到 DSH web GUI 上：七个平台的账号池、一个本地路由代理（带四种协议之间的双向桥接）、以及对十七个客户端配置文件的安全直写。

**界面是原样复刻的** —— 参考实现那 33.5k 行 React 一个字没改地搬了过来（唯一改动的是 `src/lib/transport/index.ts` 那一个文件，理由写在它的头注释里），用 Vite 打包成单页应用，由插件自己的 host 路由提供服务。换掉的是下面那一半：107k 行 Rust 变成约 1.1 万行 JavaScript，SQLite 变成 JSON 文档，Tauri IPC 变成 HTTP。

```
┌ 侧栏 ─────────┬ 主区 ─────────────────────────────────────────────────┐
│ ▸ Codex       │  账号池 (Codex)     ● 代理运行中 127.0.0.1:19527      │
│   Claude      ├───────────────────────────────────────────────────────┤
│   Gemini      │ ┌──┬─────────────┬──────────┬────────┬──────────────┐ │
│   Grok        │ │≡ │ 中转 A      │ 优先级 1 │ 3 并发 │ 98% · 1.2s   │ │
│   OpenCode    │ │≡ │ 中转 B      │ 优先级 3 │ 0 并发 │ 冷却 47s     │ │
│   OpenClaw    │ │≡ │ 官方账号    │ 优先级 3 │ 1 并发 │ 周额度 62%   │ │
│   Hermes      │ └──┴─────────────┴──────────┴────────┴──────────────┘ │
│ ▸ 会话        │  [ 池内 | 池外 | 已归档 ]        写入客户端配置 ⌄     │
│ ▸ 用量        │  实时日志  200 gpt-5.6-sol → glm-5.3 via 中转A 1.1s  │
└───────────────┴───────────────────────────────────────────────────────┘
```

一个插件 = 两个半边：

- **host 半边**（`exports "."`）跑在 dsh 的 Node 进程里：账号存储、本地路由代理、协议桥接、客户端配置直写、面板事件 WebSocket、静态面板产物。它**不注册任何 agent 工具，也不写系统提示** —— 普通会话里 agent 的行为完全不变。
- **browser 半边**（`exports "./client"`）跑在 web GUI 里：往侧栏放一个图标，点开后在中间栏挂一个同源 iframe。350 行，界面本身在 iframe 里。

## 它到底做什么

一句话：**让本机的 agent CLI 指向一个本地地址，由这个插件决定每个请求实际走哪个上游账号。**

1. 你在面板里加若干账号（中转站的 API key，或导入的官方登录态），拖成一个有序的池。
2. 插件在 `127.0.0.1:19527` 起一个代理，并按平台各发一把 `sk-ai-switch-…` 的 key。
3. 点「写入客户端配置」，插件就地改 `~/.codex/config.toml`、`~/.claude/settings.json` 等等，把地址和 key 填进去 —— **只加自己那一段，别的一个字节不动**。
4. 之后 `codex` / `claude` 跑起来打的就是这个代理：它挑账号、改写模型名、必要时翻译协议、失败了换下一个账号重试、把用量记进账本。

## 五件跟参考实现不一样的事

1. **后端是 Node，不是 Rust**。107k 行变成约 1.1 万行。原样保留了「会动别人文件」那部分的纪律：快照、原子替换、并发修改检测、带哈希守卫的回滚，以及**两个保留格式的编辑器**（`configwrite/toml.js`、`configwrite/yaml.js`）—— 参考实现用 `toml_edit` 做到「改三个键、注释一个不掉」，JS 生态没有能往回写的 TOML 库，所以自己写了一个按行编辑的。会吃掉注释的配置写入，是一次之后就不敢再用的配置写入。
2. **SQLite 变成 JSON 文档**。数据集就是几百个账号行加一个池顺序，开面板时读、用户动作时写；28 个迁移和 sqlx 校验和账本在这里买不到任何东西。**原子写和 0600 保留了** —— 这些文件里有 API key 和 OAuth refresh token。
3. **路由代理自己占端口**（19527，被占就往上找），不挂在 dsh 的 web server 上。三个理由，按重要性排：CLI 需要一个不随 dsh 端口变化的固定地址；dsh 的 server 后面有一道这些 CLI 过不去的鉴权；上游的流式响应挂在同一个 origin 上会吃掉浏览器那六条连接里的一条。
4. **面板事件走 WebSocket**，同样是为了那六条连接 —— 这个仓库里九个插件已经把额度用满过一次，症状不是报错而是整个 GUI 不动。细节见 `host/socket.js` 的头注释。
5. **桌面独占的那一半没有了**：Tailscale 私网、本地 HTTPS（要往系统信任库装根证书）、`ccswitch://` 协议注册、开机自启、带签名的自动更新。每一样都需要一个「已安装的应用程序」，而这是个插件。面板里对应的按钮不是坏的，是按参考实现自己的 `isDesktop()` 分支不显示。

## 平台支持

| 平台 | 路由账号与 API 路由 | 原生配置写入 | 官方导入与额度 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 上游账号流程允许的范围内支持 |
| Gemini CLI | 支持 | 支持 | 支持导入；不声称支持官方额度 |
| Grok | 支持 | 支持 | 上游账号流程允许的范围内支持 |
| OpenCode | 部分：API 账号必须显式给 base URL 和接口格式 | 支持 | 不支持 |
| OpenClaw | 部分：同上 | 支持 | 不支持 |
| Hermes | 部分：同上 | 支持 | 不支持 |

后三个是 agent harness 不是模型厂商，没有自己的官方登录态 —— 「部分支持」的全部含义就是这个。

## 写入哪些文件

十七个客户端目标，每个都是「加一段 provider，别的不动」：

| 目标 | 文件 | 格式 |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` + `ai-switch-model-catalog.json` | TOML（保留注释） |
| Claude Code / Gemini CLI / Grok | `~/.claude`、`~/.gemini`、`~/.grok` 下的 `settings.json` | JSON |
| **DeepSeek Harness** | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` | YAML（保留注释） |
| ZCode（Codex / Claude） | `~/.zcode/v2/config.json` | JSON |
| WorkBuddy / CodeBuddy CLI（各两个平台） | `~/.workbuddy`、`~/.codebuddy` 下的 `models.json` | JSON |
| Qoder CLI（Codex / Claude） | `~/.qoder/settings.json` | JSON |
| OpenCode | `~/.config/opencode/opencode.json` | JSON |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON |
| Hermes | `$HERMES_HOME/config.yaml` | YAML（保留注释） |

第三行值得单独说：**它写的是 dsh 自己的配置**。写完之后 dsh 的 agent 就跑在这个池上，这也是这个插件装在 dsh 里比装在别处更有意思的地方。

## 协议桥接

本地入口四种、上游四种，4×4 全实现（`host/bridge/`）：

| | → chat | → responses | → anthropic | → gemini |
| --- | --- | --- | --- | --- |
| **chat**（`/v1/chat/completions`） | 直通 | ✓ | ✓ | ✓ |
| **responses**（`/v1/responses`，Codex） | ✓ | 直通 | ✓ | ✓ |
| **anthropic**（`/v1/messages`，Claude Code） | ✓ | ✓ | 直通 | ✓ |
| **gemini**（`:generateContent`） | ✓ | ✓ | ✓ | 直通 |

非流式和流式都译，工具调用、思维链、图片、用量计数都过。对角线（`from === to`）是**字节直通**，故意的：绕一趟中间表示会把中间表示没有字段的东西悄悄吃掉（Responses 的 `encrypted_content`、Gemini 的 `safetyRatings`、Anthropic 的 `cache_control`）。

## 安全边界

- **凭据**：API key 和 OAuth token 明文存在 `<DSH 家目录>/dsh-plugin-ai-switch/accounts.json`，0600，原子写。不加密是有意的（密钥只能放同一块盘上）；真正起作用的是文件权限，以及**浏览器永远拿不到明文** —— 列表接口把 `secret_payload_json` 换成 `{"__masked":true}`，编辑时 host 把没重发的密文合回去。
- **配置直写**：路径必须是绝对路径、父目录必须是真目录、目标必须是普通文件 —— **软链接（含 Windows junction）直接拒绝**，那是一次我们没有授权的重定向。写前后各算一次 sha256，写之前再比一次；被别人改过就报 `config.concurrent_modification` 而不是覆盖。原字节留一份 0600 备份，回滚是逐字节还原，且回滚前要求文件仍是我们写的那个哈希。
- **代理只听回环**，`127.0.0.1`。它是一个本地凭据代理，不是网关。请求靠 bearer token 认平台，认不出就 401。
- **客户端 header 不整体转发**给上游 —— 客户端的 `authorization` 是我们自己的代理 key，绝不能出网。只放过 `user-agent`（有中转站按它计费，且不含凭据）。
- **Gemini 与 Grok 的配置里不写凭据**：这两个 CLI 读哪个环境变量当自定义端点的 key，参考实现自己也没验证过，写一个猜的等于白往文件里放一把 key。
- **会话文件只读，且路径受限**：`get_session_messages` 收到的路径要求解析后仍在扫描根内（比较时带路径分隔符，`<root>-secrets` 过不去）。参考实现这里是任意文件读。
- **终端会真的起进程**：Vibe 界面能在你选的目录里跑 `codex` / `claude`。这是它的用途，也是它的风险；插件退出时会杀掉所有会话，不留孤儿进程。

## 与参考实现的行为差异

- **`~/.ai-switch/` 不共用**。桌面版在那里放 SQLite 和自己的 settings；两个不同 schema 的进程写同一个目录、两个路由代理抢同一个端口，是等着发生的数据丢失。插件只拥有 `<DSH 家目录>/dsh-plugin-ai-switch/`。要迁移就用面板里的导入。
- **`secret_storage` 报 `file` 而不是 `keyring`**。插件没有 OS keyring 服务可用，这个仓库里每个插件的密钥都在 0600 文件里。字段还在，值是老实的。
- **`ccswitch_deeplink_compat_supported` 永远是 false**，注册 URL scheme 需要一个已安装的应用。
- **HTTPS 那组命令不提供**。给本地代理上 HTTPS 需要往系统信任库（以及 Linux 上的 NSS）装一张根证书，插件不该做这件事。面板的 HTTPS 面板按 `isDesktop()` 不显示。
- **`node-pty` 是可选依赖**。装上了终端就是真 TTY；没装退化成管道模式，host 侧回显输入，并**在终端里直接写明**「全屏 CLI 不会正常显示」—— 而不是给一个黑框让人猜。
- **YAML 的块序列缩进与 serde_yaml 不同**（`- ` 在父键下缩进，参考实现平齐）。两者解析结果一致，且陈旧检测比较的是我们自己的输出和自己的渲染，所以只是外观差异。
- **额度刷新一次也不会整批失败**：单个账号出错变成一条带 message 的 outcome，这和参考实现一致，但值得写出来 —— 面板是按平台整批刷的。

## 安装

npm 上还没有，先从源码装：

```bash
cd plugins/dsh-plugin-ai-switch
npm install          # ws 是运行时依赖，面板构建要 vite/react
npm run build
cd ../..
dsh plugin --profile web add link:plugins/dsh-plugin-ai-switch
```

装完重启 dsh 服务生效。侧栏会出现一个「AI 切换」图标。

卸载：

```bash
dsh plugin --profile web remove dsh-plugin-ai-switch
```

## 架构

```
src/
  index.js                    cordis 入口：只 inject webServer
  shared/protocol.js          ApiError 信封 + 校验器（面板按 code 分支）
  host/
    routes.js                 命令表（101 条，含桌面功能的诚实禁用状态）+ 路由挂载
    http.js                   信封、body、静态文件
    socket.js                 面板事件 WebSocket（SSE 兜底）
    sdk.js                    DSH 家目录、原子写、语言（不 import @deepseek-ai/*）
    store.js                  JSON 文档存储：原子写、串行化更新、坏文件挪到一边
    platforms.js              七个平台、能力矩阵、十七个目标、CLI 启动器
    accounts.js               账号域 + 池（选号、优先级带、并发、冷却）
    models.js                 模型目录：别名 → 上游名、上下文窗口、Codex 目录文件
    keys.js                   每平台一把代理 key，轮换后旧 key 仍受理
    proxy.js                  本地路由代理：挑号、重试、记账、实时日志
    bridge/                   4×4 协议桥（canon/chat/responses/anthropic/gemini/sse）
    configwrite/
      safewrite.js            快照、原子替换、并发守卫、路径锁
      toml.js  yaml.js        保留格式的编辑器
      adapters.js             十七个客户端适配器
      index.js                协调器：准备 → 提交 → 回滚
    sessions.js  usage.js     读各 CLI 的会话记录与 token 用量
    terminals.js              agent 终端（node-pty 可选）
    settings.js  ledger.js    设置、请求账本
  client/index.js             侧栏图标 + 同源 iframe
webview/                      参考实现的 React 前端 + 七个 Tauri shim
```

## 开发

```bash
npm run check       # 语法检查 + 重建 lib/（跳过 vite）
npm test            # check + node --test
npm run build       # 含面板的完整构建
npm run typecheck   # 面板的 tsc
```

`lib/` 随提交入库（外壳打包时不跑 vite），所以改完 `src/` 或 `webview/` 要 `npm run build` 再提交。

## 界面语言

参考实现自带中英双语，语言存在 `localStorage['ai-switch.language']`。host 半边按 `DSH_DESKTOP_LANG` / `LC_ALL` / `LANG` 判出 `zh-CN` 或 `en`，client 半边把它放进 iframe 的 query，面板的 index.html 在 React 启动前种进那个 key。**在面板里自己切过语言就以你切的为准**。

## 已知限制

- 面板 JS 约 3.4 MB（React + three.js 的 Vibe 座舱 + xterm），首次打开要下。iframe 是点开才建的，不点不下。
- 模型连通性测试已走完整本地链路（客户端协议 → 本地代理 → 模型映射 → 协议桥 → 上游）；结果页会同时展示入口、命中账号、上游接口和原始响应。
- 官方账号的额度刷新覆盖了参考实现的六种端点风格，但官方端点会变；失败会在卡片上写明原因而不是显示 0。
- 用量总览读的是各 CLI 自己的记录文件加本插件的账本；本插件之外发生的请求（直连上游）在账本里没有，这和参考实现一样。

## 许可

MIT。参考实现 ai-switch 亦为 MIT，其许可副本随包发布在 `LICENSE-ai-switch`。
