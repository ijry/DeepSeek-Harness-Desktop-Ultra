# `dsh-plugin-otools-socket` 共享总线与 MCode 插件平台设计

**日期：** 2026-09-07  
**状态：** 已完成设计讨论，书面设计待用户最终审阅  
**涉及仓库：** `dsh-desktop-ultra`、`mcode/mcode-app`

## 1. 背景与目标

DSH 外壳和全部面板插件共用一个 HTTP/1.1 origin。常驻 SSE 会占用浏览器约六条同源 HTTP 连接，多个插件同时打开后，后续请求可能无限排队。当前五个插件已改为各开一条 WebSocket，但插件数量增长后会形成 N 条连接、N 套重连和 N 份协议实现。

本项目新增隐藏基础插件 `dsh-plugin-otools-socket`，把桌面插件事件收敛到一条内部控制通道，并提供默认关闭、经配对认证的独立外部入口。MCode 使用同一个 DSH 连接、同一组凭据和同一条控制 WebSocket，承载会话能力和第三方插件能力。第三方插件通过公开注册契约及声明式 UI 接入，无需修改总线核心。

目标：

- 页面内所有支持插件复用一条常驻控制 WebSocket。
- 第三方插件可动态注册事件、命令、catalog 和声明式页面。
- 外部 APP 经明确启用、一次性配对和设备令牌访问总线。
- 内外通道分离，Cloudflare Tunnel/ngrok 只映射独立外部端口。
- 大流量通过按需临时通道传输，不阻塞控制消息。
- MCode 在全部 uni-app 平台使用同一协议，并按平台能力分级。
- 最终覆盖除 Canvas 外的七个用户插件；Canvas 仅迁移内部连接。

非目标：

- 不兼容旧 `/dsh-mobile-bridge` v1。
- 不迁移 `dsh-plugin-mobile-bridge.json`；升级后重新配对。
- 不加载第三方插件提供的 HTML、JavaScript、模板表达式或自定义渲染器。
- 不把整个 DSH Web 服务暴露到 LAN 或公网隧道。

## 2. 总体架构

采用“单一总线所有者 + 能力适配器”结构。

### 2.1 `dsh-plugin-otools-socket`

该插件是唯一总线所有者：

- 作为隐藏基础插件自动安装在其他内置插件之前，不显示普通插件卡片。
- 在 DSH 随机 loopback 端口上注册内部共享 WebSocket。
- 可选监听独立外部地址，默认关闭，默认 `0.0.0.0:8790`。
- 独占配对、设备令牌、catalog、请求路由、错误隔离、背压和临时数据通道职责。
- 使用独立 ledger `dsh-plugin-otools-socket.json`。
- 提供 Cordis 服务 `otoolsSocket`，业务插件通过可选注入注册 source。

### 2.2 业务插件

插件使用嵌套注入，以免形成硬依赖：

```js
ctx.inject(['otoolsSocket'], (socketCtx) =>
  socketCtx.otoolsSocket.registerSource({
    id: 'dsh-plugin-taskboard',
    protocolVersion: 1,
    exposure: 'paired',
    catalog,
    hello,
    onRequest,
  })
)
```

`registerSource()` 返回 disposer；Cordis 在插件或服务卸载时自动清理。总线晚加载时，注入 fiber 自动激活；没有总线时，插件其余功能照常运行。

暴露级别：

- `internal`：只允许 DSH 同页客户端访问；默认值。
- `paired`：进入外部 catalog，并允许已配对设备请求。

Canvas 固定为 `internal`。插件必须显式选择 `paired`，防止接入内部总线时意外暴露数据。

### 2.3 `dsh-plugin-mobile-bridge`

该插件降为能力适配器：

- 保留桌面“手机连接”面板，管理启停、二维码和设备撤销。
- 本地管理接口委托 `otoolsSocket` 服务。
- 会话、审批、提问、工作区和模型能力注册为一个 `paired` source。
- 删除自己的外部 listener、凭据存储和 v1 外部协议。
- 未安装该插件时，内部总线正常，只缺少图形化配对入口及会话 source。

