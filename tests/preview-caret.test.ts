import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdownComment } from "../src/zotero/markdown-preview";
import { clickedSourceOffset, placeSourceCaret, previewSourceOffset } from "../src/zotero/preview-caret";
import { readStoredComment, renderStoredComment } from "../src/zotero/rich-text-editor";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(source: string) {
  const preview = document.createElement("div");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  renderMarkdownComment(preview, source);
  renderStoredComment(editor, source);
  document.body.append(preview, editor);
  return { preview, editor };
}

function textNode(root: Node, text: string, occurrence = 0): Text {
  const nodes: Text[] = [];
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes) as ChildNode[]) {
      if (child.nodeType === 3 && child.nodeValue === text) nodes.push(child as Text);
      visit(child);
    }
  };
  visit(root);
  expect(nodes.length).toBeGreaterThan(occurrence);
  return nodes[occurrence];
}

describe("preview click to source caret", () => {
  it.each([
    ["首行\n第二行\n末行", "第二行", 1],
    ["重复\n重复\n重复", "重复", 1, 2],
    ["## 标题\n\n- **目标文字**\n- 后面", "目标文字", 2],
    ["> 引用\n> 第二行", "第二行", 1],
    ["| 名称 | 数值 |\n| --- | --- |\n| 重复 | 重复 |", "重复", 1, 1],
    ["[前](https://example.org/重复)重复", "重复", 1],
    ["![图](path/重复)重复", "重复", 1],
    ["3. 主项\n   - 子项\n   - 子项", "子项", 1, 1],
  ] as [string, string, number, number?][])("maps rendered text in %s", (source, text, offset, occurrence = 0) => {
    const { preview, editor } = setup(source);
    const node = textNode(preview, text, occurrence);
    let expected = -1;
    for (let i = 0; i <= occurrence; i++) expected = source.indexOf(text, expected + 1);
    // URLs/image destinations are hidden, so the rendered repeated word is the last one.
    if (source.includes("path/") || source.includes("https://")) expected = source.lastIndexOf(text);
    const mapped = previewSourceOffset(preview, node, offset)!;
    expect(mapped).toBe(expected + offset);
    editor.focus();
    placeSourceCaret(editor, source, mapped);
    const selection = document.getSelection()!;
    const before = document.createRange();
    before.selectNodeContents(editor);
    before.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
    expect(before.toString()).toBe(source.slice(0, mapped));
    expect(readStoredComment(editor)).toBe(source);
  });

  it("accounts for entities, escapes and literal code", () => {
    const source = "开头 &amp; 文字\\*后面\n\n`a\\b &amp;`\n\n```\na\\b &amp;\n```";
    const { preview } = setup(source);
    const text = textNode(preview, "开头 & 文字*后面");
    expect(previewSourceOffset(preview, text, 8)).toBe(source.indexOf("后面"));
    const code = preview.querySelector("pre code")!.firstChild!;
    expect(previewSourceOffset(preview, code, 3)).toBe(source.lastIndexOf("a\\b") + 3);
    const fence = "```ts\nts\n```";
    const rendered = setup(fence).preview.querySelector("code")!.firstChild!;
    expect(previewSourceOffset(rendered.parentElement!, rendered, 1)).toBe(fence.lastIndexOf("ts") + 1);
  });

  it("places a caret inside Zotero formatting without counting tags as text", () => {
    const source = "首行\n<b>目标</b>与<i>斜体</i>";
    const { preview, editor } = setup(source);
    const offset = previewSourceOffset(preview, textNode(preview, "目标"), 1)!;
    placeSourceCaret(editor, source, offset);
    const range = document.getSelection()!.getRangeAt(0);
    expect(range.startContainer.parentElement?.localName).toBe("b");
    expect(range.startOffset).toBe(1);
    expect(readStoredComment(editor)).toBe(source);
  });

  it("maps MathML to its formula source and supports empty comments", () => {
    const source = "首行\n\n$$\\frac{a}{b}$$\n\n结尾";
    const { preview } = setup(source);
    const math = preview.querySelector("math mi")!;
    expect(previewSourceOffset(preview, math.firstChild!, 0)).toBe(source.indexOf("\\frac"));
    const empty = setup("");
    placeSourceCaret(empty.editor, "", 0);
    expect(document.getSelection()!.isCollapsed).toBe(true);
    expect(previewSourceOffset(preview, empty.editor, 0)).toBeUndefined();
  });

  it("uses pre-switch browser hit testing rather than coordinates in the source layout", () => {
    const source = "第一行\n第二行";
    const { preview } = setup(source);
    const hit = textNode(preview, "第二行");
    const caret = vi.fn(() => ({ offsetNode: hit, offset: 2 }));
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: caret });
    const event = new MouseEvent("click", { clientX: 40, clientY: 75, detail: 1 });
    expect(clickedSourceOffset(preview, event)).toBe(source.indexOf("第二行") + 2);
    expect(caret).toHaveBeenCalledWith(40, 75);
    delete (document as any).caretPositionFromPoint;
  });
});
