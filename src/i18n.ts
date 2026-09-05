/**
 * 外壳前端的中英双语文案。
 *
 * 中文那份是类型源头（`type Dict = typeof zh`，不加 `as const` 让字面量退化成
 * `string`），英文那份按它的形状写：少一个键、多一个键、参数签名不对都编译不过。
 * 带参数的文案写成函数而不是占位符替换，省掉一层字符串拼接，也让参数名有类型。
 *
 * 语言的唯一真相在 Rust 侧（`preferences.json`）：托盘和错误消息都由它渲染，
 * 前端自己存一份就一定会和托盘不一致。所以这里首帧问一次 `get_language`，
 * 之后听 `language-changed`。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Lang = "zh" | "en";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
];

/**
 * `<html lang>` 的值。
 *
 * 不能直接用 `Lang`：那是我们自己的两个短代码，而这个属性要的是 BCP-47 标签，
 * 读屏软件按它挑发音。中文保持 `zh-CN`（和改动前的 HTML 一致）。
 */
const HTML_LANG: Record<Lang, string> = { zh: "zh-CN", en: "en" };

const zh = {
  // ---------------------------------------------------------------- 启动页
  bootStarting: "正在启动…",
  bootLocatingNode: "正在查找 Node 运行时…",
  bootAwaitingChoice: "先确认可选插件",
  bootStartingServer: "正在启动 DeepSeek Harness…",
  bootReady: "即将进入…",
  bootInstallingDsh: (version: string) =>
    `首次启动，正在安装 DeepSeek Harness ${version}…`,
  bootConfiguringPlugin: (name: string) => `正在启用${name}插件…`,
  bootFetched: (packages: number, elapsed: string) =>
    `已获取 ${packages} 个包 · 已用 ${elapsed}`,
  bootInstallNote: "依赖较多，首次可能需要数分钟；之后启动会直接进入。",

  // 已用时长
  elapsedSeconds: (seconds: number) => `${seconds} 秒`,
  elapsedMinutes: (minutes: number) => `${minutes} 分`,
  elapsedMinutesSeconds: (minutes: number, seconds: number) =>
    `${minutes} 分 ${seconds} 秒`,

  // ---------------------------------------------------------------- 失败页
  failNodeMissingTitle: "未找到 Node 运行时",
  failNodeMissingHint:
    "DSH Desktop Ultra 依赖你系统上的 Node 来运行 DeepSeek Harness。请安装 Node 22.19+ 或 24+ 后重试。若已安装但仍提示未找到，可用环境变量 DSH_DESKTOP_NODE 指定 node 可执行文件的完整路径。",
  failNodeTooOldTitle: "Node 版本过低",
  failNodeTooOldHint:
    "DeepSeek Harness 需要 Node ^22.19 或 >= 24。请升级后重试；如果你用 nvm/fnm 管理多版本，记得把新版本设为默认。",
  failInstallTitle: "安装 DeepSeek Harness 失败",
  failInstallHint:
    "首次启动需要从 npm 下载 harness。请检查网络连接与 npm registry 配置（公司网络可能需要代理），然后重试。",
  failServerTitle: "DeepSeek Harness 启动失败",
  failServerHint: "harness 进程已安装但没能正常启动。下面的日志通常能说明原因。",
  downloadNode: "下载 Node.js",
  viewLog: "查看日志",
  retry: "重试",
  copyDiagnostics: "复制诊断信息",
  copied: "已复制",
  diagnosticsError: (message: string) => `\n错误: ${message}`,
  diagnosticsLog: (log: string) => `\n\n日志:\n${log}`,

  // ------------------------------------------------------------ 插件卡片
  optionalPlugins: "可选插件",
  installPlugin: (title: string) => `安装${title}插件（推荐）`,
  promptRequiresClick: "点「继续」后按当前选择处理。",
  promptAutoContinue: "安装完成后会按当前选择继续，不需要再点任何按钮。",
  promptRemovalNote:
    "装上以后可以在托盘 → 设置 → 插件里随时移除，那里也列着每个插件对应的命令行写法。",
  continueButton: "继续",
  continuing: "正在继续…",

  // ---------------------------------------------------------------- 设置页
  sectionUpdate: "更新",
  sectionPlugins: "插件",
  sectionLanguage: "语言 / Language",
  sectionAbout: "版本信息",

  updateChecking: "正在检查…",
  updateLatest: (shell: string) => `已是最新版本（${shell}）。`,
  updateFound: (version: string, current: string) =>
    `发现新版本 ${version}，当前 ${current}。`,
  updateInstallNote:
    "安装时应用会关闭；Windows 上安装器会自己把它重新打开，macOS / Linux 由外壳自己重启。dsh 服务会先被收掉，不会留下后台进程。",
  updateStartingDownload: "正在开始下载…",
  updateDownloading: (downloaded: string, total: string | null) =>
    total ? `正在下载 ${downloaded} / ${total}` : `正在下载 ${downloaded}`,
  updateDownloadAndInstall: "下载并安装",
  updateRecheck: "重新检查",
  updateAutoNote:
    "外壳每 30 分钟自动检查一次；发现新版本会改托盘的提示与菜单文字，不会自动下载。",

  pluginLoading: "正在读取插件状态…",
  pluginEnabled: "已启用",
  pluginNotInstalled: "未安装",
  pluginStatusLine: (title: string, id: string, state: string) =>
    `${title}（${id}）：${state}`,
  pluginWorking: "处理中…",
  pluginRemove: "移除",
  pluginInstall: "安装",
  pluginRemoveHint: "也可以在命令行里卸：",
  pluginNoPnpm:
    "没找到 pnpm，装卸都做不了——dsh 的 plugin 命令是转发给 pnpm 的。",
  pluginNeedsRestart:
    "改动要重启 dsh 服务才生效（profile 的插件清单每次启动只读一次）。",
  restartDsh: "重启 dsh 服务",

  languageNote:
    "外壳的界面、托盘与报错立刻跟着变。dsh 自己的界面和插件是在启动时拿到语言的，要它们也跟着变，请重启 dsh 服务。",
  languageRestartHint: "语言已切换。要让 dsh 界面里的插件也跟着变，重启一次服务。",

  aboutShell: "外壳",
  aboutPlatform: "平台",
  aboutLanguage: "语言",
  aboutNode: "Node",
  aboutDshPinned: "dsh 锁定",
  aboutDshInstalled: "dsh 已装",
  aboutRuntimeDir: "运行时目录",
  loading: "正在读取…",

  /** 设置窗口的 document.title。原生标题栏由 Rust 贴，这个给读屏软件。 */
  titleSettings: "设置 · DSH Desktop Ultra",
};

