<p align="center">
  <img src="./addon/content/icons/margin-comments.svg" width="104" alt="Zotero Margin Comments 图标">
</p>

<h1 align="center">Zotero Margin Comments</h1>

<p align="center">
  让高亮解释与独立便签直接出现在 PDF 页边。<br>
  用引线连接原批注，就地编辑，并自动保存回 Zotero。
</p>

<p align="center">
  <a href="https://github.com/XiaoDuComrade/zotero-margin-comments">
    <img src="https://img.shields.io/badge/Zotero-9.0.x-CC2936?style=flat-square&logo=zotero&logoColor=white" alt="Zotero 9.0.x">
  </a>
  <img src="https://img.shields.io/badge/version-0.8.6-4A78C2?style=flat-square" alt="Version 0.8.6">
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.8">
  <a href="./LICENSE">
    <img src="https://img.shields.io/github/license/XiaoDuComrade/zotero-margin-comments?style=flat-square" alt="MIT License">
  </a>
</p>

<p align="center">
  <a href="./releases/margin-comments-0.8.6.xpi?raw=1"><strong>⬇️ 下载 0.8.6</strong></a>
  ·
  <a href="#安装">安装</a>
  ·
  <a href="#功能亮点">功能</a>
  ·
  <a href="#兼容性">兼容性</a>
  ·
  <a href="#开发与构建">开发</a>
</p>

---

## 为什么需要它？

Zotero 默认将高亮、下划线等批注的评论集中显示在 Reader 侧栏中。阅读正文时，批注位置与解释内容彼此分离，需要反复移动视线。

Margin Comments 将评论卡片放到对应 PDF 页面的左侧或右侧，并用引线连接原批注：

```text
PDF 原批注  ─────  引线  ─────  页边评论卡片
     ↑                              │
     └──────── 自动保存回 Zotero ────┘
```

插件直接使用 Zotero 原有批注数据，不修改 PDF 文件，也不建立另一套批注数据库。

## 功能亮点

<table>
  <tr>
    <td width="50%"><strong>↔️ 智能左右分栏</strong><br>批注位于页面左半区时显示在左边，位于右半区时显示在右边。</td>
    <td width="50%"><strong>✏️ 就地编辑</strong><br>点击评论卡片即可编辑，停止输入 700 ms 或失焦后自动保存。</td>
  </tr>
  <tr>
    <td><strong>🧭 精确引线</strong><br>引线从批注上边缘引出，避免横穿正文，并在缩放、旋转和重绘后重新定位。</td>
    <td><strong>🗒️ 独立便签</strong><br>Zotero 独立便签也能显示为页边卡片，即使内容暂时为空。</td>
  </tr>
  <tr>
    <td><strong>📚 密集批注整理</strong><br>评论超过页面高度时自动折叠；展开后在当前页面边栏内滚动。</td>
    <td><strong>🎛️ 类型筛选</strong><br>可分别显示或隐藏高亮、下划线、便签、文字和图片/区域旁注。</td>
  </tr>
  <tr>
    <td><strong>✨ 交互反馈</strong><br>悬停卡片时，卡片、引线与对应原批注会同步加重并浮起。</td>
    <td><strong>🌗 原生观感</strong><br>支持浅色和深色界面，卡片保持固定屏幕尺寸，不随 PDF 无限缩放。</td>
  </tr>
</table>

<details>
<summary><strong>查看完整功能列表</strong></summary>

