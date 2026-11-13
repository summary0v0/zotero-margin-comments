import { describe, expect, it } from "vitest";
import { assignMarginSides, canUseEitherMargin } from "../src/core/margin-side";

describe("margin side selection", () => {
  it("recognizes broad selections near the middle across zoom levels", () => {
    for (const scale of [0.5, 1, 2]) {
      expect(canUseEitherMargin(100 * scale, 900 * scale, 1000 * scale)).toBe(true);
      expect(canUseEitherMargin(110 * scale, 910 * scale, 1000 * scale)).toBe(true);
      expect(canUseEitherMargin(150 * scale, 900 * scale, 1000 * scale)).toBe(true);
      expect(canUseEitherMargin(350 * scale, 650 * scale, 1000 * scale)).toBe(true);
      expect(canUseEitherMargin(351 * scale, 649 * scale, 1000 * scale)).toBe(false);
      expect(canUseEitherMargin(80 * scale, 460 * scale, 1000 * scale)).toBe(false);
      expect(canUseEitherMargin(540 * scale, 920 * scale, 1000 * scale)).toBe(false);
      expect(canUseEitherMargin(490 * scale, 510 * scale, 1000 * scale)).toBe(false);
    }
    expect(canUseEitherMargin(0, 0, 0)).toBe(false);
    expect(canUseEitherMargin(NaN, 900, 1000)).toBe(false);
  });

  it("counts definite sides before assigning ambiguous selections in reading order", () => {
    const sides = assignMarginSides([
      { key: "B", anchorY: 200 },
      { key: "A", anchorY: 100 },
      { key: "R", anchorY: 300, preferredSide: "right" },
    ]);
    expect([...sides]).toEqual([["R", "right"], ["A", "left"], ["B", "right"]]);
    const reordered = assignMarginSides([
      { key: "R", anchorY: 300, preferredSide: "right" },
      { key: "A", anchorY: 100 },
      { key: "B", anchorY: 200 },
    ]);
    expect(reordered).toEqual(sides);
  });

  it("uses both sides for a page of centred full-line highlights", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ key: `N${i}`, anchorY: i * 50 }));
    const sides = assignMarginSides(items);
    expect([...sides.values()].filter((side) => side === "left")).toHaveLength(5);
    expect([...sides.values()].filter((side) => side === "right")).toHaveLength(5);
  });

  it("starts long centred text on the right, then uses the less occupied margin", () => {
    const sides = assignMarginSides([
      { key: "FIRST", anchorY: 100 },
      { key: "SECOND", anchorY: 200 },
      { key: "THIRD", anchorY: 300 },
    ]);
    expect([...sides.values()]).toEqual(["right", "left", "right"]);
    const crowdedRight = assignMarginSides([
      { key: "NEW", anchorY: 100 },
      { key: "EXISTING", anchorY: 200, preferredSide: "right" },
    ]);
    expect(crowdedRight.get("NEW")).toBe("left");
  });

  it("keeps existing sides when new cards appear, but honours definite positions", () => {
    const previous = new Map([["A", "left"], ["B", "right"]] as const);
    const sides = assignMarginSides([
      { key: "NEW", anchorY: 0 },
      { key: "B", anchorY: 200 },
      { key: "A", anchorY: 100 },
      { key: "MOVED", anchorY: 300, preferredSide: "right" },
    ], new Map([...previous, ["MOVED", "left"]]));
    expect(sides.get("A")).toBe("left");
    expect(sides.get("B")).toBe("right");
    expect(sides.get("MOVED")).toBe("right");
    expect(sides.get("NEW")).toBe("left");
    expect(previous.size).toBe(2);
  });
});
