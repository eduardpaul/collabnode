import type {
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphSearchHit,
  GraphSnapshot,
  HistoryEntry,
  QueryResult,
} from "@collabnode/graph";
import { GraphStoreError, squash } from "@collabnode/graph";
import {
  crdtProperties,
  identityId,
  SchemaError,
  type GraphSchema,
  type I18nStringList,
  type I18nString,
  type PropertyDef,
} from "@collabnode/schema";
import type { CollabSession, MutationOptions, UpsertNodeInput } from "./session.js";
import { normalizedIdentityMatch } from "./session.js";
import {
  clampLimit,
  compactSnapshot,
  edgeLabel,
  incidentSummary,
  mapDeep,
  mapProperties,
  MAX_LIST_LIMIT,
  MIN_ID_PREFIX,
  nodeKeyProperties,
  nodeLabel,
  nodeSummary,
  snapshotValue,
  stringList,
  truncateSearchValue,
} from "./tools-format.js";

export {
  clampLimit,
  compactSnapshot,
  DEFAULT_LIST_LIMIT,
  LONG_STRING_LIMIT,
  MAX_LIST_LIMIT,
  MIN_ID_PREFIX,
} from "./tools-format.js";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_NEIGHBOR_DEPTH = 2;
/** Ranked hits pulled before type/tag filtering, so a filter cannot empty the page. */
const MAX_SEARCH_HITS = 500;
/** Clears any BM25 score in practice, so naming a thing exactly always wins. */
const EXACT_LABEL_BONUS = 1_000;
/** Ranks a tag hit below every indexed-text hit, but above nothing at all. */
const TAG_MATCH_SCORE = 0;
/**
 * Semantic candidates considered per query. A vector index ranks *everything* —
 * it has no notion of "no match" — so without a cap a three-word question would
 * drag the whole graph back as if it were relevant.
 */
const MAX_VECTOR_HITS = 50;
/**
 * How close to the best semantic hit another one must be to count as relevant.
 *
 * Embedding similarities are compressed and model-specific — bge-small puts a
 * note that is genuinely about the question at ~0.56 and an unrelated one at
 * ~0.49 — so an absolute threshold means nothing, and even an absolute *gap*
 * only suits the one model it was measured on. A proportion of the best hit in
 * the same result set travels: things actually about the same subject cluster
 * within a few percent of each other, and everything else falls away.
 */
const VECTOR_SPREAD_RATIO = 0.95;
/**
 * Reciprocal-rank-fusion damping, the value the original paper settled on.
 * Larger flattens the contribution of top ranks; smaller lets a single list
 * dictate the order.
 */
const RRF_K = 60;
const MUTATING_CYPHER =
  /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD\s+CSV|WRITE)\b/i;

export type GraphNodeRef = string | { id?: string; type?: string; [key: string]: unknown };

export interface GraphGetArgs {
  id: string;
}

export interface GraphSearchArgs {
  q?: string;
  types?: string[];
  tag?: string;
  limit?: number;
}

export interface GraphSimilarArgs {
  id: string;
  types?: string[];
  limit?: number;
}

export interface GraphListArgs {
  types?: string[];
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface GraphNeighborsArgs {
  id: string;
  edgeTypes?: string[];
  direction?: "in" | "out" | "both";
  depth?: number;
  limit?: number;
}

export interface GraphSnapshotArgs {
  types?: string[];
  includeText?: boolean;
}

export interface GraphQueryArgs {
  cypher: string;
  params?: Record<string, unknown>;
  limit?: number;
}

export interface GraphHistoryArgs {
  id?: string;
  actorId?: string;
  since?: string;
  limit?: number;
}

export interface GraphChangesArgs {
  since?: string;
  actorId?: string;
  limit?: number;
}

export interface UpsertGraphEdgeInput {
  type: string;
  from: GraphNodeRef;
  to: GraphNodeRef;
  properties?: Record<string, unknown>;
  id?: string;
}

export interface GraphPropertyContract {
  type: string;
  required?: boolean;
  default?: unknown;
  values?: string[];
  integer?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  derived?: string;
  description?: I18nString;
}

export interface GraphDescribeResult {
  name: string;
  description?: I18nString;
  schemaId: string;
  schemaHash: string;
  version: number;
  documentId: string;
  actorId?: string;
  changeTracking: GraphSchema["config"]["changeTracking"];
  tags?: GraphSchema["config"]["tags"];
  nodes: Record<
    string,
    {
      description?: I18nString;
      identity?: string[];
      /** One node of this type per workspace; writes land on it. */
      singleton?: true;
      properties: Record<string, GraphPropertyContract>;
      guidelines?: I18nStringList;
    }
  >;
  edges: Record<
    string,
    {
      description?: I18nString;
      from: string[];
      to: string[];
      directed: boolean;
      properties: Record<string, GraphPropertyContract>;
      guidelines?: I18nStringList;
    }
  >;
  reads: string[];
  writes: string[];
}

export interface GraphListResult {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    properties: Record<string, unknown>;
    tags?: string[];
    meta: GraphNodeRecord["meta"];
  }>;
  total: number;
  offset: number;
  limit: number;
  truncated?: true;
}

