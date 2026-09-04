import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";

type FailureKind =
  | "nodeMissing"
  | "nodeTooOld"
  | "installFailed"
  | "serverFailed";

type BootState =
  | { stage: "locatingNode" }
  | {
      stage: "installingDsh";
      version: string;
      fetched: number;
      elapsedSecs: number;
    }
  | { stage: "startingServer" }
  | { stage: "awaitingChoice" }
  | { stage: "configuringPlugin"; name: string }
  | { stage: "ready"; url: string }
  | { stage: "failed"; kind: FailureKind; message: string; log: string };

/** 首启时问一次的可选插件。没有要问的东西时后端返回 null。 */
type PluginPrompt = {
  id: string;
  title: string;
  summary: string;
  removeCommand: string;
  requiresClick: boolean;
  install: boolean;
};

/** 还能改主意的阶段。之后卡片就该收起来了。 */
const CHOICE_STAGES = ["locatingNode", "installingDsh", "awaitingChoice"];

const PROGRESS_LABELS: Record<string, string> = {
  locatingNode: "正在查找 Node 运行时…",
  awaitingChoice: "先确认一个可选插件",
  startingServer: "正在启动 DeepSeek Harness…",
  ready: "即将进入…",
};

/** 每种失败对应一段可执行的指引，而不是只把报错抛给用户。 */
const FAILURE_GUIDANCE: Record<
  FailureKind,
  { title: string; hint: string; action?: { label: string; url: string } }
> = {
  nodeMissing: {
    title: "未找到 Node 运行时",
    hint: "DSH Desktop Ultra 依赖你系统上的 Node 来运行 DeepSeek Harness。请安装 Node 22.19+ 或 24+ 后重试。若已安装但仍提示未找到，可用环境变量 DSH_DESKTOP_NODE 指定 node 可执行文件的完整路径。",
    action: { label: "下载 Node.js", url: "https://nodejs.org/en/download" },
  },
  nodeTooOld: {
    title: "Node 版本过低",
    hint: "DeepSeek Harness 需要 Node ^22.19 或 >= 24。请升级后重试；如果你用 nvm/fnm 管理多版本，记得把新版本设为默认。",
    action: { label: "下载 Node.js", url: "https://nodejs.org/en/download" },
  },
  installFailed: {
    title: "安装 DeepSeek Harness 失败",
    hint: "首次启动需要从 npm 下载 harness。请检查网络连接与 npm registry 配置（公司网络可能需要代理），然后重试。",
  },
  serverFailed: {
    title: "DeepSeek Harness 启动失败",
    hint: "harness 进程已安装但没能正常启动。下面的日志通常能说明原因。",
  },
};

