# 0.11.0：批注随 PDF 等比缩放，可调整注释框宽度

卡片按 PDF 100% 时的尺寸计算布局，卡片、文字、图片、引线与页边栏一起随 PDF 缩放。缩放不再改变换行、预览行数、卡片相对位置或密集批注的折叠状态。

- 默认宽度在 50%、100%、200% 缩放下分别约为 180、360、720px。
- 去掉低于 80% 时的一行预览与图片文字标记；“自动折叠笔记”继续控制三行预览和密集批注收起，关闭后显示完整内容。
- 正在编辑时也立即跟随缩放，保留同一个编辑框、草稿、焦点与光标。后台留白检测仍等编辑结束再应用。
- 编辑 → 设置 → 页边批注 → 阅读器外观新增宽度滑块、数字输入和恢复默认。范围 200–640px，默认 360px，表示 PDF 100% 时的宽度；修改后自动保存并立即应用到已打开的 PDF。
- 保留已有的划线选侧、Markdown、公式、图片引用及打开 PDF 时清理未引用图片的行为。

调整宽度或编辑内容会按新尺寸重新排版；PDF 旋转后按新方向定位。单纯缩放保持基准布局。

## 验证入口

- `corepack pnpm test`：缩放后基准位置、换行内容、引线与草稿选区；宽度滑块、数字输入、恢复默认与持久化；原有图片和清理回归。
- `corepack pnpm run typecheck`、`corepack pnpm run stress`。
- `corepack pnpm run build`、`corepack pnpm run verify:xpi`。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<PLLaVA PDF>" --zoom`：独立 Zotero 测试库中的 50% / 100% / 200% 原生显示、折叠与完整预览、宽度控件和编辑焦点。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<PLLaVA PDF>" --images --native-clipboard`：回归图片粘贴、保存与重开清理。

安装包：`releases/margin-comments-0.11.0.xpi`。覆盖安装后重新打开 PDF。

## 本次验证结果

2026-11-13：110 项自动测试、类型检查、50 / 150 / 300 / 600 / 1000 条批注压力测试、构建与 XPI 校验通过。

独立 Zotero 10.0.8 中，完整和折叠预览在 50% / 100% / 200% 缩放下保持基准位置、引线坐标、排版与预览高度；默认卡片实际宽度为 180 / 360 / 720px。原生设置片段的滑块、数字同步、持久化读取与恢复默认通过，480px 基准在 50% 时显示为 240px；缩放过程中草稿、焦点和光标保留。已查看三个比例的原生截图。Zotero 9 仍需单独人工验收。

真实 PDF 浏览器检查中，缩放、长笔记与旋转的测试卡片覆盖原文像素数均为 0；页面留白检测在缩放时复用缓存。原生图片粘贴、保存、撤销、重命名、缺失恢复、放大和打开 PDF 时清理未引用图片的回归均通过。

- [原生缩放与设置结果](../build/zotero-zoom-qa/results.json)
- [50% 截图](../build/zotero-zoom-qa/zoom-50.png)、[100% 截图](../build/zotero-zoom-qa/zoom-100.png)、[200% 截图](../build/zotero-zoom-qa/zoom-200.png)
- [原生图片回归结果](../build/zotero-images-qa/results.json)

SHA-256：`FE27FEF59202A1522B8E3610F3049E0FC1979C4C107F38E60DB3118BBBAB4070`。
