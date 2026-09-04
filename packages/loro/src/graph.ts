import type {
  CollabArray,
  CollabListener,
  CollabMap,
  CollabText,
  CollaborativeGraph,
  DocExportMode,
  VersionToken,
  VersionedGraph,
} from "@collabnode/collab";
import type {
  GraphOp,
  GraphSnapshot,
  HistoryEntry,
  HistoryFilter,
  PropertyMap,
} from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import type { LoroDoc, LoroMap, Subscription } from "loro-crdt";
import { opsBetween } from "./changes.js";
import { ensureLoroCollab, loroCollabArray, loroCollabMap, loroCollabText } from "./collab.js";
import {
  asValue,
  edgesMap,
  entityAt,
  entityProperties,
  nodesMap,
  rootMap,
  snapshotOf,
  stringField,
  type Entity,
} from "./doc.js";
import { encodeHistoryMessage, historyOf } from "./history.js";
import { LORO_KIND, frontiersOf, isReachable, tokenOf } from "./version.js";

function applyProperties(
  target: LoroMap<Record<string, unknown>>,
  incoming: PropertyMap,
  patch?: string[],
): void {
  const keys = patch ?? Object.keys(incoming);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      target.set(key, asValue(incoming[key]));
    } else {
      target.delete(key);
    }
  }
  if (patch === undefined) {
    for (const key of target.keys()) {
      const name = String(key);
      if (!Object.prototype.hasOwnProperty.call(incoming, name)) {
        target.delete(name);
      }
    }
  }
}

export class LoroCollaborativeGraph implements CollaborativeGraph, VersionedGraph {
  constructor(
    readonly doc: LoroDoc,
    private readonly schema: GraphSchema,
  ) {}

  get schemaId(): string {
    return stringField(rootMap(this.doc), "schemaId");
  }

  get schemaHash(): string {
    return stringField(rootMap(this.doc), "schemaHash");
  }

  snapshot(): GraphSnapshot {
    return snapshotOf(this.doc, this.schema);
  }

  apply(op: GraphOp): void {
    this.applyBatch([op]);
  }

  /**
   * One Loro commit for the whole batch, so subscribers see one event and the
   * DAG gains one change — the same shape `doc.transact` gives the Yjs backend.
   *
   * The batch's history entries ride on that commit's message rather than into
   * a container of their own; see `history.ts` for why.
   */
  applyBatch(ops: GraphOp[]): void {
    if (ops.length === 0) {
      return;
    }
    const root = rootMap(this.doc);
    const nodes = nodesMap(root);
    const edges = edgesMap(root);
    const entries: HistoryEntry[] = [];
    for (const op of ops) {
      this.applyOne(nodes, edges, op);
      if (op.history) {
        entries.push(op.history);
      }
    }
    const message = encodeHistoryMessage(entries);
    this.doc.commit(message ? { message } : undefined);
  }

  private applyOne(
    nodes: LoroMap<Record<string, unknown>>,
    edges: LoroMap<Record<string, unknown>>,
    op: GraphOp,
  ): void {
    switch (op.kind) {
      case "upsertNode":
        this.upsertNode(nodes, op);
        break;
      case "deleteNode":
        nodes.delete(op.id);
        deleteIncidentEdges(edges, op.id);
        break;
      case "upsertEdge":
        upsertEdge(edges, op);
        break;
      case "deleteEdge":
        edges.delete(op.id);
        break;
      default: {
        const _never: never = op;
        return _never;
      }
    }
  }

  private upsertNode(
    nodes: LoroMap<Record<string, unknown>>,
    op: Extract<GraphOp, { kind: "upsertNode" }>,
  ): void {
    const existed = entityAt(nodes, op.id) !== undefined;
    const entity = nodes.ensureMergeableMap(op.id) as Entity;
    entity.set("type", op.type);
    // A patch against a node that does not exist yet is a create, and its keys
    // are the whole of it — honouring the patch would leave the other declared
    // properties absent rather than unset.
    applyProperties(entityProperties(entity), op.properties, existed ? op.patch : undefined);
    if (op.tags !== undefined) {
      entity.set("tags", asValue([...op.tags]));
    } else if (!existed) {
      entity.set("tags", asValue([]));
    }
    entity.set("meta", asValue({ ...op.meta }));
    ensureLoroCollab(this.doc, this.schema, op.id, op.type);
  }

  history(filter?: HistoryFilter): HistoryEntry[] {
    return historyOf(this.doc, filter);
  }

