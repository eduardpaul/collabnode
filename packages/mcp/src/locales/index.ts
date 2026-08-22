import { EN_CATALOG } from "./en.js";
import { ES_CATALOG } from "./es.js";
import type { McpLocaleCatalog } from "./types.js";

export type { McpLocaleCatalog } from "./types.js";
export type SupportedLanguage = "en" | "es" | (string & {});

const LOCALES: Record<string, McpLocaleCatalog> = {
  en: EN_CATALOG,
  es: ES_CATALOG,
};

export function normalizeLanguage(lang?: string | null): string {
  if (!lang) {
    return "en";
  }
  const lower = lang.toLowerCase().trim();
  if (
    lower.startsWith("es") ||
    lower === "spanish" ||
    lower === "español" ||
    lower === "espanol"
  ) {
    return "es";
  }
  if (
    lower.startsWith("en") ||
    lower === "english" ||
    lower === "ingles" ||
    lower === "inglés"
  ) {
    return "en";
  }
  return lower;
}

export function registerLocale(language: string, catalog: McpLocaleCatalog): void {
  LOCALES[normalizeLanguage(language)] = catalog;
}

export function getLocale(language?: string | null): McpLocaleCatalog {
  const code = normalizeLanguage(language);
  return LOCALES[code] ?? LOCALES.en!;
}
