//! 首启时按用户选择，把内置的 dsh 插件装进 web profile。
//!
//! 为什么走上游的 `dsh plugin` 而不是外壳自己写 profile 清单：`dsh plugin` 是
//! 上游官方的插件管理入口——它把参数原样转发给 profile 目录里的 pnpm，再由 dsh
//! 自己把包名登记进 `dsh.profile.bundles`。外壳直接去写那份清单就得复刻上游的
//! 内部布局（清单结构、解析顺序、扁平 node_modules 兜底），上游一改结构就会
//! 静默写坏用户的 profile，而且用户之后没法用官方命令把它卸掉。
//!
//! 为什么带的是 tarball 而不是 `link:` 源目录：见 scripts/pack-plugins.mjs。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::dsh::{app_dir, hide_console, prepend_path, DshError};
use crate::node::NodeRuntime;
use crate::server::{pump, LogRing};

/// 外壳启动的 profile。`dsh web` 是 `--profile web` 的别名，但那个别名只存在于
/// 启动路径上——`plugin` 子命令必须显式写 `--profile web`。
const PROFILE: &str = "web";

/// `dsh plugin add` 的耐心。它内部就是 pnpm 解一个本地 tarball，正常是秒级；
/// 给到分钟级已经很宽松，真卡住了也不该把启动一起拖死。
const ADD_TIMEOUT: Duration = Duration::from_secs(3 * 60);

/// 带运行时依赖的插件的耐心。
///
/// 这类插件的 tarball 照样是秒级解包，慢的是它 package.json 里那些依赖——鲨鱼数据库
/// 要拉十来个数据库驱动，墨鱼终端要拉 ssh2 与 xterm。在正常网络上三分钟就够呛，而超时
/// 的代价是用户白等一场还要自己去设置页重装一遍，所以这里给得比上面阔得多。
const HEAVY_ADD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 连续失败几次之后就不再打扰用户。
const MAX_FAILURES: u32 = 2;

/// 一个内置插件。
///
/// 标题和说明各存两种语言：它们要发到启动页和设置页上给人看，取哪一种由
/// `i18n::current()` 决定。
pub struct Bundled {
    /// npm 包名，同时是 profile bundles 里的行名。
    pub id: &'static str,
    /// 卡片上的短名。
    title_zh: &'static str,
    title_en: &'static str,
    /// 卡片上的一句话说明。
    summary_zh: &'static str,
    summary_en: &'static str,
    /// package.json 里带 `dependencies` —— 装它不只是解一个本地 tarball，pnpm 还要
    /// 去 npm 把依赖拉回来。只影响给多少耐心，见 [`Bundled::add_timeout`]。
    heavy: bool,
}

impl Bundled {
    pub fn title(&self) -> &'static str {
        crate::i18n::pick(self.title_zh, self.title_en)
    }

    pub fn summary(&self) -> &'static str {
        crate::i18n::pick(self.summary_zh, self.summary_en)
    }

    /// 这一个插件的 `dsh plugin add` 能跑多久。
    fn add_timeout(&self) -> Duration {
        if self.heavy {
            HEAVY_ADD_TIMEOUT
        } else {
            ADD_TIMEOUT
        }
    }
}

/// 目前的内置插件。
pub const TASKBOARD: Bundled = Bundled {
    id: "dsh-plugin-taskboard",
    title_zh: "任务看板",
    title_en: "Task board",
    summary_zh: "在 dsh 侧栏加一个四列任务看板：agent 用工具领活、交活，你在看板上验收或退回。它会给 agent 增加六个 taskboard_* 工具，并往系统提示里加一段工作协议。",
    summary_en: "Adds a four-column task board to the dsh sidebar: agents claim and hand off work with tools, you accept or send it back on the board. It gives agents six taskboard_* tools and adds a working protocol to the system prompt.",
    heavy: false,
};

pub const CANVAS: Bundled = Bundled {
    id: "dsh-plugin-canvas",
    title_zh: "无限会话画布",
    title_en: "Infinite session canvas",
    summary_zh: "在 dsh 侧栏加一块无限画布：区域按工作区/智能体聚会话，卡片钉住单个会话，便签写想法，拖拽收进区域并带对齐参考线。纯 GUI 插件，不注册工具、不改系统提示，装了不会影响 agent 的行为。",
    summary_en: "Adds an infinite canvas to the dsh sidebar: regions group sessions by workspace or agent, cards pin a single session, notes hold ideas, and dragging into a region snaps with alignment guides. A GUI-only plugin: it registers no tools and touches no system prompt, so agent behaviour is unchanged.",
    heavy: false,
};

