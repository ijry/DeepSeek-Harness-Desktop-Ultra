# dsh-plugin-taskboard

给 DeepSeek Harness Web GUI（dsh web）用的“任务看板”插件，看板语义参考
[codeg-plus](https://github.com/codeg-ai/codeg-plus) 的任务看板：agent 在宿主
进程里用 `taskboard_*` 工具领活、干活、交接，人在浏览器看板上实时看到进度并做
验收/退回。纯 dsh 插件，不改上游源码，可发布到 dsh 插件市场。

一个插件 = 两个半边：

- **host 半边**（`exports "."`，Node 宿主进程）：六个 `taskboard_*` agent 工具、
  单文件账本（`<DSH 家目录>/dsh-plugin-taskboard.json`）、写进 agent 系统提示的
  工作协议段，以及 `/dsh-plugin-taskboard` 的 JSON + SSE 路由。
- **浏览器半边**（`exports "./client"`，web GUI）：零依赖、纯 DOM 的四列看板与
  卡片详情，不做 React、不引任何 `@deepseek-ai/*` 浏览器包。

## 看板语义（与 codeg-plus 对齐）

四列、每列背后的状态，以及中文 UI 用的列名：

| 看板列 | 状态 | 说明 |
| --- | --- | --- |
| 待办 `todo` | `todo` | 还没排队的待办 |
| 进行中 `inProgress` | `queued`、`preparing`、`running` | 排队中（等并行额度）、认领后准备、执行中 |
| 需关注 `attention` | `awaiting_input`、`review`、`merging`、`failed` | 等你决策、待验收、合并中、失败 |
| 已完成 `done` | `done`、`canceled` | 已验收、已取消（`canceled` 默认隐藏） |

`queued` 属于**进行中**而不是待办：一次「启动任务」就把卡片从积压推进执行管线，
它要么立刻跑起来、要么等一个并行额度；只有「取消排队」才把它送回「待办」。

核心规则：

- **验收与退回是人的动作**：`review → done`（通过验收）和 `review → todo`（退回
  重做）只在 GUI 上开放；agent 永远不能把任务移进 `done` / `canceled`。
- **认领纪律**：agent 把 `todo` / `queued` 移到 `preparing` 即认领，任务绑定到
  该会话；已被其他会话持有的任务不能接管，跨项目（workspace）不能认领。
  排队中的卡归队列管，抢先认领会顶掉队列排期（详见下文）。
- **版本守卫**：所有“先读后写”的改动都要带 `ifVersion`，冲突即拒绝，避免并发
  覆盖；评论是轻量无版本操作，走串行写队列。
- **每列按最近更新排序**（`updatedAt` 降序），与 codeg-plus 的看板一致。

与 codeg-plus 的边界：本插件只负责「何时为哪张卡启动任务（入队后开会话）」（并行队列），不接管任务
内部的执行编排；`merging` 是保留状态（人和 agent 都不可主动移入），任务从认领到交验
由 agent 与人在会话里协作完成。

## 功能

- **实时看板**：页面挂载后即订阅 `/dsh-plugin-taskboard/socket`（WebSocket），任何一次
  宿主提交（工具或路由触发的写操作）都广播增量，看板自动刷新；断线 2 秒后重连，
  打开瞬间还会全量对账一次。没有 upgrade 钩子的 DSH 构建自动退回同样帧的
  `/dsh-plugin-taskboard/events`（SSE）。
  **为什么优先 WebSocket**：浏览器对每个源只给约 6 条并发 HTTP/1.1 连接，DSH 的
  GUI 和所有面板插件共用 `dsh web` 那一个源，而一条常驻 SSE 会按住一条连接直到
  面板卸载 —— 插件装齐之后额度就没了，之后这个源上任何请求（会话列表、选工作区的
  文件夹对话框）都只是排队，不报错也不超时。WebSocket 走独立的连接池。
- **详情弹层**：点卡片看全量记录（描述、执行 prompt、状态版本、认领人、项目），
  备注区读 agent 的结构化交接报告；Ctrl+Enter 发备注。
- **验收 / 退回 / 编辑 / 移动 / 删除**：`review` 卡片提供「通过验收」与「退回
  待办」（退回可选附意见，单次提交不会留下孤儿评论）；其他卡片可编辑字段、
  移到任意状态（终态只能重开回 `todo`），非活动/非 review 的卡片可删除。
- **启动任务 + 并行队列**：**待办（todo）** 卡片的右下角直接有一个「启动」按钮，
  详情弹层里也有同名按钮——点它**只做一件事：入队**（`todo → queued`，卡片移到
  「进行中」列），不等待、不建会话。真实会话由**队列调度器异步发起**：它通过 dsh
  `sessionController` 服务（`session.create` + `session.prompt`）为排到空位的卡片开一场
  会话，把任务 prompt 作为首条消息排进去，并引导新会话按看板协议先认领再动手。
  点「启动任务」立刻返回；**有空位就随后开会话，没空位就停在「排队中」**（卡片上留一条
  「已启动，正在排队等待空位（当前并行 N/M）」的备注），
  等任何一张卡让出额度（交验、验收、失败、取消排队）后自动补位。把「入队」与「开会话」
  拆成两步是有意的：接口立刻回，且重开界面、甚至重启外壳之后队列仍能自己接着往下排。
  已经排到额度（有会话）的卡片不再显示该按钮，避免同一张卡排上两个会话；要退回去就点
  「取消排队」（`queued → todo`，只对还没有会话的卡开放——dsh 没有终止会话的接口，
  放行一张已经有会话的卡只会留下一场没人管的会话）。没有 sessionController 的 dsh
  组合里该操作明确报 `unavailable`，看板其余功能不受影响。
- **并行上限可调**：工具栏右侧的「并行上限」直接改 `settings.maxParallel`
  （默认 3，取值 1–20，随账本持久化）。旁边实时显示「并行 2/3 · 排队 1」。
  调大立刻把排队卡放出去，调小只是让下一轮调度提前收手（正在跑的会话不会被掐掉）。
- **项目筛选与计数**：顶部按 workspace（项目）过滤，侧栏按钮带 todo / attention /
  review 滚动计数，多代 UI 选择器兜底挂载。
- **Agent 侧工作协议**：host 启动时把一段”先查板、先读后动、认领/版本纪律、
  交验纪律”注入 agent 系统提示，工具描述与协议文本同源约束。
- **暗黑模式支持**：自动跟随系统主题（`prefers-color-scheme`），在浅色与深色模式下
  提供一致的阅读体验，无需手动切换。

## 目录

```text
plugins/dsh-plugin-taskboard
├── package.json          # dsh 元数据；exports: "." host / "./client" 浏览器
├── cordis.patch.yml      # 打进 web profile 的插件行
├── src
│   ├── index.js          # host 加载入口：协议段 + 工具 + 路由
│   ├── host/             # store（账本）/ queue（并行队列调度）/ tools（六工具）/ routes（JSON+SSE）/ socket（WS 推送）/ sdk / protocol-text
│   ├── shared/protocol.js # 纯领域核心：列映射、迁移表、额度与守卫（host 与测试共用）
│   └── client/index.js   # 浏览器看板（vanilla DOM，构建时被包成 loader 模块）
├── scripts/              # wrap-client / build / check
└── test/                 # node:test 领域 + host 行测试（含队列调度）
```

### 队列是怎么跑的

账本（`ledger.json`）里除了 `tasks` 还有 `settings`：

```jsonc
{ "revision": 12, "settings": { "maxParallel": 3 }, "tasks": [ /* … */ ] }
```

一张卡占一个「额度」当且仅当 `preparing`/`running`/`awaiting_input`/`merging`（会话在
干活），或者它是**已经有会话**的 `queued`（会话已建好、等 agent 认领）。只有「还没有
会话的 `queued`」不占额度——它就是排队等空位的那张，把它也算进去队列就永远等不到空位。

调度只有一个入口 `pump()`（`src/host/queue.js`）：串行、可重入、FIFO，每次账本提交后
由订阅者触发，插件加载时也会跑一次（重启后接着排）。流程固定为「先入队、再调度」：
`todo → queued` 是账本事实，会话是外部副作用，反过来在两次写之间崩掉会留下一场没有
任何卡片引用的会话。某张卡开会话失败时只记一次失败并结束本轮（绝不自旋重试），失败
原因会通过 launch 接口回给用户。

## 开发与验证

零运行时依赖，无需 `npm install`：

```bash
npm run check    # 语法检查 src/ → 重新构建 lib/ → 再查 lib/（含生成的 client 包）
npm run build    # 复制 host/shared 到 lib/ 并生成 lib/client.js
npm test         # npm run build && node --test（领域 + host + 队列调度 + i18n 测试）
```

构建产物 `lib/client.js` 是 `src/client/index.js` 的模块加载器包装：

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-taskboard',
  factory: (require) => {
    var module = { exports: {} }
    // …src/client/index.js 原文…
    return module.exports
  },
})
```

## 安装到 dsh

本仓库的桌面外壳（DSH Desktop Ultra）会把这个插件打成 tarball 带进安装包，首次启动时
在启动页问一次要不要装（默认勾选，取消就不装且不再问）。手工安装：

```bash
# 本仓库开发时（宿主进程跑 exports "."，web GUI 跑 exports "./client"）
dsh plugin --profile <profile> add link:plugins/dsh-plugin-taskboard

# 发布到 npm 后直接按包名安装
dsh plugin --profile <profile> add dsh-plugin-taskboard
```

重启 `dsh web` 后，侧栏会出现任务看板入口（紧挨「新建会话」），点击后主会话区
切换为看板视图；agent 侧多出 `taskboard_list / taskboard_get / taskboard_create /
taskboard_update / taskboard_move / taskboard_comment` 六个工具。

## 发布到 dsh 插件市场

包元数据已带 `dsh-plugin` keyword、`dsh`（bundle/client/compatibility）段和
`cordis.patch.yml`，直接走 npm 发布：

```bash
npm publish
```

让包出现在 dsh 内置「插件市场」（dshmarket 的策划目录）里，还需要在
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
仓库提交一条 registry 条目——市场和网站都会自动收编（通常一天内）。此后用户在
Settings → Plugin Market 里检索、一键安装即可。

注意版本差异：桌面外壳锁定的 dsh 0.1.1-rc.2 里，Settings 下的插件页面还是只读的
（`dsh-host-plugin-inventory` 与 `ui-settings-plugin-inventory` 都明确写了不做增删启停），
没有市场也没有卸载按钮。在那个版本上，安装与移除都只能走 `dsh plugin`。
