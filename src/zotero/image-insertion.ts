export function captureEditorRange(editor: HTMLElement): Range {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) return range.cloneRange();
  }
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

/** Preserve native undo when the editor is focused; never steal another editor's focus. */
export function insertImageText(editor: HTMLElement, range: Range, text: string): boolean {
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return false;
  const doc = editor.ownerDocument;
  if (doc.activeElement === editor) {
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if ((doc as any).execCommand?.("insertText", false, text)) return true;
  }
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (doc.activeElement === editor) {
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return true;
}
