#!/usr/bin/env node
// 把内置插件打成 npm tarball，供 Tauri 以资源形式带进安装包。
//
// 为什么是 tarball 而不是让 pnpm link: 到源目录：link: 是符号链接，用户卸载
// 桌面外壳之后 ~/.dsh/profiles/web/node_modules 里会留下一个悬空链接，而
// profile 的 dsh.profile.bundles 里还列着它——用户自己的 dsh web 会直接起不来，
// 且极难自行诊断。tarball 走 file:，pnpm 会解包到用户级 store 再硬链进 profile，
// 卸载外壳不影响用户已有的 dsh。
//
// 输出文件名固定（不带版本号），这样 tauri.conf.json 里的资源路径是稳定的。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 要内置的插件目录名。与 src-tauri/src/plugins.rs 里的 BUNDLED 一一对应。 */
const BUNDLED = ["dsh-plugin-taskboard", "dsh-plugin-canvas"];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "plugins", ".pack");

/** npm pack 产出的文件名：@scope/name → scope-name-version.tgz。 */
function packedName(manifest) {
  const base = manifest.name.replace(/^@/, "").replace(/\//g, "-");
  return `${base}-${manifest.version}.tgz`;
}

function pack(id) {
  const dir = join(root, "plugins", id);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

  // npm pack 会先跑该包的 prepack（= npm run build），所以 tarball 里的 lib/
  // 一定与 src/ 同步，不依赖提交上来的产物是否最新。
  //
  // --pack-destination 用相对路径：Windows 上 .cmd 必须经 shell 才能执行，
  // 而 shell 会按空格拆参数——仓库检出路径里有空格时绝对路径就散了。
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack",
    "--pack-destination",
    "../.pack",
  ], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const packed = join(outDir, packedName(manifest));
  const stable = join(outDir, `${id}.tgz`);
  rmSync(stable, { force: true });
  renameSync(packed, stable);
  console.log(`[pack-plugins] ${id} → plugins/.pack/${id}.tgz`);
}

mkdirSync(outDir, { recursive: true });
for (const id of BUNDLED) {
  pack(id);
}
