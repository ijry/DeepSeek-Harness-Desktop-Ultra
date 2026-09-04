//! 外壳自身的更新（与上游 dsh 的版本无关——那条线走 `upstream::DSH_VERSION`）。
//!
//! 平台差异是这里最容易踩的坑，写在最前面：
//!
//! - **Windows**：`download_and_install` 在启动 NSIS 安装器后直接
//!   `std::process::exit(0)`，它**永远不会返回 `Ok`**。所以它后面的代码是死代码，
//!   而且我们注册在 `RunEvent` 上的清理钩子也不会跑——dsh 子进程必须在调用**之前**
//!   收掉，否则会留下 200MB 的孤儿 node 占着端口。安装器带 `/R`，装完会自己把应用拉起来。
//! - **macOS / Linux**：install 返回 `Ok` 且不结束进程，要我们自己 `restart()`。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{lock, AppState};

/// 设置窗口的 label。进度事件只发给它，不广播。
const SETTINGS_WINDOW: &str = "settings";

/// 待安装的更新。检查时存下来，安装时取用。
pub type Pending = Arc<Mutex<Option<Update>>>;

/// 发现的新版本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    current_version: String,
    /// 发布说明。上游那个字段叫 `body`。
    notes: Option<String>,
    date: Option<String>,
}

/// 下载进度。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    /// 来自 Content-Length，可能没有。
    total: Option<u64>,
}

/// 把上游的错误翻成一句用户能照着做的话。
///
/// 「已是最新」不在这里——那是 `Ok(None)`，不是错误。
fn explain(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::EmptyEndpoints => {
            "没有配置更新端点（tauri.conf.json 的 plugins.updater.endpoints）".into()
        }
        // 单端点的情况下，清单 404 或者清单里没有本平台的条目，都会落到这里
        Error::ReleaseNotFound => "更新清单取不到，或者里面没有本平台的条目".into(),
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            format!("更新包签名校验失败：{error}。多半是安装包的签名与内置公钥不成对")
        }
        Error::Reqwest(_) | Error::Network(_) => format!("网络请求失败：{error}"),
        other => other.to_string(),
    }
}

/// 检查更新。
///
/// debug 构建里也照常跑：上游唯一的 `debug_assertions` 分支只是放宽了「端点必须是 https」
/// 这一条，其余逻辑完全一致。所以这是验证端点、公钥、清单解析最便宜的方式。
/// 后台自动检查的间隔。
///
/// 30 分钟：足够及时，又不至于让一个常驻托盘的应用去反复打 GitHub。
const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// 第一次检查的延迟。启动那几秒在装 dsh、拉服务，别再挤一个网络请求进去。
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);

/// 真正的检查逻辑。命令和后台轮询共用。
async fn check(app: &AppHandle) -> Result<Option<Available>, String> {
    let found = app
        .updater()
        .map_err(explain)?
        .check()
        .await
        .map_err(explain)?;

    let state = app.state::<AppState>();
    let mut pending = lock(&state.pending);
    match found {
        Some(update) => {
            let available = Available {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|date| date.to_string()),
            };
            *pending = Some(update);
            Ok(Some(available))
        }
        None => {
            *pending = None;
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<Available>, String> {
    let found = check(&app).await?;
    announce(&app, found.as_ref());
    Ok(found)
}

/// 把「有没有新版本」这件事摆到用户能看见的地方。
///
/// 三件事：改托盘 tooltip（悬停可见）、改托盘菜单项文字（右键可见）、把设置窗口
/// 弹出来。设置窗口开着的话它还会收到事件、自己刷新。
///
/// 刻意不弹系统通知、也不自动下载——那两件事都该由用户决定。
fn announce(app: &AppHandle, found: Option<&Available>) {
    let _ = app.emit("update-available", found);

    let (tooltip, label) = match found {
        Some(available) => (
            format!("DSH Desktop Ultra（有新版本 {}）", available.version),
            format!("设置（有新版本 {}）", available.version),
        ),
        None => (
            "DSH Desktop Ultra（运行中）".to_string(),
            "设置".to_string(),
        ),
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
    let state = app.state::<AppState>();
    let item = lock(&state.settings_item);
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(&label);
    }
    drop(item);

    // 每个版本只弹一次窗：后台是 30 分钟一轮，同一个版本反复弹比不弹更糟。
    // 用户手动点「重新检查」时窗口本来就开着，这里只会把它带到前面来。
    let Some(available) = found else { return };
    let mut popped = lock(&state.popped_version);
    if popped.as_deref() == Some(available.version.as_str()) {
        return;
    }
    *popped = Some(available.version.clone());
    drop(popped);
    crate::open_settings(app);
}

/// 起一个后台线程按间隔检查更新。
///
/// 用线程 + `block_on` 而不是异步定时器：这里只需要「睡一会儿、查一次」，
/// 没必要为它引入一套定时器抽象。检查失败只记日志——网络不好是常态，
/// 不该因此弹任何东西。
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            match tauri::async_runtime::block_on(check(&app)) {
                Ok(found) => {
                    if let Some(available) = &found {
                        eprintln!("[update] 发现新版本 {}", available.version);
                    }
                    announce(&app, found.as_ref());
                }
                Err(message) => eprintln!("[update] 检查失败：{message}"),
            }
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// 下载并安装上一次检查发现的更新。
///
/// dev 下不做：在 Windows 上它会去升级你**已安装**的正式版，然后把开发进程一起杀掉。
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "开发模式不执行安装：它会升级已安装的正式版并结束当前进程。请用 release 构建验证。"
                .into(),
        );
    }

    // guard 必须绑到具名变量：写成块的尾表达式的话，临时的 MutexGuard 会活到
    // `state` 之后，借用检查器直接拒绝（E0597，和 stop_server 里那条注释同一个坑）。
    let update = {
        let state = app.state::<AppState>();
        let pending = lock(&state.pending);
        pending.clone()
    }
    .ok_or_else(|| "没有待安装的更新，先检查一次".to_string())?;

    // Windows 上 install 会直接 exit(0)，退出钩子不会跑——这是收掉 dsh 子进程的唯一机会。
    crate::stop_server(&app);

    let progress = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                // 第一个参数是**本次分片**的长度，累加要自己做；total 每片都重复给一次
                downloaded += chunk as u64;
                let _ = progress.emit_to(
                    SETTINGS_WINDOW,
                    "update-progress",
                    Progress { downloaded, total },
                );
            },
            // 这个回调在**校验签名之前**触发，所以它不代表「装好了」，不发事件
            || {},
        )
        .await
        .map_err(explain)?;

    // 只有 macOS / Linux 会走到这里（Windows 已经在上面退出了）。
    // 这个命令跑在 async runtime 上而不是主线程，所以 restart 会正常发出
    // ExitRequested / Exit，退出钩子还能再兜一次底。
    app.restart()
}
