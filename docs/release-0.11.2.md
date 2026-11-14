# 0.11.2：笔记 Tab 缩进

- 在笔记编辑框按 `Tab`，在光标处插入 4 个空格。
- 选中文字后按 `Tab`，整行批量缩进；`Shift + Tab` 取消当前行或选中行的一级缩进（最多 4 个空格或 1 个制表符）。
- 保留编辑焦点、多行选区方向及原有粗体、斜体、上下标，不把按键传给 PDF 阅读器。
- 保存时保留首尾空白，避免首行缩进被删除；继续使用原有自动保存与取消编辑流程。
- `Ctrl/Cmd/Alt + Tab` 不被缩进处理拦截；只读批注不可修改。

安装包：[margin-comments-0.11.2.xpi](../releases/margin-comments-0.11.2.xpi)。覆盖安装后重新打开 PDF。

阅读状态继续使用 Markdown 规则：例如四个空格开头的段落可显示为代码块，列表缩进可形成嵌套列表；点击卡片仍编辑原始文本。

## 验证入口

- `corepack pnpm test`：缩进位置、空笔记、多行与反向选区、BR/DIV 换行、格式保留、自动保存、重新编辑及取消。
- `corepack pnpm run typecheck`、`corepack pnpm run build`、`corepack pnpm run verify:xpi`。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<PLLaVA PDF>" --indent`：在独立配置和独立库中检查实际 Gecko 编辑器、原生撤销/重做与 Zotero 保存，不操作日常 Zotero 数据库。

## 本次验证结果

2026-11-14：129 项自动测试、类型检查、构建和 XPI 校验通过。

独立 Zotero 10.0.8 的 14 项缩进检查全部通过，涵盖原生撤销/重做、自动保存、销毁并重建阅读会话后的首行缩进、多行与反向选区、取消缩进及 BR/DIV 换行与粗斜体。已查看原生截图。Zotero 9 尚未单独验收。

- [原生检查结果](../build/zotero-indent-qa/results.json)
- [原生截图](../build/zotero-indent-qa/screenshot.png)

SHA-256：`9BD894F21A39A0EE84C962B854FD9BBFA89F899EE862109782BA4F5A631F5F9D`。
