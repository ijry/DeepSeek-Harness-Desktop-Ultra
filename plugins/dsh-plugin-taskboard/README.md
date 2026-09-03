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
| 待办 `todo` | `todo`、`queued` | 待办、排队 |
| 进行中 `inProgress` | `preparing`、`running` | 认领后准备、执行中 |
| 需关注 `attention` | `awaiting_input`、`review`、`merging`、`failed` | 等你决策、待验收、合并中、失败 |
| 已完成 `done` | `done`、`canceled` | 已验收、已取消（`canceled` 默认隐藏） |

核心规则：

- **验收与退回是人的动作**：`review → done`（通过验收）和 `review → todo`（退回
  重做）只在 GUI 上开放；agent 永远不能把任务移进 `done` / `canceled`。
- **认领纪律**：agent 把 `todo` / `queued` 移到 `preparing` 即认领，任务绑定到
  该会话；已被其他会话持有的任务不能接管，跨项目（workspace）不能认领。
- **版本守卫**：所有“先读后写”的改动都要带 `ifVersion`，冲突即拒绝，避免并发
  覆盖；评论是轻量无版本操作，走串行写队列。
- **每列按最近更新排序**（`updatedAt` 降序），与 codeg-plus 的看板一致。

与 codeg-plus 的边界：本插件不做任务的执行/调度，`merging` 是保留状态（人和
agent 都不可主动移入），任务从认领到交验由 agent 与人在现有会话里协作完成。

## 功能

- **实时看板**：页面挂载后即订阅 `/dsh-plugin-taskboard/events`（SSE），任何一次
  宿主提交（工具或路由触发的写操作）都广播增量，看板自动刷新；浏览器
  `EventSource` 断线自动重连，打开瞬间还会全量对账一次。
- **详情弹层**：点卡片看全量记录（描述、执行 prompt、状态版本、认领人、项目），
  备注区读 agent 的结构化交接报告；Ctrl+Enter 发备注。
- **验收 / 退回 / 编辑 / 移动 / 删除**：`review` 卡片提供「通过验收」与「退回
  待办」（退回可选附意见，单次提交不会留下孤儿评论）；其他卡片可编辑字段、
  移到任意状态（终态只能重开回 `todo`），非活动/非 review 的卡片可删除。
- **项目筛选与计数**：顶部按 workspace（项目）过滤，侧栏按钮带 todo / attention /
  review 滚动计数，多代 UI 选择器兜底挂载。
- **Agent 侧工作协议**：host 启动时把一段“先查板、先读后动、认领/版本纪律、
  交验纪律”注入 agent 系统提示，工具描述与协议文本同源约束。

## 目录

```text
plugins/dsh-plugin-taskboard
├── package.json          # dsh 元数据；exports: "." host / "./client" 浏览器
├── cordis.patch.yml      # 打进 web profile 的插件行
├── src
│   ├── index.js          # host 加载入口：协议段 + 工具 + 路由
│   ├── host/             # store（账本）/ tools（六工具）/ routes（JSON+SSE）/ sdk / protocol-text
│   ├── shared/protocol.js # 纯领域核心：列映射、迁移表、守卫（host 与测试共用）
│   └── client/index.js   # 浏览器看板（vanilla DOM，构建时被包成 loader 模块）
├── scripts/              # wrap-client / build / check
└── test/                 # node:test 领域 + host 行测试
```

## 开发与验证

零运行时依赖，无需 `npm install`：

```bash
npm run check    # 语法检查 src/ → 重新构建 lib/ → 再查 lib/（含生成的 client 包）
npm run build    # 复制 host/shared 到 lib/ 并生成 lib/client.js
npm test         # npm run build && node --test（9 个领域 + host 测试）
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
