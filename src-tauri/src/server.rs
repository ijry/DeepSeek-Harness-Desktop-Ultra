//! 管理 dsh web 服务子进程的生命周期。
//!
//! 职责：挑一个空闲端口、启动 `node <dsh> web --port <port>`、等它就绪、
//! 在应用退出时干净地杀掉整棵进程树。

use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 服务就绪的最长等待时间。首次启动 dsh 要初始化 profile 和插件，比稳态慢。
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// 就绪探测的轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// 保留的日志行数——够定位启动失败，又不会无界增长。
const LOG_RING_CAPACITY: usize = 400;

/// 服务日志的文件名（放在 `<应用数据目录>/logs/` 下）。
pub const LOG_FILE_NAME: &str = "dsh.log";

/// 日志文件超过这个大小就在下次启动时清空。
///
/// 只管住「量级」而不是精确切割：这个文件是给排障用的，留最近几轮启动的输出就够，
/// 真正的价值在于最后一次崩溃的现场不会因为磁盘写满而丢失。
pub const LOG_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 启动 dsh 服务时的失败原因。
///
/// `Display` 手写而不是用 `#[error(...)]`：这些话会出现在启动页上，要跟着
/// `i18n::current()` 变。
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    NoPort(#[source] std::io::Error),

    Spawn(#[source] std::io::Error),

    ExitedEarly { code: String, log: String },

    ReadyTimeout { log: String },
}

impl std::fmt::Display for ServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let zh = crate::i18n::is_zh();
        match self {
            Self::NoPort(source) => {
                if zh {
                    write!(f, "无法分配本地端口: {source}")
                } else {
                    write!(f, "Cannot allocate a local port: {source}")
                }
            }
            Self::Spawn(source) => {
                if zh {
                    write!(f, "启动 dsh 进程失败: {source}")
                } else {
                    write!(f, "Failed to start the dsh process: {source}")
                }
            }
            Self::ExitedEarly { code, log } => {
                if zh {
                    write!(f, "dsh 进程在就绪前退出（退出码 {code}）:\n{log}")
                } else {
                    write!(
                        f,
                        "The dsh process exited before it was ready (exit code {code}):\n{log}"
                    )
                }
            }
            Self::ReadyTimeout { log } => {
                let seconds = READY_TIMEOUT.as_secs();
                if zh {
                    write!(f, "等待 dsh 就绪超时（{seconds}s）:\n{log}")
                } else {
                    write!(
                        f,
                        "Timed out after {seconds}s waiting for dsh to become ready:\n{log}"
                    )
                }
            }
        }
    }
}

/// 落盘前的脱敏。
///
/// `dsh web:` 那一行带着本机 web 面板的入场券（凭它就能换到会话 cookie），而日志
/// 文件活得很久、也很容易被随手贴到 issue 里。内存里的环形缓冲保留原值——外壳
/// 要解析它才拿得到地址——只有写进文件的那一份把令牌抹掉。
fn redact(line: &str) -> String {
    const MARKER: &str = "token=";
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find(MARKER) {
        let (head, tail) = rest.split_at(at + MARKER.len());
        out.push_str(head);
        out.push_str("***");
        // 令牌到下一个分隔符为止（URL 后面可能跟着空格或 LAN 地址的括号）
        let end = tail
            .find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == '&')
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// 子进程输出的环形缓冲，失败时用来展示原因。
///
/// 除了留在内存里，每一行还可以同时落到磁盘（`mirror_to`）。dsh 是被外壳拉起来的
/// 长期进程，它退出时打的那几行是唯一能说明原因的现场；而内存里的环形缓冲只有在
/// 用户点开诊断信息时才读得到——服务已经没了、界面卡在「连不上后端」的时候，
/// 那条路已经走不通了。所以长期服务一律落盘。
#[derive(Debug, Clone, Default)]
pub struct LogRing {
    lines: Arc<Mutex<Vec<String>>>,
    /// 落盘目标。`None` 表示只留在内存里（插件安装那类短命子进程就够用）。
    mirror: Arc<Mutex<Option<std::fs::File>>>,
}

impl LogRing {
    pub fn push(&self, line: String) {
        // 先落盘：进程死掉时内存里的东西还在，但拿到它的机会未必还在
        if let Ok(mut guard) = self.mirror.lock() {
            if let Some(file) = guard.as_mut() {
                use std::io::Write;
                let _ = writeln!(file, "{}", redact(&line));
                // 崩溃现场最怕的就是留在缓冲区里，逐行 flush 换确定性
                let _ = file.flush();
            }
        }

        let mut lines = match self.lines.lock() {
            Ok(guard) => guard,
            // 某个写日志的线程 panic 了不该连带搞挂应用
            Err(poisoned) => poisoned.into_inner(),
        };
        if lines.len() >= LOG_RING_CAPACITY {
            lines.remove(0);
        }
        lines.push(line);
    }

    /// 让之后写入的每一行同时追加到 `path`（父目录会建好）。
    pub fn mirror_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let mut guard = match self.mirror.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = Some(file);
        Ok(())
    }

    pub fn snapshot(&self) -> String {
        let lines = match self.lines.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        lines.join("\n")
    }
}

