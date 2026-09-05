//! 定位并校验用户系统上的 Node 运行时。
//!
//! 我们不分发 Node（见 README 的架构决策），所以启动路径上第一件事就是
//! 找到一个够新的 node，并在找不到时给出可执行的指引，而不是一句
//! 「启动失败」。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::upstream::{NODE_MIN_MAJOR, NODE_MIN_MINOR_FOR_22};

/// 环境变量覆盖：用户可以显式指定 node 路径。
pub const NODE_PATH_ENV: &str = "DSH_DESKTOP_NODE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl std::fmt::Display for NodeVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub path: PathBuf,
    pub version: NodeVersion,
}

/// 找 Node 时的失败原因。
///
/// `Display` 手写而不是用 `#[error(...)]`：这些话会出现在启动页上，要跟着
/// `i18n::current()` 变。
#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    NotFound,

    TooOld {
        found: NodeVersion,
        path: PathBuf,
    },

    NotExecutable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    UnparsableVersion {
        raw: String,
    },
}

impl std::fmt::Display for NodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let zh = crate::i18n::is_zh();
        match self {
            Self::NotFound => f.write_str(if zh {
                "未找到 Node 运行时"
            } else {
                "Node runtime not found"
            }),
            Self::TooOld { found, path } => {
                // 带上路径：版本过低时启动就停了，`state.node` 还是空的，诊断信息里
                // 只会写「尚未选定」——「是哪个 node 太旧」只有这一句话能交代。
                let path = path.display();
                if zh {
                    write!(
                        f,
                        "Node {found} 版本过低（{path}），DeepSeek Harness 需要 Node ^22.19 或 >= 24"
                    )
                } else {
                    write!(
                        f,
                        "Node {found} at {path} is too old; DeepSeek Harness needs Node ^22.19 or >= 24"
                    )
                }
            }
            Self::NotExecutable { path, source } => {
                let path = path.display();
                if zh {
                    write!(f, "无法执行 {path}: {source}")
                } else {
                    write!(f, "Cannot run {path}: {source}")
                }
            }
            Self::UnparsableVersion { raw } => {
                if zh {
                    write!(f, "无法解析 `node --version` 的输出: {raw}")
                } else {
                    write!(f, "Cannot parse the output of `node --version`: {raw}")
                }
            }
        }
    }
}

/// 解析 `node --version` 的输出，例如 `v22.19.0\n`。
pub fn parse_node_version(raw: &str) -> Option<NodeVersion> {
    let trimmed = raw.trim();
    let stripped = trimmed.strip_prefix('v').unwrap_or(trimmed);

    // 丢掉预发布/构建元数据后缀，例如 22.19.0-nightly
    let core = stripped.split(['-', '+']).next().unwrap_or(stripped);

    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let patch = parts.next().unwrap_or("0").parse().unwrap_or(0);

    Some(NodeVersion {
        major,
        minor,
        patch,
    })
}

/// 上游要求：Node ^22.19 或 >= 24。
///
/// 注意 23 是奇数版本（非 LTS），上游的 `^22.19 || >=24` 语义把它排除了。
pub fn is_supported(version: &NodeVersion) -> bool {
    if version.major >= 24 {
        return true;
    }
    if version.major == NODE_MIN_MAJOR {
        return version.minor >= NODE_MIN_MINOR_FOR_22;
    }
    false
}

/// Windows 下隐藏子进程控制台窗口。
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// 探测某个 node 可执行文件的版本。
fn probe(path: &Path) -> Result<NodeVersion, NodeError> {
    let mut command = Command::new(path);
    command.arg("--version");
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|source| NodeError::NotExecutable {
            path: path.to_path_buf(),
            source,
        })?;

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    parse_node_version(&raw).ok_or(NodeError::UnparsableVersion { raw })
}

/// 常见的 Node 安装位置——PATH 里没有时兜底。
///
/// 图形化启动的应用（尤其 macOS 的 .app）继承到的 PATH 往往比终端里窄，
/// nvm/fnm/volta 管理的 node 经常不在其中。
fn candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        // nvm-windows 会设置这两个环境变量。NVM_SYMLINK 直接指向「当前版本」
        // 的目录,优先级最高——nvm4w 默认装在 C:\nvm4w\nodejs 这种自定义
        // 位置,不在下面任何一个固定路径里,只靠固定路径会找不到。
        for var in ["NVM_SYMLINK", "NVM_HOME"] {
            if let Ok(dir) = std::env::var(var) {
                candidates.push(PathBuf::from(&dir).join("node.exe"));
            }
        }
        for base in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(dir) = std::env::var(base) {
                candidates.push(PathBuf::from(&dir).join("nodejs").join("node.exe"));
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(&appdata).join("nvm").join("node.exe"));
        }
        // fnm / volta 的 Windows 默认位置
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(&local);
            candidates.push(
                local
                    .join("fnm")
                    .join("aliases")
                    .join("default")
                    .join("node.exe"),
            );
            candidates.push(local.join("Volta").join("bin").join("node.exe"));
        }
    }

    #[cfg(not(windows))]
    {
        for dir in [
            "/usr/local/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
            "/opt/local/bin",
        ] {
            candidates.push(PathBuf::from(dir).join("node"));
        }
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".volta/bin/node"));
            candidates.push(home.join(".local/bin/node"));
            // fnm / nvm 的当前版本符号链接
            candidates.push(home.join(".fnm/aliases/default/bin/node"));
            candidates.push(home.join(".nvm/alias/default/bin/node"));
        }
    }

    candidates
}

