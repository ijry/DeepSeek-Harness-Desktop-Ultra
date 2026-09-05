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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 要内置的插件目录名。与 src-tauri/src/plugins.rs 里的 BUNDLED 一一对应
 * （scripts/bundled-plugins.test.mjs 盯着这件事），顺序也照卡片顺序：
 * 两个带一堆运行时依赖的排最后，首启逐个装时先把便宜的装完。
 */
export const BUNDLED = [
  "dsh-plugin-taskboard",
  "dsh-plugin-canvas",
  "dsh-plugin-mobile-bridge",
  "dsh-plugin-repopanel",
  "dsh-plugin-otools-git",
  "dsh-plugin-automation",
  "dsh-plugin-longread",
  "dsh-plugin-otools-term",
  "dsh-plugin-otools-dbm",
];

/**
 * 打包时额外给的环境变量。
 *
 * 鲨鱼数据库的 prepack 会跑一次 vite 把 Vue 面板打进 lib/webview，而调用这个脚本的
 * 地方（`npm run build`，包括 CI 的 release 工作流）只装了外壳自己的依赖——插件目录里
 * 没有 vite，那一步会直接挂掉，且是在三个平台上一起挂。面板产物随提交入库，所以让它
 * 复用已提交的那份：DBM_SKIP_WEBVIEW 是插件 build 脚本自己提供的开关，跳过 vite、
 * 保留现有 lib/webview。
 */
const PACK_ENV = {
  "dsh-plugin-otools-dbm": { DBM_SKIP_WEBVIEW: "1" },
};

/**
 * 跳过面板构建时必须已经有一份面板产物。
 *
 * 没有的话插件的 build 只会打印一行 “SKIPPED and no previous build to reuse” 就正常退出，
 * tarball 照样打出来——装上以后面板是空白页，而这一路上没有任何报错。
 */
const REQUIRES_PREBUILT_WEBVIEW = {
  "dsh-plugin-otools-dbm": "lib/webview/index.html",
};

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

  const prebuilt = REQUIRES_PREBUILT_WEBVIEW[id];
  if (prebuilt && !existsSync(join(dir, prebuilt))) {
    throw new Error(
      `${id} 跳过面板构建，但 ${prebuilt} 不存在——这样打出来的包装上是空白页。` +
        `先在插件目录里 npm install && npm run build。`
    );
  }

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
    env: { ...process.env, ...PACK_ENV[id] },
  });

  const packed = join(outDir, packedName(manifest));
  const stable = join(outDir, `${id}.tgz`);
  rmSync(stable, { force: true });
  renameSync(packed, stable);
  console.log(`[pack-plugins] ${id} → plugins/.pack/${id}.tgz`);
}

// 被 scripts/bundled-plugins.test.mjs 直接 import：那条守卫要读 BUNDLED，
// 但绝不该顺手打一遍包。
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  mkdirSync(outDir, { recursive: true });
  for (const id of BUNDLED) {
    pack(id);
  }
}
