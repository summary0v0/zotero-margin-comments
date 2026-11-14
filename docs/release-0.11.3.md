# 0.11.3：点击笔记时定位编辑光标

点击页边卡片的第二行、第三行或更后面的文字进入编辑时，光标定位到点击处对应的原文，避免先跳回第一行再重新寻找修改位置。

- 支持普通多行文字、标题、列表、表格、代码及 Zotero 粗斜体。
- 折叠预览展开、缩放 PDF 后，仍按点击文字定位。
- 公式显示与 LaTeX 原文的字符没有一一对应关系，点击公式时定位到该公式的原文开头（分隔符之后）。
- 保留原文与原有保存、Tab 缩进、键盘进入编辑和批注菜单行为；链接与图片继续执行打开操作。
- 预览与原文排版差异较大时尽量定位到对应内容附近。

安装包：[margin-comments-0.11.3.xpi](../releases/margin-comments-0.11.3.xpi)。覆盖安装后重新打开 PDF。

## 验证入口

- `corepack pnpm test`、`corepack pnpm run typecheck`、`corepack pnpm run build`、`corepack pnpm run verify:xpi`。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<PLLaVA PDF>" --caret`：独立 Zotero 库中发送真实鼠标事件，检查普通第三行、重复文字、粗体列表、表格、原生粗体、折叠预览、50% / 200% 缩放及公式定位，并确认输入确实保存到第三行。

## 本次验证结果

2026-11-14：141 项自动测试、类型检查、构建及 XPI 校验通过。

独立 Zotero 10.0.8 中，8 种文字点击场景及公式点击全部通过；真实鼠标点击后焦点和单光标保留，原文未改动。随后输入“【修改】”并自动保存，确认它出现在第三行点击处，前两行保持原样。已查看原生截图。Zotero 9 尚未单独验收。

- [原生检查结果](../build/zotero-caret-qa/results.json)
- [原生截图](../build/zotero-caret-qa/screenshot.png)

SHA-256：`8727AD13F434E5EA9196713B321437CD96D1B3DA929537D6F04FEA8F845AAF58`。
