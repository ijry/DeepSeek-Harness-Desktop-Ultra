# dsh-plugin-otools-dbm · 鲨鱼数据库

把 [otools-dbm](https://github.com/ijry) 的「鲨鱼数据库」面板搬到 DSH web GUI 上：连接树、数据网格（可直接改行）、表设计器、SQL 工作台、Redis 键浏览器、导入导出、备份中心（含定时计划）、结构 + 数据同步、数据字典、用户管理，以及一个直接接 DSH 模型的 AI 大屏。

**界面是原样复刻的** —— 参考实现那 30 个 Vue 3 + Element Plus 组件一个字没改地搬了过来，用 Vite 打包成一个单页应用，由插件自己的 host 路由提供服务。换掉的是下面那一半：Rust 变成 Node，Tauri 的三条桥变成 HTTP，AI 从「再配一把 key」变成「用 DSH 已经选好的模型」。

```
┌ 侧栏 ─────────┬ 主区 ────────────────────────────────────────────────┐
│ ▸ 本地 MySQL  │  数据库信息 │ users │ [V] v_orders │ [Q] SQL查询  ✕  │
│   ▸ shop      ├──────────────────────────────────────────────────────┤
│     ▸ 表      │  ⟳ 保存修改  刷新              筛选  ⋯               │
│       users   │ ┌────┬──────────┬─────┬────────────────┬───────────┐ │
│       orders  │ │ id │ name     │ age │ created_at     │ 操作      │ │
│     ▸ 视图    │ │ 1  │ Ada      │ 36  │ 2026-09-05 …   │ 编辑 删除 │ │
│     ▸ 存储过程│ │ 2  │ Grace    │ 45  │ 2026-09-04 …   │ 编辑 删除 │ │
│ ▸ 线上 PG     │ └────┴──────────┴─────┴────────────────┴───────────┘ │
│ ▸ 缓存 Redis  │  ‹ 1 2 3 ›  共 128 条            [ 数据 | 结构 ]     │
└───────────────┴──────────────────────────────────────────────────────┘
```

一个插件 = 两个半边：

- **host 半边**（`exports "."`）跑在 dsh 的 Node 进程里：数据库驱动、74 条命令路由、任务的 SSE 事件流、静态面板产物。它**不注册任何 agent 工具，也不写系统提示** —— 普通会话里 agent 的行为完全不变。
- **browser 半边**（`exports "./client"`）跑在 web GUI 里：往侧栏放一个图标，点开后在中间栏挂一个同源 iframe，把语言与亮暗同步进去。300 行，界面本身在 iframe 里。

## 四件跟参考实现不一样的事

1. **驱动换成 Node 生态，并且只选纯 JS 的**。参考实现是 29k 行 Rust（sqlx / tiberius / oracledb / dmdb）。这里的选型抄的是同一作者的 VS Code 客户端 [AirDB](https://github.com/ijry/airdb)：`mysql2`、`pg`、`ioredis`、`mongodb`、`tedious`、`@clickhouse/client`、`kafkajs`，全部纯 JS，`npm install` 不需要编译器。**SQLite 用 Node 22.5 内置的 `node:sqlite`** —— 参考实现和 AirDB 都是外挂一个 `sqlite3` 可执行文件，那意味着要么随包发二进制，要么指望用户 PATH 里有。Oracle 与 Snowflake 是 `optionalDependencies`，装不上时面板报「驱动未安装」并给出安装命令，而不是整块功能消失。
2. **AI 直接接 DSH**。`ctx.llm.stream()` 走 `agentDefaultModel` 已经选好的那条路由，所以 SQL 助手和 AI 大屏不需要第二把 API key。不建会话、不写会话日志、agent 侧看不到。
3. **Tauri 的三条桥变成 HTTP**：`invoke` 是每条命令一个 POST，`listen` 是一条共享 SSE，原来的系统文件对话框变成面板内的宿主目录浏览器 —— 浏览器标签页开不出系统对话框，而那些路径本来就在宿主机上。
4. **改掉了参考实现里六个会咬人的地方**，见下面「与参考实现的行为差异」。

## 支持的数据库

| 引擎 | 驱动 | 状态 |
| --- | --- | --- |
| MySQL / MariaDB | `mysql2` | 完整 |
| PostgreSQL | `pg` | 完整 |
| KingbaseES 人大金仓 | `pg`（PG 协议兼容） | 完整 |
| SQLite | `node:sqlite`（内置） | 完整 |
| SQL Server | `tedious` | 查询、结构、DDL |
| ClickHouse | `@clickhouse/client` | 查询、结构、DDL（无事务） |
| Redis | `ioredis` | 键树、值编辑、命令台 |
| MongoDB | `mongodb` | 集合浏览、文档编辑、聚合 |
| Elasticsearch | 直接 `fetch` REST | 索引浏览、DSL 控制台 |
| Kafka | `kafkajs` | 主题、分区、消息预览与投递 |
| Oracle | `oracledb`（可选依赖，Thin 模式） | 查询、结构、DDL |
| Dameng 达梦 | 走 `oracledb`（Oracle 兼容面） | 尽力而为，见下 |
| Snowflake | `snowflake-sdk`（可选依赖） | 查询、结构 |

达梦官方的 `dmdb` 是需要编译的原生模块，装不上就是整个插件装不上，所以这里用它的 Oracle 兼容面。够用的部分能用，不够的部分会明确报错 —— 比装不上好。

## 安全边界

- **凭据**：连接账号密码明文存在 `<DSH 家目录>/dsh-plugin-otools-dbm/connections.json`，文件权限 0600，写入是「临时文件 + rename」的原子写。不加密是有意的：密钥只能放在同一块磁盘上，加了等于没加；真正起作用的是文件权限，以及**密码永远不回传给浏览器** —— 列表与编辑表单拿到的是 `__dsh_dbm_secret__` 占位符，保存时 host 会把没重发的密文合回去。
- **标识符**：数据库名、表名、字段名、索引名全部先过 `requireIdentifier()`（拒绝引号、反斜杠、分号、换行），再交给方言加引号。这是所有拼接语句唯一的边界。值走绑定参数，只有确实不支持绑定的引擎（ClickHouse）才内联，且内联走方言的 `literal()`。
- **排序**：网格传来的 `ORDER BY` 只允许「列名 [ASC|DESC]」，别的直接拒 —— ORDER BY 是能塞子查询的地方。
- **AI 大屏只读**：模型生成的仪表盘代码在浏览器里跑，它发什么 SQL 就执行什么，所以 `dbm_execute_dashboard_query` 强制单条语句且首关键字必须是 SELECT/WITH/SHOW/EXPLAIN/PRAGMA 之类。
- **宿主文件系统**：`dbm_fs_*` 那几条路由给了目录列表和文件写入的能力。这不是新增的攻击面 —— dsh 自己的 agent 工具（`read`/`write`/`bash`）在同一个 origin 上能做的更多 —— 但值得知道。**没有**提供读文件内容的路由，因为面板不需要；导入时只读文件的表头那一行。
- **删列不自动执行**：同步中心发现目标表多出字段时只报告，不生成 DROP COLUMN。删列不可恢复，不该由定时任务替人决定。
- **备份保留策略只删自己目录里的 `.sql`**，不递归 —— 有人把计划指向源码目录时不该丢文件。

## 与参考实现的行为差异

这些是移植时读参考实现读出来的问题，改掉了：

1. **筛选的三个多词操作符原来是坏的**。参考实现用最后一个 `_` 切 `field_OPERATOR`，于是 `name_NOT_LIKE` 被切成字段 `name_NOT` + 操作符 `LIKE`，`age_IS_NOT_NULL` 更是切出个不存在的 `NULL` 操作符。这里按已知操作符表**从长到短**匹配后缀，`home_city_=` 这种带下划线的字段名也不会被误伤（有测试）。
2. **改行不再假设主键叫 `id`**。参考实现把 `id` 写死进每条 UPDATE / DELETE，主键叫别的名字就会去改一个碰巧存在的 `id` 列，复合主键根本没法用。这里读表结构拿真主键，缺任何一列就明确报错。
3. **没有主键的表会拒绝保存**，而不是静默什么都不做（参考实现在这种情况下 `Ok(())` 返回成功，用户以为存上了）。
4. **取消真的取消**。参考实现的 `cancel_task` 只是往记录里写个 `Cancelled`，没有任何 worker 读它，导出照跑到底再把状态改回 `Completed`。这里每个 worker 拿到 `AbortSignal`，分块之间检查。
5. **导入导出按 1000 行分块**，参考实现是**每行一次往返 + 每行一个进度事件 + 每行重写一遍 tasks.json**。导入用批量 INSERT（500 行一条），远端库上快一个数量级。
6. **备份中心的磁盘用量在 Windows 上能用了**。参考实现调的是 unix-only 的 `statvfs`，Windows 上整块面板直接报错；这里用 Node 22 的 `fs.statfs`。

另外，任务只存在内存里，不落盘：参考实现把任务写进 `~/.menudbm/tasks.json`，重启后留下一堆永远不会完成的 `Running`，还会把「退出前检查未完成任务」的钩子卡死。任务活不过进程，记录也就不该活过。

界面是逐字复制的，但有两处**参考实现里会抛异常的代码**必须改，否则功能是坏的（改动都标了 `PORT FIX`）：

- `TableContent.vue`：`normalizeMongoRow` / `normalizeMongoValue` 声明在保存处理函数内部，却被下面的 Redis WATCH 冲突重试路径调用 —— 一旦检测到并发写就是 `ReferenceError`。原样上移到组件作用域，函数体没动。
- `queryWorkbenchState.ts`：`QUERY_RESULT_SNAPSHOT_ROW_LIMIT` 被引用但从未声明，恢复带 `result` 字段的旧状态就抛 `ReferenceError`。补上声明（200 行）。

## 安装

从 npm：

```bash
dsh plugin --profile web add dsh-plugin-otools-dbm
```

从源码（开发用）：

```bash
cd plugins/dsh-plugin-otools-dbm
npm install          # 驱动 + Vite/Vue 构建链
npm run build        # 生成 lib/（含 lib/webview 面板产物）
cd ../..
dsh plugin --profile web add link:plugins/dsh-plugin-otools-dbm
```

装完重启 dsh 服务，侧栏会出现一个数据库图标。

> 需要 **Node 22.5 以上** —— SQLite 用的是内置的 `node:sqlite`。
> 这个插件**不进 DSH Desktop Ultra 安装包**，跟仓库面板、章鱼Git、自动化一样：装它只有 `dsh plugin add` 一条路。数据库客户端默认装进每台机器不合适。

## 架构

```
src/
  index.js                     host 入口（namespace plugin：name / inject / apply）
  shared/protocol.js           错误码、DbmError、标识符校验
  host/
    routes.js                  74 条命令的分派表 + SSE + 静态面板
    http.js                    信封、body 读取、静态文件（含路径穿越防护）
    sdk.js                     dshHomePath / 原子写 / 语言解析（不 import @deepseek-ai/*）
    store.js                   连接账本（0600）、UI 状态、备份计划、同步日志
    connections.js             连接 → 引擎的注册表，SSH 隧道在这里解析
    tunnel.js                  ssh2 + net.createServer 的本地端口转发
    tasks.js                   后台任务 + AbortSignal + 进度节流
    schema.js                  表结构读取（30s 内存缓存）与 DDL 校验
    crud.js                    单行 CRUD、网格保存、事务
    query.js …                 （查询走 engines/sql-engine.js）
    exporter.js                CSV / JSON / SQL / Excel 流式导出、整库备份
    importer.js                SQL / CSV / Excel / JSON 流式导入
    sync.js                    结构 + 数据同步，预览与执行同一条代码路径
    backup.js                  备份计划、30s 调度器、磁盘用量
    dictionary.js              数据字典 .docx
    ai.js                      ctx.llm.stream 一次性补全 + 会话历史
    fs.js                      dbm_fs_* 宿主文件系统、图片上传
    engines/
      contract.js              引擎契约（文档 + 校验）
      sql-engine.js            通用 SQL 引擎（句柄、行映射、多语句脚本协议）
      sql-dialect.js           方言基类与内省输出列约定
      result.js               值归一化（Date / BigInt / Buffer / JSON）
      dialects/                mysql postgres sqlite mssql oracle clickhouse snowflake
      drivers/                 load(懒加载) sql(mysql/pg/sqlite) vendor(其余四个)
      redis.js mongodb.js elasticsearch.js kafka.js
    sql/split.js               语句切分（引号、注释、$$、DELIMITER、Oracle 的 /）
  client/index.js              侧栏图标 + iframe + 语言/亮暗同步
webview/                       参考实现的 Vue 应用，逐字复制
  src/*.vue                    30 个组件，未改动
  src/shims/                   tauri-core(invoke→POST) tauri-event(listen→SSE) tauri-dialog(→宿主浏览器)
  src/platform/ i18n runtime ui/…    参考实现从 OTools 外壳拿的那些，在这里补齐
  i18n/*.json                  参考实现的 8 种语言 1089 条，逐字复制
```

## 开发

```bash
npm run check       # 语法检查 src/ → 重建 lib/（跳过 webview）→ 再检查 lib/
npm run test        # 构建后跑 node --test（含一整套真跑 SQLite 的端到端测试）
npm run typecheck   # vue-tsc 检查面板
npm run build       # 全量构建，含 vite 打包面板
```

`npm run typecheck` 目前**有 27 个报错，全部来自逐字复制的上游组件**（`TS2339` 属性不在类型上、`TS2305` 五个从未被调用的死导入、`ElTable` 泛型噪音、`status: string` 对不上联合类型、缺 `@types/node` 的 `NodeJS` 命名空间）。它们不影响构建（Vite 用 esbuild，从不做类型检查），也不影响运行 —— 已经确认剩下的报错里没有一个是「引用了不存在的名字」那类真错（那两个已经修了，见上）。`webview/tsconfig.json` 因此关掉了 `strict`，理由写在文件里。**本插件自己写的代码（`shims/`、`platform/`、`utils/hostFs.ts`、整个 `src/`）必须零报错。**

改了 `src/` 之后 `lib/` 必须一起提交 —— CI 会用 `git diff --exit-code` 检查。`lib/webview` 是 Vite 产物，同样要提交。

面板的开发热重载：`npx vite --config webview/vite.config.ts`，然后把 dsh 的地址代理进去；或者直接 `npm run build` 后刷新页面 —— 面板产物是静态文件，改一次构建一次即可。

## 界面语言

面板自带参考实现的八种语言（zh-CN / en-US / ja-JP / ko-KR / de-DE / ru-RU / es-ES / ar-SA，共 1089 条键）。语言按这个顺序定：

1. `DSH_DESKTOP_LANG`（`zh` / `en`），装了 DSH Desktop Ultra 时由外壳设置；
2. `LC_ALL` / `LC_MESSAGES` / `LANG` —— 独立部署走这条，而且这里认全八种，所以 `LANG=ja_JP.UTF-8` 会得到日文面板，即使外壳本身只有中英；
3. 浏览器的 `navigator.language`；
4. 都认不出用中文。

语言与亮暗都是 client 半边通过 iframe 的 query 传进去的，运行中改语言/主题会 postMessage 同步，不用刷新。

## 已知限制

- SQL Server 与 Snowflake 没有执行计划（`explain_query` 会明确报不支持）。
- SQLite 改字段类型需要重建表，面板会拒绝而不是偷偷重建 —— 12 步重建表在有外键的库上不安全。
- 同步中心只支持同引擎（MySQL↔MariaDB、PostgreSQL↔KingbaseES 算同引擎）。跨引擎 DDL 翻译是另一个产品。
- 没有 hunk 级/行级的差异编辑器，参考实现也没有。
- Excel 导入只支持 `.xlsx`；`.xls` 是旧二进制格式，`exceljs` 读不了，会明确报错。

## 许可

MIT