export default function Bootstrap() {
  const [state, setState] = useState<BootState>({ stage: "locatingNode" });
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState<PluginPrompt | null>(null);
  const [install, setInstall] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let active = true;

    // 首帧主动拉一次：事件可能在前端挂载前就已经发出
    invoke<BootState>("boot_state")
      .then((initial) => {
        if (active) setState(initial);
      })
      .catch(() => {
        /* 拿不到就等事件 */
      });

    invoke<PluginPrompt | null>("plugin_prompt")
      .then((initial) => {
        if (active && initial) {
          setPrompt(initial);
          setInstall(initial.install);
        }
      })
      .catch(() => {
        /* 同上 */
      });

    const unlisten = listen<BootState>("boot-state", (event) => {
      if (active) setState(event.payload);
    });

    const unlistenPrompt = listen<PluginPrompt>("plugin-prompt", (event) => {
      if (!active) return;
      setPrompt(event.payload);
      setInstall(event.payload.install);
    });

    return () => {
      active = false;
      unlisten.then((off) => off()).catch(() => {});
      unlistenPrompt.then((off) => off()).catch(() => {});
    };
  }, []);

  // 事件有可能在监听器注册之前就发出了（启动线程和 webview 是并行的）。
  // 阶段每变一次就再兜一次底，直到确认有没有要问的东西——漏掉这一次的代价是
  // 卡片永远不出现，而 Rust 那边正等着一次点击。
  useEffect(() => {
    if (prompt !== null || !CHOICE_STAGES.includes(state.stage)) return;
    let active = true;
    invoke<PluginPrompt | null>("plugin_prompt")
      .then((current) => {
        if (active && current) {
          setPrompt(current);
          setInstall(current.install);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [state.stage, prompt]);

  /** 每次切换都推给 Rust：dsh 装完时以它为准，用户不必点任何按钮。 */
  const toggleInstall = (next: boolean) => {
    setInstall(next);
    invoke("set_plugin_choice", { install: next }).catch(() => {});
  };

  const confirmPlugins = () => {
    setConfirmed(true);
    invoke("confirm_plugins", { install }).catch(() => {});
  };

  const copyDiagnostics = async () => {
    try {
      const text = await invoke<string>("diagnostics");
      const extra =
        state.stage === "failed"
          ? `\n错误: ${state.message}\n\n日志:\n${state.log}`
          : "";
      await navigator.clipboard.writeText(text + extra);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (state.stage === "failed") {
    const guidance = FAILURE_GUIDANCE[state.kind];
    return (
      <main className="shell shell--error" role="alert">
        <h1>{guidance.title}</h1>
        <p className="hint">{guidance.hint}</p>
        <p className="detail">{state.message}</p>

        {state.log && (
          <details>
            <summary>查看日志</summary>
            <pre>{state.log}</pre>
          </details>
        )}

        <div className="actions">
          <button type="button" onClick={() => invoke("retry_boot")}>
            重试
          </button>
          {guidance.action && (
            <button
              type="button"
              className="button--secondary"
              onClick={() => {
                // webview 里 target="_blank" 不会拉起系统浏览器，必须走 shell 插件
                void openExternal(guidance.action!.url);
              }}
            >
              {guidance.action.label}
            </button>
          )}
          <button
            type="button"
            className="button--secondary"
            onClick={copyDiagnostics}
          >
            {copied ? "已复制" : "复制诊断信息"}
          </button>
        </div>
      </main>
    );
  }

  const label =
    state.stage === "installingDsh"
      ? `首次启动，正在安装 DeepSeek Harness ${state.version}…`
      : state.stage === "configuringPlugin"
        ? `正在启用${state.name}插件…`
        : (PROGRESS_LABELS[state.stage] ?? "正在启动…");

  // 等用户勾选时不该转圈，也不该报告「忙」——忙的是人，不是程序
  const waiting = state.stage === "awaitingChoice";

  return (
    <main className="shell" aria-live="polite" aria-busy={!waiting}>
      <div className="mark" aria-hidden="true">
        DSH
      </div>
      <h1>DSH Desktop Ultra</h1>
      {!waiting && (
        <div className="spinner" role="progressbar" aria-label={label} />
      )}
      <p className="hint">{label}</p>
      {state.stage === "installingDsh" && (
        <p className="detail">
          {/* harness 是「一切皆插件」架构,依赖树有 100+ 个包。npm 在解析
              阶段会长时间不输出,所以这里同时显示包数和已耗时——只显示
              包数的话,静默期看起来还是卡死的。 */}
          已获取 {state.fetched} 个包 · 已用 {formatElapsed(state.elapsedSecs)}
          <br />
          依赖较多，首次可能需要数分钟；之后启动会直接进入。
        </p>
      )}
      {prompt && CHOICE_STAGES.includes(state.stage) && (
        <section className="offer" aria-label="可选插件">
          <label className="offer__pick">
            <input
              type="checkbox"
              checked={install}
              onChange={(event) => toggleInstall(event.target.checked)}
            />
            <span>安装{prompt.title}插件（推荐）</span>
          </label>
          <p className="offer__note">{prompt.summary}</p>
          <p className="offer__note">
            {prompt.requiresClick
              ? "点「继续」后按当前选择处理。"
              : "安装完成后会按当前选择继续，不需要再点任何按钮。"}
            以后要移除，运行 <code>{prompt.removeCommand}</code>
            （需要命令行与 pnpm——这个 dsh 版本还没有插件卸载界面）。
          </p>
          {prompt.requiresClick && (
            <div className="actions">
              <button type="button" onClick={confirmPlugins} disabled={confirmed}>
                {confirmed ? "正在继续…" : "继续"}
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}
