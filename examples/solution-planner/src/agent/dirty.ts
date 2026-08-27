import { snapshotToMarkdown, walk, type CollabSession } from "@collabnode/runtime";

type Snapshot = ReturnType<CollabSession["snapshot"]>;
type GraphNode = Snapshot["nodes"][number];
type GraphEdge = Snapshot["edges"][number];

const HUMAN_ACTOR = "human-user";

/** Edges that walk down the planning hierarchy (and onto linked governance). */
const DOWNSTREAM_EDGE_TYPES = new Set([
  "HAS_FEATURE",
  "HAS_TASK",
  "HAS_RISK",
  "HAS_ASSUMPTION",
  "TARGETS_C4",
]);

const PROPERTY_ALLOWLIST: Record<string, string[]> = {
  Epic: ["title", "description", "priority"],
  Feature: ["title", "description", "epicTitle"],
  C4Model: ["title", "level", "markdown"],
  Task: [
    "title",
    "description",
    "featureTitle",
    "functionalPoints",
    "technicalPoints",
    "complexity",
    "uncertainty",
    "friction",
    "nfrScale",
    "status",
  ],
  Risk: ["title", "description", "severity", "category", "mitigation"],
  Assumption: ["title", "description", "status", "raisedBy", "userComment"],
};

export function isDirty(node: GraphNode): boolean {
  return node.properties.dirty === true;
}

export function dirtyNodes(snapshot: Snapshot): GraphNode[] {
  return snapshot.nodes.filter((n) => n.type !== "SolutionState" && isDirty(n));
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
  session: CollabSession,
  actorId: string = HUMAN_ACTOR,
): Promise<void> {
  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        managerAgrees: false,
        architectAgrees: false,
      },
    },
    { actorId },
  );
}

export async function markDirtyAndCascade(
  session: CollabSession,
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
    .filter((n): n is GraphNode => n !== undefined && n.type !== "SolutionState" && !isDirty(n));

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
  session: CollabSession,
  nodeId: string,
  options?: { actorId?: string },
): Promise<void> {
  const parent = parentId(session.snapshot(), nodeId);
  if (parent) {
    await markDirtyAndCascade(session, parent, options);
  }
}

export async function clearDirty(
  session: CollabSession,
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

export interface RevisionUpdate {
  id?: unknown;
  properties?: unknown;
}

export interface RevisionCreate {
  type?: unknown;
  properties?: unknown;
  link?: unknown;
}

export interface RevisionWrites {
  updates?: RevisionUpdate[];
  creates?: RevisionCreate[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickAllowed(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const allow = PROPERTY_ALLOWLIST[type];
  if (!allow) return {};
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (props[key] !== undefined) {
      out[key] = props[key];
    }
  }
  return out;
}

/**
 * Apply LLM (or fallback) revision writes. Always stamps `dirty: false` so the
 * crew's own edits are not treated as unrevised human changes.
 */
export async function applyRevisionWrites(
  session: CollabSession,
  writes: RevisionWrites,
  actorId: string,
): Promise<void> {
  const snapshot = session.snapshot();
  const nodesById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const updates = Array.isArray(writes.updates) ? writes.updates : [];
  const creates = Array.isArray(writes.creates) ? writes.creates : [];

  const plannedUpdates: Array<{ id: string; type: string; properties: Record<string, unknown> }> = [];
  for (const update of updates) {
    const id = typeof update.id === "string" ? update.id : undefined;
    const props = asRecord(update.properties);
    if (!id || !props) continue;
    const existing = nodesById.get(id);
    if (!existing || existing.type === "SolutionState") continue;
    const picked = pickAllowed(existing.type, props);
    plannedUpdates.push({
      id,
      type: existing.type,
      properties: { ...picked, dirty: false },
    });
  }

  const plannedCreates: Array<{
    type: string;
    properties: Record<string, unknown>;
    ref: string;
    link?: { type: string; from: string };
  }> = [];
  let createIndex = 0;
  for (const create of creates) {
    const type = typeof create.type === "string" ? create.type : undefined;
    const props = asRecord(create.properties);
    if (!type || !props || type === "SolutionState" || !PROPERTY_ALLOWLIST[type]) continue;
    const picked = pickAllowed(type, props);
    if (PROPERTY_ALLOWLIST[type]?.includes("title") && (picked.title === undefined || picked.title === "")) {
      continue;
    }
    const linkRaw = asRecord(create.link);
    const linkType = typeof linkRaw?.type === "string" ? linkRaw.type : undefined;
    const linkFrom = typeof linkRaw?.from === "string" ? linkRaw.from : undefined;
    plannedCreates.push({
      type,
      properties: { ...picked, dirty: false },
      ref: `rev-create-${createIndex++}`,
      link: linkType && linkFrom ? { type: linkType, from: linkFrom } : undefined,
    });
  }

  if (plannedUpdates.length === 0 && plannedCreates.length === 0) {
    return;
  }

  await session.batch((b) => {
    for (const update of plannedUpdates) {
      b.upsertNode({
        id: update.id,
        type: update.type,
        properties: update.properties,
      });
    }
    for (const create of plannedCreates) {
      b.upsertNode(
        {
          type: create.type,
          properties: create.properties,
        },
        create.ref,
      );
      if (create.link) {
        b.upsertEdge({
          type: create.link.type,
          from: create.link.from,
          to: { ref: create.ref },
        });
      }
    }
  }, { actorId });
}

export function risksToCreates(
  risks: unknown,
): RevisionCreate[] {
  if (!Array.isArray(risks)) return [];
  const creates: RevisionCreate[] = [];
  for (const risk of risks) {
    const rec = asRecord(risk);
    if (!rec) continue;
    const from = typeof rec.linkFrom === "string" ? rec.linkFrom : undefined;
    creates.push({
      type: "Risk",
      properties: {
        title: rec.title,
        description: rec.description,
        severity: rec.severity,
        category: rec.category,
        mitigation: rec.mitigation,
      },
      link: from ? { type: "HAS_RISK", from } : undefined,
    });
  }
  return creates;
}
