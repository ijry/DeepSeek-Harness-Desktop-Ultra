// 发布版不要额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dsh;
mod node;
mod server;
mod upstream;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager};

use server::DshServer;

/// 启动阶段。前端据此渲染进度或错误页。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum BootState {
    /// 正在查找可用的 Node
    LocatingNode,
    /// 正在安装锁定版本的 dsh（首次启动或版本变更时）
    InstallingDsh { version: String },
    /// 正在启动 dsh web 服务
    StartingServer,
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
}

impl AppState {
    fn new() -> Self {
        Self {
            boot: Arc::new(Mutex::new(BootState::LocatingNode)),
            server: Arc::new(Mutex::new(None)),
            node: Arc::new(Mutex::new(None)),
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

/// 供错误页「复制诊断信息」使用。
///
/// 刻意包含实际选中的 node 路径与版本、以及 dsh 最近的输出:
/// 这个架构下的故障几乎都出在「哪个 node」和「dsh 说了什么」上,
/// 让用户手填这两项既麻烦又不可靠。
#[tauri::command]
fn diagnostics(state: tauri::State<'_, AppState>) -> String {
    let boot = lock(&state.boot).clone();

    let node_info = match lock(&state.node).as_ref() {
        Some(runtime) => format!("{} ({})", runtime.version, runtime.path.display()),
        None => "<尚未选定>".to_string(),
    };

    let runtime_dir = dsh::runtime_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("<不可用: {e}>"));

    let installed = dsh::runtime_dir()
        .ok()
        .and_then(|dir| dsh::installed_version(&dir))
        .unwrap_or_else(|| "<未安装>".to_string());

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

    format!(
        "DSH Desktop Ultra {shell}\n\
         平台: {os} {arch}\n\
         Node: {node_info}\n\
         dsh 锁定版本: {pinned}\n\
         dsh 已安装版本: {installed}\n\
         运行时目录: {runtime_dir}\n\
         启动状态: {boot:?}\n\
         \n--- dsh 输出 ---\n{dsh_output}\n",
        shell = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        pinned = upstream::DSH_VERSION,
    )
}

/// 更新状态并通知前端。
fn transition(app: &tauri::AppHandle, next: BootState) {
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

    // 版本已匹配时 ensure_installed 是个空操作，但状态先切过去：
    // 首次安装要拉网络，几十秒的静默会让人以为卡死了。
    let dsh_runtime = match dsh::runtime_dir() {
        Ok(dir) if !dsh::needs_install(&dir) => Ok(dir),
        _ => {
            transition(
                &app,
                BootState::InstallingDsh {
                    version: upstream::DSH_VERSION.to_string(),
                },
            );
            dsh::ensure_installed(&runtime)
        }
    };

    let dsh_runtime = match dsh_runtime {
        Ok(dir) => dir,
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            boot_state,
            diagnostics,
            retry_boot,
            check_for_updates,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            // 应用退出时必须收掉 dsh 子进程，否则会留下占着端口的孤儿 node
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

/// 检查 shell 自身的更新（与上游 dsh 版本无关）。
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_updater::UpdaterExt;

        let updater = app
            .updater()
            .map_err(|error| format!("初始化更新器失败: {error}"))?;

        match updater
            .check()
            .await
            .map_err(|error| format!("检查更新失败: {error}"))?
        {
            Some(update) => Ok(format!("发现新版本 {}", update.version)),
            None => Ok("已是最新版本".to_string()),
        }
    }
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok("开发模式不检查更新".to_string())
    }
}
