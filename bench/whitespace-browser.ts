/** Actual ReaderSession + PDF.js canvas integration, hosted by verify-whitespace-browser.mjs. */
import { ReaderSession } from "../src/zotero/reader-session";
import type { MarginAnnotation } from "../src/core/types";

declare global {
  interface Window { pdfjsLib: any; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const pdfjs = window.pdfjsLib;
  const task = pdfjs.getDocument({ url: "/source.pdf" });
  const pdf = await task.promise;
  const sourcePage = await pdf.getPage(2);
  const viewer = document.getElementById("viewer")!;
  const page = document.createElement("div");
  page.className = "page";
  const canvas = document.createElement("canvas");
  page.append(canvas);
  viewer.append(page);
  let zoom = 2;
  let rotation = 0;
  let viewport: any;
  let analysisRenders = 0;
  const wrappedPage = {
    getViewport: (options: any) => sourcePage.getViewport(options),
    getTextContent: () => sourcePage.getTextContent(),
    render: (options: any) => { analysisRenders++; return sourcePage.render(options); },
  };
  async function draw() {
    viewport = sourcePage.getViewport({ scale: zoom * 96 / 72, rotation });
    page.style.width = `${viewport.width}px`;
    page.style.height = `${viewport.height}px`;
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await sourcePage.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: 0 }).promise;
  }
  await draw();
  const callbacks = new Map<string, () => void>();
  const annotations: MarginAnnotation[] = [{
    itemID: 1, key: "ABSTRACT", type: "highlight", color: "#ffd400", pageLabel: "2", readOnly: false,
    position: { pageIndex: 1, rects: [[205, 585, 470, 599]] },
    comment: "| 术语 | 含义 |\n| --- | --- |\n| Pre-trained（预训练） | 模型已经经过预训练，具有一定的知识和特征提取能力 |\n| Frozen（冻结） | 训练当前任务时冻结模型参数，不更新权重 |\n| Fine-tuned（微调） | 在预训练模型基础上，使用特定任务的数据继续训练 |\n| Training from Scratch（从头训练） | 从随机初始化开始训练，不使用预训练权重 |\n\n$$P=\\frac{N_{matched}}{N_{pred}}\\cdot\\overline{\\operatorname{sim}}$$",
  }];
  const store = {
    list: () => annotations,
    saveComment: async (_id: number, text: string) => { annotations[0].comment = text; },
  };
  Object.assign(window, {
    Zotero: { logError: (e: unknown) => console.error(e) },
    PDFViewerApplication: {
      eventBus: { on: (name: string, callback: () => void) => callbacks.set(name, callback), off: () => {} },
      pdfViewer: {
        get currentScale() { return zoom; }, currentPageNumber: 2,
        getPageView: (index: number) => index === 1 ? { div: page, viewport, pdfPage: wrappedPage } : undefined,
      },
    },
  });
  const reader = {
    itemID: 1,
    _internalReader: {
      _state: { annotations: [{ id: "ABSTRACT" }], showAnnotations: true },
      _primaryView: { _iframeWindow: window, _iframeDocument: document },
    },
  };
  const session = new ReaderSession(reader, store as any, () => {});
  session.setCollapseNotes(false);
  await session.start(true);
  let stage = "initial";
  async function until(predicate: () => boolean) {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error(`Whitespace integration timed out: ${stage}, mode ${column().dataset.placement}, active ${document.activeElement?.className}`);
      await sleep(40);
    }
  }
  const column = () => document.querySelector<HTMLElement>(".zmc-margin-column-right")!;
  const card = () => document.querySelector<HTMLElement>(".zmc-card")!;
  const checks: Record<string, unknown>[] = [];
  let expectedWidth = 360;
  function check(name: string) {
    const p = page.getBoundingClientRect(), c = card().getBoundingClientRect();
    const mode = card().closest<HTMLElement>(".zmc-margin-column")!.dataset.placement;
    let ink = 0;
    const configured = card().closest<HTMLElement>(".zmc-margin-column")!.getBoundingClientRect().width;
    const scaledWidth = expectedWidth * zoom;
    if (Math.abs(configured - scaledWidth) > 1 || c.width < scaledWidth - 16 || c.width > scaledWidth + 1) {
      throw new Error(`${name}: configured reading width was not preserved (${c.width}px)`);
    }
    {
      const sx = canvas.width / p.width, sy = canvas.height / p.height;
      const x = Math.max(0, Math.floor((c.left - p.left) * sx));
      const y = Math.max(0, Math.floor((c.top - p.top) * sy));
      const width = Math.min(canvas.width - x, Math.ceil((c.right - p.left) * sx) - x);
      const height = Math.min(canvas.height - y, Math.ceil((c.bottom - p.top) * sy) - y);
      const data = width > 0 && height > 0
        ? canvas.getContext("2d")!.getImageData(x, y, width, height).data : [];
      for (let i = 0; i < data.length; i += 4) if (Math.min(data[i], data[i + 1], data[i + 2]) < 245) ink++;
      if (ink) throw new Error(`${name}: ${ink} original content pixels covered`);
    }
    checks.push({ name, zoom, rotation, mode, width: c.width, originalInkCovered: ink, analysisRenders });
  }
  await until(() => column().dataset.placement === "overhang");
  check("table-and-math");
  zoom = 1;
  await draw(); callbacks.get("scalechanging")!();
  await sleep(150);
  check("full-width-overhang");
  if (column().dataset.placement !== "overhang") throw new Error("Card did not use both paper margin and outside space");
  const original = annotations[0].comment;
  card().querySelector<HTMLElement>(".zmc-card-preview")!.click();
  const longEditor = card().querySelector<HTMLElement>(".zmc-card-editor")!;
  longEditor.textContent = "长笔记需要自然增长并通过页边栏滚动，保持正文可读。".repeat(160);
  longEditor.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
  check("long-editor");
  if (getComputedStyle(longEditor).maxHeight !== "none") throw new Error("Long editor was capped");
  longEditor.textContent = original;
  longEditor.dispatchEvent(new Event("input", { bubbles: true }));
  longEditor.blur();
  await sleep(80);
  zoom = .5;
  await draw(); callbacks.get("scalechanging")!();
  stage = "small-zoom";
  await sleep(150);
  check("small-zoom-full-width");
  card().querySelector<HTMLElement>(".zmc-card-preview")!.click();
  const editor = card().querySelector<HTMLElement>(".zmc-card-editor")!;
  if (document.activeElement !== editor) throw new Error("Editor did not retain focus");
  editor.blur();
  await sleep(80);
  if (analysisRenders !== 1) throw new Error("Zoom re-rendered the analysis");
  check("full-width-after-edit");
  session.setCardWidth(480);
  expectedWidth = 480;
  check("custom-width");
  session.setCardWidth(360);
  expectedWidth = 360;
  zoom = 2; rotation = 90;
  stage = "rotation";
  await draw(); callbacks.get("rotationchanging")!();
  await until(() => analysisRenders === 2);
  await sleep(500);
  check("rotated");
  rotation = 0; zoom = 1;
  stage = "restored";
  await draw(); callbacks.get("rotationchanging")!();
  await until(() => column().dataset.placement === "overhang");
  await sleep(150);
  if (analysisRenders !== 2) throw new Error("Orientation cache was not reused");
  check("restored");
  const container = document.getElementById("viewerContainer")!;
  if (container.scrollWidth > container.clientWidth + 1) throw new Error("Readable cards were unnecessarily clipped by horizontal overflow");
  const rect = annotations[0].position.rects![0];
  const p1 = viewport.convertToViewportPoint(rect[0], rect[3]);
  const p2 = viewport.convertToViewportPoint(rect[2], rect[1]);
  const highlight = document.createElement("div");
  highlight.className = "sample-highlight";
  Object.assign(highlight.style, { left: `${p1[0]}px`, top: `${p1[1]}px`, width: `${p2[0]-p1[0]}px`, height: `${p2[1]-p1[1]}px` });
  page.append(highlight);
  document.documentElement.dataset.qa = "passed";
  document.getElementById("status")!.textContent = "0.11.0 · 批注随 PDF 等比缩放，保持相对布局";
  document.getElementById("report")!.textContent = JSON.stringify({ passed: true, checks });
}

main().catch((error) => {
  document.documentElement.dataset.qa = "failed";
  document.getElementById("status")!.textContent = String(error);
  document.getElementById("report")!.textContent = JSON.stringify({ passed: false, error: String(error) });
  console.error(error);
});
