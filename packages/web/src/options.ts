import type { CollabBackend } from "@collabnode/collab";
import type { GraphStore } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";

export interface AzureTokenResponse {
  jwt: string;
}

/** Same shape Fluid's AzureClient expects. Implement via `httpTokenProvider`. */
export interface AzureTokenProvider {
  fetchOrdererToken(tenantId: string, documentId?: string): Promise<AzureTokenResponse>;
  fetchStorageToken(tenantId: string, documentId?: string): Promise<AzureTokenResponse>;
}

export type WebCollabKind =
  | { kind: "fluid"; relay?: "tinylicious"; domain?: string; port?: number }
  | {
      kind: "fluid";
      relay: "azure";
      tenantId: string;
      endpoint: string;
      tokenProvider: AzureTokenProvider;
    }
  | { kind: "hocuspocus"; url: string }
  | { kind: "custom"; backend: CollabBackend };

export type WebGraphKind = { kind: "memory" } | { kind: "custom"; store: GraphStore };

export interface ConnectOptions {
  /** Parsed schema JSON from `webJoinInfo`, or YAML text. Not a filesystem path. */
  schema: GraphSchema | string;
  /** Room id from the server. Browsers join; they do not create documents. */
  documentId: string;
  actorId?: string;
  collab: WebCollabKind;
  graph?: WebGraphKind;
}