### 2.4 MCode

MCode 保留单一 `targetAgent: 'dsh'`：

- 一条连接记录、一份 access/refresh token、一条控制 WebSocket。
- 会话事件与插件事件共享连接。
- 只实现新协议，不回退 `/dsh-mobile-bridge` v1。
- DSH 连接详情新增“插件”页签，不增加 App 一级插件入口。
- 更新后用户重新配对一次。

## 3. 生命周期与失败策略

基础插件安装失败不得阻止其他插件启动。业务插件的桌面客户端使用以下顺序：

1. 等待页面级 `otoolsSocket` 客户端服务的短暂宽限。
2. 成功时订阅共享总线。
3. 基础服务缺失或不可用时，退回插件自有 WebSocket。
4. 自有 WebSocket 无 upgrade 支持时，再退回 SSE。
5. 基础服务晚加载时接管订阅，并关闭旧载体。

MCode 外部服务在基础插件失败时不可用；“手机连接”面板必须显示明确安装或启动错误。

## 4. 控制协议

总线信封版本为 v2；source 业务协议独立版本化。

```json
{
  "v": 2,
  "kind": "request",
  "source": "dsh-plugin-taskboard",
  "requestId": "01J...",
  "name": "task/create",
  "data": {}
}
```

`kind` 集合：

- `hello`：连接身份、协议版本、限制、catalog revision。
- `catalog`：当前可见 source 的完整快照。
- `subscribe` / `unsubscribe`：订阅 source。
- `event`：source 主动推送。
- `request` / `response`：双向调用，以 `requestId` 关联。
- `cancel`：取消请求，对插件暴露 `AbortSignal`。
- `overflow`：增量丢失，客户端必须重新读取快照。
- `error`：连接级错误；插件请求错误只使用 `response`。

source 注册契约：

```js
registerSource({
  id,
  protocolVersion,
  exposure: 'internal' | 'paired',
  catalog,
  hello(context),
  onRequest(request, context),
})
```

`context` 提供：

- `transport`: `internal` 或 `paired`。
- `deviceId`: 外部设备身份；内部为空。
- `signal`: 取消或断线时触发。
- `issueTransfer()`: 签发临时数据通道。

总线只理解信封、路由、权限、尺寸和生命周期，不理解业务 payload，也不维护插件白名单。

### 4.1 连接和恢复

1. 连接成功后发送 `hello` 和完整 `catalog`。
2. 客户端按页面需要订阅 source。
3. 总线先调用该 source 的 `hello()` 发送基线，再发送增量事件。
4. source 装卸或清单变化使 catalog revision 增加，并重发完整 catalog。
5. source 卸载时，在途请求返回 `source_unavailable`。
6. 重连后重新订阅并获取新快照；严格增量恢复由 source 自己在 payload 中维护 revision。

### 4.2 请求隔离、熔断与背压

- 默认请求期限 30 秒。
- 断线或 `cancel` 中止请求的 `AbortSignal`。
- 单次插件异常只返回该 `requestId` 的稳定错误码和安全消息，不返回堆栈。
- 同一 source 对同一客户端在 60 秒内连续五次超时或协议违规，熔断 30 秒。
- 控制帧上限 256 KiB；声明式页面 catalog 上限 512 KiB。
- 每客户端待发送控制数据上限 1 MiB。
- 低优先级事件可以丢弃并发送一次 `overflow`；响应和 catalog 不丢。无法继续发送时关闭慢客户端，由重连恢复。

## 5. 大流量临时通道

一条常驻控制总线只承载 catalog、状态、命令和进度。文件、终端二进制、数据库导出等通过 `context.issueTransfer()` 签发临时通道：

