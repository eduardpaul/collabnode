import type {
  CollabArray,
  CollabBackend,
  CollabBackendCapabilities,
  CollabHandle,
  CollabMap,
  CollabText,
  DocExportMode,
  Peer,
  PeerKind,
  Presence,
  VersionToken,
} from "@collabnode/collab";
import { isVersioned, unsupported } from "@collabnode/collab";
import {
  diffSnapshots,
  squash,
  stampMeta,
  GraphStoreError,
  type GraphEdgeRecord,
  type GraphNodeRecord,
  type GraphOp,
  type GraphSearchHit,
  type GraphSearchModes,
  type GraphSearchRequest,
  type GraphSnapshot,
  type GraphStore,
  type GraphVectorRequest,
  type HistoryEntry,
  type HistoryFilter,
  type PropertyMap,
  type Provenance,
  type QueryResult,
  type WorkspaceScope,
} from "@collabnode/graph";
import { diffSnapshotsToMarkdown } from "./snapshot-format.js";
import {
  assertCrdtField,
  compileTemplate,
  crdtProperties,
  fillRequiredCrdt,
  generateId,
  identityId,
  lwwProperties,
  singletonId,
  partitionNodeProperties,
  guidelinesFor,
  type AnyGraph,
  type CrdtPropertyType,
  type EdgeNameOf,
  type GraphOpInput,
  type GraphSchema,
  type GraphTypeMap,
  type NodeRef,
  type PropertyDef,
  type UpsertEdgeInput,
  type UpsertNodeInput,
  type WorkspaceType,
  SchemaError,
} from "@collabnode/schema";
import { applyDerivedProperties } from "./derived.js";
import {
  historyForEdgeDelete,
  historyForEdgeUpsert,
  historyForNodeDelete,
  historyForNodeUpsert,
} from "./history.js";
import { Projector, type ProjectorListener } from "./projector.js";
import { SnapshotIndex } from "./snapshot-index.js";
import { assertEdgeOpWith, assertNodeOp, resolveNodeTags } from "./validate.js";

export interface CollabSessionOptions {
  schema: GraphSchema;
  collab: CollabBackend;
  /**
   * Where the graph is projected for querying. Omit for `projection: none`:
   * the CRDT is the source of truth, snapshots answer reads, and a workspace
   * that never issues Cypher stops paying for a projection it does not use.
   */
  graph?: GraphStore;
  /** Required when YAML `config.changeTracking.enabled` is true. */
  actorId?: string;
  /** How this connection appears in presence. Defaults to `human`. */
  peerKind?: PeerKind;
  /**
   * Whether `close()` closes the store. Default true, which is right for a
   * store this session opened; pass false for a store shared across
   * workspaces, where closing it would take the others down with it.
   */
  ownsStore?: boolean;
}

export interface MutationOptions {
  actorId?: string;
}

/**
 * The write shapes come from `@collabnode/schema`, where they are generic over
 * a workspace's type map. `tags` on a node upsert replaces the tag set: omit it
 * to leave what is stored, pass `[]` to clear it.
 */
export type { UpsertEdgeInput, UpsertNodeInput } from "@collabnode/schema";

/**
 * An endpoint in a batch: a node id, or `{ ref }` naming an entry earlier in
 * the same batch. Refs are what make a batch expressive enough to seed a graph
 * whose ids do not exist until the batch is planned.
 */
export type { NodeRef, GraphOpInput } from "@collabnode/schema";

/**
 * Collects writes for one atomic batch.
 *
 * The generic parameter is here for the *caller* — `type` is checked against
 * the schema's node and edge names, and `properties` against the type actually
 * named. Inside, each op is spread into a union member TypeScript cannot
 * correlate while `T` is still generic, so each push carries one cast. Narrowing
 * that away would mean writing the builder per node type, which is a lot of
 * machinery to prove something the signature above already guarantees.
 */
export class BatchBuilder<S extends GraphTypeMap = AnyGraph> {
  readonly ops: GraphOpInput<S>[] = [];

  upsertNode(input: UpsertNodeInput<S>, ref?: string): NodeRef {
    this.ops.push({ op: "upsertNode", ref, ...input } as unknown as GraphOpInput<S>);
    return ref ? { ref } : (input.id ?? "");
  }

  upsertEdge<T extends EdgeNameOf<S>>(input: {
    type: T;
    from: NodeRef;
    to: NodeRef;
    properties?: S["edges"][T]["input"];
    id?: string;
  }): void {
    this.ops.push({ op: "upsertEdge", ...input } as unknown as GraphOpInput<S>);
  }

  deleteNode(id: string): void {
    this.ops.push({ op: "deleteNode", id });
  }

  deleteEdge(id: string): void {
    this.ops.push({ op: "deleteEdge", id });
  }
}

