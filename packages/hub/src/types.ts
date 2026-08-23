import type { CollabBackend } from "@collabnode/collab";
import type { EmbeddingProvider, GraphSnapshot, GraphStore, HistoryEntry } from "@collabnode/graph";
import type { WorkspaceType } from "@collabnode/schema";

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
}

export interface Lease {
  id: string;
  token: string;
  expiresAt: number;
}

export interface WorkspaceRecord {
  id: string;
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
}

export interface OpenWorkspaceOptions {
  /** Caller-supplied id. If omitted, minted by the hub. */
  id?: string;
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
}
