import type {
  AnyGraph,
  EdgeNameOf,
  GraphTypeMap,
  NodeNameOf,
  PropertyMap,
} from "@collabnode/schema";

// Declared in `@collabnode/schema` because the generic write shapes there are
// stated in terms of them; re-exported here because this is where every caller
// has always imported them from.
export type { AnyGraph, GraphTypeMap, PropertyMap, PropertyValue } from "@collabnode/schema";

export interface Provenance {
  actorId: string;
  at: string;
}

export interface EntityMeta {
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface NodeRecordOf<S extends GraphTypeMap, T extends NodeNameOf<S>> {
  id: string;
  type: T;
  properties: S["nodes"][T]["props"];
  tags?: string[];
  meta: EntityMeta;
}

/**
 * One node, as it comes back from a snapshot.
 *
 * Over a known schema this is a union discriminated on `type`, so
 * `nodes.find((n) => n.type === "Epic")` narrows `properties` to that type's
 * own shape with no cast. `T extends unknown` is what distributes it: without
 * that the result would be one record whose `type` and `properties` are
 * independent unions, and every node would appear to have every property.
 */
export type GraphNodeRecord<
  S extends GraphTypeMap = AnyGraph,
  T extends NodeNameOf<S> = NodeNameOf<S>,
> = T extends unknown ? NodeRecordOf<S, T> : never;

interface EdgeRecordOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> {
  id: string;
  type: T;
  from: string;
  to: string;
  properties: S["edges"][T]["props"];
  meta: EntityMeta;
}

export type GraphEdgeRecord<
  S extends GraphTypeMap = AnyGraph,
  T extends EdgeNameOf<S> = EdgeNameOf<S>,
> = T extends unknown ? EdgeRecordOf<S, T> : never;

/**
 * The least a helper needs to identify or render one node, whatever workspace it
 * came from.
 *
 * `GraphNodeRecord` over a known schema and over `AnyGraph` are not assignable
 * to each other — a schema's `properties` is an object type with optional keys,
 * `AnyGraph`'s is a `PropertyMap`, and neither contains the other. Read-only
 * helpers take this instead of picking a side, and accept both.
 */
export interface NodeLike {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  tags?: string[];
  meta?: EntityMeta;
}

export interface EdgeLike {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Record<string, unknown>;
  meta?: EntityMeta;
}

/**
 * A snapshot of *some* workspace, for code that only reads it.
 *
 * `GraphSnapshot<AnyGraph>` is not this: its properties are a `PropertyMap`,
 * whose values exclude `undefined`, so a schema-typed snapshot carrying an
 * optional property is not assignable to it. Helpers that walk, render or diff
 * a snapshot without caring whose it is take this instead, and then accept both.
 */
export interface AnySnapshot {
  schemaId: string;
  schemaHash: string;
  nodes: NodeLike[];
  edges: EdgeLike[];
}

export interface GraphSnapshot<S extends GraphTypeMap = AnyGraph> {
  schemaId: string;
  schemaHash: string;
  nodes: GraphNodeRecord<S>[];
  edges: GraphEdgeRecord<S>[];
}

export interface HistoryFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export interface HistoryEntry {
  opId: string;
  op: "upsertNode" | "deleteNode" | "upsertEdge" | "deleteEdge";
  id: string;
  type?: string;
  from?: string;
  to?: string;
  actorId: string;
  at: string;
  /** True when this upsert created the entity. Distinguishes first-time field sets from creates. */
  created?: boolean;
  fields?: string[];
  changes?: HistoryFieldDiff[];
  summary?: string;
}

export interface HistoryFilter {
  id?: string;
  actorId?: string;
  since?: string;
  limit?: number;
}

export type GraphOp =
  | {
      kind: "upsertNode";
      id: string;
      type: string;
      properties: PropertyMap;
      /** Keys this op writes. Omitted = replace the whole map. */
      patch?: string[];
      tags?: string[];
      meta: EntityMeta;
      provenance?: Provenance;
      history?: HistoryEntry;
    }
  | {
      kind: "deleteNode";
      id: string;
      provenance?: Provenance;
      history?: HistoryEntry;
    }
  | {
      kind: "upsertEdge";
      id: string;
      type: string;
      from: string;
      to: string;
      properties: PropertyMap;
      patch?: string[];
      meta: EntityMeta;
      provenance?: Provenance;
      history?: HistoryEntry;
    }
  | {
      kind: "deleteEdge";
      id: string;
      provenance?: Provenance;
      history?: HistoryEntry;
    };

export interface QueryRow {
  [column: string]: unknown;
}

export interface QueryResult {
  columns: string[];
  rows: QueryRow[];
}

export function emptyMeta(): EntityMeta {
  return {};
}

export function stampMeta(
  existing: EntityMeta | undefined,
  provenance: Provenance | undefined,
  trackingEnabled: boolean,
): EntityMeta {
  if (!trackingEnabled || !provenance) {
    return existing ?? emptyMeta();
  }
  return {
    createdAt: existing?.createdAt ?? provenance.at,
    createdBy: existing?.createdBy ?? provenance.actorId,
    updatedAt: provenance.at,
    updatedBy: provenance.actorId,
  };
}

export function snapshotToOps(snapshot: GraphSnapshot): GraphOp[] {
  const ops: GraphOp[] = [];
  for (const node of snapshot.nodes) {
    ops.push({
      kind: "upsertNode",
      id: node.id,
      type: node.type,
      properties: node.properties,
      tags: node.tags,
      meta: node.meta,
    });
  }
  for (const edge of snapshot.edges) {
    ops.push({
      kind: "upsertEdge",
      id: edge.id,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      properties: edge.properties,
      meta: edge.meta,
    });
  }
  return ops;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sameNode(a: GraphNodeRecord, b: GraphNodeRecord): boolean {
  return (
    a.type === b.type &&
    stable(a.properties) === stable(b.properties) &&
    stable(a.tags ?? []) === stable(b.tags ?? []) &&
    stable(a.meta) === stable(b.meta)
  );
}

function sameEdge(a: GraphEdgeRecord, b: GraphEdgeRecord): boolean {
  return (
    a.type === b.type &&
    a.from === b.from &&
    a.to === b.to &&
    stable(a.properties) === stable(b.properties) &&
    stable(a.meta) === stable(b.meta)
  );
}

export function diffSnapshots(previous: GraphSnapshot, next: GraphSnapshot): GraphOp[] {
  const ops: GraphOp[] = [];
  const prevNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const prevEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));

