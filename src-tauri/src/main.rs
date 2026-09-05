// 发布版不要额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dsh;
mod node;
mod plugins;
mod server;
mod update;
mod upstream;

use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

use server::DshServer;

/// 启动阶段。前端据此渲染进度或错误页。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "stage",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BootState {
    /// 正在查找可用的 Node
    LocatingNode,
    /// 正在安装锁定版本的 dsh（首次启动或版本变更时）。
    ///
    /// 带上进度是必需的:dsh 的依赖树有 100+ 个包,npm 在解析阶段会静默
    /// 好几分钟,没有进展信号的话首次启动看起来就是卡死。
    InstallingDsh {
        version: String,
        fetched: usize,
        elapsed_secs: u64,
    },
    /// 正在启动 dsh web 服务
    StartingServer,
    /// 等用户在启动页确认那个可选插件。
    ///
    /// 只在 dsh 已经装好时出现：没有安装阶段可以等，卡片不等一次点击就只会闪一下。
    AwaitingChoice,
    /// 正在按用户的选择启用内置插件
    ConfiguringPlugin { name: String },
    /// 就绪，webview 即将跳转
    Ready { url: String },
    /// 失败。`kind` 决定前端展示哪种指引。
    Failed {
        kind: FailureKind,
        message: String,
        log: String,
    },
}

/// 失败类型——决定给用户看什么指引，而不只是一段报错。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// 没找到 Node：给下载链接
    NodeMissing,
    /// Node 版本太低：给升级指引
    NodeTooOld,
    /// npm 安装 dsh 失败：多半是网络或注册表问题
    InstallFailed,
    /// dsh 起来了但没就绪，或直接崩了
    ServerFailed,
}

pub struct AppState {
    boot: Arc<Mutex<BootState>>,
    server: Arc<Mutex<Option<DshServer>>>,
    /// 实际选中的 Node。诊断信息里最有价值的一条:这个架构下
    /// 「用户以为在用哪个 node」和「外壳真正拉起的是哪个」经常不是一回事。
    node: Arc<Mutex<Option<node::NodeRuntime>>>,
    /// 首启插件提示。前端切复选框时更新，启动线程装完 dsh 后读它。
    prompt: Arc<(Mutex<Prompt>, Condvar)>,
    /// 最后一次 dsh plugin 的输出。上游成功时不打印任何东西，失败原因只在这里。
    plugin_log: Arc<Mutex<Option<String>>>,
    /// 上一次检查发现的、待安装的外壳更新。
    pending: update::Pending,
    /// 托盘里那一项「设置」。发现新版本时要改它的文字——没有窗口开着时，
    /// 托盘是唯一能被看见的界面。
    settings_item: Arc<Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>>,
    /// 已经为哪个版本弹过窗。后台每 30 分钟查一次，同一个版本反复弹比不弹更糟。
    popped_version: Arc<Mutex<Option<String>>>,
}

/// 启动页那张插件卡片的状态。
#[derive(Debug, Clone, Default)]
struct Prompt {
    /// 卡片是否正在展示。
    asking: bool,
    /// 当前被勾选的插件 id。
    selected: Vec<String>,
    /// 用户已经点过「继续」。
    confirmed: bool,
    /// 需要点一次才继续。
    requires_click: bool,
}

impl Prompt {
    fn payload(&self) -> PluginPrompt {
        PluginPrompt {
            plugins: plugins::BUNDLED
                .iter()
                .map(|plugin| PromptPlugin {
                    id: plugin.id,
                    title: plugin.title,
                    summary: plugin.summary,
                    remove_command: plugins::remove_command(plugin.id),
                    install: self.selected.iter().any(|id| id == plugin.id),
                })
                .collect(),
            requires_click: self.requires_click,
        }
    }
}

/// 发给前端的卡片内容。一张卡片一个插件，勾选状态各自独立。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPrompt {
    plugins: Vec<PromptPlugin>,
    requires_click: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPlugin {
    id: &'static str,
    title: &'static str,
    summary: &'static str,
    /// 这个 dsh 版本没有插件卸载界面，所以把移除命令直接写在卡片上。
    remove_command: String,
    install: bool,
}

