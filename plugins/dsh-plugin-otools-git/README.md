# dsh-plugin-otools-git · 章鱼Git

DSH Web GUI 里的完整 Git 客户端，界面复刻 [otools-git](https://github.com/) 的「章鱼Git」面板。

侧栏点 **Git** 打开，占据中间栏。仓库列表**直接来自 DSH 的工作区**，不需要手动添加。

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ 仓库      │ 工作区 历史 分支 标签 贮藏 远端 子模块 工作树 │拉取 推送…│
│ ◆ repo-a │──────────────────────────────────────────────────────────│
│   main   │ 已暂存文件 (2)          │                                │
│ ◇ repo-b │  ~ src/app.ts           │  @@ -1,4 +1,5 @@               │
│   ↑2 ±3  │ 未暂存文件 (1)          │  - const a = 1                │
│          │  ~ README.md            │  + const a = 2                 │
│          │ 未跟踪文件 (1)          │                                │
│          │  ? new.txt              │                                │
│          │─────────────────────────┤                                │
│          │ ✨ 提交信息...           │                                │
│          │ ☐覆盖最近一次提交  [提交]│                                │
├──────────┴─────────────────────────────────────────────────────────┤
│ 当前分支: main  同步: ↑2  状态: 3 个改动     当前仓库: D:/repo-a    │
└────────────────────────────────────────────────────────────────────┘
```

## 三件跟参考实现不一样的事

**1. 仓库列表就是 DSH 的工作区。** 参考实现自己维护一份仓库清单，用户要手动「打开本地仓库 / 克隆 / 新建」，还能拖动排序、重命名。DSH 已经知道用户在哪些文件夹里干活，所以这些全部换成 `ctx.workspaceRegistry`：**在 DSH 里打开的文件夹，只要是 git 仓库就出现在左边**，它的子模块和同仓库的其它工作树挂在它下面。代价是没有「添加仓库」这个动作 —— 请用 DSH 自己的打开文件夹。

**2. AI 提交信息直接接 DSH 的模型。** 点提交框左上角的 ✨，插件走 `ctx.llm.stream()` + `ctx.agentDefaultModel`，用的就是**你在 DSH 里已经选好的模型**：不用另配 API key，不建会话，不写会话日志，agent 那边什么都看不到。生成的文字是流式回填到输入框的，一句一句出现。

**3. HTTPS 凭证单独存，权限 0600。** 参考实现把账号密码明文塞在插件状态的大 JSON 里。这里放在 DSH 家目录下的独立文件（`dsh-plugin-otools-git-credentials.json`，0600；Windows 上跟随目录 ACL），浏览器只拿得到「哪个主机有凭证、用户名是什么」，**拿不到密码本身**。环境变量（`GITHUB_TOKEN` / `GH_TOKEN` / `GITLAB_TOKEN` / `GIT_USERNAME`+`GIT_PASSWORD`）优先于存盘的凭证，并且按主机限定 —— `github.com` 的 token 不会被发给 `github.someone-elses-box.com`。

## 功能

八个页签，覆盖参考实现的全部 Git 能力：

| 页签 | 内容 |
| --- | --- |
| **工作区** | 冲突 / 已暂存 / 未暂存 / 未跟踪四段，列表与文件树两种视图，单选多选（Ctrl 加选、Shift 连选）、右键菜单、暂存/取消暂存/丢弃、冲突取我方/取他方/标记解决，右侧行内 diff，下面是提交框 |
| **历史** | 提交表 + 分支图（车道几何照搬参考实现）、按分支/信息/作者/哈希/日期区间筛选、无限滚动翻页、引用 chip（HEAD / 本地 / 远程 / 标签，超过三个折叠成 +N）、提交详情卡 + 变更文件 + diff、右键合并/变基/打标签/建分支/挑选/回滚/重置 |
| **分支** | 按前缀分组的本地与远程分支、当前分支标记、领先/落后计数、检出（切换前先算会不会覆盖本地改动）、新建/重命名/删除/强制删除、设置上游、删除远端分支 |
| **标签** | 轻量与附注标签、创建（可选说明、可选创建后推送）、检出、删除本地与远端 |
| **贮藏** | 列表 + 每条的文件与 diff、创建（说明 / 含未跟踪 / 保留暂存区 / 只贮藏选中文件）、应用 / 应用并恢复暂存区 / 弹出 / 删除 / 基于它建分支 |
| **远端** | 名称、抓取与推送地址、凭证来源、添加/编辑/重命名/删除、单个远端抓取、prune |
| **子模块** | 初始化状态、初始化并更新、更新到远端最新、同步地址、添加、移除 |
| **工作树** | 列表（含锁定/失效/DSH 已打开标记）、新增（新分支/已有分支/游离）、锁定、删除、清理失效记录 |

工具栏另有 **拉取 / 推送 / 抓取**（带领先落后角标）、**分支 / 合并 / 贮藏** 快捷入口，和 **设置**。

推送对话框支持 `--force-with-lease`（默认排在 `--force` 前面）、`--set-upstream`、`--follow-tags`、`--tags`、`--dry-run`；选了 `--force` 要手打 `yes` 才能继续。

**长任务不阻塞界面。** 抓取 / 拉取 / 推送 / 克隆 / 子模块更新交给 host 侧的操作注册表，进度和输出走 SSE。关掉进度弹窗不会中断推送，再打开还能看到它推到哪了。认证失败会变成一个「填凭证并重试」的按钮，而不是只报个错；SSH 首次连接会把指纹摆出来让你核对后再写 `known_hosts` —— **指纹跟本地记录不一致时拒绝自动改写**。

### 没有做的三块

**软著申请助手、内置终端、文件编辑器** —— 它们不属于 Git，DSH 自己有对应的东西。

## 安装

```bash
# npm
dsh plugin --profile web add dsh-plugin-otools-git

# 或从源码
cd plugins/dsh-plugin-otools-git && npm run build && cd -
dsh plugin --profile web add link:plugins/dsh-plugin-otools-git
```

装完重启 `dsh web`。前提是机器上有 `git`，**建议 2.31 以上** —— 合并提交的差异需要
`--diff-merges`，版本低于此面板会在空状态里直接说出来，而不是给你一个空 diff。

## 架构

```
src/index.js          cordis 入口：prefs / 凭证 / 路由，llm 与 agentDefaultModel 都是可选注入
src/host/git.js       唯一的 git spawn 点：进程卫生 + 错误分类 + 取消信号
src/host/{status,diff,history,refs,commit,remotes,stash,nested,config}.js
                      git 引擎，porcelain v2 / -z / %x1f 分隔的 log 格式
src/host/{auth,ai,ops,workspaces,store}.js
                      凭证、AI 写提交信息、长任务注册表、工作区索引、偏好
src/host/{http,routes,actions}.js   JSON + SSE 路由（读在 routes，写在 actions）
src/shared/protocol.js              错误码与全部入参校验
src/client/*.js       浏览器侧，22 个片段拼成一个 IIFE（scripts/wrap-client.mjs）
```

**安全边界在 `src/shared/protocol.js`，GET 和 POST 两侧都必须过。** 这一条是踩过坑写下来的：
最初只有 POST 侧校验，GET 侧原样把 query 塞进 git argv —— 而 git 的选项可以出现在命令行
任何位置，所以 `?rev=--output=<文件>` 会把那个文件截断重写，`?rev=--contents=<文件>` 会让
`git blame --porcelain` 把它的内容原样回显出来（任意文件读）。现在每个 rev / ref / branch /
path 参数都走 `host/http.js` 里的一组校验器：路径不能是绝对路径也不能含 `..`；ref 与 rev
不能以 `-` 开头；URL 拒绝 `ext::` / `fd::` 这类会执行命令的传输协议；`safe.directory` 只收
已经解析成「DSH 已知仓库根」的绝对路径（否则 `{"paths":["*"]}` 能全局关掉 git 的所有权检查）。
`test/security.test.mjs` 里每一条都是曾经能打通的利用。

仓库只能是 DSH 已注册工作区里的那些 —— 浏览器没法让 host 去任意目录跑 git。包含判断带
路径分隔符，所以 `<root>-secrets/` 这种同前缀的兄弟目录进不来。

`git` 子进程一律禁掉交互提示（`GIT_TERMINAL_PROMPT=0`、清掉 askpass），所以缺凭证时是**立刻
失败**而不是挂住，然后面板来问。凭证只进子进程的环境变量，不进 argv、不进日志、不进响应。

## 开发

```bash
npm run check   # 语法检查 + 重建 lib/
npm test        # 116 个用例
```

测试分四层：`test/host.test.mjs` 起真的 http server 打真的临时 git 仓库（含空仓库、根提交、
合并提交这些容易错的形状）；`test/client-bundle.test.mjs` 把打包好的 bundle 塞进
`test/dom-stub.mjs`（自制的最小 DOM）真跑一遍，这是唯一能抓出片段间作用域冲突的办法；
`test/security.test.mjs` 每条都是曾经能打通的利用；`test/client-mirror.test.mjs` 守着浏览器侧
那份手抄的词表不跟 host 漂移。

改了 `src/` 之后 `lib/` 必须一起提交 —— CI 会用 `git diff --exit-code` 检查。

## 许可

MIT