/// 已就绪的 dsh 服务。
pub struct DshServer {
    child: Child,
    pub port: u16,
    pub logs: LogRing,
    /// dsh 自己打印的带认证令牌的地址。旧版本没有认证，这里是 None。
    auth_url: Option<String>,
}

impl DshServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// webview 应该访问的地址：优先用带令牌的认证地址，拿不到再退回裸地址。
    pub fn preferred_url(&self) -> String {
        self.auth_url.clone().unwrap_or_else(|| self.url())
    }

    /// 子进程是否已经退出；退出时给出退出码文案（取不到码就是被信号结束）。
    ///
    /// 守护线程用它把「端口不通」和「进程真的没了」区分开：前者可能只是一次抖动，
    /// 后者才是要重启的那种死。
    pub fn exited(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".into()),
            ),
            _ => None,
        }
    }
}

/// 从 dsh 的 stdout 里提取带认证令牌的 web 地址。
///
/// dsh 0.1.5 起给 web 面板加了启动令牌认证（BrowserAuth）：裸地址一律 401，
/// 只有上游自己打印的 `dsh web: <url>?token=...` 这一行能换到会话 cookie。
/// 这里解析那一行；解析不到（旧版本、未来上游改措辞）就回退裸地址，
/// 所以对上游文本的依赖是"尽力而为"而不是"必须成功"。
fn extract_auth_url(snapshot: &str) -> Option<String> {
    for line in snapshot.lines() {
        let rest = match line.strip_prefix("[out] dsh web: ") {
            Some(rest) => rest,
            None => continue,
        };
        if let Some(candidate) = rest.split_whitespace().next() {
            if candidate.starts_with("http://") || candidate.starts_with("https://") {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

/// 向系统要一个当前空闲的端口。
///
/// 拿到端口号后立即释放监听，所以理论上存在被别人抢占的竞态窗口；
/// 真被抢了 dsh 会在启动时报错，比我们硬编码一个端口然后神秘失败要好。
///
/// 上游其实支持 `--port 0`（让 OS 挑端口），能彻底消掉这个竞态窗口，
/// 但代价是必须从 dsh 的 stdout（`dsh web: http://127.0.0.1:<port>`）
/// 解析出实际端口。这里选择不那样做：竞态窗口只有几毫秒且失败是响亮的
/// （dsh 直接报错退出，走 ExitedEarly 分支显示日志），而依赖上游日志的
/// 文本格式是一种静默耦合——上游改一次措辞，我们就静默卡在等待就绪。
fn free_port() -> Result<u16, ServerError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(ServerError::NoPort)?;
    let port = listener.local_addr().map_err(ServerError::NoPort)?.port();
    drop(listener);
    Ok(port)
}

/// 端口是否已经接受连接。
pub(crate) fn accepts_connections(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // 自成进程组，退出时可以一次性 kill 掉 node 派生的所有子进程
    command.process_group(0);
}

/// 把子进程的一路输出泵进环形缓冲。
///
/// 返回读取线程的句柄：进程退出与「输出已经被读完」是两件事，需要拿失败原因的
/// 调用方必须 join 一下再取快照，否则子进程临死前打的那几行——恰恰是错误信息——
/// 大概率还堵在管道里。
pub(crate) fn pump<R>(reader: R, logs: LogRing, tag: &'static str) -> std::thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(text) => logs.push(format!("[{tag}] {text}")),
                Err(_) => break,
            }
        }
    })
}

