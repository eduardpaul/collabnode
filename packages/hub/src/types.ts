import type { CollabBackend, DocExportMode, VersionToken } from "@collabnode/collab";
import type { EmbeddingProvider, GraphSnapshot, GraphStore, HistoryEntry } from "@collabnode/graph";

export type WorkspaceState = "seeding" | "active" | "ending" | "ended" | "failed";

export type EndReason = "idle" | "duration" | "predicate" | "explicit" | "error";

export interface Participant {
  actorId: string;
  kind: "human" | "agent";
  joinedAt: string;
  leftAt?: string;
}

export interface WorkspaceArtifact {
  id: string;
  type: string;
  version: number;
  params: Record<string, unknown>;
  openedAt: string;
  endedAt: string;
  endedBy: EndReason;
  participants: Participant[];
  snapshot: GraphSnapshot;
  history?: HistoryEntry[];
  /**
   * The CRDT version the document ended at, on a backend that can name one.
   *
   * Not to be confused with `version` above, which is the workspace *type's*
   * version. The snapshot is still the portable record every consumer can read;
   * this is what lets one that kept `bytes` ask what changed between two
   * artifacts, or reopen this one at an earlier point.
   */
  documentVersion?: VersionToken;
  /**
   * The document itself, for a backend whose `capabilities.versioning` is true.
   *
   * With it, `hub.reopen` is a checkout: the review mount keeps the workspace's
   * history and can be rewound. Without it, reopening replays the snapshot into
   * a fresh document, which shows the same graph but has no past. Undefined on
   * Yjs and Fluid.
   */
  bytes?: Uint8Array;
}

export interface Lease {
  id: string;
  token: string;
  expiresAt: number;
}

export interface WorkspaceRecord {
  id: string;
  /**
   * What a person called this workspace, when a person named it.
   *
   * Ids have to stay URL- and MCP-path-safe, so the name someone typed cannot
   * be one. Without a place for it here, every app that lets people name
   * workspaces ends up keeping a second store beside the registry, and a name
   * created on one replica goes missing on the next.
   */
  label?: string;
  typeName: string;
  version: number;
  params: Record<string, unknown>;
  state: WorkspaceState;
  openedAt: string;
  lastActivityAt: string;
  lastWriteAt: string;
  endedAt?: string;
  endedBy?: EndReason;
  leaseToken?: string;
  leaseExpiresAt?: number;
  collabDocId?: string;
}


export interface WorkspaceRegistry {
  claim(id: string, ttlMs: number): Promise<Lease | undefined>;
  heartbeat(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<void>;
  due(now: number, limit?: number): Promise<WorkspaceRecord[]>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  put(record: WorkspaceRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: { state?: WorkspaceState; typeName?: string }): Promise<WorkspaceRecord[]>;
  /**
   * The record whose collab document is `collabDocId`, if this registry indexes
   * them. Optional: callers fall back to a `list()` scan, which is correct and
   * costs a read per live workspace. Answering "may this caller open this
   * document?" is on the request path of every browser join, so an index is
   * worth having wherever `list()` is not free.
   */
  findByCollabDocId?(collabDocId: string): Promise<WorkspaceRecord | undefined>;
}

export interface OpenWorkspaceOptions {
  /** Caller-supplied id. If omitted, minted by the hub. */
  id?: string;
  /**
   * Display name for this workspace, stored on the record. Set on create;
   * joining an existing workspace with a new label renames it.
   */
  label?: string;
  /** Parameter values for template and lifecycle evaluation. */
  params?: Record<string, unknown>;
  /** Seed from an existing artifact. */
  from?: WorkspaceArtifact;
  /** Actor id for this participant. */
  actorId?: string;
  /** Peer kind for presence ("human" | "agent"). Default "human". */
  peerKind?: "human" | "agent";
  /** Optional callback fired when this workspace terminates. */
  onEnd?: (artifact: WorkspaceArtifact) => Promise<void> | void;
}

export interface ReopenOptions {
  actorId?: string;
  /**
   * Mount the artifact rewound to this version rather than to how it ended.
   *
   * Only possible when the artifact carries `bytes`; reopening a snapshot-only
   * artifact at a past version is refused out loud rather than quietly showing
   * the final state, which would be indistinguishable from working.
   */
  at?: VersionToken;
}

export interface HubOptions {
  /**
   * The backend every workspace in this hub opens on. `{ kind: "memory" }` and
   * omitting it both give an in-process `InMemoryCollabBackend`.
   *
   * Anything networked is constructed by the caller and passed in as a
   * `CollabBackend` — `openCollab()` in `collabnode` resolves the descriptors.
   * This package deliberately depends on no transport, so a descriptor it
   * cannot build would have to be silently downgraded to memory, which is
   * indistinguishable from working until you notice nobody else is there.
   */
  collab?: CollabBackend | { kind: "memory" };
  registry?: WorkspaceRegistry;
  graph?: GraphStore;
  embeddings?: EmbeddingProvider;
  mcp?: {
    mount?: string;
  };
  /**
   * Periodic reaper sweep interval in milliseconds.
   * Defaults to 10,000ms. Set to 0 or negative to disable the internal timer
   * (e.g. when driving `hub.sweep()` externally via cron).
   */
  sweepIntervalMs?: number;
  /**
   * Default callback fired when any workspace in the hub terminates.
   * Executed during the termination sequence before storage cleanup.
   */
  onEnd?: (artifact: WorkspaceArtifact) => Promise<void> | void;
  /**
   * How much of a document goes into `WorkspaceArtifact.bytes` on a versioned
   * backend. Default `"snapshot"`: the whole history, so a reopened artifact can
   * be rewound to any point the workspace passed through.
   *
   * `"shallow"` keeps only the history still needed to collaborate, which is
   * dramatically smaller on a long-running workspace and gives up rewinding
   * past the moment it ended. Right for a host that stores thousands of
   * artifacts and reviews them as finished documents. Ignored by backends
   * without versioning, which store no bytes either way.
   */
  artifactExport?: DocExportMode;
}
