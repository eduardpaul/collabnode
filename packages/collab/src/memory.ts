import {
  applyPropertyPatch,
  cloneHistoryEntry,
  nodeTags,
  selectHistory,
  trimHistory,
  type GraphEdgeRecord,
  type GraphNodeRecord,
  type GraphOp,
  type GraphSnapshot,
  type HistoryEntry,
  type HistoryFilter,
} from "@collabnode/graph";
import { crdtProperties, DEFAULT_HISTORY_LIMIT, type GraphSchema } from "@collabnode/schema";
import {
  assertSchemaMatch,
  type CollabBackend,
  type CollabBackendCapabilities,
  type CollabHandle,
  type CollabListener,
  type CollaborativeGraph,
  type OpenOptions,
  CollabError,
} from "./backend.js";
import {
  sortPeers,
  type Peer,
  type Presence,
  type PresenceEvent,
  type PresenceListener,
} from "./presence.js";
import {
  cloneJson,
  replaceText,
  type CollabArray,
  type CollabMap,
  type CollabText,
} from "./fields.js";

interface NodeCollab {
  texts: Map<string, MemoryText>;
  maps: Map<string, MemoryMap>;
  arrays: Map<string, MemoryArray>;
}

interface MemoryState {
  schema: GraphSchema;
  schemaId: string;
  schemaHash: string;
  nodes: Map<string, GraphNodeRecord>;
  edges: Map<string, GraphEdgeRecord>;
  collab: Map<string, NodeCollab>;
  history: HistoryEntry[];
  historyLimit: number;
  listeners: Set<CollabListener>;
  room: MemoryRoom;
}

/**
 * The in-process stand-in for a Yjs awareness channel: one peer table per
 * document, shared by every handle opened on it.
 */
interface MemoryRoom {
  peers: Map<string, Peer>;
  listeners: Map<PresenceEvent, Set<PresenceListener>>;
}

function emptyRoom(): MemoryRoom {
  return { peers: new Map(), listeners: new Map() };
}

function roomPeers(room: MemoryRoom): Peer[] {
  return sortPeers([...room.peers.values()]);
}

function emitPresence(room: MemoryRoom, event: PresenceEvent, peer: Peer): void {
  const peers = roomPeers(room);
  for (const listener of room.listeners.get(event) ?? []) {
    listener(peer, peers);
  }
}

class MemoryPresence implements Presence {
  constructor(
    private readonly room: MemoryRoom,
    private readonly connectionId: string,
  ) {}

  peers(): Peer[] {
    return roomPeers(this.room).map((peer) => ({
      ...peer,
      state: { ...peer.state },
      self: peer === this.room.peers.get(this.connectionId),
    }));
  }

  set(state: Record<string, unknown>): void {
    const peer = this.room.peers.get(this.connectionId);
    if (!peer) {
      return;
    }
    const next: Peer = { ...peer, state: { ...peer.state, ...state } };
    this.room.peers.set(this.connectionId, next);
    emitPresence(this.room, "change", next);
  }

