export const MIN_POINTS = 1;
export const MAX_POINTS = 21;
export const FIBONACCI_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export function parsePoints(value: unknown, fallback = 3): number {
  if (typeof value === "string" && value.trim() && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return fallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(n)));
}

export function nextPoints(current: number): number {
  return FIBONACCI_POINTS.find((n) => n > current) ?? FIBONACCI_POINTS[0];
}

export function formatTaskDescription(what: string, how: string, language: "en" | "es"): string {
  if (language === "es") {
    return `Qué: ${what.trim()}\nCómo: ${how.trim()}`;
  }
  return `What: ${what.trim()}\nHow: ${how.trim()}`;
}
