import type { GraphOp } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import type { LoroDoc, OpId, TreeID } from "loro-crdt";
import {
  ROOT_KEY,
  edgeRecordOf,
  edgesMap,
  entityAt,
  nodeRecordOf,
  nodesMap,
  rootMap,
} from "./doc.js";

interface Touched {
  nodes: Set<string>;
  edges: Set<string>;
  removedNodes: Set<string>;
  removedEdges: Set<string>;
}

function emptyTouched(): Touched {
  return {
    nodes: new Set(),
    edges: new Set(),
    removedNodes: new Set(),
    removedEdges: new Set(),
  };
}

interface MapLikeDiff {
  type?: string;
  updated?: Record<string, unknown>;
}

/**
 * Which nodes and edges differ between two versions.
 *
 * Loro reports the change per *container*, and a container's path already says
 * which entity it belongs to — `["collabnode", "nodes", "n1", "properties"]`.
 * That is the whole trick: the cost is proportional to what changed rather than
 * to the size of the graph, which is what a snapshot-to-snapshot diff can never
 * be.
 */
/**
 * Which of `nodes`/`edges` a container path belongs to, and which entity.
 *
 * `undefined` for a path this backend did not write, and for a container with no
 * path at all — the latter means it is gone from the document tree, and the
 * parent map's own diff carries that removal, so there is nothing to read here.
 */
function locate(
  path: (string | number | TreeID)[] | undefined,
): { scope: "nodes" | "edges"; id: string | undefined } | undefined {
  if (!path || path.length < 2 || path[0] !== ROOT_KEY) {
    return undefined;
  }
  const scope = path[1];
  if (scope !== "nodes" && scope !== "edges") {
    return undefined;
  }
  const id = path.length > 2 ? path[2] : undefined;
  return { scope, id: typeof id === "string" ? id : undefined };
}

/**
 * Entities appearing and disappearing in the `nodes` or `edges` map.
 *
 * A key present with an `undefined` value is a delete. An absent key is not:
 * reading this with `for...in` over defined values only would lose every
 * deletion in the span.
 */
function readMapDiff(diff: unknown, changed: Set<string>, removed: Set<string>): void {
  const updated = (diff as MapLikeDiff).updated ?? {};
  for (const key of Object.keys(updated)) {
    if (updated[key] === undefined) {
      removed.add(key);
    } else {
      changed.add(key);
    }
  }
}

function touchedBetween(doc: LoroDoc, from: OpId[], to: OpId[]): Touched {
  const touched = emptyTouched();
  for (const [containerId, diff] of doc.diff(from, to, false)) {
    const at = locate(doc.getPathToContainer(containerId));
    if (!at) {
      continue;
    }
    const changed = at.scope === "nodes" ? touched.nodes : touched.edges;
    const removed = at.scope === "nodes" ? touched.removedNodes : touched.removedEdges;
    if (at.id === undefined) {
      readMapDiff(diff, changed, removed);
    } else {
      changed.add(at.id);
    }
  }
  // An entity both written and removed in the same span is removed: the map
  // diff is the authority on whether it still exists.
  for (const id of touched.removedNodes) {
    touched.nodes.delete(id);
  }
  for (const id of touched.removedEdges) {
    touched.edges.delete(id);
  }
  return touched;
}

/**
 * The ops that carry a projection from `from` to `to`.
 *
 * Changed entities are read out of current state rather than reconstructed from
 * the diff. A `GraphStore` applies upserts idempotently, so "here is what this
 * node looks like now" is both simpler and more robust than replaying a
 * property-level delta — and it is still linear in *changed* entities, which is
 * the only thing that matters.
 *
 * Emission order matches `diffSnapshots`, so a store cannot tell which backend
 * produced the batch.
 */
export function opsBetween(
  doc: LoroDoc,
  schema: GraphSchema,
  from: OpId[],
  to: OpId[],
): GraphOp[] {
  const touched = touchedBetween(doc, from, to);
  const root = rootMap(doc);
  const nodes = nodesMap(root);
  const edges = edgesMap(root);

  return [
    ...[...touched.nodes].map((id) => nodeOp(nodes, id, schema)),
    ...[...touched.removedNodes].map((id): GraphOp => ({ kind: "deleteNode", id })),
    ...[...touched.edges].map((id) => edgeOp(edges, id)),
    ...[...touched.removedEdges].map((id): GraphOp => ({ kind: "deleteEdge", id })),
  ];
}

function nodeOp(
  nodes: ReturnType<typeof nodesMap>,
  id: string,
  schema: GraphSchema,
): GraphOp {
  const entity = entityAt(nodes, id);
  if (!entity) {
    // Present in the diff but gone now: something removed it after `to`.
    return { kind: "deleteNode", id };
  }
  const record = nodeRecordOf(id, entity, schema);
  return {
    kind: "upsertNode",
    id: record.id,
    type: record.type,
    properties: record.properties,
    tags: record.tags,
    meta: record.meta,
  };
}

function edgeOp(edges: ReturnType<typeof edgesMap>, id: string): GraphOp {
  const entity = entityAt(edges, id);
  if (!entity) {
    return { kind: "deleteEdge", id };
  }
  const record = edgeRecordOf(id, entity);
  return {
    kind: "upsertEdge",
    id: record.id,
    type: record.type,
    from: record.from,
    to: record.to,
    properties: record.properties,
    meta: record.meta,
  };
}
