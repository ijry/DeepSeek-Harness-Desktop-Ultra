import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LANGS, type Lang, strings, useLang } from "./i18n";

/** 都是手工镜像 Rust 侧的结构（仓库没有 codegen），字段名是 camelCase。 */
type AppInfo = {
  shell: string;
  platform: string;
  language: string;
  node: string;
  dshPinned: string;
  dshInstalled: string;
  runtimeDir: string;
};

type Available = {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
};

type Progress = { downloaded: number; total: number | null };

type PluginStatus = {
  id: string;
  title: string;
  summary: string;
  installed: boolean;
  pnpm: boolean;
  removeCommand: string;
};

type UpdateState =
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "available"; update: Available }
  | { phase: "installing"; progress: Progress | null }
  | { phase: "failed"; message: string };

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Settings() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ phase: "checking" });
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null);
  /** 正在处理的插件 id——装卸是逐个走 CLI 的，按钮也该逐个禁用。 */
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useLang();
  /** 切过语言：dsh 里的插件要重启服务才跟着变，提示一句。 */
  const [langSwitched, setLangSwitched] = useState(false);
  const [langError, setLangError] = useState<string | null>(null);
  const s = strings(lang);

  useEffect(() => {
    let active = true;

    // app_info / plugin_status 不在这里取：它们的文字跟语言有关，交给下面那个
    // 带 [lang] 依赖的 effect 一并处理（它在挂载时也会跑一次）。

    // 下载进度是 Rust 侧 emit_to 单发给这个窗口的
    const unlisten = listen<Progress>("update-progress", (event) => {
      if (!active) return;
      setUpdate((current) =>
        current.phase === "installing"
          ? { phase: "installing", progress: event.payload }
          : current
      );
    });

    // 后台 30 分钟一次的检查结果。正在下载时不要打断它
    const unlistenFound = listen<Available | null>("update-available", (event) => {
      if (!active) return;
      setUpdate((current) =>
        current.phase === "installing"
          ? current
          : event.payload
            ? { phase: "available", update: event.payload }
            : { phase: "latest" }
      );
    });

    return () => {
      active = false;
      unlisten.then((off) => off()).catch(() => {});
      unlistenFound.then((off) => off()).catch(() => {});
    };
  }, []);

  // 打开就自动查一次：一个 GET，省用户一次点击
  useEffect(() => {
    void check();
  }, []);

  // 插件的名字和说明、以及 appInfo 里那几个占位文字都是 Rust 按语言渲染的，
  // 切语言之后要重新取一次。
  useEffect(() => {
    let active = true;
    invoke<AppInfo>("app_info")
      .then((value) => active && setInfo(value))
      .catch(() => {});
    invoke<PluginStatus[]>("plugin_status")
      .then((value) => active && setPlugins(value))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [lang]);

  // 原生标题栏由 Rust 贴（托盘也要用同一份文字），这里只管 document.title
  useEffect(() => {
    document.title = s.titleSettings;
  }, [s]);

  const changeLanguage = async (next: Lang) => {
    if (next === lang) return;
    setLangError(null);
    try {
      await setLang(next);
      setLangSwitched(true);
    } catch (error) {
      // 语言本身已经切了（Rust 那边先改界面再落盘），这里只剩「记不住」这一种失败
      setLangError(String(error));
    }
  };

  const check = async () => {
    setUpdate({ phase: "checking" });
    try {
      const found = await invoke<Available | null>("update_check");
      setUpdate(found ? { phase: "available", update: found } : { phase: "latest" });
    } catch (error) {
      setUpdate({ phase: "failed", message: String(error) });
    }
  };

  const install = async () => {
    setUpdate({ phase: "installing", progress: null });
    try {
      // Windows 上这个 promise 不会 resolve：装之前进程就被更新器结束掉了
      await invoke("update_install");
    } catch (error) {
      setUpdate({ phase: "failed", message: String(error) });
    }
  };

  const changePlugin = async (id: string, installIt: boolean) => {
    setPluginBusy(id);
    setPluginError(null);
    try {
      const next = await invoke<PluginStatus[]>(
        installIt ? "plugin_install" : "plugin_remove",
        { id },
      );
      setPlugins(next);
      setNeedsRestart(true);
    } catch (error) {
      setPluginError(String(error));
    } finally {
      setPluginBusy(null);
    }
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(await invoke<string>("diagnostics"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="page">
      <section className="card" aria-label={s.sectionUpdate}>
        <div className="card__title">{s.sectionUpdate}</div>
        {update.phase === "checking" && <p className="card__note">{s.updateChecking}</p>}
        {update.phase === "latest" && (
          <p className="card__note">{s.updateLatest(info?.shell ?? "…")}</p>
        )}
        {update.phase === "failed" && (
          <p className="card__note card__note--bad">{update.message}</p>
        )}
        {update.phase === "available" && (
          <>
            <p className="card__note">
              {s.updateFound(update.update.version, update.update.currentVersion)}
            </p>
            {update.update.notes && <div className="notes">{update.update.notes}</div>}
            <p className="card__note">{s.updateInstallNote}</p>
          </>
        )}
        {update.phase === "installing" && (
          <>
            <p className="card__note">
              {update.progress
                ? s.updateDownloading(
                    megabytes(update.progress.downloaded),
                    update.progress.total === null
                      ? null
                      : megabytes(update.progress.total),
                  )
                : s.updateStartingDownload}
            </p>
            <div className="bar">
              <div
                className="bar__fill"
                style={{
                  width:
                    update.progress?.total && update.progress.total > 0
                      ? `${Math.min(100, (update.progress.downloaded / update.progress.total) * 100)}%`
                      : "10%",
                }}
              />
            </div>
          </>
        )}
        <div className="actions">
          {update.phase === "available" && (
            <button type="button" onClick={() => void install()}>
              {s.updateDownloadAndInstall}
            </button>
          )}
          <button
            type="button"
            className="button--secondary"
            onClick={() => void check()}
            disabled={update.phase === "checking" || update.phase === "installing"}
          >
            {s.updateRecheck}
          </button>
        </div>
        <p className="card__note">{s.updateAutoNote}</p>
      </section>

      <section className="card" aria-label={s.sectionLanguage}>
        <div className="card__title">{s.sectionLanguage}</div>
        <div className="actions">
          {LANGS.map((entry) => (
            <button
              key={entry.code}
              type="button"
              className={entry.code === lang ? undefined : "button--secondary"}
              aria-pressed={entry.code === lang}
              onClick={() => void changeLanguage(entry.code)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="card__note">{s.languageNote}</p>
        {langError && <p className="card__note card__note--bad">{langError}</p>}
        {langSwitched && <p className="card__note">{s.languageRestartHint}</p>}
        {langSwitched && (
          <div className="actions">
            <button
              type="button"
              className="button--secondary"
              onClick={() => void invoke("retry_boot")}
            >
              {s.restartDsh}
            </button>
          </div>
        )}
      </section>

      <section className="card" aria-label={s.sectionPlugins}>
        <div className="card__title">{s.sectionPlugins}</div>
        {plugins ? (
          <>
            {plugins.map((plugin) => (
              <div key={plugin.id}>
                <p className="card__note">
                  {s.pluginStatusLine(
                    plugin.title,
                    plugin.id,
                    plugin.installed ? s.pluginEnabled : s.pluginNotInstalled,
                  )}
                </p>
                <p className="card__note">{plugin.summary}</p>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void changePlugin(plugin.id, !plugin.installed)}
                    disabled={pluginBusy !== null || !plugin.pnpm}
                  >
                    {pluginBusy === plugin.id
                      ? s.pluginWorking
                      : plugin.installed
                        ? s.pluginRemove
                        : s.pluginInstall}
                  </button>
                </div>
                <p className="card__note">
                  {s.pluginRemoveHint}
                  <code>{plugin.removeCommand}</code>
                </p>
              </div>
            ))}
            {plugins.some((plugin) => !plugin.pnpm) && (
              <p className="card__note card__note--bad">{s.pluginNoPnpm}</p>
            )}
            {pluginError && (
              <p className="card__note card__note--bad">{pluginError}</p>
            )}
            {needsRestart && (
              <>
                <p className="card__note">{s.pluginNeedsRestart}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="button--secondary"
                    onClick={() => void invoke("retry_boot")}
                  >
                    {s.restartDsh}
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <p className="card__note">{s.pluginLoading}</p>
        )}
      </section>

      <section className="card" aria-label={s.sectionAbout}>
        <div className="card__title">{s.sectionAbout}</div>
        {info ? (
          <dl className="facts">
            <dt>{s.aboutShell}</dt>
            <dd>{info.shell}</dd>
            <dt>{s.aboutPlatform}</dt>
            <dd>{info.platform}</dd>
            <dt>{s.aboutNode}</dt>
            <dd>{info.node}</dd>
            <dt>{s.aboutDshPinned}</dt>
            <dd>{info.dshPinned}</dd>
            <dt>{s.aboutDshInstalled}</dt>
            <dd>{info.dshInstalled}</dd>
            <dt>{s.aboutRuntimeDir}</dt>
            <dd>{info.runtimeDir}</dd>
          </dl>
        ) : (
          <p className="card__note">{s.loading}</p>
        )}
        <div className="actions">
          <button
            type="button"
            className="button--secondary"
            onClick={() => void copyDiagnostics()}
          >
            {copied ? s.copied : s.copyDiagnostics}
          </button>
        </div>
      </section>
    </main>
  );
}