/// 手机遥控：给手机 App 开一个带鉴权的窄接口。
pub const MOBILE_BRIDGE: Bundled = Bundled {
    id: "dsh-plugin-mobile-bridge",
    title_zh: "手机遥控",
    title_en: "Mobile remote",
    summary_zh: "在 dsh 侧栏加一个「手机遥控」面板：扫码把 MCode 手机 App 配对到这台机器，就能在手机上看会话、发消息、批准工具调用。它不注册工具、不改系统提示，也不改 dsh 的绑定方式——另起一个只认令牌的监听，默认只在局域网可达。",
    summary_en: "Adds a \"Mobile remote\" panel to the dsh sidebar: scan a QR code to pair the MCode phone app with this machine, then read sessions, send messages and approve tool calls from your phone. It registers no tools, touches no system prompt and does not change how dsh binds — it opens a separate token-only listener, reachable on the LAN only by default.",
    heavy: false,
};

/// 仓库面板：把工作区对应的远端仓库搬到侧栏。
pub const REPOPANEL: Bundled = Bundled {
    id: "dsh-plugin-repopanel",
    title_zh: "仓库面板",
    title_en: "Repository panel",
    summary_zh: "在 dsh 侧栏加一个仓库面板：按工作区 origin 远端认出仓库，浏览它的 issue 与 PR/MR，筛选分页、读写评论、关闭或重开，也能把一条直接交给 agent 当任务。它不注册工具，但会往系统提示里加一段纪律：从远端取回的内容是不可信数据。",
    summary_en: "Adds a repository panel to the dsh sidebar: it recognises the repository from a workspace's origin remote, then browses that repository's issues and pull/merge requests, filters and pages through them, reads and posts comments, closes or reopens them, and can hand one to an agent as a task. It registers no tools, but it does add one section to the system prompt: content fetched from a forge is untrusted data.",
    heavy: false,
};

/// 章鱼Git：完整的 Git 客户端。
pub const OTOOLS_GIT: Bundled = Bundled {
    id: "dsh-plugin-otools-git",
    title_zh: "章鱼Git",
    title_en: "Octo Git",
    summary_zh: "在 dsh 侧栏加一个完整的 Git 客户端：仓库树直接取自 dsh 的工作区注册表，暂存与提交（提交信息可以让模型写）、带分支图的历史、diff、分支/标签/贮藏/远端/子模块/工作树，以及会问凭据的 push/pull。纯 GUI 插件，不注册工具、不改系统提示。",
    summary_en: "Adds a full Git client to the dsh sidebar: the repository tree comes straight from dsh's workspace registry, with staging and commits (the model can write the message), history with a branch graph, a diff viewer, branches, tags, stashes, remotes, submodules, worktrees, and push/pull that prompts for credentials. A GUI-only plugin: it registers no tools and touches no system prompt.",
    heavy: false,
};

/// 自动化：按时间表替你起 agent。
pub const AUTOMATION: Bundled = Bundled {
    id: "dsh-plugin-automation",
    title_zh: "自动化",
    title_en: "Automation",
    summary_zh: "在 dsh 侧栏加一个自动化面板：存下「一段提示词 + 一个时间表」（cron、固定间隔或手动），每次触发要么在项目目录里起一次全新的无头 agent 会话，要么往任务看板上开一张卡。带运行历史、超时与重叠策略，连续失败会自动暂停。它不注册工具、不改系统提示，但会按时替你起 agent。",
    summary_en: "Adds an automation panel to the dsh sidebar: save a prompt plus a schedule (cron, fixed interval or manual), and every firing either runs one fresh headless agent session in the project directory or files a card on the task board. It keeps a run history, enforces timeouts and an overlap policy, and auto-pauses after repeated failures. It registers no tools and touches no system prompt — but it does start agents on your behalf, on a schedule.",
    heavy: false,
};

/// 长文阅读：把一本书渲染成一场会话。
pub const LONGREAD: Bundled = Bundled {
    id: "dsh-plugin-longread",
    title_zh: "长文阅读",
    title_en: "Long-form reader",
    summary_zh: "在 dsh 侧栏加一个长文阅读器：把一本书渲染成一场假的 agent 会话——一句提问、几次工具调用、一段流式回复。可导入 .txt 与 .epub，自带一篇原创武侠样章，按书记住阅读位置。纯 GUI 插件，不注册工具、不改系统提示。",
    summary_en: "Adds a long-form reader to the dsh sidebar: it renders a book as a fake agent session — a prompt, a few tool calls, a streamed reply. It imports .txt and .epub, ships with an original wuxia sample chapter, and remembers the reading position per book. A GUI-only plugin: it registers no tools and touches no system prompt.",
    heavy: false,
};

