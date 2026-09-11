/**
 * 测试进程的语言锚：把宿主/客户端语言固定为中文。
 *
 * host 半边的 hostLang() 与 client 半边的语言判定都会读进程环境
 * （DSH_DESKTOP_LANG，其次 LC_ALL / LC_MESSAGES / LANG，最后回落 zh）。
 * 开发机的 shell 若带 LANG=en_US，断言中文文案的测试就会随机翻车——
 * 语言是插件自己的行为，不该被运行测试的终端 locale 决定。
 *
 * 通过 `node --test --import ./test/setup-env.mjs` 在任何业务模块加载
 * 之前执行（ESM import 提升会晚于此文件）。
 */
process.env.DSH_DESKTOP_LANG = 'zh'