impl AppState {
    fn new() -> Self {
        Self {
            boot: Arc::new(Mutex::new(BootState::LocatingNode)),
            server: Arc::new(Mutex::new(None)),
            node: Arc::new(Mutex::new(None)),
            prompt: Arc::new((Mutex::new(Prompt::default()), Condvar::new())),
            plugin_log: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(None)),
            settings_item: Arc::new(Mutex::new(None)),
            popped_version: Arc::new(Mutex::new(None)),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // 启动线程 panic 不应该连带让整个应用无法响应
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 当前启动状态。前端首帧调用，避免错过已经发出的事件。
#[tauri::command]
fn boot_state(state: tauri::State<'_, AppState>) -> BootState {
    lock(&state.boot).clone()
}

/// 当前是否有插件提示要展示。前端首帧调用，避免错过已经发出的事件。
#[tauri::command]
fn plugin_prompt(state: tauri::State<'_, AppState>) -> Option<PluginPrompt> {
    let (mutex, _) = &*state.prompt;
    let prompt = lock(mutex).clone();
    prompt.asking.then(|| prompt.payload())
}

/// 某个复选框被切换。存到 Rust 侧——dsh 装完时以它为准，用户不需要点任何按钮。
#[tauri::command]
fn set_plugin_choice(state: tauri::State<'_, AppState>, id: String, install: bool) {
    if plugins::find(&id).is_none() {
        return;
    }
    let (mutex, _) = &*state.prompt;
    let mut prompt = lock(mutex);
    prompt.selected.retain(|current| current != &id);
    if install {
        prompt.selected.push(id);
    }
}

/// 用户点了「继续」。
#[tauri::command]
fn confirm_plugins(state: tauri::State<'_, AppState>, ids: Vec<String>) {
    let (mutex, notify) = &*state.prompt;
    {
        let mut prompt = lock(mutex);
        prompt.selected = ids
            .into_iter()
            .filter(|id| plugins::find(id).is_some())
            .collect();
        prompt.confirmed = true;
    }
    notify.notify_all();
}

/// 设置页的插件区。以 profile 落盘状态为准。
#[tauri::command]
fn plugin_status(state: tauri::State<'_, AppState>) -> Vec<plugins::Status> {
    let node = lock(&state.node).clone();
    plugins::status(node.as_ref())
}

/// 设置页里手动安装某个内置插件。
#[tauri::command]
async fn plugin_install(app: tauri::AppHandle, id: String) -> Result<Vec<plugins::Status>, String> {
    change_plugin(app, id, true).await
}

/// 设置页里手动移除某个内置插件。
#[tauri::command]
async fn plugin_remove(app: tauri::AppHandle, id: String) -> Result<Vec<plugins::Status>, String> {
    change_plugin(app, id, false).await
}

/// 装或卸。底下跑的是 pnpm，秒级但是阻塞的，所以丢到 blocking 线程池，
/// 不占着 async runtime 的 worker。
async fn change_plugin(
    app: tauri::AppHandle,
    id: String,
    install: bool,
) -> Result<Vec<plugins::Status>, String> {
    // id 来自前端，查表落到静态定义上，绝不拿它去拼命令行。
    let plugin = plugins::find(&id).ok_or_else(|| format!("未知的内置插件：{id}"))?;
    let node = {
        let state = app.state::<AppState>();
        let selected = lock(&state.node);
        selected.clone()
    }
    .ok_or_else(|| "还没有选定 Node，等启动完成再试".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let entry = dsh::runtime_dir()
            .and_then(|dir| dsh::entry_script(&dir))
            .map_err(|error| error.to_string())?;

        let (result, log) = if install {
            plugins::install(&app, &node, &entry, plugin)
        } else {
            plugins::uninstall(&node, &entry, plugin)
        };
        {
            let state = app.state::<AppState>();
            *lock(&state.plugin_log) = Some(log);
        }

        // 决定档跟着走：用户在设置里卸掉之后，下次启动不该又来问一遍
        let mut choice = plugins::load_choice();
        match (&result, install) {
            (Ok(()), true) => {
                if !choice.installed.iter().any(|current| current == plugin.id) {
                    choice.installed.push(plugin.id.to_string());
                }
                choice.declined = false;
                choice.failures = 0;
            }
            (Ok(()), false) => {
                choice.installed.retain(|current| current != plugin.id);
                // 手动卸掉最后一个就等于「不要内置插件」，下次启动别再问。
                if choice.installed.is_empty() {
                    choice.declined = true;
                }
            }
            (Err(_), _) => {}
        }
        plugins::save_choice(&choice);

        result.map_err(|error| error.to_string())?;
        Ok(plugins::status(Some(&node)))
    })
    .await
    .map_err(|error| format!("插件操作的线程异常结束: {error}"))?
}

/// 供错误页「复制诊断信息」使用。
///
/// 刻意包含实际选中的 node 路径与版本、以及 dsh 最近的输出:
/// 这个架构下的故障几乎都出在「哪个 node」和「dsh 说了什么」上,
/// 让用户手填这两项既麻烦又不可靠。
#[tauri::command]
fn diagnostics(state: tauri::State<'_, AppState>) -> String {
    let info = collect_info(&state);
    let boot = lock(&state.boot).clone();

    let dsh_output = match lock(&state.server).as_ref() {
        Some(server) => {
            let snapshot = server.logs.snapshot();
            if snapshot.is_empty() {
                "<无输出>".to_string()
            } else {
                snapshot
            }
        }
        None => "<服务未运行>".to_string(),
    };

    let plugin_output = lock(&state.plugin_log)
        .clone()
        .unwrap_or_else(|| "<本次启动未执行>".to_string());

    format!(
        "DSH Desktop Ultra {shell}\n\
         平台: {platform}\n\
         Node: {node}\n\
         dsh 锁定版本: {pinned}\n\
         dsh 已安装版本: {installed}\n\
         运行时目录: {runtime_dir}\n\
         {plugins}\n\
         启动状态: {boot:?}\n\
         \n--- dsh 输出 ---\n{dsh_output}\n\
         \n--- dsh plugin 输出 ---\n{plugin_output}\n",
        shell = info.shell,
        platform = info.platform,
        node = info.node,
        pinned = info.dsh_pinned,
        installed = info.dsh_installed,
        runtime_dir = info.runtime_dir,
        plugins = plugins::diagnostics_line(),
    )
}

/// 设置页展示的基本信息，同时是诊断文本的数据来源——一份数据两种用法。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    shell: String,
    platform: String,
    /// 实际选中的 Node。这个架构下「用户以为在用哪个」和「外壳真正拉起的是哪个」经常不一致。
    node: String,
    dsh_pinned: String,
    dsh_installed: String,
    runtime_dir: String,
}