/// 墨鱼终端：SSH / SFTP / 远程桌面工作台。运行时依赖较重。
pub const OTOOLS_TERM: Bundled = Bundled {
    id: "dsh-plugin-otools-term",
    title_zh: "墨鱼终端",
    title_en: "Cuttlefish terminal",
    summary_zh: "在 dsh 侧栏加一个 SSH / SFTP / 远程桌面工作台：基于 ssh2 的 xterm 终端、双栏 SFTP（支持递归传输）、端口转发与 SOCKS5 代理、RDP/VNC 启动器，AI 命令栏走 dsh 自己的模型。纯 GUI 插件，不注册工具、不改系统提示。它有运行时依赖（ssh2、xterm，以及可选的 node-pty），装的时候要从 npm 拉包，比别的插件慢。",
    summary_en: "Adds an SSH / SFTP / remote-desktop workbench to the dsh sidebar: xterm terminals over ssh2, a two-pane SFTP browser with recursive transfers, port forwarding and a SOCKS5 proxy, an RDP/VNC launcher, and dsh's own model behind the AI command bar. A GUI-only plugin: it registers no tools and touches no system prompt. It has runtime dependencies (ssh2, xterm and optionally node-pty), so installing it fetches packages from npm and takes longer than the others.",
    heavy: true,
};

/// 鲨鱼数据库：完整的数据库管理器。内置插件里最重的一个。
pub const OTOOLS_DBM: Bundled = Bundled {
    id: "dsh-plugin-otools-dbm",
    title_zh: "鲨鱼数据库",
    title_en: "Shark database manager",
    summary_zh: "在 dsh 侧栏加一个完整的数据库管理器：连接树、可直接改的数据表格、表设计器、SQL 工作台、Redis 浏览器、导入导出、带计划的备份中心、结构与数据同步、数据字典、用户管理，AI 面板走 dsh 自己的模型。纯 GUI 插件，不注册工具、不改系统提示。驱动是运行时依赖（MySQL、PostgreSQL、MongoDB、Redis、SQL Server、ClickHouse、Kafka 等十来个包），装它要从 npm 拉不少东西，是所有内置插件里最慢的一个。",
    summary_en: "Adds a full database manager to the dsh sidebar: connection tree, an editable data grid, a table designer, a SQL workbench, a Redis browser, export/import, a backup centre with schedules, structure and data sync, a data dictionary, a user manager, and an AI panel wired to dsh's own model. A GUI-only plugin: it registers no tools and touches no system prompt. The drivers are runtime dependencies — a dozen packages covering MySQL, PostgreSQL, MongoDB, Redis, SQL Server, ClickHouse and Kafka — so installing it pulls a lot from npm and is the slowest of the bundled plugins.",
    heavy: true,
};

/// 安装包带上的插件，按卡片顺序。新增一个插件只要往这里加一行，装卸、首启询问、
/// 设置页与诊断信息都会跟着走——单插件的假设不该散落在各处。
///
/// 顺序上把 `heavy` 的排在最后：首启是逐个串行装的，先把不用联网拉依赖的装完记上，
/// 慢的那两个失败也不影响前面的成果。
///
/// 这份名单还要与 `scripts/pack-plugins.mjs`（打哪些 tarball）和 `tauri.conf.json`
/// 的 `bundle.resources`（哪些 tarball 进安装包）逐一对齐，三处失配都不会在构建时
/// 报错——`scripts/bundled-plugins.test.mjs` 就是为此存在的。
pub const BUNDLED: &[Bundled] = &[
    TASKBOARD,
    CANVAS,
    MOBILE_BRIDGE,
    REPOPANEL,
    OTOOLS_GIT,
    AUTOMATION,
    LONGREAD,
    OTOOLS_TERM,
    OTOOLS_DBM,
];

/// 按 id 找一个内置插件。前端传来的 id 不可信，所以查表而不是直接拼命令。
pub fn find(id: &str) -> Option<&'static Bundled> {
    BUNDLED.iter().find(|plugin| plugin.id == id)
}

/// 让用户自己移除的命令。这个 dsh 版本没有插件卸载界面，只能给命令。
pub fn remove_command(id: &str) -> String {
    format!("dsh plugin --profile {PROFILE} remove {id}")
}

