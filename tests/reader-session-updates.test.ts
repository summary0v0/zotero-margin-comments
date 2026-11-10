import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarginAnnotation } from "../src/core/types";
import { ReaderSession } from "../src/zotero/reader-session";

describe("ReaderSession live annotation updates", () => {
  let session: ReaderSession;

  beforeEach(() => {
    vi.useFakeTimers();
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", { logError: vi.fn() });
  });

  afterEach(() => {
    session?.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function openReader(polling = false) {
    const viewer = document.createElement("div");
    viewer.id = "viewer";
    const page = document.createElement("div");
    viewer.append(page);
    document.body.append(viewer);
    Object.assign(window, {
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 16),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      PDFViewerApplication: {
        pdfViewer: {
          currentScale: 1,
          currentPageNumber: 1,
          getPageView: () => ({
            div: page,
            viewport: {
              width: 600,
              height: 800,
              convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
            },
          }),
        },
      },
    });
    const internalReader: any = {
      _state: { annotations: [], showAnnotations: true },
      _primaryView: { _iframeWindow: window, _iframeDocument: document },
      _updateState(state: Record<string, unknown>) {
        this._state = { ...this._state, ...state };
      },
    };
    if (polling) {
      // Cross-window wrappers can prevent replacing _updateState.
      Object.defineProperty(internalReader, "_updateState", { writable: false });
    }
    const annotations: MarginAnnotation[] = [];
    const store = {
      // AnnotationStore returns fresh models, not the backing Zotero items.
      list: () => annotations.map((annotation) => ({ ...annotation })),
      saveComment: vi.fn(async (itemID: number, value: string) => {
        annotations.find((annotation) => annotation.itemID === itemID)!.comment = value;
      }),
    };
    session = new ReaderSession(
      { itemID: 5, _internalReader: internalReader }, store as any, vi.fn(),
    );
    await session.start(true);
    expect(document.querySelector(".zmc-overlay-root")).toBeNull();
    const annotation: MarginAnnotation = {
      itemID: 21, key: "FIRST001", type: "highlight", comment: "首次评论",
      color: "#ffd400", pageLabel: "1", readOnly: false,
      position: { pageIndex: 0, rects: [[10, 700, 150, 720]] },
    };
    const nativeAnnotation = { id: annotation.key, comment: annotation.comment, _hidden: false };
    const card = () => document.querySelector<HTMLElement>(".zmc-card");
    return { annotations, annotation, nativeAnnotation, internalReader, card, store };
  }

  it("shows the first saved comment even before a visibility callback arrives", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader, card } = await openReader();
    annotations.push(annotation);
    // The item notifier can run after Reader state changes but before our
    // debounced visibility callback. Its refresh must use the current IDs.
    internalReader._state.annotations = [nativeAnnotation];
    await session.refresh();
    expect(card()).not.toBeNull();
    expect(card()!.classList.contains("zmc-filtered")).toBe(false);
    expect(document.querySelector(".zmc-line")).not.toBeNull();
  });

  it("loads newly saved comments on Reader changes without reopening the PDF", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader, card } = await openReader();
    annotations.push({ ...annotation, comment: "" });
    internalReader._updateState({ annotations: [{ ...nativeAnnotation, comment: "" }] });
    await vi.advanceTimersByTimeAsync(120);
    expect(card()).toBeNull();
    annotations[0] = annotation;
    internalReader._updateState({ annotations: [nativeAnnotation] });
    await vi.advanceTimersByTimeAsync(120);
    expect(card()?.querySelector(".zmc-card-preview")?.textContent).toBe("首次评论");
    expect(card()!.classList.contains("zmc-filtered")).toBe(false);

    // Subsequent in-place item edits and deletions must also be picked up.
    annotation.comment = "更新后的评论";
    internalReader._updateState({ annotations: [{ ...nativeAnnotation, comment: annotation.comment }] });
    await vi.advanceTimersByTimeAsync(120);
    expect(card()?.querySelector(".zmc-card-preview")?.textContent).toBe("更新后的评论");
    annotations.length = 0;
    internalReader._updateState({ annotations: [] });
    await vi.advanceTimersByTimeAsync(120);
    expect(document.querySelector(".zmc-overlay-root")).toBeNull();
  });

  it("rechecks annotations and visibility when enabled again", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader, card } = await openReader();
    session.setEnabled(false);
    annotations.push(annotation);
    internalReader._updateState({ annotations: [nativeAnnotation] });
    await vi.advanceTimersByTimeAsync(120);
    session.setEnabled(true);
    expect(card()?.querySelector(".zmc-card-preview")?.textContent).toBe("首次评论");
    expect(card()!.classList.contains("zmc-filtered")).toBe(false);
  });

  it("detects comment-only edits when state wrapping is unavailable", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader, card } = await openReader(true);
    annotations.push({ ...annotation, comment: "" });
    internalReader._state.annotations = [{ ...nativeAnnotation, comment: "" }];
    await session.refresh();
    await vi.advanceTimersByTimeAsync(400);
    expect(card()).toBeNull();
    annotations[0] = annotation;
    internalReader._state.annotations[0].comment = annotation.comment;
    await vi.advanceTimersByTimeAsync(400);
    expect(card()?.querySelector(".zmc-card-preview")?.textContent).toBe("首次评论");
    expect(card()!.classList.contains("zmc-filtered")).toBe(false);
  });

  it("keeps a local draft and applies pending external updates after editing", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader, card, store } = await openReader();
    annotations.push(annotation);
    internalReader._state.annotations = [nativeAnnotation];
    await session.refresh();
    card()!.querySelector<HTMLElement>(".zmc-card-preview")!.click();
    const editor = card()!.querySelector<HTMLElement>(".zmc-card-editor")!;
    editor.textContent = "未保存的本地草稿";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const second = { ...annotation, itemID: 22, key: "SECOND01", comment: "新增评论" };
    annotations.push(second);
    internalReader._updateState({ annotations: [nativeAnnotation, { id: second.key }] });
    await vi.advanceTimersByTimeAsync(120);
    expect(document.activeElement).toBe(editor);
    expect(editor.textContent).toBe("未保存的本地草稿");
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(1);
    editor.blur();
    await vi.advanceTimersByTimeAsync(120);
    expect(store.saveComment).toHaveBeenCalledWith(21, "未保存的本地草稿");
    expect(document.querySelectorAll(".zmc-card")).toHaveLength(2);
  });

  it("cancels scheduled updates on teardown", async () => {
    const { annotations, annotation, nativeAnnotation, internalReader } = await openReader();
    annotations.push(annotation);
    internalReader._updateState({ annotations: [nativeAnnotation] });
    session.destroy();
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector(".zmc-overlay-root")).toBeNull();
  });
});
