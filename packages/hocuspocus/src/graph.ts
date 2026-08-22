import type {
  CollabArray,
  CollabListener,
  CollabMap,
  CollabText,
  CollaborativeGraph,
} from "@collabnode/collab";
import {
  historyIndicesToDrop,
  selectHistory,
  type GraphOp,
  type GraphSnapshot,
  type HistoryEntry,
  type HistoryFilter,
  type PropertyMap,
} from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import * as Y from "yjs";
import {
  decodeHistoryEntry,
  encodeHistoryEntry,
  encodeMeta,
  encodePropertyValue,
  encodeTags,
} from "./codec.js";
import { ensureYCollab, yCollabArray, yCollabMap, yCollabText } from "./collab.js";
import {
  edgesMap,
  historyArray,
  historyLimitOf,
  nodesMap,
  rootMap,
  snapshotOf,
} from "./ydoc.js";

function applyPropertyYMap(target: Y.Map<string>, incoming: PropertyMap, patch?: string[]): void {
  const keys = patch ?? Object.keys(incoming);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      target.set(key, encodePropertyValue(incoming[key]!));
    } else {
      target.delete(key);
    }
  }
  if (patch === undefined) {
    for (const key of [...target.keys()]) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) {
        target.delete(key);
      }
    }
  }
}

function propertiesMap(entity: Y.Map<unknown>): Y.Map<string> {
  const existing = entity.get("properties");
  if (existing instanceof Y.Map) {
    return existing as Y.Map<string>;
  }
  const created = new Y.Map<string>();
  entity.set("properties", created);
  return created;
}

function newEntity(fields: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) {
    map.set(key, value);
  }
  return map;
}

function appendHistory(root: Y.Map<unknown>, entry: HistoryEntry | undefined): void {
  if (!entry) {
    return;
  }
  const history = historyArray(root);
  history.push([encodeHistoryEntry(entry)]);
  const decoded: HistoryEntry[] = [];
  for (const json of history) {
    decoded.push(decodeHistoryEntry(json) ?? { opId: "", op: "upsertNode", id: "", actorId: "", at: "" });
  }
  for (const index of historyIndicesToDrop(decoded, historyLimitOf(root))) {
    history.delete(index, 1);
  }
}

export class HocuspocusCollaborativeGraph implements CollaborativeGraph {
  constructor(
    private readonly doc: Y.Doc,
    private readonly schema: GraphSchema,
  ) {}

  get schemaId(): string {
    const value = rootMap(this.doc).get("schemaId");
    return typeof value === "string" ? value : "";
  }

  get schemaHash(): string {
    const value = rootMap(this.doc).get("schemaHash");
    return typeof value === "string" ? value : "";
  }

  snapshot(): GraphSnapshot {
    return snapshotOf(this.doc, this.schema);
  }

  apply(op: GraphOp): void {
    this.applyBatch([op]);
  }

  applyBatch(ops: GraphOp[]): void {
    if (ops.length === 0) {
      return;
    }
    const root = rootMap(this.doc);
    // One transaction for the whole batch: Yjs emits a single deep observation
    // for it, so the projector diffs once no matter how large the template is.
    this.doc.transact(() => {
      const nodes = nodesMap(root);
      const edges = edgesMap(root);
      for (const op of ops) {
        this.applyOne(root, nodes, edges, op);
      }
    });
  }

  private applyOne(
    root: Y.Map<unknown>,
    nodes: Y.Map<Y.Map<unknown>>,
    edges: Y.Map<Y.Map<unknown>>,
    op: GraphOp,
  ): void {
    switch (op.kind) {
      case "upsertNode": {
        const existing = nodes.get(op.id);
        if (!existing) {
          const entity = newEntity({
            type: op.type,
            tagsJson: encodeTags(op.tags ?? []),
            metaJson: encodeMeta(op.meta),
          });
          const properties = new Y.Map<string>();
          entity.set("properties", properties);
          nodes.set(op.id, entity);
          applyPropertyYMap(properties, op.properties);
          ensureYCollab(this.doc, this.schema, op.id, op.type);
        } else {
          existing.set("type", op.type);
          applyPropertyYMap(propertiesMap(existing), op.properties, op.patch);
          if (op.tags !== undefined) {
            existing.set("tagsJson", encodeTags(op.tags));
          }
          existing.set("metaJson", encodeMeta(op.meta));
          ensureYCollab(this.doc, this.schema, op.id, op.type);
        }
        break;
      }
      case "deleteNode": {
        nodes.delete(op.id);
        const remove: string[] = [];
        for (const [edgeId, edge] of edges) {
          if (edge.get("from") === op.id || edge.get("to") === op.id) {
            remove.push(edgeId);
          }
        }
        for (const edgeId of remove) {
          edges.delete(edgeId);
        }
        break;
      }
      case "upsertEdge": {
        const existing = edges.get(op.id);
        if (!existing) {
          const entity = newEntity({
            type: op.type,
            from: op.from,
            to: op.to,
            metaJson: encodeMeta(op.meta),
          });
          const properties = new Y.Map<string>();
          entity.set("properties", properties);
          edges.set(op.id, entity);
          applyPropertyYMap(properties, op.properties);
        } else {
          existing.set("type", op.type);
          existing.set("from", op.from);
          existing.set("to", op.to);
          applyPropertyYMap(propertiesMap(existing), op.properties, op.patch);
          existing.set("metaJson", encodeMeta(op.meta));
        }
        break;
      }
      case "deleteEdge":
        edges.delete(op.id);
        break;
      default: {
        const _never: never = op;
        return _never;
      }
    }
    appendHistory(root, op.history);
  }

  history(filter?: HistoryFilter): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    for (const json of historyArray(rootMap(this.doc))) {
      const entry = decodeHistoryEntry(json);
      if (entry) {
        entries.push(entry);
      }
    }
    return selectHistory(entries, filter);
  }

  subscribe(listener: CollabListener): () => void {
    const root = rootMap(this.doc);
    const handler = (): void => {
      listener(this.snapshot());
    };
    root.observeDeep(handler);
    return () => {
      root.unobserveDeep(handler);
    };
  }

  async ensureCollab(nodeId: string, nodeType: string): Promise<void> {
    ensureYCollab(this.doc, this.schema, nodeId, nodeType);
  }

  collabText(nodeId: string, field: string): CollabText {
    return yCollabText(this.doc, this.schema, nodeId, field);
  }

  collabMap(nodeId: string, field: string): CollabMap {
    return yCollabMap(this.doc, this.schema, nodeId, field);
  }

  collabArray(nodeId: string, field: string): CollabArray {
    return yCollabArray(this.doc, this.schema, nodeId, field);
  }
}
