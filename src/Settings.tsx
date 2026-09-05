import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 都是手工镜像 Rust 侧的结构（仓库没有 codegen），字段名是 camelCase。 */
type AppInfo = {
  shell: string;
  platform: string;
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

  useEffect(() => {
    let active = true;

    invoke<AppInfo>("app_info")
      .then((value) => active && setInfo(value))
      .catch(() => {});
    invoke<PluginStatus[]>("plugin_status")
      .then((value) => active && setPlugins(value))
      .catch(() => {});

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
      <section className="card" aria-label="更新">
        <div className="card__title">更新</div>
        {update.phase === "checking" && <p className="card__note">正在检查…</p>}
        {update.phase === "latest" && (
          <p className="card__note">已是最新版本（{info?.shell ?? "…"}）。</p>
        )}
        {update.phase === "failed" && (
          <p className="card__note card__note--bad">{update.message}</p>
        )}
        {update.phase === "available" && (
          <>
            <p className="card__note">
              发现新版本 <strong>{update.update.version}</strong>，当前
              {update.update.currentVersion}。
            </p>
            {update.update.notes && <div className="notes">{update.update.notes}</div>}
            <p className="card__note">
              安装时应用会关闭；Windows 上安装器会自己把它重新打开，macOS / Linux
              由外壳自己重启。dsh 服务会先被收掉，不会留下后台进程。
            </p>
          </>
        )}
        {update.phase === "installing" && (
          <>
            <p className="card__note">
              {update.progress
                ? `正在下载 ${megabytes(update.progress.downloaded)}${
                    update.progress.total
                      ? ` / ${megabytes(update.progress.total)}`
                      : ""
                  }`
                : "正在开始下载…"}
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
              下载并安装
            </button>
          )}
          <button
            type="button"
            className="button--secondary"
            onClick={() => void check()}
            disabled={update.phase === "checking" || update.phase === "installing"}
          >
            重新检查
          </button>
        </div>
        <p className="card__note">
          外壳每 30 分钟自动检查一次；发现新版本会改托盘的提示与菜单文字，不会自动下载。
        </p>
      </section>

      <section className="card" aria-label="插件">
        <div className="card__title">插件</div>
        {plugins ? (
          <>
            {plugins.map((plugin) => (
              <div key={plugin.id}>
                <p className="card__note">
                  {plugin.title}（{plugin.id}）：
                  {plugin.installed ? "已启用" : "未安装"}
                </p>
                <p className="card__note">{plugin.summary}</p>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void changePlugin(plugin.id, !plugin.installed)}
                    disabled={pluginBusy !== null || !plugin.pnpm}
                  >
                    {pluginBusy === plugin.id
                      ? "处理中…"
                      : plugin.installed
                        ? "移除"
                        : "安装"}
                  </button>
                </div>
                <p className="card__note">
                  也可以在命令行里卸：<code>{plugin.removeCommand}</code>
                </p>
              </div>
            ))}
            {plugins.some((plugin) => !plugin.pnpm) && (
              <p className="card__note card__note--bad">
                没找到 pnpm，装卸都做不了——dsh 的 plugin 命令是转发给 pnpm 的。
              </p>
            )}
            {pluginError && (
              <p className="card__note card__note--bad">{pluginError}</p>
            )}
            {needsRestart && (
              <>
                <p className="card__note">
                  改动要重启 dsh 服务才生效（profile 的插件清单每次启动只读一次）。
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="button--secondary"
                    onClick={() => void invoke("retry_boot")}
                  >
                    重启 dsh 服务
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <p className="card__note">正在读取插件状态…</p>
        )}
      </section>

      <section className="card" aria-label="版本信息">
        <div className="card__title">版本信息</div>
        {info ? (
          <dl className="facts">
            <dt>外壳</dt>
            <dd>{info.shell}</dd>
            <dt>平台</dt>
            <dd>{info.platform}</dd>
            <dt>Node</dt>
            <dd>{info.node}</dd>
            <dt>dsh 锁定</dt>
            <dd>{info.dshPinned}</dd>
            <dt>dsh 已装</dt>
            <dd>{info.dshInstalled}</dd>
            <dt>运行时目录</dt>
            <dd>{info.runtimeDir}</dd>
          </dl>
        ) : (
          <p className="card__note">正在读取…</p>
        )}
        <div className="actions">
          <button
            type="button"
            className="button--secondary"
            onClick={() => void copyDiagnostics()}
          >
            {copied ? "已复制" : "复制诊断信息"}
          </button>
        </div>
      </section>
    </main>
  );
}
