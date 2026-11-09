# Zotero 10 兼容性记录

0.8.8 将安装包声明的 Zotero 兼容范围从 `9.0`–`9.0.*` 扩展到 `9.0`–`10.0.*`，保留 0.8.7 的笔记折叠设置与 Markdown 渲染。

## 核对依据

- 核对日期：2026-11-08。
- 本机应用：`D:\00_work_app\04_note\Zotero\app\application.ini`，版本 `10.0.8`，BuildID `20261106171835`。
- 本机 `platform.ini`：Mozilla `140.17.0`，与现有 `firefox140` 构建目标相符。
- [Zotero 10 官方开发文档](https://www.zotero.org/support/dev/zotero_10_for_developers)：Zotero 10 沿用 Firefox 140 ESR；确认兼容后应把 `strict_max_version` 改为 `10.0.*`。

## 本机应用文件核对

只读检查安装目录的 `app/omni.ja`，未修改应用或用户文献库。

| 功能 | 核对结果 |
| --- | --- |
| Reader 工具栏、批注右键菜单 | `xpcom/reader.js` 仍提供 `registerEventListener`、`_unregisterEventListenerByPluginID`、`renderToolbar`、`createAnnotationContextMenu` |
| PDF 视图初始化 | Reader 仍通过 `_internalReader._primaryView` 暴露 PDF 视图；`_iframeWindow`、`_iframeDocument`、`initializedPromise` 仍存在 |
| 原生选择与筛选 | Reader bundle 仍包含 `_updateState`、`_annotationManager`、`setFilter` 和 `_state.annotations` |
| 设置页面 | `xpcom/preferencePanes.js` 仍提供 `register`/`unregister`，接受 `pluginID`、`src`、`stylesheets` |
| 批注读取与保存 | `xpcom/data/item.js` 仍提供 `getAnnotations` 与 `annotationComment`；现有代码通过 `item.saveTx()` 保存 |
| 可选便签图标缩小 | Reader bundle 仍包含 `_drawNote`、`_drawNoteIcon`、`getSelectableAnnotations`、`getSelectedAnnotationAction`、`_p2v`；此功能继续默认关闭 |
| Zotero 10 移除的接口 | 本项目未使用官方迁移文档中移除的单选集合接口、旧全文索引和 CookieSandbox 接口 |

## 验证边界

应用文件检查说明相关入口仍存在，不能替代在运行中的 Zotero 10 内完成安装、PDF 布局和交互验收。尚未在用户的 Zotero 内安装此版本；安装后检查见 [人工验收清单](./manual-smoke-test.md)。

`verify:xpi` 会检查最终安装包的 Zotero 插件 ID、兼容上下限、版本、必需文件以及构建包与归档包的 SHA-256 一致性。
