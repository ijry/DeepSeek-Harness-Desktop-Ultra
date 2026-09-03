//! 把锁定版本的 `@deepseek-ai/dsh` 安装到应用私有目录，并定位它的入口脚本。
//!
//! 为什么用私有 npm prefix 而不是 `npx`：
//! - `npx` 会解析到用户全局缓存里的任意版本，不同机器可能跑不同代码；
//! - 私有 prefix 让「我们测过的版本」和「用户跑的版本」严格一致；
//! - 升级上游只需要改 `upstream::DSH_VERSION`，下次启动自动重装。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use crate::node::NodeRuntime;
use crate::upstream::{package_spec, DSH_PACKAGE, DSH_VERSION};

#[derive(Debug, thiserror::Error)]
pub enum DshError {
    #[error("无法确定应用数据目录")]
    NoDataDir,

    #[error("创建运行时目录 {path} 失败: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("未找到 npm（应与 Node 一同安装）")]
    NpmNotFound,

    #[error("npm 安装 {spec} 失败（退出码 {code}）:\n{stderr}")]
    InstallFailed {
        spec: String,
        code: String,
        stderr: String,
    },

    #[error("执行 npm 失败: {0}")]
    NpmSpawn(#[source] std::io::Error),

    #[error("安装完成但未找到 {DSH_PACKAGE} 的 package.json: {path}")]
    ManifestMissing { path: PathBuf },

    #[error("解析 {path} 失败: {source}")]
    ManifestUnreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("解析 {path} 的 JSON 失败: {source}")]
    ManifestInvalid {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("{DSH_PACKAGE} 的 package.json 里没有可用的 bin 入口")]
    NoBinEntry,

    #[error("bin 入口指向的文件不存在: {path}")]
    BinMissing { path: PathBuf },
}

/// `@deepseek-ai/dsh` 的 package.json（只取我们关心的字段）。
#[derive(Debug, Deserialize)]
struct DshManifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    bin: Option<serde_json::Value>,
}

/// 从 package.json 的 `bin` 字段里挑出入口脚本的相对路径。
///
/// npm 允许两种写法：
///   "bin": "./bin/dsh.js"                  （字符串）
///   "bin": { "dsh": "./bin/dsh.js", ... }  （对象）
/// 对象形式优先选名为 `dsh` 的那一项，否则退化为第一项。
fn pick_bin_path(bin: &serde_json::Value) -> Option<String> {
    match bin {
        serde_json::Value::String(single) if !single.trim().is_empty() => {
            Some(single.trim().to_string())
        }
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(preferred)) = map.get("dsh") {
                if !preferred.trim().is_empty() {
                    return Some(preferred.trim().to_string());
                }
            }
            map.values().find_map(|value| match value {
                serde_json::Value::String(path) if !path.trim().is_empty() => {
                    Some(path.trim().to_string())
                }
                _ => None,
            })
        }
        _ => None,
    }
}

/// 应用私有的 dsh 运行时目录。
pub fn runtime_dir() -> Result<PathBuf, DshError> {
    let base = dirs::data_dir().ok_or(DshError::NoDataDir)?;
    Ok(base.join("dsh-desktop-ultra").join("runtime"))
}

fn package_dir(runtime: &Path) -> PathBuf {
    runtime.join("node_modules").join(DSH_PACKAGE)
}

fn manifest_path(runtime: &Path) -> PathBuf {
    package_dir(runtime).join("package.json")
}

fn read_manifest(runtime: &Path) -> Result<DshManifest, DshError> {
    let path = manifest_path(runtime);
    if !path.exists() {
        return Err(DshError::ManifestMissing { path });
    }
    let raw = std::fs::read_to_string(&path).map_err(|source| DshError::ManifestUnreadable {
        path: path.clone(),
        source,
    })?;
    serde_json::from_str(&raw).map_err(|source| DshError::ManifestInvalid { path, source })
}

/// 已安装的版本是否正好是我们锁定的版本。
///
/// 不匹配就重装——包括「已装的比锁定的新」这种情况：
/// 降级和升级同样重要，否则回滚一个坏版本就做不到了。
pub fn installed_version(runtime: &Path) -> Option<String> {
    read_manifest(runtime)
        .ok()
        .map(|manifest| manifest.version)
        .filter(|version| !version.is_empty())
}

pub fn needs_install(runtime: &Path) -> bool {
    installed_version(runtime).as_deref() != Some(DSH_VERSION)
}