/// 按优先级定位一个受支持的 Node：显式覆盖 → PATH → 常见位置。
///
/// 找到了 node 但版本过低时返回 `TooOld`（而不是 `NotFound`），
/// 这样 UI 能告诉用户「你装的是 v20，需要升到 22.19+」——比「没找到」有用得多。
pub fn discover() -> Result<NodeRuntime, NodeError> {
    // 1. 显式覆盖：无论版本如何都尊重用户的选择，但仍然校验。
    if let Ok(explicit) = std::env::var(NODE_PATH_ENV) {
        if !explicit.trim().is_empty() {
            let path = PathBuf::from(explicit.trim());
            let version = probe(&path)?;
            return finish(path, version);
        }
    }

    let mut too_old: Option<(PathBuf, NodeVersion)> = None;

    // 2. PATH 上的 node
    let bare = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(version) = probe(Path::new(bare)) {
        let path = absolute_exe(Path::new(bare));
        if is_supported(&version) {
            return Ok(NodeRuntime { path, version });
        }
        too_old = Some((path, version));
    }

    // 3. 常见安装位置
    for candidate in candidate_paths() {
        if !candidate.exists() {
            continue;
        }
        if let Ok(version) = probe(&candidate) {
            if is_supported(&version) {
                return Ok(NodeRuntime {
                    path: candidate,
                    version,
                });
            }
            too_old.get_or_insert((candidate, version));
        }
    }

    match too_old {
        Some((path, found)) => Err(NodeError::TooOld { found, path }),
        None => Err(NodeError::NotFound),
    }
}

/// 从 PATH 上找到的 node 只有裸名，问它自己要一个绝对路径。
///
/// 为什么值得多起一次进程：
/// - 诊断信息里「Node: v22.22.2 (node.exe)」这种是没用的——这个架构下最常见的
///   故障就是「用户以为在用哪个 node」和「外壳真正拉起的是哪个」不一致，
///   而裸名恰好把唯一能分辨这件事的信息丢掉了。
/// - 裸名的 `parent()` 是空目录。据此去拼子进程的 PATH 会拼出以分隔符开头的
///   `;C:\...`，那个空项会让 Windows 的 cmd.exe 查不到任何命令（`dsh plugin`
///   正是经 cmd.exe 转发给 pnpm 的）。`dsh::merged_path` 已经挡住了这种情况，
///   这里是把根源也补掉。
///
/// 问不出来就退回裸名——那是今天的行为，不该因为一次探测失败连 node 都不认。
fn absolute_exe(path: &Path) -> PathBuf {
    let mut command = Command::new(path);
    command.args(["-p", "process.execPath"]);
    hide_console(&mut command);

    let resolved = command.output().ok().and_then(|output| {
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!raw.is_empty()).then(|| PathBuf::from(raw))
    });
    resolved.unwrap_or_else(|| path.to_path_buf())
}

fn finish(path: PathBuf, version: NodeVersion) -> Result<NodeRuntime, NodeError> {
    if is_supported(&version) {
        Ok(NodeRuntime { path, version })
    } else {
        Err(NodeError::TooOld {
            found: version,
            path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(major: u32, minor: u32, patch: u32) -> NodeVersion {
        NodeVersion {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn parses_standard_output() {
        assert_eq!(parse_node_version("v22.19.0\n"), Some(v(22, 19, 0)));
        assert_eq!(parse_node_version("v24.0.1"), Some(v(24, 0, 1)));
        assert_eq!(parse_node_version("  v20.11.1  \r\n"), Some(v(20, 11, 1)));
    }

    #[test]
    fn parses_without_v_prefix_and_partial_versions() {
        assert_eq!(parse_node_version("22.19.0"), Some(v(22, 19, 0)));
        assert_eq!(parse_node_version("v24"), Some(v(24, 0, 0)));
        assert_eq!(parse_node_version("v24.3"), Some(v(24, 3, 0)));
    }

    #[test]
    fn parses_prerelease_suffix() {
        assert_eq!(parse_node_version("v25.0.0-nightly"), Some(v(25, 0, 0)));
        assert_eq!(parse_node_version("v22.19.0+build7"), Some(v(22, 19, 0)));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("not a version"), None);
        assert_eq!(parse_node_version("vX.Y.Z"), None);
    }

    #[test]
    fn accepts_supported_versions() {
        assert!(is_supported(&v(22, 19, 0)));
        assert!(is_supported(&v(22, 20, 5)));
        assert!(is_supported(&v(24, 0, 0)));
        assert!(is_supported(&v(25, 1, 0)));
    }

    #[test]
    fn rejects_unsupported_versions() {
        assert!(!is_supported(&v(22, 18, 9)), "22.18 低于 ^22.19");
        assert!(!is_supported(&v(20, 11, 1)), "20 是旧 LTS");
        assert!(!is_supported(&v(18, 0, 0)));
        // 23 是非 LTS 奇数版本，上游的 ^22.19 || >=24 把它排除了
        assert!(!is_supported(&v(23, 5, 0)), "23 不在支持范围内");
    }
}
