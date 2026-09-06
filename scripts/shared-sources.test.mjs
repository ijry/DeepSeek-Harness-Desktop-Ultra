/**
 * 共享源码的漂移闸门。
 *
 * plugins/.shared/ 里放规范副本，scripts/sync-shared.mjs 把它拷进每个用它的插件的
 * src/。拷贝这个做法的代价就在这里：谁直接改了插件里的那份副本，什么都不会报错，
 * 五份实现从此各走各路——而这个模块是每个面板的事件通道，出问题的样子是「某个面板
 * 偶尔收不到推送」，最难查的那一类。
 *
 * 所以这条测试盯两件事：副本与规范副本逐字节相同，以及副本确实存在（插件被改名或
 * 删掉时，SHARED 名单必须跟着改，而不是静默少同步一个）。
 *
 * 它放在根 `npm test`（"node --test scripts/*.test.mjs"）而不是插件自己的
 * `node --test`：plugins/.shared/ 在插件包目录之外，发布出去的 tarball 里没有它，
 * 放插件里跑会在用户机器上直接失败。
 *
 * @module scripts/shared-sources.test
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pairs, SHARED } from "./sync-shared.mjs";

test("每个插件里的共享源码与 plugins/.shared 下的规范副本逐字节相同", async () => {
  for (const pair of await pairs()) {
    const copy = await readFile(pair.copy, "utf8").catch(() => undefined);
    assert.notEqual(
      copy,
      undefined,
      `${pair.plugin}/src/${pair.path} 不存在 —— 插件改名或删除后要同时改 SHARED 名单`,
    );
    assert.equal(
      copy,
      pair.source,
      `${pair.plugin}/src/${pair.path} 与 plugins/.shared/${pair.path} 不一致 —— `
        + "改规范副本再跑 `npm run sync:shared`，不要直接改插件里的副本",
    );
  }
});

test("规范副本不写死某个插件的路径 —— 否则共享的意义就没了", async () => {
  for (const entry of SHARED) {
    const source = await readFile(
      (await pairs()).find((pair) => pair.path === entry.path).canonical,
      "utf8",
    );
    // 允许注释里出现插件名（模块文档要举例），只禁止代码里出现 '/dsh-plugin-xxx/…' 这种
    // 字面量路径：那正是抽取前每份副本唯一的实质差异，回归了就说明常量又被搬回来了。
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(
      code,
      /['"`]\/dsh-plugin-[a-z-]+\//,
      `plugins/.shared/${entry.path} 里出现了写死的插件路径 —— 路径应当由调用方通过 options 传入`,
    );
  }
});

test("SHARED 名单里的插件都是真实存在的内置插件", async () => {
  const { BUNDLED } = await import("./pack-plugins.mjs");
  for (const entry of SHARED) {
    assert.ok(entry.plugins.length > 0, `${entry.path} 没有任何使用者，应当从 SHARED 里删掉`);
    for (const plugin of entry.plugins) {
      assert.ok(
        BUNDLED.includes(plugin),
        `${plugin} 不在 pack-plugins.mjs 的 BUNDLED 名单里 —— 名字写错了？`,
      );
    }
  }
});