/// 失败原因。
///
/// 刻意不用 `thiserror` 的 `#[error(...)]` 生成 `Display`：这些文字会走到界面上，
/// 要跟着 `i18n::current()` 变。手写 `Display` 的代价是多一个 match，换来的是
/// 两种语言并排可读、参数留在原地用 `format!` 检查。
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    Dsh(#[from] DshError),

    NoHome,

    Resource(#[source] tauri::Error),

    Stage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    Manifest {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    Spawn(#[source] std::io::Error),

    AddFailed {
        code: String,
        log: String,
    },

    AddTimeout {
        log: String,
        /// 实际给了多少耐心。轻重插件不一样，报错里不能写死一个数。
        timeout: Duration,
    },

    NotActivated {
        path: PathBuf,
        id: &'static str,
    },

    StillActivated {
        path: PathBuf,
        id: &'static str,
    },
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let zh = crate::i18n::is_zh();
        match self {
            Self::Dsh(source) => write!(f, "{source}"),
            Self::NoHome => f.write_str(if zh {
                "无法确定用户主目录"
            } else {
                "Cannot determine the user home directory"
            }),
            Self::Resource(source) => {
                if zh {
                    write!(f, "定位内置插件资源失败: {source}")
                } else {
                    write!(f, "Failed to locate the bundled plugin resource: {source}")
                }
            }
            Self::Stage { path, source } => {
                let path = path.display();
                if zh {
                    write!(f, "把内置插件复制到 {path} 失败: {source}")
                } else {
                    write!(f, "Failed to copy the bundled plugin to {path}: {source}")
                }
            }
            Self::Manifest { path, source } => {
                let path = path.display();
                if zh {
                    write!(f, "读取 {path} 失败: {source}")
                } else {
                    write!(f, "Failed to read {path}: {source}")
                }
            }
            Self::Spawn(source) => {
                if zh {
                    write!(f, "执行 dsh plugin 失败: {source}")
                } else {
                    write!(f, "Failed to run dsh plugin: {source}")
                }
            }
            Self::AddFailed { code, log } => {
                if zh {
                    write!(f, "dsh plugin 失败（退出码 {code}）:\n{log}")
                } else {
                    write!(f, "dsh plugin failed (exit code {code}):\n{log}")
                }
            }
            Self::AddTimeout { log, timeout } => {
                let seconds = timeout.as_secs();
                if zh {
                    write!(f, "dsh plugin 超过 {seconds}s 仍未完成:\n{log}")
                } else {
                    write!(f, "dsh plugin did not finish within {seconds}s:\n{log}")
                }
            }
            Self::NotActivated { path, id } => {
                let path = path.display();
                if zh {
                    write!(
                        f,
                        "add 报告成功，但 {path} 的 bundles 里没有 {id}——插件并没有被激活"
                    )
                } else {
                    write!(
                        f,
                        "add reported success, but {id} is missing from the bundles in {path} — the plugin was not activated"
                    )
                }
            }
            Self::StillActivated { path, id } => {
                let path = path.display();
                if zh {
                    write!(f, "remove 报告成功，但 {path} 的 bundles 里还有 {id}")
                } else {
                    write!(
                        f,
                        "remove reported success, but {id} is still in the bundles in {path}"
                    )
                }
            }
        }
    }
}

/// 首启询问的结果。
///
/// 只问一次，所以这个文件放在 `runtime/` **外面**：升级上游 dsh 会重装整个
/// 运行时目录，不该把「已经问过用户」一起洗掉。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    /// 已经装上的插件 id。
    #[serde(default)]
    pub installed: Vec<String>,
    /// 用户明确取消过勾选。
    #[serde(default)]
    pub declined: bool,
    /// 累计失败次数。
    #[serde(default)]
    pub failures: u32,
}

impl Choice {
    /// 这事是否已经有结论了——有结论就不再问。
    ///
    /// 失败不算结论：pnpm 没装、网络不好都是能被修好的，下次启动可以再试；
    /// 但也不能一直纠缠，所以有次数上限。
    fn settled(&self) -> bool {
        self.declined || !self.installed.is_empty() || self.failures >= MAX_FAILURES
    }

    fn describe(&self) -> String {
        let zh = crate::i18n::is_zh();
        if !self.installed.is_empty() {
            let list = self.installed.join(", ");
            return if zh {
                format!("已装 {list}")
            } else {
                format!("installed {list}")
            };
        }
        if self.declined {
            return crate::i18n::pick("用户已拒绝", "declined by user").to_string();
        }
        if self.failures > 0 {
            let times = self.failures;
            return if zh {
                format!("失败 {times} 次")
            } else {
                format!("failed {times} time(s)")
            };
        }
        crate::i18n::pick("尚未询问", "not asked yet").to_string()
    }
}

fn choice_path() -> Result<PathBuf, PluginError> {
    Ok(app_dir()?.join("plugin-choice.json"))
}

/// 读上次的决定。读不出来就当没问过——最坏情况是多问一次，
/// 比因为一个坏文件永远不再提供插件要好。
pub fn load_choice() -> Choice {
    let Ok(path) = choice_path() else {
        return Choice::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Choice::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// 记下决定。写不进去不是致命错误（下次会再问一遍），但要留痕。
pub fn save_choice(choice: &Choice) {
    let written = choice_path().and_then(|path| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| PluginError::Stage {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let raw = serde_json::to_string_pretty(choice).unwrap_or_default();
        std::fs::write(&path, raw).map_err(|source| PluginError::Stage { path, source })
    });
    if let Err(error) = written {
        eprintln!("[plugins] 记录选择失败：{error}");
    }
}

/// 与 node 配套的 pnpm。
///
/// 和 `dsh::npm_command` 同一套路：先看 node 旁边，再指望 PATH。Windows 上必须
/// 带 `.cmd`——CreateProcess 不会替我们补 PATHEXT。
fn pnpm_command(node: &NodeRuntime) -> PathBuf {
    let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
    if let Some(dir) = node.path.parent() {
        let sibling = dir.join(name);
        if sibling.exists() {
            return sibling;
        }
    }
    PathBuf::from(name)
}

/// pnpm 在不在。
///
/// `dsh plugin` 只是把参数转发给 pnpm（上游 README 就是这么写的），没有 pnpm 它
/// 会以 127 退出。Node 自带 npm 而不带 pnpm，所以这在用户机器上是大概率事件——
/// 没有就干脆别提这个选项，不承诺做不到的事。
fn pnpm_available(node: &NodeRuntime) -> bool {
    let mut command = Command::new(pnpm_command(node));
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    matches!(command.status(), Ok(status) if status.success())
}

/// 要不要在启动页问这一次。
pub fn should_ask(node: &NodeRuntime) -> bool {
    let choice = load_choice();
    if choice.settled() {
        return false;
    }
    if !pnpm_available(node) {
        eprintln!("[plugins] 未找到 pnpm，跳过插件提示（dsh plugin 依赖 pnpm）");
        return false;
    }
    true
}

/// 把内置的 tarball 复制到可写的私有目录，返回它的绝对路径。
///
/// 不直接把安装目录里的资源交给 pnpm：Windows 上那是 Program Files（只读），
/// 而且外壳更新会重写它、卸载会删掉它，profile 里记下的 `file:` 路径就悬空了。
fn stage(app: &AppHandle, id: &str) -> Result<PathBuf, PluginError> {
    let name = format!("{id}.tgz");
    let source = app
        .path()
        .resolve(format!("plugins/{name}"), BaseDirectory::Resource)
        .map_err(PluginError::Resource)?;

    let dir = app_dir()?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|source| PluginError::Stage {
        path: dir.clone(),
        source,
    })?;

    let dest = dir.join(&name);
    std::fs::copy(&source, &dest).map_err(|source| PluginError::Stage {
        path: dest.clone(),
        source,
    })?;
    Ok(dest)
}

/// pnpm 的本地 tarball 规格。
///
/// Windows 上要自己加引号：上游用 `spawnSync(..., { shell: true })` 把参数拼成
/// 一条 cmd.exe 命令行，且不做任何引用——路径里有空格（用户名带空格很常见）就会
/// 被拆成两个参数。加了引号 cmd 会替我们脱掉，pnpm 收到的还是一个参数。
fn spec(tarball: &Path) -> String {
    let path = tarball.display();
    if cfg!(windows) {
        format!("\"file:{path}\"")
    } else {
        format!("file:{path}")
    }
}

/// `node <entry> plugin --profile web add file:<tarball>` 的参数表。
///
/// `--profile` 是 `plugin` 的**子命令本地必填项**，只能写在 `plugin` 后面；
/// 放到前面上游会直接报错。`add` 是 pnpm 的动词，dsh 原样转发。
fn add_args(entry: &Path, tarball: &Path) -> Vec<String> {
    vec![
        entry.to_string_lossy().into_owned(),
        "plugin".into(),
        "--profile".into(),
        PROFILE.into(),
        "add".into(),
        spec(tarball),
    ]
}

/// `node <entry> plugin --profile web remove <id>` 的参数表。
///
/// `remove` 同样是转发给 pnpm 的动词。上游只在包**曾经是 dependency** 时才把它从
/// bundles 里摘掉——我们装的就是 dependency，所以官方命令能卸干净。
fn remove_args(entry: &Path, id: &str) -> Vec<String> {
    vec![
        entry.to_string_lossy().into_owned(),
        "plugin".into(),
        "--profile".into(),
        PROFILE.into(),
        "remove".into(),
        id.into(),
    ]
}

/// 跑一次 `dsh plugin <args>`。
///
/// `timeout` 由调用方按插件给：解一个本地 tarball 是秒级的事，但带运行时依赖的插件
/// 还要等 pnpm 把依赖从 npm 拉回来。
fn run(
    node: &NodeRuntime,
    args: Vec<String>,
    logs: &LogRing,
    timeout: Duration,
) -> Result<(), PluginError> {
    let mut command = Command::new(&node.path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    // dsh 用裸名 `pnpm` 起子进程。pnpm 常与 node 同目录（nvm/corepack 都是），
    // 把 node 目录前置进 PATH 同时解决「用哪个 node」和「找不到 pnpm」。
    if let Some(dir) = node.path.parent() {
        prepend_path(&mut command, dir);
    }
    hide_console(&mut command);

    let mut child = command.spawn().map_err(PluginError::Spawn)?;
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(pump(stdout, logs.clone(), "plugin"));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(pump(stderr, logs.clone(), "plugin"));
    }

    /// 等输出读完再取快照。上游把 pnpm 的 stdio 设成 inherit，所以失败原因是
    /// pnpm 临死前打出来的那几行——进程已经退出不代表那几行已经进了缓冲。
    fn drain(readers: Vec<std::thread::JoinHandle<()>>) {
        for reader in readers {
            let _ = reader.join();
        }
    }

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                drain(readers);
                if status.success() {
                    return Ok(());
                }
                return Err(PluginError::AddFailed {
                    code: status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    log: logs.snapshot(),
                });
            }
            Ok(None) => {}
            Err(source) => return Err(PluginError::Spawn(source)),
        }

        if Instant::now() >= deadline {
            // pnpm 卡住会留下子进程，整棵树一起收
            let _ = crate::server::terminate(&mut child);
            drain(readers);
            return Err(PluginError::AddTimeout {
                log: logs.snapshot(),
                timeout,
            });
        }

        std::thread::sleep(Duration::from_millis(200));
    }
}

