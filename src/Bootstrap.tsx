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
  | { stage: "installingDsh"; version: string }
  | { stage: "startingServer" }
  | { stage: "ready"; url: string }
  | { stage: "failed"; kind: FailureKind; message: string; log: string };

const PROGRESS_LABELS: Record<string, string> = {
  locatingNode: "正在查找 Node 运行时…",
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

    const unlisten = listen<BootState>("boot-state", (event) => {
      if (active) setState(event.payload);
    });

    return () => {
      active = false;
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

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
      : PROGRESS_LABELS[state.stage] ?? "正在启动…";

  return (
    <main className="shell" aria-live="polite" aria-busy="true">
      <div className="mark" aria-hidden="true">
        DSH
      </div>
      <h1>DSH Desktop Ultra</h1>
      <div className="spinner" role="progressbar" aria-label={label} />
      <p className="hint">{label}</p>
      {state.stage === "installingDsh" && (
        <p className="detail">只需一次，之后启动会直接进入。</p>
      )}
    </main>
  );
}
