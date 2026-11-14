import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderSession } from "../src/zotero/reader-session";
import { Zotero9ReaderAdapter } from "../src/zotero/reader-adapter";
import type { PageWhitespace } from "../src/core/page-whitespace";
import type { MarginAnnotation } from "../src/core/types";

describe("ReaderSession whitespace integration", () => {
  let session: ReaderSession;
  afterEach(() => {
    session?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup(fraction = 0.25, deferred = false, count = 1) {
    vi.useFakeTimers();
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.stubGlobal("Zotero", { logError: vi.fn() });
    const viewer = document.createElement("div");
    viewer.id = "viewer";
    const page = document.createElement("div");
    viewer.append(page);
    document.body.append(viewer);
    const viewport = {
      width: 1000, height: 1000, rotation: 0,
      convertToViewportPoint: (x: number, y: number): [number, number] => [x, 1000 - y],
    };
    const callbacks = new Map<string, () => void>();
    const pdfViewer = { currentScale: 1, getPageView: () => ({ div: page, viewport }) };
    viewport.convertToViewportPoint = (x, y) => [x * pdfViewer.currentScale, (1000 - y) * pdfViewer.currentScale];
    Object.assign(window, {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      PDFViewerApplication: {
        pdfViewer,
        eventBus: { on: (name: string, cb: () => void) => callbacks.set(name, cb), off: vi.fn() },
      },
    });
    const profile: PageWhitespace = { rows: [{ top: 0, bottom: 1, left: fraction, right: fraction }] };
    let resolve!: (profile: PageWhitespace) => void;
    const detection = vi.spyOn(Zotero9ReaderAdapter.prototype, "pageWhitespace")
      .mockImplementation(() => deferred ? new Promise((r) => { resolve = r; }) : Promise.resolve(profile));
    const annotations: MarginAnnotation[] = [{
      itemID: 1, key: "RIGHT001", type: "highlight", comment: "原始批注", color: "#ffd400",
      pageLabel: "1", position: { pageIndex: 0, rects: [[600, 700, 720, 720]] }, readOnly: false,
    }];
    for (let i = 1; i < count; i++) {
      annotations.push({ ...annotations[0], itemID: i + 1, key: `RIGHT${String(i + 1).padStart(3, "0")}` });
    }
    const store = { list: () => annotations, saveComment: vi.fn(async () => undefined) };
    const reader = { itemID: 1, _internalReader: { _primaryView: { _iframeWindow: window, _iframeDocument: document } } };
    session = new ReaderSession(reader, store as any, vi.fn());
    await session.start(true);
    if (!deferred) await vi.advanceTimersByTimeAsync(30);
    const column = () => document.querySelector<HTMLElement>(".zmc-margin-column-right")!;
    const preview = () => column().querySelector<HTMLElement>(".zmc-card-preview")!;
    const editor = () => column().querySelector<HTMLElement>(".zmc-card-editor")!;
    return { column, preview, editor, viewer, resolve: () => resolve(profile), callbacks, viewport, pdfViewer, detection, store };
  }

  it("uses paper whitespace while allowing full-width cards to overhang", async () => {
    const { column, viewer } = await setup();
    expect(column().dataset.placement).toBe("overhang");
    expect(column().style.left).toBe("760px");
    expect(column().style.width).toBe("360px");
    expect(viewer.style.getPropertyValue("--zmc-gutter-width")).toBe("120px");
    expect(document.querySelector(".zmc-line-layer")!.getAttribute("width")).toBe("1120");
    expect(document.querySelector<HTMLElement>(".zmc-margin-column-left")!.hidden).toBe(true);
    const points = document.querySelector(".zmc-line")!.getAttribute("points")!;
    expect(points.split(" ").at(-1)!.split(",")[0]).toBe("760");
    session.setEnabled(false);
    expect(viewer.style.getPropertyValue("--zmc-gutter-width")).toBe("");
  });

  it("keeps a narrow-margin card readable and stable when entering/leaving editing", async () => {
    const { column, preview, editor, viewer } = await setup(0.1);
    expect(column().dataset.placement).toBe("overhang");
    expect(column().style.width).toBe("360px");
    expect(column().style.left).toBe("910px");
    preview().click();
    expect(column().dataset.placement).toBe("overhang");
    expect(column().style.width).toBe("360px");
    expect(viewer.style.getPropertyValue("--zmc-gutter-width")).toBe("270px");
    expect(document.activeElement).toBe(editor());
    editor().blur();
    await vi.advanceTimersByTimeAsync(30);
    expect(column().dataset.placement).toBe("overhang");
    expect(column().style.left).toBe("910px");
  });

  it("does not interrupt a local draft when background analysis finishes", async () => {
    const { column, preview, editor, resolve, store } = await setup(0.25, true);
    expect(column().dataset.placement).toBe("outside");
    preview().click();
    const input = editor();
    input.textContent = "检测期间输入的草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    resolve();
    await vi.advanceTimersByTimeAsync(40);
    expect(document.activeElement).toBe(input);
    expect(input.textContent).toBe("检测期间输入的草稿");
    expect(column().dataset.placement).toBe("outside");
    input.blur();
    await vi.advanceTimersByTimeAsync(40);
    expect(store.saveComment).toHaveBeenCalledWith(1, "检测期间输入的草稿");
    expect(column().dataset.placement).toBe("overhang");
  });

  it("reuses a profile on zoom and requests a fresh orientation on rotation", async () => {
    const { callbacks, viewport, pdfViewer, column, detection } = await setup();
    pdfViewer.currentScale = 1.6;
    viewport.width = 1600;
    viewport.height = 1600;
    callbacks.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(detection).toHaveBeenCalledTimes(1);
    expect(column().style.width).toBe("360px");
    expect(column().style.left).toBe("760px");
    expect(document.querySelector<HTMLElement>(".zmc-page-overlay")!.style.transform).toBe("scale(1.6, 1.6)");
    viewport.rotation = 90;
    callbacks.get("rotationchanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(detection).toHaveBeenCalledTimes(2);
  });

  it("updates the configured width without losing the draft, editor or focus", async () => {
    const { preview, editor, column, store } = await setup();
    preview().click();
    const input = editor();
    input.textContent = "调整宽度期间的草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    session.setCardWidth(480);
    expect(column().style.width).toBe("480px");
    expect(editor()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.textContent).toBe("调整宽度期间的草稿");
    input.blur();
    await vi.advanceTimersByTimeAsync(30);
    expect(store.saveComment).toHaveBeenCalledWith(1, "调整宽度期间的草稿");
  });

  it("preserves normalized layout, content, overflow and an active draft across PDF zoom", async () => {
    const { callbacks, viewport, pdfViewer, column, preview, editor, viewer } = await setup();
    const overlay = document.querySelector<HTMLElement>(".zmc-page-overlay")!;
    const card = column().querySelector<HTMLElement>(".zmc-card")!;
    const before = { top: card.style.top, left: column().style.left, html: preview().innerHTML };
    for (const scale of [0.5, 2, 1]) {
      pdfViewer.currentScale = scale;
      viewport.width = viewport.height = 1000 * scale;
      callbacks.get("scalechanging")!();
      await vi.advanceTimersByTimeAsync(90);
      expect(overlay.style.transform).toBe(`scale(${scale}, ${scale})`);
      expect(overlay.style.width).toBe("1000px");
      expect(card.style.top).toBe(before.top);
      expect(column().style.left).toBe(before.left);
      expect(preview().innerHTML).toBe(before.html);
      expect(viewer.style.getPropertyValue("--zmc-gutter-width")).toBe(`${120 * scale}px`);
      expect(overlay.classList.contains("zmc-low-zoom")).toBe(false);
    }
    preview().click();
    const input = editor();
    input.textContent = "缩放时未保存的草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const range = document.createRange();
    range.setStart(input.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    pdfViewer.currentScale = 0.5;
    viewport.width = viewport.height = 500;
    callbacks.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(overlay.style.transform).toBe("scale(0.5, 0.5)");
    expect(document.activeElement).toBe(input);
    expect(input.textContent).toBe("缩放时未保存的草稿");
    expect(window.getSelection()!.anchorOffset).toBe(3);
    expect(editor()).toBe(input);
    expect(card.classList.contains("zmc-overflow-hidden")).toBe(false);
  });

  it("keeps dense-card folding and the expanded scroll position stable across zoom", async () => {
    const { callbacks, viewport, pdfViewer, column } = await setup(0.25, false, 20);
    const toggle = column().querySelector<HTMLButtonElement>(".zmc-margin-toggle")!;
    const hiddenCount = column().querySelectorAll(".zmc-overflow-hidden").length;
    expect(hiddenCount).toBeGreaterThan(0);
    for (const scale of [0.5, 2, 1]) {
      pdfViewer.currentScale = scale;
      viewport.width = viewport.height = 1000 * scale;
      callbacks.get("scalechanging")!();
      await vi.advanceTimersByTimeAsync(90);
      expect(column().querySelectorAll(".zmc-overflow-hidden")).toHaveLength(hiddenCount);
      expect(toggle.hidden).toBe(false);
    }
    toggle.click();
    const scrollport = column().querySelector<HTMLElement>(".zmc-margin-scrollport")!;
    scrollport.scrollTop = 120;
    const tops = [...column().querySelectorAll(".zmc-card")].map((card) => (card as HTMLElement).style.top);
    pdfViewer.currentScale = 0.5;
    viewport.width = viewport.height = 500;
    callbacks.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(scrollport.scrollTop).toBe(120);
    expect(column().classList.contains("zmc-margin-expanded")).toBe(true);
    expect([...column().querySelectorAll(".zmc-card")].map((card) => (card as HTMLElement).style.top)).toEqual(tops);
    expect(column().querySelectorAll(".zmc-overflow-hidden")).toHaveLength(0);
  });

  it("applies font changes without losing the editor, draft or selection", async () => {
    const { preview, editor, column, viewport, pdfViewer, callbacks, store } = await setup();
    preview().click();
    const input = editor();
    input.textContent = "调整字号时的草稿与选区";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, 2);
    range.setEnd(input.firstChild!, 5);
    selection.removeAllRanges();
    selection.addRange(range);
    session.setFontSize(18.5);
    const overlay = column().closest<HTMLElement>(".zmc-page-overlay")!;
    expect(overlay.style.getPropertyValue("--zmc-font-size")).toBe("18.5px");
    expect(editor()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(selection.anchorOffset).toBe(2);
    expect(selection.getRangeAt(0).endOffset).toBe(5);
    expect(input.textContent).toBe("调整字号时的草稿与选区");
    pdfViewer.currentScale = 0.5;
    viewport.width = viewport.height = 500;
    callbacks.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(overlay.style.getPropertyValue("--zmc-font-size")).toBe("18.5px");
    expect(overlay.style.transform).toBe("scale(0.5, 0.5)");
    input.blur();
    await vi.advanceTimersByTimeAsync(30);
    expect(store.saveComment).toHaveBeenCalledWith(1, "调整字号时的草稿与选区");
    session.setEnabled(false);
    session.setEnabled(true);
    expect(column().closest<HTMLElement>(".zmc-page-overlay")!.style.getPropertyValue("--zmc-font-size")).toBe("18.5px");
  });
});
