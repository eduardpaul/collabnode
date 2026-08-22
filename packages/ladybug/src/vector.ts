import { vectorProperties, vectorSlug, type EmbeddingProvider } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";

/** One HNSW index over one node table's embedding column. */
export interface VectorIndexPlan {
  table: string;
  name: string;
  column: string;
  dimensions: number;
  /** Schema properties whose text goes into the embedding, in schema order. */
  properties: string[];
}

/**
 * Column holding one node's embedding.
 *
 * The model slug is part of the name on purpose. Vectors from two models are
 * not comparable, and nothing in the column would reveal which one wrote them —
 * so switching providers has to produce a *different*, empty column that the
 * backfill refills, rather than a column that silently ranks by nonsense.
 */
export function vectorColumn(provider: EmbeddingProvider): string {
  return `_vec_${vectorSlug(provider.id)}_${provider.dimensions}`;
}

/** Every `_vec_*` column belongs to us, which is how orphans from an old model are recognized. */
export const VECTOR_COLUMN_PREFIX = "_vec_";
const VECTOR_INDEX_PREFIX = "vec_";

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
}

export function vectorPlan(schema: GraphSchema, provider: EmbeddingProvider): VectorIndexPlan[] {
  const column = vectorColumn(provider);
  const plans: VectorIndexPlan[] = [];
  for (const [table, def] of Object.entries(schema.nodes)) {
    const properties = vectorProperties(def);
    if (properties.length === 0) {
      continue;
    }
    plans.push({
      table,
      name: `${VECTOR_INDEX_PREFIX}${table}_${vectorSlug(provider.id)}_${provider.dimensions}`.replaceAll(
        /[^A-Za-z0-9_]/g,
        "_",
      ),
      column,
      dimensions: provider.dimensions,
      properties,
    });
  }
  return plans;
}

/**
 * `IF NOT EXISTS` so this runs on every open, including against databases
 * written before vectors existed — `CREATE NODE TABLE IF NOT EXISTS` leaves
 * those untouched, and the column has to arrive some other way.
 */
export function addVectorColumnStatement(plan: VectorIndexPlan): string {
  return `ALTER TABLE ${quoteIdent(plan.table)} ADD IF NOT EXISTS ${quoteIdent(plan.column)} FLOAT[${plan.dimensions}]`;
}

export function dropColumnStatement(table: string, column: string): string {
  return `ALTER TABLE ${quoteIdent(table)} DROP IF EXISTS ${quoteIdent(column)}`;
}

/**
 * Components below this round to zero. A float32 carries about seven decimal
 * digits, so trimming here costs nothing a cosine ranking can notice, and it
 * keeps a 384-component literal from tripling in size on values like
 * 0.10000000149011612.
 */
const FLOAT_EPSILON = 1e-7;

function formatComponent(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < FLOAT_EPSILON) {
    return "0";
  }
  return String(Number(value.toFixed(7)));
}

/**
 * A vector as a Cypher literal. The CAST is required: an untyped list literal
 * binds as DOUBLE[] and will not assign to a FLOAT[N] column.
 */
export function vectorLiteral(vector: ArrayLike<number>, dimensions: number): string {
  const parts: string[] = [];
  for (let i = 0; i < dimensions; i += 1) {
    parts.push(formatComponent(Number(vector[i] ?? 0)));
  }
  return `CAST([${parts.join(",")}], 'FLOAT[${dimensions}]')`;
}

export function setVectorStatement(
  plan: VectorIndexPlan,
  id: string,
  vector: ArrayLike<number>,
): string {
  return `MATCH (n:${quoteIdent(plan.table)} {id: ${quote(id)}}) SET n.${quoteIdent(plan.column)} = ${vectorLiteral(vector, plan.dimensions)}`;
}

export function createIndexStatement(plan: VectorIndexPlan): string {
  return `CALL CREATE_VECTOR_INDEX(${quote(plan.table)}, ${quote(plan.name)}, ${quote(plan.column)}, metric := 'cosine')`;
}

export function dropIndexStatement(table: string, name: string): string {
  return `CALL DROP_VECTOR_INDEX(${quote(table)}, ${quote(name)})`;
}

/**
 * `QUERY_VECTOR_INDEX` returns cosine *distance* and, unlike the full-text
 * call, does not order its rows — the caller sorts.
 */
export function queryIndexStatement(
  plan: VectorIndexPlan,
  vector: ArrayLike<number>,
  limit: number,
): string {
  const k = Math.max(1, Math.trunc(limit));
  return (
    `CALL QUERY_VECTOR_INDEX(${quote(plan.table)}, ${quote(plan.name)}, ` +
    `${vectorLiteral(vector, plan.dimensions)}, ${k}) ` +
    `RETURN node.id AS id, distance AS distance`
  );
}

/** Rows with a NULL embedding, which is what the backfill exists to fill. */
export function pendingStatement(plan: VectorIndexPlan, limit: number): string {
  const properties = plan.properties.map((name) => `n.${quoteIdent(name)} AS ${quoteIdent(name)}`);
  return (
    `MATCH (n:${quoteIdent(plan.table)}) WHERE n.${quoteIdent(plan.column)} IS NULL ` +
    `RETURN n.id AS id${properties.length > 0 ? `, ${properties.join(", ")}` : ""} ` +
    `LIMIT ${Math.max(1, Math.trunc(limit))}`
  );
}

interface ShownIndex {
  table_name?: unknown;
  index_name?: unknown;
  index_type?: unknown;
  property_names?: unknown;
}

export interface VectorReconcile {
  create: VectorIndexPlan[];
  /** Indexes to remove, including ones left behind by a previous embedding model. */
  drop: Array<{ table: string; name: string }>;
}

/**
 * `CREATE_VECTOR_INDEX` throws when the name is taken, so what already exists
 * has to be read rather than assumed. Any `vec_*` HNSW index this plan does not
 * claim belonged to an earlier model and is dropped — leaving it would keep a
 * stale copy of every node's meaning on disk forever.
 */
export function reconcileIndexes(plans: VectorIndexPlan[], shown: unknown[]): VectorReconcile {
  const existing = new Map<string, { table: string; name: string; column: string }>();
  for (const row of shown) {
    const index = row as ShownIndex;
    if (String(index.index_type ?? "").toUpperCase() !== "HNSW") {
      continue;
    }
    const table = String(index.table_name ?? "");
    const name = String(index.index_name ?? "");
    if (!name.startsWith(VECTOR_INDEX_PREFIX)) {
      continue;
    }
    const columns = Array.isArray(index.property_names) ? index.property_names.map(String) : [];
    existing.set(`${table} ${name}`, { table, name, column: columns[0] ?? "" });
  }
  const create: VectorIndexPlan[] = [];
  const drop: Array<{ table: string; name: string }> = [];
  const claimed = new Set<string>();
  for (const plan of plans) {
    const key = `${plan.table} ${plan.name}`;
    const found = existing.get(key);
    claimed.add(key);
    if (!found) {
      create.push(plan);
      continue;
    }
    if (found.column !== plan.column) {
      drop.push({ table: plan.table, name: plan.name });
      create.push(plan);
    }
  }
  for (const [key, index] of existing) {
    if (!claimed.has(key)) {
      drop.push({ table: index.table, name: index.name });
    }
  }
  return { create, drop };
}

/** Embedding columns on a table that no current plan uses — an old model's leftovers. */
export function orphanColumns(plan: VectorIndexPlan, columns: string[]): string[] {
  return columns.filter(
    (column) => column.startsWith(VECTOR_COLUMN_PREFIX) && column !== plan.column,
  );
}
