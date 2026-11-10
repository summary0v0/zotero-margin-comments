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

  async function setup(fraction = 0.25, deferred = false) {
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
    Object.assign(window, {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      PDFViewerApplication: {
        pdfViewer: { currentScale: 1, getPageView: () => ({ div: page, viewport }) },
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
    const store = { list: () => annotations, saveComment: vi.fn(async () => undefined) };
    const reader = { itemID: 1, _internalReader: { _primaryView: { _iframeWindow: window, _iframeDocument: document } } };
    session = new ReaderSession(reader, store as any, vi.fn());
    await session.start(true);
    if (!deferred) await vi.advanceTimersByTimeAsync(30);
    const column = () => document.querySelector<HTMLElement>(".zmc-margin-column-right")!;
    const preview = () => column().querySelector<HTMLElement>(".zmc-card-preview")!;
    const editor = () => column().querySelector<HTMLElement>(".zmc-card-editor")!;
    return { column, preview, editor, viewer, resolve: () => resolve(profile), callbacks, viewport, detection, store };
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
    const { callbacks, viewport, column, detection } = await setup();
    viewport.width = 1600;
    callbacks.get("scalechanging")!();
    await vi.advanceTimersByTimeAsync(90);
    expect(detection).toHaveBeenCalledTimes(1);
    expect(column().style.width).toBe("360px");
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
});
