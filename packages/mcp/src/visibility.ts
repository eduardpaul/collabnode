import type {
  CollabSession,
  GraphChangesResult,
  GraphDescribeResult,
  GraphListResult,
  GraphSearchResult,
  graphGet,
  graphHistory,
  graphNeighbors,
  graphSnapshot,
} from "@collabnode/runtime";
import { resolveEntity } from "@collabnode/runtime";
import { SchemaError, type NodeAccessPolicy } from "@collabnode/schema";

type Snapshot = ReturnType<CollabSession["snapshot"]>;
type GetResult = ReturnType<typeof graphGet>;
type NeighborsResult = ReturnType<typeof graphNeighbors>;
type SnapshotResult = ReturnType<typeof graphSnapshot>;
type HistoryResult = ReturnType<typeof graphHistory>;

/**
 * `graph_describe` with each visible-but-unwritable node type marked, so a role
 * that can read `Decision` but has no `upsert_node_Decision` learns why from the
 * contract instead of from a failed call.
 */
export type DescribeView = Omit<GraphDescribeResult, "nodes"> & {
  nodes: Record<string, GraphDescribeResult["nodes"][string] & { readOnly?: true }>;
};

/**
 * The messages a hidden node answers with. Deliberately the runtime's own
 * wording, and deliberately *not* localized: a policy-specific or
 * locale-specific error would let a role tell "you may not see this" apart from
 * "this does not exist", which is the whole distinction `hidden` exists to erase.
 */
export function unknownIdError(id: string): Error {
  return new SchemaError(`unknown id: ${id}`, "id");
}

export function noNodeMatchesError(ref: unknown): Error {
  return new SchemaError(`no node matches ${JSON.stringify(ref)}`, "id");
}

/** Ids of the nodes this role cannot see, for the current snapshot. */
export function hiddenNodeIds(snapshot: Snapshot, policy: NodeAccessPolicy): Set<string> {
  const ids = new Set<string>();
  if (policy.hidden.size === 0) {
    return ids;
  }
  for (const node of snapshot.nodes) {
    if (policy.isHidden(node.type)) {
      ids.add(node.id);
    }
  }
  return ids;
}

/**
 * An edge is visible only when both of its endpoints are. An endpoint that is
 * missing from the snapshot (its node was deleted) counts as hidden when the
 * edge type could have reached a hidden type at all — the conservative read,
 * since the alternative is disclosing that *something* hidden was there.
 */
export function edgeVisible(
  edge: { type: string; from: string; to: string },
  snapshot: Snapshot,
  hidden: Set<string>,
  policy: NodeAccessPolicy,
): boolean {
  if (policy.isEdgeHidden(edge.type)) {
    return false;
  }
  if (hidden.has(edge.from) || hidden.has(edge.to)) {
    return false;
  }
  if (!policy.edgeTouchesHidden(edge.type)) {
    return true;
  }
  const known = (id: string) => snapshot.nodes.some((node) => node.id === id);
  return known(edge.from) && known(edge.to);
}

/** The snapshot as this role may see it: hidden nodes and their edges removed. */
export function visibleSnapshot(snapshot: Snapshot, policy: NodeAccessPolicy): Snapshot {
  if (policy.hidden.size === 0) {
    return snapshot;
  }
  const hidden = hiddenNodeIds(snapshot, policy);
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => !policy.isHidden(node.type)),
    edges: snapshot.edges.filter((edge) => edgeVisible(edge, snapshot, hidden, policy)),
  };
}

/**
 * Resolves an id — exact, or the unique-prefix form the graph tools accept —
 * against the part of the graph this role can see.
 *
 * Resolving against the filtered snapshot rather than checking the result
 * afterwards also closes the prefix probe: a two-node match where one node is
 * hidden must read as one match, not as `ambiguous id prefix` naming a node the
 * caller is not allowed to know about.
 */
export function resolveVisible(
  session: CollabSession,
  policy: NodeAccessPolicy,
  id: string,
  kinds: Array<"node" | "edge"> = ["node", "edge"],
): { kind: "node"; id: string } | { kind: "edge"; id: string } {
  const resolved = resolveEntity(visibleSnapshot(session.snapshot(), policy), session.schema, id, kinds);
  return resolved.kind === "node"
    ? { kind: "node", id: resolved.node.id }
    : { kind: "edge", id: resolved.edge.id };
}

/** The node type behind an id, or undefined when the snapshot has no such node. */
export function nodeTypeOf(session: CollabSession, id: string): string | undefined {
  return session.snapshot().nodes.find((node) => node.id === id)?.type;
}

/**
 * Narrows a caller's `types` argument to what this role may see. `empty` means
 * every requested type was hidden: the caller has to short-circuit, because an
 * empty list reads as "no filter" to the runtime tools and would show everything.
 */