/// 启动 dsh web 服务并等待它就绪。
///
/// `workspace` 为 None 时由 dsh 自己决定工作目录。
pub fn start(
    node: &Path,
    entry_script: &Path,
    workspace: Option<&Path>,
) -> Result<DshServer, ServerError> {
    let port = free_port()?;
    let logs = LogRing::default();

    // 长命服务一律落盘：服务死掉时的那几行是唯一的现场，而那时界面已经连不上后端了。
    // 拿不到数据目录不算致命错误——那只是没有落盘，服务该起还是要起。
    if let Ok(dir) = crate::dsh::app_dir() {
        let path = dir.join("logs").join(LOG_FILE_NAME);
        let oversized = std::fs::metadata(&path)
            .map(|meta| meta.len() > LOG_FILE_MAX_BYTES)
            .unwrap_or(false);
        if oversized {
            let _ = std::fs::remove_file(&path);
        }
        let _ = logs.mirror_to(&path);
    }
    logs.push(format!("--- dsh web 启动（端口 {port}）---"));

    let mut command = Command::new(node);
    command
        .arg(entry_script)
        // `web` 是上游认可的 `--profile web` 别名（见 dsh --help）
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        // 明确绑定回环地址：这是个本机桌面应用，不应该对外暴露端口。
        // dsh 默认已经是 127.0.0.1，这里显式写死以防上游默认值变化。
        .arg("--host")
        .arg("127.0.0.1")
        // 我们自己开窗口显示它，不要它再去拉系统浏览器。
        // 这是上游提供的正式开关——早先靠 BROWSER=none 那类约定是不可靠的，
        // dsh 并不读它，结果会是应用窗口和系统浏览器同时弹出来。
        .arg("--no-open")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        // 插件跑在 dsh 自己的页面里，拿不到外壳的 IPC，也不能靠外壳往那个页面
        // 注入任何东西（那会越过「不改 dsh 的 UI」这条边界）。所以语言走环境变量：
        // 插件的 host 半边读它，再由自己的接口发给浏览器半边。
        //
        // 只在启动时读一次，因此设置里切完语言要重启服务才生效——设置页那个
        // 「重启 dsh 服务」按钮就是这条路。
        .env("DSH_DESKTOP_LANG", crate::i18n::current().code());

    if let Some(dir) = workspace {
        command.current_dir(dir);
    }
    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(ServerError::Spawn)?;

    if let Some(stdout) = child.stdout.take() {
        pump(stdout, logs.clone(), "out");
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, logs.clone(), "err");
    }

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        // 先看进程是否已经死了——不然要白等满 90 秒
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(ServerError::ExitedEarly {
                    code: status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    log: logs.snapshot(),
                });
            }
            Ok(None) => {}
            Err(source) => return Err(ServerError::Spawn(source)),
        }

        if accepts_connections(port) {
            // 端口就绪后稍等片刻，让 stdout 泵把 `dsh web: <带令牌地址>` 那行
            // 送到环形缓冲（认证是 0.1.5 引入的；这行打印紧跟在监听之后）。
            // 等不到也不阻塞启动——旧版本本来就没有这行。
            let grace = Instant::now() + Duration::from_secs(5);
            let mut auth_url = None;
            while Instant::now() < grace {
                match child.try_wait() {
                    Ok(Some(_)) => break, // 进程死了，交给外层循环走 ExitedEarly
                    Ok(None) => {}
                    Err(_) => break,
                }
                if let Some(url) = extract_auth_url(&logs.snapshot()) {
                    auth_url = Some(url);
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            return Ok(DshServer {
                child,
                port,
                logs,
                auth_url,
            });
        }

        if Instant::now() >= deadline {
            let log = logs.snapshot();
            // 超时的进程留着只会占端口和内存
            let _ = terminate(&mut child);
            return Err(ServerError::ReadyTimeout { log });
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 杀掉子进程及其派生的整棵进程树。
///
/// 单纯 `Child::kill()` 只杀直接子进程，dsh 派生的 worker 会变成孤儿进程
/// 继续占着端口，下次启动就会撞车。
#[cfg(windows)]
pub(crate) fn terminate(child: &mut Child) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pid = child.id();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    // taskkill 失败时（进程已退出等）兜底
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn terminate(child: &mut Child) -> std::io::Result<()> {
    // 先对整个进程组发 SIGTERM，给 dsh 一个保存会话的机会
    let pgid = child.id() as i32;
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // 不肯走就强制
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

impl DshServer {
    /// 停止服务。应用退出时必须调用，否则会留下孤儿 node 进程。
    pub fn stop(&mut self) {
        let _ = terminate(&mut self.child);
    }
}

impl Drop for DshServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_returns_usable_port() {
        let port = free_port().expect("应该能分配到端口");
        assert!(port > 0);
        // 释放后应该能重新绑定
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("端口应可重新绑定");
    }

    #[test]
    fn free_port_varies() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        // 系统一般不会立刻复用同一个端口；即使复用了也只说明分配有效
        assert!(a > 0 && b > 0);
    }

    #[test]
    fn closed_port_is_not_ready() {
        let port = free_port().unwrap();
        assert!(!accepts_connections(port), "没人监听时不应判定为就绪");
    }

    #[test]
    fn listening_port_is_ready() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(accepts_connections(port), "有监听时应判定为就绪");
    }

    #[test]
    fn log_ring_is_bounded() {
        let logs = LogRing::default();
        for i in 0..(LOG_RING_CAPACITY + 50) {
            logs.push(format!("line {i}"));
        }
        let snapshot = logs.snapshot();
        let count = snapshot.lines().count();
        assert_eq!(count, LOG_RING_CAPACITY, "环形缓冲应有上界");
        assert!(
            snapshot.contains(&format!("line {}", LOG_RING_CAPACITY + 49)),
            "应保留最新的行"
        );
        assert!(!snapshot.contains("line 0\n"), "最旧的行应被丢弃");
    }

    #[test]
    fn log_ring_preserves_order() {
        let logs = LogRing::default();
        logs.push("first".into());
        logs.push("second".into());
        assert_eq!(logs.snapshot(), "first\nsecond");
    }

    #[test]
    fn redact_masks_the_token_only() {
        let line = "[out] dsh web: http://127.0.0.1:54647/?token=abc123 (LAN: http://192.168.1.2:54647/?token=def456)";
        let masked = redact(line);
        assert!(!masked.contains("abc123"), "局域网地址里的令牌也要抹掉");
        assert!(!masked.contains("def456"));
        assert!(masked.contains("http://127.0.0.1:54647/?token=***"));
        assert!(masked.contains("http://192.168.1.2:54647/?token=***"), "括号要留在原处");
        // 没令牌的行原样通过：日志的价值就在这些行上
        assert_eq!(redact("[err] boom"), "[err] boom");
    }

    #[test]
    fn log_ring_mirrors_every_line_to_disk() {
        let dir = std::env::temp_dir().join(format!("dsh-logring-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join(LOG_FILE_NAME);

        let logs = LogRing::default();
        logs.push("before mirroring".into());
        logs.mirror_to(&path).expect("应该能建好父目录并打开日志");
        logs.push("after one".into());
        logs.push("after two".into());

        // 只落盘镜像之后的行：镜像之前的那行没有文件可写，丢掉是对的
        let text = std::fs::read_to_string(&path).expect("日志应已写盘");
        assert_eq!(text, "after one\nafter two\n");
        // 内存里仍然保留全部，两边的用途不同
        assert_eq!(logs.snapshot(), "before mirroring\nafter one\nafter two");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auth_url_extracted_from_stdout_line() {
        let snapshot = "[out] some noise\n[out] dsh web: http://127.0.0.1:54647/?token=abc123 (LAN: http://192.168.1.2:54647/?token=abc123)\n[out] more";
        assert_eq!(
            extract_auth_url(snapshot).as_deref(),
            Some("http://127.0.0.1:54647/?token=abc123")
        );
    }

    #[test]
    fn auth_url_without_lan_suffix() {
        assert_eq!(
            extract_auth_url("[out] dsh web: http://127.0.0.1:8080/?token=t").as_deref(),
            Some("http://127.0.0.1:8080/?token=t")
        );
    }

    #[test]
    fn auth_url_absent_for_old_versions() {
        assert_eq!(extract_auth_url("[out] hello\n[err] boom"), None);
    }

    #[test]
    fn auth_url_ignores_malformed_line() {
        // 前缀对了但后面不是 URL，不能把乱七八糟的东西塞给 webview
        assert_eq!(extract_auth_url("[out] dsh web: not-a-url"), None);
    }
}
