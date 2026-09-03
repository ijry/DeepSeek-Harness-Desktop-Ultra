#!/usr/bin/env node
/**
 * 生成 Tauri 更新签名密钥对。
 *
 * 私钥写到仓库外的 D:\Repos\xyito\config\dsh-desktop\，绝不进 Git。
 * 公钥同时写到该目录，并自动填进 src-tauri/tauri.conf.json。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const KEY_DIR = "D:\\Repos\\xyito\\config\\dsh-desktop";
const PRIVATE_KEY = path.join(KEY_DIR, "dsh-desktop-ultra.key");
const PUBLIC_KEY = path.join(KEY_DIR, "dsh-desktop-ultra.key.pub");
const TAURI_CONF = path.join(REPO, "src-tauri", "tauri.conf.json");

function fail(message) {
  console.error(`\n错误: ${message}`);
  process.exit(1);
}

// 覆盖已有密钥会让所有已安装的客户端再也收不到更新——必须显式确认
if (fs.existsSync(PRIVATE_KEY) && process.argv[2] !== "--force") {
  fail(
    `私钥已存在: ${PRIVATE_KEY}\n` +
      "覆盖它会导致所有已发布版本的更新签名失效，已装的客户端将永久收不到更新。\n" +
      "确认要重新生成，请加 --force。"
  );
}

fs.mkdirSync(KEY_DIR, { recursive: true });

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

console.log("正在生成密钥对…");
try {
  // -w 写文件，-f 允许覆盖（已由上面的 --force 检查把关）
  execFileSync(
    npx,
    ["tauri", "signer", "generate", "-w", PRIVATE_KEY, "-f", "--password", ""],
    { cwd: REPO, stdio: "inherit" }
  );
} catch (error) {
  fail(`tauri signer 执行失败: ${error.message}`);
}

if (!fs.existsSync(PRIVATE_KEY)) {
  fail(`tauri signer 没有生成私钥: ${PRIVATE_KEY}`);
}

// tauri signer 会顺带写出 <key>.pub
const generatedPub = `${PRIVATE_KEY}.pub`;
if (!fs.existsSync(generatedPub)) {
  fail(`未找到公钥文件: ${generatedPub}`);
}
if (generatedPub !== PUBLIC_KEY) {
  fs.copyFileSync(generatedPub, PUBLIC_KEY);
}

const pubkey = fs.readFileSync(PUBLIC_KEY, "utf8").trim();

const config = JSON.parse(fs.readFileSync(TAURI_CONF, "utf8"));
config.plugins ??= {};
config.plugins.updater ??= {};
config.plugins.updater.pubkey = pubkey;
fs.writeFileSync(TAURI_CONF, `${JSON.stringify(config, null, 2)}\n`);

console.log(`
✓ 私钥: ${PRIVATE_KEY}
✓ 公钥: ${PUBLIC_KEY}
✓ 公钥已写入 src-tauri/tauri.conf.json

接下来在 GitHub 仓库 Settings → Secrets and variables → Actions 添加：

  TAURI_SIGNING_PRIVATE_KEY           = ${PRIVATE_KEY} 的完整内容
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD  = 留空（本次未设密码）

私钥不要提交到 Git（.gitignore 已排除 *.key）。
丢失私钥意味着已发布版本再也无法推送更新。
`);