fn collect_info(state: &AppState) -> AppInfo {
    AppInfo {
        shell: env!("CARGO_PKG_VERSION").to_string(),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        node: match lock(&state.node).as_ref() {
            Some(runtime) => format!("{} ({})", runtime.version, runtime.path.display()),
            None => "<尚未选定>".to_string(),
        },
        dsh_pinned: upstream::DSH_VERSION.to_string(),
        dsh_installed: dsh::runtime_dir()
            .ok()
            .and_then(|dir| dsh::installed_version(&dir))
            .unwrap_or_else(|| "<未安装>".to_string()),
        runtime_dir: dsh::runtime_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|error| format!("<不可用: {error}>")),
    }
}

/// 设置页首帧调用。
#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    collect_info(&state)
}

/// 更新状态并通知前端。
///
/// 同时打到 stderr。跳转到 dsh 的 UI 之后前端就换人了，届时外壳自己的
/// 状态只能靠日志观察；启动失败的现场也需要能在终端里复现。
/// 安装进度会每 400ms 触发一次，太吵，单独降噪。
fn transition(app: &tauri::AppHandle, next: BootState) {
    match &next {
        // 只在整十秒的刻度上打一行，避免刷屏
        BootState::InstallingDsh {
            fetched,
            elapsed_secs,
            ..
        } => {
            if elapsed_secs % 10 == 0 {
                eprintln!("[boot] 安装 dsh 中：已获取 {fetched} 个包，已用 {elapsed_secs}s");
            }
        }
        BootState::Failed { kind, message, .. } => {
            eprintln!("[boot] 失败（{kind:?}）：{message}");
        }
        other => eprintln!("[boot] {other:?}"),
    }

    let state = app.state::<AppState>();
    *lock(&state.boot) = next.clone();
    // 事件发不出去不是致命错误：前端还能靠 boot_state 命令兜底
    let _ = app.emit("boot-state", next);
}