export interface ApplyOpsResult {
  /** Id per input entry, in order. Deletes report the id they removed. */
  ids: string[];
  /** The ids of entries that named themselves with `ref`. */
  refs: Record<string, string>;
  /** CRDT ops actually committed; lower than `ids.length` when writes were no-ops. */
  applied: number;
}

/**
 * Drops a value's schema types on the way into the implementation.
 *
 * Everything below this line validates against the *runtime* schema and has no
 * use for the compile-time one, so the generic parameter is erased once, here,
 * rather than being threaded through planners and validators that would gain
 * nothing from it. The public signature is what enforces the types; this is the
 * seam where that enforcement has already happened.
 */
function loose<T>(value: T): T extends GraphSnapshot<GraphTypeMap>
  ? GraphSnapshot
  : T extends UpsertNodeInput<GraphTypeMap>
    ? UpsertNodeInput
    : T extends UpsertEdgeInput<GraphTypeMap>
      ? UpsertEdgeInput
      : never {
  return value as never;
}

function provenanceFor(schema: GraphSchema, actorId: string | undefined): Provenance | undefined {
  if (!schema.config.changeTracking.enabled) {
    return undefined;
  }
  if (!actorId) {
    throw new SchemaError(
      "actorId is required when changeTracking.enabled is true",
      "config.changeTracking",
    );
  }
  return { actorId, at: new Date().toISOString() };
}

function identityIdFromInput(
  schema: GraphSchema,
  type: string,
  properties: Record<string, unknown>,
): string | undefined {
  const def = schema.nodes[type];
  if (!def?.identity) {
    return undefined;
  }
  const ready = def.identity.from.every((field) => {
    const value = properties[field];
    return value !== undefined && value !== null && value !== "";
  });
  if (!ready) {
    return undefined;
  }
  return identityId(schema, type, properties);
}

/**
 * Identity ids are a hash of the raw field values, so `Stand-Up` and `Standup`
 * are different nodes. When nothing matched exactly, look for a single node
 * whose identity fields differ only in case, accent, or punctuation — that is
 * the note the speaker meant, not a new one. Two candidates means we cannot
 * tell, so create instead of guessing.
 */
