import type { GraphOp, GraphSnapshot, HistoryEntry, HistoryFilter } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import type { CollabArray, CollabMap, CollabText } from "./fields.js";
import type { PeerKind, Presence } from "./presence.js";

/**
 * Backend-agnostic collaborative graph. Fluid, Hocuspocus, Loro, and the
 * in-memory test double all implement this. The projector diffs snapshots
 * rather than depending on a vendor event model.
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