  on(event: PresenceEvent, listener: PresenceListener): () => void {
    let set = this.room.listeners.get(event);
    if (!set) {
      set = new Set();
      this.room.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

function cloneNode(node: GraphNodeRecord): GraphNodeRecord {
  return {
    id: node.id,
    type: node.type,
    properties: { ...node.properties },
    tags: node.tags ? [...node.tags] : undefined,
    meta: { ...node.meta },
  };
}

function cloneEdge(edge: GraphEdgeRecord): GraphEdgeRecord {
  return {
    id: edge.id,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    properties: { ...edge.properties },
    meta: { ...edge.meta },
  };
}

function hydrateNode(state: MemoryState, node: GraphNodeRecord): GraphNodeRecord {
  const defs = crdtProperties(state.schema.nodes[node.type]);
  const cloned = cloneNode(node);
  if (Object.keys(defs).length === 0) {
    return cloned;
  }
  const fields = state.collab.get(node.id);
  const properties = { ...cloned.properties };
  for (const [name, kind] of Object.entries(defs)) {
    if (kind === "text") {
      properties[name] = fields?.texts.get(name)?.toString() ?? "";
    } else if (kind === "map") {
      properties[name] = fields?.maps.get(name)?.toJSON() ?? {};
    } else {
      properties[name] = fields?.arrays.get(name)?.toJSON() ?? [];
    }
  }
  return { ...cloned, properties };
}

function toSnapshot(state: MemoryState): GraphSnapshot {
  return {
    schemaId: state.schemaId,
    schemaHash: state.schemaHash,
    nodes: [...state.nodes.values()].map((node) => hydrateNode(state, node)),
    edges: [...state.edges.values()].map(cloneEdge),
  };
}

function notify(state: MemoryState): void {
  const snapshot = toSnapshot(state);
  for (const listener of state.listeners) {
    listener(snapshot);
  }
}

function emptyNodeCollab(): NodeCollab {
  return { texts: new Map(), maps: new Map(), arrays: new Map() };
}

function appendHistory(state: MemoryState, entry: HistoryEntry | undefined): void {
  if (!entry) {
    return;
  }
  state.history.push(cloneHistoryEntry(entry));
  state.history = trimHistory(state.history, state.historyLimit);
}

function applyOp(state: MemoryState, op: GraphOp): void {
  switch (op.kind) {
    case "upsertNode": {
      const existing = state.nodes.get(op.id);
      state.nodes.set(op.id, {
        id: op.id,
        type: op.type,
        properties: applyPropertyPatch(existing?.properties ?? {}, op.properties, op.patch),
        tags: op.tags !== undefined ? [...op.tags] : nodeTags(existing),
        meta: { ...op.meta },
      });
      ensureNodeCollab(state, op.id, op.type);
      break;
    }
    case "deleteNode":
      state.nodes.delete(op.id);
      state.collab.delete(op.id);
      for (const [edgeId, edge] of state.edges) {
        if (edge.from === op.id || edge.to === op.id) {
          state.edges.delete(edgeId);
        }
      }
      break;
    case "upsertEdge": {
      const existing = state.edges.get(op.id);
      state.edges.set(op.id, {
        id: op.id,
        type: op.type,
        from: op.from,
        to: op.to,
        properties: applyPropertyPatch(existing?.properties ?? {}, op.properties, op.patch),
        meta: { ...op.meta },
      });
      break;
    }
    case "deleteEdge":
      state.edges.delete(op.id);
      break;
    default: {
      const _never: never = op;
      throw new CollabError(`unknown op ${JSON.stringify(_never)}`);
    }
  }
  appendHistory(state, op.history);
}

function ensureNodeCollab(state: MemoryState, nodeId: string, nodeType: string): NodeCollab {
  let fields = state.collab.get(nodeId);
  if (!fields) {
    fields = emptyNodeCollab();
    state.collab.set(nodeId, fields);
  }
  const defs = crdtProperties(state.schema.nodes[nodeType]);
  for (const [name, kind] of Object.entries(defs)) {
    if (kind === "text" && !fields.texts.has(name)) {
      fields.texts.set(name, new MemoryText(() => notify(state)));
    }
    if (kind === "map" && !fields.maps.has(name)) {
      fields.maps.set(name, new MemoryMap(() => notify(state)));
    }
    if (kind === "array" && !fields.arrays.has(name)) {
      fields.arrays.set(name, new MemoryArray(() => notify(state)));
    }
  }
  return fields;
}

function requireNode(state: MemoryState, nodeId: string): GraphNodeRecord {
  const node = state.nodes.get(nodeId);
  if (!node) {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  return node;
}

/** Listener plumbing shared by the in-memory text, map, and array types. */
abstract class MemoryObservable {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onGraph: () => void) {}

  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
    this.onGraph();
  }
}

class MemoryText extends MemoryObservable implements CollabText {
  readonly kind = "text" as const;
  private value = "";

  toString(): string {
    return this.value;
  }

  insert(index: number, value: string): void {
    this.value = this.value.slice(0, index) + value + this.value.slice(index);
    this.emit();
  }

  delete(index: number, length: number): void {
    this.value = this.value.slice(0, index) + this.value.slice(index + length);
    this.emit();
  }

  replace(value: string): void {
    replaceText(this, value);
  }
}

class MemoryMap extends MemoryObservable implements CollabMap {
  readonly kind = "map" as const;
  private readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, cloneJson(value));
    this.emit();
  }

  delete(key: string): void {
    this.values.delete(key);
    this.emit();
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }

  replace(value: Record<string, unknown>): void {
    this.values.clear();
    for (const [key, item] of Object.entries(value)) {
      this.values.set(key, cloneJson(item));
    }
    this.emit();
  }
}

class MemoryArray extends MemoryObservable implements CollabArray {
  readonly kind = "array" as const;
  private items: unknown[] = [];

  toJSON(): unknown[] {
    return this.items.map((item) => cloneJson(item));
  }

  replace(value: unknown[]): void {
    this.items = value.map((item) => cloneJson(item));
    this.emit();
  }

  push(value: unknown): void {
    this.items.push(cloneJson(value));
    this.emit();
  }
}

