/**
 * Story points. The workspace schema is the authority here: `functionalPoints`
 * is declared `number, integer: true, min: 1, max: 21`, and the runtime rejects
 * a string, a float, or an out-of-range value outright.
 *
 * So the only requirement is that the value is a storable number. Nothing
 * downstream reads meaning into *which* number it is — an off-ladder 4 is a
 * perfectly good estimate. Fibonacci is the convention we suggest to the model
 * and step through in the UI, not an invariant worth enforcing twice.
 */
export const MIN_POINTS = 1;
export const MAX_POINTS = 21;

/** The planning-poker ladder the UI steps through. Guidance, not validation. */
export const FIBONACCI_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export function isPoint(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= MIN_POINTS && (value as number) <= MAX_POINTS;
}

export function isProsePoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !/^-?\d+(\.\d+)?$/.test(trimmed);
}

/** Coerce whatever the model wrote into a number the schema will accept. */
export function parsePoints(value: unknown, fallback = 3): number {
  if (isProsePoint(value)) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(n)));
}

/** Next rung of the UI's estimate stepper; off-ladder values step up to the next rung. */
export function nextPoints(current: number): number {
  return FIBONACCI_POINTS.find((n) => n > current) ?? FIBONACCI_POINTS[0];
}

export function formatTaskDescription(what: string, how: string, language: "en" | "es"): string {
  if (language === "es") {
    return `Qué: ${what.trim()}\nCómo: ${how.trim()}`;
  }
  return `What: ${what.trim()}\nHow: ${how.trim()}`;
}

export function descriptionHasWhatAndHow(description: string): boolean {
  const text = description.toLowerCase();
  return (
    (text.includes("what:") || text.includes("qué:")) &&
    (text.includes("how:") || text.includes("cómo:"))
  );
}

/**
 * Coerce misused What/How prose out of the point fields and store a number.
 *
 * Only keys actually present in `properties` are written back. An upsert is a
 * merge over what is stored, so injecting a default for an absent key would turn
 * a partial write (say, a rename) into an overwrite that blanks the description
 * and resets both estimates.
 */
export function normalizeTaskProperties(
  properties: Record<string, unknown>,
  options: { language: "en" | "es" },
): Record<string, unknown> {
  const out = { ...properties };
  const functionalRaw = properties.functionalPoints;
  const technicalRaw = properties.technicalPoints;
  const what = isProsePoint(functionalRaw) ? String(functionalRaw).trim() : "";
  const how = isProsePoint(technicalRaw) ? String(technicalRaw).trim() : "";

  if (what || how) {
    // Prose landed in a point field: move it into description before scoring.
    const description = String(properties.description ?? "").trim();
    out.description = descriptionHasWhatAndHow(description)
      ? description
      : [description, formatTaskDescription(what, how, options.language)].filter(Boolean).join("\n");
  }

  if (functionalRaw !== undefined) out.functionalPoints = parsePoints(functionalRaw);
  if (technicalRaw !== undefined) out.technicalPoints = parsePoints(technicalRaw);

  return out;
}
