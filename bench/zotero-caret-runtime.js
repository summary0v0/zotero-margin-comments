/* Real mouse gestures in an isolated Zotero profile, never the personal library. */
async function verifyCommentCaret({ annotation, session, adapter, reader, scope, application, result }) {
  const doc = adapter.document();
  const win = reader._internalReader._primaryView._iframeWindow;
  const utils = Cu.unwaiveXrays(win).windowUtils;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const store = new scope.MarginStore();
  const card = () => doc.querySelector(`.zmc-card[data-annotation-key="${annotation.key}"]`);
  const preview = () => card().querySelector(".zmc-card-preview");
  const editor = () => card().querySelector(".zmc-card-editor");
  async function source(value, collapse = false, scale = 1) {
    editor().blur();
    await pause(60);
    await store.saveComment(annotation.id, value);
    await session.refresh(true);
    session.setCollapseNotes(collapse);
    application.pdfViewer.currentScale = scale;
    await pause(150);
    adapter.centerCurrentPageHorizontally();
    preview().scrollIntoView({ block: "center", inline: "nearest" });
    await pause(100);
  }
  function find(text, occurrence = 0) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3 && child.nodeValue === text) matches.push(child);
        visit(child);
      }
    };
    visit(preview());
    if (!matches[occurrence]) throw new Error(`Missing preview text: ${text}`);
    return matches[occurrence];
  }
  async function click(node, offset) {
    const range = doc.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width * 0.2, y = rect.top + rect.height / 2;
    utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
    utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
    utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    await pause(50);
  }
  function prefix() {
    const selection = win.getSelection();
    const range = doc.createRange(); range.selectNodeContents(editor());
    range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString();
  }
  result.caret = [];
  const cases = [
    { name: "plain-third-line", source: "第一行\n第二行\n第三行目标文字", text: "第三行目标文字", offset: 3 },
    { name: "repeated-third-line", source: "重复文字\n重复文字\n重复文字", text: "重复文字", occurrence: 2, offset: 2 },
    { name: "bold-list", source: "## 标题\n\n- **目标文字**\n- 后面", text: "目标文字", offset: 2 },
    { name: "table-last-cell", source: "| 名称 | 数值 |\n| --- | --- |\n| 重复 | 重复 |", text: "重复", occurrence: 1, offset: 1 },
    { name: "native-bold", source: "首行\n<b>目标文字</b>", text: "目标文字", offset: 2 },
    { name: "collapsed-preview", source: "第一行\n第二行目标\n第三行\n第四行\n第五行", text: "第二行目标", offset: 2, collapse: true },
    { name: "half-zoom", source: "首行\n第二行\n第三行目标文字", text: "第三行目标文字", offset: 3, scale: 0.5 },
    { name: "double-zoom", source: "首行\n第二行\n第三行目标文字", text: "第三行目标文字", offset: 3, scale: 2 },
  ];
  for (const test of cases) {
    await source(test.source, test.collapse, test.scale);
    let expected = -1;
    for (let i = 0; i <= (test.occurrence ?? 0); i++) expected = test.source.indexOf(test.text, expected + 1);
    expected += test.offset;
    const expectedPrefix = test.source.slice(0, expected).replace(/<\/?(?:b|i|sub|sup)>/gi, "");
    await click(find(test.text, test.occurrence), test.offset);
    const actual = prefix();
    const entry = { name: test.name, expectedPrefix, actualPrefix: actual,
      focused: doc.activeElement === editor(), collapsed: win.getSelection().isCollapsed,
      unchanged: store.list(annotation.parentID).find((item) => item.key === annotation.key).comment === test.source };
    result.caret.push(entry);
    if (actual !== expectedPrefix || !entry.focused || !entry.collapsed || !entry.unchanged) {
      throw new Error(`Click caret mismatch: ${JSON.stringify(entry)}`);
    }
  }
  await source("首行\n\n$$\\frac{a}{b}$$\n\n末行");
  await click(preview().querySelector("math mi").firstChild, 0);
  result.formulaCaret = prefix();
  if (result.formulaCaret !== "首行\n\n$$") throw new Error(`Formula click missed source: ${result.formulaCaret}`);
  // Keep a final ordinary text caret visible in the screenshot.
  await source("第一行保持原样\n第二行保持原样\n第三行：从这里继续修改");
  await click(find("第三行：从这里继续修改"), 5);
  win.eval("document.execCommand('insertText', false, '【修改】')");
  const expected = "第一行保持原样\n第二行保持原样\n第三行：从【修改】这里继续修改";
  for (let i = 0; i < 60; i++) {
    result.savedEdit = store.list(annotation.parentID).find((item) => item.key === annotation.key).comment;
    if (result.savedEdit === expected) break;
    await pause(50);
  }
  if (result.savedEdit !== expected) throw new Error(`Edit was inserted at the wrong line: ${result.savedEdit}`);
  editor().scrollIntoView({ block: "center", inline: "nearest" });
  await pause(100);
}
