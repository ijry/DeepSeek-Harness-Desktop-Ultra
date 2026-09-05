# dsh-plugin-canvas

给 DeepSeek Harness Web GUI（`dsh web`）用的**无限会话画布**，语义参考
[codeg-plus](https://github.com/codeg-ai/codeg-plus) 主线的「无限会话」：把工作区、
智能体和会话摆在一块可以无限平移缩放的板子上，用空间关系而不是列表来梳理手上的活。
纯 dsh 插件，不改上游源码，可发布到 dsh 插件市场。

一个插件 = 两个半边：

- **host 半边**（`exports "."`，Node 宿主进程）：单文件账本
  （`<DSH 家目录>/dsh-plugin-canvas.json`）、八个变更、`/dsh-plugin-canvas` 的
  JSON + SSE 路由、以及把 `workspaceRegistry` / `sessionQuery` 归一成一份视图。
- **浏览器半边**（`exports "./client"`，web GUI）：零依赖、纯 DOM 的画布——自己的
  平移缩放、点阵、框选、拖拽、对齐参考线、缩放吸附、工具条与菜单。不引 React，
  不引任何 `@deepseek-ai/*` 浏览器包。

**它不碰 agent。** 与同仓的任务看板插件不同，这个插件不注册任何工具、不往系统提示里
写字、不读也不改会话内容（除了只读地展示正文）。装上它只会多一块看板子的地方，
agent 的行为一个字都不变。

## 画布上有什么

| 节点 | 绑定 | 成员从哪来 |
| --- | --- | --- |
| 工作区区域 `workspace` | 一个 dsh 工作区（`workspaceRegistry` 里的记录） | 该工作区名下的会话 |
| 智能体区域 `agent` | 一个 agent preset id | 用该 preset 起的所有会话 |
| 自定义区域 `custom` | 无 | 手动收进来的会话（存成成员表） |
| 会话卡片 `session` | 一个会话 | —— |
| 便签 `note` | 无 | —— |

与 codeg-plus 的对应关系：`folder` → `workspace`（dsh 把会话挂在工作区上，不是侧栏
文件夹行），`conversation` → `session`，`agent` 仍是 agent 但绑的是 preset id。
codeg-plus 的「文件夹分组」在 dsh 里没有对应概念，**没有硬造**，直接不做。

## 手势与操作

- **平移**：右键拖 / 中键拖（左键拖是框选，所以平移让给这两个），滚轮也平移；
  `Ctrl/Cmd + 滚轮`（含触控板捏合）以指针为锚点缩放，范围 0.1–2。
- **框选**：空白处左键拖，**碰到就算选中**；`Shift/Ctrl/Cmd` 叠加选择。框选时会
  按住不放地压制文本选择，扫过一片标题不会把它们全刷蓝。
- **拖拽**：拖动卡片时实时判定落点——
  - 落到自定义区域 → 收进那个区域（原来是散卡就连卡一起吞掉）；
  - 落到另一张散卡上 → 以静止那张为锚点开出一个两列的新区域，**预览框就是最终框**；
  - 从区域里拖到空白 → 移出成散卡（自定义区域是「移动」，绑定区域是「复制」）；
  - 落回自己所在的区域 → 吸回网格，不产生任何写入。
- **对齐**：Figma 式参考线，两个轴独立判定，取最小修正量；两个轴都没有邻居时退回
  24 单位点阵（点阵吸附不画线——点已经画在那了）。按住 `Alt` 暂停吸附。
- **缩放节点**：区域按**整列整行**步进，松手时把网格形状和框尺寸写在同一个 patch 里；
  便签和展开的会话卡自由缩放。
- **双击**：会话卡展开成正文卡（区域成员会先被移出成散卡再展开——520 宽的窗口塞在
  统一网格里会把整行撕开）；区域标题双击改名；便签双击进入编辑。
- **「+N」**：区域装不下的成员收进底部一行 chrome（是真的一行，不是浮层，所以永远
  不会压住最后一排卡片），点开展开全部，工具条上再收回去。

## 键盘

| 键 | 作用 |
| --- | --- |
| `Cmd/Ctrl + A` | 全选 |
| `Cmd/Ctrl + G` | 把所选收进新区域 |
| `Delete` / `Backspace` | 删除所选（写了字的便签会先问一次） |
| `F2` / `Enter` | 重命名选中的区域 |
| `Escape` | 取消改名/编辑，否则清空选择 |
| `Alt`（按住） | 暂停拖拽吸附 |

## 工具条

左半边常驻：**添加**（新建会话/工作区/智能体/会话卡/自定义区域/便签，会话卡带搜索，
只列最近 15 个；「新建会话」走 GUI 自己的 `POST /api/session.create`，建完直接钉一张卡）、**适应视图**、**自动整理**（货架式排布，按**渲染尺寸**而不是入账尺寸，
展开的卡片才不会压到邻居）。右半边是所选对象的动词：改名、折叠、显示全部/收起、
网格（列数/行数，自动或 1–6）、颜色（12 色，重复点同一色即清除）、移出到画布、
从区域移除、在会话界面打开、展开/收起会话、删除。多选时是计数 + 收进新区域 + 删除。

右下角是导航地图与缩放条（地图开关、缩小、百分比（点一下回 100%）、放大）；
视口、展开状态、地图开关都记在 `localStorage`，回来还是走的时候那样。

## 一致性协议

账本给每次提交分配一个稠密 `revision`，一次提交对应**恰好一个** SSE 事件；空操作
不占号。浏览器侧的规则与 codeg-plus 的 `canvas-store.ts` 完全一致：

- 只有事件流推进 `revision`：`<= 本地`丢弃，`== 本地 + 1`应用，`> 本地 + 1`是缺口
  ——不应用，直接全量对账。
- **响应永不推进 `revision`**，只在自己的事件还没到时作为乐观确认落地。两种到达
  顺序都会收敛，所以不需要「自己发的」这种特例。
- 断线由 `EventSource` 自己重连，重连后再全量对账一次。

## 目录

```text
plugins/dsh-plugin-canvas
├── package.json          # dsh 元数据；exports: "." host / "./client" 浏览器
├── cordis.patch.yml      # 打进 web profile 的插件行
├── src
│   ├── index.js          # host 加载入口：账本 + 路由
│   ├── host/             # store（账本）/ board（八个变更）/ routes（JSON+SSE）
│   │                     # sessions（工作区/会话/预设视图）/ transcript / sdk
│   ├── shared/           # units 板上单位 / layout 网格与货架 / snap 落点与对齐
│   │                     # model 节点记录与校验 / derive 派生图（host 与浏览器共用）
│   └── client/           # 浏览器画布：styles/state/viewport/render/commands/interact/dock
├── scripts/              # wrap-client（把 shared 内联进 loader 包）/ build / check
└── test/                 # node:test：几何 + 领域 + host 行为 + 产物冒烟
```

`src/shared/*` 是唯一的几何真源：host 用 ESM 直接 import，浏览器包由
`scripts/wrap-client.mjs` 在构建时把它们**内联**进去（loader 的 `require` 只认 dsh
模块图，浏览器包没法 import 兄弟文件）。所以不存在「客户端再抄一份」这种漂移。

## 开发与验证

零运行时依赖，无需 `npm install`：

```bash
npm run check    # 语法检查 src/ → 重新构建 lib/ → 再查 lib/（含生成的 client 包）
npm run build    # 复制 host/shared 到 lib/ 并生成 lib/client.js
npm test         # npm run build && node --test
```

测试分四层：`geometry` 钉住板上单位与落点/对齐/整理的具体数值，`model` 钉住节点
记录的校验与派生图，`host` 钉住 revision 协议、崩坏文件隔离与八个变更的不变量，
`client` 把**构建产物**在一个手写 DOM 替身里真的跑起来（注册、挂载、拉数据、画出
节点）——它拦的是「打包之后根本起不来」这一类问题。

## 安装

```bash
# 开发：指向源码目录
dsh plugin --profile web add link:plugins/dsh-plugin-canvas
# 发布后
dsh plugin --profile web add dsh-plugin-canvas
```

DSH Desktop Ultra 的安装包直接带了它的 tarball，首启会问一次要不要装，
也可以在托盘 → 设置 → 插件里装卸。

## 与 codeg-plus 的差距（明写出来）

- **展开的会话卡是只读的。** codeg-plus 的展开卡是一个可以直接聊天的完整会话表面，
  因为那块画布和它的聊天界面是同一个 React 应用。dsh 的 GUI 是另一个编译好的包，
  DOM 插件挂不进它的会话组件，所以这里展示折好的正文，要输入就点 ↗ 交给 GUI 自己的
  会话界面（`ctx.sessions.open(id)`）。
- **「新建会话」只到「建好并钉上」，第一句话要去会话界面说。** codeg-plus 的草稿卡能在
  画布上直接输入并发送，靠的还是同一个应用里的 composer。这里能做的是替你调用 GUI 自己的
  `session.create`、把新会话钉成一张卡——省掉的是「先切过去、再回来找它」。
- **没有导出 PNG。** codeg-plus 用的是把 DOM 转图片的库；这个插件零依赖，不值得为它
  引一个。
- **没有文件夹分组区域**：dsh 没有这个概念。
- **「最近更新」是尽力而为的。** dsh 的会话头只有 `createdAt`；`updatedAt` 取的是会话
  日志目录的 mtime，读不到就退回创建时间。
- **没有撤销。** 与 codeg-plus 一致——也正因为如此，唯一会拦一下的删除是「写了字的
  便签」，其它节点都只是别处东西的排列。
