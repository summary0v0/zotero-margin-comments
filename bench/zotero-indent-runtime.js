/* Runs only in the isolated Zotero QA profile and library. */
async function verifyCommentIndent({ annotation, session, adapter, reader, scope, result }) {
  const win = reader._internalReader._primaryView._iframeWindow;
  const doc = adapter.document();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const card = () => doc.querySelector(`.zmc-card[data-annotation-key="${annotation.key}"]`);
  const editor = () => card().querySelector(".zmc-card-editor");
  const open = () => { card().querySelector(".zmc-card-preview").click(); editor().focus(); };
  const select = (anchorNode, anchor, focusNode = anchorNode, focus = anchor) =>
    win.getSelection().setBaseAndExtent(anchorNode, anchor, focusNode, focus);
  const key = (shift = false) => win.eval(`(() => {
    const e = document.querySelector('.zmc-card-editor:not(.zmc-editor-hidden)');
    const key = new KeyboardEvent('keydown', {key:'Tab',shiftKey:${shift},bubbles:true,cancelable:true});
    e.dispatchEvent(key); return key.defaultPrevented;
  })()`);
  function check(condition, name) {
    result.indentation[name] = Boolean(condition);
    if (!condition) throw new Error(`Indentation check failed: ${name}; DOM=${editor()?.innerHTML}`);
  }
  const savedSource = () => new scope.MarginStore().list(annotation.parentID)
    .find((item) => item.key === annotation.key).comment;
  async function waitForSave(expected) {
    for (let i = 0; i < 60; i++) {
      if (savedSource() === expected) return;
      await pause(50);
    }
  }
  result.indentation = {};
  open();
  editor().textContent = "首行\n次行\n末行";
  select(editor().firstChild, 0);
  check(key(), "tabHandled");
  check(editor().textContent === "    首行\n次行\n末行", "fourSpacesAtCaret");
  check(doc.activeElement === editor() && win.getSelection().isCollapsed, "focusAndCaretKept");
  win.eval("document.execCommand('undo', false, null)");
  check(editor().textContent === "首行\n次行\n末行", "nativeUndo");
  win.eval("document.execCommand('redo', false, null)");
  check(editor().textContent === "    首行\n次行\n末行", "nativeRedo");
  await pause(850);
  await waitForSave("    首行\n次行\n末行");
  const stored = savedSource();
  result.storedSource = stored;
  result.storedNative = Zotero.Items.get(annotation.id).annotationComment;
  check(stored === "    首行\n次行\n末行", "autosaveKeepsFirstIndent");
  editor().blur();
  await pause(100);
  session.destroy();
  session = new scope.MarginSession(reader, new scope.MarginStore(), () => {});
  session.setCollapseNotes(false);
  await session.start(true);
  open();
  check(editor().textContent === stored, "reopenKeepsFirstIndent");

  // A reverse selection excluding the final line must keep its direction.
  select(editor().firstChild, 10, editor().firstChild, 0);
  key();
  check(editor().textContent === "        首行\n    次行\n末行", "multilineIndent");
  const selected = win.getSelection();
  check(!selected.isCollapsed && selected.anchorNode === selected.getRangeAt(0).endContainer, "reverseSelectionKept");
  key(true);
  check(editor().textContent === stored, "multilineOutdent");
  select(editor().firstChild, 4);
  key(true);
  check(editor().textContent === "首行\n次行\n末行", "singleLineOutdent");
  key(true);
  check(editor().textContent === "首行\n次行\n末行" && doc.activeElement === editor(), "outdentNoopKeepsFocus");

  editor().innerHTML = "<b>粗体</b><br>次行<div><i>斜体</i></div>";
  const range = doc.createRange(); range.selectNodeContents(editor());
  win.getSelection().removeAllRanges(); win.getSelection().addRange(range);
  key();
  check(editor().querySelector("b")?.textContent.includes("粗体")
    && editor().querySelector("i")?.textContent.includes("斜体"), "inlineFormattingKept");
  await pause(850);
  await waitForSave("<b>    粗体</b>\n    次行\n<i>    斜体</i>");
  const formatted = savedSource();
  result.formattedSource = formatted;
  check(formatted.replace(/<\/?[bi]>/g, "") === "    粗体\n    次行\n    斜体", "nativeLineBreaksSaved");
  // Finish on an editable source view for the screenshot.
  return session;
}
