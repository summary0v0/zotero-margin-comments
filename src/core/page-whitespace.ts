/** Page coordinates are normalized so a profile survives PDF zoom changes. */
export interface WhitespaceRow {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PageWhitespace {
  rows: WhitespaceRow[];
}

export interface ContentRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarginPlacement {
  x: number;
  width: number;
  mode: "inside" | "overhang" | "outside";
}

export interface VerticalBand {
  top: number;
  bottom: number;
}

export const PREFERRED_CARD_WIDTH = 360;
export const OUTSIDE_CARD_GAP = 24;
const CONTENT_GAP = 10;

export function normalizeCardWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(200, Math.min(640, value)))
    : PREFERRED_CARD_WIDTH;
}

/** Scan a clean, white-background PDF render, never the annotated Reader canvas. */
export function analyzePageWhitespace(
  image: { width: number; height: number; data: ArrayLike<number> },
  textRects: readonly ContentRect[] = [],
): PageWhitespace {
  const { width, height, data } = image;
  if (!(width > 0 && height > 0) || data.length < width * height * 4) {
    throw new Error("Invalid PDF render dimensions");
  }
  const rowHeight = Math.max(1, Math.ceil(height / 384));
  const rows: WhitespaceRow[] = [];
  for (let top = 0; top < height; top += rowHeight) {
    const bottom = Math.min(height, top + rowHeight);
    let left = width;
    let right = -1;
    for (let y = top; y < bottom; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        // Composite transparent pixels over white; transparent black is not ink.
        const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        const shade = 255 - (255 - min) * data[offset + 3] / 255;
        if (shade < 248) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
    }
    rows.push({
      top: top / height,
      bottom: bottom / height,
      left: left / width,
      right: (width - right - 1) / width,
    });
  }
  // Text bounds protect very pale text that may not cross the pixel threshold.
  for (const rect of textRects) {
    if (![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite)) continue;
    if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
    for (const row of rows) {
      if (row.bottom < rect.top || row.top > rect.bottom) continue;
      row.left = Math.max(0, Math.min(row.left, rect.left));
      row.right = Math.max(0, Math.min(row.right, 1 - rect.right));
    }
  }
  return { rows };
}

export function placeMarginInWhitespace(
  profile: PageWhitespace | undefined,
  options: {
    side: "left" | "right";
    pageWidth: number;
    pageHeight: number;
    bands?: readonly VerticalBand[];
    cardWidth?: number;
  },
): MarginPlacement {
  const { side, pageWidth, pageHeight } = options;
  const width = normalizeCardWidth(options.cardWidth);
  const outside = (): MarginPlacement => ({
    x: side === "left" ? -width - OUTSIDE_CARD_GAP : pageWidth + OUTSIDE_CARD_GAP,
    width,
    mode: "outside",
  });
  if (!profile?.rows.length || !(pageWidth > 0 && pageHeight > 0)) return outside();
  const bands = options.bands?.length
    ? options.bands
    : [{ top: 0, bottom: pageHeight }];
  // Never extend a margin into the middle of an empty page or between columns.
  let fraction = 0.32;
  let matched = false;
  for (const row of profile.rows) {
    if (!bands.some((band) =>
      row.bottom * pageHeight >= band.top - 4
      && row.top * pageHeight <= band.bottom + 4,
    )) continue;
    matched = true;
    fraction = Math.min(fraction, row[side]);
  }
  if (!matched || !Number.isFinite(fraction)) return outside();
  // Keep the reading width. Use paper whitespace to bring the inner edge close
  // to the content and let the other edge extend beyond the sheet as needed.
  const x = side === "left"
    ? pageWidth * fraction - CONTENT_GAP - width
    : pageWidth * (1 - fraction) + CONTENT_GAP;
  return {
    x,
    width,
    mode: x >= 0 && x + width <= pageWidth ? "inside"
      : x < pageWidth && x + width > 0 ? "overhang" : "outside",
  };
}
