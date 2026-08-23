import type { CollabBackend } from "@collabnode/collab";
import type { EmbeddingProvider, GraphStore } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import { fileURLToPath } from "node:url";

export type CollabKind =
  | { kind: "memory" }
  | {
      kind: "fluid";
      relay?: "tinylicious" | "azure";
      port?: number;
      domain?: string;
      /** Pin Tinylicious snapshots (e.g. `data/tinylicious`) so documentIds survive restart. */
      storageDir?: string;
      /**
       * `relay: "azure"` only. The route this server mounts with
       * `createFluidTokenHandler`, e.g. `/api/fluid/token`. It travels in the
       * join descriptor so a browser can reach the relay without ever seeing
       * the tenant key; without it, browser peers have to build a token
       * provider themselves.
       */
      tokenEndpoint?: string;
    }
  | { kind: "hocuspocus"; port?: number; url?: string }
  | { kind: "custom"; backend: CollabBackend };

export type GraphKind =
  /**
   * No projection. The CRDT is the source of truth and reads go through
   * `snapshot()`; `query` refuses rather than answering from a store that does
   * not exist. Right for short-lived workspaces that are never queried.
   */
  | { kind: "none" }
  | { kind: "memory" }
  | { kind: "ladybug"; path: string }
  | {
      kind: "age";
      url?: string;
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      database?: string;
      graphName?: string;
      ssl?: boolean;
      reset?: boolean;
    }
  | { kind: "custom"; store: GraphStore };

/**
 * Where embeddings come from, for schemas that mark properties `vector: true`.
 *
 * Off by default: semantic search costs a model, and a schema that never asks
 * for it should never pay for one. `local` runs bge-small on this machine
 * through transformers.js — no API key, nothing leaving the process.
 */
export type EmbeddingsKind =
  | false
  | { kind: "local"; model?: string; dimensions?: number }
  | { kind: "custom"; provider: EmbeddingProvider };

export type McpKind = boolean | { listen?: string; language?: string };

export interface InitOptions {
  schema: string | URL | GraphSchema;
  actorId?: string;
  documentId?: string;
  collab?: CollabKind;
  graph?: GraphKind;
  embeddings?: EmbeddingsKind;
  mcp?: McpKind;
}

export interface ResolvedInit {
  schema: GraphSchema | string;
  actorId?: string;
  documentId?: string;
  collab: CollabKind;
  graph: GraphKind;
  embeddings: EmbeddingsKind;
  mcp: McpKind;
}

export function resolveOptions(options: InitOptions): ResolvedInit {
  return {
    schema: options.schema instanceof URL ? fileURLToPath(options.schema) : options.schema,
    actorId: options.actorId,
    documentId: options.documentId,
    collab: options.collab ?? { kind: "memory" },
    graph: options.graph ?? { kind: "memory" },
    embeddings: options.embeddings ?? false,
    mcp: options.mcp ?? true,
  };
}
