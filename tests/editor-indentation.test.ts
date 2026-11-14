import { afterEach, describe, expect, it, vi } from "vitest";
import { indentEditor } from "../src/zotero/editor-indentation";
import { readStoredComment, renderStoredComment } from "../src/zotero/rich-text-editor";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(source: string) {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  renderStoredComment(editor, source);
  document.body.append(editor);
  editor.focus();
  const selection = document.getSelection()!;
  const select = (anchorNode: Node, anchor: number, focusNode = anchorNode, focus = anchor) =>
    selection.setBaseAndExtent(anchorNode, anchor, focusNode, focus);
  return { editor, selection, select };
}

describe("source editor indentation", () => {
  it("inserts four spaces at the caret and preserves first-line indentation on saving", () => {
    const { editor, select, selection } = setup("字段");
    const input = vi.fn();
    editor.addEventListener("input", input);
    select(editor.firstChild!, 0);
    expect(indentEditor(editor)).toBe(true);
    expect(readStoredComment(editor)).toBe("    字段");
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEnd(selection.focusNode!, selection.focusOffset);
    expect(before.toString()).toBe("    ");
    expect(selection.isCollapsed).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect(input).toHaveBeenCalledOnce();
    expect(indentEditor(editor, true)).toBe(true);
    expect(readStoredComment(editor)).toBe("字段");
  });

  it("indents and outdents an empty editor without losing its whitespace", () => {
    const { editor, select } = setup("");
    select(editor, 0);
    indentEditor(editor);
    expect(readStoredComment(editor)).toBe("    ");
    indentEditor(editor, true);
    expect(readStoredComment(editor)).toBe("");
  });

  it("inserts at the middle of a line without replacing neighbouring text", () => {
    const { editor, select } = setup("前后");
    select(editor.firstChild!, 1);
    indentEditor(editor);
    expect(readStoredComment(editor)).toBe("前    后");
  });

  it("preserves formatting and a backwards multi-line selection", () => {
    const { editor, select, selection } = setup("<b>首行</b>\n次行\n末行");
    const last = editor.lastChild!;
    select(last, 4, editor.querySelector("b")!.firstChild!, 0);
    indentEditor(editor);
    expect(readStoredComment(editor)).toBe("<b>    首行</b>\n    次行\n末行");
    expect(selection.toString()).toBe("首行\n    次行\n");
    expect(selection.anchorNode).toBe(selection.getRangeAt(0).endContainer);
    indentEditor(editor, true);
    expect(readStoredComment(editor)).toBe("<b>首行</b>\n次行\n末行");
    expect(editor.querySelector("b")?.textContent).toBe("首行");
  });

  it("handles BR and native DIV line boundaries and keeps the unselected next line", () => {
    const { editor, select } = setup("");
    editor.innerHTML = "<b>一</b><br>二<div><i>三</i></div><div>四</div>";
    select(editor.querySelector("b")!.firstChild!, 0, editor.lastChild!.firstChild!, 0);
    indentEditor(editor);
    expect(readStoredComment(editor)).toBe("<b>    一</b>\n    二\n<i>    三</i>\n四");
    indentEditor(editor, true);
    expect(readStoredComment(editor)).toBe("<b>一</b>\n二\n<i>三</i>\n四");
  });

  it.each(["  文本", "\t文本", "    文本"])("removes one existing indent from %j", (source) => {
    const { editor, select } = setup(source);
    select(editor.firstChild!, source.length);
    indentEditor(editor, true);
    expect(readStoredComment(editor)).toBe("文本");
  });

  it("handles leading blank lines and a selection beginning at offset zero", () => {
    const { editor, select } = setup("\n文本");
    select(editor.firstChild!, 0, editor.firstChild!, 3);
    indentEditor(editor);
    expect(readStoredComment(editor)).toBe("    \n    文本");
    indentEditor(editor, true);
    expect(readStoredComment(editor)).toBe("\n文本");
  });

  it("leaves unindented lines, read-only content and selections outside the editor alone", () => {
    const { editor, select } = setup("文本");
    select(editor.firstChild!, 1);
    expect(indentEditor(editor, true)).toBe(false);
    editor.contentEditable = "false";
    expect(indentEditor(editor)).toBe(false);
    editor.contentEditable = "true";
    const outside = document.createTextNode("外部");
    document.body.append(outside);
    select(outside, 0);
    expect(indentEditor(editor)).toBe(false);
    expect(readStoredComment(editor)).toBe("文本");
  });
});
