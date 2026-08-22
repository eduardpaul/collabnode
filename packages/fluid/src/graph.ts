import type {
  CollabArray,
  CollabListener,
  CollabMap,
  CollabText,
  CollaborativeGraph,
} from "@collabnode/collab";
import { CollabError, cloneJson, replaceText } from "@collabnode/collab";
import {
  historyIndicesToDrop,
  selectHistory,
  type GraphOp,
  type GraphSnapshot,
  type HistoryEntry,
  type HistoryFilter,
  type PropertyMap,
} from "@collabnode/graph";
import { crdtProperties, type CrdtPropertyType, type GraphSchema } from "@collabnode/schema";
import { SharedString, type ISharedString } from "fluid-framework/legacy";
import { Tree, type IFluidContainer, type TreeView } from "fluid-framework";
import {
  decodeHistoryEntry,
  decodeMeta,
  decodePropertyMap,
  encodeHistoryEntry,
  encodeMeta,
  encodePropertyEntries,
  encodePropertyValue,
  encodeTags,
  edgeRecord,
  nodeRecord,
} from "./codec.js";
import { CollabDocument, CollabJsonArray, CollabJsonMap, CollabNodeRecord } from "./collab-schema.js";
import { GraphDocument, GraphEdge, GraphNode } from "./tree-schema.js";

type StringMap = GraphNode["properties"];

