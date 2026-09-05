# dsh-plugin-mobile-bridge

> 用手机 App（[MCode](https://getmcode.lingyun.net)）遥控桌面上的 DeepSeek Harness。

这是「承接」侧的插件：它在 dsh 里开一个**带鉴权的窄接口**，手机扫码配对之后就能看会话、发消息、看流式回复、批准工具调用。dsh 自己的界面和绑定方式一点不动。

```
手机 MCode App
   │  扫码配对 → Bearer token
   │  REST + SSE
   ▼
dsh-plugin-mobile-bridge  ← 本插件
   │  只调允许清单里的方法（in-process）
   ▼
dsh 自己的 /api（apiProxy）
```

## 装 / 卸

```bash
# 从这个仓库装（开发用）
dsh plugin --profile web add link:plugins/dsh-plugin-mobile-bridge

# 从 npm 装
dsh plugin --profile web add dsh-plugin-mobile-bridge

# 卸
dsh plugin --profile web remove dsh-plugin-mobile-bridge
```

DSH Desktop Ultra 的安装包自带这个插件的 tarball，托盘 →「设置」→「插件」里可以直接装卸，不用命令行。

装完要**重启 dsh 服务**：profile 的插件清单每次启动只读一次。

## 怎么用

dsh 侧栏会多一个「手机遥控」入口，点开是三步：

1. **装 App** —— 扫二维码打开 `https://getmcode.lingyun.net`。
2. **配对** —— App 里「新增连接 → 扫码连接」，扫面板上的配对二维码。配对码**一次一用**，用掉自动换新，30 分钟过期。
3. **从外网连（可选）** —— 面板给出 `cloudflared` 命令；完整教程见 [docs/public-access.md](./docs/public-access.md)。

面板下面还有已配对手机的列表（可单独解除、也可「全部解除并换码」）和这台机器在手机上显示的名字。

## 安全边界

这一节是这个插件最要紧的部分，请读完再往外网暴露任何端口。

**为什么不能直接让 dsh 监听 `0.0.0.0`。** dsh 的 `/api` 前面有一道 loopback 闸：配置面（`settings.*`、`credentials.*`）、拉起系统目录选择器、`agentPreset.read` 这些方法被钉死在本机，上游写明「在有真正的认证层之前 `dsh web --host 0.0.0.0` 不受支持」。把绑定改成全网卡，等于把一个**没有任何认证、带 shell 和文件系统工具的 agent 界面**放到网络上。所以本插件自己起一个监听，dsh 的姿态原样保留。

**接口是白名单，不是过滤器。** [`src/host/bridge.js`](./src/host/bridge.js) 里只有那几个函数，没有通用的 `invoke(method, payload)`，以后也不该有 —— 加一个透传就等于把闸门后面的东西全放出来，只是前面挂了个 token。

**两个载体，权限不同。**

| 载体 | 绑定 | 服务的路由 |
| --- | --- | --- |
| dsh 自己的 web server | `127.0.0.1`（dsh 原样） | 全部，**含 `/admin/*`** |
| 本插件的监听 | `0.0.0.0:8790`（可配） | 除 `/admin/*` 以外全部 |

`/admin/*`（读配对密钥、解除设备）只挂在前者。判断依据是**载体**而不是来源地址 —— 因为 `cloudflared` 这类本地隧道进程连过来也是 loopback，「来自本机」证明不了「来自这台机器前面的人」。两者都要满足才放行。

**因此：往外网暴露时只暴露 8790，绝不要暴露 dsh 自己的端口。** 前者每个有状态请求都要 Bearer token；后者上面的界面没有任何认证。

**其它。** 令牌只存 sha256、比较用 constant-time；配对密钥只在内存里，进程重启即失效；配对失败每分钟最多 10 次；请求体上限 12 MB。

## 协议

前缀 `/dsh-mobile-bridge`，信封统一是 `{ ok: true, value }` / `{ ok: false, error: { code, message, dshCode? } }`。

### 公开

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/hello` | 身份、能力、协议版本。不含任何密钥 |
| POST | `/pair` | `{ code, secret, deviceName? }` → `{ accessToken, refreshToken, target }` |
| POST | `/session/refresh` | `{ refreshToken }` → 新的一对（两半都换） |

### 需要 `Authorization: Bearer <accessToken>`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sessions` | 会话列表 |
| POST | `/sessions` | `{ cwd? \| workspaceId?, agentPreset? }` |
| GET | `/sessions/:id` | 单条列表行 |
| GET | `/sessions/:id/messages?limit=&beforeSeq=` | 一页消息（上限 200） |
| POST | `/sessions/:id/prompt` | `{ text, mode?: 'queue'\|'steer', images? }` |
| POST | `/sessions/:id/cancel` | 停当前回合 |
| POST | `/sessions/:id/rename` | `{ title }` |
| GET | `/sessions/:id/models` | 模型目录 |
| POST | `/sessions/:id/model` | `{ provider, model, reasoningEffort? }` |
| GET | `/workspaces` | 项目列表 |
| GET | `/search?q=` | 跨会话搜索 |
| POST | `/answers` | 回答审批或提问，见下 |
| POST | `/logout` | 吊销自己这台设备 |
| GET | `/events?sessionId=&lastEventId=` | SSE |
| GET (Upgrade) | `/ws?sessionId=&lastEventId=` | 同一条流的 WebSocket 版本 |

同一条事件流有两个载体，不是冗余：SSE 是浏览器和 `curl` 想要的形状，而 WebSocket 是 MCode 的 uni-app 运行时在所有目标平台上都能开的形状（App 端 `EventSource` 不可靠）。帧内容完全一样，只有信封不同 —— SSE 用 `id:` 字段，WebSocket 把它放进 `{ eventId, event, data }`。

WebSocket 握手的令牌按这个顺序找：`Authorization` 头（原生客户端）→ 子协议 `dshm-token.<base64url(token)>`（浏览器没法给 WebSocket 设头）→ `?token=`。握手失败回的是普通 HTTP 401 而不是「先 101 再立刻关」——后者让客户端分不清「令牌不对」和「网络抖动」，会无限重试。

`/answers` 有两种形状，`requestId` 必须是 dsh 发过来的那个 id，原样回传：

```jsonc
{ "kind": "approval", "requestId": "...", "sessionId": "...", "approvalId": "...",
  "outcome": "allowed-once" }            // 或 "rejected"，别的值一律 400

{ "kind": "question", "requestId": "...", "sessionId": "...",
  "answers": [{ "id": "q1", "selected": ["A"], "custom": "别的" }] }
```

### SSE 帧

每帧 `event: frame`，`id:` 是可用于 `Last-Event-ID` 续传的单调序号。类型见 [`src/shared/protocol.js`](./src/shared/protocol.js) 的 `FRAME`：`hello` / `session/added|removed|status|title` / `message/start|delta|end` / `tool/call|result` / `approval/requested|resolved` / `question/requested|resolved` / `turn/end` / `error`。

这些是 dsh `MuxFrame`/`HostFrame` 的**投影**，不是转发。dsh 的流里是事件溯源的原始事件（分块、步骤边界、compaction 的 surface replace），让手机去复刻那套折叠等于把 App 绑死在 dsh 内部词汇上。折叠只做一次，在 [`src/host/projection.js`](./src/host/projection.js) 里 —— 那个文件是纯函数，也是测试最密的地方。

断线重连：客户端带 `Last-Event-ID` 回来，还在环形缓冲（600 帧）里的补发，超出范围时 `hello` 帧里 `gap: true`，此时应该重新拉一次 `/messages` 而不是渲染出一个洞。

## 配对二维码

二维码里是 **base64url 编码的 MCode v2 配置码**，所以 App 现有的扫码路径不用改格式：

```jsonc
{ "version": 2, "name": "书房台式机 的 dsh", "targetAgent": "dsh", "routeMode": "direct",
  "directBaseUrl": "http://192.168.1.20:8790/dsh-mobile-bridge",
  "pairCode": "ABCD-2345", "pairSecret": "...",
  "candidates": ["http://10.8.0.2:8790/dsh-mobile-bridge"] }
```

`routeMode: 'direct'` 配 `pairCode`/`pairSecret` 是这里新增的组合：地址是直连的，凭据要换 —— Bearer token 绝不能放进一张任何人都能拍下来的二维码里。`targetId`、`protocolVersion`、能力列表故意不放进去，客户端第一次请求 `/hello` 就有了，而每多一个字节都会把二维码推到更密的版本，代价是对着屏幕扫的那个人在付。

## 配置

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: dsh-plugin-mobile-bridge
      name: dsh-plugin-mobile-bridge
      config:
        lan: true          # 关掉就只剩本机面板
        lanHost: 0.0.0.0   # 只认 0.0.0.0 和 127.0.0.1
        lanPort: 8790
        displayName: ''    # 空则用主机名
```

## 目录

```
src/
  index.js              cordis 入口（name / inject / apply）
  shared/               两侧共用：codec.js、protocol.js（契约）、qr.js（二维码编码器）
  host/
    bridge.js           调 dsh 的白名单，唯一的对上游耦合点
    routes.js           路由表，一份两挂
    projection.js       dsh 事件 → 手机形状（纯函数）
    stream.js           一份订阅扇出成 N 条 SSE
    auth.js store.js    配对码、令牌、设备档
    http.js net.js      信封/SSE 写入器、局域网地址枚举
    carriers/           listener.js（0.0.0.0）、webserver.js（loopback）、websocket.js（RFC6455 下行）
  client/index.js       浏览器面板，vanilla DOM
docs/public-access.md   外网接入教程
```

## 开发

```bash
npm run check   # 语法检查 + 重建 lib/
npm run build   # 只重建 lib/
npm test        # 58 个测试：QR 编码器、协议、投影、路由端到端
```

零依赖是硬约束：这个包以本地 tarball 形式随桌面外壳分发，由 pnpm 从文件安装，任何运行时依赖都会把「首启装插件」变成一次可能失败的联网操作。二维码编码器因此是手写的（`src/shared/qr.js`），也因此是唯一值得单独验证的数学 —— 测试会把码字从成品矩阵里反读出来，并用一套独立实现的 GF(256) 检查 Reed-Solomon 校验子归零。

同理不从 `@deepseek-ai/*` 运行时导入任何东西：profile 的 node_modules 里一份 npm 镜像副本会遮住 CLI 内部构建，能把 agent 循环搞坏。

## 已知限制

- **`session.fork`、附件下载、队列编辑没做。** 手机上这些手势要么用不上，要么值不回它们的协议面积。
- **一次只有一个 `/events` 环形缓冲**，600 帧。多台手机同时看同一个高频回合，走得最慢的那台可能撞上 `gap`。
- **没有 TLS。** 局域网是明文 HTTP；外网请让隧道或反代终结 TLS，见 [docs/public-access.md](./docs/public-access.md)。
- **`dsh.compatibility.dshReleases` 要手工维护。** 升 dsh 版本前先回归本插件，再把结论写进 `package.json`；外壳的 `cargo test` 有一条守卫盯着这件事。
