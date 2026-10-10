/**
 * 故意写坏的夹具：`const duplicated` 声明两次。
 *
 * `tools/self-check.mjs` 会导入它并**断言必须报 SyntaxError** —— 用来证明
 * "语法检查"这一项真的有效（而不是永远打印 ✓）。
 *
 * 背景：2026-10-10 本插件的宿主半就因为一次编辑留下了重复的 `const`，
 * 模块根本解析不了、整行不激活，而当时的自检只做字符串匹配、没发现。
 */
const duplicated = 1
const duplicated = 2

export { duplicated }