function applyPropertyMap(target: StringMap, incoming: PropertyMap, patch?: string[]): void {
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

function appendHistory(root: GraphDocument, entry: HistoryEntry | undefined): void {
  if (!entry) {
    return;
  }
  root.history.insertAtEnd(encodeHistoryEntry(entry));
  const decoded: HistoryEntry[] = [];
  for (const json of root.history) {
    decoded.push(decodeHistoryEntry(json) ?? { opId: "", op: "upsertNode", id: "", actorId: "", at: "" });
  }
  for (const index of historyIndicesToDrop(decoded, root.historyLimit)) {
    root.history.removeAt(index);
  }
}

function stringKey(nodeId: string, field: string): string {
  return `${nodeId}:${field}`;
}

export class FluidCollaborativeGraph implements CollaborativeGraph {
  private readonly strings = new Map<string, ISharedString>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly listeners = new Set<CollabListener>();
  private readonly relay = (): void => {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };

  constructor(
    private readonly view: TreeView<typeof GraphDocument>,
    private readonly collabView: TreeView<typeof CollabDocument>,
    private readonly container: IFluidContainer,
    private readonly schema: GraphSchema,
  ) {}

  get schemaId(): string {
    return this.view.root.schemaId;
  }

  get schemaHash(): string {
    return this.view.root.schemaHash;
  }

  snapshot(): GraphSnapshot {
    const root = this.view.root;
    const nodes = [];
    for (const [id, node] of root.nodes) {
      nodes.push(this.hydrate(nodeRecord(id, node.type, decodePropertyMap(node.properties), node.metaJson, node.tagsJson)));
    }
    const edges = [];
    for (const [id, edge] of root.edges) {
      edges.push(
        edgeRecord(
          id,
          edge.type,
          edge.from,
          edge.to,
          decodePropertyMap(edge.properties),
          edge.metaJson,
        ),
      );
    }
    return {
      schemaId: root.schemaId,
      schemaHash: root.schemaHash,
      nodes,
      edges,
    };
  }

  apply(op: GraphOp): void {
    this.applyBatch([op]);
  }

  applyBatch(ops: GraphOp[]): void {
    if (ops.length === 0) {
      return;
    }
    const root = this.view.root;
    // One SharedTree transaction for the whole batch: subscribers see one
    // change event, so seeding a template projects once rather than per node.
    Tree.runTransaction(root, () => {
      for (const op of ops) {
        this.applyOne(op);
      }
    });
  }

  private applyOne(op: GraphOp): void {
    const root = this.view.root;
    switch (op.kind) {
      case "upsertNode": {
        const existing = root.nodes.get(op.id);
        if (!existing) {
          root.nodes.set(
            op.id,
            new GraphNode({
              type: op.type,
              properties: new Map(encodePropertyEntries(op.properties)),
              tagsJson: encodeTags(op.tags ?? []),
              metaJson: encodeMeta(op.meta),
            }),
          );
        } else {
          existing.type = op.type;
          applyPropertyMap(existing.properties, op.properties, op.patch);
          if (op.tags !== undefined) {
            existing.tagsJson = encodeTags(op.tags);
          }
          existing.metaJson = encodeMeta(op.meta);
        }
        this.ensureCollabRecord(op.id);
        break;
      }
      case "deleteNode": {
        root.nodes.delete(op.id);
        this.collabView.root.nodes.delete(op.id);
        this.dropStrings(op.id);
        const remove: string[] = [];
        for (const [edgeId, edge] of root.edges) {
          if (edge.from === op.id || edge.to === op.id) {
            remove.push(edgeId);
          }
        }
        for (const edgeId of remove) {
          root.edges.delete(edgeId);
        }
        break;
      }
      case "upsertEdge": {
        const existing = root.edges.get(op.id);
        if (!existing) {
          root.edges.set(
            op.id,
            new GraphEdge({
              type: op.type,
              from: op.from,
              to: op.to,
              properties: new Map(encodePropertyEntries(op.properties)),
              metaJson: encodeMeta(op.meta),
            }),
          );
        } else {
          existing.type = op.type;
          existing.from = op.from;
          existing.to = op.to;
          applyPropertyMap(existing.properties, op.properties, op.patch);
          existing.metaJson = encodeMeta(op.meta);
        }
        break;
      }
      case "deleteEdge":
        root.edges.delete(op.id);
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
    for (const json of this.view.root.history) {
      const entry = decodeHistoryEntry(json);
      if (entry) {
        entries.push(entry);
      }
    }
    return selectHistory(entries, filter);
  }

  subscribe(listener: CollabListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stopGraph = Tree.on(this.view.root, "treeChanged", this.onTreeChanged);
      this.stopCollab = Tree.on(this.collabView.root, "treeChanged", this.onTreeChanged);
      for (const shared of this.strings.values()) {
        shared.on("sequenceDelta", this.relay);
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopGraph?.();
        this.stopCollab?.();
        this.stopGraph = undefined;
        this.stopCollab = undefined;
        for (const shared of this.strings.values()) {
          shared.off("sequenceDelta", this.relay);
        }
      }
    };
  }

  async ensureCollab(nodeId: string, nodeType: string): Promise<void> {
    const node = this.view.root.nodes.get(nodeId);
    if (!node) {
      throw new CollabError(`unknown node '${nodeId}'`);
    }
    const record = this.ensureCollabRecord(nodeId);
    const defs = crdtProperties(this.schema.nodes[nodeType]);
    for (const [name, kind] of Object.entries(defs)) {
      if (kind === "text") {
        await this.ensureString(nodeId, name, record);
      } else if (kind === "map" && !record.maps.has(name)) {
        record.maps.set(name, new CollabJsonMap({ entries: new Map() }));
      } else if (kind === "array" && !record.arrays.has(name)) {
        record.arrays.set(name, new CollabJsonArray({ items: [] }));
      }
    }
  }

  collabText(nodeId: string, field: string): CollabText {
    this.requireKind(nodeId, field, "text");
    const key = stringKey(nodeId, field);
    const shared = this.strings.get(key);
    if (shared) {
      return new FluidCollabText(shared);
    }
    return new LazyFluidCollabText(this.waitForString(nodeId, field));
  }

  collabMap(nodeId: string, field: string): CollabMap {
    this.requireKind(nodeId, field, "map");
    const record = this.ensureCollabRecord(nodeId);
    let map = record.maps.get(field);
    if (!map) {
      map = new CollabJsonMap({ entries: new Map() });
      record.maps.set(field, map);
    }
    return new FluidCollabMap(map);
  }

  collabArray(nodeId: string, field: string): CollabArray {
    this.requireKind(nodeId, field, "array");
    const record = this.ensureCollabRecord(nodeId);
    let array = record.arrays.get(field);
    if (!array) {
      array = new CollabJsonArray({ items: [] });
      record.arrays.set(field, array);
    }
    return new FluidCollabArray(array);
  }

  private requireKind(nodeId: string, field: string, kind: CrdtPropertyType): void {
    const node = this.view.root.nodes.get(nodeId);
    if (!node) {
      throw new CollabError(`unknown node '${nodeId}'`);
    }
    if (crdtProperties(this.schema.nodes[node.type])[field] !== kind) {
      throw new CollabError(`node '${nodeId}' has no ${kind} collab field '${field}'`);
    }
  }

  private stopGraph: (() => void) | undefined;
  private stopCollab: (() => void) | undefined;
  private hydrating = false;
  private hydrateAgain = false;

  private readonly onTreeChanged = (): void => {
    if (this.hydrating) {
      this.hydrateAgain = true;
      return;
    }
    this.hydrating = true;
    this.hydrateAgain = false;
    void this.loadAllStrings()
      .then(() => this.relay())
      .finally(() => {
        this.hydrating = false;
        if (this.hydrateAgain) {
          this.onTreeChanged();
        }
      });
  };

  /**
   * Passive hydration after a tree change. It must never mint collab state: a
   * node reaches a peer before the handles for its text fields do, so creating
   * here would cache a fresh empty SharedString under the field key and publish
   * its handle over the writer's. `ensureString` then short-circuits on that
   * cache forever, and the peer shows an empty body for a node that is fine
   * everywhere else. Load what exists; the next treeChanged picks up the rest.
   */
  private async loadAllStrings(): Promise<void> {
    const loads: Promise<void>[] = [];
    for (const [id, node] of this.view.root.nodes) {
      const record = this.collabView.root.nodes.get(id);
      if (!record) {
        continue;
      }
      const defs = crdtProperties(this.schema.nodes[node.type]);
      for (const [name, kind] of Object.entries(defs)) {
        if (kind === "text") {
          if (record.texts.get(name)) {
            loads.push(this.ensureString(id, name, record));
          }
        } else if (kind === "map" && !record.maps.has(name)) {
          record.maps.set(name, new CollabJsonMap({ entries: new Map() }));
        } else if (kind === "array" && !record.arrays.has(name)) {
          record.arrays.set(name, new CollabJsonArray({ items: [] }));
        }
      }
    }
    await Promise.all(loads);
  }

  private ensureCollabRecord(nodeId: string): CollabNodeRecord {
    const existing = this.collabView.root.nodes.get(nodeId);
    if (existing) {
      return existing;
    }
    const record = new CollabNodeRecord({
      texts: new Map(),
      maps: new Map(),
      arrays: new Map(),
    });
    this.collabView.root.nodes.set(nodeId, record);
    return record;
  }

  private async waitForString(nodeId: string, field: string): Promise<ISharedString> {
    const key = stringKey(nodeId, field);
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const cached = this.strings.get(key);
      if (cached) {
        return cached;
      }
      const record = this.collabView.root.nodes.get(nodeId);
      const handle = record?.texts.get(field);
      if (record && handle) {
        await this.ensureString(nodeId, field, record);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new CollabError(`node '${nodeId}' has no text collab field '${field}'`);
  }

  private async ensureString(nodeId: string, field: string, record: CollabNodeRecord): Promise<void> {
    const key = stringKey(nodeId, field);
    if (this.strings.has(key)) {
      return;
    }
    const inflight = this.loading.get(key);
    if (inflight) {
      await inflight;
      return;
    }
    const run = this.loadOrCreateString(key, field, record);
    this.loading.set(key, run);
    try {
      await run;
    } finally {
      this.loading.delete(key);
    }
  }

  private async loadOrCreateString(key: string, field: string, record: CollabNodeRecord): Promise<void> {
    if (this.strings.has(key)) {
      return;
    }
    const handle = record.texts.get(field);
    if (handle) {
      const loaded = (await handle.get()) as ISharedString;
      this.attachString(key, loaded);
      return;
    }
    const created = (await this.container.create(SharedString)) as ISharedString;
    record.texts.set(field, created.handle);
    this.attachString(key, created);
  }

  private attachString(key: string, shared: ISharedString): void {
    if (this.strings.has(key)) {
      return;
    }
    this.strings.set(key, shared);
    if (this.listeners.size > 0) {
      shared.on("sequenceDelta", this.relay);
    }
  }

  private dropStrings(nodeId: string): void {
    const prefix = `${nodeId}:`;
    for (const [key, shared] of [...this.strings.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      shared.off("sequenceDelta", this.relay);
      this.strings.delete(key);
      this.loading.delete(key);
    }
  }

  private hydrate(record: ReturnType<typeof nodeRecord>): ReturnType<typeof nodeRecord> {
    const defs = crdtProperties(this.schema.nodes[record.type]);
    if (Object.keys(defs).length === 0) {
      return record;
    }
    const properties = { ...record.properties };
    for (const [name, kind] of Object.entries(defs)) {
      if (kind === "text") {
        const shared = this.strings.get(stringKey(record.id, name));
        properties[name] = shared?.getText() ?? "";
      } else if (kind === "map") {
        const map = this.collabView.root.nodes.get(record.id)?.maps.get(name);
        if (map) {
          properties[name] = new FluidCollabMap(map).toJSON();
        }
      } else {
        const array = this.collabView.root.nodes.get(record.id)?.arrays.get(name);
        if (array) {
          properties[name] = new FluidCollabArray(array).toJSON();
        }
      }
    }
    return { ...record, properties };
  }
}

class LazyFluidCollabText implements CollabText {
  readonly kind = "text" as const;
  private shared: ISharedString | undefined;
  private readonly observers = new Set<() => void>();
  private chain: Promise<ISharedString>;

  constructor(pending: Promise<ISharedString>) {
    this.chain = pending.then((shared) => {
      this.shared = shared;
      for (const listener of this.observers) {
        listener();
        shared.on("sequenceDelta", listener);
      }
      return shared;
    });
  }

  flushed(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  toString(): string {
    return this.shared?.getText() ?? "";
  }

  insert(index: number, value: string): void {
    this.chain = this.chain.then((shared) => {
      shared.insertText(index, value);
      return shared;
    });
  }

  delete(index: number, length: number): void {
    this.chain = this.chain.then((shared) => {
      shared.removeText(index, index + length);
      return shared;
    });
  }

  replace(value: string): void {
    this.chain = this.chain.then((shared) => {
      replaceText(new FluidCollabText(shared), value);
      return shared;
    });
  }

  observe(listener: () => void): () => void {
    this.observers.add(listener);
    if (this.shared) {
      this.shared.on("sequenceDelta", listener);
    }
    return () => {
      this.observers.delete(listener);
      this.shared?.off("sequenceDelta", listener);
    };
  }
}

class FluidCollabText implements CollabText {
  readonly kind = "text" as const;

  constructor(private readonly shared: ISharedString) {}

  toString(): string {
    return this.shared.getText();
  }

  insert(index: number, value: string): void {
    this.shared.insertText(index, value);
  }

  delete(index: number, length: number): void {
    this.shared.removeText(index, index + length);
  }

  replace(value: string): void {
    replaceText(this, value);
  }

  observe(listener: () => void): () => void {
    this.shared.on("sequenceDelta", listener);
    return () => {
      this.shared.off("sequenceDelta", listener);
    };
  }
}

class FluidCollabMap implements CollabMap {
  readonly kind = "map" as const;

  constructor(private readonly map: CollabJsonMap) {}

  get(key: string): unknown {
    const raw = this.map.entries.get(key);
    return raw === undefined ? undefined : decodeJson(raw);
  }

  set(key: string, value: unknown): void {
    this.map.entries.set(key, encodeJson(value));
  }

  delete(key: string): void {
    this.map.entries.delete(key);
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of this.map.entries) {
      result[key] = decodeJson(raw);
    }
    return result;
  }

  replace(value: Record<string, unknown>): void {
    const keys = [...this.map.entries.keys()];
    for (const key of keys) {
      this.map.entries.delete(key);
    }
    for (const [key, item] of Object.entries(value)) {
      this.map.entries.set(key, encodeJson(item));
    }
  }

  observe(listener: () => void): () => void {
    return Tree.on(this.map, "treeChanged", listener);
  }
}

class FluidCollabArray implements CollabArray {
  readonly kind = "array" as const;

  constructor(private readonly array: CollabJsonArray) {}

  toJSON(): unknown[] {
    return [...this.array.items].map((item) => decodeJson(item));
  }

  replace(value: unknown[]): void {
    this.array.items.removeRange(0, this.array.items.length);
    for (const item of value) {
      this.array.items.insertAtEnd(encodeJson(item));
    }
  }

  push(value: unknown): void {
    this.array.items.insertAtEnd(encodeJson(value));
  }

  observe(listener: () => void): () => void {
    return Tree.on(this.array, "treeChanged", listener);
  }
}

function encodeJson(value: unknown): string {
  return JSON.stringify(cloneJson(value));
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function existingMetaJson(
  view: TreeView<typeof GraphDocument>,
  kind: "node" | "edge",
  id: string,
): ReturnType<typeof decodeMeta> {
  if (kind === "node") {
    const node = view.root.nodes.get(id);
    return node ? decodeMeta(node.metaJson) : {};
  }
  const edge = view.root.edges.get(id);
  return edge ? decodeMeta(edge.metaJson) : {};
}