export function narrowTypes(
  requested: string[] | undefined,
  policy: NodeAccessPolicy,
): { types: string[] | undefined; empty: boolean } {
  if (policy.hidden.size === 0) {
    return { types: requested, empty: false };
  }
  if (requested && requested.length > 0) {
    const types = requested.filter((type) => !policy.isHidden(type));
    return { types, empty: types.length === 0 };
  }
  const types = [...policy.visibleNodeTypes];
  return { types, empty: types.length === 0 };
}

export function emptyList(offset: number, limit: number): GraphListResult {
  return { nodes: [], total: 0, offset, limit };
}

export function filterDescribe(
  result: GraphDescribeResult,
  policy: NodeAccessPolicy,
): DescribeView {
  const nodes: DescribeView["nodes"] = {};
  for (const [type, def] of Object.entries(result.nodes)) {
    if (policy.isHidden(type)) {
      continue;
    }
    nodes[type] = policy.canWrite(type) ? def : { ...def, readOnly: true };
  }
  const edges: GraphDescribeResult["edges"] = {};
  for (const [type, def] of Object.entries(result.edges)) {
    if (policy.isEdgeHidden(type)) {
      continue;
    }
    edges[type] = {
      ...def,
      from: def.from.filter((t) => !policy.isHidden(t)),
      to: def.to.filter((t) => !policy.isHidden(t)),
    };
  }
  // The contract must not advertise doors this role does not have: no Cypher for
  // a concealing role, and no writes at all for a passive one.
  const reads = policy.hidden.size > 0
    ? result.reads.filter((tool) => tool !== "graph_query")
    : result.reads;
  const writes = policy.anyWritable ? result.writes : [];
  return { ...result, nodes, edges, reads, writes };
}

export function filterGet(
  result: GetResult,
  session: CollabSession,
  policy: NodeAccessPolicy,
): GetResult {
  const snapshot = session.snapshot();
  const hidden = hiddenNodeIds(snapshot, policy);
  if (result.kind === "node") {
    return {
      ...result,
      incident: result.incident.filter((edge) => edgeVisible(edge, snapshot, hidden, policy)),
    };
  }
  return {
    ...result,
    incident: result.incident.filter((end) => !hidden.has(end.id)),
  };
}

export function filterNeighbors(
  result: NeighborsResult,
  session: CollabSession,
  policy: NodeAccessPolicy,
): NeighborsResult {
  const snapshot = session.snapshot();
  const hidden = hiddenNodeIds(snapshot, policy);
  // Dropping hops that *depart* from a hidden node, not just hops that land on
  // one, is what keeps a hidden node from leaking as the `fromId` of whatever
  // sits behind it at depth 2.
  const neighbors = result.neighbors.filter(
    (hop) =>
      !hidden.has(hop.node.id) &&
      !hidden.has(hop.fromId) &&
      edgeVisible(hop.edge, snapshot, hidden, policy),
  );
  return { ...result, neighbors };
}

export function filterSnapshot(
  result: SnapshotResult,
  session: CollabSession,
  policy: NodeAccessPolicy,
): SnapshotResult {
  // `types` narrowing is not enough here: compactSnapshot pulls in the endpoint
  // nodes of every edge it keeps, so a hidden neighbour rides along uninvited.
  const snapshot = session.snapshot();
  const hidden = hiddenNodeIds(snapshot, policy);
  return {
    ...result,
    nodes: result.nodes.filter((node) => !policy.isHidden(node.type)),
    edges: result.edges.filter((edge) => edgeVisible(edge, snapshot, hidden, policy)),
  };
}

export function filterSearch(
  result: GraphSearchResult,
  policy: NodeAccessPolicy,
): GraphSearchResult {
  const nodes = result.nodes.filter((node) => !policy.isHidden(node.type));
  if (nodes.length === result.nodes.length) {
    return result;
  }
  return { ...result, nodes, total: Math.max(0, result.total - (result.nodes.length - nodes.length)) };
}

function entryVisible(
  entry: { type?: string; from?: string; to?: string },
  snapshot: Snapshot,
  hidden: Set<string>,
  policy: NodeAccessPolicy,
): boolean {
  if (!entry.type) {
    return true;
  }
  if (policy.isHidden(entry.type)) {
    return false;
  }
  if (entry.from !== undefined && entry.to !== undefined) {
    return edgeVisible({ type: entry.type, from: entry.from, to: entry.to }, snapshot, hidden, policy);
  }
  return true;
}

export function filterHistory(
  result: HistoryResult,
  session: CollabSession,
  policy: NodeAccessPolicy,
): HistoryResult {
  const snapshot = session.snapshot();
  const hidden = hiddenNodeIds(snapshot, policy);
  return {
    ...result,
    entries: result.entries.filter((entry) => entryVisible(entry, snapshot, hidden, policy)),
  };
}

export function filterChanges(
  result: GraphChangesResult,
  session: CollabSession,
  policy: NodeAccessPolicy,
): GraphChangesResult {
  const snapshot = session.snapshot();
  const hidden = hiddenNodeIds(snapshot, policy);
  return {
    ...result,
    events: result.events.filter((event) => entryVisible(event, snapshot, hidden, policy)),
  };
}
