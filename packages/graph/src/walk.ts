import type {
  AnyGraph,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphSnapshot,
  GraphTypeMap,
} from "./ops.js";

export type WalkDirection = "in" | "out" | "both";

export interface WalkOptions {
  /** Restrict to these edge types. Omit to follow every edge. */
  edgeTypes?: readonly string[];
  /** Default `out` (follow `from` → `to`). */
  direction?: WalkDirection;
  /** Hops from the start node. Default unbounded. */
  depth?: number;
  /** Stop after this many visited neighbors (not counting start). */
  limit?: number;
}

export interface WalkHop<S extends GraphTypeMap = AnyGraph> {
  depth: number;
  direction: "in" | "out";
  fromId: string;
  edge: GraphEdgeRecord<S>;
  node: GraphNodeRecord<S>;
}

export interface WalkResult<S extends GraphTypeMap = AnyGraph> {
  hops: WalkHop<S>[];
  truncated?: true;
}

/**
 * BFS from `startId` over the snapshot. The start node is not included in
 * `hops`. Missing start ids yield an empty result rather than throwing, so
 * callers that already resolved the node (MCP `graph_neighbors`) can require it
 * themselves.
 */
export function walk<S extends GraphTypeMap = AnyGraph>(
  snapshot: GraphSnapshot<S>,
  startId: string,
  options: WalkOptions = {},
): WalkResult<S> {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(startId)) {
    return { hops: [] };
  }

  const edgeTypeSet =
    options.edgeTypes && options.edgeTypes.length > 0 ? new Set(options.edgeTypes) : undefined;
  const direction: WalkDirection = options.direction ?? "out";
  const depth =
    options.depth === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.depth));
  const limit =
    options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));

  if (depth === 0 || limit === 0) {
    return limit === 0 ? { hops: [], truncated: true } : { hops: [] };
  }

  const hops: WalkHop<S>[] = [];
  const seen = new Set<string>([startId]);
  let frontier = [startId];
  let truncated = false;

  for (let hop = 1; hop <= depth && !truncated; hop += 1) {
    const next: string[] = [];
    for (const currentId of frontier) {
      for (const edge of snapshot.edges) {
        if (edgeTypeSet && !edgeTypeSet.has(edge.type)) {
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
        if (seen.has(otherId)) {
          continue;
        }
        const other = nodesById.get(otherId);
        if (!other) {
          continue;
        }
        if (limit !== undefined && hops.length >= limit) {
          truncated = true;
          break;
        }
        seen.add(otherId);
        next.push(otherId);
        hops.push({
          depth: hop,
          direction: hopDirection,
          fromId: currentId,
          edge,
          node: other,
        });
      }
      if (truncated) {
        break;
      }
    }
    if (next.length === 0) {
      break;
    }
    frontier = next;
  }

  return truncated ? { hops, truncated: true } : { hops };
}
