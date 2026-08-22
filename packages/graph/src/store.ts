import type { GraphSchema } from "@collabnode/schema";
import type { GraphOp, QueryResult } from "./ops.js";
import type { GraphSearchHit, GraphSearchRequest } from "./search.js";
import type { GraphVectorRequest } from "./vector.js";

/**
 * Which workspace's projection an operation belongs to.
 *
 * Passing this per call rather than per store is what lets one store, one
 * connection pool, and one set of indexes serve many concurrent workspaces.
 * A store constructed per workspace cannot: at a thousand short-lived rooms the
 * per-instance cost - a file, a pool, a schema apply - is the dominant one.
 */
export interface WorkspaceScope {
  /** Stable id of the workspace. Unique within `schemaId`. */
  workspaceId: string;
  /** The schema the workspace was opened with. */
  schemaId: string;
}

export function scopeKey(scope: WorkspaceScope): string {
  return `${scope.schemaId}\0${scope.workspaceId}`;
}

export interface GraphStore {
  /**
   * Prepare `scope` to receive ops. Idempotent per scope, and it must not
   * disturb any other scope: a shared store applying a schema for one
   * workspace cannot reset the workspace beside it.
   */
  applySchema(scope: WorkspaceScope, schema: GraphSchema): Promise<void>;
  apply(scope: WorkspaceScope, op: GraphOp): Promise<void>;
  applyBatch(scope: WorkspaceScope, ops: GraphOp[]): Promise<void>;
  query(
    scope: WorkspaceScope,
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult>;
  /**
   * Discard everything projected for `scope`, releasing whatever it held:
   * rows, files, indexes. Called on workspace termination; a store that keeps
   * scopes forever turns "ephemeral" into a slow leak.
   */
  dropScope(scope: WorkspaceScope): Promise<void>;
  /**
   * Relevance-ranked full text over the projected nodes, best first.
   *
   * `undefined` means this backend cannot answer - no index, extension missing,
   * store not ready - and the caller should fall back. An empty array means the
   * index looked and found nothing, which is a real answer. Backends that omit
   * the method entirely are treated the same as `undefined`.
   */
  search?(scope: WorkspaceScope, request: GraphSearchRequest): Promise<GraphSearchHit[] | undefined>;
  /**
   * Nearest neighbours by meaning, best first, using the embeddings the store
   * wrote as nodes were projected. Same `undefined` contract as `search`: it
   * means no vector index, no embedding provider, or a query that could not be
   * embedded - never "nothing is similar".
   */
  searchVector?(
    scope: WorkspaceScope,
    request: GraphVectorRequest,
  ): Promise<GraphSearchHit[] | undefined>;
  /**
   * Which indexes this store can answer from right now, after `applySchema`.
   *
   * Callers use it to describe the search tools honestly: a schema with no
   * `vector:` fields, or a machine that could not load the extension, should
   * not be advertising semantic search to a model.
   */
  searchModes?(scope: WorkspaceScope): GraphSearchModes;
  close(): Promise<void>;
}

export interface GraphSearchModes {
  text: boolean;
  vector: boolean;
}

export class GraphStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphStoreError";
  }
}
