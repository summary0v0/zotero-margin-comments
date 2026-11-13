import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarginAnnotation } from "../src/core/types";
import { ReaderSession } from "../src/zotero/reader-session";

describe("ReaderSession automatic margin sides", () => {
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

  const highlight = (key: string, y: number, left = 60, right = 540): MarginAnnotation => ({
    itemID: y, key, type: "highlight", comment: `评论 ${key}`, color: "#ffd400",
    pageLabel: "1", readOnly: false,
    position: { pageIndex: 0, rects: [[left, y, right, y + 12]] },
  });

  async function openReader(annotations: MarginAnnotation[]) {
    const viewer = document.createElement("div");
    viewer.id = "viewer";
    const page = document.createElement("div");
    viewer.append(page);
    document.body.append(viewer);
    let scale = 1;
    const viewport = {
      width: 600, height: 800, rotation: 0,
      convertToViewportPoint: (x: number, y: number): [number, number] => {
        if (viewport.rotation === 90) return [y * scale, x * scale];
        return [x * scale, (800 - y) * scale];
      },
    };
    const pdfViewer = {
      currentScale: 1, currentPageNumber: 1,
      getPageView: () => ({ div: page, viewport }),
    };
    Object.assign(window, {
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      PDFViewerApplication: { pdfViewer },
    });
    const internalReader: any = {
      _state: { annotations: annotations.map((a) => ({ id: a.key })), showAnnotations: true },
      _primaryView: { _iframeWindow: window, _iframeDocument: document },
      _updateState(state: Record<string, unknown>) { this._state = { ...this._state, ...state }; },
    };
    session = new ReaderSession({ itemID: 5, _internalReader: internalReader }, {
      list: () => annotations.map((a) => ({ ...a })), saveComment: vi.fn(),
    } as any, vi.fn());
    await session.start(true);
    const sides = () => {
      const result = new Map<string, "left" | "right">();
      document.querySelectorAll<HTMLElement>(".zmc-card").forEach((card) => {
        result.set(card.dataset.annotationKey!, card.classList.contains("zmc-card-left") ? "left" : "right");
      });
      return result;
    };
    return {
      sides, internalReader,
      transform: (nextScale: number, rotation = 0) => {
        scale = nextScale;
        viewport.rotation = rotation;
        viewport.width = (rotation === 90 ? 800 : 600) * scale;
        viewport.height = (rotation === 90 ? 600 : 800) * scale;
        pdfViewer.currentScale = scale;
      },
    };
  }

  it("distributes symmetric and slightly offset full-line/multiline highlights", async () => {
    const annotations = Array.from({ length: 6 }, (_, i) => highlight(`N${i}`, 700 - i * 70, 66, 546));
    annotations[1].type = "underline";
    annotations[2].position.rects!.push([60, 540, 300, 552]);
    const { sides } = await openReader(annotations);
    expect([...sides().values()].filter((side) => side === "left")).toHaveLength(3);
    expect([...sides().values()].filter((side) => side === "right")).toHaveLength(3);
    expect(document.querySelectorAll(".zmc-line")).toHaveLength(6);
  });

  it("preserves definite columns and uses their counts to place centred text", async () => {
    const { sides } = await openReader([
      highlight("CENTER", 700),
      highlight("RIGHT1", 600, 330, 540),
      highlight("RIGHT2", 500, 350, 550),
      highlight("LEFT", 400, 50, 270),
    ]);
    expect(sides()).toEqual(new Map([
      ["CENTER", "left"], ["RIGHT1", "right"], ["RIGHT2", "right"], ["LEFT", "left"],
    ]));
  });

  it("prefers the right margin for the first long centred selection, regardless of comment length", async () => {
    const annotations = [highlight("LONG", 700), highlight("NEXT", 600)];
    annotations[0].comment = "短评";
    annotations[1].comment = "这是很长的评论。".repeat(80);
    annotations[1].type = "underline";
    const { sides } = await openReader(annotations);
    expect(sides().get("LONG")).toBe("right");
    expect(sides().get("NEXT")).toBe("left");
  });

  it("uses the 30 percent selection width threshold rather than the old 40 percent", async () => {
    const { sides } = await openReader([
      highlight("AT30", 700, 209, 389),
      highlight("BELOW30", 600, 209.5, 388.5),
    ]);
    expect(sides().get("AT30")).toBe("right");
    expect(sides().get("BELOW30")).toBe("left");
  });

  it("retains sides through zoom, edits, insertions, filtering and hide/show", async () => {
    const annotations = [highlight("A", 650), highlight("B", 550)];
    const { sides, transform, internalReader } = await openReader(annotations);
    const original = sides();
    transform(0.5);
    annotations[0].comment = "编辑后的长评论\n第二行";
    await session.refresh();
    expect(sides()).toEqual(original);
    const added = highlight("NEW", 750);
    annotations.unshift(added);
    internalReader._state.annotations.push({ id: added.key });
    await session.refresh();
    for (const [key, side] of original) expect(sides().get(key)).toBe(side);
    session.setVisibleTypes(new Set(["note"]));
    expect(sides().size).toBe(0);
    session.setVisibleTypes(new Set(["highlight"]));
    for (const [key, side] of original) expect(sides().get(key)).toBe(side);
    session.setEnabled(false);
    session.setEnabled(true);
    for (const [key, side] of original) expect(sides().get(key)).toBe(side);
    const beforeRotation = sides();
    transform(1, 90);
    await session.refresh();
    transform(2);
    await session.refresh();
    expect(sides()).toEqual(beforeRotation);
  });

  it("recomputes the side when the selection itself moves to the other column", async () => {
    const annotations = [highlight("A", 650), highlight("B", 550)];
    const { sides } = await openReader(annotations);
    expect(sides().get("A")).toBe("right");
    annotations[0].position = { pageIndex: 0, rects: [[50, 650, 200, 662]] };
    await session.refresh();
    expect(sides().get("A")).toBe("left");
    expect(sides().get("B")).toBe("left");
  });

  it("keeps notes and region annotations on their natural side", async () => {
    const annotations = [highlight("NOTE", 650, 289, 311), highlight("IMAGE", 400)];
    annotations[0].type = "note";
    annotations[1].type = "image";
    const { sides } = await openReader(annotations);
    expect([...sides().values()]).toEqual(["right", "right"]);
  });
});
