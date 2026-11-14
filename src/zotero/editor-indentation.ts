const INDENT = "    ";
interface Point { node: Node; offset: number }
interface Edit { start: number; end: number; text: string }

/** Map source lines across text nodes, inline formatting, BRs and native DIV lines. */
export function editorText(editor: HTMLElement): { text: string; points: Point[] } {
  let text = "";
  const points: Point[] = [{ node: editor, offset: 0 }];
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes) as ChildNode[]) {
      if (child.nodeType === 3) {
        const value = child.nodeValue ?? "";
        for (let i = 0; i < value.length; i++) {
          points[text.length] = { node: child, offset: i };
          text += value[i];
          points[text.length] = { node: child, offset: i + 1 };
        }
      } else if (child.nodeType === 1) {
        const element = child as HTMLElement;
        if (element.localName === "br") {
          const index = Array.prototype.indexOf.call(parent.childNodes, child);
          points[text.length] = { node: parent, offset: index };
          text += "\n";
          points[text.length] = { node: parent, offset: index + 1 };
        } else {
          if (element.localName === "div" && text && !text.endsWith("\n")) {
            text += "\n";
            points[text.length] = { node: child, offset: 0 };
          }
          visit(child);
        }
      }
    }
  };
  visit(editor);
  return { text, points };
}

function pointOffset(editor: HTMLElement, points: Point[], node: Node, offset: number): number {
  const caret = editor.ownerDocument.createRange();
  caret.setStart(node, offset);
  caret.collapse(true);
  const index = points.findIndex((point) => caret.comparePoint(point.node, point.offset) >= 0);
  return index < 0 ? points.length - 1 : index;
}

/** Change source whitespace only; leave inline formatting and native undo intact. */
export function indentEditor(editor: HTMLElement, outdent = false): boolean {
  if (editor.contentEditable === "false") return false;
  const doc = editor.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection?.rangeCount) return false;
  const selected = selection.getRangeAt(0);
  if (!editor.contains(selected.startContainer) || !editor.contains(selected.endContainer)) return false;

  const { text, points } = editorText(editor);
  const start = pointOffset(editor, points, selected.startContainer, selected.startOffset);
  const end = pointOffset(editor, points, selected.endContainer, selected.endOffset);
  const backward = !selected.collapsed && selection.anchorNode === selected.endContainer
    && selection.anchorOffset === selected.endOffset;
  const anchor = backward ? end : start;
  const focus = backward ? start : end;
  const edits: Edit[] = [];
  if (selection.isCollapsed && !outdent) {
    edits.push({ start, end, text: INDENT });
  } else {
    let line = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
    // An end exactly at the next line's start does not select that line.
    do {
      const prefix = text.slice(line).match(/^(?:\t| {1,4})/)?.[0] ?? "";
      if (!outdent || prefix) edits.push({ start: line, end: line + (outdent ? prefix.length : 0), text: outdent ? "" : INDENT });
      const next = text.indexOf("\n", line);
      if (next < 0) break;
      line = next + 1;
    } while (line < end);
  }
  if (!edits.length) return false;

  // Live Ranges follow native node splitting while editing from bottom to top.
  const changes = edits.map((edit) => {
    const range = doc.createRange();
    range.setStart(points[edit.start].node, points[edit.start].offset);
    range.setEnd(points[edit.end].node, points[edit.end].offset);
    return { edit, range };
  });
  for (const { edit, range } of changes.reverse()) {
    selection.removeAllRanges();
    selection.addRange(range);
    const command = edit.text ? "insertText" : "delete";
    if (!(doc as any).execCommand?.(command, false, edit.text || null)) {
      range.deleteContents();
      if (edit.text) range.insertNode(doc.createTextNode(edit.text));
    }
  }
  const updated = editorText(editor);
  const move = (offset: number) => offset + edits.reduce((delta, edit) =>
    delta + (offset < edit.start ? 0 : edit.text.length - Math.min(offset - edit.start, edit.end - edit.start)), 0);
  const a = updated.points[move(anchor)];
  const f = updated.points[move(focus)];
  selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  // Gecko may already emit input for execCommand; the repeated read is harmless.
  const input = doc.createEvent("Event");
  input.initEvent("input", true, false);
  editor.dispatchEvent(input);
  return true;
}
