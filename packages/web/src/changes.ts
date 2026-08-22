import type { GraphOp, GraphSnapshot, HistoryEntry, PropertyMap } from "@collabnode/graph";

export interface ChangeEvent {
  id: string;
  actor: string;
  at: string;
  text: string;
}

function labelOf(type: string, properties: PropertyMap, id: string): string {
  const value = properties.title ?? properties.name ?? properties.body ?? properties.claim;
  if (value !== undefined && value !== null && value !== "") {
    return String(value);
  }
  return `${type} ${id.slice(0, 8)}`;
}

function actorOf(meta: { updatedBy?: string; createdBy?: string }, fallback = "unknown"): string {
  return meta.updatedBy ?? meta.createdBy ?? fallback;
}

function atOf(meta: { updatedAt?: string; createdAt?: string }): string {
  return meta.updatedAt ?? meta.createdAt ?? new Date().toISOString();
}

export function describeOps(
  ops: GraphOp[],
  snapshot: GraphSnapshot,
  previous?: GraphSnapshot,
): ChangeEvent[] {
  const prevNodes = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const prevEdges = new Map((previous?.edges ?? []).map((edge) => [edge.id, edge]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const events: ChangeEvent[] = [];

  for (const op of ops) {
    if (op.kind === "upsertNode") {
      const before = prevNodes.get(op.id);
      const actor = actorOf(op.meta, op.provenance?.actorId);
      const at = atOf(op.meta) || op.provenance?.at || new Date().toISOString();
      const label = labelOf(op.type, op.properties, op.id);
      let text: string;
      if (!before) {
        text = `created ${op.type} “${label}”`;
      } else if (before.properties.status !== op.properties.status && op.properties.status != null) {
        text = `moved “${label}” ${String(before.properties.status)} → ${String(op.properties.status)}`;
      } else {
        text = `updated ${op.type} “${label}”`;
      }
      events.push({ id: `${op.kind}:${op.id}:${at}`, actor, at, text });
      continue;
    }
    if (op.kind === "upsertEdge") {
      const actor = actorOf(op.meta, op.provenance?.actorId);
      const at = atOf(op.meta) || op.provenance?.at || new Date().toISOString();
      const from = nodes.get(op.from);
      const to = nodes.get(op.to);
      const fromLabel = from ? labelOf(from.type, from.properties, from.id) : op.from.slice(0, 8);
      const toLabel = to ? labelOf(to.type, to.properties, to.id) : op.to.slice(0, 8);
      const verb = prevEdges.has(op.id) ? "updated" : "linked";
      events.push({
        id: `${op.kind}:${op.id}:${at}`,
        actor,
        at,
        text: `${verb} ${fromLabel} —${op.type}→ ${toLabel}`,
      });
      continue;
    }
    if (op.kind === "deleteNode") {
      const before = prevNodes.get(op.id);
      const at = op.provenance?.at ?? new Date().toISOString();
      const actor = op.provenance?.actorId ?? "unknown";
      const label = before ? labelOf(before.type, before.properties, before.id) : op.id.slice(0, 8);
      events.push({ id: `${op.kind}:${op.id}:${at}`, actor, at, text: `removed ${label}` });
      continue;
    }
    const before = prevEdges.get(op.id);
    const at = op.provenance?.at ?? new Date().toISOString();
    const actor = op.provenance?.actorId ?? "unknown";
    events.push({
      id: `${op.kind}:${op.id}:${at}`,
      actor,
      at,
      text: `removed ${before?.type ?? "edge"} ${op.id.slice(0, 8)}`,
    });
  }
  return events;
}

/** Last-write rows already on the document when a tab joins (not a full history). */
export function describeLastWrites(snapshot: GraphSnapshot): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const node of snapshot.nodes) {
    if (!node.meta.updatedAt && !node.meta.createdAt) {
      continue;
    }
    events.push({
      id: `last:node:${node.id}:${atOf(node.meta)}`,
      actor: actorOf(node.meta),
      at: atOf(node.meta),
      text: `last wrote ${node.type} “${labelOf(node.type, node.properties, node.id)}”`,
    });
  }
  for (const edge of snapshot.edges) {
    if (!edge.meta.updatedAt && !edge.meta.createdAt) {
      continue;
    }
    const from = snapshot.nodes.find((node) => node.id === edge.from);
    const to = snapshot.nodes.find((node) => node.id === edge.to);
    const fromLabel = from ? labelOf(from.type, from.properties, from.id) : edge.from.slice(0, 8);
    const toLabel = to ? labelOf(to.type, to.properties, to.id) : edge.to.slice(0, 8);
    events.push({
      id: `last:edge:${edge.id}:${atOf(edge.meta)}`,
      actor: actorOf(edge.meta),
      at: atOf(edge.meta),
      text: `last wrote ${fromLabel} —${edge.type}→ ${toLabel}`,
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events;
}

function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "∅";
  }
  if (typeof value === "object" && value !== null && "prefix" in value && "length" in value) {
    const redacted = value as { prefix: unknown; length: unknown };
    return `${String(redacted.prefix)}…`;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return String(value);
}

export function describeHistory(entries: HistoryEntry[]): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const entry of [...entries].reverse()) {
    events.push({
      id: entry.opId,
      actor: entry.actorId,
      at: entry.at,
      text: formatHistoryText(entry),
    });
  }
  return events;
}

export function formatHistoryText(entry: HistoryEntry): string {
  const label = entry.summary ?? entry.type ?? entry.id.slice(0, 8);
  if (entry.op === "deleteNode" || entry.op === "deleteEdge") {
    return `removed ${label}`;
  }
  if (entry.op === "upsertEdge") {
    const from = entry.from?.slice(0, 8) ?? "?";
    const to = entry.to?.slice(0, 8) ?? "?";
    const verb = entry.created === false ? "updated" : "linked";
    return `${verb} ${from} —${entry.type}→ ${to}`;
  }
  if (entry.created === true) {
    return `created ${entry.type ?? "node"} “${label}”`;
  }
  const changes = entry.changes ?? [];
  if (changes.length === 0) {
    return `updated ${entry.type ?? "node"} “${label}”`;
  }
  const bits = changes.map(
    (change) => `${change.field} ${formatDiffValue(change.before)} → ${formatDiffValue(change.after)}`,
  );
  if (bits.length === 1) {
    return `changed ${bits[0]} on ${entry.type ?? "node"} ${label}`;
  }
  return `changed ${bits.join(", ")} on ${entry.type ?? "node"} ${label}`;
}

export function formatChangeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
