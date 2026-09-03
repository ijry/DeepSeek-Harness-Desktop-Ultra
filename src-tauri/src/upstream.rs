//! 上游 DeepSeek Harness 的版本锁定。
//!
//! 这是「更新上游」的唯一入口：改这里的版本号，重新构建即可。
//!
//! 项目硬约束（见 README「项目边界」）：**完全尊重上游官方功能，
//! 不修改、不增删、不"改良" harness 的任何行为，只做桌面打包。**
//! 因此这里安装的是 npm 上未经修改的官方包，外壳不 fork、不打补丁、
//! 不代理请求。升级上游不需要对齐任何 diff —— 这正是这条约束换来的。

/// 锁定的 `@deepseek-ai/dsh` 版本。
///
/// 升级步骤：
/// 1. 改这个常量
/// 2. `cargo test -p dsh-desktop-ultra`（校验版本号格式）
/// 3. 构建并冒烟测试
///
/// 当前锁定的是最新的 rc 版本。如需切换到 0.1.2-alpha 分支,改成 `"0.1.2-rc.1"`。
pub const DSH_VERSION: &str = "0.1.1-rc.2";

/// 官方 npm 包名。
pub const DSH_PACKAGE: &str = "@deepseek-ai/dsh";

/// dsh 要求的最低 Node 主版本 / 次版本。
/// 上游声明：Node ^22.19 或 >= 24。
pub const NODE_MIN_MAJOR: u32 = 22;
pub const NODE_MIN_MINOR_FOR_22: u32 = 19;

/// 带版本的包规格，例如 `@deepseek-ai/dsh@0.1.0`。
pub fn package_spec() -> String {
    format!("{}@{}", DSH_PACKAGE, DSH_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_version_is_exact() {
        // 必须是精确版本，不能是 ^ ~ * latest 之类的范围。
        // 范围会让不同时间构建出的安装包跑不同的上游代码。
        assert!(
            DSH_VERSION
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c.is_ascii_alphanumeric()),
            "DSH_VERSION 必须是精确版本，不能包含范围符号: {DSH_VERSION}"
        );
        assert!(
            !DSH_VERSION.starts_with('^') && !DSH_VERSION.starts_with('~'),
            "DSH_VERSION 不能是版本范围"
        );
        assert_ne!(DSH_VERSION, "latest", "DSH_VERSION 不能是 latest");
        assert!(
            DSH_VERSION.split('.').count() >= 3,
            "DSH_VERSION 应为 semver"
        );
    }

    #[test]
    fn package_spec_is_wellformed() {
        assert_eq!(package_spec(), format!("@deepseek-ai/dsh@{DSH_VERSION}"));
    }
}
