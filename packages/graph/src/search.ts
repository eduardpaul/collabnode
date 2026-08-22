import {
  DEFAULT_IDENTITY_BOOST,
  DEFAULT_SEARCH_BOOST,
  type NodeTypeDef,
  type PropertyDef,
} from "@collabnode/schema";

export interface GraphSearchRequest {
  /** Raw user text. Backends normalize it with `searchTerms`. */
  q: string;
  /** Restrict to these node types. Omitted means every type. */
  types?: string[];
  /** Upper bound on hits. Callers over-fetch, because they still filter by tag. */
  limit: number;
}

export interface GraphSearchHit {
  id: string;
  /** Backend-relative relevance, higher is better. Only comparable within one result set. */
  score: number;
}

/**
 * Case, accent, and width folding. Applied to every indexed term and every
 * query term, so `Café` and `cafe` land on the same token.
 */
export function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Everything that is not a letter or digit, removed. `Stand-Up` -> `standup`. */
export function squash(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * A joined term longer than this is prose, not a name. Squashing a whole note
 * body into one token costs index space and matches nothing anybody would type.
 */
const MAX_JOINED_TERM_LENGTH = 64;

/** The plain words a full-text tokenizer produces on its own. */
function plainTerms(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
}

/**
 * The terms a piece of text contributes to search.
 *
 * Every full-text tokenizer splits on punctuation, so `Stand-Up` becomes
 * ["stand", "up"] while `Standup` becomes ["standup"] — and neither spelling
 * finds the other. Adding the punctuation-free join of each word, and of the
 * whole string when it is short enough to be a name, gives the two spellings a
 * term in common. Applied to stored text and query text alike, matching becomes
 * symmetric: it no longer matters which side was hyphenated.
 */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const word of fold(text).split(/\s+/)) {
    for (const term of plainTerms(word)) {
      terms.add(term);
    }
    // `kick-off` -> `kickoff`
    const joined = squash(word);
    if (joined) {
      terms.add(joined);
    }
  }
  // `stand up` -> `standup`
  const whole = squash(text);
  if (whole && whole.length <= MAX_JOINED_TERM_LENGTH) {
    terms.add(whole);
  }
  return [...terms];
}

/**
 * Only the terms a plain tokenizer would miss — the punctuation-free joins.
 *
 * Backends that cannot be given a custom tokenizer get these written into a
 * companion column and indexed alongside the real one, which is what makes a
 * stored `Kick-Off` answer a query for `kickoff`.
 */
export function joinedTerms(text: string): string[] {
  const plain = new Set(plainTerms(text));
  return searchTerms(text).filter((term) => !plain.has(term));
}

/**
 * What gets indexed when a schema says nothing about `search`: the same field
 * set the old substring scan walked, so existing schemas keep the behaviour
 * they already had without editing a line of YAML.
 */
const SEARCHABLE_BY_DEFAULT = new Set<PropertyDef["type"]>(["string", "text", "enum", "datetime"]);

export interface SearchableProperty {
  name: string;
  boost: number;
}

/**
 * A node type opts into explicit search config as a whole: the moment one of
 * its properties declares `search`, the rest are out unless they say otherwise.
 */
export function searchableProperties(def: NodeTypeDef | undefined): SearchableProperty[] {
  if (!def) {
    return [];
  }
  const entries = Object.entries(def.properties);
  const explicit = entries.some(([, property]) => property.search !== undefined);
  const identity = def.identity?.from ?? [];
  const out: SearchableProperty[] = [];
  for (const [name, property] of entries) {
    const fallbackBoost = identity.includes(name) ? DEFAULT_IDENTITY_BOOST : DEFAULT_SEARCH_BOOST;
    if (property.search) {
      if (property.search.index) {
        out.push({ name, boost: property.search.boost ?? fallbackBoost });
      }
      continue;
    }
    if (!explicit && SEARCHABLE_BY_DEFAULT.has(property.type)) {
      out.push({ name, boost: fallbackBoost });
    }
  }
  return out;
}

/** Group searchable properties by boost, so a backend without per-column weights can index each tier separately. */
export function boostTiers(properties: SearchableProperty[]): Map<number, string[]> {
  const tiers = new Map<number, string[]>();
  for (const { name, boost } of properties) {
    const existing = tiers.get(boost);
    if (existing) {
      existing.push(name);
    } else {
      tiers.set(boost, [name]);
    }
  }
  return tiers;
}

/** Flatten whatever a property holds into text, mirroring the deep substring walk in graph_search. */
export function flattenSearchValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenSearchValue).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(flattenSearchValue).join(" ");
  }
  return "";
}