class MemoryGraph implements CollaborativeGraph {
  constructor(private readonly state: MemoryState) {}

  get schemaId(): string {
    return this.state.schemaId;
  }

  get schemaHash(): string {
    return this.state.schemaHash;
  }

  snapshot(): GraphSnapshot {
    return toSnapshot(this.state);
  }

  apply(op: GraphOp): void {
    applyOp(this.state, op);
    notify(this.state);
  }

  applyBatch(ops: GraphOp[]): void {
    if (ops.length === 0) {
      return;
    }
    for (const op of ops) {
      applyOp(this.state, op);
    }
    notify(this.state);
  }

  history(filter?: HistoryFilter): HistoryEntry[] {
    return selectHistory(this.state.history, filter);
  }

  subscribe(listener: CollabListener): () => void {
    this.state.listeners.add(listener);
    return () => {
      this.state.listeners.delete(listener);
    };
  }

  async ensureCollab(nodeId: string, nodeType: string): Promise<void> {
    requireNode(this.state, nodeId);
    ensureNodeCollab(this.state, nodeId, nodeType);
  }

  collabText(nodeId: string, field: string): CollabText {
    const node = requireNode(this.state, nodeId);
    const text = ensureNodeCollab(this.state, nodeId, node.type).texts.get(field);
    if (!text) {
      throw new CollabError(`node '${nodeId}' has no text collab field '${field}'`);
    }
    return text;
  }

  collabMap(nodeId: string, field: string): CollabMap {
    const node = requireNode(this.state, nodeId);
    const map = ensureNodeCollab(this.state, nodeId, node.type).maps.get(field);
    if (!map) {
      throw new CollabError(`node '${nodeId}' has no map collab field '${field}'`);
    }
    return map;
  }

  collabArray(nodeId: string, field: string): CollabArray {
    const node = requireNode(this.state, nodeId);
    const array = ensureNodeCollab(this.state, nodeId, node.type).arrays.get(field);
    if (!array) {
      throw new CollabError(`node '${nodeId}' has no array collab field '${field}'`);
    }
    return array;
  }
}

/**
 * In-process collab backend. Two handles opened on the same id share one
 * document — the same contract a Loro or Fluid implementation must honour.
 *
 * It supports every capability, which is what makes it a usable test double
 * for the ephemeral-workspace path: a backend that cannot delete or report
 * peers cannot exercise termination.
 */
export class InMemoryCollabBackend implements CollabBackend {
  readonly kind = "memory";
  readonly capabilities: CollabBackendCapabilities = {
    namedDocuments: true,
    deletion: true,
    presence: true,
  };
  private readonly docs = new Map<string, MemoryState>();

  async open(
    id: string | undefined,
    schema: GraphSchema,
    options: OpenOptions = {},
  ): Promise<CollabHandle> {
    const name = id ?? crypto.randomUUID();
    let state = this.docs.get(name);
    if (state) {
      assertSchemaMatch(schema, toSnapshot(state));
    } else {
      state = {
        schema,
        schemaId: schema.config.schemaId,
        schemaHash: schema.schemaHash,
        nodes: new Map(),
        edges: new Map(),
        collab: new Map(),
        history: [],
        historyLimit: schema.config.changeTracking.historyLimit ?? DEFAULT_HISTORY_LIMIT,
        listeners: new Set(),
        room: emptyRoom(),
      };
      this.docs.set(name, state);
    }
    return this.connect(name, state, options);
  }

  async delete(id: string): Promise<void> {
    const state = this.docs.get(id);
    if (!state) {
      return;
    }
    // Clear in place as well as dropping the map entry, so any handle still
    // holding this state observes an empty document rather than a live one.
    state.nodes.clear();
    state.edges.clear();
    state.collab.clear();
    state.history = [];
    this.docs.delete(id);
    notify(state);
  }

  async exists(id: string): Promise<boolean> {
    return this.docs.has(id);
  }

  private connect(id: string, state: MemoryState, options: OpenOptions): CollabHandle {
    const connectionId = crypto.randomUUID();
    const peer: Peer = {
      actorId: options.actorId ?? connectionId,
      kind: options.peerKind ?? "human",
      since: new Date().toISOString(),
      state: {},
      self: true,
    };
    state.room.peers.set(connectionId, peer);
    emitPresence(state.room, "join", peer);
    let closed = false;
    return {
      id,
      graph: new MemoryGraph(state),
      presence: () => new MemoryPresence(state.room, connectionId),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        state.room.peers.delete(connectionId);
        emitPresence(state.room, "leave", peer);
        /* document stays until deleted; peers may still be joined */
      },
    };
  }
}
