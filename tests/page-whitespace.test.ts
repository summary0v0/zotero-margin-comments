import { describe, expect, it } from "vitest";
import { analyzePageWhitespace, placeMarginInWhitespace, normalizeCardWidth, type PageWhitespace } from "../src/core/page-whitespace";

function image(width = 200, height = 200) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function paint(target: ReturnType<typeof image>, x1: number, y1: number, x2: number, y2: number) {
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
    target.data.set([0, 0, 0, 255], (y * target.width + x) * 4);
  }
}

describe("whitespace placement with readable width", () => {
  it("protects figures without text and pale text bounds, while ignoring transparent pixels", () => {
    const bitmap = image();
    paint(bitmap, 50, 0, 150, 200);
    paint(bitmap, 150, 80, 190, 120); // a plot extending beyond the text column
    bitmap.data.set([0, 0, 0, 0], (30 * 200 + 199) * 4);
    const profile = analyzePageWhitespace(bitmap, [{ left: 0.2, right: 0.8, top: 0.15, bottom: 0.2 }]);
    expect(profile.rows.find((r) => r.top >= 0.45)!.right).toBe(0.05);
    expect(profile.rows.find((r) => r.top >= 0.15)!.right).toBeCloseTo(0.2);
    expect(profile.rows.find((r) => r.top >= 0.7)!.right).toBeCloseTo(0.25);
  });

  const profile: PageWhitespace = { rows: [
    { top: 0, bottom: 0.4, left: 0.25, right: 0.25 },
    { top: 0.4, bottom: 1, left: 0.15, right: 0.15 },
  ] };

  it("uses the narrowest margin across the whole card height, including safety padding", () => {
    const options = { side: "right" as const, pageWidth: 1200, pageHeight: 1600 };
    const abstract = placeMarginInWhitespace(profile, { ...options, bands: [{ top: 100, bottom: 500 }] });
    const crossing = placeMarginInWhitespace(profile, { ...options, bands: [{ top: 500, bottom: 800 }] });
    expect(abstract).toEqual({ x: 910, width: 360, mode: "overhang" });
    expect(crossing).toEqual({ x: 1030, width: 360, mode: "overhang" });
    expect(placeMarginInWhitespace(profile, { ...options, bands: [{ top: 100, bottom: 639 }] }).x).toBe(1030);
  });

  it("mirrors left margins and scales normalized profiles without scaling the font/card cap", () => {
    const right = placeMarginInWhitespace(profile, { side: "right", pageWidth: 1200, pageHeight: 1600 });
    const left = placeMarginInWhitespace(profile, { side: "left", pageWidth: 1200, pageHeight: 1600 });
    expect(left.x).toBe(1200 - right.x - right.width);
    expect(placeMarginInWhitespace(profile, { side: "right", pageWidth: 2400, pageHeight: 3200 }).width).toBe(360);
  });

  it("uses a narrow margin without shrinking the card or falling back to a distant paper edge", () => {
    const options = { side: "right" as const, pageWidth: 600, pageHeight: 800 };
    expect(placeMarginInWhitespace(profile, options)).toEqual({ x: 520, width: 360, mode: "overhang" });
    expect(placeMarginInWhitespace(undefined, options).mode).toBe("outside");
    expect(placeMarginInWhitespace({ rows: [{ top: 0, bottom: 1, left: 0.01, right: 0.01 }] }, options).mode).toBe("outside");
  });

  it("caps empty-page margins and never uses the centre or a double-column gutter", () => {
    const blank = analyzePageWhitespace(image());
    const placement = placeMarginInWhitespace(blank, { side: "right", pageWidth: 800, pageHeight: 1000 });
    expect(placement.x).toBeGreaterThan(800 / 2);
    expect(placement.width).toBe(360);
  });

  it("keeps the content-facing edge fixed for custom widths and validates persisted values", () => {
    const options = { side: "right" as const, pageWidth: 1200, pageHeight: 1600 };
    const normal = placeMarginInWhitespace(profile, options);
    const wide = placeMarginInWhitespace(profile, { ...options, cardWidth: 480 });
    expect(wide.x).toBe(normal.x);
    expect(wide.width).toBe(480);
    expect(normalizeCardWidth(undefined)).toBe(360);
    expect(normalizeCardWidth(NaN)).toBe(360);
    expect(normalizeCardWidth(100)).toBe(200);
    expect(normalizeCardWidth(900)).toBe(640);
  });
});