/// 完整的启动序列，在后台线程里跑。
///
/// 每一步失败都映射成带指引的 `FailureKind`，而不是往上抛一个裸错误——
/// 「没装 Node」和「dsh 崩了」对用户来说是两件完全不同的事。
fn boot(app: tauri::AppHandle) {
    transition(&app, BootState::LocatingNode);

    let runtime = match node::discover() {
        Ok(runtime) => runtime,
        Err(error) => {
            let kind = match &error {
                node::NodeError::TooOld { .. } => FailureKind::NodeTooOld,
                _ => FailureKind::NodeMissing,
            };
            transition(
                &app,
                BootState::Failed {
                    kind,
                    message: error.to_string(),
                    log: String::new(),
                },
            );
            return;
        }
    };

    // 记下真正选中的 node，供诊断信息使用
    {
        let state = app.state::<AppState>();
        *lock(&state.node) = Some(runtime.clone());
    }

    let installed = dsh::runtime_dir()
        .ok()
        .filter(|dir| !dsh::needs_install(dir));

    // 插件提示要在装 dsh 之前就摆出来:首次安装是几十分钟,那段等待正好用来做
    // 这个选择,装完直接按当前勾选继续。已经装好时没有这段等待可用,
    // 才需要等用户点一次——否则卡片只会闪一下就过去了。
    let asking = plugins::should_ask(&runtime);
    if asking {
        start_prompt(&app, installed.is_some());
    }

    // 版本已匹配时 ensure_installed 是个空操作，但状态先切过去：
    // 首次安装要拉网络，几十秒的静默会让人以为卡死了。
    let dsh_runtime = match installed {
        Some(dir) => Ok(dir),
        None => {
            let app_clone = app.clone();
            dsh::ensure_installed(&runtime, &|progress| {
                transition(
                    &app_clone,
                    BootState::InstallingDsh {
                        version: upstream::DSH_VERSION.to_string(),
                        fetched: progress.fetched,
                        elapsed_secs: progress.elapsed.as_secs(),
                    },
                );
            })
        }
    };

    let dsh_runtime = match dsh_runtime {
        Ok(dir) => dir,
        Err(error) => {
            // 超时/失败时 npm 的输出是唯一能定位原因的材料
            let log = match &error {
                dsh::DshError::InstallFailed { stderr, .. } => stderr.clone(),
                dsh::DshError::InstallTimeout { log, .. } => log.clone(),
                _ => String::new(),
            };
            transition(
                &app,
                BootState::Failed {
                    kind: FailureKind::InstallFailed,
                    message: error.to_string(),
                    log,
                },
            );
            return;
        }
    };

    let entry = match dsh::entry_script(&dsh_runtime) {
        Ok(path) => path,
        Err(error) => {
            transition(
                &app,
                BootState::Failed {
                    kind: FailureKind::InstallFailed,
                    message: error.to_string(),
                    log: String::new(),
                },
            );
            return;
        }
    };

    if asking {
        settle_prompt(&app, &runtime, &entry);
    }

    transition(&app, BootState::StartingServer);

    match server::start(&runtime.path, &entry, None) {
        Ok(instance) => {
            let url = instance.url();
            {
                let state = app.state::<AppState>();
                *lock(&state.server) = Some(instance);
            }
            transition(&app, BootState::Ready { url: url.clone() });

            // 瘦壳的核心动作：把窗口整体交给 dsh 自己的 UI
            if let Some(window) = app.get_webview_window("main") {
                match url.parse() {
                    Ok(parsed) => {
                        if let Err(error) = window.navigate(parsed) {
                            transition(
                                &app,
                                BootState::Failed {
                                    kind: FailureKind::ServerFailed,
                                    message: format!("跳转到 {url} 失败: {error}"),
                                    log: String::new(),
                                },
                            );
                        }
                    }
                    Err(error) => transition(
                        &app,
                        BootState::Failed {
                            kind: FailureKind::ServerFailed,
                            message: format!("dsh 返回的地址无法解析 ({url}): {error}"),
                            log: String::new(),
                        },
                    ),
                }
            }
        }
        Err(error) => {
            let log = match &error {
                server::ServerError::ExitedEarly { log, .. }
                | server::ServerError::ReadyTimeout { log } => log.clone(),
                _ => String::new(),
            };
            transition(
                &app,
                BootState::Failed {
                    kind: FailureKind::ServerFailed,
                    message: error.to_string(),
                    log,
                },
            );
        }
    }
}

