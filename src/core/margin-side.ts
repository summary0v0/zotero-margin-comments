import type { PageAnchor } from "./types";

type MarginSide = PageAnchor["side"];

export interface MarginSideItem {
  key: string;
  anchorY: number;
  preferredSide?: MarginSide;
}

/** Only broad, nearly centred selections can use either margin. */
export function canUseEitherMargin(left: number, right: number, pageWidth: number): boolean {
  if (!(pageWidth > 0) || ![left, right, pageWidth].every(Number.isFinite)) return false;
  return (right - left) / pageWidth >= 0.3 - 1e-6
    && Math.abs((left + right) / pageWidth - 1) <= 0.1 + 1e-6;
}

/** Keep definite/cached sides; distribute only new, ambiguous selections. */
export function assignMarginSides(
  items: readonly MarginSideItem[],
  previous: ReadonlyMap<string, MarginSide> = new Map(),
): Map<string, MarginSide> {
  const result = new Map<string, MarginSide>();
  const counts = { left: 0, right: 0 };
  const pending: MarginSideItem[] = [];
  for (const item of items) {
    const side = item.preferredSide ?? previous.get(item.key);
    if (side) {
      result.set(item.key, side);
      counts[side] += 1;
    } else {
      pending.push(item);
    }
  }
  // Zotero's item order need not match reading order. Resolve ties consistently.
  pending.sort((a, b) => a.anchorY - b.anchorY || a.key.localeCompare(b.key));
  for (const item of pending) {
    // Long, centred text starts on the right when both margins are equally busy.
    const side = counts.left < counts.right ? "left" : "right";
    result.set(item.key, side);
    counts[side] += 1;
  }
  return result;
}
