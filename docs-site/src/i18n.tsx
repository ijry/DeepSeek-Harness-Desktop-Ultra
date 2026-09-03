import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const GITHUB_REPO = "https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra";
export const GITHUB_LATEST = `${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
export const UPSTREAM_REPO = "https://github.com/deepseek-ai/deepseek-harness";
export const UPSTREAM_ISSUES = `${UPSTREAM_REPO}/issues`;
export const PLUGINS_URL = "https://github.com/0xsline/awesome-deepseek-harness";
export const TAURI_URL = "https://tauri.app/";

export type Lang = "zh" | "en";
export type OsId = "windows" | "macos" | "linux";

export interface Copy {
  nav: {
    brand: string;
    download: string;
    features: string;
    flow: string;
    boundaries: string;
    faq: string;
    github: string;
    switchTo: string;
  };
  hero: {
    badge: string;
    pre: string;
    hot: string;
    sub: string;
    cta: string;
    repo: string;
    note: string;
    scroll: string;
  };
  download: {
    label: string;
    title: string;
    lead: string;
    autoNote: string;
    recommended: string;
    open: string;
    alt: string;
    updaterHint: string;
    items: Record<OsId, { file: string; desc: string }>;
  };
  features: {
    label: string;
    title: string;
    lead: string;
    items: { t: string; d: string }[];
  };
  flow: {
    label: string;
    title: string;
    lead: string;
    steps: { t: string; d: string }[];
    note: string;
  };
  boundaries: {
    label: string;
    title: string;
    lead: string;
    rules: { t: string; d: string }[];
    splitTitle: string;
    shellTitle: string;
    shellItems: string[];
    dshTitle: string;
    dshItems: string[];
    note: string;
    disclaimer: string;
    upstream: string;
  };
  limits: {
    label: string;
    title: string;
    lead: string;
    items: { t: string; d: string }[];
  };
  faq: {
    label: string;
    title: string;
    items: { q: string; a: string }[];
  };
  footer: {
    tagline: string;
    siteNav: string;
    project: string;
    oss: string;
    ossNote: string;
    upstream: string;
    plugins: string;
    tauri: string;
    rights: string;
    backTop: string;
  };
}

export const HERO_CONSOLE: string[] = [
  "dsh-launcher · node v22.19 detected",
  "dsh 0.1.x locked · install ok",
  "alloc port 51423 · bind 127.0.0.1",
  "dsh web --no-open --port 51423",
  "ready → opening workspace",
];

export const HERO_CHIPS: string[] = ["node v22 ✓", "dsh 0.1.x ✓", "127.0.0.1:port"];

const zh: Copy = {
  nav: {
    brand: "DSH Desktop Ultra",
    download: "下载",
    features: "特性",
    flow: "启动流程",
    boundaries: "项目边界",
    faq: "常见问题",
    github: "GitHub",
    switchTo: "English",
  },
  hero: {
    badge: "DeepSeek Harness 官方开源 × Tauri 2 桌面壳",
    pre: "把 DeepSeek Harness",
    hot: "装进原生桌面",
    sub: "不 fork、不改一行上游代码、不加任何功能的桌面外壳。原生窗口、托盘常驻、进程监护、自动更新——只做打包，绝不越界。",
    cta: "立即下载",
    repo: "查看 GitHub",
    note: "Windows · macOS · Linux",
    scroll: "向下滚动，了解为什么它可以「零维护地跟随上游」",
  },
  download: {
    label: "下载",
    title: "选择你的平台",
    lead: "安装包托管在 GitHub Releases，每个版本都附带签名更新清单。请自备 Node（^22.19 或 >=24），首次启动会自动安装 dsh。",
    autoNote: "已检测到你的系统是",
    recommended: "推荐",
    open: "打开下载页",
    alt: "安装包",
    updaterHint: "内置自动更新 · 下次启动即收到新版本",
    items: {
      windows: { file: "NSIS (.exe)", desc: "最省事的安装包，安装即用，自动更新开箱即用。" },
      macos: { file: "通用 (dmg)", desc: "macOS 安装包；首次打开请在访达右键 → 打开。" },
      linux: { file: "deb / AppImage", desc: "适配主流发行版，桌面集成与自动更新同样完整。" },
    },
  },
  features: {
    label: "特性",
    title: "外壳只做 dsh 做不到的事",
    lead: "进入 dsh 界面之前的一切由外壳负责：窗口、运行时、进程、更新；进入之后的世界完整属于 dsh。职责划分清晰到可以用一句话说清。",
    items: [
      {
        t: "原生桌面窗口",
        d: "基于 Tauri 2 的系统原生窗口与图标：缩放、任务栏、多任务切换，和任何桌面应用一样体面。",
      },
      {
        t: "托盘常驻，关窗不退出",
        d: "点关闭只是收进系统托盘，dsh 服务继续后台运行，再次打开秒回现场；右键托盘图标 → 退出 才是唯一真正退出。",
      },
      {
        t: "智能 Node 探测与校验",
        d: "启动时定位并校验本机 Node；缺失或过旧时给出带下载链接的指引页，而不是一句笼统的「启动失败」。",
      },
      {
        t: "锁定精确的 dsh 版本",
        d: "在私有目录安装并锁定 @deepseek-ai/dsh 的精确版本；跟随上游升级 = 改一个版本常量，坏版本可自动回滚。",
      },
      {
        t: "进程监护与收尾",
        d: "轮询直到 dsh 就绪，超时给出诊断页；退出时清理整棵进程树，绝不留下占着端口的孤儿进程。",
      },
      {
        t: "外壳自身自动更新",
        d: "内置 Tauri 更新器与签名清单，发版后用户下次启动即收到更新；更新通道与 dsh 版本完全解耦。",
      },
    ],
  },
  flow: {
    label: "启动流程",
    title: "从双击到进入 dsh，只需几秒",
    lead: "外壳把「找到运行时、装对版本、拉起服务」这些脏活全部自动化。首次安装 dsh 除外——那一次会久一点，见常见问题。",
    steps: [
      { t: "查找并校验 Node", d: "沿 PATH（含 nvm/fnm）定位 node，尊重 DSH_DESKTOP_NODE 环境变量指定，校验版本是否满足要求。" },
      { t: "校验并安装 dsh", d: "比对私有目录中已安装的 @deepseek-ai/dsh 与锁定版本，不一致则自动安装或回滚到锁定版。" },
      { t: "分配空闲端口", d: "探测可用端口并只绑定 127.0.0.1，服务不对外暴露。" },
      { t: "拉起 dsh web", d: "以 --no-open --port 启动上游 web 模式，绝不抢开系统浏览器。" },
      { t: "轮询直到就绪", d: "监听端口就绪（通常约 2 秒）；进程提前退出会立即给出带日志的诊断。" },
      { t: "跳转 dsh 界面", d: "webview 整体进入 dsh 自带 UI，此后的画面与交互完全属于 dsh。" },
    ],
    note: "任一步骤失败都会停在带完整日志的指引页，告诉你下一步该做什么——而不是一句笼统的报错。",
  },
  boundaries: {
    label: "项目边界",
    title: "一条不可协商的硬约束",
    lead: "完全尊重上游官方功能：不改、不增删、不「改良」DeepSeek Harness 的任何行为。这不是权衡取舍，而是这个项目全部价值所在——让「跟随上游更新」永远只等于改一个版本号。",
    rules: [
      { t: "不 fork、不改上游", d: "直接安装 npm 上未经修改的 @deepseek-ai/dsh，只锁定版本号。" },
      { t: "不代理、不拦截、不转换", d: "外壳不碰模型请求、不改提示词、不插手工具调用、不动会话数据。" },
      { t: "不做自己的 UI", d: "dsh 自带完整 Web UI，外壳原样加载，不注入 CSS、不替换组件、不加主题。" },
      { t: "不「顺手修」bug", d: "上游行为哪怕看起来有问题也不在此绕过——请提交到上游仓库。" },
      { t: "不加任何功能", d: "想要什么先问上游，或写成 harness 插件——那是它设计好的扩展方式。" },
    ],
    splitTitle: "职责划分",
    shellTitle: "外壳负责",
    shellItems: ["原生窗口与生命周期（含托盘）", "Node 查找与版本校验", "安装并锁定 dsh 版本", "进程监护与退出清理", "外壳自身的自动更新"],
    dshTitle: "交给 dsh · 壳零介入",
    dshItems: ["全部 UI 与主题外观", "模型、工具与 Agent 循环", "会话、配置与沙盒", "插件生态", "API Key 等敏感数据"],
    note: "分清问题归属：进入 dsh 界面之前（窗口、Node、安装、更新）属于本仓库；进入之后的一切属于上游。",
    disclaimer: "本项目是独立的第三方开源桌面打包，与 DeepSeek 无隶属关系。DeepSeek Harness 由 DeepSeek AI 开发，以 MIT 许可开源，其功能与版权归上游所有。",
    upstream: "访问上游 DeepSeek Harness",
  },
  limits: {
    label: "已知限制",
    title: "诚实说明每个取舍",
    lead: "每一处限制都对应一笔清晰的账：为什么这样设计、代价是什么、有没有办法绕开。透明比漂亮话值钱。",
    items: [
      {
        t: "首次启动可能需要较久",
        d: "dsh 是「一切皆插件」架构，一次要装 450+ 个包、约 200MB；npm 缓存未预热时实测最长约 55 分钟。界面会显示进度，超过 20 分钟判定卡死并中止。装完之后每次启动只需约 2 秒。",
      },
      {
        t: "需要自备 Node",
        d: "安装包只有几 MB，不分发运行时。要求 Node ^22.19 或 >=24；不满足时启动页会给出带下载链接的指引。",
      },
      {
        t: "关窗不等于退出",
        d: "点关闭后 dsh 仍在后台运行并占用内存。真正退出：右键托盘图标 → 退出。",
      },
      {
        t: "跳转后外壳失去 UI 控制权",
        d: "webview 交给 dsh 页面后，若 dsh 崩溃，外壳无法再显示错误页——从托盘退出再重开即可。",
      },
      {
        t: "会话格式与 dsh 版本绑定",
        d: "不同版本 dsh 写出的会话可能被拒载（SessionFormatUnsupportedError）——这是上游的保护机制，拒绝加载比错误解析安全。",
      },
    ],
  },
  faq: {
    label: "常见问题",
    title: "FAQ",
    items: [
      {
        q: "为什么第一次启动那么慢？",
        a: "dsh 采用插件化架构，首次启动需要安装 450+ 个包（约 200MB）。外壳在安装期间显示进度与耗时，超过 20 分钟会中止并给出诊断。装完后每次启动只需约 2 秒。",
      },
      {
        q: "一定要自己装 Node 吗？",
        a: "是的。外壳不捆绑运行时，要求 Node ^22.19 或 >=24。不满足时启动页会给出下载链接；若 PATH 看不到 nvm/fnm 安装的 Node，可用环境变量 DSH_DESKTOP_NODE 显式指定路径。",
      },
      {
        q: "点关闭按钮是退出吗？",
        a: "不是。关闭只是把窗口收进系统托盘，dsh 继续在后台运行，下次打开秒回。唯一真正的退出入口：右键托盘图标 → 退出。",
      },
      {
        q: "这是 DeepSeek 官方的应用吗？",
        a: "不是。这是独立的第三方开源打包项目，与 DeepSeek 无隶属关系。上游 DeepSeek Harness 由 DeepSeek AI 开源（MIT）。",
      },
      {
        q: "上游升级后我怎么跟进？",
        a: "跟着版本走即可：外壳锁定 dsh 精确版本，新版本发布后用户下次启动会自动重装对齐；想主动升级上游，只需改 src-tauri/src/upstream.rs 里的一个版本常量。",
      },
      {
        q: "遇到问题该找谁？",
        a: "进入 dsh 界面之前（窗口、Node、安装、更新）的问题属于本仓库；进入之后（模型、工具、会话、插件）的问题请提交到上游 DeepSeek Harness，提交错地方只会延误修复。",
      },
    ],
  },
  footer: {
    tagline: "把 DeepSeek Harness 装进原生桌面",
    siteNav: "站点导航",
    project: "项目",
    oss: "开源",
    ossNote: "外壳代码以 MIT 许可开源。上游 DeepSeek Harness 同为 MIT，版权归 DeepSeek AI；应用运行时从 npm 安装未经修改的 @deepseek-ai/dsh，不重新分发、不内置其代码。",
    upstream: "上游 DeepSeek Harness",
    plugins: "插件生态",
    tauri: "Tauri 2",
    rights: "非官方项目 · 与 DeepSeek 无隶属关系 · 商标归各自所有者",
    backTop: "回到顶部",
  },
};

const en: Copy = {
  nav: {
    brand: "DSH Desktop Ultra",
    download: "Download",
    features: "Features",
    flow: "Startup flow",
    boundaries: "Boundaries",
    faq: "FAQ",
    github: "GitHub",
    switchTo: "中文",
  },
  hero: {
    badge: "DeepSeek Harness, open source × Tauri 2 desktop shell",
    pre: "DeepSeek Harness,",
    hot: "now a native desktop app",
    sub: "No fork, no line of upstream code changed, no features added. Native window, tray resident, process supervision, auto-update — we only package, never cross the line.",
    cta: "Download now",
    repo: "View on GitHub",
    note: "Windows · macOS · Linux",
    scroll: "Scroll to see why following upstream stays a one-line change",
  },
  download: {
    label: "Download",
    title: "Pick your platform",
    lead: "Installers live on GitHub Releases, each signed with an update manifest. Bring your own Node (^22.19 or >=24); dsh is installed automatically on first launch.",
    autoNote: "Detected your system:",
    recommended: "Recommended",
    open: "Open download page",
    alt: "Installer",
    updaterHint: "Built-in auto-update · next launch picks up new versions",
    items: {
      windows: { file: "NSIS (.exe)", desc: "The no-fuss installer — run it and you are done." },
      macos: { file: "Universal (dmg)", desc: "macOS installer; right-click → Open on first launch." },
      linux: { file: "deb / AppImage", desc: "Covers mainstream distros with full desktop integration." },
    },
  },
  features: {
    label: "Features",
    title: "The shell only does what dsh can't",
    lead: "Everything before the dsh UI is the shell's job: window, runtime, process, updates. Everything after belongs entirely to dsh — a split you can explain in one sentence.",
    items: [
      {
        t: "Native desktop window",
        d: "Real native windows and icons via Tauri 2: resizing, taskbar, alt-tab — as polished as any desktop app.",
      },
      {
        t: "Tray resident, close ≠ quit",
        d: "Closing hides to the system tray while dsh keeps running; reopen and you are instantly back. Right-click tray → Quit is the only real exit.",
      },
      {
        t: "Smart Node detection",
        d: "Locates and validates your local Node at launch. Missing or too old? You get a guidance page with download links, not a bare “startup failed”.",
      },
      {
        t: "Pinned exact dsh version",
        d: "Installs and pins an exact @deepseek-ai/dsh version in a private prefix; following upstream is a one-constant change, and bad versions roll back automatically.",
      },
      {
        t: "Process supervision & cleanup",
        d: "Polls until dsh is ready and shows diagnostics on timeout; on exit it kills the whole process tree so no orphan node ever squats on a port.",
      },
      {
        t: "Auto-updates for the shell",
        d: "Ships a Tauri updater with a signed manifest — users get new versions on next launch, fully decoupled from the dsh version.",
      },
    ],
  },
  flow: {
    label: "Startup flow",
    title: "From double-click to dsh in seconds",
    lead: "The shell automates the grunt work: find a runtime, install the right version, bring up the service. First-time dsh install is the exception — see FAQ for why it takes longer.",
    steps: [
      { t: "Find & validate Node", d: "Locates node along PATH (including nvm/fnm), honors the DSH_DESKTOP_NODE override, and checks the version." },
      { t: "Verify & install dsh", d: "Compares the installed @deepseek-ai/dsh against the pinned version and installs or rolls back automatically." },
      { t: "Allocate a free port", d: "Finds an available port and binds to 127.0.0.1 only — the service is never exposed." },
      { t: "Launch dsh web", d: "Starts upstream web mode with --no-open --port; it never hijacks your system browser." },
      { t: "Poll until ready", d: "Watts for the port to answer (usually ~2s); an early exit reports diagnostics immediately." },
      { t: "Jump into the dsh UI", d: "The webview loads dsh's own UI; from here on, everything belongs to dsh." },
    ],
    note: "Any failed step lands on a guidance page with full logs — telling you what to do next, not a vague error.",
  },
  boundaries: {
    label: "Project boundaries",
    title: "One non-negotiable rule",
    lead: "Upstream behavior is fully respected: no modification, no additions, no “improvements” to DeepSeek Harness. This is not a trade-off — it is the entire point of the project, keeping “follow upstream” a one-line version bump forever.",
    rules: [
      { t: "No fork, no upstream edits", d: "Installs the unmodified @deepseek-ai/dsh from npm, version-pinned only." },
      { t: "No proxy, no interception, no rewriting", d: "The shell never touches model requests, prompts, tool calls, or session data." },
      { t: "No custom UI", d: "dsh ships its own full web UI; the shell loads it as-is — no injected CSS, no replaced components, no themes." },
      { t: "No “quick fix” for bugs", d: "Even if upstream looks wrong, it is not patched around here — file it upstream." },
      { t: "No added features", d: "Want something? Ask upstream first, or write a harness plugin — that is the designed extension path." },
    ],
    splitTitle: "Division of responsibility",
    shellTitle: "The shell owns",
    shellItems: ["Native window & lifecycle (incl. tray)", "Node discovery & version checks", "Installing & pinning the dsh version", "Process supervision & cleanup", "Its own auto-update"],
    dshTitle: "dsh owns · zero shell involvement",
    dshItems: ["All UI & theming", "Models, tools & the agent loop", "Sessions, config & sandbox", "Plugin ecosystem", "API keys & sensitive data"],
    note: "Assign issues correctly: anything before the dsh UI (window, Node, install, updates) belongs here; everything after belongs upstream.",
    disclaimer: "This is an independent third-party open-source desktop packaging project with no affiliation to DeepSeek. Upstream DeepSeek Harness is developed by DeepSeek AI and open-sourced under MIT; its functionality and copyright belong to the upstream project.",
    upstream: "Visit upstream DeepSeek Harness",
  },
  limits: {
    label: "Known limits",
    title: "Every trade-off, stated plainly",
    lead: "Each limit comes with a clear ledger: why it is designed this way, what it costs, and whether there is a workaround. Transparency beats marketing copy.",
    items: [
      {
        t: "First launch can take a while",
        d: "dsh is a everything-is-a-plugin architecture: one install brings 450+ packages (~200MB). With a cold npm cache it has taken up to ~55 minutes in testing. Progress is shown; stalled installs abort after 20 minutes. Every later launch takes ~2 seconds.",
      },
      {
        t: "Bring your own Node",
        d: "Installers are a few MB and ship no runtime. Node ^22.19 or >=24 is required; otherwise a guidance page with download links appears.",
      },
      {
        t: "Closing the window is not quitting",
        d: "After closing, dsh keeps running in the background and holding memory. Real exit: right-click tray → Quit.",
      },
      {
        t: "No shell UI once inside dsh",
        d: "After the webview hands over to dsh, a dsh crash can't show a shell error page — quit from the tray and relaunch.",
      },
      {
        t: "Session format is version-bound",
        d: "Sessions written by other dsh versions may be rejected (SessionFormatUnsupportedError) — an upstream safeguard; rejecting is safer than mis-parsing.",
      },
    ],
  },
  faq: {
    label: "FAQ",
    title: "Frequently asked",
    items: [
      {
        q: "Why is the first launch so slow?",
        a: "dsh uses a plugin-heavy architecture; the first run installs 450+ packages (~200MB). The shell shows progress and elapsed time, and aborts with diagnostics after 20 minutes. Every later launch takes ~2 seconds.",
      },
      {
        q: "Do I really need to install Node myself?",
        a: "Yes. The shell ships no runtime and requires Node ^22.19 or >=24. If PATH can't see an nvm/fnm Node, set DSH_DESKTOP_NODE to point at it explicitly.",
      },
      {
        q: "Does clicking the close button quit the app?",
        a: "No. Close hides to the system tray while dsh keeps running; reopening is instant. The only real exit is right-click tray → Quit.",
      },
      {
        q: "Is this an official DeepSeek app?",
        a: "No. It is an independent third-party packaging project with no affiliation to DeepSeek. Upstream DeepSeek Harness is open-sourced (MIT) by DeepSeek AI.",
      },
      {
        q: "How do I follow an upstream release?",
        a: "Just follow the versions: the shell pins dsh exactly and reinstalls to match on next launch. To bump upstream yourself, edit one version constant in src-tauri/src/upstream.rs.",
      },
      {
        q: "Where should I report problems?",
        a: "Before the dsh UI (window, Node, install, updates) — this repo. Inside it (models, tools, sessions, plugins) — upstream DeepSeek Harness. Wrong place only delays the fix.",
      },
    ],
  },
  footer: {
    tagline: "DeepSeek Harness, in a native desktop app",
    siteNav: "Site",
    project: "Project",
    oss: "Open source",
    ossNote: "Shell code is MIT-licensed. Upstream DeepSeek Harness is MIT too, © DeepSeek AI; the app installs the unmodified @deepseek-ai/dsh from npm at runtime and never redistributes its code.",
    upstream: "Upstream DeepSeek Harness",
    plugins: "Plugin ecosystem",
    tauri: "Tauri 2",
    rights: "Unofficial project · no affiliation with DeepSeek · trademarks belong to their owners",
    backTop: "Back to top",
  },
};

const COPY: Record<Lang, Copy> = { zh, en };
const STORAGE_KEY = "dsh-site-lang";

interface I18nValue {
  lang: Lang;
  t: Copy;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* storage may be unavailable */
  }
  return (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = (next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return <I18nContext.Provider value={{ lang, t: COPY[lang], setLang }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}