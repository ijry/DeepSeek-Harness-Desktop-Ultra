# dsh-plugin-repopanel

给 DeepSeek Harness Web GUI（`dsh web`）用的「仓库面板」插件，语义参考
[codeg-plus](https://github.com/codeg-ai/codeg-plus) 的仓库面板（代码里叫 `forge`）：
选一个工作区 → 读它的 `origin` 远端 → 列出那个远端仓库的 issue 与 pull request →
筛选、翻页、看详情、发评论、关闭/重开 → 把某一条交给 agent 变成一个任务。
纯 dsh 插件，不改上游源码，可发布到 dsh 插件市场。

一个插件 = 两个半边：

- **host 半边**（`exports "."`，Node 宿主进程）：远端解析、forge REST 客户端、
  面板设置与「条目 → 任务」映射的单文件账本、写进 agent 系统提示的不可信数据纪律，
  以及 `/dsh-plugin-repopanel` 的 JSON + SSE 路由。
- **浏览器半边**（`exports "./client"`，web GUI）：零依赖、纯 DOM 的列表 / 详情抽屉 /
  设置弹层，不引 React、不引任何 `@deepseek-ai/*` 浏览器包。

## 数据存在哪（三个去处，各有理由）

| 数据 | 存法 | 为什么 |
| --- | --- | --- |
| **仓库** | 不存 | 每次从工作区路径跑一次 `git remote get-url origin` 推导（带 15 秒 TTL 缓存）。存一份仓库表只会多一个「与 git 不一致」的 bug —— codeg-plus 也是这么决定的。 |
| **issue / PR 内容** | 不存 | 按需打 forge 的 REST API。缓存远端条目换来的只是过期数据。 |
| **面板设置 + 条目→任务映射** | `<DSH 家目录>/dsh-plugin-repopanel.json` | 这两样不可推导，必须落盘。串行写队列 + 临时文件 `rename` 原子发布 + 单调 `revision` + 快照 deep-freeze + 坏文件隔离成 `.corrupt-<ts>`。 |
| **访问令牌** | 环境变量优先，其次 `<DSH 家目录>/dsh-plugin-repopanel-credentials.json`（0600） | 见下面「令牌」一节。 |
| **选中的工作区 / tab / 每页条数** | 浏览器 `localStorage` | 纯 UI 偏好，浏览器半边唯一能自己存的东西。页码**故意不存**：翻到第 7 页关掉再打开，回到第 7 页只会让人困惑。 |

**为什么不用 dsh 自己的 storage service。** dsh 内部确实有一套（落盘在
`~/.dsh/storages/<unit>.json`，形如 `{ unit: { name, version }, global, tables }`），
但它只存在于 `@deepseek-ai/*` 包里，而一个已发布的 dsh 插件**不能**在运行时 resolve 那些包 ——
profile 的 node_modules 里那份 npm 镜像副本会 shadow CLI 内部构建，可能弄坏 agent loop。
这条约束与它的原因写在同仓库 `dsh-plugin-taskboard/src/host/sdk.js` 的文件头。
所以这里和任务板插件一样：自管一个 JSON 账本，`dshHomePath()` 自己实现，零运行时依赖。

## 与任务板插件的联动

**不改 `dsh-plugin-taskboard` 一行代码。** 它的 `TaskRecord` 里没有来源字段，
这个插件也不去给它加：

- 「Start」→ host 组好 prompt，调任务板现有的 `POST /dsh-plugin-taskboard/tasks` 建任务，
  然后把 `sourceKey → taskId` 记进自己的账本。任务标题写成 `#123 · 原标题`。
- 画行内 chip 时读任务板的 `GET /dsh-plugin-taskboard/state`，用 taskId 关联出当前状态，
  得到三态：没有任务 → `Start`；有活跃任务 → 状态 chip；任务已终结 → chip + 「重新触发」。
- **source key** 是 `provider:host:owner/repo:kind:number`，host 与 repo 一律小写、
  去掉 `.git`。两侧必须归一到同一个字符串，否则 chip 认不出自己的任务 —— 有测试盯着。
- 任务板不在（没装 / 起不来）时，列表照常显示，只是每行都退回 `Start`，不报错。
- 面板互斥沿用任务板已有的约定：`dsh-panel-activate` 自定义事件 + `<html>` 上的
  `data-dsh-*-active` 属性。

代价写明：任务板的卡片上看不到「来自 #123」这条来源链接（那需要动它的记录格式）。
反向的钱是省下的 —— 两个插件各自独立发布、独立回归。

## 令牌

`GITHUB_TOKEN` / `GH_TOKEN`（GitHub）与 `GITLAB_TOKEN`（GitLab）优先，每次请求现读，
所以补一个环境变量不用重启宿主。没有环境变量时，才落到设置弹层里存下来的那份：

- **环境变量只对规范 host 生效**（`github.com` / `gitlab.com`）。provider 是按 host 的某一节
  匹配出来的，`github.acme.com` 会被当成 GitHub Enterprise —— 要是环境变量对所有匹配的
  host 都生效，那么某个工作区的 origin 一旦指向 `github.<别人的机器>.com`，你真正的
  `GITHUB_TOKEN` 就会被发到那台机器上。自建与 Enterprise 实例必须自己存一份按 host 的凭据。
- 文件 `<DSH 家目录>/dsh-plugin-repopanel-credentials.json`，创建时 `chmod 0600`；
  **Windows 上 `chmod` 基本是空操作**，那里靠的是用户目录本身的 ACL，这一点不掩饰。
- 与面板设置分开存，这样把设置贴进 issue 或诊断信息时不会连令牌一起带出去。
- 只有你在设置弹层里手填令牌才会产生这个文件；只用环境变量的话它永远不存在。
- 浏览器只会拿到「哪些 host 有凭据、来自 env 还是文件」，**永远拿不到令牌本身**。
  环境变量那类只报变量名（`{ provider, variable }`）不报值 —— 不报出来的话，面板会
  一边显示「github.com 没有凭据」一边正常出数据，用户会去找一个不存在的 bug。

## 已实现 / 尚未实现

对齐了 codeg-plus 仓库面板的列表层与触发流：双 tab 带计数、搜索（350ms 防抖）、
状态 / 指派给我 / 标签多选 / 排序、服务端分页与每页条数、行内三态动作、
右上角齿轮开设置弹层（scope 选择、全局 vs 自定义、场景默认值、回帖默认、
常驻指令分场景、凭据管理）、详情抽屉的对话页（评论分页、发评论、关闭/重开）、
新建 issue、以及全套空态与错误态。**支持暗黑模式**：自动跟随系统主题偏好
（`prefers-color-scheme`），深浅两种配色方案无缝切换。

**尚未实现**（下一期）：

- 详情抽屉的 **Checks 页**（检查项汇总与逐条状态）
- 详情抽屉的 **Files changed 页**（diff、内联/并排切换、逐文件展开）
- **合并框**（冲突与检查判定、合并方式下拉、`headSha` 守卫）
- **GitLab**：provider 分派已经留好（`src/host/forge.js`），缺的是一个实现同一组
  方法的 `src/host/gitlab.js`；现在遇到 GitLab 远端会明确报「这个构建还不支持」，
  而不是列出一个空列表。
- codeg-plus 的**投递与回帖**（`git push` + 建 PR + 把结果回帖）依赖它自己的任务引擎；
  任务板插件明确不做执行与调度，所以这条不在移植范围内。设置里的「回帖」开关目前
  只是把意图记进 link，不会自己发帖。

## 目录

```text
plugins/dsh-plugin-repopanel
├── package.json            # dsh 元数据；exports: "." host / "./client" 浏览器
├── cordis.patch.yml        # 打进 profile 的插件行
├── src
│   ├── index.js            # host 加载入口：提示段 + 路由
│   ├── host/
│   │   ├── remote.js       # git remote get-url origin → forge 坐标
│   │   ├── auth.js         # 令牌解析（env → 文件）与 0600 落盘
│   │   ├── github.js       # GitHub REST 客户端
│   │   ├── forge.js        # provider 分派
│   │   ├── store.js        # 账本：设置 + 映射，串行队列 + 原子写
│   │   ├── taskboard.js    # 任务板桥（HTTP，带回环围栏）
│   │   ├── routes.js       # JSON + SSE 路由
│   │   ├── protocol-text.js# 不可信数据纪律的系统提示段
│   │   └── sdk.js          # dshHomePath（不 import @deepseek-ai/*）
│   ├── shared/protocol.js  # 纯领域核心：source key、远端解析、设置 scope、分页、prompt 组装
│   └── client/index.js     # 浏览器面板（vanilla DOM，构建时包成 loader 模块）
├── scripts/                # wrap-client / build / check
└── test/                   # node:test 领域 + host 行测试
```

## 开发与验证

零运行时依赖，无需 `npm install`：

```bash
npm run check    # 语法检查 src/ → 重新构建 lib/ → 再查 lib/（含生成的 client 包）
npm run build    # 复制 host/shared 到 lib/ 并生成 lib/client.js
npm test         # npm run build && node --test
```

## 安装到 dsh

```bash
# 本仓库开发时
dsh plugin --profile <profile> add link:plugins/dsh-plugin-repopanel

# 发布到 npm 后按包名安装
dsh plugin --profile <profile> add dsh-plugin-repopanel
```

重启 `dsh web` 后侧栏出现「仓库面板」入口（与任务板入口相邻）。

## 安全须知

- 面板的路由和任务板的一样**没有自己的鉴权**，唯一的保护是 dsh 只绑 `127.0.0.1`。
  也就是说，本机上任何能访问该端口的进程或页面都能通过这些路由读写你的 forge。
  这与任务板插件的现状一致，但因为这里牵涉远端写操作与令牌，所以单独写明。
- forge 的正文与评论是**任何能在该仓库开 issue 的人**写的。浏览器半边从不用
  `innerHTML` 渲染它们，host 半边把它们夹在 `UNTRUSTED DATA` 围栏里再交给 agent，
  并且围栏对正文里自带的结束标记做了打断处理。
- 远端 URL 交给浏览器之前会抹掉带密码的 userinfo（`user:token@`），
  但保留 SSH 约定的 `git@`。
