//! 外壳自己的中英双语支持。
//!
//! 只管外壳发出的文字：托盘、窗口标题、诊断信息、以及所有会走到界面上的错误。
//! dsh 自己的 UI 与插件不在这里——它们跑在 dsh 的页面里，见 server.rs 传下去的
//! `DSH_DESKTOP_LANG`。
//!
//! 为什么是「就地写两句」而不是一张 key 表：错误消息带参数（路径、退出码、日志），
//! 放到远处的表里就只能用字符串占位符替换，既丢掉 `format!` 的编译期检查，也让
//! 消息和它的 variant 分了家。`match lang` 就地写反而两种语言并排可读，漏一种
//! 语言编译不过。

use std::sync::atomic::{AtomicU8, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zh,
    En,
}

impl Default for Language {
    fn default() -> Self {
        Self::Zh
    }
}

impl Language {
    /// 解析语言代码。宽松匹配：`zh-CN`、`zh_CN.UTF-8`、`en-US` 都认。
    pub fn from_code(code: &str) -> Option<Self> {
        let normalized = code.trim().to_ascii_lowercase();
        let base = normalized
            .split(['-', '_', '.'])
            .next()
            .unwrap_or(&normalized);
        match base {
            "zh" => Some(Self::Zh),
            "en" => Some(Self::En),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }
}

/// 当前语言。用全局量而不是从 `AppState` 里取：错误在 dsh.rs / node.rs /
/// server.rs 里构造，那些地方拿不到 Tauri 的 State，而 `Display` 又不能加参数。
static CURRENT: AtomicU8 = AtomicU8::new(0);

const ZH: u8 = 0;
const EN: u8 = 1;

pub fn current() -> Language {
    match CURRENT.load(Ordering::Relaxed) {
        EN => Language::En,
        _ => Language::Zh,
    }
}

pub fn set_current(lang: Language) {
    CURRENT.store(
        match lang {
            Language::Zh => ZH,
            Language::En => EN,
        },
        Ordering::Relaxed,
    );
}

/// 按当前语言二选一。给不带参数的短语用。
pub fn pick(zh: &'static str, en: &'static str) -> &'static str {
    match current() {
        Language::Zh => zh,
        Language::En => en,
    }
}

/// 当前是否中文。带参数的消息用它分支，好把 `format!` 的参数写在原地。
pub fn is_zh() -> bool {
    matches!(current(), Language::Zh)
}

/// 首次启动没有偏好文件时，猜一次系统语言。
///
/// 只读环境变量，不引第三方依赖：Windows 上这些变量通常不存在，落回中文——
/// 这个项目的默认受众是中文用户，猜错的代价也只是设置里点一下。
pub fn detect_system() -> Language {
    for key in ["DSH_DESKTOP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(lang) = Language::from_code(&value) {
                return lang;
            }
        }
    }
    Language::Zh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_locale_spellings() {
        assert_eq!(Language::from_code("zh"), Some(Language::Zh));
        assert_eq!(Language::from_code("zh-CN"), Some(Language::Zh));
        assert_eq!(Language::from_code("zh_CN.UTF-8"), Some(Language::Zh));
        assert_eq!(Language::from_code("en"), Some(Language::En));
        assert_eq!(Language::from_code("en-US"), Some(Language::En));
        assert_eq!(Language::from_code("EN_us"), Some(Language::En));
        assert_eq!(Language::from_code("fr"), None);
        assert_eq!(Language::from_code(""), None);
    }

    #[test]
    fn code_round_trips() {
        for lang in [Language::Zh, Language::En] {
            assert_eq!(Language::from_code(lang.code()), Some(lang));
        }
    }

    #[test]
    fn pick_follows_current() {
        // 全局量，测试之间会互相看见：这个测试自己两种语言都设一遍再还原。
        let before = current();
        set_current(Language::Zh);
        assert_eq!(pick("中", "en"), "中");
        assert!(is_zh());
        set_current(Language::En);
        assert_eq!(pick("中", "en"), "en");
        assert!(!is_zh());
        set_current(before);
    }
}