/// dsh 的 web profile 清单路径。上游取 `$DSH_HOME`，否则 `~/.dsh`。
fn profile_manifest() -> Result<PathBuf, PluginError> {
    let home = match std::env::var("DSH_HOME") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => dirs::home_dir().ok_or(PluginError::NoHome)?.join(".dsh"),
    };
    Ok(home.join("profiles").join(PROFILE).join("package.json"))
}

/// 清单里这个插件是否真的被激活了。
///
/// `dsh.profile.bundles` 才是「激活」的契约：包进了 `dependencies` 但没进 bundles
/// 说明装的东西不是插件（上游那种情况只打一行 warning，退出码仍是 0）。
fn activated(manifest: &str, id: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()
        .and_then(|value| {
            let rows = value.pointer("/dsh/profile/bundles")?.as_array()?.clone();
            Some(rows.iter().any(|row| row.as_str() == Some(id)))
        })
        .unwrap_or(false)
}

/// 查落盘状态确认装成了。上游成功时不打印任何成功行，只能这样验。
fn confirm_activated(plugin: &'static Bundled) -> Result<(), PluginError> {
    let path = profile_manifest()?;
    let raw = std::fs::read_to_string(&path).map_err(|source| PluginError::Manifest {
        path: path.clone(),
        source,
    })?;
    if activated(&raw, plugin.id) {
        Ok(())
    } else {
        Err(PluginError::NotActivated {
            path,
            id: plugin.id,
        })
    }
}