export function normalizedIdentityMatch(
  schema: GraphSchema,
  snapshot: GraphSnapshot,
  type: string,
  properties: Record<string, unknown>,
): GraphNodeRecord | undefined {
  const fields = schema.nodes[type]?.identity?.from;
  if (!fields || fields.length === 0) {
    return undefined;
  }
  const wanted = fields.map((field) => squash(String(properties[field] ?? "")));
  if (wanted.some((value) => value === "")) {
    return undefined;
  }
  const matches = snapshot.nodes.filter(
    (node) =>
      node.type === type &&
      fields.every((field, i) => squash(String(node.properties[field] ?? "")) === wanted[i]),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

interface UpsertTarget {
  id: string | undefined;
  existing: GraphNodeRecord | undefined;
  /** `normalized` means the stored identity spelling wins over the incoming one. */
  matchedBy?: "id" | "identity" | "normalized" | "singleton";
}

/**
 * Where a write to a `singleton:` type lands.
 *
 * Whatever the caller passes, there is one node: the one already there if the
 * document has one — under the derived id, or under some other id it was
 * created with before the type became singleton — and otherwise the derived id,
 * which every replica computes the same way, so two peers creating it at once
 * write to one node rather than two.
 *
 * An explicit id is honoured only when it agrees with that. A caller pointing at
 * some other node of the type is refused rather than quietly redirected: the
 * write they described cannot happen, and a silent redirect would hide a bug in
 * whatever computed the id.
 */
function singletonForUpsert(
  schema: GraphSchema,
  index: SnapshotIndex,
  input: UpsertNodeInput,
): UpsertTarget {
  const existing = index.singletonOfType(input.type);
  if (existing) {
    if (input.id && input.id !== existing.id) {
      throw new SchemaError(
        `node type '${input.type}' is a singleton and this workspace already has one ('${existing.id}'); id '${input.id}' refers to something else`,
        "id",
      );
    }
    return { id: existing.id, existing, matchedBy: "singleton" };
  }
  // Nothing there yet. A caller-supplied id is respected — seeding from an
  // artifact replays the ids it recorded — and the derived id is what a caller
  // that named none gets.
  return { id: input.id ?? singletonId(schema, input.type), existing: undefined };
}

function existingNodeForUpsert(
  schema: GraphSchema,
  index: SnapshotIndex,
  input: UpsertNodeInput,
): UpsertTarget {
  if (schema.nodes[input.type]?.singleton) {
    return singletonForUpsert(schema, index, input);
  }
  const minted = identityIdFromInput(schema, input.type, input.properties);
  const byId = input.id ? index.node(input.id) : undefined;
  if (minted) {
    const byIdentity = index.node(minted);
    if (input.id && input.id !== minted) {
      if (byIdentity && byId && byId.id !== byIdentity.id) {
        throw new SchemaError(
          `id '${input.id}' refers to a different node than identity of ${input.type} ('${minted}')`,
          "id",
        );
      }
      if (byIdentity) {
        return { id: minted, existing: byIdentity, matchedBy: "identity" };
      }
      if (byId) {
        return { id: byId.id, existing: byId, matchedBy: "id" };
      }
      return { id: minted, existing: undefined };
    }
    if (byIdentity) {
      return { id: minted, existing: byIdentity, matchedBy: "identity" };
    }
    if (!input.id) {
      const nearMiss = index.normalizedMatch(input.type, input.properties);
      if (nearMiss) {
        return { id: nearMiss.id, existing: nearMiss, matchedBy: "normalized" };
      }
    }
    return { id: minted, existing: undefined };
  }
  if (input.id) {
    return { id: input.id, existing: byId, matchedBy: "id" };
  }
  return { id: undefined, existing: undefined };
}

function hasOwn(map: PropertyMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Input keys this op writes (omit-keep / null-clear), plus derived keys that changed or were omitted. */
function patchKeys(
  input: Record<string, unknown>,
  after?: PropertyMap,
  before?: PropertyMap,
  defs?: Record<string, PropertyDef>,
): string[] {
  const keys = new Set(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );
  if (!after || !defs) {
    return [...keys];
  }
  const existing = before ?? {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.derived === undefined) {
      continue;
    }
    const afterHas = hasOwn(after, name);
    const beforeHas = hasOwn(existing, name);
    // The key changed if it appeared, disappeared, or its value moved.
    const changed = afterHas
      ? !beforeHas || JSON.stringify(existing[name]) !== JSON.stringify(after[name])
      : beforeHas;
    if (changed) {
      keys.add(name);
    }
  }
  return [...keys];
}

/** What a node write resolved to, before anything is committed. */
interface PlannedNode {
  id: string;
  type: string;
  /** Undefined when the write would change nothing in the graph structure. */
  op: GraphOp | undefined;
  crdt: Record<string, unknown>;
}

/**
 * Resolve one node write against the index. Extracted from `upsertNode` so the
 * single-write path and the batch path cannot drift: identity resolution,
 * near-miss adoption, derived properties, and history all happen here once.
 */
/**
 * Find what this write lands on and which incoming scalars survive.
 *
 * Separate from the planning below because near-miss adoption has a rule of its
 * own: the adopted node keeps its id, which hashes its *stored* identity
 * values, so letting the incoming spelling overwrite them would leave the id
 * permanently inconsistent with the fields it was derived from.
 */
function resolveUpsertTarget(
  schema: GraphSchema,
  index: SnapshotIndex,
  input: UpsertNodeInput,
  def: NonNullable<GraphSchema["nodes"][string]>,
): { resolved: UpsertTarget; scalars: Record<string, unknown>; providedCrdt: Record<string, unknown> } {
  const { scalars, crdt: providedCrdt } = partitionNodeProperties(def, input.properties);
  const resolved = existingNodeForUpsert(schema, index, input);
  if (resolved.matchedBy === "normalized") {
    for (const field of def.identity?.from ?? []) {
      delete scalars[field];
    }
  }
  if (resolved.existing && resolved.existing.type !== input.type) {
    throw new SchemaError(
      `node '${resolved.existing.id}' is type '${resolved.existing.type}', not '${input.type}'`,
      "type",
    );
  }
  return { resolved, scalars, providedCrdt };
}

function planNodeUpsert(
  schema: GraphSchema,
  index: SnapshotIndex,
  input: UpsertNodeInput,
  provenance: Provenance | undefined,
  tracksHistory: boolean,
): PlannedNode {
  const def = schema.nodes[input.type];
  if (!def) {
    throw new SchemaError(`unknown node type '${input.type}'`, "type");
  }
  const { resolved, scalars, providedCrdt } = resolveUpsertTarget(schema, index, input, def);
  const isCreate = !resolved.existing;
  const crdt = fillRequiredCrdt(def, providedCrdt, `nodes.${input.type}`, isCreate);
  const lww = lwwProperties(def);
  const existing = resolved.existing ? lwwOnly(resolved.existing.properties, lww) : undefined;
  const merged = assertNodeOp(schema, input.type, scalars, existing);
  const properties = applyDerivedProperties(def.properties, merged, `nodes.${input.type}`);
  const tagsResult = resolveNodeTags(schema, input.tags, resolved.existing?.tags);
  let id = resolved.id ?? identityId(schema, input.type, properties);
  if (!id) {
    id = generateId(schema.config.idStrategy);
  }
  const tracking = schema.config.changeTracking.enabled;
  const sameScalars =
    existing !== undefined && stableProperties(existing) === stableProperties(properties);
  const hasCrdtWrite = Object.keys(crdt).length > 0;
  const applyGraph = isCreate || !sameScalars || tagsResult.replaced || (hasCrdtWrite && tracking);
  if (!applyGraph) {
    return { id, type: input.type, op: undefined, crdt };
  }
  const history =
    tracksHistory && provenance
      ? historyForNodeUpsert({
          actorId: provenance.actorId,
          at: provenance.at,
          id,
          type: input.type,
          before: resolved.existing
            ? { ...resolved.existing, properties: existing ?? resolved.existing.properties }
            : undefined,
          properties,
          tags: tagsResult.replaced ? tagsResult.tags : undefined,
        })
      : undefined;
  const op: GraphOp = {
    kind: "upsertNode",
    id,
    type: input.type,
    properties,
    patch: isCreate ? undefined : patchKeys(scalars, properties, existing, def.properties),
    tags: tagsResult.replaced ? tagsResult.tags : undefined,
    meta: stampMeta(index.node(id)?.meta ?? {}, provenance, tracking),
    provenance,
    history,
  };
  return { id, type: input.type, op, crdt };
}

function planEdgeUpsert(
  schema: GraphSchema,
  index: SnapshotIndex,
  input: UpsertEdgeInput,
  provenance: Provenance | undefined,
  tracksHistory: boolean,
): { id: string; op: GraphOp } {
  let existing: GraphEdgeRecord | undefined;
  let id: string;
  if (input.id) {
    id = input.id;
    existing = index.edge(id);
  } else {
    existing = index.edgeByEndpoints(input.type, input.from, input.to);
    id =
      existing?.id ??
      generateId(schema.config.idStrategy === "literal" ? "uuid" : schema.config.idStrategy);
  }
  const from = existing?.from ?? input.from;
  const to = existing?.to ?? input.to;
  const properties = assertEdgeOpWith(
    schema,
    (nodeId) => index.node(nodeId),
    input.type,
    from,
    to,
    input.properties ?? {},
    existing?.properties,
  );
  const history =
    tracksHistory && provenance
      ? historyForEdgeUpsert({
          actorId: provenance.actorId,
          at: provenance.at,
          id,
          type: input.type,
          from,
          to,
          before: existing,
          properties,
        })
      : undefined;
  const op: GraphOp = {
    kind: "upsertEdge",
    id,
    type: input.type,
    from,
    to,
    properties,
    patch: existing ? patchKeys(input.properties ?? {}) : undefined,
    meta: stampMeta(
      index.edge(id)?.meta ?? {},
      provenance,
      schema.config.changeTracking.enabled,
    ),
    provenance,
    history,
  };
  return { id, op };
}

/** What one batch entry resolves against: the graph so far, plus the refs named so far. */
interface BatchContext {
  schema: GraphSchema;
  index: SnapshotIndex;
  provenance: Provenance | undefined;
  tracksHistory: boolean;
  refs: Record<string, string>;
}

interface PlannedEntry {
  id: string;
  op: GraphOp | undefined;
  /** Present when the entry also has CRDT fields to write after the batch. */
  crdt?: PlannedNode;
}

function resolveRef(context: BatchContext, ref: NodeRef, side: "from" | "to"): string {
  if (typeof ref === "string") {
    return ref;
  }
  const id = context.refs[ref.ref];
  if (id === undefined) {
    throw new SchemaError(
      `unknown ref '${ref.ref}'. Refs must be declared by an earlier entry in the same batch.`,
      side,
    );
  }
  return id;
}

function planBatchDelete(
  context: BatchContext,
  input: { op: "deleteNode" | "deleteEdge"; id: string },
): PlannedEntry {
  const { provenance, tracksHistory, index } = context;
  const tracked = tracksHistory && provenance ? provenance : undefined;
  const stamp = tracked ? { actorId: tracked.actorId, at: tracked.at, id: input.id } : undefined;
  if (input.op === "deleteNode") {
    const history = stamp ? historyForNodeDelete({ ...stamp, before: index.node(input.id) }) : undefined;
    return { id: input.id, op: { kind: "deleteNode", id: input.id, provenance, history } };
  }
  const history = stamp ? historyForEdgeDelete({ ...stamp, before: index.edge(input.id) }) : undefined;
  return { id: input.id, op: { kind: "deleteEdge", id: input.id, provenance, history } };
}

/** Resolve one batch entry against everything the batch has planned before it. */
function planBatchEntry(context: BatchContext, input: GraphOpInput): PlannedEntry {
  const { schema, index, provenance, tracksHistory } = context;
  if (input.op === "upsertNode") {
    const { op: _op, ref, ...node } = input;
    const plan = planNodeUpsert(schema, index, node, provenance, tracksHistory);
    if (ref !== undefined) {
      context.refs[ref] = plan.id;
    }
    return {
      id: plan.id,
      op: plan.op,
      crdt: Object.keys(plan.crdt).length > 0 ? plan : undefined,
    };
  }
  if (input.op === "upsertEdge") {
    return planEdgeUpsert(
      schema,
      index,
      {
        type: input.type,
        from: resolveRef(context, input.from, "from"),
        to: resolveRef(context, input.to, "to"),
        properties: input.properties,
        id: input.id,
      },
      provenance,
      tracksHistory,
    );
  }
  return planBatchDelete(context, input);
}

/**
 * A live workspace: reads, writes, presence and the CRDT document behind them.
 *
 * The optional type parameter is a workspace's type map — the `GraphTypes<…>`
 * a generated module exports. Supplying it narrows every read and write to that
 * schema's own node and edge types; leaving it off keeps the untyped shapes
 * this class has always had, which is why nothing downstream had to change.
 * Supply it at the boundary (`CollabSession.open<Planner>(…)`) or with `as()`
 * on a session handed over by something generic, like the hub.
 */
export class CollabSession<S extends GraphTypeMap = AnyGraph> {
  private constructor(
    readonly id: string,
    readonly schema: GraphSchema,
    readonly actorId: string | undefined,
    readonly backendKind: string,
    private readonly backend: CollabBackend,
    private readonly handle: CollabHandle,
    private readonly store: GraphStore | undefined,
    private readonly projector: Projector,
    private readonly ownsStore: boolean,
    private readonly ownsResources = true,
  ) {}

  /**
   * Open a workspace, creating it if it does not exist. Pass `undefined` to let
   * the backend mint an id.
   *
   * Idempotent by design: N browser tabs calling this with the same id land on
   * the same document. The create/join pair it replaces made the caller decide
   * which of the two to call, which is a race no application can win.
   */
  static async open<S extends GraphTypeMap = AnyGraph>(
    id: string | undefined,
    options: CollabSessionOptions,
  ): Promise<CollabSession<S>> {
    const handle = await options.collab.open(id, options.schema, {
      actorId: options.actorId,
      peerKind: options.peerKind,
    });
    return CollabSession.connect<S>(options.schema, options, handle);
  }

  /**
   * The same session, seen through a workspace's types.
   *
   * A session that arrives from something schema-agnostic — the hub, a join
   * route, a test helper — is a `CollabSession<AnyGraph>`. This is how an
   * application that does know its schema puts the types back on, without a
   * reconnect and without an `as` at every call site downstream.
   *
   * It also goes the other way: `session.as()` with no type argument drops back
   * to the untyped session, which is what library code that serves *any* schema
   * asks for. The parameter is invariant — it is both read and written — so a
   * typed session is not silently a substitute for an untyped one, and saying
   * so explicitly is better than every such API guessing.
   */
  as<S2 extends GraphTypeMap = AnyGraph>(): CollabSession<S2> {
    return this as unknown as CollabSession<S2>;
  }

  /**
   * A session over a handle the caller already opened.
   *
   * `open` is the usual door; this is for the cases where the handle does not
   * come from an id — `CollabBackend.restore` rebuilding a finished document
   * from its bytes, most of all, where there is no id to open and the document
   * exists only in memory.
   */
  static async adopt<S extends GraphTypeMap = AnyGraph>(
    handle: CollabHandle,
    options: CollabSessionOptions,
  ): Promise<CollabSession<S>> {
    return CollabSession.connect<S>(options.schema, options, handle);
  }

  private static async connect<S extends GraphTypeMap = AnyGraph>(
    schema: GraphSchema,
    options: CollabSessionOptions,
    handle: CollabHandle,
  ): Promise<CollabSession<S>> {
    for (const node of handle.graph.snapshot().nodes) {
      await handle.graph.ensureCollab(node.id, node.type);
    }
    const scope: WorkspaceScope = {
      workspaceId: handle.id,
      schemaId: schema.config.schemaId,
    };
    const projector = new Projector(schema, scope, handle.graph, options.graph);
    await projector.start();
    return new CollabSession<S>(
      handle.id,
      schema,
      options.actorId,
      options.collab.kind,
      options.collab,
      handle,
      options.graph,
      projector,
      options.ownsStore ?? true,
    );
  }

  /** What this session's backend can do; see `CollabBackendCapabilities`. */
  get capabilities(): CollabBackendCapabilities {
    return this.backend.capabilities;
  }

  /** Whether this workspace maintains a queryable projection. */
  get projected(): boolean {
    return this.store !== undefined;
  }

  snapshot(): GraphSnapshot<S> {
    return this.handle.graph.snapshot() as unknown as GraphSnapshot<S>;
  }

  /**
   * Who is connected right now. Throws on a backend whose
   * `capabilities.presence` is false rather than reporting a room of one.
   */
  presence(): Presence {
    return this.handle.presence();
  }

  peers(): Peer[] {
    return this.handle.presence().peers();
  }

  async ensureCollab(nodeId: string, nodeType?: string): Promise<void> {
    const type =
      nodeType ?? this.handle.graph.snapshot().nodes.find((node) => node.id === nodeId)?.type;
    if (!type) {
      throw new SchemaError(`unknown node '${nodeId}'`, "id");
    }
    await this.handle.graph.ensureCollab(nodeId, type);
  }

  collabText(nodeId: string, field: string): CollabText {
    this.requireCollabField(nodeId, field, "text");
    return this.handle.graph.collabText(nodeId, field);
  }

  collabMap(nodeId: string, field: string): CollabMap {
    this.requireCollabField(nodeId, field, "map");
    return this.handle.graph.collabMap(nodeId, field);
  }

  collabArray(nodeId: string, field: string): CollabArray {
    this.requireCollabField(nodeId, field, "array");
    return this.handle.graph.collabArray(nodeId, field);
  }

  history(filter?: HistoryFilter): HistoryEntry[] {
    return this.handle.graph.history(filter);
  }

  /**
   * This document's current version, or `undefined` on a backend that has none.
   *
   * `undefined` rather than a thrown error, because a version is an
   * optimisation everywhere it is used — an artifact without one is still a
   * complete artifact, it just reopens as a re-seed instead of a checkout.
   */
  version(): VersionToken | undefined {
    return isVersioned(this.handle.graph) ? this.handle.graph.version() : undefined;
  }

  /**
   * The whole document as bytes, history included, for a caller that wants to
   * store it and open it again later.
   *
   * `shallow` drops the history that is no longer needed to keep collaborating,
   * which makes the bytes much smaller and gives up forking versions older than
   * the export.
   */
  exportDoc(mode?: DocExportMode): Uint8Array | undefined {
    return isVersioned(this.handle.graph) ? this.handle.graph.exportDoc(mode) : undefined;
  }

  /**
   * Move this session's document to a past version, or back to the latest with
   * `undefined`.
   *
   * A rewound document is read-only, which is what makes this safe on a review
   * mount and wrong on a live workspace: every peer sharing the document sees
   * the rewind. Throws on a backend that cannot do it, rather than silently
   * showing the present.
   */
  checkout(version: VersionToken | undefined): void {
    if (!isVersioned(this.handle.graph)) {
      throw unsupported(this.backendKind, "versioning");
    }
    this.handle.graph.checkout(version);
  }

  /**
   * Waits for pending background projection tasks to complete.
   */
  async drain(): Promise<void> {
    await this.projector.drain();
  }


  /**
   * Light proxy that writes with a different actorId on the same document.
   * Requires changeTracking.enabled.
   */
  runAs(actorId: string): CollabSession {
    if (!this.schema.config.changeTracking.enabled) {
      throw new SchemaError(
        "runAs requires changeTracking.enabled",
        "config.changeTracking",
      );
    }
    return new CollabSession(
      this.id,
      this.schema,
      actorId,
      this.backendKind,
      this.backend,
      this.handle,
      this.store,
      this.projector,
      false,
      false,
    );
  }

  onChange(listener: ProjectorListener<S>): () => void {
    return this.projector.on(listener as unknown as ProjectorListener);
  }

  /**
   * Ranked full text, answered by whichever graph store backs this session —
   * Ladybug's FTS index, or the in-memory store's scan. `undefined` means the
   * backend has no index to consult and the caller should fall back, which is
   * also the answer for a workspace with no projection at all.
   *
   * Draining first is what makes a note written a moment ago findable: the
   * projector, not the CRDT, is what feeds the store.
   */
  async search(request: GraphSearchRequest): Promise<GraphSearchHit[] | undefined> {
    if (!this.store) {
      return undefined;
    }
    await this.projector.drain();
    return this.store.search?.(this.scope(), request);
  }

  /**
   * Nearest neighbours by meaning rather than by wording — the half of search
   * that can answer "anything about hiring?" when no note contains the word.
   *
   * Same drain, and for a sharper reason: the embedding of a note is written
   * during projection, so a note the user just dictated is not merely unindexed
   * before this, it has no vector at all.
   */
  async searchVector(request: GraphVectorRequest): Promise<GraphSearchHit[] | undefined> {
    if (!this.store) {
      return undefined;
    }
    await this.projector.drain();
    return this.store.searchVector?.(this.scope(), request);
  }

  /** What this session's store can actually search by, used to describe the tools honestly. */
  searchModes(): GraphSearchModes {
    return this.store?.searchModes?.(this.scope()) ?? { text: false, vector: false };
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    if (!this.store) {
      throw new GraphStoreError(
        "this workspace has no projection, so it cannot answer Cypher. " +
          "Pass a `graph` store when opening it, or read through snapshot().",
      );
    }
    await this.projector.drain();
    return this.store.query(this.scope(), cypher, params);
  }

  async upsertNode(input: UpsertNodeInput<S>, options?: MutationOptions): Promise<string> {
    const index = new SnapshotIndex(this.schema, this.handle.graph.snapshot());
    const provenance = provenanceFor(this.schema, this.resolveActor(options));
    const plan = planNodeUpsert(this.schema, index, loose(input), provenance, this.tracksHistory());
    if (plan.op) {
      this.handle.graph.apply(plan.op);
    }
    await this.writeCrdt(plan);
    await this.projector.drain();
    return plan.id;
  }

  /**
   * Commit many writes as one CRDT transaction, one projection pass, and one
   * drain.
   *
   * This is the path template instantiation takes. Doing the same work through
   * repeated `upsertNode` calls cost a full snapshot and three linear scans per
   * node — 856 ms to seed an 800-node graph, on every workspace open.
   *
   * Entries resolve in order and see each other: a node can name itself with
   * `ref`, and a later edge can point at it with `{ ref }`.
   */
  async applyOps(inputs: GraphOpInput<S>[], options?: MutationOptions): Promise<ApplyOpsResult> {
    const index = new SnapshotIndex(this.schema, this.handle.graph.snapshot());
    const context: BatchContext = {
      schema: this.schema,
      index,
      provenance: provenanceFor(this.schema, this.resolveActor(options)),
      tracksHistory: this.tracksHistory(),
      refs: {},
    };
    const ops: GraphOp[] = [];
    const crdtWrites: PlannedNode[] = [];
    const ids: string[] = [];

    for (const input of inputs) {
      const planned = planBatchEntry(context, input);
      if (planned.op) {
        ops.push(planned.op);
        index.absorb(planned.op);
      }
      if (planned.crdt) {
        crdtWrites.push(planned.crdt);
      }
      ids.push(planned.id);
    }

    this.handle.graph.applyBatch(ops);
    // CRDT fields live outside the op log - they are their own replicated
    // types - so they are written after the structural batch commits.
    for (const plan of crdtWrites) {
      await this.writeCrdt(plan);
    }
    await this.projector.drain();
    return { ids, refs: context.refs, applied: ops.length };
  }

  /**
   * Alias for applyOps to apply a batch of graph operations atomically.
   */
  async applyBatch(ops: GraphOpInput<S>[], options?: MutationOptions): Promise<ApplyOpsResult> {
    return this.applyOps(ops as GraphOpInput<S>[], options);
  }

  /**
   * Execute a batch of mutations using a fluent BatchBuilder.
   */
  async batch(
    fn: (b: BatchBuilder<S>) => void | Promise<void>,
    options?: MutationOptions,
  ): Promise<ApplyOpsResult> {
    const builder = new BatchBuilder<S>();
    await fn(builder);
    return this.applyOps(builder.ops, options);
  }

  /**
   * Computes the diff between a previous snapshot and the current state,
   * returning structural ops, human/LLM-readable markdown, and a boolean flag.
   */
  diffSince(previousSnapshot: GraphSnapshot<S>): {
    ops: GraphOp[];
    markdown: string;
    hasChanges: boolean;
  } {
    const current = this.snapshot();
    const ops = diffSnapshots(loose(previousSnapshot), loose(current));
    const markdown = diffSnapshotsToMarkdown(loose(previousSnapshot), loose(current));
    return {
      ops,
      markdown,
      hasChanges: ops.length > 0,
    };
  }

  /**
   * Seeds this workspace from a WorkspaceType's template (or TemplateDef).
   * Parameter values are validated against type.params, evaluated in expressions
   * and loops, and applied in a single batch transaction.
   */
  async seedTemplate(
    type: WorkspaceType,
    params?: Record<string, unknown>,
    options?: MutationOptions,
  ): Promise<ApplyOpsResult> {
    // A template is compiled from the runtime WorkspaceType, so its ops are
    // only ever as typed as that schema — which is to say, not.
    const ops = compileTemplate(type, params) as GraphOpInput<S>[];
    return this.applyOps(ops, options);
  }

  async deleteNode(id: string, options?: MutationOptions): Promise<void> {
    const snap = this.handle.graph.snapshot();
    const before = snap.nodes.find((node) => node.id === id);
    const provenance = provenanceFor(this.schema, this.resolveActor(options));
    const history =
      this.tracksHistory() && provenance
        ? historyForNodeDelete({
            actorId: provenance.actorId,
            at: provenance.at,
            id,
            before,
          })
        : undefined;
    this.handle.graph.apply({ kind: "deleteNode", id, provenance, history });
    await this.projector.drain();
  }

  async upsertEdge(input: UpsertEdgeInput<S>, options?: MutationOptions): Promise<string> {
    const index = new SnapshotIndex(this.schema, this.handle.graph.snapshot());
    const provenance = provenanceFor(this.schema, this.resolveActor(options));
    const planned = planEdgeUpsert(this.schema, index, loose(input), provenance, this.tracksHistory());
    this.handle.graph.apply(planned.op);
    await this.projector.drain();
    return planned.id;
  }

  async deleteEdge(id: string, options?: MutationOptions): Promise<void> {
    const snap = this.handle.graph.snapshot();
    const before = snap.edges.find((edge) => edge.id === id);
    const provenance = provenanceFor(this.schema, this.resolveActor(options));
    const history =
      this.tracksHistory() && provenance
        ? historyForEdgeDelete({
            actorId: provenance.actorId,
            at: provenance.at,
            id,
            before,
          })
        : undefined;
    this.handle.graph.apply({ kind: "deleteEdge", id, provenance, history });
    await this.projector.drain();
  }

  guidelinesFor(kind: "node" | "edge", type: string, language?: string): string[] {
    return guidelinesFor(this.schema, kind, type, language);
  }

  /** Disconnect this peer. The document survives for whoever is still joined. */
  async close(): Promise<void> {
    if (!this.ownsResources) {
      return;
    }
    this.projector.stop();
    try {
      await this.projector.drain();
    } catch {
      // Projection may have failed; still release the store and collab handle.
    }
    if (this.ownsStore) {
      await this.store?.close();
    }
    await this.handle.close();
  }

  /**
   * End the workspace: capture nothing, keep nothing, leave nothing behind.
   *
   * Returns the final snapshot, because the ordering — drain, snapshot, then
   * tear down — is the one every caller needs and the one `close()` made easy
   * to get wrong. The projected copy is dropped and the document is deleted, so
   * a persisted backend does not keep a terminated workspace readable by anyone
   * holding its id.
   */
  async destroy(): Promise<GraphSnapshot> {
    if (!this.backend.capabilities.deletion) {
      throw new GraphStoreError(
        `the '${this.backendKind}' backend cannot delete documents, so this workspace cannot be destroyed. ` +
          "Use close() and remove it through the relay's own API.",
      );
    }
    this.projector.stop();
    try {
      await this.projector.drain();
    } catch {
      // A failed projection must not block reclaiming the document.
    }
    const snapshot = this.handle.graph.snapshot();
    await this.projector.drop();
    if (this.ownsStore) {
      await this.store?.close();
    }
    await this.handle.close();
    await this.backend.delete(this.id);
    return snapshot;
  }

  private scope(): WorkspaceScope {
    return { workspaceId: this.id, schemaId: this.schema.config.schemaId };
  }

  private async writeCrdt(plan: PlannedNode): Promise<void> {
    const def = this.schema.nodes[plan.type];
    if (!def) {
      return;
    }
    await this.handle.graph.ensureCollab(plan.id, plan.type);
    const kinds = crdtProperties(def);
    for (const [name, value] of Object.entries(plan.crdt)) {
      const kind = kinds[name];
      if (kind === "text") {
        const text = this.handle.graph.collabText(plan.id, name);
        text.replace(String(value));
        await text.flushed?.();
      } else if (kind === "map") {
        this.handle.graph.collabMap(plan.id, name).replace(value as Record<string, unknown>);
      } else if (kind === "array") {
        this.handle.graph.collabArray(plan.id, name).replace(value as unknown[]);
      }
    }
  }

  private resolveActor(options?: MutationOptions): string | undefined {
    if (options?.actorId !== undefined && !this.schema.config.changeTracking.enabled) {
      throw new SchemaError(
        "actorId override requires changeTracking.enabled",
        "config.changeTracking",
      );
    }
    return options?.actorId ?? this.actorId;
  }

  private requireCollabField(nodeId: string, field: string, kind: CrdtPropertyType): void {
    const node = this.handle.graph.snapshot().nodes.find((item) => item.id === nodeId);
    if (!node) {
      throw new SchemaError(`unknown node '${nodeId}'`, "id");
    }
    assertCrdtField(this.schema, node.type, field, kind);
  }

  private tracksHistory(): boolean {
    return (
      this.schema.config.changeTracking.enabled && this.schema.config.changeTracking.mode === "history"
    );
  }
}

function lwwOnly(properties: PropertyMap, lww: ReturnType<typeof lwwProperties>): PropertyMap {
  const result: PropertyMap = {};
  for (const key of Object.keys(lww)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      result[key] = properties[key]!;
    }
  }
  return result;
}

function stableProperties(properties: PropertyMap): string {
  return JSON.stringify(properties);
}

export { CollabSession as Workspace };