- 左右两列分别进行纵向避让，卡片颜色继承原批注颜色。
- 评论默认最多预览三行，超出部分以省略号结尾；点击后展开完整编辑器。
- 展开密集评论后，只绘制当前边栏视野内卡片的引线。
- 点击卡片会选中并定位原批注；点击原批注会高亮对应卡片。
- `Ctrl/Cmd + Enter` 立即保存，`Esc` 取消尚未保存的编辑。
- 批注右键菜单提供“在页边显示/编辑评论”，可为尚无评论的划线创建空卡片。
- Reader 工具栏按钮可以统一显示或隐藏页边批注。
- PDF 缩小到 80% 以下时，卡片自动折叠为一行预览。
- 没有可显示旁注时，不保留额外侧栏或覆盖层，PDF 恢复 Zotero 原生宽度与缩放中心。
- 卡片高度缓存、DOM 复用和分帧刷新用于降低密集批注、缩放及筛选恢复时的卡顿。

</details>

## 设置

打开 **Zotero → 编辑 → 设置 → 页边批注**：

- 选择需要显示的批注类型：高亮、下划线、便签、文字、图片与区域。
- 开启或关闭 **缩小便签图标**，将 PDF 页面原生便签图标缩小到 14px。
- 设置会持久保存，并立即应用到所有已打开的 PDF。

> [!WARNING]
> “缩小便签图标”依赖 Zotero 9.0.x Reader 的内部 Canvas 实现。若 Zotero 更新后出现图标、点选范围或引线异常，请先关闭该选项。

## 安装

1. 下载 [最新版 `margin-comments-0.8.6.xpi`](./releases/margin-comments-0.8.6.xpi?raw=1)。
2. 打开 **Zotero → 工具 → 插件**。
3. 点击右上角齿轮，选择 **从文件安装插件**。
4. 选择下载的 `.xpi` 文件，并按 Zotero 提示完成安装。

首次试用建议使用单独的 Zotero 测试配置文件。历史安装包保存在 [`releases/`](./releases/) 目录中，可以随时回退。

## 使用方法

1. 打开包含批注的 PDF。
2. 点击 Reader 工具栏中的 **页边批注** 按钮显示或隐藏卡片。
3. 点击卡片内容开始编辑；保存由插件自动完成。
4. 对尚无评论的批注点击右键，选择 **在页边显示/编辑评论**。

| 操作 | 效果 |
| --- | --- |
| 点击评论卡片 | 选中原批注并进入编辑 |
| 停止输入 700 ms | 自动保存 |
| `Ctrl/Cmd + Enter` | 立即保存 |
| `Esc` | 取消尚未保存的编辑 |
| 点击工具栏按钮 | 显示或隐藏全部页边批注 |

## 兼容性

| 项目 | 当前支持情况 |
| --- | --- |
| Zotero | `9.0.x` |
| 已验证版本 | `9.0.6` |
| 文档类型 | PDF |
| 界面 | 浅色 / 深色 |
| 数据存储 | Zotero 原批注 |

> [!IMPORTANT]
> 工具栏和右键菜单使用 Zotero Reader 插件事件；页内坐标、Canvas 便签图标和命中区域涉及 Reader 内部实现。Zotero 大版本更新后可能需要重新适配。

## 开发与构建

需要 Node.js、Corepack 和 pnpm：

```powershell
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run stress
corepack pnpm run build
corepack pnpm run verify:xpi
```

构建结果位于 `build/margin-comments-0.8.6.xpi`，同时会归档到 `releases/`。构建脚本不会删除历史版本。

- [人工验收清单](./docs/manual-smoke-test.md)
- [性能与压力测试](./docs/performance.md)

## 项目结构

```text
addon/        Zotero 清单、设置页与静态资源
src/core/     批注模型与页边布局算法
src/zotero/   Reader 适配、会话、编辑器与数据存储
tests/        单元测试和 Reader 回归测试
bench/        密集批注压力测试
releases/     带版本号的历史 XPI
```

## 数据与隐私

- 不修改 PDF 文件。
- 不创建外部批注数据库。
- 评论仍保存在原来的 Zotero 批注中。
- 插件本身不需要网络服务或 API 密钥。

## License

本项目基于 [MIT License](./LICENSE) 开源。

---

<p align="center">
  Made for a calmer Zotero reading experience.
</p>
