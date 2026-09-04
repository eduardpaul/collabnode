import type { GraphOp, GraphSnapshot, HistoryEntry, HistoryFilter } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import type { CollabArray, CollabMap, CollabText } from "./fields.js";
import type { PeerKind, Presence } from "./presence.js";

/**
 * A point in a document's history, as the backend that minted it describes it.
 *
 * Deliberately opaque and deliberately stringly: a version has to survive being
 * written into a `WorkspaceArtifact`, stored as JSON, and read back by a
 * different process, and no two CRDTs agree on what a version *is* — Loro's is
 * a set of DAG frontiers, another backend's might be a sequence number. `kind`
 * is what stops one being handed to a backend that would misread it.
 */
export interface VersionToken {
  /** The `CollabBackend.kind` that minted this token. */
  kind: string;
  /** Backend-private encoding. Only the backend that minted it may parse it. */
  encoded: string;
}

/** How a whole document is serialized for storage or transfer. */
export type DocExportMode =
  /** State plus the complete history. Restores to a document that can still be forked at any past version. */
  | "snapshot"
  /** State plus only the history needed to keep collaborating. Git's shallow clone. */
  | "shallow";

/**
 * The parts of `CollaborativeGraph` that only a versioned backend can answer.
 *
 * Every member is optional on the graph itself so that Yjs and Fluid keep
 * satisfying the interface unchanged; `capabilities.versioning` is how a caller
 * learns whether they are there, in the same declared-rather-than-discovered
 * spirit as the other three flags.
 */
export interface VersionedGraph {
  /** The document's current version. */
  version(): VersionToken;
  /**
   * The ops that carry a projection from `version` to `to` — or to the
   * document's present, when `to` is omitted.
   *
   * `undefined` means this document cannot answer: the version came from
   * another backend, or its history has been shallow-trimmed past that point.
   * It never means "nothing changed" — that is the empty array, and confusing
   * the two would leave a projection silently stale.
   *
   * `to` exists because a caller that already read a snapshot needs the ops for
   * *that* version, not for whatever has landed since; without it a diff and
   * the snapshot beside it can disagree about how far along they are.
   */
  diffSince(version: VersionToken, to?: VersionToken): GraphOp[] | undefined;
  /** Serialize the whole document, history included unless `mode` says otherwise. */
  exportDoc(mode?: DocExportMode): Uint8Array;
  /**
   * Move the document to a past version, or back to the latest when passed
   * `undefined`. Reads after this see that version; writes are refused while
   * detached, which is what makes it safe for a review mount.
   */
  checkout(version: VersionToken | undefined): void;
}

/**
 * Backend-agnostic collaborative graph. Fluid, Hocuspocus, Loro, and the
 * in-memory test double all implement this.
 *
 * The required surface is snapshot-shaped on purpose: `subscribe` hands out a
 * whole snapshot and the projector diffs two of them, so no caller depends on a
 * vendor's event model. A backend that can do better says so through the
 * optional `VersionedGraph` members below and the projector takes them; the
 * snapshot path stays the floor every backend meets.
 */
export interface CollaborativeGraph {
  readonly schemaId: string;
  readonly schemaHash: string;
  snapshot(): GraphSnapshot;
  apply(op: GraphOp): void;
  /**
   * Commit many ops as one CRDT transaction and one subscriber notification.
   *
   * Seeding a document one `apply` at a time costs a transaction, a snapshot,
   * and a projection pass per node, which is what made template instantiation
   * super-linear. Both vendors already have the primitive — `doc.transact` and
   * `Tree.runTransaction` — so this exposes it rather than adding it.
   */
  applyBatch(ops: GraphOp[]): void;
  history(filter?: HistoryFilter): HistoryEntry[];
  subscribe(listener: CollabListener): () => void;
  ensureCollab(nodeId: string, nodeType: string): Promise<void>;
  collabText(nodeId: string, field: string): CollabText;
  collabMap(nodeId: string, field: string): CollabMap;
  collabArray(nodeId: string, field: string): CollabArray;

  // Versioning. Present only when `capabilities.versioning` is true; see
  // `VersionedGraph` for what each one promises.
  version?: VersionedGraph["version"];
  diffSince?: VersionedGraph["diffSince"];
  exportDoc?: VersionedGraph["exportDoc"];
  checkout?: VersionedGraph["checkout"];
}

/**
 * Narrow a graph to one that can answer version questions.
 *
 * Callers should reach for this rather than probing a single method: a backend
 * that has `version()` but not `diffSince()` would satisfy a one-method check
 * and then fail halfway through the work.
 */
