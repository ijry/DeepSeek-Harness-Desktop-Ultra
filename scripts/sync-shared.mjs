#!/usr/bin/env node
// 把 plugins/.shared/ 下的规范副本同步到每个用它的插件里。
//
// 为什么是「构建期拷贝」而不是一个共享 npm 包：插件靠 npm tarball 分发
// （scripts/pack-plugins.mjs），而 `npm pack` 不会带上包目录之外的文件。做成共享包就得
// 给现在零依赖的七个插件都加一条 dependencies，用户装插件时多一次 npm 拉取——正好破掉
// 「解包即用」这个特性（term 与 dbm 已经因为有运行时依赖被标 heavy: true）。拷贝进去之后
// 每份都是插件自己的真实文件，发布出去的包依旧自包含，装包的人感知不到这套机制。
//
// 为什么拷进 src/ 而不只是 lib/：插件测试 import 的是 src/（见各插件 test/*.test.mjs），
// 各自的 scripts/build.mjs 再把 src/host 整个复制成 lib/host。所以 src/ 是源头，
// lib/ 由插件自己的构建产生，这个脚本不碰 lib/。
//
// 代价是 src/host/socket.js 变成了生成物：改错地方（改副本而不是改规范副本）不会报错，
// 只会静默漂移。scripts/shared-sources.test.mjs 就是盯这件事的闸门，它进根 `npm test`。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 规范副本（相对 plugins/.shared/ 的路径） → 用它的插件。
 *
 * host/socket.js：五份手写 RFC 6455 各 228 行，逻辑逐字节相同，差异只有模块注释与
 * 那个 SOCKET_PATH 常量。常量已经从模块里去掉——path 改成调用方必传，这样这个模块
 * 与「一个插件一条路径」脱钩，将来 dsh-plugin-otools-socket 把多个插件收到一条
 * socket 上时，它一行都不用改。
 *
 * 有意不在这里的：shared/lang.js 与 host/sdk.js。看着也像重复，但 normalizeLang 的
 * 分隔符集合（taskboard 认 `@`，canvas 不认）、入参类型判断、process 守卫在各份之间
 * 是真的不一样，统一它们等于改行为，得单独做、单独测。
 */
export const SHARED = [
  {
    path: "client/panel-channel.js",
    plugins: [
      "dsh-plugin-taskboard",
      "dsh-plugin-canvas",
      "dsh-plugin-repopanel",
      "dsh-plugin-otools-git",
      "dsh-plugin-automation",
    ],
  },
  {
    path: "host/socket.js",
    plugins: [
      "dsh-plugin-taskboard",
      "dsh-plugin-canvas",
      "dsh-plugin-repopanel",
      "dsh-plugin-otools-git",
      "dsh-plugin-automation",
    ],
  },
];

/** 规范副本的绝对路径。 */
export function canonicalPath(relative) {
  return join(root, "plugins", ".shared", relative);
}

/** 某个插件里那份副本的绝对路径。 */
export function copyPath(plugin, relative) {
  return join(root, "plugins", plugin, "src", relative);
}

/**
 * 读出所有 (规范副本, 副本) 对，供同步与漂移测试共用。
 * @returns {Promise<Array<{path: string, plugin: string, canonical: string, copy: string, source: string}>>}
 */
export async function pairs() {
  const out = [];
  for (const entry of SHARED) {
    const source = await readFile(canonicalPath(entry.path), "utf8");
    for (const plugin of entry.plugins) {
      out.push({
        path: entry.path,
        plugin,
        canonical: canonicalPath(entry.path),
        copy: copyPath(plugin, entry.path),
        source,
      });
    }
  }
  return out;
}

/** 直接跑这个脚本时才写文件；被测试 import 时只提供上面几个函数。 */
function runAsScript() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (runAsScript()) {
  let changed = 0;
  for (const pair of await pairs()) {
    const before = await readFile(pair.copy, "utf8").catch(() => undefined);
    if (before === pair.source) continue;
    await writeFile(pair.copy, pair.source);
    changed += 1;
    console.log(`[sync:shared] ${pair.plugin}/src/${pair.path}`);
  }
  console.log(
    changed === 0
      ? "[sync:shared] 已是最新，没有文件需要改写"
      : `[sync:shared] 同步了 ${changed} 个文件——记得在插件目录里重新构建 lib/`,
  );
}
