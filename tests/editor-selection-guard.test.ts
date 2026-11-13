import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEditorSelectionGuard } from "../src/zotero/editor-selection-guard";

describe("note drag ownership before PDF window capture", () => {
  let editor: HTMLElement;
  let pdf: HTMLElement;
  let view: any;
  let pdfDown: ReturnType<typeof vi.fn>;
  let pdfMove: ReturnType<typeof vi.fn>;
  let down: (event: MouseEvent) => void;
  let move: (event: Event) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    const card = document.createElement("article");
    card.className = "zmc-card";
    editor = document.createElement("div");
    editor.className = "zmc-card-editor";
    editor.contentEditable = "true";
    editor.textContent = "第一行笔记\n第二行笔记\n第三行笔记\n第四行笔记\n第五行笔记\n第六行笔记";
    card.append(editor);
    pdf = document.createElement("div");
    pdf.textContent = "PDF article content";
    document.body.append(card, pdf);
    view = { _iframeWindow: window, _nativeTextSelection: null, _setSelectionRanges: vi.fn() };
    (window as any)._reader = { _primaryView: view };
    pdfDown = vi.fn();
    pdfMove = vi.fn();
    down = (event) => {
      if (view._nativeTextSelection?.handlePointerDown(event)) return;
      pdfDown();
      event.preventDefault();
      document.getSelection()!.selectAllChildren(pdf);
    };
    move = (event) => {
      if (view._nativeTextSelection?.shouldDeferEvent(event)) return;
      pdfMove();
      document.getSelection()!.selectAllChildren(pdf);
    };
    // Reader's window capture handler is registered before the plugin/editor.
    window.addEventListener("mousedown", down, true);
    window.addEventListener("pointermove", move);
    editor.addEventListener("mousedown", (event) => event.stopPropagation());
  });

  afterEach(() => {
    setEditorSelectionGuard(false);
    window.removeEventListener("mousedown", down, true);
    window.removeEventListener("pointermove", move);
    delete (window as any)._reader;
    vi.useRealTimers();
  });

  function selectNote() {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  it("retains a multi-line editor selection even when the pointer moves over PDF text", async () => {
    expect(setEditorSelectionGuard(true)).toBe(true);
    const selection = selectNote();
    const text = selection.toString();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    editor.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(pdfDown).not.toHaveBeenCalled();
    editor.dispatchEvent(new Event("pointermove", { bubbles: true }));
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(pdfMove).not.toHaveBeenCalled();
    expect(selection.toString()).toBe(text);
    expect(editor.contains(selection.anchorNode)).toBe(true);
    expect(editor.contains(selection.focusNode)).toBe(true);
    pdf.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    pdf.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(pdfDown).toHaveBeenCalledOnce();
    expect(pdfMove).toHaveBeenCalledOnce();
    expect(selection.toString()).toBe(pdf.textContent);
  });

  it("restores the desktop Reader hook and original clear/text-layer behaviour on shutdown", () => {
    setEditorSelectionGuard(true);
    view._nativeTextSelection.clear();
    expect(view._setSelectionRanges).toHaveBeenCalledOnce();
    const layer = document.createElement("div");
    view._nativeTextSelection.handleTextLayerRendered(layer);
    expect(layer.draggable).toBe(true);
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    setEditorSelectionGuard(false);
    expect(view._nativeTextSelection).toBeNull();
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(pdfMove).toHaveBeenCalledOnce();
  });

  it("preserves an existing native-selection implementation and unwraps it exactly", () => {
    const originalDown = vi.fn(() => false), originalDefer = vi.fn(() => true);
    const native = { enabled: true, handlePointerDown: originalDown, shouldDeferEvent: originalDefer };
    view._nativeTextSelection = native;
    setEditorSelectionGuard(true);
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(originalDefer).toHaveBeenCalledOnce();
    expect(pdfMove).not.toHaveBeenCalled();
    setEditorSelectionGuard(false);
    expect(view._nativeTextSelection).toBe(native);
    expect(native.handlePointerDown).toBe(originalDown);
    expect(native.shouldDeferEvent).toBe(originalDefer);
  });

  it("releases a drag on window blur or when its editor is removed", () => {
    setEditorSelectionGuard(true);
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new Event("blur"));
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(pdfMove).toHaveBeenCalledTimes(1);
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.remove();
    pdf.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(pdfMove).toHaveBeenCalledTimes(2);
  });
});
