# 0.9.2：长划线批注优先从右侧开始

在 0.9.1 的就近选侧规则之后，加入原文长划线的右侧偏好。

1. 明显靠左、靠右的批注继续就近显示。
2. 原文划线范围较长且居中时，两侧卡片数量相同优先放右侧。长度按高亮/下划线选区的整体范围计算，评论字数不参与判断；整体宽度阈值由页面的 40% 调整为 30%，中心距页面中线仍不超过页面宽度的 5%。
3. 两侧数量不同时，新居中长划线优先使用卡片较少的一侧。比如空白页依次添加三条居中长划线，初始顺序为右、左、右。
4. 本次阅读中已分配的卡片保持原侧。编辑、缩放、筛选、临时隐藏和新增批注不搬动旧卡片；选区位置改变时重新判断，旋转按方向定位并缓存，关闭重开 PDF 时重新分配。

## 验证入口

- `corepack pnpm test` 与 `corepack pnpm run typecheck`。
- `corepack pnpm run build` 与 `corepack pnpm run verify:xpi`。
- `node scripts/verify-zotero-runtime.mjs "<zotero.exe>" "<测试 PDF>" --sides`：独立配置中的原生 Zotero 验证，增加“新页面第一条居中长划线放右侧”的检查；结果位于 `build/zotero-sides-qa/results.json`。

2026-11-13：86 项自动测试、类型检查、构建及 XPI 校验通过。独立 Zotero 10.0.8 验证中，宽度恰为页面 30%、中心略偏左的第一条划线采用右侧，评论仅含两个字；另一个测试页的 6 条居中划线左右各 3 条，连同明确选侧和新增批注，最终 10 张卡片左右各 5 张。编辑、缩放、隐藏再显示、旋转恢复和新增批注的稳定性检查均通过。

- [原生验证结果](../build/zotero-sides-qa/results.json)
- [原生界面截图](../build/zotero-sides-qa/screenshot.png)

安装包：`releases/margin-comments-0.9.2.xpi`。安装后重新打开 PDF，让新分配规则生效。

SHA-256：`633FC02579332608E48CAAFB1C0B20F337DC6CE82218FAD3B7C5CE68CAF3E423`。