export interface GraphSearchResult {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    properties: Record<string, unknown>;
    tags?: string[];
    meta: GraphNodeRecord["meta"];
    /** Relevance score; absent on substring-fallback hits, which are unranked. */
    score?: number;
    /**
     * Which index found this: its wording, its meaning, or both. Lets a caller
     * tell "the note called that" from "a note about that" — absent on
     * substring-fallback hits.
     */
    match?: SearchMatch;
  }>;
  total: number;
  truncated?: true;
}

export type SearchMatch = "text" | "vector" | "both";

export interface GraphChangeEvent {
  op: HistoryEntry["op"];
  id: string;
  type?: string;
  from?: string;
  to?: string;
  label?: string;
  actorId?: string;
  at?: string;
  created?: boolean;
  changes?: HistoryEntry["changes"];
}

export interface GraphChangesResult {
  mode: "history" | "last-write" | "off";
  events: GraphChangeEvent[];
  cursor: string;
  deletesOmitted?: true;
  truncated?: true;
}

export interface GraphActorsResult {
  sessionActorId?: string;
  actors: Array<{ actorId: string; lastAt?: string; nodes: number; edges: number }>;
}

export interface GraphNodeWriteResult {
  created: boolean;
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  tags?: string[];
  meta: GraphNodeRecord["meta"];
  warnings?: string[];
}

export interface GraphEdgeWriteResult {
  created: boolean;
  id: string;
  type: string;
  from: string;
  to: string;
  label: string;
  properties: Record<string, unknown>;
  meta: GraphEdgeRecord["meta"];
}

export interface GraphDeleteResult {
  deleted: string;
  existed: true;
  kind: "node" | "edge";
  type?: string;
  cascadedEdges?: number;
}

export interface BindGraphToolsOptions {
  graphKind?: string;
}

function propertyContract(def: PropertyDef): GraphPropertyContract {
  const out: GraphPropertyContract = { type: def.type };
  if (def.required) {
    out.required = true;
  }
  if (def.default !== undefined) {
    out.default = def.default;
  }
  if (def.values) {
    out.values = def.values;
  }
  if (def.integer) {
    out.integer = true;
  }
  if (def.min !== undefined) {
    out.min = def.min;
  }
  if (def.max !== undefined) {
    out.max = def.max;
  }
  if (def.maxLength !== undefined) {
    out.maxLength = def.maxLength;
  }
  if (def.derived !== undefined) {
    out.derived = def.derived;
  }
  if (def.description) {
    out.description = def.description;
  }
  return out;
}

function propertiesContract(properties: Record<string, PropertyDef>): Record<string, GraphPropertyContract> {
  const out: Record<string, GraphPropertyContract> = {};
  for (const [name, def] of Object.entries(properties)) {
    out[name] = propertyContract(def);
  }
  return out;
}

function matchesNeedle(value: string, needle: string): boolean {
  if (value.toLowerCase().includes(needle)) {
    return true;
  }
  // `stand-up` should still filter down to a note titled `Standup`.
  const squashedNeedle = squash(needle);
  return squashedNeedle.length > 0 && squash(value).includes(squashedNeedle);
}

function valueMatchesNeedle(value: unknown, needle: string): boolean {
  if (typeof value === "string") {
    return matchesNeedle(value, needle);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return matchesNeedle(String(value), needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueMatchesNeedle(item, needle));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => valueMatchesNeedle(item, needle));
  }
  return false;
}