/// 同理，确认真的卸掉了。
fn confirm_removed(plugin: &'static Bundled) -> Result<(), PluginError> {
    let path = profile_manifest()?;
    let raw = std::fs::read_to_string(&path).map_err(|source| PluginError::Manifest {
        path: path.clone(),
        source,
    })?;
    if activated(&raw, plugin.id) {
        Err(PluginError::StillActivated {
            path,
            id: plugin.id,
        })
    } else {
        Ok(())
    }
}

/// 完整的启用流程：落地 tarball → 走官方 CLI → 校验真的激活了。
///
/// 日志无论成败都要带出去：上游成功时一个字都不打印，失败的原因只在这里。
pub fn install(
    app: &AppHandle,
    node: &NodeRuntime,
    entry: &Path,
    plugin: &'static Bundled,
) -> (Result<(), PluginError>, String) {
    let logs = LogRing::default();
    let result = stage(app, plugin.id).and_then(|tarball| {
        run(node, add_args(entry, &tarball), &logs, plugin.add_timeout())?;
        confirm_activated(plugin)
    });
    (result, logs.snapshot())
}

/// 移除流程。tarball 留在 app data 里不动——下次装回来不用再复制一遍。
pub fn uninstall(
    node: &NodeRuntime,
    entry: &Path,
    plugin: &'static Bundled,
) -> (Result<(), PluginError>, String) {
    let logs = LogRing::default();
    // 卸载只动 profile 清单再让 pnpm 剪掉本地依赖，不联网，所以一律用短耐心。
    let result = run(node, remove_args(entry, plugin.id), &logs, ADD_TIMEOUT)
        .and_then(|()| confirm_removed(plugin));
    (result, logs.snapshot())
}

/// 设置页看到的插件状态。
///
/// 以**落盘状态**为准，不看决定档：用户完全可能自己在命令行上装过或卸过。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: &'static str,
    /// 已按当前语言取好。前端拿到就直接显示。
    pub title: &'static str,
    pub summary: &'static str,
    /// profile 的 bundles 里有它。
    pub installed: bool,
    /// 没有 pnpm 就既装不了也卸不了——`dsh plugin` 是转发给 pnpm 的。
    pub pnpm: bool,
    pub remove_command: String,
}

pub fn status(node: Option<&NodeRuntime>) -> Vec<Status> {
    // 清单读一次给所有插件用：装卸都是逐个走 CLI，但状态是同一份落盘事实。
    let manifest = profile_manifest()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let pnpm = node.map(pnpm_available).unwrap_or(false);
    BUNDLED
        .iter()
        .map(|plugin| Status {
            id: plugin.id,
            title: plugin.title(),
            summary: plugin.summary(),
            installed: activated(&manifest, plugin.id),
            pnpm,
            remove_command: remove_command(plugin.id),
        })
        .collect()
}

