import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManifest,
  findSignedArtifacts,
  normalizePlatform,
  pickArtifact,
} from "./create-updater-manifest.mjs";

test("识别受支持的平台目录名", () => {
  assert.equal(normalizePlatform("windows-x86_64"), "windows-x86_64");
  assert.equal(normalizePlatform("darwin-aarch64"), "darwin-aarch64");
  assert.equal(normalizePlatform("linux-x86_64"), "linux-x86_64");
});

test("拒绝无法识别的平台目录名", () => {
  assert.equal(normalizePlatform("win32"), null);
  assert.equal(normalizePlatform("release-notes.md"), null);
  assert.equal(normalizePlatform(""), null);
});

// 以下三组用的是 v0.1.0 真实发布出来的文件名。那次发布因为按后缀白名单
// (.nsis.zip / .AppImage.tar.gz) 匹配,Windows 和 Linux 全被漏掉。
test("Windows: 更新包是带 .sig 的 setup.exe,不是 .nsis.zip", () => {
  const files = [
    "DSH.Desktop.Ultra_0.1.0_x64-setup.exe",
    "DSH.Desktop.Ultra_0.1.0_x64-setup.exe.sig",
  ];
  assert.deepEqual(findSignedArtifacts(files), [
    "DSH.Desktop.Ultra_0.1.0_x64-setup.exe",
  ]);
});

test("Linux: 同时签了 AppImage 和 deb 时优先 AppImage", () => {
  const files = [
    "DSH.Desktop.Ultra_0.1.0_amd64.AppImage",
    "DSH.Desktop.Ultra_0.1.0_amd64.AppImage.sig",
    "DSH.Desktop.Ultra_0.1.0_amd64.deb",
    "DSH.Desktop.Ultra_0.1.0_amd64.deb.sig",
  ];
  assert.equal(
    pickArtifact(findSignedArtifacts(files)),
    "DSH.Desktop.Ultra_0.1.0_amd64.AppImage"
  );
});

test("macOS: 取 .app.tar.gz,忽略没签名的 dmg", () => {
  const files = [
    "DSH.Desktop.Ultra.app.tar.gz",
    "DSH.Desktop.Ultra.app.tar.gz.sig",
    "DSH.Desktop.Ultra_0.1.0_aarch64.dmg",
  ];
  assert.equal(
    pickArtifact(findSignedArtifacts(files)),
    "DSH.Desktop.Ultra.app.tar.gz"
  );
});

test("没有签名的文件一律不算更新包", () => {
  // dmg 和 deb 内部文件都没有 .sig
  const files = ["app.dmg", "control.tar.gz", "data.tar.gz", "latest.json"];
  assert.deepEqual(findSignedArtifacts(files), []);
  assert.equal(pickArtifact([]), null);
});

test("孤立的 .sig(缺对应产物)不算更新包", () => {
  assert.deepEqual(findSignedArtifacts(["ghost.exe.sig"]), []);
});

test("多个候选时结果稳定,不受输入顺序影响", () => {
  const a = pickArtifact(["b.deb", "a.AppImage"]);
  const b = pickArtifact(["a.AppImage", "b.deb"]);
  assert.equal(a, b);
  assert.equal(a, "a.AppImage");
});

test("生成的清单去掉 tag 的 v 前缀", () => {
  const manifest = buildManifest({
    tag: "v1.2.3",
    pubDate: "2026-09-03T00:00:00.000Z",
    notes: "测试",
    platforms: { "windows-x86_64": { signature: "sig", url: "https://x" } },
  });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.pub_date, "2026-09-03T00:00:00.000Z");
  assert.equal(manifest.notes, "测试");
});

test("平台列表为空时拒绝生成清单", () => {
  // 空清单会让所有客户端静默停止收到更新，必须让 CI 失败
  assert.throws(
    () =>
      buildManifest({
        tag: "v1.0.0",
        pubDate: "2026-09-03T00:00:00.000Z",
        notes: "n",
        platforms: {},
      }),
    /空清单/
  );
});
