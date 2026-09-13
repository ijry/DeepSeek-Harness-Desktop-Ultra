/**
 * 内置插件的清单在三处各写一遍，而三处失配都不会在构建时报错：
 *
 *   - `scripts/pack-plugins.mjs` 的 BUNDLED——决定打出哪些 tarball
 *   - `src-tauri/tauri.conf.json` 的 bundle.resources——决定哪些 tarball 进安装包
 *   - `src-tauri/src/plugins.rs` 的 BUNDLED——决定界面上列出、并去装哪些插件
 *
 * 漏了前两处，插件会等到用户点「安装」时才报「定位内置插件资源失败」；漏了第三处，
 * tarball 白进安装包却没人装得上。三个插件时靠眼睛还能对齐，九个不行。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUNDLED as PACKED } from "./pack-plugins.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rust = readFileSync(join(root, "src-tauri", "src", "plugins.rs"), "utf8");
const tauri = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
);

/** plugins.rs 里每个 `pub const X: Bundled` 的常量名 → 它的 npm 包名。 */
function declaredPlugins() {
  const found = new Map();
  const pattern = /pub const (\w+): Bundled = Bundled \{[\s\S]*?id: "([^"]+)"/g;
  for (const [, name, id] of rust.matchAll(pattern)) {
    found.set(name, id);
  }
  return found;
}

/** plugins.rs 的 `BUNDLED` 数组里列出的包名，按卡片顺序。 */
function rustBundled() {
  const declared = declaredPlugins();
  const list = rust.match(/pub const BUNDLED: &\[Bundled\] = &\[([\s\S]*?)\];/);
  assert.ok(list, "plugins.rs 里找不到 BUNDLED 列表——这条守卫的正则要跟着改");
  return list[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((name) => {
      const id = declared.get(name);
      assert.ok(id, `BUNDLED 里的 ${name} 不是一个 Bundled 常量`);
      return id;
    });
}

test("三处内置插件清单完全一致", () => {
  const inRust = rustBundled();
  const inResources = Object.values(tauri.bundle.resources).map((target) =>
    target.replace(/^plugins\//, "").replace(/\.tgz$/, "")
  );

  assert.deepEqual([...PACKED].sort(), [...inRust].sort());
  assert.deepEqual([...inResources].sort(), [...inRust].sort());
});

test("共享总线是唯一、排第一且对用户隐藏的基础插件", () => {
  const rows = [...rust.matchAll(/pub const (\w+): Bundled = Bundled \{([\s\S]*?)\n\};/g)]
    .map(([, name, body]) => ({
      name,
      id: body.match(/id: "([^"]+)"/)?.[1],
      hidden: body.match(/hidden: (true|false)/)?.[1] === "true",
      infrastructure: body.match(/infrastructure: (true|false)/)?.[1] === "true",
    }))
  const infrastructure = rows.filter(row => row.infrastructure)
  assert.deepEqual(infrastructure.map(row => row.id), ["dsh-plugin-otools-socket"])
  assert.equal(infrastructure[0].hidden, true)
  assert.equal(PACKED[0], "dsh-plugin-otools-socket")
  assert.equal(rustBundled()[0], "dsh-plugin-otools-socket")
  assert.match(rust, /pub fn selectable\(\)[\s\S]*?filter\(\|plugin\| !plugin\.hidden\)/)
  assert.match(rust, /pub fn find_selectable\(id: &str\)[\s\S]*?selectable\(\)\.find/)
  assert.match(rust, /pub fn status\([\s\S]*?selectable\(\)[\s\S]*?\.map\(\|plugin\| Status/)
})

test("每个内置插件的资源路径与 stage() 的约定一致", () => {
  // stage() 按 `plugins/{id}.tgz` 去 Resource 目录里找，源头则是 pack-plugins.mjs
  // 固定输出的 `plugins/.pack/{id}.tgz`（不带版本号，路径才稳定）。
  for (const id of rustBundled()) {
    assert.equal(
      tauri.bundle.resources[`../plugins/.pack/${id}.tgz`],
      `plugins/${id}.tgz`,
      `${id} 的资源映射不对`
    );
  }
});

test("声明了的 Bundled 常量都进了 BUNDLED 列表", () => {
  // 写了常量却忘了挂进列表，界面上就是「插件凭空少了一个」，且没有任何报错。
  const declared = [...declaredPlugins().values()].sort();
  assert.deepEqual(declared, [...rustBundled()].sort());
});

test("内置插件不重复", () => {
  // id 同时是资源文件名、profile 的 bundles 行名和前端 key，重名会静默串台。
  assert.equal(new Set(PACKED).size, PACKED.length);
});

test("桌面升级会刷新用户已选择的稳定版本插件包", () => {
  assert.match(rust, /const BUNDLE_REVISION: u32 = [1-9]\d*;/)
  assert.match(rust, /pub fn plugins_to_refresh\(choice: &Choice\)/)
  assert.match(rust, /choice\.bundle_revision >= BUNDLE_REVISION/)
  const main = readFileSync(join(root, "src-tauri", "src", "main.rs"), "utf8")
  assert.match(main, /refresh_bundled_plugins[\s\S]*?install_infrastructure[\s\S]*?if asking/)
  assert.match(main, /plugins::uninstall[\s\S]*?plugins::install/)
  assert.match(rust, /plugin\.infrastructure \|\| choice\.installed/)
});
