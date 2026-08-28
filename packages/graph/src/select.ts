import type { AnyGraph, GraphNodeRecord, GraphSnapshot, GraphTypeMap } from "./ops.js";
import type { EdgeNameOf, NodeNameOf } from "@collabnode/schema";
import type { GraphEdgeRecord } from "./ops.js";

/**
 * Selecting from a snapshot by type, with the narrowing carried out.
 *
 * Over a known schema `snapshot.nodes` is a union discriminated on `type`, and
 * `filter`/`find` with a plain predicate hand back the whole union: TypeScript
 * has no way to see that the comparison inside the callback decided the element
 * type. Writing the type guard by hand at every call site is noise, so these do
 * it once. Over an untyped graph they behave exactly like the `filter` they
 * replace.
 */

/**
 * Anything discriminated on `type` — a snapshot's nodes or edges, but also a
 * plan's entries, or a diff's.
 */
export interface Typed {
  type: string;
}

/**
 * The members of one type, narrowed.
 *
 * `items.filter((i) => i.type === "Epic")` is already type-safe — comparing
 * against a name the union does not contain is an error — but it hands back the
 * whole union, so reading a property only Epics have still does not compile.
 * This is that filter with the guard attached.
 */
export function ofType<N extends Typed, T extends N["type"]>(
  items: readonly N[],
  type: T,
): Extract<N, { type: T }>[] {
  return items.filter((item): item is Extract<N, { type: T }> => item.type === type);
}

/** The first member of one type, narrowed. */
export function findOfType<N extends Typed, T extends N["type"]>(
  items: readonly N[],
  type: T,
  predicate?: (item: Extract<N, { type: T }>) => boolean,
): Extract<N, { type: T }> | undefined {
  return items.find(
    (item): item is Extract<N, { type: T }> =>
      item.type === type && (!predicate || predicate(item as Extract<N, { type: T }>)),
  );
}

/** One node type's record, with that type's own properties. */
export type NodeOf<S extends GraphTypeMap, T extends NodeNameOf<S>> = Extract<
  GraphNodeRecord<S>,
  { type: T }
>;

/** One edge type's record. */
export type EdgeOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> = Extract<
  GraphEdgeRecord<S>,
  { type: T }
>;

/** Every node of one type. */
export function nodesOfType<S extends GraphTypeMap = AnyGraph, T extends NodeNameOf<S> = NodeNameOf<S>>(
  snapshot: GraphSnapshot<S>,
  type: T,
): NodeOf<S, T>[] {
  return ofType(snapshot.nodes, type as GraphNodeRecord<S>["type"]) as NodeOf<S, T>[];
}

/**
 * One node of a given type, by id.
 *
 * Returns `undefined` when the id is absent *or* names a node of some other
 * type — which is the answer a caller wants either way, and safer than the
 * `find` by id alone it replaces: that one returns a node whose properties the
 * caller then reads as if it were the type they expected.
 */
export function nodeOfType<S extends GraphTypeMap = AnyGraph, T extends NodeNameOf<S> = NodeNameOf<S>>(
  snapshot: GraphSnapshot<S>,
  type: T,
  id: string | null | undefined,
): NodeOf<S, T> | undefined {
  if (!id) {
    return undefined;
  }
  return nodesOfType(snapshot, type).find((node) => node.id === id);
}

/**
 * The one node of a `singleton:` type, if the workspace has it yet.
 *
 * A singleton type has at most one instance — the workspace's status, its
 * settings, its board configuration — so the whole lookup is "the one of
 * those", which every caller otherwise spells as a `find` over every node.
 */
export function singletonOfType<
  S extends GraphTypeMap = AnyGraph,
  T extends NodeNameOf<S> = NodeNameOf<S>,
>(snapshot: GraphSnapshot<S>, type: T): NodeOf<S, T> | undefined {
  return nodesOfType(snapshot, type)[0];
}

/** Every edge of one type. */
export function edgesOfType<S extends GraphTypeMap = AnyGraph, T extends EdgeNameOf<S> = EdgeNameOf<S>>(
  snapshot: GraphSnapshot<S>,
  type: T,
): EdgeOf<S, T>[] {
  return ofType(snapshot.edges, type as GraphEdgeRecord<S>["type"]) as EdgeOf<S, T>[];
}

/** Every node whose type is one of several. */
export function nodesOfTypes<S extends GraphTypeMap = AnyGraph, T extends NodeNameOf<S> = NodeNameOf<S>>(
  snapshot: GraphSnapshot<S>,
  types: readonly T[],
): NodeOf<S, T>[] {
  const wanted = new Set<string>(types);
  return snapshot.nodes.filter((node): node is NodeOf<S, T> => wanted.has(node.type));
}