/** 英文那份要按它的形状写；少一个键或参数不对都编译不过。 */
export type Dict = typeof zh;

const en: Dict = {
  bootStarting: "Starting…",
  bootLocatingNode: "Looking for a Node runtime…",
  bootAwaitingChoice: "Confirm the optional plugins first",
  bootStartingServer: "Starting DeepSeek Harness…",
  bootReady: "Almost there…",
  bootInstallingDsh: (version) =>
    `First launch — installing DeepSeek Harness ${version}…`,
  bootConfiguringPlugin: (name) => `Enabling the ${name} plugin…`,
  bootFetched: (packages, elapsed) =>
    `${packages} packages fetched · ${elapsed} elapsed`,
  bootInstallNote:
    "There are a lot of dependencies; the first run can take several minutes. Later launches go straight in.",

  elapsedSeconds: (seconds) => `${seconds}s`,
  elapsedMinutes: (minutes) => `${minutes}m`,
  elapsedMinutesSeconds: (minutes, seconds) => `${minutes}m ${seconds}s`,

  failNodeMissingTitle: "No Node runtime found",
  failNodeMissingHint:
    "DSH Desktop Ultra runs DeepSeek Harness on the Node installed on your system. Install Node 22.19+ or 24+ and try again. If Node is installed but still not found, point DSH_DESKTOP_NODE at the full path of the node executable.",
  failNodeTooOldTitle: "Node is too old",
  failNodeTooOldHint:
    "DeepSeek Harness needs Node ^22.19 or >= 24. Upgrade and try again; if you manage versions with nvm/fnm, remember to make the new one the default.",
  failInstallTitle: "Could not install DeepSeek Harness",
  failInstallHint:
    "The first launch downloads the harness from npm. Check your network and npm registry settings (a corporate network may need a proxy), then try again.",
  failServerTitle: "DeepSeek Harness failed to start",
  failServerHint:
    "The harness is installed but did not come up. The log below usually says why.",
  downloadNode: "Download Node.js",
  viewLog: "View log",
  retry: "Retry",
  copyDiagnostics: "Copy diagnostics",
  copied: "Copied",
  diagnosticsError: (message) => `\nError: ${message}`,
  diagnosticsLog: (log) => `\n\nLog:\n${log}`,

  optionalPlugins: "Optional plugins",
  installPlugin: (title) => `Install the ${title} plugin (recommended)`,
  promptRequiresClick: "Click Continue to proceed with the current selection.",
  promptAutoContinue:
    "Once the install finishes it continues with the current selection — no button needed.",
  promptRemovalNote:
    "You can remove any of them later from tray → Settings → Plugins, which also shows the command-line form for each.",
  continueButton: "Continue",
  continuing: "Continuing…",

  sectionUpdate: "Update",
  sectionPlugins: "Plugins",
  sectionLanguage: "语言 / Language",
  sectionAbout: "About",

  updateChecking: "Checking…",
  updateLatest: (shell) => `Up to date (${shell}).`,
  updateFound: (version, current) =>
    `Version ${version} is available; you are on ${current}.`,
  updateInstallNote:
    "The app closes while installing. On Windows the installer reopens it; on macOS and Linux the shell restarts itself. The dsh service is stopped first, so nothing is left running in the background.",
  updateStartingDownload: "Starting the download…",
  updateDownloading: (downloaded, total) =>
    total ? `Downloading ${downloaded} / ${total}` : `Downloading ${downloaded}`,
  updateDownloadAndInstall: "Download and install",
  updateRecheck: "Check again",
  updateAutoNote:
    "The shell checks every 30 minutes. A new version changes the tray tooltip and menu text; nothing is downloaded on its own.",

  pluginLoading: "Reading plugin status…",
  pluginEnabled: "enabled",
  pluginNotInstalled: "not installed",
  pluginStatusLine: (title, id, state) => `${title} (${id}): ${state}`,
  pluginWorking: "Working…",
  pluginRemove: "Remove",
  pluginInstall: "Install",
  pluginRemoveHint: "You can also remove it from the command line:",
  pluginNoPnpm:
    "pnpm was not found, so nothing can be installed or removed — dsh's plugin command forwards to pnpm.",
  pluginNeedsRestart:
    "Changes take effect after the dsh service restarts (the profile's plugin list is read once per launch).",
  restartDsh: "Restart the dsh service",

  languageNote:
    "The shell's UI, tray and error messages switch right away. dsh's own UI and the plugins are handed the language at startup, so restart the dsh service to switch those too.",
  languageRestartHint:
    "Language switched. Restart the service to switch the plugins inside dsh's UI as well.",

  aboutShell: "Shell",
  aboutPlatform: "Platform",
  aboutLanguage: "Language",
  aboutNode: "Node",
  aboutDshPinned: "dsh pinned",
  aboutDshInstalled: "dsh installed",
  aboutRuntimeDir: "Runtime directory",
  loading: "Loading…",

  titleSettings: "Settings · DSH Desktop Ultra",
};