/// 诊断信息里的一行摘要。
pub fn diagnostics_line() -> String {
    let choice = load_choice();
    let installed: Vec<&str> = BUNDLED
        .iter()
        .filter(|plugin| choice.installed.iter().any(|id| id == plugin.id))
        .map(|plugin| plugin.id)
        .collect();
    let state = if !installed.is_empty() {
        let list = installed.join(", ");
        if crate::i18n::is_zh() {
            format!("已装 {list}")
        } else {
            format!("installed {list}")
        }
    } else {
        choice.describe()
    };
    let all = BUNDLED
        .iter()
        .map(|plugin| plugin.id)
        .collect::<Vec<_>>()
        .join(", ");
    if crate::i18n::is_zh() {
        format!("内置插件（{all}）: {state}")
    } else {
        format!("Bundled plugins ({all}): {state}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 每个内置插件的 package.json 原文。
    ///
    /// `include_str!` 要求字面量路径，所以逐个列出而不是遍历 `BUNDLED`；
    /// [`every_bundled_plugin_has_its_manifest_here`] 保证这张表和 `BUNDLED` 不会走散。
    const MANIFESTS: &[(&str, &str)] = &[
        (
            "dsh-plugin-taskboard",
            include_str!("../../plugins/dsh-plugin-taskboard/package.json"),
        ),
        (
            "dsh-plugin-canvas",
            include_str!("../../plugins/dsh-plugin-canvas/package.json"),
        ),
        (
            "dsh-plugin-mobile-bridge",
            include_str!("../../plugins/dsh-plugin-mobile-bridge/package.json"),
        ),
        (
            "dsh-plugin-repopanel",
            include_str!("../../plugins/dsh-plugin-repopanel/package.json"),
        ),
        (
            "dsh-plugin-otools-git",
            include_str!("../../plugins/dsh-plugin-otools-git/package.json"),
        ),
        (
            "dsh-plugin-automation",
            include_str!("../../plugins/dsh-plugin-automation/package.json"),
        ),
        (
            "dsh-plugin-longread",
            include_str!("../../plugins/dsh-plugin-longread/package.json"),
        ),
        (
            "dsh-plugin-otools-term",
            include_str!("../../plugins/dsh-plugin-otools-term/package.json"),
        ),
        (
            "dsh-plugin-otools-dbm",
            include_str!("../../plugins/dsh-plugin-otools-dbm/package.json"),
        ),
    ];

    #[test]
    fn add_args_put_profile_after_the_subcommand() {
        let args = add_args(Path::new("/dsh/bin.js"), Path::new("/tmp/x.tgz"));
        assert_eq!(args[0], "/dsh/bin.js");
        assert_eq!(&args[1..5], &["plugin", "--profile", "web", "add"]);
        assert!(
            args[5].contains("file:/tmp/x.tgz"),
            "最后一个参数应是本地 tarball 规格: {}",
            args[5]
        );
    }

    #[test]
    fn spec_quotes_on_windows_only() {
        let spec = spec(Path::new(r"C:\Users\A B\x.tgz"));
        if cfg!(windows) {
            assert!(
                spec.starts_with('"') && spec.ends_with('"'),
                "Windows 上必须自带引号，否则含空格的路径会被 cmd.exe 拆开: {spec}"
            );
            assert_eq!(spec.matches('"').count(), 2, "只在两端各一个引号");
        } else {
            assert!(
                !spec.contains('"'),
                "非 Windows 直接 exec，不能带引号: {spec}"
            );
        }
        assert!(spec.contains("file:"), "必须是 pnpm 的 file: 协议");
    }

    #[test]
    fn activated_reads_the_bundles_array() {
        let manifest = json!({
            "dependencies": { "dsh-plugin-taskboard": "file:x.tgz" },
            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-taskboard"] } }
        })
        .to_string();
        assert!(activated(&manifest, "dsh-plugin-taskboard"));
    }

    #[test]
    fn dependency_without_bundle_row_is_not_activated() {
        // 上游遇到「不是插件的包」时只打一行 warning，退出码仍是 0，
        // 所以只看退出码会把这种情况当成功。
        let manifest = json!({
            "dependencies": { "dsh-plugin-taskboard": "file:x.tgz" },
            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
        })
        .to_string();
        assert!(!activated(&manifest, "dsh-plugin-taskboard"));
    }

    #[test]
    fn unusable_manifests_are_not_activated() {
        assert!(!activated("", "dsh-plugin-taskboard"));
        assert!(!activated("{}", "dsh-plugin-taskboard"));
        assert!(!activated(
            r#"{"dsh":{"profile":{}}}"#,
            "dsh-plugin-taskboard"
        ));
        assert!(!activated("不是 JSON", "dsh-plugin-taskboard"));
    }

    #[test]
    fn only_a_real_conclusion_settles_the_prompt() {
        assert!(!Choice::default().settled(), "没问过就该问");
        assert!(Choice {
            declined: true,
            ..Default::default()
        }
        .settled());
        assert!(Choice {
            installed: vec![TASKBOARD.id.into()],
            ..Default::default()
        }
        .settled());
        assert!(
            !Choice {
                failures: MAX_FAILURES - 1,
                ..Default::default()
            }
            .settled(),
            "失败还没到上限时下次应该再试"
        );
        assert!(Choice {
            failures: MAX_FAILURES,
            ..Default::default()
        }
        .settled());
    }

    #[test]
    fn choice_round_trips_as_camel_case() {
        let choice = Choice {
            installed: vec![TASKBOARD.id.into()],
            declined: false,
            failures: 1,
        };
        let raw = serde_json::to_string(&choice).unwrap();
        assert!(raw.contains("installed"), "字段名应稳定: {raw}");
        let back: Choice = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.installed, choice.installed);
        assert_eq!(back.failures, choice.failures);
    }

    /// 缺字段的旧文件不能让读取失败——否则一个格式变更就会让所有人被重新问一遍。
    #[test]
    fn partial_choice_files_still_parse() {
        let back: Choice = serde_json::from_str(r#"{"declined":true}"#).unwrap();
        assert!(back.declined);
        assert!(back.installed.is_empty());
    }

    /// 解析某个内置插件的清单。
    fn manifest(id: &str) -> serde_json::Value {
        let (_, raw) = MANIFESTS
            .iter()
            .find(|(name, _)| *name == id)
            .unwrap_or_else(|| panic!("{id} 的清单没进 MANIFESTS"));
        serde_json::from_str(raw).unwrap()
    }

    /// 这张表和 `BUNDLED` 不能走散——散了下面两条守卫就会漏掉新插件。
    #[test]
    fn every_bundled_plugin_has_its_manifest_here() {
        assert_eq!(
            MANIFESTS.len(),
            BUNDLED.len(),
            "新增内置插件时也要把它的清单加进 MANIFESTS"
        );
        for plugin in BUNDLED {
            assert_eq!(
                manifest(plugin.id).get("name").and_then(|n| n.as_str()),
                Some(plugin.id),
                "{} 的清单对不上",
                plugin.id
            );
        }
    }

    /// `heavy` 决定给多少耐心，而判据是清单里到底有没有要联网拉的依赖——
    /// 加插件时忘了标，用户那边就是「装到一半超时失败」。
    #[test]
    fn heavy_is_exactly_the_plugins_with_runtime_dependencies() {
        for plugin in BUNDLED {
            let manifest = manifest(plugin.id);
            let has_deps = ["dependencies", "optionalDependencies"].iter().any(|key| {
                manifest
                    .get(key)
                    .and_then(|deps| deps.as_object())
                    .is_some_and(|deps| !deps.is_empty())
            });
            assert_eq!(
                plugin.heavy, has_deps,
                "{} 的 heavy 与它清单里的运行时依赖不一致",
                plugin.id
            );
            let expected = if has_deps {
                HEAVY_ADD_TIMEOUT
            } else {
                ADD_TIMEOUT
            };
            assert_eq!(plugin.add_timeout(), expected);
        }
        assert!(HEAVY_ADD_TIMEOUT > ADD_TIMEOUT);
    }

    /// 升 `upstream::DSH_VERSION` 之前必须先回归每个内置插件，并把结论写进它的
    /// `dsh.compatibility.dshReleases`。这条守卫就是「预装插件抬高升级成本」
    /// 这个风险的对冲：忘了回归，`cargo test` 直接红。
    #[test]
    fn bundled_plugins_declare_the_pinned_dsh_version_compatible() {
        for plugin in BUNDLED {
            let manifest = manifest(plugin.id);
            assert_eq!(
                manifest
                    .pointer("/dsh/compatibility/dshReleases")
                    .and_then(|releases| releases.get(crate::upstream::DSH_VERSION))
                    .and_then(|value| value.as_str()),
                Some("compatible"),
                "{} 没被标记为与 dsh {} 兼容：先回归插件，再更新它的 compatibility.dshReleases",
                plugin.id,
                crate::upstream::DSH_VERSION
            );
        }
    }

    /// `remove` 必须点名要卸的那一个：它是转发给 pnpm 的动词，参数错了会去动
    /// 别的包。装的路径由 `add_args` 那条测试盯着，卸的路径盯这里。
    #[test]
    fn remove_args_name_the_plugin_being_removed() {
        let args = remove_args(Path::new("/dsh/bin.js"), MOBILE_BRIDGE.id);
        assert_eq!(&args[1..5], &["plugin", "--profile", "web", "remove"]);
        assert_eq!(args[5], MOBILE_BRIDGE.id);
    }

    /// 内置插件的 id 是资源文件名、profile 行名和前端 key，重名会静默串台。
    #[test]
    fn bundled_ids_are_unique() {
        let mut ids: Vec<&str> = BUNDLED.iter().map(|plugin| plugin.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "内置插件 id 不能重复");
        assert!(BUNDLED.iter().all(|plugin| find(plugin.id).is_some()));
        assert!(find("不存在的插件").is_none());
    }
}
