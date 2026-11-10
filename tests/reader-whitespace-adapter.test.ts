import { afterEach, describe, expect, it, vi } from "vitest";
import { Zotero9ReaderAdapter } from "../src/zotero/reader-adapter";
import { createContext, runInContext } from "node:vm";

describe("clean PDF whitespace analysis", () => {
  let adapter: Zotero9ReaderAdapter;
  afterEach(() => { adapter?.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function setup(render?: (options: any) => any) {
    vi.stubGlobal("Zotero", { logError: vi.fn() });
    const context = {
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        width, height, data: new Uint8ClampedArray(width * height * 4).fill(255),
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as any);
    const pdfPage = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale, height: 200 * scale, scale, transform: [scale, 0, 0, -scale, 0, 200 * scale],
      }),
      getTextContent: vi.fn(async () => ({ items: [], styles: {} })),
      render: vi.fn(render ?? ((_options: any) => ({ promise: Promise.resolve(), cancel: vi.fn() }))),
    };
    adapter = new Zotero9ReaderAdapter({});
    const pdfViewer = { getPageView: () => ({ pdfPage }) };
    const readerWindow: any = { PDFViewerApplication: { pdfViewer } };
    const evaluate = (source: string) => new Function("window", "document", `return ${source}`)(readerWindow, document);
    Object.assign(adapter, { pdfViewer, pdfDocument: document, pdfWindow: { eval: evaluate } });
    const handle = {
      pageIndex: 0, element: document.createElement("div"), scale: 1,
      viewport: { width: 600, height: 800, rotation: 0, convertToViewportPoint: (x: number, y: number): [number, number] => [x, y] },
    };
    return { pdfPage, handle, context };
  }

  it("renders without annotations, caches zooms and separates rotations", async () => {
    const { pdfPage, handle } = setup();
    const first = adapter.pageWhitespace(handle);
    expect(adapter.pageWhitespace({ ...handle, scale: 2 })).toBe(first);
    expect(await first).toBeDefined();
    expect(pdfPage.render).toHaveBeenCalledTimes(1);
    expect(pdfPage.render.mock.calls[0][0]).toMatchObject({ annotationMode: 0, background: "rgb(255,255,255)" });
    expect(document.querySelector("canvas")).toBeNull();
    await adapter.pageWhitespace({ ...handle, viewport: { ...handle.viewport, rotation: 90 } });
    expect(pdfPage.render).toHaveBeenCalledTimes(2);
  });

  it("serializes page scans and cancels the active render on close", async () => {
    let release!: () => void;
    const cancel = vi.fn();
    const { pdfPage, handle } = setup(() => ({ promise: new Promise<void>((r) => { release = r; }), cancel }));
    const first = adapter.pageWhitespace(handle);
    const second = adapter.pageWhitespace({ ...handle, pageIndex: 1 });
    await Promise.resolve();
    expect(pdfPage.render).toHaveBeenCalledTimes(1);
    adapter.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(pdfPage.render).toHaveBeenCalledTimes(1);
  });

  it("keeps failures contained so the session can use its safe fallback", async () => {
    const { handle } = setup(() => ({ promise: Promise.reject(new Error("Unavailable page")), cancel: vi.fn() }));
    expect(await adapter.pageWhitespace(handle)).toBeUndefined();
    expect((Zotero as any).logError).toHaveBeenCalledOnce();
  });

  it("constructs PDF.js options in the iframe realm rather than the addon realm", async () => {
    const { handle } = setup();
    const readerWindow: any = {};
    const realm = createContext({ window: readerWindow, document });
    runInContext(`window.PDFViewerApplication = { pdfViewer: { getPageView() { return { pdfPage: {
      getViewport(options) {
        if (Object.getPrototypeOf(options) !== Object.prototype) throw new Error("Privileged options rejected");
        return { width: 100 * options.scale, height: 100 * options.scale, scale: options.scale, transform: [1,0,0,-1,0,100] };
      },
      render(options) {
        if (Object.getPrototypeOf(options) !== Object.prototype) throw new Error("Privileged render options rejected");
        return { promise: Promise.resolve(), cancel() {} };
      },
      getTextContent() { return Promise.resolve({ items: [], styles: {} }); }
    } }; } } };`, realm);
    expect(() => readerWindow.PDFViewerApplication.pdfViewer.getPageView().pdfPage.getViewport({ scale: 1 }))
      .toThrow("Privileged options rejected");
    Object.assign(adapter, { pdfWindow: { eval: (source: string) => runInContext(source, realm) } });
    expect((await adapter.pageWhitespace(handle))?.rows.length).toBeGreaterThan(0);
    expect((Zotero as any).logError).not.toHaveBeenCalled();
  });

  it("can retry a page after a transient render failure", async () => {
    const { handle, pdfPage } = setup();
    pdfPage.render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("Page reset")), cancel: vi.fn() }));
    expect(await adapter.pageWhitespace(handle)).toBeUndefined();
    expect(await adapter.pageWhitespace(handle)).toBeDefined();
    expect(pdfPage.render).toHaveBeenCalledTimes(2);
  });
});