const DICTS: Record<Lang, Dict> = { zh, en };

export function strings(lang: Lang): Dict {
  return DICTS[lang] ?? DICTS.zh;
}

function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

/**
 * 当前语言，以及切换它的函数。
 *
 * 首帧问一次 Rust（事件可能在挂载前就发过了），之后两个窗口都靠
 * `language-changed` 保持一致：设置页里切一次，启动页也跟着变。
 */
export function useLang(): [Lang, (next: Lang) => Promise<void>] {
  const [lang, setLang] = useState<Lang>("zh");

  // 读屏软件按 `<html lang>` 挑发音，所以它得跟着走。两个页面都用这个 hook，
  // 放这里就不用各自记着。
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);

  useEffect(() => {
    let active = true;

    invoke<string>("get_language")
      .then((code) => {
        if (active && isLang(code)) setLang(code);
      })
      .catch(() => {
        /* 拿不到就先用中文 */
      });

    const unlisten = listen<string>("language-changed", (event) => {
      if (active && isLang(event.payload)) setLang(event.payload);
    });

    return () => {
      active = false;
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  const change = async (next: Lang) => {
    // 先本地生效再落盘：Rust 会广播回来，重复设成同一个值是幂等的
    setLang(next);
    await invoke("set_language", { code: next });
  };

  return [lang, change];
}
