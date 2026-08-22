import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import { resolveI18nString, uiFor, type GraphSchema } from "@collabnode/schema";

/** Search/snapshot cap so chunk and body dumps cannot fill a context window. */
export const LONG_STRING_LIMIT = 240;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const MAX_COLLECTION_ITEMS = 20;
export const MIN_ID_PREFIX = 4;

const FALLBACK_LABEL_KEYS = ["title", "name", "claim", "body", "channel"] as const;

export function clampLimit(value: unknown, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(0, Math.floor(value)), max);
}

export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.map((item) => String(item));
}

export function interpolateLabel(template: string, properties: Record<string, unknown>): string {
  const filled = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
    const value = properties[key];
    if (value === undefined || value === null || value === "") {
      return "";
    }
    return String(value);
  });
  return filled.replace(/\s+/g, " ").trim();
}

export function fallbackNodeLabel(type: string, properties: Record<string, unknown>, id: string): string {
  for (const key of FALLBACK_LABEL_KEYS) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return `${type} ${id.slice(0, 8)}`;
}

export function nodeLabel(schema: GraphSchema, node: GraphNodeRecord): string {
  const template = resolveI18nString(uiFor(schema, "node", node.type)?.label);
  if (template) {
    const label = interpolateLabel(template, node.properties);
    if (label) {
      return label;
    }
  }
  return fallbackNodeLabel(node.type, node.properties, node.id);
}

export function edgeLabel(schema: GraphSchema, edge: GraphEdgeRecord): string {
  const template = resolveI18nString(uiFor(schema, "edge", edge.type)?.label);
  if (template) {
    const label = interpolateLabel(template, edge.properties);
    if (label) {
      return label;
    }
  }
  return edge.type.replaceAll("_", " ").toLowerCase();
}

export function snapshotValue(value: unknown, includeText: boolean): unknown {
  if (!includeText && typeof value === "string" && value.length > LONG_STRING_LIMIT) {
    return { truncated: true, length: value.length };
  }
  return value;
}

export function truncateSearchValue(value: unknown, needle = ""): unknown {
  if (typeof value !== "string" || value.length <= LONG_STRING_LIMIT) {
    return value;
  }
  const result: { truncated: true; length: number; text: string; match?: string } = {
    truncated: true,
    length: value.length,
    text: value.slice(0, LONG_STRING_LIMIT),
  };
  if (needle) {
    const idx = value.toLowerCase().indexOf(needle);
    if (idx >= LONG_STRING_LIMIT) {
      const start = Math.max(0, idx - 40);
      result.match = value.slice(start, Math.min(value.length, start + 80));
    }
  }
  return result;
}

export function mapDeep(value: unknown, mapScalar: (item: unknown) => unknown): unknown {
  const mapped = mapScalar(value);
  if (mapped !== value) {
    return mapped;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => mapDeep(item, mapScalar));
    if (value.length > MAX_COLLECTION_ITEMS) {
      return { truncated: true, length: value.length, items };
    }
    return items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
      out[key] = mapDeep(item, mapScalar);
    }
    if (entries.length > MAX_COLLECTION_ITEMS) {
      return { truncated: true, length: entries.length, ...out };
    }
    return out;
  }
  return value;
}

export function mapProperties(
  properties: Record<string, unknown>,
  mapValue: (value: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = mapValue(value);
  }
  return out;
}

export function compactSnapshot(snapshot: GraphSnapshot, types: string[] | undefined, includeText: boolean) {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  let nodes = snapshot.nodes;
  let edges = snapshot.edges;
  if (types) {
    const typeSet = new Set(types);
    const selected = new Map<string, GraphNodeRecord>();
    for (const node of snapshot.nodes) {
      if (typeSet.has(node.type)) {
        selected.set(node.id, node);
      }
    }
    edges = snapshot.edges.filter((edge) => {
      if (typeSet.has(edge.type)) {
        return true;
      }
      return selected.has(edge.from) && selected.has(edge.to);
    });
    for (const edge of edges) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (from) {
        selected.set(from.id, from);
      }
      if (to) {
        selected.set(to.id, to);
      }
    }
    nodes = snapshot.nodes.filter((node) => selected.has(node.id));
  }
  const map = (value: unknown) => mapDeep(value, (item) => snapshotValue(item, includeText));
  return {
    schemaId: snapshot.schemaId,
    schemaHash: snapshot.schemaHash,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      properties: mapProperties(node.properties, map),
      tags: node.tags,
      meta: node.meta,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      properties: mapProperties(edge.properties, map),
      meta: edge.meta,
    })),
  };
}

export function incidentSummary(schema: GraphSchema, edge: GraphEdgeRecord) {
  return {
    id: edge.id,
    type: edge.type,
    label: edgeLabel(schema, edge),
    from: edge.from,
    to: edge.to,
  };
}

export function nodeSummary(schema: GraphSchema, node: GraphNodeRecord, compact = false) {
  return {
    id: node.id,
    type: node.type,
    label: nodeLabel(schema, node),
    properties: compact
      ? mapProperties(node.properties, (value) => mapDeep(value, (item) => truncateSearchValue(item)))
      : node.properties,
    tags: node.tags,
    meta: node.meta,
  };
}

export function nodeKeyProperties(schema: GraphSchema, node: GraphNodeRecord): Record<string, unknown> {
  const def = schema.nodes[node.type];
  const keys: string[] = [];
  const add = (key: string) => {
    if (keys.includes(key) || !(key in node.properties)) {
      return;
    }
    const prop = def?.properties[key];
    if (prop && (prop.type === "text" || prop.type === "json" || prop.type === "map" || prop.type === "array")) {
      return;
    }
    keys.push(key);
  };
  for (const field of def?.identity?.from ?? []) {
    add(field);
  }
  const template = resolveI18nString(uiFor(schema, "node", node.type)?.label);
  if (template) {
    for (const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      add(match[1]!);
    }
  }
  for (const key of FALLBACK_LABEL_KEYS) {
    add(key);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys.slice(0, 8)) {
    out[key] = mapDeep(node.properties[key], (item) => truncateSearchValue(item));
  }
  return out;
}