/// 摆出插件卡片，默认全部勾选。
fn start_prompt(app: &tauri::AppHandle, requires_click: bool) {
    let state = app.state::<AppState>();
    let (mutex, _) = &*state.prompt;
    let payload = {
        let mut prompt = lock(mutex);
        prompt.asking = true;
        prompt.selected = plugins::BUNDLED
            .iter()
            .map(|plugin| plugin.id.to_string())
            .collect();
        prompt.confirmed = false;
        prompt.requires_click = requires_click;
        prompt.payload()
    };
    // 事件发不出去不是致命错误：前端还能靠 plugin_prompt 命令兜底
    let _ = app.emit("plugin-prompt", payload);
}

/// 拿到用户的选择。
///
/// 等待有上限:窗口可以被关进托盘,那样没人会来点按钮,不能让启动永远挂着。
/// 超时就按默认(全勾)继续,与「装 dsh 期间没动过复选框」是同一个结果。
fn wait_for_choice(app: &tauri::AppHandle) -> Vec<String> {
    const PATIENCE: Duration = Duration::from_secs(10 * 60);

    let state = app.state::<AppState>();
    let (mutex, notify) = &*state.prompt;

    {
        let prompt = lock(mutex);
        if !prompt.requires_click {
            return prompt.selected.clone();
        }
    }

    transition(app, BootState::AwaitingChoice);

    let deadline = Instant::now() + PATIENCE;
    let mut prompt = lock(mutex);
    while !prompt.confirmed {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            eprintln!("[plugins] 等待确认超时，按默认选择继续");
            break;
        }
        prompt = match notify.wait_timeout(prompt, remaining) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        };
    }
    prompt.selected.clone()
}

/// 结算插件提示：必要时等一次点击，然后按勾选状态执行。
///
/// 必须在 `server::start` 之前:`dsh.profile.bundles` 每次 boot 只读一次
/// (只有 cordis.patch.yml 会热重载),装晚了要重启服务才生效。
fn settle_prompt(app: &tauri::AppHandle, node: &node::NodeRuntime, entry: &Path) {
    let chosen = wait_for_choice(app);

    {
        let state = app.state::<AppState>();
        let (mutex, _) = &*state.prompt;
        lock(mutex).asking = false;
    }

    let mut choice = plugins::load_choice();
    if chosen.is_empty() {
        eprintln!("[plugins] 用户没有勾选，不安装内置插件");
        choice.declined = true;
        plugins::save_choice(&choice);
        return;
    }

    // 逐个装：每个插件都是独立的一次 `dsh plugin add`，一个失败不该拖累其它的。
    for plugin in plugins::BUNDLED
        .iter()
        .filter(|plugin| chosen.iter().any(|id| id == plugin.id))
    {
        transition(
            app,
            BootState::ConfiguringPlugin {
                name: plugin.title.to_string(),
            },
        );

        let (result, log) = plugins::install(app, node, entry, plugin);
        {
            let state = app.state::<AppState>();
            *lock(&state.plugin_log) = Some(log);
        }

        match result {
            Ok(()) => choice.installed.push(plugin.id.to_string()),
            // 可选功能失败不该把应用弄挂:记下来,继续拉起服务。
            Err(error) => {
                eprintln!("[plugins] 启用 {} 失败：{error}", plugin.id);
                choice.failures += 1;
            }
        }
    }
    plugins::save_choice(&choice);
}

