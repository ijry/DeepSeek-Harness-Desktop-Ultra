#!/usr/bin/env node
/**
 * 从 CI 下载的构建产物生成 Tauri 更新清单 latest.json。
 *
 * 更新的是「外壳」自身，与上游 dsh 版本无关：
 * dsh 由 src-tauri/src/upstream.rs 里的 DSH_VERSION 锁定，随外壳一起发布。
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

/** 各平台的更新包后缀。Tauri 更新器只认这些格式。 */
const UPDATE_ARTIFACT_SUFFIXES = [
  ".nsis.zip", // Windows
  ".app.tar.gz", // macOS
  ".AppImage.tar.gz", // Linux
];

/**
 * 从产物目录名推断更新器平台标识。
 * CI 的 upload-artifact 用的就是 `windows-x86_64` 这类名字。
 */
export function normalizePlatform(dirName) {
  const valid = new Set([
    "windows-x86_64",
    "windows-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
    "linux-aarch64",
  ]);
  return valid.has(dirName) ? dirName : null;
}

/** 在文件列表里找出更新包（不是安装包）。 */
export function findUpdateArtifact(files) {
  return (
    files.find((file) =>
      UPDATE_ARTIFACT_SUFFIXES.some((suffix) => file.endsWith(suffix))
    ) ?? null
  );
}

/**
 * 找出某个更新包对应的 .sig 签名文件。
 * Tauri 生成的签名名为 `<artifact>.sig`。
 */
export function findSignature(files, artifact) {
  const exact = `${artifact}.sig`;
  if (files.includes(exact)) return exact;
  // 少数打包器会把 .sig 直接替换掉原后缀
  return files.find((file) => file.endsWith(".sig")) ?? null;
}

export function buildManifest({ tag, pubDate, notes, platforms }) {
  if (Object.keys(platforms).length === 0) {
    throw new Error("没有任何平台的更新包，拒绝生成空清单。");
  }
  return {
    version: tag.startsWith("v") ? tag.slice(1) : tag,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      "assets-dir": { type: "string" },
      tag: { type: "string" },
      repo: { type: "string" },
      output: { type: "string" },
      "notes-file": { type: "string" },
    },
  });

  for (const required of ["assets-dir", "tag", "repo", "output"]) {
    if (!values[required]) {
      throw new Error(`缺少必需参数 --${required}`);
    }
  }

  const assetsDir = values["assets-dir"];
  const tag = values.tag;
  const notes = values["notes-file"]
    ? fs.readFileSync(values["notes-file"], "utf8").trim()
    : `${tag} 发布`;

  const platforms = {};

  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const platform = normalizePlatform(entry.name);
    if (!platform) {
      console.warn(`跳过无法识别的产物目录: ${entry.name}`);
      continue;
    }

    const dir = path.join(assetsDir, entry.name);
    const files = fs.readdirSync(dir);

    const artifact = findUpdateArtifact(files);
    if (!artifact) {
      console.warn(`${platform}: 未找到更新包，跳过`);
      continue;
    }

    const signatureFile = findSignature(files, artifact);
    if (!signatureFile) {
      // 没签名的条目会让客户端直接拒绝更新，宁可让 CI 失败
      throw new Error(`${platform}: 找到更新包 ${artifact} 但没有 .sig 签名`);
    }

    platforms[platform] = {
      signature: fs.readFileSync(path.join(dir, signatureFile), "utf8").trim(),
      url: `https://github.com/${values.repo}/releases/download/${tag}/${artifact}`,
    };
    console.log(`✓ ${platform}: ${artifact}`);
  }

  const manifest = buildManifest({
    tag,
    pubDate: new Date().toISOString(),
    notes,
    platforms,
  });

  fs.writeFileSync(values.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `\n已写入 ${values.output}（${Object.keys(platforms).length} 个平台）`
  );
}

// 作为脚本执行时才跑 main，被测试 import 时不跑
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main();
}
