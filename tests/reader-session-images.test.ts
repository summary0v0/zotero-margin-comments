import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { MarginAnnotation } from "../src/core/types";
import { ImageAssets } from "../src/zotero/image-assets";
import { ReaderSession } from "../src/zotero/reader-session";

const reference = `margin-comments-assets/ABCD1234/${"a".repeat(64)}.png`;
const markdown = `![截图.png](${reference})`;

describe("ReaderSession image insertion", () => {
  let session: ReaderSession;
  let load: MockInstance<ImageAssets["load"]>;
  let saveImage: MockInstance<ImageAssets["importBytes"]>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", { logError: vi.fn() });
    load = vi.spyOn(ImageAssets.prototype, "load").mockResolvedValue("data:image/png;base64,test");
    saveImage = vi.spyOn(ImageAssets.prototype, "importBytes").mockResolvedValue({ reference, name: "截图.png" });
    vi.spyOn(ImageAssets.prototype, "cleanupUnused").mockResolvedValue({ deleted: [] });
  });

  afterEach(() => {
    session?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openReader(comment = "AB", readOnly = false) {
    const viewer = document.createElement("div");
    viewer.id = "viewer";
    const page = document.createElement("div");
    viewer.append(page);
    document.body.append(viewer);
    Object.assign(window, {
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16),
      cancelAnimationFrame: clearTimeout,
      PDFViewerApplication: { pdfViewer: {
        currentScale: 1, currentPageNumber: 1,
        getPageView: () => ({ div: page, viewport: {
          width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
        } }),
      } },
    });
    const annotation: MarginAnnotation = {
      itemID: 1, key: "NOTE0001", type: "highlight", comment, readOnly,
      color: "#ffd400", pageLabel: "1", position: { pageIndex: 0, rects: [[400, 700, 500, 720]] },
    };
    const store = {
      list: () => [{ ...annotation }],
      listAllComments: vi.fn(() => [annotation.comment]),
      saveComment: vi.fn(async (_: number, value: string) => { annotation.comment = value; }),
    };
    session = new ReaderSession({ itemID: 5, _internalReader: {
      _state: { annotations: [{ id: annotation.key }], showAnnotations: true },
      _primaryView: { _iframeWindow: window, _iframeDocument: document },
    } }, store as any, vi.fn());
    await session.start(true);
    const card = document.querySelector<HTMLElement>(".zmc-card")!;
    card.querySelector<HTMLElement>(".zmc-card-preview")!.click();
    const editor = card.querySelector<HTMLElement>(".zmc-card-editor")!;
    const caret = (offset = 1) => {
      const range = document.createRange();
      range.setStart(editor.firstChild!, offset);
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    const paste = (image = true) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: image ? [{
        kind: "file", type: "image/png", getAsFile: () => ({
          name: "截图.png", arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        }),
      }] : [] } });
      editor.dispatchEvent(event);
      return event;
    };
    return { card, editor, caret, paste, annotation, store };
  }

  it("pastes at the captured caret, previews and saves only the relative reference", async () => {
    const { card, editor, caret, paste, annotation, store } = await openReader();
    caret();
    expect(paste().defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(720);
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe(`A\n${markdown}\nB`);
    expect(annotation.comment).toBe(`A\n${markdown}\nB`);
    expect(store.saveComment).toHaveBeenCalled();
    expect(annotation.comment).not.toContain("base64");
    expect(card.querySelector(".zmc-editor-images img")).not.toBeNull();
    const image = card.querySelector<HTMLImageElement>(".zmc-card-preview img")!;
    image.dispatchEvent(new Event("load"));
    image.click();
    expect(document.querySelector(".zmc-image-lightbox img")?.getAttribute("src")).toBe(image.src);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".zmc-image-lightbox")).toBeNull();
    editor.blur();
    session.setEnabled(false);
    session.setEnabled(true);
    await vi.advanceTimersByTimeAsync(30);
    expect(document.querySelector(".zmc-card-preview img")).not.toBeNull();
  });

  it("ignores late insertion after Escape and keeps the original text", async () => {
    let complete!: (value: any) => void;
    saveImage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { editor, caret, paste, annotation } = await openReader();
    caret();
    paste();
    await vi.advanceTimersByTimeAsync(1);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    complete({ reference, name: "截图.png" });
    await vi.advanceTimersByTimeAsync(800);
    expect(editor.textContent).toBe("AB");
    expect(annotation.comment).toBe("AB");
    expect(document.querySelector(".zmc-inline-image")).toBeNull();
  });

  it("finishes a blurred paste without stealing focus from another control", async () => {
    let complete!: (value: any) => void;
    saveImage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { editor, caret, paste, annotation } = await openReader();
    caret();
    paste();
    await vi.advanceTimersByTimeAsync(1);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    complete({ reference, name: "截图.png" });
    await vi.advanceTimersByTimeAsync(50);
    expect(annotation.comment).toContain(markdown);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("preserves text and reports save failure without inserting a broken reference", async () => {
    saveImage.mockRejectedValueOnce(new Error("目录不可写"));
    const { editor, caret, paste, annotation, card } = await openReader();
    caret();
    paste();
    await vi.advanceTimersByTimeAsync(30);
    expect(editor.textContent).toBe("AB");
    expect(annotation.comment).toBe("AB");
    expect(card.querySelector(".zmc-save-state")?.textContent).toContain("目录不可写");
  });

  it("keeps text paste native and prevents image writes for read-only cards", async () => {
    const { paste } = await openReader("只读", true);
    expect(paste(false).defaultPrevented).toBe(false);
    paste();
    await vi.advanceTimersByTimeAsync(20);
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("shows missing images without changing their source references", async () => {
    load.mockRejectedValue(new Error("图片文件缺失"));
    const { editor, annotation, card } = await openReader(markdown);
    await vi.advanceTimersByTimeAsync(30);
    expect(card.querySelector(".zmc-image-missing")?.textContent).toContain("图片文件缺失");
    expect(editor.textContent).toBe(markdown);
    expect(annotation.comment).toBe(markdown);
  });

  it("uses the file selection entry point and inserts the same kind of reference", async () => {
    const picker = vi.spyOn(ImageAssets.prototype, "pickFile").mockResolvedValue("C:\\图.png");
    const file = vi.spyOn(ImageAssets.prototype, "importFile").mockResolvedValue({ reference, name: "图.png" });
    const { editor, caret, card, annotation } = await openReader();
    caret();
    card.querySelector<HTMLButtonElement>(".zmc-insert-image")!.click();
    await vi.advanceTimersByTimeAsync(720);
    expect(picker).toHaveBeenCalled();
    expect(file).toHaveBeenCalledWith("C:\\图.png");
    expect(editor.textContent).toContain(`![图.png](${reference})`);
    expect(annotation.comment).toContain(reference);
  });

  it("keeps the source editor open when keyboard focus moves to Insert Image", async () => {
    const { editor, card } = await openReader();
    const button = card.querySelector<HTMLButtonElement>(".zmc-insert-image")!;
    button.focus();
    await vi.advanceTimersByTimeAsync(20);
    expect(card.classList.contains("zmc-editing")).toBe(true);
    expect(editor.classList.contains("zmc-editor-hidden")).toBe(false);
  });

  it("requests cleanup once on opening, not on refresh, filters or hide/show", async () => {
    const { editor, store } = await openReader();
    expect(ImageAssets.prototype.cleanupUnused).toHaveBeenCalledTimes(1);
    const readAll = vi.mocked(ImageAssets.prototype.cleanupUnused).mock.calls[0][0];
    expect(readAll()).toEqual(["AB"]);
    expect(store.listAllComments).toHaveBeenCalled();
    editor.blur();
    await vi.advanceTimersByTimeAsync(30);
    await session.refresh();
    session.setVisibleTypes(new Set(["note"]));
    session.setVisibleTypes(new Set(["highlight"]));
    session.setEnabled(false);
    session.setEnabled(true);
    expect(ImageAssets.prototype.cleanupUnused).toHaveBeenCalledTimes(1);
  });

  it("does not insert a late result after the session is destroyed", async () => {
    let complete!: (value: any) => void;
    saveImage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { caret, paste, annotation, store } = await openReader();
    caret(); paste();
    await vi.advanceTimersByTimeAsync(1);
    session.destroy();
    complete({ reference, name: "截图.png" });
    await vi.advanceTimersByTimeAsync(800);
    expect(annotation.comment).toBe("AB");
    expect(store.saveComment).not.toHaveBeenCalled();
    expect(document.querySelector(".zmc-card")).toBeNull();
  });
});
