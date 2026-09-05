# dsh-plugin-automation

给 DeepSeek Harness Web GUI（dsh web）用的「自动化」插件，语义参考
[codeg-plus](https://github.com/codeg-ai/codeg-plus) 的自动化：存一段提示词 + 一张时间表，
到点后自己跑一次 agent，把每次运行的结果留成历史。纯 dsh 插件，不改上游源码，
可发布到 dsh 插件市场。

一个插件 = 两个半边：

- **host 半边**（`exports "."`，Node 宿主进程）：单文件账本
  （`<DSH 家目录>/dsh-plugin-automation.json`）、调度循环、把一次触发变成真正的
  agent 运行、以及 `/dsh-plugin-automation` 的 JSON + SSE 路由。
- **浏览器半边**（`exports "./client"`，web GUI）：零依赖、纯 DOM 的自动化列表、
  编辑弹层、模板库与运行历史，不做 React、不引任何 `@deepseek-ai/*` 浏览器包。

**它不给 agent 加工具、不写系统提示**，所以装上之后普通会话里 agent 的行为一个字不变。
它加的是另一样东西：**无人值守执行**。这既是这个功能的全部意义，也是它的风险 ——
见下面的「安全边界」。

## 一条自动化是什么

| 字段 | 说明 |
| --- | --- |
| 名称 / 说明 | 列表上显示的标题与一句话备注 |
| 项目 | dsh 的工作区（workspace）。运行发生在这个目录里 |
| 提示词 | 到点后交给 agent 的内容，最多 20000 字 |
| 触发方式 | `cron`（5 字段 crontab）/ `interval`（固定间隔）/ `manual`（只手动跑） |
| 到点后做什么 | `headless`（真的跑一次会话）/ `taskboard`（只在任务看板建卡） |
| 超时 | 只对 `headless` 有意义，超过就终止，历史里记为超时 |
| 上一次还在运行时 | 跳过这一次，或终止上一次再跑新的 |
| 错过的时间点 | 默认丢弃并记一条「已跳过」；打开后补跑一次 |
| 无人值守说明 | 是否在提示词前加一段「没人能回答你的提问、别做破坏性操作」 |

每次触发都会留下一条运行记录：状态（运行中 / 成功 / 失败 / 超时 / 已取消 / 已跳过）、
触发来源、耗时、退出码、最终回答或错误、以及（能唯一确定时）它产生的那个会话 id。

## 到点后到底发生了什么

**`headless`**：宿主用 dsh 自己的一次性入口跑一个子进程 —

```text
dsh --profile headless "<无人值守说明 + 你的提示词>"    # cwd = 项目目录
```

这是 dsh 官方文档里写明的一次性接口（"run one fresh persisted session, print the
final answer, and exit"）。选它而不是在进程内直接调 `ctx.agents.create(...)`，是因为
CLI 契约是公开且跨版本稳定的，而进程内那条路要依赖 Agent 构造、消息工厂、模型选择安装器
三个内部 API —— 它们一漂移，坏掉的是**半夜没人看着**的定时运行。

代价也写明：

- 每次运行一个独立进程（调度频率下没问题，聊天界面会不合适）；
- **没有按条选 agent 预设或模型**：一次性 CLI 只接受任务文本，运行用的是 headless
  profile 自己的配置。与其放一个点了没反应的下拉框，不如不放；
- 产生的会话是事后从 sessions 目录里认出来的，**只有能唯一确定时才记**（两次运行同时
  在跑时宁可不记，也不给你一个错的链接）。

**`taskboard`**：只调 [任务看板插件](../dsh-plugin-taskboard) 的
`POST /dsh-plugin-taskboard/tasks` 建一张卡，什么都不执行，运行立刻结算为成功并记下卡片 id。
适合「按时提醒我 / 提醒 agent 该做这件事」，执行交给人在会话里接手。

## 安全边界

这是本仓库里唯一会**在没人看着的时候启动 agent** 的插件，所以护栏写在这儿，也做在代码里：

- **总开关**。列表顶部一个按钮停掉所有定时触发，`enabled: false` 存进账本；「立即运行」
  不受它影响（暂停的是时钟，不是你的手）。
- **无人值守说明**。默认在提示词前加一段：没人能回答提问、遇到需要决策的地方选可逆的做法、
  不要做破坏性或对外的操作、结束时总结。内容可以在设置里改，也可以按条关掉。
- **超时**。默认 30 分钟，超时先 SIGTERM，10 秒后 SIGKILL；POSIX 上按进程组、Windows 上
  用 `taskkill /T` 收拾子进程 —— 一次运行会启动工具进程，只杀启动器等于把它们留在仓库里。
- **并发上限**。默认同时最多 2 次，超出的触发记一条「已跳过」而不是排队堆积。
- **不重叠**。同一条自动化默认不会自己撞自己；账本事务里开运行、同时把下一次时间前移，
  所以慢运行不会被下一个 tick 重复触发。
- **连续失败自动暂停**。默认连续 5 次失败就把它停掉并写明原因，手动重新启用会清零连败。
- **宿主退出时终止在跑的子进程**。无人监管的 agent 不该活得比它的监管者更久。
- **重启后不假装成功、也不自动重跑**。加载账本时，上一个进程留下的「运行中」一律变成
  「宿主进程重启，这次运行被中断」，等下一个计划时间自然触发。
- **提示词永远是一个 argv 元素，任何路径都不经过 shell**，所以提示词里的 `$(...)`、`&&`
  不可能变成命令。测试里有一条专门盯这件事。
- **模板都只做诊断与报告**，不提交、不推送、不部署；测试会拒绝含破坏性动作的模板。

它**不做**的事：不改 git 状态（不切分支、不建 worktree、不 commit）、不碰凭据、
不开监听端口、不往外发任何东西。运行就在你选的项目目录当前的状态上发生。

## 时间怎么算

- **5 字段 crontab**：`分 时 日 月 周`，支持 `*`、`a-b`、`*/n`、`a-b/n`、列表，
  月份与星期可以写名字（`jan`、`mon`），`?` 等于 `*`，`7` 和 `0` 都是周日，
  也认 `@daily` / `@hourly` / `@weekly` / `@monthly` / `@yearly` 这类简写。
- **日与星期都限定时按 OR 匹配**（Vixie 规则）：`0 9 13 * 5` 是「每月 13 日**或**每周五」。
  与 crontab 同字符串同含义，这一点是有意保持的。
- **按本机时区计算**。自动化是给自己的工作日排的，宿主就在你的机器上。
  代价写明：夏令时跳过的那个本地时刻当天不触发，重复的那个小时只触发第一次。
- **固定间隔以上一次触发为锚点**，重启不漂移；宿主没运行的时间不计入。
- **错过的时间点最多补一次**，不会把停机期间的每个点都补上（那是运行风暴，不是补跑）。
- 中文描述（「每个工作日 09:00」「每 15 分钟」）和「接下来会在什么时候跑」都由**宿主**回答
  （`GET /preview`）。浏览器里没有第二份 cron 实现，所以表单下的预览和真正触发的时刻
  不可能对不上。

## 功能

- **实时列表**：页面挂载后即订阅 `/dsh-plugin-automation/events`（SSE），任何一次宿主提交
  都广播增量，列表自动刷新；断线自动重连，重连时按 revision 全量对账一次。
- **侧栏角标**：不打开面板也能看到「几条已启用 / 几条最近失败 / 现在有几次在跑」。
- **模板库**：新建时先给几条现成的（每日测试回归、收工前的改动清点、每周依赖巡检、
  近期提交自查、TODO 清理提案、把待办投到看板），选一条就把表单填好，创建前随便改。
- **编辑弹层**：名称 / 说明 / 项目 / 提示词 / 触发方式（含 cron 预设与实时预览）/
  到点后做什么 / 超时 / 三个开关 / 重叠策略，带乐观并发（`ifVersion`，冲突即拒绝）。
- **运行历史**：行内展开最近 20 次，点开看完整最终回答、错误、耗时、退出码、运行目录；
  能唯一确定会话时提供「打开会话」直接跳过去。
- **立即运行 / 终止本次 / 暂停 / 启用 / 删除**：删除会先终止在跑的那一次，再连带删掉历史。
- **设置**：总开关、并发上限、默认超时、每条保留多少运行记录、连续失败自动暂停阈值、
  无人值守说明的正文。
- **暗黑模式支持**：自动跟随系统主题（`prefers-color-scheme`）。

## 目录

```text
plugins/dsh-plugin-automation
├── package.json          # dsh 元数据；exports: "." host / "./client" 浏览器
├── cordis.patch.yml      # 打进 web profile 的插件行
├── src
│   ├── index.js          # host 加载入口：账本 + 调度器 + 路由
│   ├── host/
│   │   ├── store.js      # 单文件账本：串行写队列、原子落盘、快照、账本事务
│   │   ├── engine.js     # 调度循环、在跑表、触发分派
│   │   ├── runner.js     # 起 dsh --profile headless 子进程、超时、取消、认会话
│   │   ├── routes.js     # JSON + SSE 路由
│   │   ├── taskboard.js  # 投递到任务看板（走它自己的 HTTP API）
│   │   └── sdk.js        # dshHomePath / 找到本进程的 dsh 启动器
│   ├── shared/
│   │   ├── cron.js       # cron 解析、下一次触发、中文描述（纯函数）
│   │   ├── protocol.js   # 领域核心：校验、状态机、投影（纯函数）
│   │   └── templates.js  # 内置模板
│   └── client/index.js   # 浏览器面板（vanilla DOM，构建时被包成 loader 模块）
├── scripts/              # wrap-client / build / check
└── test/                 # node:test：cron / 领域 / 账本 / 引擎 / 路由 / 子进程 / 浏览器半边 / 产物
```

## HTTP 接口

同源挂在 dsh 自己的 webserver 上，前缀 `/dsh-plugin-automation`，
信封统一是 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 设置 + 自动化列表（带 `scheduleText`）+ 最近 100 条运行 + 引擎状态 + 项目列表 |
| GET | `/templates` | 内置模板 |
| GET | `/workspaces` | 项目列表 |
| GET | `/preview?kind=&cron=&intervalMinutes=&count=` | 这张时间表的中文含义 + 接下来几次触发时间 |
| GET | `/runs?automationId=&limit=` | 某条的运行历史（默认 50，上限 200） |
| GET | `/run?id=` | 单次运行，**只有这个接口带完整输出** |
| GET | `/events` | SSE：`hello` 一帧带当前 revision，之后每次提交一帧 `change` |
| POST | `/automations` | 新建（body `{ draft }`） |
| POST | `/automations/update` | 全量覆盖（`{ id, draft, ifVersion? }`） |
| POST | `/automations/enabled` | 启用 / 暂停（`{ id, enabled, ifVersion? }`） |
| POST | `/automations/delete` | 删除（`{ id, ifVersion? }`），先终止在跑的那次 |
| POST | `/automations/run` | 立即运行（`{ id }`），返回运行记录（可能是一条 `skipped`） |
| POST | `/runs/cancel` | 终止（`{ runId }`） |
| POST | `/settings` | 合并设置（越界的值会被夹到合法范围） |

错误码到状态码：`invalid_input` → 400，`not_found` → 404，`conflict` → 409，
`no_taskboard` → 502，其余 500。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_HOME` | 账本位置（默认 `~/.dsh`），与 dsh 自己一致 |
| `DSH_PLUGIN_AUTOMATION_DSH_ENTRY` | 手动指定 dsh 启动脚本（`bin.js`）。默认用 `process.argv[1]`，也就是启动本进程的那个启动器；找不到时列表顶部会显示一条警告，`headless` 类型无法执行 |
| `DSH_PLUGIN_AUTOMATION_TASKBOARD_BASE` | 手动指定任务看板的地址。默认用 webserver 自己的端口（定时触发时没有请求可以读 Host 头） |

## 开发与验证

零运行时依赖，无需 `npm install`：

```bash
npm run check    # 语法检查 src/ → 重新构建 lib/ → 再查 lib/（含生成的 client 包）
npm run build    # 复制 host/shared 到 lib/ 并生成 lib/client.js
npm test         # npm run build && node --test（83 条）
```

测试覆盖到的、值得单独说一句的几条：cron 方言（该拒的都拒、Vixie 的 OR 规则、
永不触发的表达式不会死循环）、错过时间点的两种处理、并发与重叠、连续失败自动暂停、
重启后「运行中」变「被中断」、子进程真的被起来并按超时/取消终止、提示词不经过 shell、
账本坏文件被隔离而不是让插件起不来、以及 `lib/client.js` 与 `src/client/index.js` 是否同步。

浏览器半边也是真的跑起来测的：`test/dom-stub.mjs` 是一份手写的 DOM 替身
（复制自 canvas 插件），`test/client.test.mjs` 在里面执行构建产物，然后像用户一样点：
挂载入口 → 打开面板 → 渲染行 → 展开历史 → 打开运行详情 → 走模板库新建 → 暂停 / 删除 /
终止 / 筛选，并断言发出的写请求（含 `ifVersion`）。


## 安装到 dsh

它**不进安装包**、首启不询问、默认不装 —— 和 [仓库面板](../dsh-plugin-repopanel) 一样，
装它只有一条路：

```bash
# 本仓库开发时（宿主进程跑 exports "."，web GUI 跑 exports "./client"）
dsh plugin --profile web add link:plugins/dsh-plugin-automation

# 发布到 npm 后直接按包名安装
dsh plugin --profile web add dsh-plugin-automation
```

重启 `dsh web` 后侧栏出现「⏱ 自动化」入口。卸载：

```bash
dsh plugin --profile web remove dsh-plugin-automation
```

卸载后账本文件还在（`~/.dsh/dsh-plugin-automation.json`），重新装上历史还在；
真的不想要了就手动删掉它。

## 与 codeg-plus 自动化的差异

对齐的部分：一条自动化 = 提示词 + 项目 + 时间表 + 到点后做什么；cron 按时区求值、
到点即触发、槽位在开运行的同一个事务里前移；每次触发都是一条有终态的运行记录，
只留摘要与错误而不是全量日志；历史按条数修剪但**正在跑的那条永不修剪**；
重启时把「运行中」判为中断而不是成功；投递到任务板与真的执行是两种动作。

有意不同的部分，以及为什么：

| codeg-plus | 这个插件 | 为什么 |
| --- | --- | --- |
| 每次运行铸一个 git worktree（`automation/<id>/run-<id>` 分支） | 直接在项目目录当前状态上跑 | dsh 没有对应的任务引擎与 worktree 注册表；而且参考实现里那些 worktree 与分支**至今没有回收**（源码里就是个 TODO）。宁可不建，也不给你一堆没人清理的目录 |
| 每条自动化可选 agent / 模型 / 模式 | 用 headless profile 自己的配置 | 一次性 CLI 只接受任务文本。放一个点了没反应的下拉框比不放更糟 |
| 每条自动化带 IANA 时区 | 一律本机时区 | 宿主就在用户机器上；跨时区调度是另一个功能，不是这一个的默认 |
| 进程级独占文件锁 + 数据库部分唯一索引双重兜底 | 进程内在跑表 + 账本事务 | 账本是一个 JSON 文件，同一个 `~/.dsh` 上跑两个 dsh 本身就不是支持的部署方式 |
| MCP 工具 `create_automation`，agent 能自己建自动化 | 没有 | 让 agent 排定「以后自动再跑一个 agent」是权限升级，得由用户单独决定。这个插件不给 agent 加任何工具 |
| 失败计数只做侧栏红点 | 连续失败到阈值就自动暂停 | 无人值守下，一条每小时失败一次的自动化会安静地烧一整天 |

**没做的部分**（都是有意留的边界，不是漏掉的）：per-run worktree 与分支选择、
按条选模型 / 预设、跨时区调度、失败重试与退避、运行输出的实时流（现在是运行结束后
一次性写入历史）、agent 侧工具。

它也**没有变成内置插件**（不进安装包、不在首启询问、外壳 Rust 不认识它）：
本仓库 README 里那条「唯一的例外」是为任务看板单独论证过的，而这个插件会在没人看着的时候
启动 agent —— 默认装进每台机器不合适。要不要内置是需要用户自己拍的边界决策。