/// 停掉当前运行的 dsh 实例（若有）。
///
/// 必须把 MutexGuard 绑到具名局部变量:如果写成
/// `if let Some(x) = lock(&state.server).take() { .. }`,那个临时的 guard
/// 会活到整个 if let 结束,而 `state` 先被丢弃,借用检查器会拒绝(E0597)。
fn stop_server(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut server = lock(&state.server);
    if let Some(mut instance) = server.take() {
        instance.stop();
    }
}

/// 错误页的「重试」。
#[tauri::command]
fn retry_boot(app: tauri::AppHandle) {
    // 重试前先清掉可能残留的半死进程
    stop_server(&app);
    std::thread::spawn(move || boot(app));
}

/// 把窗口显示出来并聚焦。托盘的「显示窗口」和单击托盘图标都走这里。
fn reveal_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 打开设置窗口。托盘是它唯一的入口。
///
/// 关掉设置窗口是**销毁**（main 窗口才是隐藏），所以这里要么复用还活着的那个，
/// 要么重新建一个。建窗刻意丢到另一个线程：上游明确写了
/// `WebviewWindowBuilder` 在 Windows 的同步命令与事件回调里会死锁，
/// 而托盘菜单回调正是事件回调。
fn open_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            tauri::WebviewUrl::App("settings.html".into()),
        )
        .title("设置")
        .inner_size(560.0, 640.0)
        .center()
        .resizable(false)
        .maximizable(false)
        // 托盘拉起来的对话框不该在任务栏里再占一格
        .skip_taskbar(true)
        .build();
        if let Err(error) = built {
            eprintln!("[settings] 打开设置窗口失败：{error}");
        }
    });
}

/// 真正退出：先收掉 dsh 子进程，再让 Tauri 退出。
///
/// 关窗只是隐藏，所以退出只有托盘菜单这一条路——必须在这里停服务，
/// 否则 200MB 的 node 进程会一直留在后台。
fn quit(app: &tauri::AppHandle) {
    stop_server(app);
    app.exit(0);
}

/// 建立托盘图标与菜单。
///
/// 关窗缩托盘之后，托盘是唯一能把窗口找回来、也是唯一能真正退出的入口，
/// 所以菜单里这两项都必须有——只放一个图标会让用户既找不回窗口也退不掉。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DSH Desktop Ultra（运行中）")
        .menu(&menu)
        // 左键留给「显示窗口」这个高频动作，菜单走右键
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_window(app),
            "settings" => open_settings(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    // 存下菜单项：发现新版本时要改它的文字
    *lock(&app.state::<AppState>().settings_item) = Some(settings);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            boot_state,
            diagnostics,
            app_info,
            retry_boot,
            plugin_prompt,
            set_plugin_choice,
            confirm_plugins,
            plugin_status,
            plugin_install,
            plugin_remove,
            update::update_check,
            update::update_install,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;

            // 关窗改成隐藏。dsh 服务继续在后台跑，下次打开窗口是秒开，
            // 不用重新等它启动；真正退出走托盘菜单。
            if let Some(window) = app.get_webview_window("main") {
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }

            let boot_handle = handle.clone();
            std::thread::spawn(move || boot(boot_handle));

            // 后台每 30 分钟查一次外壳自己的更新
            update::spawn_watcher(handle.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            // 兜底：任何路径导致的退出都要收掉 dsh 子进程，
            // 否则会留下占着端口的孤儿 node，下次启动撞车
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
