import { CollabError } from "@collabnode/collab";
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot, PropertyMap } from "@collabnode/graph";
import { emptyMeta, type EntityMeta } from "@collabnode/graph";
import { crdtProperties, type GraphSchema } from "@collabnode/schema";
import type { LoroDoc, LoroList, LoroMap, LoroMovableList, LoroText, Value } from "loro-crdt";

/** Root container name. Matches the Yjs backend's, so a document is recognisable across backends. */
export const ROOT_KEY = "collabnode";
/** Per-node container holding the `text`/`map`/`array` fields the schema declares live. */
export const NODE_COLLAB_KEY = "_collab";

export type Entity = LoroMap<Record<string, unknown>>;

export function rootMap(doc: LoroDoc): LoroMap<Record<string, unknown>> {
  return doc.getMap(ROOT_KEY);
}

/**
 * Child containers are created with `ensureMergeable*` rather than
 * `setContainer` throughout.
 *
 * Two peers can upsert the same node id concurrently — the hub's `open()` is
 * explicitly create-or-join on one id, so this is the normal case, not the
 * exotic one. Plain `setContainer` gives each peer a *different* container and
 * one of them silently loses its writes; a mergeable container is the same
 * container on both sides. See Loro's "Mergeable Containers" note.
 */
export function nodesMap(root: LoroMap<Record<string, unknown>>): LoroMap<Record<string, unknown>> {
  return root.ensureMergeableMap("nodes");
}

export function edgesMap(root: LoroMap<Record<string, unknown>>): LoroMap<Record<string, unknown>> {
  return root.ensureMergeableMap("edges");
}

export function entityProperties(entity: Entity): LoroMap<Record<string, unknown>> {
  return entity.ensureMergeableMap("properties");
}

export function entityCollab(entity: Entity): LoroMap<Record<string, unknown>> {
  return entity.ensureMergeableMap(NODE_COLLAB_KEY);
}

export function initializeIfNeeded(doc: LoroDoc, schema: GraphSchema): void {
  const root = rootMap(doc);
  if (root.get("schemaId") === undefined) {
    root.set("schemaId", schema.config.schemaId);
  }
  if (root.get("schemaHash") === undefined) {
    root.set("schemaHash", schema.schemaHash);
  }
  // Touch both so a freshly created document has the containers a reader
  // expects, rather than materialising them on the first write.
  nodesMap(root);
  edgesMap(root);
  doc.commit();
}

export function stringField(map: LoroMap<Record<string, unknown>>, key: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Property values go into Loro as they are.
 *
 * The Yjs backend JSON-encodes every value because `Y.Map` cannot tell a stored
 * string from a stored number without one; Loro's `Value` covers the whole
 * `PropertyValue` union natively, so the encode/decode pair is not just
 * unnecessary here, it would defeat the per-key diffing `diffSince` relies on.
 */
export function readProperties(map: LoroMap<Record<string, unknown>> | undefined): PropertyMap {
  if (!map) {
    return {};
  }
  const properties: PropertyMap = {};
  for (const [key, value] of map.entries()) {
    if (value !== undefined && !isContainerValue(value)) {
      properties[key] = value as PropertyMap[string];
    }
  }
  return properties;
}

function isContainerValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && "kind" in value && typeof (value as { kind: unknown }).kind === "function";
}

export function readMeta(entity: Entity): EntityMeta {
  const value = entity.get("meta");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return emptyMeta();
  }
  return value as EntityMeta;
}

export function readTags(entity: Entity): string[] {
  const value = entity.get("tags");
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * One live field's value, or the empty value of its kind.
 *
 * A field the schema declares but the document has not materialised yet reads as
 * empty rather than missing: a caller rendering a note should see "" before the
 * first keystroke, not `undefined`.
 */
function collabFieldValue(container: unknown, kind: string): unknown {
  if (kind === "text") {
    return isLoroText(container) ? container.toString() : "";
  }
  if (kind === "map") {
    return isLoroMap(container) ? (container.toJSON() as Record<string, unknown>) : {};
  }
  return isListLike(container) ? (container.toJSON() as unknown[]) : [];
}

/** Overlay the live `text`/`map`/`array` fields onto a node's plain properties. */
function hydrateCollab(
  record: GraphNodeRecord,
  entity: Entity,
  schema: GraphSchema,
): GraphNodeRecord {
  const defs = crdtProperties(schema.nodes[record.type]);
  if (Object.keys(defs).length === 0) {
    return record;
  }
  const fields = entity.get(NODE_COLLAB_KEY);
  const properties = { ...record.properties };
  for (const [name, kind] of Object.entries(defs)) {
    const container = isLoroMap(fields) ? fields.get(name) : undefined;
    properties[name] = collabFieldValue(container, kind) as (typeof properties)[string];
  }
  return { ...record, properties };
}

export function isLoroMap(value: unknown): value is LoroMap<Record<string, unknown>> {
  return kindOf(value) === "Map";
}

export function isLoroText(value: unknown): value is LoroText {
  return kindOf(value) === "Text";
}

export function isListLike(value: unknown): value is LoroList | LoroMovableList {
  const kind = kindOf(value);
  return kind === "List" || kind === "MovableList";
}

function kindOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return undefined;
  }
  const kind = (value as { kind: unknown }).kind;
  return typeof kind === "function" ? String((kind as () => string).call(value)) : undefined;
}

export function nodeRecordOf(id: string, entity: Entity, schema?: GraphSchema): GraphNodeRecord {
  const record: GraphNodeRecord = {
    id,
    type: stringField(entity, "type"),
    properties: readProperties(asMap(entity.get("properties"))),
    tags: readTags(entity),
    meta: readMeta(entity),
  };
  return schema ? hydrateCollab(record, entity, schema) : record;
}

export function edgeRecordOf(id: string, entity: Entity): GraphEdgeRecord {
  return {
    id,
    type: stringField(entity, "type"),
    from: stringField(entity, "from"),
    to: stringField(entity, "to"),
    properties: readProperties(asMap(entity.get("properties"))),
    meta: readMeta(entity),
  };
}

function asMap(value: unknown): LoroMap<Record<string, unknown>> | undefined {
  return isLoroMap(value) ? value : undefined;
}

export function entityAt(
  container: LoroMap<Record<string, unknown>>,
  id: string,
): Entity | undefined {
  const value = container.get(id);
  return isLoroMap(value) ? (value as Entity) : undefined;
}

export function snapshotOf(doc: LoroDoc, schema?: GraphSchema): GraphSnapshot {
  const root = rootMap(doc);
  const nodes: GraphNodeRecord[] = [];
  const edges: GraphEdgeRecord[] = [];
  for (const [id, value] of nodesMap(root).entries()) {
    if (isLoroMap(value)) {
      nodes.push(nodeRecordOf(id, value as Entity, schema));
    }
  }
  for (const [id, value] of edgesMap(root).entries()) {
    if (isLoroMap(value)) {
      edges.push(edgeRecordOf(id, value as Entity));
    }
  }
  return {
    schemaId: stringField(root, "schemaId"),
    schemaHash: stringField(root, "schemaHash"),
    nodes,
    edges,
  };
}

export function requireEntity(container: LoroMap<Record<string, unknown>>, id: string, label: string): Entity {
  const entity = entityAt(container, id);
  if (!entity) {
    throw new CollabError(`${label} '${id}' does not exist`);
  }
  return entity;
}

/** Loro accepts any JSON value; this only exists to satisfy the `Value` parameter type. */
export function asValue(value: unknown): Value {
  return value as Value;
}