- 上传/下载：临时 HTTP URL。
- 终端、SFTP 流、数据库流等双向数据：临时二进制 WebSocket。
- ticket 与设备绑定、单次使用，默认 60 秒内必须开始。
- 完成、断开、撤销设备或超时后立即销毁。
- URL 只含随机 ticket，不含长期 token；服务端仍校验设备身份。
- 全部临时路径复用同一外部监听端口，无需额外开放端口。

## 6. 外部认证与网络边界

外部监听默认关闭。开启时只暴露：

- 未认证的最小 `/hello`。
- 限速的一次性 `/pair`。
- `/session/refresh`。
- 已认证控制 WebSocket。
- 已认证临时数据路径。

不暴露 DSH 或其他插件现有 HTTP 路由。

认证规则：

- 配对 code + secret 一次性使用，30 分钟过期，成功后立即轮换。
- access token 默认 24 小时。
- refresh token 默认 90 天；每次刷新时轮换，旧 token 立即失效。
- 服务端只保存 token 哈希。
- HTTP 使用 Bearer token。
- WebSocket 使用子协议携带编码 token，避免出现在 URL、代理日志和浏览历史。
- refresh 失败后要求重新配对，不无限循环。
- 撤销设备立即关闭其全部控制和数据连接，并使 ticket 失效。
- 内部 socket 严格校验同源。
- 外部 socket 不以 Origin 鉴权，只信任设备 token；原生 App 和小程序的 Origin 不稳定。

Cloudflare Tunnel/ngrok 只映射外部端口 8790。

## 7. MCode 平台兼容

- App：支持 LAN `http/ws` 和隧道 `https/wss`。
- H5：保证 `https/wss` 隧道；HTTPS 页面拒绝降级到明文 LAN。
- 小程序：保证平台后台已登记合法域名的 `https/wss`；临时域名是否可用由平台配置决定。

统一传输接口分别适配浏览器 `fetch/WebSocket` 和 `uni.request/uni.connectSocket`。错误必须区分：不可达、TLS/合法域名限制、配对失效、令牌失效、source 不可用和协议不兼容。

原生端优先使用系统安全存储；无法使用安全存储的 H5/小程序退回平台 storage，并在连接详情提示风险。

MCode 重连采用带抖动的指数退避，从 500 ms 封顶到 30 秒；前后台切换时立即重新评估连接。

## 8. 声明式 UI v1

catalog 只承载数据化页面描述，MCode 原生渲染，不执行远端代码。

```json
{
  "id": "dsh-plugin-taskboard",
  "title": "任务看板",
  "icon": "checklist",
  "uiVersion": 1,
  "pages": [
    {
      "id": "board",
      "title": "看板",
      "layout": {
        "type": "kanban",
        "dataRequest": "board/read",
        "itemAction": "task/update"
      }
    }
  ]
}
```

公开组件分层：

- 基础：页面、页签、分区、状态卡、键值列表、徽章、Markdown、空状态。
- 数据：虚拟列表、树、表格、分页、筛选、排序、搜索。
- 输入：文本、数字、布尔、单选、多选、日期、代码编辑器、文件选择。
- 操作：按钮、表单提交、确认框、上下文菜单、批量操作、进度、取消。
- 专业：Kanban、Diff、日志流、终端、文件树、电子书阅读器、SQL/数据网格。

专业组件仍是公开 schema，第三方插件可复用；内置插件没有私有渲染特权。

数据绑定规则：

- 组件用 JSON Pointer 读取响应。
- 组件触发固定 request 名称并提交声明字段。
- 不提供表达式语言；条件显示只支持等值、存在性和 capability 判断。
- 写操作声明确认级别：`none`、`confirm`、`danger`。
- MCode 发送前显示插件名、操作名和目标摘要；插件不能关闭危险操作确认。

DSH 连接详情“插件”页签只显示 `paired` 且声明 UI 的 source。无 UI 但有命令的 source 只出现在开发控制台。控制台默认隐藏，需开启开发者模式，可查看 catalog、帧并手工发送 request。

## 9. 三批交付

### 批次 1：基础平台

