# 0.11.1：可调整批注字体大小

在 **编辑 → 设置 → 页边批注 → 阅读器外观 → 批注字号** 中，用滑块或数字调整字号。

- 默认 12.5px，范围 8–32px，步长 0.5px，支持“恢复默认”。
- 表示 PDF 100% 时的字号；随后随 PDF 等比缩放，保留上一版的相对布局规则。
- 预览与编辑文字同步更新，Markdown 标题、代码与公式按其相对字号显示。
- 修改后自动保存，并立即应用到所有已打开的 PDF；新打开的 PDF 使用已保存字号。
- 字号变化后重新测量卡片高度，更新纵向避让、折叠状态和引线。保留编辑中的草稿、焦点及文字选区。

安装包：`releases/margin-comments-0.11.1.xpi`。覆盖安装后重新打开 PDF。

## 验证入口

- `corepack pnpm test`：字号控件同步、0.5px 小数持久化、新阅读器应用、输入范围及草稿选区；保留原有图片、布局、缩放和清理回归。
- `corepack pnpm run typecheck`、`corepack pnpm run stress`、`corepack pnpm run build`、`corepack pnpm run verify:xpi`。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<PLLaVA PDF>" --zoom`：独立 Zotero 的实际字体样式、卡片高度重测、字号保存与恢复默认、50% / 100% / 200% 缩放、编辑草稿与选区。

## 本次验证结果

2026-11-13：112 项自动测试、类型检查、50 / 150 / 300 / 600 / 1000 条批注压力测试、构建与 XPI 校验通过。

独立 Zotero 10.0.8 中，设置 18.5px 后卡片实际样式为 18.5px，小数设置可保存并重新读取，卡片高度随新字号重测。50% / 100% / 200% 下保留相对布局与换行；数字输入与滑块同步，恢复默认后回到 12.5px。编辑草稿时改为 20px 并缩小 PDF 后，文字、焦点与第 3–6 字符选区保留。已查看 18.5px 的原生截图。Zotero 9 仍需单独人工验收。

- [原生检查结果](../build/zotero-zoom-qa/results.json)
- [18.5px 截图](../build/zotero-zoom-qa/font-18.5.png)

SHA-256：`AD41AF33EDF1ABC0A1C8ABAE7A4778EF0FA322734A570C7FAA01B1517AE63887`。
