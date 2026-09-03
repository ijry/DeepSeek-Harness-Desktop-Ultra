#!/usr/bin/env node
/**
 * 从 CI 下载的构建产物生成 Tauri 更新清单 latest.json。
 *
 * 更新的是「外壳」自身，与上游 dsh 版本无关：
 * dsh 由 src-tauri/src/upstream.rs 里的 DSH_VERSION 锁定，随外壳一起发布。
 *
 * 关键设计：**不靠后缀白名单猜哪个产物是更新包，而是反查 .sig。**
 * Tauri 就是用 `<产物>.sig` 来标记更新包的。v0.1.0 那次发布踩过这个坑：
 * 白名单里写的是 .nsis.zip / .AppImage.tar.gz，而 Tauri v2 实际直接签
 * 安装包本体（.exe / .AppImage / .deb），结果 Windows 和 Linux 双双漏掉，
 * 清单里只剩 macOS —— 而且脚本还「告警跳过」静默通过了。
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

/** 产物目录名 → 更新器平台标识。CI 的 upload-artifact 用的就是这些名字。 */
const KNOWN_PLATFORMS = new Set([
  "windows-x86_64",
  "windows-aarch64",
  "darwin-x86_64",
  "darwin-aarch64",
  "linux-x86_64",
  "linux-aarch64",
]);

export function normalizePlatform(dirName) {
  return KNOWN_PLATFORMS.has(dirName) ? dirName : null;
}

/**
 * 一个平台可能有多个签名产物（Linux 同时签 .AppImage 和 .deb）。
 * Tauri 的 Linux 更新走 AppImage，所以优先它；其余按字典序取第一个，
 * 保证同样的输入总是产出同样的清单。
 */
const PREFERRED_ORDER = [".app.tar.gz", ".AppImage", ".exe", ".msi", ".deb"];

export function pickArtifact(candidates) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort();
  for (const suffix of PREFERRED_ORDER) {
    const hit = sorted.find((name) => name.endsWith(suffix));
    if (hit) return hit;
  }
  return sorted[0];
}

/**
 * 从文件列表里找出所有「有 .sig 陪伴」的产物。
 * 这就是 Tauri 认定的更新包集合。
 */
export function findSignedArtifacts(files) {
  const present = new Set(files);
  return files
    .filter((name) => name.endsWith(".sig"))
    .map((sig) => sig.slice(0, -".sig".length))
    .filter((artifact) => present.has(artifact));
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
    if (!values[required]) throw new Error(`缺少必需参数 --${required}`);
  }

  const assetsDir = values["assets-dir"];
  const tag = values.tag;
  const notes = values["notes-file"]
    ? fs.readFileSync(values["notes-file"], "utf8").trim()
    : `${tag} 发布`;

  const platforms = {};
  const missing = [];

  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const platform = normalizePlatform(entry.name);
    if (!platform) {
      console.warn(`跳过无法识别的产物目录: ${entry.name}`);
      continue;
    }

    const dir = path.join(assetsDir, entry.name);
    const files = fs.readdirSync(dir);
    const artifact = pickArtifact(findSignedArtifacts(files));

    if (!artifact) {
      // 构建成功却没有签名产物，说明签名或归集环节坏了。
      // 这里必须失败：静默跳过会让该平台的用户永远收不到更新，
      // 而且没有任何迹象——v0.1.0 就是这么发出去的。
      missing.push(`${platform}（目录内容: ${files.join(", ") || "空"}）`);
      continue;
    }

    // URL 用的必须是 GitHub 上的资源名。CI 的归集步骤已经把空格去掉，
    // 使本地文件名与资源名一致——否则 GitHub 会把空格换成点，URL 直接 404。
    if (/\s/.test(artifact)) {
      throw new Error(
        `产物名含空格，上传后 GitHub 会改名导致 URL 404: ${artifact}`
      );
    }

    platforms[platform] = {
      signature: fs
        .readFileSync(path.join(dir, `${artifact}.sig`), "utf8")
        .trim(),
      url: `https://github.com/${values.repo}/releases/download/${tag}/${artifact}`,
    };
    console.log(`✓ ${platform}: ${artifact}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `以下平台没有找到带 .sig 的更新包，拒绝发布残缺清单:\n  ${missing.join("\n  ")}`
    );
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

if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  main();
}
