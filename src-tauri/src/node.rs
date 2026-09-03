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

#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    #[error("未找到 Node 运行时")]
    NotFound,

    #[error("Node {found} 版本过低，DeepSeek Harness 需要 Node ^22.19 或 >= 24")]
    TooOld { found: NodeVersion, path: PathBuf },

    #[error("无法执行 {path}: {source}")]
    NotExecutable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("无法解析 `node --version` 的输出: {raw}")]
    UnparsableVersion { raw: String },
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
        if is_supported(&version) {
            return Ok(NodeRuntime {
                path: PathBuf::from(bare),
                version,
            });
        }
        too_old = Some((PathBuf::from(bare), version));
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
