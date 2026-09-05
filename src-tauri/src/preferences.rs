//! 外壳自己的偏好设置。目前只有语言。
//!
//! 和 `plugin-choice.json` 一样放在 `app_dir()` 下、而不是 `runtime/` 里：
//! 升级上游 dsh 会重装整个运行时目录，不该把用户选的语言一起洗掉。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::dsh::app_dir;
use crate::i18n::Language;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// 界面语言。缺省时由调用方决定要不要猜系统语言。
    #[serde(default)]
    pub language: Option<Language>,
}

fn path() -> Option<PathBuf> {
    app_dir().ok().map(|dir| dir.join("preferences.json"))
}

/// 读偏好。文件不存在、读不动、内容坏了都退化成「没有偏好」——
/// 语言读不出来不该阻止应用启动。
pub fn load() -> Preferences {
    let Some(path) = path() else {
        return Preferences::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Preferences::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// 落盘。失败要把原因交回去：这是用户主动点出来的动作，静默失败会让
/// 「下次启动又变回去了」变成一个查不出原因的 bug。
pub fn save(prefs: &Preferences) -> Result<(), String> {
    let path = path().ok_or_else(|| {
        crate::i18n::pick(
            "无法确定应用数据目录",
            "Cannot determine the application data directory",
        )
        .to_string()
    })?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            if crate::i18n::is_zh() {
                format!("创建 {} 失败: {error}", parent.display())
            } else {
                format!("Failed to create {}: {error}", parent.display())
            }
        })?;
    }

    let text = serde_json::to_string_pretty(prefs).map_err(|error| {
        if crate::i18n::is_zh() {
            format!("序列化偏好设置失败: {error}")
        } else {
            format!("Failed to serialize preferences: {error}")
        }
    })?;

    fs::write(&path, text).map_err(|error| {
        if crate::i18n::is_zh() {
            format!("写入 {} 失败: {error}", path.display())
        } else {
            format!("Failed to write {}: {error}", path.display())
        }
    })
}

/// 启动时决定用哪种语言：有存过的就用它，没有就猜一次系统语言。
pub fn initial_language() -> Language {
    load().language.unwrap_or_else(crate::i18n::detect_system)
}
