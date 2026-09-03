#!/usr/bin/env node
/**
 * 生成 Tauri 更新签名密钥对。
 *
 * 私钥必须写到仓库之外，绝不进 Git。目录由环境变量 DSH_KEY_DIR 指定，
 * 不在这里硬编码——这是个公开仓库，把维护者机器上的私钥路径写进代码
 * 等于白送一条信息给攻击者。
 *
 * 用法:
 *   DSH_KEY_DIR=/path/to/secrets  node scripts/generate-keys.mjs
 *   $env:DSH_KEY_DIR="C:\path\to\secrets"; node scripts/generate-keys.mjs
 *
 * 公钥会同时写到该目录，并自动填进 src-tauri/tauri.conf.json。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

function fail(message) {
  console.error(`\n错误: ${message}`);
  process.exit(1);
}

const KEY_DIR = process.env.DSH_KEY_DIR?.trim();
if (!KEY_DIR) {
  fail(
    "未设置 DSH_KEY_DIR。\n" +
      "请指定一个仓库之外的目录来存放私钥，例如:\n" +
      "  bash:       DSH_KEY_DIR=~/secrets/dsh-desktop node scripts/generate-keys.mjs\n" +
      "  PowerShell: $env:DSH_KEY_DIR=\"C:\\secrets\\dsh-desktop\"; node scripts/generate-keys.mjs"
  );
}

// 私钥落在仓库里迟早会被提交上去，直接拒绝
const resolvedKeyDir = path.resolve(KEY_DIR);
if (
  resolvedKeyDir === path.resolve(REPO) ||
  resolvedKeyDir.startsWith(path.resolve(REPO) + path.sep)
) {
  fail(
    `DSH_KEY_DIR 指向仓库内部 (${resolvedKeyDir})。\n` +
      "私钥必须放在仓库之外，否则迟早会被提交。"
  );
}

const PRIVATE_KEY = path.join(resolvedKeyDir, "dsh-desktop-ultra.key");
const PUBLIC_KEY = path.join(resolvedKeyDir, "dsh-desktop-ultra.key.pub");
const TAURI_CONF = path.join(REPO, "src-tauri", "tauri.conf.json");

// 覆盖已有密钥会让所有已安装的客户端再也收不到更新——必须显式确认
if (fs.existsSync(PRIVATE_KEY) && !process.argv.includes("--force")) {
  fail(
    `私钥已存在: ${PRIVATE_KEY}\n` +
      "覆盖它会导致所有已发布版本的更新签名失效，已装的客户端将永久收不到更新。\n" +
      "确认要重新生成，请加 --force。"
  );
}

fs.mkdirSync(resolvedKeyDir, { recursive: true });

console.log("正在生成密钥对…");

// 直接用 node 跑 tauri CLI 的 JS 入口,不走 npx。
// Windows 上 npx 是 npx.cmd,而 Node 18.20.2+/20.12.2+ 修 CVE-2024-27980
// 之后不加 shell:true 就 spawn 不了 .cmd(报 EINVAL)。加 shell:true 又要
// 自己处理路径引号转义。绕开 .cmd 是最稳的做法。
const tauriCli = path.join(
  REPO,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js"
);
if (!fs.existsSync(tauriCli)) {
  fail(`未找到 Tauri CLI: ${tauriCli}\n先跑 npm install。`);
}

try {
  // -w 写文件，-f 允许覆盖（已由上面的 --force 检查把关）
  execFileSync(
    process.execPath,
    [
      tauriCli,
      "signer",
      "generate",
      "-w",
      PRIVATE_KEY,
      "-f",
      "--password",
      "",
    ],
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