export function isVersioned(
  graph: CollaborativeGraph,
): graph is CollaborativeGraph & VersionedGraph {
  return (
    typeof graph.version === "function" &&
    typeof graph.diffSince === "function" &&
    typeof graph.exportDoc === "function" &&
    typeof graph.checkout === "function"
  );
}

export type CollabListener = (snapshot: GraphSnapshot) => void;

export interface CollabHandle {
  id: string;
  graph: CollaborativeGraph;
  /**
   * Who is connected. Throws `CollabError` on backends whose
   * `capabilities.presence` is false rather than reporting a room of one as if
   * it were the whole room.
   */
  presence(): Presence;
  close(): Promise<void>;
}

/**
 * What a backend can actually do, declared rather than discovered in
 * production. Ephemeral workspaces need all three; a backend missing one is
 * still useful for durable documents, and saying so here is what lets a caller
 * pick correctly instead of finding out at termination time.
 */
export interface CollabBackendCapabilities {
  /**
   * `open` can *create* a document under a caller-chosen id.
   *
   * False for relay-minted-id backends (Fluid/Azure attach the container and
   * hand back an id). Those still reopen an id they minted - joining works
   * either way - but a caller that wants to name its own workspaces has to
   * keep the id mapping itself, which is why the distinction is surfaced
   * rather than papered over.
   */
  namedDocuments: boolean;
  /** `delete` removes the document's content and its persisted copy. */
  deletion: boolean;
  /** `presence()` reports real remote peers, not just this client. */
  presence: boolean;
  /**
   * The graph implements `VersionedGraph`: versions can be named, diffed
   * against, exported, and checked out.
   *
   * False is the honest answer for Yjs and Fluid. Both have an internal notion
   * of state that a peer could in principle name, but neither exposes one that
   * survives a round trip through an artifact, and a caller that assumed
   * otherwise would silently get a full re-seed where it asked for a checkout.
   */
  versioning: boolean;
}

export interface OpenOptions {
  /** Identity this connection publishes to presence and attributes writes to. */
  actorId?: string;
  peerKind?: PeerKind;
}

export interface CollabBackend {
  readonly kind: string;
  readonly capabilities: CollabBackendCapabilities;
  /**
   * Open-or-create, idempotent. `undefined` asks the backend to mint an id;
   * a string opens that document, creating it when absent.
   *
   * This replaces the create/join pair, which forced the caller to know whether
   * a document already existed — a race no application with N tabs can win.
   */
  open(id: string | undefined, schema: GraphSchema, options?: OpenOptions): Promise<CollabHandle>;
  /**
   * Destroy the document. Without this an "ephemeral" workspace is only
   * ephemeral in memory: with persistence on — which crash recovery requires —
   * a terminated workspace stays readable by anyone holding its id.
   */
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  /**
   * Rebuild a document from `VersionedGraph.exportDoc` bytes, detached from any
   * live document and from any persisted copy.
   *
   * This is what makes reviewing a finished workspace a *checkout* rather than
   * a re-seed: the restored document keeps its history, so it can be forked,
   * diffed against, and rewound. Present only when `capabilities.versioning`
   * is true.
   */
  restore?(
    bytes: Uint8Array,
    schema: GraphSchema,
    options?: OpenOptions,
  ): Promise<CollabHandle>;
}

export class CollabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollabError";
  }
}

/** Uniform refusal for a capability a backend has declared it lacks. */
export function unsupported(kind: string, feature: keyof CollabBackendCapabilities): CollabError {
  const why: Record<keyof CollabBackendCapabilities, string> = {
    namedDocuments: "cannot create a document under a caller-chosen id; open with `undefined` and keep the id it returns",
    deletion: "cannot delete documents; remove them through the relay's own API",
    presence: "does not report peers",
    versioning:
      "cannot name, diff, or check out versions; read history() and snapshot() instead, or open the document on a versioned backend such as @collabnode/loro",
  };
  return new CollabError(`the '${kind}' collab backend ${why[feature]}`);
}

export function assertSchemaMatch(schema: GraphSchema, snapshot: GraphSnapshot): void {
  if (snapshot.schemaId !== schema.config.schemaId) {
    throw new CollabError(
      `schemaId mismatch: document is '${snapshot.schemaId}', client loaded '${schema.config.schemaId}'`,
    );
  }
  if (snapshot.schemaHash !== schema.schemaHash) {
    throw new CollabError(
      `schemaHash mismatch: document is '${snapshot.schemaHash}', client loaded '${schema.schemaHash}'. All peers must use the same YAML.`,
    );
  }
}
