import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManifest,
  findSignature,
  findUpdateArtifact,
  normalizePlatform,
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

test("在安装包中挑出更新包", () => {
  const files = [
    "DSH-Desktop-Ultra_0.1.0_x64-setup.exe",
    "DSH-Desktop-Ultra_0.1.0_x64-setup.nsis.zip",
    "DSH-Desktop-Ultra_0.1.0_x64-setup.nsis.zip.sig",
  ];
  assert.equal(
    findUpdateArtifact(files),
    "DSH-Desktop-Ultra_0.1.0_x64-setup.nsis.zip"
  );
});

test("只有安装包、没有更新包时返回 null", () => {
  // .exe / .dmg / .deb 是安装包，更新器不接受
  const files = ["app_0.1.0.exe", "app_0.1.0.dmg", "app_0.1.0.deb"];
  assert.equal(findUpdateArtifact(files), null);
});

test("按 <artifact>.sig 精确匹配签名", () => {
  const files = ["a.nsis.zip", "a.nsis.zip.sig", "b.nsis.zip.sig"];
  assert.equal(findSignature(files, "a.nsis.zip"), "a.nsis.zip.sig");
});

test("没有任何签名时返回 null", () => {
  assert.equal(findSignature(["a.nsis.zip"], "a.nsis.zip"), null);
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