  subscribe(listener: CollabListener): () => void {
    const subscription: Subscription = this.doc.subscribe(() => {
      listener(this.snapshot());
    });
    return () => {
      subscription();
    };
  }

  // --- VersionedGraph ---------------------------------------------------

  version(): VersionToken {
    return tokenOf(this.doc);
  }

  diffSince(version: VersionToken, to?: VersionToken): GraphOp[] | undefined {
    if (version.kind !== LORO_KIND || (to !== undefined && to.kind !== LORO_KIND)) {
      return undefined;
    }
    let from;
    let target;
    try {
      from = frontiersOf(version);
      target = to === undefined ? this.doc.frontiers() : frontiersOf(to);
    } catch {
      return undefined;
    }
    if (!isReachable(this.doc, from) || (to !== undefined && !isReachable(this.doc, target))) {
      return undefined;
    }
    try {
      return opsBetween(this.doc, this.schema, from, target);
    } catch {
      // A version that passed the reachability check but that the document
      // still cannot replay. Falling back to a full snapshot is always correct;
      // guessing at a partial diff is not.
      return undefined;
    }
  }

  exportDoc(mode: DocExportMode = "snapshot"): Uint8Array {
    if (mode === "shallow") {
      return this.doc.export({ mode: "shallow-snapshot", frontiers: this.doc.frontiers() });
    }
    return this.doc.export({ mode: "snapshot" });
  }

  checkout(version: VersionToken | undefined): void {
    if (version === undefined) {
      this.doc.checkoutToLatest();
      return;
    }
    this.doc.checkout(frontiersOf(version));
  }

  // --- transport seam ---------------------------------------------------

  /**
   * Everything this peer has that `version` does not.
   *
   * This is the payload a relay would broadcast. Loro ships no transport of its
   * own, so a server built on this backend sends these bytes and calls
   * `importUpdate` on the other side; see the package README.
   */
  exportUpdate(version?: VersionToken): Uint8Array {
    if (!version || version.kind !== LORO_KIND) {
      return this.doc.export({ mode: "update" });
    }
    return this.doc.export({ mode: "update", from: this.doc.frontiersToVV(frontiersOf(version)) });
  }

  importUpdate(bytes: Uint8Array): void {
    this.doc.import(bytes);
  }

  /** Fires with the bytes of every local commit, for a transport to forward. */
  onLocalUpdate(listener: (bytes: Uint8Array) => void): () => void {
    const subscription = this.doc.subscribeLocalUpdates(listener);
    return () => {
      subscription();
    };
  }

  // --- live fields ------------------------------------------------------

  async ensureCollab(nodeId: string, nodeType: string): Promise<void> {
    ensureLoroCollab(this.doc, this.schema, nodeId, nodeType);
    this.doc.commit();
  }

  collabText(nodeId: string, field: string): CollabText {
    return loroCollabText(this.doc, this.schema, nodeId, field);
  }

  collabMap(nodeId: string, field: string): CollabMap {
    return loroCollabMap(this.doc, this.schema, nodeId, field);
  }

  collabArray(nodeId: string, field: string): CollabArray {
    return loroCollabArray(this.doc, this.schema, nodeId, field);
  }
}

function upsertEdge(
  edges: LoroMap<Record<string, unknown>>,
  op: Extract<GraphOp, { kind: "upsertEdge" }>,
): void {
  const existed = entityAt(edges, op.id) !== undefined;
  const entity = edges.ensureMergeableMap(op.id) as Entity;
  entity.set("type", op.type);
  entity.set("from", op.from);
  entity.set("to", op.to);
  applyProperties(entityProperties(entity), op.properties, existed ? op.patch : undefined);
  entity.set("meta", asValue({ ...op.meta }));
}

/**
 * Remove the edges that pointed at a node being deleted.
 *
 * A scan of every edge, as on the other backends. Referential integrity is not
 * something any of these CRDTs provides: an edge added concurrently with the
 * deletion of one of its endpoints survives here as it does there. What this
 * backend adds is a history in which that is findable afterwards.
 */
function deleteIncidentEdges(edges: LoroMap<Record<string, unknown>>, nodeId: string): void {
  const orphaned: string[] = [];
  for (const [edgeId] of edges.entries()) {
    const entity = entityAt(edges, String(edgeId));
    if (entity && (stringField(entity, "from") === nodeId || stringField(entity, "to") === nodeId)) {
      orphaned.push(String(edgeId));
    }
  }
  for (const edgeId of orphaned) {
    edges.delete(edgeId);
  }
}
