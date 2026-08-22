import type { GraphEdgeRecord, GraphNodeRecord, HistoryEntry, HistoryFieldDiff, PropertyMap } from "@collabnode/graph";
import { ulid } from "@collabnode/schema";

const REDACTED_FIELDS = new Set(["Chunk.text", "Message.body"]);
const STRING_CAP = 200;
const REDACT_PREFIX = 80;

function stable(value: unknown): string {
  return JSON.stringify(value);
}

export function redactHistoryValue(type: string | undefined, field: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (type && REDACTED_FIELDS.has(`${type}.${field}`)) {
    return { length: value.length, prefix: value.slice(0, REDACT_PREFIX) };
  }
  if (value.length > STRING_CAP) {
    return value.slice(0, STRING_CAP);
  }
  return value;
}

export function entitySummary(type: string | undefined, properties: PropertyMap | undefined): string | undefined {
  if (!properties) {
    return type;
  }
  const value = properties.title ?? properties.name ?? properties.preview ?? properties.body ?? properties.claim;
  if (value === undefined || value === null || value === "") {
    return type;
  }
  const text = String(value);
  return text.length > REDACT_PREFIX ? text.slice(0, REDACT_PREFIX) : text;
}

function propertyDiffs(
  type: string | undefined,
  before: PropertyMap,
  after: PropertyMap,
): { fields: string[]; changes: HistoryFieldDiff[] } {
  const fields: string[] = [];
  const changes: HistoryFieldDiff[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (stable(before[key]) === stable(after[key])) {
      continue;
    }
    fields.push(key);
    changes.push({
      field: key,
      before: key in before ? redactHistoryValue(type, key, before[key]) : null,
      after: key in after ? redactHistoryValue(type, key, after[key]) : null,
    });
  }
  return { fields, changes };
}

export function historyForNodeUpsert(input: {
  actorId: string;
  at: string;
  id: string;
  type: string;
  before?: GraphNodeRecord;
  properties: PropertyMap;
  tags?: string[];
}): HistoryEntry {
  const { fields, changes } = propertyDiffs(input.type, input.before?.properties ?? {}, input.properties);
  if (input.tags !== undefined) {
    const previous = input.before?.tags ?? [];
    if (stable(previous) !== stable(input.tags)) {
      fields.push("tags");
      changes.push({ field: "tags", before: previous, after: input.tags });
    }
  }
  return {
    opId: ulid(),
    op: "upsertNode",
    id: input.id,
    type: input.type,
    actorId: input.actorId,
    at: input.at,
    created: input.before === undefined,
    fields,
    changes,
    summary: entitySummary(input.type, input.properties),
  };
}

export function historyForNodeDelete(input: {
  actorId: string;
  at: string;
  id: string;
  before?: GraphNodeRecord;
}): HistoryEntry {
  return {
    opId: ulid(),
    op: "deleteNode",
    id: input.id,
    type: input.before?.type,
    actorId: input.actorId,
    at: input.at,
    summary: entitySummary(input.before?.type, input.before?.properties),
  };
}

export function historyForEdgeUpsert(input: {
  actorId: string;
  at: string;
  id: string;
  type: string;
  from: string;
  to: string;
  before?: GraphEdgeRecord;
  properties: PropertyMap;
}): HistoryEntry {
  const { fields, changes } = propertyDiffs(input.type, input.before?.properties ?? {}, input.properties);
  return {
    opId: ulid(),
    op: "upsertEdge",
    id: input.id,
    type: input.type,
    from: input.from,
    to: input.to,
    actorId: input.actorId,
    at: input.at,
    created: input.before === undefined,
    fields,
    changes,
    summary: input.type,
  };
}

export function historyForEdgeDelete(input: {
  actorId: string;
  at: string;
  id: string;
  before?: GraphEdgeRecord;
}): HistoryEntry {
  return {
    opId: ulid(),
    op: "deleteEdge",
    id: input.id,
    type: input.before?.type,
    from: input.before?.from,
    to: input.before?.to,
    actorId: input.actorId,
    at: input.at,
    summary: input.before?.type,
  };
}
