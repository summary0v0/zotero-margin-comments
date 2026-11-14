export const DEFAULT_FONT_SIZE = 12.5;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export function normalizeFontSize(value: unknown): number {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric)
    ? Math.round(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, numeric)) * 2) / 2
    : DEFAULT_FONT_SIZE;
}
