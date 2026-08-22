import type { I18nString, I18nStringList } from "./types.js";

/**
 * Natural-language names people write in a `language` hint, mapped to the
 * BCP-47 code an i18n map is keyed by. Mirrors `normalizeLanguage` in
 * `@collabnode/mcp`, which resolves the same hints for its own catalogs.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  english: "en",
  ingles: "en",
  "inglés": "en",
  spanish: "es",
  "español": "es",
  espanol: "es",
};

/**
 * Pick the entry for `language` out of an i18n map, falling back through the
 * bare subtag (`es-MX` -> `es`), a natural-language alias, `en`, then whatever
 * the map defines first — so a value is only missing if the map is empty.
 */
function pickLocalized<T>(map: Record<string, T>, language?: string): T | undefined {
  if (language) {
    const key = language.toLowerCase().trim();
    const candidates = [key, key.split("-")[0] ?? key];
    const alias = LANGUAGE_ALIASES[candidates[1]!];
    if (alias) {
      candidates.push(alias);
    }
    for (const candidate of candidates) {
      if (map[candidate] !== undefined) {
        return map[candidate];
      }
    }
  }
  if (map.en !== undefined) {
    return map.en;
  }
  const firstKey = Object.keys(map)[0];
  return firstKey !== undefined ? map[firstKey] : undefined;
}

/** Resolve a `string | { en: "...", es: "..." }` schema field for `language`. */
export function resolveI18nString(
  val?: I18nString | null,
  language?: string,
): string | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val === "string") {
    return val;
  }
  return pickLocalized(val, language);
}

/** Resolve a `string[] | { en: [...], es: [...] }` schema field for `language`. */
export function resolveI18nStringList(
  val?: I18nStringList | null,
  language?: string,
): string[] {
  if (val === undefined || val === null) {
    return [];
  }
  if (Array.isArray(val)) {
    return val;
  }
  return pickLocalized(val, language) ?? [];
}

export function resolveGuidelines(
  guidelines?: I18nStringList | null,
  language?: string,
): string[] {
  return resolveI18nStringList(guidelines, language);
}
