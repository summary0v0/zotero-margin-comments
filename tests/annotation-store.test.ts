import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationStore } from "../src/zotero/annotation-store";

afterEach(() => vi.unstubAllGlobals());

describe("AnnotationStore", () => {
  it("reads supported Zotero annotation fields", () => {
    const annotation = {
      id: 11,
      key: "ABCDEFGH",
      isAnnotation: () => true,
      isEditable: () => true,
      annotationType: "underline",
      annotationComment: "关键解释",
      annotationColor: "#ff6666",
      annotationPageLabel: "iv",
      annotationPosition: '{"pageIndex":3,"rects":[[1,2,3,4]]}',
    };
    vi.stubGlobal("Zotero", {
      Items: { get: () => ({ getAnnotations: () => [annotation] }) },
    });

    expect(new AnnotationStore().list(7)).toEqual([
      {
        itemID: 11,
        key: "ABCDEFGH",
        type: "underline",
        comment: "关键解释",
        color: "#ff6666",
        pageLabel: "iv",
        position: {
          pageIndex: 3,
          rects: [[1, 2, 3, 4]],
          nextPageRects: undefined,
          paths: undefined,
          width: undefined,
        },
        readOnly: false,
      },
    ]);
  });

  it("saves through the Zotero item transaction API", async () => {
    const saveTx = vi.fn(async () => undefined);
    const item = {
      isAnnotation: () => true,
      isEditable: () => true,
      annotationComment: "旧内容",
      saveTx,
    };
    vi.stubGlobal("Zotero", { Items: { get: () => item } });

    await new AnnotationStore().saveComment(1, "新内容");
    expect(item.annotationComment).toBe("新内容");
    expect(saveTx).toHaveBeenCalledOnce();
  });

});
