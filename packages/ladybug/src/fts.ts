import {
  boostTiers,
  flattenSearchValue,
  joinedTerms,
  searchableProperties,
  type PropertyMap,
  type SearchableProperty,
} from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";

/** One full-text index over the columns sharing a boost, for one node table. */
export interface FtsIndexPlan {
  table: string;
  name: string;
  /** Schema properties covered. */
  properties: string[];
  /** Everything the index reads: `properties` plus the companion column, sorted. */
  columns: string[];
  /** Multiplied into every score this index returns, standing in for per-column weights. */
  boost: number;
}

/**
 * Companion column holding the punctuation-free joins of this tier's text.
 *
 * Ladybug's tokenizer cannot be replaced, so a stored `Kick-Off` indexes only
 * as ["kick", "off"] and a query for `kickoff` finds nothing. Writing `kickoff`
 * into a column indexed alongside the real one closes that direction. The `_`
 * prefix keeps it clear of user property names, which cannot start with one.
 */
export function searchColumn(boost: number): string {
  return `_search_${boost}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
}

/**
 * Ladybug's CREATE_FTS_INDEX has no per-column weight, so `search: { boost: 6 }`
 * in the schema is honoured by giving each distinct boost its own index and
 * scaling that index's scores on the way out. Types normally use one or two
 * tiers, so this is one or two indexes per table, not one per property.
 */
export function ftsPlan(schema: GraphSchema): FtsIndexPlan[] {
  const plans: FtsIndexPlan[] = [];
  for (const [table, def] of Object.entries(schema.nodes)) {
    const searchable: SearchableProperty[] = searchableProperties(def);
    for (const [boost, tier] of boostTiers(searchable)) {
      const properties = [...tier].sort();
      plans.push({
        table,
        name: `fts_${table}_${boost}`.replaceAll(/[^A-Za-z0-9_]/g, "_"),
        properties,
        columns: [...properties, searchColumn(boost)].sort(),
        boost,
      });
    }
  }
  return plans;
}

/**
 * Add the companion column to an existing table. `IF NOT EXISTS` makes this
 * safe to run on every open, including against databases created before search
 * existed — `CREATE NODE TABLE IF NOT EXISTS` would silently leave those without
 * the column, and every later insert would fail on the unknown property.
 */
export function addSearchColumnStatement(plan: FtsIndexPlan): string {
  return `ALTER TABLE ${quoteIdent(plan.table)} ADD IF NOT EXISTS ${quoteIdent(searchColumn(plan.boost))} STRING`;
}

/** The companion-column values for one node's properties, keyed by column name. */
export function searchColumnValues(
  plans: FtsIndexPlan[],
  properties: PropertyMap,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const plan of plans) {
    const terms = new Set<string>();
    for (const name of plan.properties) {
      const value = properties[name];
      if (value === undefined || value === null) {
        continue;
      }
      for (const term of joinedTerms(flattenSearchValue(value))) {
        terms.add(term);
      }
    }
    values[searchColumn(plan.boost)] = [...terms].join(" ");
  }
  return values;
}

export function createIndexStatement(plan: FtsIndexPlan): string {
  const columns = plan.columns.map(quote).join(", ");
  return `CALL CREATE_FTS_INDEX(${quote(plan.table)}, ${quote(plan.name)}, [${columns}])`;
}

export function dropIndexStatement(plan: FtsIndexPlan): string {
  return `CALL DROP_FTS_INDEX(${quote(plan.table)}, ${quote(plan.name)})`;
}

/**
 * `terms` is already normalized by `searchTerms`, so the punctuation-free form
 * of the query is in there alongside the plain words. `conjunctive := false`
 * makes that an OR: `Stand-Up` becomes `stand up standup` and finds a note
 * stored either way, ranked rather than filtered.
 */
export function queryIndexStatement(plan: FtsIndexPlan, terms: string[], limit: number): string {
  const query = quote(terms.join(" "));
  return (
    `CALL QUERY_FTS_INDEX(${quote(plan.table)}, ${quote(plan.name)}, ${query}, ` +
    `conjunctive := false, top := ${Math.max(1, Math.trunc(limit))}) ` +
    `RETURN node.id AS id, score AS score`
  );
}

interface ShownIndex {
  table_name?: unknown;
  index_name?: unknown;
  index_type?: unknown;
  property_names?: unknown;
}

/**
 * Which of `plans` already exist with the right columns, and which stale FTS
 * indexes should be dropped. CREATE_FTS_INDEX throws when the name is taken, so
 * this has to be checked rather than run blind, and a schema whose `search:`
 * fields changed needs the old index removed before the new one is built.
 */
export function reconcileIndexes(
  plans: FtsIndexPlan[],
  shown: unknown[],
): { create: FtsIndexPlan[]; drop: FtsIndexPlan[] } {
  const existing = new Map<string, string[]>();
  for (const row of shown) {
    const index = row as ShownIndex;
    if (String(index.index_type ?? "").toUpperCase() !== "FTS") {
      continue;
    }
    const table = String(index.table_name ?? "");
    const name = String(index.index_name ?? "");
    const columns = Array.isArray(index.property_names)
      ? index.property_names.map(String).sort()
      : [];
    existing.set(`${table}\0${name}`, columns);
  }
  const create: FtsIndexPlan[] = [];
  const drop: FtsIndexPlan[] = [];
  for (const plan of plans) {
    const columns = existing.get(`${plan.table}\0${plan.name}`);
    if (!columns) {
      create.push(plan);
      continue;
    }
    if (columns.join("\0") !== plan.columns.join("\0")) {
      drop.push(plan);
      create.push(plan);
    }
  }
  return { create, drop };
}