- `dsh-plugin-otools-socket`、认证、内外通道、catalog、临时数据通道。
- 页面级唯一共享连接与完整降级链。
- MCode 新 DSH v2 driver、扫码配对、凭据保存、插件页签、基础 renderer 和开发控制台。
- `mobile-bridge` 的会话/审批 source 和管理面板迁入新服务。
- Canvas 仅迁移内部事件，不出现在 MCode catalog。

### 批次 2：第一批插件

- taskboard：完整看板、任务 CRUD、状态流转、筛选、批量操作。
- repopanel：仓库、Issue、PR 浏览，关联任务，场景和常驻指令管理。
- automation：规则、触发器、运行历史、日志、启停、手动执行。
- otools-git：状态、分支、Diff、暂存、提交、拉取、推送及已有桌面能力。
- 稳定 Kanban、Diff、树、日志等公开组件。

### 批次 3：第二批插件

- longread：书架、导入、阅读、进度、章节。
- otools-term：SSH、终端、SFTP、隧道；终端和传输走临时通道。
- otools-dbm：连接树、SQL、可编辑数据网格、结构管理、导入导出、备份等。
- 稳定终端、文件树、阅读器、SQL 编辑器和数据网格协议。

“功能对等”指业务能力可从手机到达，但交互按屏幕重排，不要求像素或手势复制。平台不支持的能力明确提示限制，例如手机不能本地启动桌面 RDP/VNC 客户端时，可管理配置和隧道，但不得假装已启动。

## 10. 版本、防漂移与验证

版本层级：

- 总线信封：v2。
- 声明式 UI：v1。
- 每个 source：独立 `protocolVersion`。

两个仓库各保存相同 JSON Schema 与黄金帧样例，并分别运行编码、解码和拒绝测试。`hello` 返回支持版本与限制；版本不兼容时明确提示桌面端与 App 配套升级。

桌面验证：

- source 注册/卸载、暴露隔离、catalog revision。
- 请求取消、超时、熔断、背压。
- token 轮换、设备撤销、ticket 单次消费。
- 真实 Node WebSocket 验证内外握手、多 source 共用连接。
- 基础插件缺失时的自有 WebSocket/SSE 回退。
- 全部内置插件继续执行 `check.mjs + node --test`。
- 根测试覆盖打包清单、共享源码和跨仓库协议样例。

MCode 验证：

- 配置码、配对、刷新、各平台传输适配和重连。
- catalog、schema 校验、危险操作确认和 renderer。
- 单元测试、TypeScript/Vue 类型检查、H5、App-plus 和至少一个主流小程序构建。
- 每批真实链路：桌面启用服务 → MCode 扫码 → 断网重连 → 操作插件 → 撤销设备后立即断开。

## 11. 安装与发布

插件管理模型增加 `hidden` / `infrastructure` 标记。`dsh-plugin-otools-socket` 自动安装但不显示普通卡片，并排在其他内置插件之前。普通插件失败不影响基础服务；基础服务失败不阻止插件降级运行。

发布顺序：

1. 桌面基础平台与新协议，外部服务保持默认关闭。
2. 配套 MCode；旧桌面连接明确提示不兼容。
3. 第一批插件适配。
4. 第二批插件适配。

每批独立提交和验证；基础平台不等待专业组件完成。

## 12. 已明确的取舍

- 单一 DSH 连接，而非会话桥与插件总线两套连接。
- 认证归 `otools-socket`，不迁移旧 ledger。
- 内外入口分离，外部默认关闭。
- 已配对设备可访问所有显式 `paired` source；当前不做逐插件设备授权。
- 通用双向总线，不做任意 HTTP 代理。
- 插件异常按请求隔离，连续违规才熔断。
- 一条常驻控制通道，重流量按需临时通道。
- 所有插件 UI 使用公开声明式协议。
- Canvas 无手机页面。
- 只支持新协议，不兼容旧 mobile-bridge v1。
- MCode 插件入口位于 DSH 连接详情。
