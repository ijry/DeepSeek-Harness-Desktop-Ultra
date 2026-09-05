import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { type Dict, type Lang, LANGS, strings, useLang } from "./i18n";

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
  plugins: PromptPlugin[];
  requiresClick: boolean;
};

type PromptPlugin = {
  id: string;
  title: string;
  summary: string;
  install: boolean;
};

/** 还能改主意的阶段。之后卡片就该收起来了。 */
const CHOICE_STAGES = ["locatingNode", "installingDsh", "awaitingChoice"];

/** 不带参数的那几个阶段各自一句话。带参数的两个在下面单独拼。 */
function progressLabel(stage: string, s: Dict): string {
  switch (stage) {
    case "locatingNode":
      return s.bootLocatingNode;
    case "awaitingChoice":
      return s.bootAwaitingChoice;
    case "startingServer":
      return s.bootStartingServer;
    case "ready":
      return s.bootReady;
    default:
      return s.bootStarting;
  }
}

/** 每种失败对应一段可执行的指引，而不是只把报错抛给用户。 */
function failureGuidance(
  kind: FailureKind,
  s: Dict,
): { title: string; hint: string; action?: { label: string; url: string } } {
  const nodeDownload = { label: s.downloadNode, url: "https://nodejs.org/en/download" };
  switch (kind) {
    case "nodeMissing":
      return {
        title: s.failNodeMissingTitle,
        hint: s.failNodeMissingHint,
        action: nodeDownload,
      };
    case "nodeTooOld":
      return {
        title: s.failNodeTooOldTitle,
        hint: s.failNodeTooOldHint,
        action: nodeDownload,
      };
    case "installFailed":
      return { title: s.failInstallTitle, hint: s.failInstallHint };
    case "serverFailed":
      return { title: s.failServerTitle, hint: s.failServerHint };
  }
}

export default function Bootstrap() {
  const [state, setState] = useState<BootState>({ stage: "locatingNode" });
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState<PluginPrompt | null>(null);
  /** 当前勾选的插件 id。默认由后端给（全勾）。 */
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [lang, setLang] = useLang();
  const s = strings(lang);

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
          setSelected(pickedOf(initial));
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
      setSelected(pickedOf(event.payload));
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
          setSelected(pickedOf(current));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [state.stage, prompt]);

  // 插件的名字和说明是 Rust 按语言渲染好发过来的，所以切语言之后要重新取一次，
  // 否则卡片上会留着上一种语言的文字。
  useEffect(() => {
    if (prompt === null) return;
    let active = true;
    invoke<PluginPrompt | null>("plugin_prompt")
      .then((current) => {
        if (active && current) setPrompt(current);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [lang]);

  /** 每次切换都推给 Rust：dsh 装完时以它为准，用户不必点任何按钮。 */
  const toggleInstall = (id: string, next: boolean) => {
    setSelected((current) =>
      next ? [...current.filter((it) => it !== id), id] : current.filter((it) => it !== id),
    );
    invoke("set_plugin_choice", { id, install: next }).catch(() => {});
  };

  const confirmPlugins = () => {
    setConfirmed(true);
    invoke("confirm_plugins", { ids: selected }).catch(() => {});
  };

  const copyDiagnostics = async () => {
    try {
      const text = await invoke<string>("diagnostics");
      const extra =
        state.stage === "failed"
          ? s.diagnosticsError(state.message) + s.diagnosticsLog(state.log)
          : "";
      await navigator.clipboard.writeText(text + extra);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (state.stage === "failed") {
    const guidance = failureGuidance(state.kind, s);
    return (
      <main className="shell shell--error" role="alert">
        <h1>{guidance.title}</h1>
        <p className="hint">{guidance.hint}</p>
        <p className="detail">{state.message}</p>

        {state.log && (
          <details>
            <summary>{s.viewLog}</summary>
            <pre>{state.log}</pre>
          </details>
        )}

        <div className="actions">
          <button type="button" onClick={() => invoke("retry_boot")}>
            {s.retry}
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
            {copied ? s.copied : s.copyDiagnostics}
          </button>
        </div>
        <LanguagePicker lang={lang} onPick={setLang} />
      </main>
    );
  }

  const label =
    state.stage === "installingDsh"
      ? s.bootInstallingDsh(state.version)
      : state.stage === "configuringPlugin"
        ? s.bootConfiguringPlugin(state.name)
        : progressLabel(state.stage, s);

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
          {s.bootFetched(state.fetched, formatElapsed(state.elapsedSecs, s))}
          <br />
          {s.bootInstallNote}
        </p>
      )}
      {prompt && CHOICE_STAGES.includes(state.stage) && (
        <section className="offer" aria-label={s.optionalPlugins}>
          {/* 九个插件装不进一屏，列表自己滚——下面的说明和「继续」按钮要一直露在外面 */}
          <div className="offer__list">
            {prompt.plugins.map((plugin) => (
              <div key={plugin.id} className="offer__item">
                <label className="offer__pick">
                  <input
                    type="checkbox"
                    checked={selected.includes(plugin.id)}
                    onChange={(event) => toggleInstall(plugin.id, event.target.checked)}
                  />
                  <span>{s.installPlugin(plugin.title)}</span>
                </label>
                <p className="offer__note">{plugin.summary}</p>
              </div>
            ))}
          </div>
          <p className="offer__note">
            {prompt.requiresClick ? s.promptRequiresClick : s.promptAutoContinue}{" "}
            {s.promptRemovalNote}
          </p>
          {prompt.requiresClick && (
            <div className="actions">
              <button type="button" onClick={confirmPlugins} disabled={confirmed}>
                {confirmed ? s.continuing : s.continueButton}
              </button>
            </div>
          )}
        </section>
      )}
      <LanguagePicker lang={lang} onPick={setLang} />
    </main>
  );
}

/**
 * 语言开关。
 *
 * 放在启动页上而不是只放设置页：首次启动要装 dsh，用户会在这一页上待好几分钟，
 * 而这也是「装不上」的指引唯一出现的地方——那段话看不懂的时候，托盘远了一点。
 */
function LanguagePicker({
  lang,
  onPick,
}: {
  lang: Lang;
  onPick: (next: Lang) => Promise<void>;
}) {
  return (
    <div className="langpick" role="group" aria-label="语言 / Language">
      {LANGS.map((entry) => (
        <button
          key={entry.code}
          type="button"
          className="langpick__option"
          aria-pressed={entry.code === lang}
          onClick={() => {
            // 切换失败只有「写不进偏好文件」一种，界面已经切好了，不值得在
            // 启动页上再占一行去说它
            onPick(entry.code).catch(() => {});
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** 后端给的默认勾选集合。 */
function pickedOf(prompt: PluginPrompt): string[] {
  return prompt.plugins.filter((plugin) => plugin.install).map((plugin) => plugin.id);
}

function formatElapsed(seconds: number, s: Dict): string {
  if (seconds < 60) return s.elapsedSeconds(seconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? s.elapsedMinutes(minutes)
    : s.elapsedMinutesSeconds(minutes, rest);
}