  for (const [id, node] of nextNodes) {
    const before = prevNodes.get(id);
    if (!before || !sameNode(before, node)) {
      ops.push({
        kind: "upsertNode",
        id: node.id,
        type: node.type,
        properties: node.properties,
        tags: node.tags,
        meta: node.meta,
      });
    }
  }
  for (const id of prevNodes.keys()) {
    if (!nextNodes.has(id)) {
      ops.push({ kind: "deleteNode", id });
    }
  }
  for (const [id, edge] of nextEdges) {
    const before = prevEdges.get(id);
    if (!before || !sameEdge(before, edge)) {
      ops.push({
        kind: "upsertEdge",
        id: edge.id,
        type: edge.type,
        from: edge.from,
        to: edge.to,
        properties: edge.properties,
        meta: edge.meta,
      });
    }
  }
  for (const id of prevEdges.keys()) {
    if (!nextEdges.has(id)) {
      ops.push({ kind: "deleteEdge", id });
    }
  }
  return ops;
}

/** Merge a property patch into an existing map. Cleared keys are in `patch` but omitted from `incoming`. */
export function applyPropertyPatch(
  existing: PropertyMap,
  incoming: PropertyMap,
  patch?: string[],
): PropertyMap {
  if (!patch) {
    return { ...incoming };
  }
  const next: PropertyMap = { ...existing };
  for (const key of patch) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      next[key] = incoming[key]!;
    } else {
      delete next[key];
    }
  }
  return next;
}

export function nodeTags(node: GraphNodeRecord | undefined): string[] {
  return node?.tags ? [...node.tags] : [];
}
