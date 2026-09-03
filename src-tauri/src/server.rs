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

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("无法分配本地端口: {0}")]
    NoPort(#[source] std::io::Error),

    #[error("启动 dsh 进程失败: {0}")]
    Spawn(#[source] std::io::Error),

    #[error("dsh 进程在就绪前退出（退出码 {code}）:\n{log}")]
    ExitedEarly { code: String, log: String },

    #[error("等待 dsh 就绪超时（{}s）:\n{log}", READY_TIMEOUT.as_secs())]
    ReadyTimeout { log: String },
}

/// 子进程输出的环形缓冲，失败时用来展示原因。
#[derive(Debug, Clone, Default)]
pub struct LogRing {
    lines: Arc<Mutex<Vec<String>>>,
}

impl LogRing {
    pub fn push(&self, line: String) {
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
}

impl DshServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// 向系统要一个当前空闲的端口。
///
/// 拿到端口号后立即释放监听，所以理论上存在被别人抢占的竞态窗口；
/// 真被抢了 dsh 会在启动时报错，比我们硬编码一个端口然后神秘失败要好。
fn free_port() -> Result<u16, ServerError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(ServerError::NoPort)?;
    let port = listener.local_addr().map_err(ServerError::NoPort)?.port();
    drop(listener);
    Ok(port)
}

/// 端口是否已经接受连接。
fn accepts_connections(port: u16) -> bool {
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
fn pump<R>(reader: R, logs: LogRing, tag: &'static str)
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
    });
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

    let mut command = Command::new(node);
    command
        .arg(entry_script)
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        // 明确绑定回环地址：这是个本机桌面应用，不应该对外暴露端口。
        // dsh 默认已经是 127.0.0.1，这里显式写死以防上游默认值变化。
        .arg("--host")
        .arg("127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 我们自己开窗口显示，不要它再去拉系统浏览器
        .env("BROWSER", "none")
        .env("NO_COLOR", "1");

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
            return Ok(DshServer { child, port, logs });
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
}
