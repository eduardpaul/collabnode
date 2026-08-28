import type { GraphPlan, PlanEdge, PlanNode } from "@collabnode/mcp";
import type { CollabSession } from "@collabnode/runtime";
import type { AnyGraph, EdgeNameOf, GraphTypeMap, NodeNameOf } from "@collabnode/schema";

/**
 * Writing a plan into the graph.
 *
 * `planZod` says what an agent may answer; this says what happens to the
 * answer. The two are the halves of one idea, and everything here is a
 * consequence of the plan format rather than of any particular workspace:
 * entries are resolved by handle, never by title, and one bad endpoint costs
 * one edge instead of the whole turn.
 */

export interface ApplyPlanOptions<
  S extends GraphTypeMap = AnyGraph,
  N extends NodeNameOf<S> = NodeNameOf<S>,
> {
  /** Actor the writes are attributed to, for history and change tracking. */
  actorId?: string;
  /** Properties written over whatever the model said, per node type. */
  stamp?: { [T in N]?: Partial<S["nodes"][T]["input"]> };
  /**
   * Last look at one entry's properties before they are written, with nulls
   * already dropped. Return `undefined` to leave the entry out entirely —
   * which is how an app rejects a node it considers unusable. `stamp` is
   * applied after this, so a stamped property always wins.
   */
  transform?: (
    node: PlanNode<S, N>,
    properties: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  /** Ids of edges to delete in the same batch — the only way to re-parent. */
  removeEdges?: readonly string[];
}

export interface ApplyPlanResult {
  /** Graph id per plan `ref`, for anything the caller has to follow up on. */
  idsByRef: Record<string, string>;
  created: number;
  updated: number;
  edges: number;
  /** Edges dropped because an endpoint was neither a plan ref nor a live id. */
  droppedEdges: string[];
}

/**
 * Writes a plan as one atomic batch.
 *
 * Endpoints resolve in one direction only: a plan `ref` first, then an id that
 * is actually in the graph. Anything else is dropped and reported — a
 * hallucinated endpoint costs one edge, not the whole turn.
 */
export async function applyPlan<
  S extends GraphTypeMap = AnyGraph,
  N extends NodeNameOf<S> = NodeNameOf<S>,
  E extends EdgeNameOf<S> = EdgeNameOf<S>,
>(
  session: CollabSession<S>,
  plan: GraphPlan<S, N, E>,
  options: ApplyPlanOptions<S, N> = {},
): Promise<ApplyPlanResult> {
  const snapshot = session.snapshot();
  const liveIds = new Set(snapshot.nodes.map((n) => n.id));
  const liveEdgeIds = new Set(snapshot.edges.map((e) => e.id));
  const nodes: PlanNode<S, N>[] = Array.isArray(plan.nodes) ? plan.nodes : [];
  const edges: PlanEdge<S, E>[] = Array.isArray(plan.edges) ? plan.edges : [];

  const writable = (node: PlanNode<S, N>): Record<string, unknown> | undefined => {
    const properties = options.transform
      ? options.transform(node, omitNull(node.properties))
      : omitNull(node.properties);
    if (!properties) {
      return undefined;
    }
    const stamp = options.stamp?.[node.type as N];
    return stamp ? { ...properties, ...stamp } : properties;
  };

  /**
   * The entries that will actually be written, one per `ref`.
   *
   * Both halves matter to `resolve`: a duplicate `ref` must name one node, not
   * two, and a node `transform` dropped must not stay referenceable — an edge
   * pointing at either would resolve to a `{ ref }` the batch never declares,
   * which fails the whole batch rather than the one edge it should cost.
   */
  const byRef = new Map<string, { id?: string; node: PlanNode<S, N>; properties: Record<string, unknown> }>();
  const writes: Array<{ ref: string; id?: string; node: PlanNode<S, N>; properties: Record<string, unknown> }> = [];
  for (const node of nodes) {
    if (!node?.ref || byRef.has(node.ref)) continue;
    const properties = writable(node);
    if (!properties) continue;
    const entry = {
      id: typeof node.id === "string" && liveIds.has(node.id) ? node.id : undefined,
      node,
      properties,
    };
    byRef.set(node.ref, entry);
    writes.push({ ref: node.ref, ...entry });
  }

  const resolve = (endpoint: unknown): string | { ref: string } | undefined => {
    const handle = typeof endpoint === "string" ? endpoint.trim() : "";
    if (!handle) return undefined;
    const pending = byRef.get(handle);
    if (pending) return pending.id ?? { ref: handle };
    return liveIds.has(handle) ? handle : undefined;
  };

  const droppedEdges: string[] = [];
  let created = 0;
  let updated = 0;
  let written = 0;


  type Builder = Parameters<Parameters<CollabSession<S>["batch"]>[0]>[0];

  const writeEdges = (b: Builder): number => {
    let count = 0;
    for (const edge of edges) {
      const from = resolve(edge?.from);
      const to = resolve(edge?.to);
      if (!from || !to) {
        droppedEdges.push(`${edge?.type ?? "?"}: ${String(edge?.from)} → ${String(edge?.to)}`);
        continue;
      }
      count++;
      b.upsertEdge({
        type: edge.type,
        from,
        to,
        properties: edge.properties ? omitNull(edge.properties) : undefined,
      } as Parameters<typeof b.upsertEdge>[0]);
    }
    for (const edgeId of options.removeEdges ?? []) {
      if (typeof edgeId === "string" && liveEdgeIds.has(edgeId)) {
        b.deleteEdge(edgeId);
      }
    }
    return count;
  };

  const result = await session.batch(
    (b) => {
      for (const entry of writes) {
        // `node.type` is only known at runtime here, so the pairing of type and
        // properties cannot be re-proved to the compiler while iterating a
        // heterogeneous array. The plan that produced these entries was checked
        // against the schema; this is the one place that check is spent.
        const write = {
          type: entry.node.type,
          properties: entry.properties,
        } as Parameters<typeof b.upsertNode>[0];
        if (entry.id) {
          updated++;
          b.upsertNode({ ...write, id: entry.id }, entry.ref);
        } else {
          created++;
          b.upsertNode(write, entry.ref);
        }
      }

      written += writeEdges(b);
    },
    { actorId: options.actorId },
  );

  return { idsByRef: result.refs, created, updated, edges: written, droppedEdges };
}

/** Strict mode says "no value" with `null`; the graph says it by not writing the key. */
export function omitNull(properties: unknown): Record<string, unknown> {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
