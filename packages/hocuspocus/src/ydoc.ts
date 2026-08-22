import { CollabError } from "@collabnode/collab";
import type { GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import { crdtProperties, DEFAULT_HISTORY_LIMIT, type GraphSchema } from "@collabnode/schema";
import * as Y from "yjs";
import { decodePropertyMap, edgeRecord, nodeRecord } from "./codec.js";

export const NODE_COLLAB_KEY = "_collab";

export const ROOT_KEY = "collabnode";

export function rootMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(ROOT_KEY);
}

function asMap(value: unknown, label: string): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) {
    throw new CollabError(`Hocuspocus document is missing ${label} map`);
  }
  return value;
}

function asStringMap(value: unknown, label: string): Y.Map<string> {
  if (!(value instanceof Y.Map)) {
    throw new CollabError(`Hocuspocus document is missing ${label} map`);
  }
  return value as Y.Map<string>;
}

export function asHistoryArray(value: unknown): Y.Array<string> {
  if (!(value instanceof Y.Array)) {
    throw new CollabError("Hocuspocus document is missing history array");
  }
  return value as Y.Array<string>;
}

export function nodesMap(root: Y.Map<unknown>): Y.Map<Y.Map<unknown>> {
  return asMap(root.get("nodes"), "nodes") as Y.Map<Y.Map<unknown>>;
}

export function edgesMap(root: Y.Map<unknown>): Y.Map<Y.Map<unknown>> {
  return asMap(root.get("edges"), "edges") as Y.Map<Y.Map<unknown>>;
}

export function historyArray(root: Y.Map<unknown>): Y.Array<string> {
  return asHistoryArray(root.get("history"));
}

export function historyLimitOf(root: Y.Map<unknown>): number {
  const value = root.get("historyLimit");
  return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_HISTORY_LIMIT;
}

export function initializeIfNeeded(doc: Y.Doc, schema: GraphSchema): void {
  const root = rootMap(doc);
  if (
    root.has("schemaId") &&
    root.has("schemaHash") &&
    root.has("nodes") &&
    root.has("edges") &&
    root.has("history")
  ) {
    return;
  }
  doc.transact(() => {
    if (!root.has("schemaId")) {
      root.set("schemaId", schema.config.schemaId);
    }
    if (!root.has("schemaHash")) {
      root.set("schemaHash", schema.schemaHash);
    }
    if (!root.has("historyLimit")) {
      root.set("historyLimit", schema.config.changeTracking.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    }
    if (!(root.get("nodes") instanceof Y.Map)) {
      root.set("nodes", new Y.Map());
    }
    if (!(root.get("edges") instanceof Y.Map)) {
      root.set("edges", new Y.Map());
    }
    if (!(root.get("history") instanceof Y.Array)) {
      root.set("history", new Y.Array());
    }
  });
}

function mapString(map: Y.Map<unknown>, key: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : "";
}

function propertiesOf(entity: Y.Map<unknown>): ReturnType<typeof decodePropertyMap> {
  const value = entity.get("properties");
  if (value instanceof Y.Map) {
    return decodePropertyMap(asStringMap(value, "properties"));
  }
  return {};
}

function hydrateYNode(record: GraphNodeRecord, node: Y.Map<unknown>, schema: GraphSchema): GraphNodeRecord {
  const defs = crdtProperties(schema.nodes[record.type]);
  if (Object.keys(defs).length === 0) {
    return record;
  }
  const fields = node.get(NODE_COLLAB_KEY);
  const properties = { ...record.properties };
  for (const [name, kind] of Object.entries(defs)) {
    const value = fields instanceof Y.Map ? fields.get(name) : undefined;
    if (kind === "text") {
      properties[name] = value instanceof Y.Text ? value.toString() : "";
    } else if (kind === "map") {
      properties[name] = value instanceof Y.Map ? (value.toJSON() as Record<string, unknown>) : {};
    } else {
      properties[name] = value instanceof Y.Array ? (value.toJSON() as unknown[]) : [];
    }
  }
  return { ...record, properties };
}

export function snapshotOf(doc: Y.Doc, schema?: GraphSchema): GraphSnapshot {
  const root = rootMap(doc);
  const schemaId = typeof root.get("schemaId") === "string" ? (root.get("schemaId") as string) : "";
  const schemaHash =
    typeof root.get("schemaHash") === "string" ? (root.get("schemaHash") as string) : "";
  const nodes = [];
  const nodesY = root.get("nodes");
  if (nodesY instanceof Y.Map) {
    for (const [id, node] of nodesY) {
      if (node instanceof Y.Map) {
        const record = nodeRecord(
          id,
          mapString(node, "type"),
          propertiesOf(node),
          mapString(node, "metaJson"),
          mapString(node, "tagsJson"),
        );
        nodes.push(schema ? hydrateYNode(record, node, schema) : record);
      }
    }
  }
  const edges = [];
  const edgesY = root.get("edges");
  if (edgesY instanceof Y.Map) {
    for (const [id, edge] of edgesY) {
      if (edge instanceof Y.Map) {
        edges.push(
          edgeRecord(
            id,
            mapString(edge, "type"),
            mapString(edge, "from"),
            mapString(edge, "to"),
            propertiesOf(edge),
            mapString(edge, "metaJson"),
          ),
        );
      }
    }
  }
  return { schemaId, schemaHash, nodes, edges };
}
