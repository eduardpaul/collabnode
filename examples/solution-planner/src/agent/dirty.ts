import { snapshotToMarkdown, walk } from "@collabnode/runtime";
import { singletonOfType, type PlannedNode, type PlannerSession } from "./session.ts";

type Snapshot = ReturnType<PlannerSession["snapshot"]>;
type GraphNode = Snapshot["nodes"][number];
type GraphEdge = Snapshot["edges"][number];

const HUMAN_ACTOR = "human-user";

/** Edges that walk down the planning hierarchy (and onto linked governance). */
const DOWNSTREAM_EDGE_TYPES = new Set([
  "HAS_FEATURE",
  "HAS_TASK",
  "HAS_RISK",
  "HAS_ASSUMPTION",
  "CONTAINS",
  "USES",
  "TARGETS_C4",
]);

export function isDirty(node: GraphNode): boolean {
  // `SolutionState` is the one node type with no `dirty` flag: it holds the
  // run's status rather than anything a human plans, so it is never revised.
  return "dirty" in node.properties && node.properties.dirty === true;
}

export function dirtyNodes(snapshot: Snapshot): PlannedNode[] {
  return snapshot.nodes.filter(
    (n): n is PlannedNode => n.type !== "SolutionState" && isDirty(n),
  );
}

export function descendantIds(snapshot: Snapshot, rootId: string): string[] {
  return walk(snapshot, rootId, {
    edgeTypes: [...DOWNSTREAM_EDGE_TYPES],
    direction: "out",
  }).hops.map((hop) => hop.node.id);
}

export function parentId(snapshot: Snapshot, nodeId: string): string | undefined {
  return walk(snapshot, nodeId, {
    edgeTypes: [...DOWNSTREAM_EDGE_TYPES],
    direction: "in",
    depth: 1,
  }).hops[0]?.node.id;
}

export interface RevisionSet {
  dirty: GraphNode[];
  context: GraphNode[];
  edges: GraphEdge[];
}

export function collectRevisionSet(snapshot: Snapshot): RevisionSet {
  const dirty = dirtyNodes(snapshot);
  const dirtyIds = new Set(dirty.map((n) => n.id));
  const edges = snapshot.edges.filter((e) => dirtyIds.has(e.from) || dirtyIds.has(e.to));
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (!dirtyIds.has(edge.from)) neighborIds.add(edge.from);
    if (!dirtyIds.has(edge.to)) neighborIds.add(edge.to);
  }
  const context = snapshot.nodes.filter((n) => neighborIds.has(n.id) && n.type !== "SolutionState");
  return { dirty, context, edges };
}

export function formatUserReviewGuidance(message: string | undefined, isEs: boolean): string {
  const text = message?.trim();
  if (!text) {
    return "";
  }
  return isEs
    ? `\n\n## Nota del usuario para esta revisión\n"${text}"\n\nTrata esta nota como contexto adicional al adaptar los nodos sucios y sus relaciones.`
    : `\n\n## User note for this revision\n"${text}"\n\nTreat this note as additional guidance when adapting the dirty nodes and their relationships.`;
}

export function formatRevisionContext(snapshot: Snapshot): string {
  const dirty = dirtyNodes(snapshot);
  if (dirty.length === 0) {
    return "*(No dirty nodes)*";
  }
  return snapshotToMarkdown(snapshot, {
    ids: dirty.map((n) => n.id),
    includeNeighbors: true,
  });
}

export async function breakConsensus(
  session: PlannerSession,
  actorId: string = HUMAN_ACTOR,
): Promise<void> {
  // `status` has to come down with the agreement flags. Clearing the flags
  // alone leaves the header reading "Consensus Approved" next to two agents
  // reporting "Reviewing..." and a dirty badge — the board contradicting
  // itself. A pending validation is already not-approved, so it stays put.
  const state = singletonOfType(session.snapshot(), "SolutionState");
  const status = state?.properties.status === "approved" ? "planning" : undefined;

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        managerAgrees: false,
        architectAgrees: false,
        ...(status ? { status } : {}),
      },
    },
    { actorId },
  );
}

export async function markDirtyAndCascade(
  session: PlannerSession,
  nodeId: string,
  options?: { actorId?: string },
): Promise<void> {
  const actorId = options?.actorId ?? HUMAN_ACTOR;
  const snapshot = session.snapshot();
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === "SolutionState") {
    return;
  }

  const ids = [nodeId, ...descendantIds(snapshot, nodeId)];
  const toMark = ids
    .map((id) => snapshot.nodes.find((n) => n.id === id))
    .filter((n): n is PlannedNode => n !== undefined && n.type !== "SolutionState" && !isDirty(n));

  if (toMark.length > 0) {
    await session.batch((b) => {
      for (const n of toMark) {
        b.upsertNode({
          id: n.id,
          type: n.type,
          properties: { dirty: true },
        });
      }
    }, { actorId });
  }

  await breakConsensus(session, actorId);
}

export async function markParentDirtyOnDelete(
  session: PlannerSession,
  nodeId: string,
  options?: { actorId?: string },
): Promise<void> {
  const parent = parentId(session.snapshot(), nodeId);
  if (parent) {
    await markDirtyAndCascade(session, parent, options);
  }
}

export async function clearDirty(
  session: PlannerSession,
  options?: { actorId?: string },
): Promise<void> {
  const actorId = options?.actorId ?? "system";
  const snapshot = session.snapshot();
  const marked = dirtyNodes(snapshot);
  if (marked.length === 0) {
    return;
  }

  await session.batch((b) => {
    for (const node of marked) {
      b.upsertNode({
        id: node.id,
        type: node.type,
        properties: { dirty: false },
      });
    }
  }, { actorId });
}