function nodeMatchesFilters(
  node: GraphNodeRecord,
  types: string[] | undefined,
  tag: string | undefined,
): boolean {
  if (types && !types.includes(node.type)) {
    return false;
  }
  if (
    tag !== undefined &&
    !(node.tags ?? []).some((item) => item.toLowerCase() === tag.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function nodeMatchesSearch(
  schema: GraphSchema,
  node: GraphNodeRecord,
  needle: string,
  types: string[] | undefined,
  tag: string | undefined,
): boolean {
  if (!nodeMatchesFilters(node, types, tag)) {
    return false;
  }
  if (!needle) {
    return true;
  }
  if (matchesNeedle(node.id, needle) || matchesNeedle(nodeLabel(schema, node), needle)) {
    return true;
  }
  if (valueMatchesNeedle(node.properties, needle)) {
    return true;
  }
  return (node.tags ?? []).some((item) => matchesNeedle(item, needle));
}

function identityIdFromFields(
  schema: GraphSchema,
  type: string,
  properties: Record<string, unknown>,
): string | undefined {
  const def = schema.nodes[type];
  if (!def?.identity) {
    return undefined;
  }
  const ready = def.identity.from.every((field) => {
    const value = properties[field];
    return value !== undefined && value !== null && value !== "";
  });
  if (!ready) {
    return undefined;
  }
  return identityId(schema, type, properties);
}

export function resolveEntity(
  snapshot: GraphSnapshot,
  schema: GraphSchema,
  id: string,
  kinds: Array<"node" | "edge"> = ["node", "edge"],
): { kind: "node"; node: GraphNodeRecord } | { kind: "edge"; edge: GraphEdgeRecord } {
  if (kinds.includes("node")) {
    const node = snapshot.nodes.find((record) => record.id === id);
    if (node) {
      return { kind: "node", node };
    }
  }
  if (kinds.includes("edge")) {
    const edge = snapshot.edges.find((record) => record.id === id);
    if (edge) {
      return { kind: "edge", edge };
    }
  }
  const needle = id.toLowerCase();
  if (needle.length < MIN_ID_PREFIX) {
    throw new SchemaError(`unknown id: ${id}`, "id");
  }
  const nodes = kinds.includes("node")
    ? snapshot.nodes.filter((record) => record.id.toLowerCase().startsWith(needle))
    : [];
  const edges = kinds.includes("edge")
    ? snapshot.edges.filter((record) => record.id.toLowerCase().startsWith(needle))
    : [];
  if (nodes.length + edges.length === 1) {
    if (nodes[0]) {
      return { kind: "node", node: nodes[0] };
    }
    return { kind: "edge", edge: edges[0]! };
  }
  if (nodes.length + edges.length > 1) {
    const labels = [
      ...nodes.map((node) => `${node.type}:${node.id} (${nodeLabel(schema, node)})`),
      ...edges.map((edge) => `${edge.type}:${edge.id}`),
    ];
    throw new SchemaError(`ambiguous id prefix '${id}': ${labels.join(", ")}`, "id");
  }
  throw new SchemaError(`unknown id: ${id}`, "id");
}

function requireNode(
  snapshot: GraphSnapshot,
  schema: GraphSchema,
  id: string,
): GraphNodeRecord {
  const resolved = resolveEntity(snapshot, schema, id, ["node"]);
  if (resolved.kind !== "node") {
    throw new SchemaError(`not a node id: ${id}`, "id");
  }
  return resolved.node;
}

function requireEdge(
  snapshot: GraphSnapshot,
  schema: GraphSchema,
  id: string,
): GraphEdgeRecord {
  const resolved = resolveEntity(snapshot, schema, id, ["edge"]);
  if (resolved.kind !== "edge") {
    throw new SchemaError(`not an edge id: ${id}`, "id");
  }
  return resolved.edge;
}

export function resolveNodeRef(session: CollabSession, ref: GraphNodeRef): string {
  if (typeof ref === "string") {
    return requireNode(session.snapshot(), session.schema, ref).id;
  }
  if (ref && typeof ref === "object") {
    if (typeof ref.id === "string" && ref.id) {
      return requireNode(session.snapshot(), session.schema, ref.id).id;
    }
    const type = typeof ref.type === "string" ? ref.type : undefined;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ref)) {
      if (key === "id" || key === "type" || value === undefined) {
        continue;
      }
      properties[key] = value;
    }
    if (type) {
      const minted = identityIdFromFields(session.schema, type, properties);
      if (minted) {
        const existing = session.snapshot().nodes.find((node) => node.id === minted);
        if (existing) {
          return existing.id;
        }
      }
    }
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      throw new SchemaError("node ref needs an id, identity fields, or matching properties", "id");
    }
    const matchesOn = (loose: boolean) =>
      session.snapshot().nodes.filter((node) => {
        if (type && node.type !== type) {
          return false;
        }
        return keys.every((key) => {
          const actual = node.properties[key];
          const wanted = properties[key];
          if (actual === wanted) {
            return true;
          }
          return (
            loose &&
            typeof actual === "string" &&
            typeof wanted === "string" &&
            squash(actual) === squash(wanted)
          );
        });
      });
    // Exact first; a spoken `Stand-Up` only falls back to the stored `Standup`
    // when nothing matched byte for byte.
    const exact = matchesOn(false);
    const matches = exact.length > 0 ? exact : matchesOn(true);
    if (matches.length === 1) {
      return matches[0]!.id;
    }
    if (matches.length === 0) {
      throw new SchemaError(
        `no node matches ${JSON.stringify(type ? { type, ...properties } : properties)}`,
        "id",
      );
    }
    throw new SchemaError(
      `ambiguous node ref ${JSON.stringify(type ? { type, ...properties } : properties)}`,
      "id",
    );
  }
  throw new SchemaError("invalid node ref", "id");
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function graphDescribe(session: CollabSession): GraphDescribeResult {
  const schema = session.schema;
  const nodes: GraphDescribeResult["nodes"] = {};
  for (const [type, def] of Object.entries(schema.nodes)) {
    nodes[type] = {
      description: def.description,
      identity: def.identity?.from,
      ...(def.singleton ? { singleton: true as const } : {}),
      properties: propertiesContract(def.properties),
      guidelines: def.guidelines,
    };
  }
  const edges: GraphDescribeResult["edges"] = {};
  for (const [type, def] of Object.entries(schema.edges)) {
    edges[type] = {
      description: def.description,
      from: def.from,
      to: def.to,
      directed: def.directed,
      properties: propertiesContract(def.properties),
      guidelines: def.guidelines,
    };
  }
  return {
    name: schema.name,
    description: schema.description,
    schemaId: schema.config.schemaId,
    schemaHash: schema.schemaHash,
    version: schema.version,
    documentId: session.id,
    actorId: session.actorId,
    changeTracking: schema.config.changeTracking,
    tags: schema.config.tags,
    nodes,
    edges,
    reads: [
      "graph_describe",
      "graph_list",
      "graph_get",
      "graph_search",
      // Only exists where the store can embed, so only advertised there.
      ...(session.searchModes().vector ? ["graph_similar"] : []),
      "graph_neighbors",
      "graph_snapshot",
      "graph_query",
      "graph_history",
      "graph_changes",
      "graph_actors",
    ],
    writes: ["upsert_node_<Type>", "upsert_edge_<Type>", "graph_delete_node", "graph_delete_edge"],
  };
}

export function graphGet(session: CollabSession, args: GraphGetArgs) {
  const resolved = resolveEntity(session.snapshot(), session.schema, String(args.id));
  const snapshot = session.snapshot();
  const schema = session.schema;
  if (resolved.kind === "node") {
    const incident = snapshot.edges
      .filter((edge) => edge.from === resolved.node.id || edge.to === resolved.node.id)
      .map((edge) => incidentSummary(schema, edge));
    return { kind: "node" as const, node: nodeSummary(schema, resolved.node), incident };
  }
  const from = snapshot.nodes.find((record) => record.id === resolved.edge.from);
  const to = snapshot.nodes.find((record) => record.id === resolved.edge.to);
  return {
    kind: "edge" as const,
    edge: {
      ...incidentSummary(schema, resolved.edge),
      properties: resolved.edge.properties,
      meta: resolved.edge.meta,
    },
    incident: [
      from ? { id: from.id, type: from.type, label: nodeLabel(schema, from) } : { id: resolved.edge.from },
      to ? { id: to.id, type: to.type, label: nodeLabel(schema, to) } : { id: resolved.edge.to },
    ],
  };
}

/**
 * Relevance-ranked full text, served by the graph store's own index, with the
 * old substring scan behind it.
 *
 * Every backend is token-based, so none can answer a mid-word query the way
 * `includes` did (`ay` finding `Pay flow`). Falling back only when the store
 * has no index, or comes up empty, keeps those queries working without letting
 * unranked substring noise outrank real hits.
 */
export async function graphSearch(
  session: CollabSession,
  args: GraphSearchArgs = {},
): Promise<GraphSearchResult> {
  const query = String(args.q ?? "");
  const needle = query.toLowerCase();
  const types = stringList(args.types);
  const tag = typeof args.tag === "string" ? args.tag : undefined;
  const limit = clampLimit(args.limit);
  const schema = session.schema;

  const scores = new Map<string, number>();
  const matches = new Map<string, SearchMatch>();
  let matched: GraphNodeRecord[] = [];
  // Over-fetch before filtering, so a type or tag filter cannot empty the page.
  // Sequential, not concurrent: both hit the same store, and Ladybug's
  // connection is not safe to drive from two queries at once.
  const textHits = query.trim()
    ? await session.search({ q: query, types, limit: MAX_SEARCH_HITS })
    : undefined;
  const vectorHits = query.trim()
    ? relevantVectorHits(await session.searchVector({ q: query, types, limit: MAX_VECTOR_HITS }))
    : undefined;
  const hits = fuseHits(textHits, vectorHits);
  // Read the snapshot after searching, not before: search drains the projector,
  // so a node the store just indexed is guaranteed to be resolvable here.
  const snapshot = session.snapshot();
  if (hits) {
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const wanted = squash(query);
    for (const hit of hits) {
      const node = byId.get(hit.id);
      if (!node || !nodeMatchesFilters(node, types, tag)) {
        continue;
      }
      // BM25 rewards repetition, so a note that says "standup" three times in
      // its body can outrank the note actually *called* Standup. Someone naming
      // a thing means that thing, so an exact label match takes the top.
      const exact = wanted.length > 0 && squash(nodeLabel(schema, node)) === wanted;
      scores.set(node.id, exact ? hit.score + EXACT_LABEL_BONUS : hit.score);
      matches.set(node.id, hit.match);
      matched.push(node);
    }
    // Ladybug's DDL has no tags column, so tag text never reaches its index.
    // Folding tag matches in here keeps every backend answering the same way.
    for (const node of snapshot.nodes) {
      if (scores.has(node.id) || !nodeMatchesFilters(node, types, tag)) {
        continue;
      }
      if ((node.tags ?? []).some((item) => matchesNeedle(item, needle))) {
        scores.set(node.id, TAG_MATCH_SCORE);
        matches.set(node.id, "text");
        matched.push(node);
      }
    }
    matched.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  }
  if (matched.length === 0) {
    scores.clear();
    matches.clear();
    matched = snapshot.nodes.filter((node) => nodeMatchesSearch(schema, node, needle, types, tag));
  }

  return searchResult(session, matched, limit, needle, scores, matches);
}

/** A store hit plus which index produced it, once both have been merged. */
interface FusedHit {
  id: string;
  score: number;
  match: SearchMatch;
}

/**
 * Drop semantic hits that are only nearest by default.
 *
 * A vector index always returns its `k` closest neighbours, however unrelated —
 * "closest" is not "relevant". Keeping only what sits within `VECTOR_SPREAD` of
 * the best hit turns "here is the whole graph, ranked" into "here are the few
 * that are actually about this".
 */
function relevantVectorHits(
  hits: GraphSearchHit[] | undefined,
): GraphSearchHit[] | undefined {
  if (!hits || hits.length === 0) {
    return hits;
  }
  const best = hits[0]?.score ?? 0;
  // Cosine can go negative, where scaling would raise the bar above the best
  // hit and throw everything away. Nothing is relevant at that point anyway.
  const floor = best > 0 ? best * VECTOR_SPREAD_RATIO : best;
  return hits.filter((hit) => hit.score >= floor);
}

/**
 * Merge the lexical and semantic result sets with reciprocal rank fusion.
 *
 * The two scores cannot be compared: BM25 is unbounded and rewards repetition,
 * cosine similarity is squeezed into a narrow band near the top. Only their
 * *orders* mean anything, which is exactly what RRF combines. A node both
 * indexes agree on collects from both lists and rises above either alone.
 *
 * With one list there is nothing to fuse, so its own scores are passed through
 * unchanged — which is what keeps every schema without `vector:` scoring
 * exactly as it did before semantic search existed.
 */
function fuseHits(
  textHits: GraphSearchHit[] | undefined,
  vectorHits: GraphSearchHit[] | undefined,
): FusedHit[] | undefined {
  if (!vectorHits?.length) {
    return textHits?.map((hit) => ({ ...hit, match: "text" as const }));
  }
  if (!textHits?.length) {
    return vectorHits.map((hit) => ({ ...hit, match: "vector" as const }));
  }
  const fused = new Map<string, FusedHit>();
  const add = (hits: GraphSearchHit[], match: SearchMatch): void => {
    hits.forEach((hit, rank) => {
      const existing = fused.get(hit.id);
      const score = (existing?.score ?? 0) + 1 / (RRF_K + rank + 1);
      fused.set(hit.id, {
        id: hit.id,
        score,
        match: existing && existing.match !== match ? "both" : match,
      });
    });
  };
  add(textHits, "text");
  add(vectorHits, "vector");
  return [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Nodes that read like the given one, ranked by their stored embeddings.
 *
 * This is the query no search string can express: the input is a node, not
 * words, so there is nothing for a caller to phrase and nothing for full text
 * to match on.
 */
export async function graphSimilar(
  session: CollabSession,
  args: GraphSimilarArgs,
): Promise<GraphSearchResult> {
  const types = stringList(args.types);
  const limit = clampLimit(args.limit);
  const resolved = resolveEntity(session.snapshot(), session.schema, String(args.id), ["node"]);
  if (resolved.kind !== "node") {
    throw new SchemaError(`not a node: ${String(args.id)}`, "id");
  }
  const hits =
    relevantVectorHits(
      await session.searchVector({ likeId: resolved.node.id, types, limit: MAX_VECTOR_HITS }),
    ) ?? [];
  // Search drains the projector, so anything it returned resolves here.
  const byId = new Map(session.snapshot().nodes.map((node) => [node.id, node]));
  const scores = new Map<string, number>();
  const matches = new Map<string, SearchMatch>();
  const matched: GraphNodeRecord[] = [];
  for (const hit of hits) {
    const node = byId.get(hit.id);
    if (!node || !nodeMatchesFilters(node, types, undefined)) {
      continue;
    }
    scores.set(node.id, hit.score);
    matches.set(node.id, "vector");
    matched.push(node);
  }
  return searchResult(session, matched, limit, "", scores, matches);
}

function searchResult(
  session: CollabSession,
  matched: GraphNodeRecord[],
  limit: number,
  needle: string,
  scores: Map<string, number>,
  matches: Map<string, SearchMatch>,
): GraphSearchResult {
  const schema = session.schema;
  const nodes = matched.slice(0, limit).map((node) => ({
    id: node.id,
    type: node.type,
    label: nodeLabel(schema, node),
    properties: mapProperties(node.properties, (value) =>
      mapDeep(value, (item) => truncateSearchValue(item, needle)),
    ),
    tags: node.tags,
    meta: node.meta,
    score: scores.get(node.id),
    match: matches.get(node.id),
  }));
  return {
    nodes,
    total: matched.length,
    truncated: matched.length > limit ? true : undefined,
  };
}

export function graphList(session: CollabSession, args: GraphListArgs = {}): GraphListResult {
  const types = stringList(args.types);
  const tag = typeof args.tag === "string" ? args.tag : undefined;
  const needle = String(args.q ?? "").toLowerCase();
  const limit = clampLimit(args.limit);
  const offset =
    typeof args.offset === "number" && Number.isFinite(args.offset)
      ? Math.max(0, Math.floor(args.offset))
      : 0;
  const schema = session.schema;
  const matched = session
    .snapshot()
    .nodes.filter((node) => nodeMatchesSearch(schema, node, needle, types, tag));
  const nodes = matched.slice(offset, offset + limit).map((node) => ({
    id: node.id,
    type: node.type,
    label: nodeLabel(schema, node),
    properties: nodeKeyProperties(schema, node),
    tags: node.tags,
    meta: node.meta,
  }));
  return {
    nodes,
    total: matched.length,
    offset,
    limit,
    truncated: offset + nodes.length < matched.length ? true : undefined,
  };
}

export function graphNeighbors(session: CollabSession, args: GraphNeighborsArgs) {
  const snapshot = session.snapshot();
  const schema = session.schema;
  const start = requireNode(snapshot, schema, String(args.id));
  const edgeTypes = stringList(args.edgeTypes);
  const direction = args.direction === "in" || args.direction === "out" ? args.direction : "both";
  const depth = Math.min(
    MAX_NEIGHBOR_DEPTH,
    Math.max(1, typeof args.depth === "number" && Number.isFinite(args.depth) ? Math.floor(args.depth) : 1),
  );
  const limit = clampLimit(args.limit, MAX_LIST_LIMIT);
  const nodesById = new Map(snapshot.nodes.map((record) => [record.id, record]));
  const neighbors: Array<{
    depth: number;
    direction: "in" | "out";
    fromId: string;
    edge: ReturnType<typeof incidentSummary>;
    node: ReturnType<typeof nodeSummary>;
  }> = [];
  const seenNodes = new Set<string>([start.id]);
  let frontier = [start.id];
  let hitLimit = false;
  for (let hop = 1; hop <= depth && !hitLimit; hop++) {
    const next: string[] = [];
    for (const currentId of frontier) {
      for (const edge of snapshot.edges) {
        if (edgeTypes && !edgeTypes.includes(edge.type)) {
          continue;
        }
        let hopDirection: "in" | "out" | undefined;
        let otherId: string | undefined;
        if (edge.from === currentId) {
          hopDirection = "out";
          otherId = edge.to;
        } else if (edge.to === currentId) {
          hopDirection = "in";
          otherId = edge.from;
        }
        if (!hopDirection || !otherId || (direction !== "both" && hopDirection !== direction)) {
          continue;
        }
        if (seenNodes.has(otherId)) {
          continue;
        }
        const other = nodesById.get(otherId);
        if (!other) {
          continue;
        }
        seenNodes.add(otherId);
        next.push(otherId);
        neighbors.push({
          depth: hop,
          direction: hopDirection,
          fromId: currentId,
          edge: incidentSummary(schema, edge),
          node: nodeSummary(schema, other, true),
        });
        if (neighbors.length > limit) {
          hitLimit = true;
          break;
        }
      }
      if (hitLimit) {
        break;
      }
    }
    frontier = next;
  }
  return {
    node: nodeSummary(schema, start, true),
    neighbors: hitLimit ? neighbors.slice(0, limit) : neighbors,
    truncated: hitLimit ? true : undefined,
  };
}

export function graphSnapshot(session: CollabSession, args: GraphSnapshotArgs = {}) {
  return compactSnapshot(session.snapshot(), stringList(args.types), args.includeText === true);
}

export async function graphQuery(
  session: CollabSession,
  args: GraphQueryArgs,
  _options?: BindGraphToolsOptions,
): Promise<QueryResult & { truncated?: true }> {
  const cypher = String(args.cypher ?? "").trim();
  if (!cypher) {
    throw new SchemaError("cypher is required", "cypher");
  }
  if (MUTATING_CYPHER.test(cypher)) {
    throw new SchemaError(
      "graph_query is read-only (MATCH/RETURN). Use upsert_node_*, upsert_edge_*, graph_delete_node, or graph_delete_edge to write.",
      "cypher",
    );
  }
  const limit = clampLimit(args.limit, DEFAULT_HISTORY_LIMIT);
  let result: QueryResult;
  try {
    result = await session.query(cypher, args.params);
  } catch (error) {
    if (error instanceof GraphStoreError || error instanceof SchemaError) {
      throw error;
    }
    throw new SchemaError(error instanceof Error ? error.message : String(error), "cypher");
  }
  const truncated = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).map((row) => {
    const out: QueryResult["rows"][number] = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = mapDeep(value, (item) => snapshotValue(item, false));
    }
    return out;
  });
  return {
    columns: result.columns,
    rows,
    truncated: truncated ? true : undefined,
  };
}

export function graphHistory(session: CollabSession, args: GraphHistoryArgs = {}) {
  const limit = clampLimit(args.limit, DEFAULT_HISTORY_LIMIT);
  const entries = session.history({
    id: typeof args.id === "string" ? args.id : undefined,
    actorId: typeof args.actorId === "string" ? args.actorId : undefined,
    since: typeof args.since === "string" ? args.since : undefined,
    limit: limit + 1,
  });
  const truncated = entries.length > limit;
  return {
    entries: truncated ? entries.slice(-limit) : entries,
    truncated: truncated ? true : undefined,
  };
}

export function graphChanges(session: CollabSession, args: GraphChangesArgs = {}): GraphChangesResult {
  const schema = session.schema;
  const tracking = schema.config.changeTracking;
  const limit = clampLimit(args.limit, DEFAULT_HISTORY_LIMIT);
  const since = typeof args.since === "string" ? args.since : undefined;
  const actorId = typeof args.actorId === "string" ? args.actorId : undefined;
  if (!tracking.enabled) {
    const cursor = new Date().toISOString();
    return { mode: "off", events: [], cursor };
  }
  if (tracking.mode === "history") {
    const listed = graphHistory(session, { since, actorId, limit });
    const snapshot = session.snapshot();
    const events: GraphChangeEvent[] = listed.entries.map((entry) => {
      const node = snapshot.nodes.find((record) => record.id === entry.id);
      const edge = snapshot.edges.find((record) => record.id === entry.id);
      return {
        op: entry.op,
        id: entry.id,
        type: entry.type,
        from: entry.from,
        to: entry.to,
        label: node
          ? nodeLabel(schema, node)
          : edge
            ? edgeLabel(schema, edge)
            : undefined,
        actorId: entry.actorId,
        at: entry.at,
        created: entry.created,
        changes: entry.changes,
      };
    });
    return {
      mode: "history",
      events,
      cursor: events.at(-1)?.at ?? since ?? new Date().toISOString(),
      truncated: listed.truncated === true ? true : undefined,
    };
  }
  const snapshot = session.snapshot();
  const events: GraphChangeEvent[] = [];
  const include = (at: string | undefined, actor: string | undefined) => {
    if (!at) {
      return false;
    }
    if (since && at < since) {
      return false;
    }
    if (actorId && actor !== actorId) {
      return false;
    }
    return true;
  };
  for (const node of snapshot.nodes) {
    const at = node.meta.updatedAt ?? node.meta.createdAt;
    const actor = node.meta.updatedBy ?? node.meta.createdBy;
    if (!include(at, actor)) {
      continue;
    }
    events.push({
      op: "upsertNode",
      id: node.id,
      type: node.type,
      label: nodeLabel(schema, node),
      actorId: actor,
      at,
      created: node.meta.createdAt === node.meta.updatedAt,
    });
  }
  for (const edge of snapshot.edges) {
    const at = edge.meta.updatedAt ?? edge.meta.createdAt;
    const actor = edge.meta.updatedBy ?? edge.meta.createdBy;
    if (!include(at, actor)) {
      continue;
    }
    events.push({
      op: "upsertEdge",
      id: edge.id,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      label: edgeLabel(schema, edge),
      actorId: actor,
      at,
    });
  }
  events.sort((a, b) => {
    if ((a.at ?? "") < (b.at ?? "")) {
      return -1;
    }
    if ((a.at ?? "") > (b.at ?? "")) {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });
  const truncated = events.length > limit;
  const sliced = truncated ? events.slice(-limit) : events;
  return {
    mode: "last-write",
    events: sliced,
    cursor: sliced.at(-1)?.at ?? since ?? new Date().toISOString(),
    deletesOmitted: true,
    truncated: truncated ? true : undefined,
  };
}

export function graphActors(session: CollabSession): GraphActorsResult {
  const counts = new Map<string, { lastAt?: string; nodes: number; edges: number }>();
  const touch = (actorId: string | undefined, at: string | undefined, kind: "node" | "edge") => {
    if (!actorId) {
      return;
    }
    const current = counts.get(actorId) ?? { lastAt: undefined, nodes: 0, edges: 0 };
    if (kind === "node") {
      current.nodes += 1;
    } else {
      current.edges += 1;
    }
    if (at && (!current.lastAt || at > current.lastAt)) {
      current.lastAt = at;
    }
    counts.set(actorId, current);
  };
  for (const node of session.snapshot().nodes) {
    touch(node.meta.updatedBy ?? node.meta.createdBy, node.meta.updatedAt ?? node.meta.createdAt, "node");
  }
  for (const edge of session.snapshot().edges) {
    touch(edge.meta.updatedBy ?? edge.meta.createdBy, edge.meta.updatedAt ?? edge.meta.createdAt, "edge");
  }
  const actors = [...counts.entries()]
    .map(([actorId, info]) => ({ actorId, ...info }))
    .sort((a, b) => a.actorId.localeCompare(b.actorId));
  return { sessionActorId: session.actorId, actors };
}

export async function upsertGraphNode(
  session: CollabSession,
  input: UpsertNodeInput,
  options?: MutationOptions,
): Promise<GraphNodeWriteResult> {
  const before = existingNodeId(session, input);
  const id = await session.upsertNode(input, options);
  const node = session.snapshot().nodes.find((record) => record.id === id);
  if (!node) {
    throw new SchemaError(`upsert of ${input.type} did not produce a node`, "id");
  }
  const properties = { ...node.properties };
  const defs = crdtProperties(session.schema.nodes[node.type]);
  for (const [name, kind] of Object.entries(defs)) {
    if (kind === "text") {
      properties[name] = session.collabText(node.id, name).toString();
    }
  }
  const warnings: string[] = [];
  if (!before) {
    for (const [name, kind] of Object.entries(defs)) {
      if (kind === "text" && !String(properties[name] ?? "").trim()) {
        warnings.push(
          `${name} is empty. Pass ${name} as a string on this tool to fill the live text; chat text is not stored.`,
        );
      }
    }
  }
  return {
    created: !before,
    id: node.id,
    type: node.type,
    label: nodeLabel(session.schema, node),
    properties,
    tags: node.tags,
    meta: node.meta,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function existingNodeId(session: CollabSession, input: UpsertNodeInput): boolean {
  const snap = session.snapshot();
  const minted = identityIdFromFields(session.schema, input.type, input.properties);
  if (minted && snap.nodes.some((node) => node.id === minted)) {
    return true;
  }
  if (input.id) {
    return snap.nodes.some((node) => node.id === input.id);
  }
  // Same near-miss adoption upsertNode performs, so a note reached by a
  // misheard title reports as updated rather than created.
  return normalizedIdentityMatch(session.schema, snap, input.type, input.properties) !== undefined;
}

export async function upsertGraphEdge(
  session: CollabSession,
  input: UpsertGraphEdgeInput,
  options?: MutationOptions,
): Promise<GraphEdgeWriteResult> {
  const from = resolveNodeRef(session, input.from);
  const to = resolveNodeRef(session, input.to);
  const snap = session.snapshot();
  const existed = input.id
    ? snap.edges.some((edge) => edge.id === input.id)
    : snap.edges.some((edge) => {
        if (edge.type !== input.type) {
          return false;
        }
        if (edge.from === from && edge.to === to) {
          return true;
        }
        return session.schema.edges[input.type]?.directed === false && edge.from === to && edge.to === from;
      });
  const id = await session.upsertEdge(
    {
      type: input.type,
      id: input.id,
      from,
      to,
      properties: input.properties ? omitUndefined(input.properties) : undefined,
    },
    options,
  );
  const edge = session.snapshot().edges.find((record) => record.id === id);
  if (!edge) {
    throw new SchemaError(`upsert of ${input.type} did not produce an edge`, "id");
  }
  return {
    created: !existed,
    id: edge.id,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    label: edgeLabel(session.schema, edge),
    properties: edge.properties,
    meta: edge.meta,
  };
}

export async function deleteGraphNode(
  session: CollabSession,
  args: { id: string },
  options?: MutationOptions,
): Promise<GraphDeleteResult> {
  const snapshot = session.snapshot();
  const node = requireNode(snapshot, session.schema, String(args.id));
  const cascadedEdges = snapshot.edges.filter(
    (edge) => edge.from === node.id || edge.to === node.id,
  ).length;
  await session.deleteNode(node.id, options);
  return {
    deleted: node.id,
    existed: true,
    kind: "node",
    type: node.type,
    cascadedEdges,
  };
}

export async function deleteGraphEdge(
  session: CollabSession,
  args: { id: string },
  options?: MutationOptions,
): Promise<GraphDeleteResult> {
  const edge = requireEdge(session.snapshot(), session.schema, String(args.id));
  await session.deleteEdge(edge.id, options);
  return {
    deleted: edge.id,
    existed: true,
    kind: "edge",
    type: edge.type,
  };
}

export async function graphApplyBatch(
  session: CollabSession,
  args: { ops: import("./session.js").GraphOpInput[] },
  options?: MutationOptions,
): Promise<import("./session.js").ApplyOpsResult> {
  return session.applyBatch(args.ops, options);
}

export function graphDiffSince(
  session: CollabSession,
  args: { previousSnapshot: GraphSnapshot },
) {
  return session.diffSince(args.previousSnapshot);
}

export function bindGraphTools(session: CollabSession, options: BindGraphToolsOptions = {}) {
  return {
    graphDescribe: () => graphDescribe(session),
    graphGet: (args: GraphGetArgs) => graphGet(session, args),
    graphSearch: (args?: GraphSearchArgs) => graphSearch(session, args),
    graphSimilar: (args: GraphSimilarArgs) => graphSimilar(session, args),
    graphList: (args?: GraphListArgs) => graphList(session, args),
    graphNeighbors: (args: GraphNeighborsArgs) => graphNeighbors(session, args),
    graphSnapshot: (args?: GraphSnapshotArgs) => graphSnapshot(session, args),
    graphQuery: (args: GraphQueryArgs) => graphQuery(session, args, options),
    graphHistory: (args?: GraphHistoryArgs) => graphHistory(session, args),
    graphChanges: (args?: GraphChangesArgs) => graphChanges(session, args),
    graphActors: () => graphActors(session),
    graphApplyBatch: (args: { ops: import("./session.js").GraphOpInput[] }, mutation?: MutationOptions) =>
      graphApplyBatch(session, args, mutation),
    graphDiffSince: (args: { previousSnapshot: GraphSnapshot }) =>
      graphDiffSince(session, args),
    upsertGraphNode: (input: UpsertNodeInput, mutation?: MutationOptions) =>
      upsertGraphNode(session, input, mutation),
    upsertGraphEdge: (input: UpsertGraphEdgeInput, mutation?: MutationOptions) =>
      upsertGraphEdge(session, input, mutation),
    deleteGraphNode: (args: { id: string }, mutation?: MutationOptions) =>
      deleteGraphNode(session, args, mutation),
    deleteGraphEdge: (args: { id: string }, mutation?: MutationOptions) =>
      deleteGraphEdge(session, args, mutation),
  };
}

export type BoundGraphTools = ReturnType<typeof bindGraphTools>;