/// 找到与该 node 配套的 npm。
fn npm_command(node: &NodeRuntime) -> Result<PathBuf, DshError> {
    let npm_name = if cfg!(windows) { "npm.cmd" } else { "npm" };

    // npm 通常和 node 在同一目录下
    if let Some(dir) = node.path.parent() {
        let sibling = dir.join(npm_name);
        if sibling.exists() {
            return Ok(sibling);
        }
    }

    // 否则指望它在 PATH 上
    Ok(PathBuf::from(npm_name))
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// 把锁定版本装进私有 prefix。幂等：版本已匹配时直接返回。
pub fn ensure_installed(node: &NodeRuntime) -> Result<PathBuf, DshError> {
    let runtime = runtime_dir()?;
    std::fs::create_dir_all(&runtime).map_err(|source| DshError::CreateDir {
        path: runtime.clone(),
        source,
    })?;

    if !needs_install(&runtime) {
        return Ok(runtime);
    }

    let npm = npm_command(node)?;
    let spec = package_spec();

    let mut command = Command::new(&npm);
    command
        .arg("install")
        .arg(&spec)
        .arg("--prefix")
        .arg(&runtime)
        // 私有 prefix 不是一个真正的项目，别让 npm 去写 lockfile / package.json
        .arg("--no-save")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--loglevel=error")
        // 确保 npm 用的是我们挑中的那个 node，而不是 PATH 上的另一个
        .env("npm_config_prefix", &runtime);
    if let Some(dir) = node.path.parent() {
        prepend_path(&mut command, dir);
    }
    hide_console(&mut command);

    let output = command.output().map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            DshError::NpmNotFound
        } else {
            DshError::NpmSpawn(source)
        }
    })?;

    if !output.status.success() {
        return Err(DshError::InstallFailed {
            spec,
            code: output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into()),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    // 安装声称成功，但要确认落到磁盘上的确实是锁定的版本
    let installed = installed_version(&runtime);
    if installed.as_deref() != Some(DSH_VERSION) {
        return Err(DshError::InstallFailed {
            spec: package_spec(),
            code: "0".into(),
            stderr: format!(
                "npm 报告成功，但安装到的版本是 {}，期望 {DSH_VERSION}",
                installed.unwrap_or_else(|| "<无>".into())
            ),
        });
    }

    Ok(runtime)
}

/// 把 node 所在目录插到子进程 PATH 最前面。
fn prepend_path(command: &mut Command, dir: &Path) {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let existing = std::env::var("PATH").unwrap_or_default();
    let merged = if existing.is_empty() {
        dir.to_string_lossy().to_string()
    } else {
        format!("{}{}{}", dir.to_string_lossy(), separator, existing)
    };
    command.env("PATH", merged);
}

/// dsh 的入口脚本绝对路径，供 `node <script> web` 调用。
///
/// 直接用 node 跑入口 .js，而不是调用 npm 生成的 shim：
/// Windows 上的 shim 是 .cmd，会多起一个 cmd.exe，让进程树的清理变得不可靠。
pub fn entry_script(runtime: &Path) -> Result<PathBuf, DshError> {
    let manifest = read_manifest(runtime)?;
    let relative = manifest
        .bin
        .as_ref()
        .and_then(pick_bin_path)
        .ok_or(DshError::NoBinEntry)?;

    let normalized = relative.trim_start_matches("./");
    let script = package_dir(runtime).join(normalized);

    if !script.exists() {
        return Err(DshError::BinMissing { path: script });
    }
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_string_bin() {
        let bin = json!("./bin/dsh.js");
        assert_eq!(pick_bin_path(&bin), Some("./bin/dsh.js".to_string()));
    }

    #[test]
    fn prefers_dsh_key_in_object_bin() {
        let bin = json!({ "other": "./bin/other.js", "dsh": "./bin/dsh.js" });
        assert_eq!(pick_bin_path(&bin), Some("./bin/dsh.js".to_string()));
    }

    #[test]
    fn falls_back_to_only_entry_when_no_dsh_key() {
        let bin = json!({ "harness": "./bin/harness.mjs" });
        assert_eq!(pick_bin_path(&bin), Some("./bin/harness.mjs".to_string()));
    }

    #[test]
    fn rejects_unusable_bin_shapes() {
        assert_eq!(pick_bin_path(&json!(null)), None);
        assert_eq!(pick_bin_path(&json!("")), None);
        assert_eq!(pick_bin_path(&json!("   ")), None);
        assert_eq!(pick_bin_path(&json!({})), None);
        assert_eq!(pick_bin_path(&json!({ "dsh": "" })), None);
        assert_eq!(pick_bin_path(&json!([1, 2])), None);
    }

    #[test]
    fn ignores_non_string_values_in_object_bin() {
        let bin = json!({ "bad": 42, "good": "./bin/good.js" });
        assert_eq!(pick_bin_path(&bin), Some("./bin/good.js".to_string()));
    }
}
