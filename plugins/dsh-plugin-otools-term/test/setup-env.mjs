/**
 * 测试进程的语言锚：把宿主/客户端语言固定为中文。
 *
 * client 半边的语言判定会从 state.language / 环境回落链里取值
 * （DSH_DESKTOP_LANG → LC_ALL → LC_MESSAGES → LANG → zh）。开发机的
 * shell 若带 LANG=en_US，断言中文文案的 client bundle 测试就会随机
 * 翻车——语言是插件自己的行为，不该被运行测试的终端 locale 决定。
 *
 * 通过 `node --test --import ./test/setup-env.mjs` 在任何业务模块加载
 * 之前执行（ESM import 提升会晚于此文件）。
 */
process.env.DSH_DESKTOP_LANG = 'zh'
