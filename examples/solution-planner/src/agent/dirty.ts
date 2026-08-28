import { walk } from "@collabnode/runtime";
import { singletonOfType, type PlannedNode, type PlannerSession } from "./session.ts";

type Snapshot = ReturnType<PlannerSession["snapshot"]>;
type GraphNode = Snapshot["nodes"][number];

const HUMAN_ACTOR = "human-user";

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

export async function breakConsensus(
  session: PlannerSession,
  actorId: string = HUMAN_ACTOR,
): Promise<void> {
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
    await session.batch(
      (b) => {
        for (const n of toMark) {
          b.upsertNode({
            id: n.id,
            type: n.type,
            properties: { dirty: true },
          });
        }
      },
      { actorId },
    );
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
