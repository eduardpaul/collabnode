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
  | ({
      kind: "fluid";
      relay: "azure";
      tenantId: string;
      endpoint: string;
    } & AzureTokenSource)
  | { kind: "hocuspocus"; url: string }
  | { kind: "custom"; backend: CollabBackend };

/**
 * How a browser gets a token for the relay — one of two ways, never neither.
 *
 * The tenant key is a bearer credential for every document in the tenant, so it
 * cannot travel to a browser and a descriptor from the server cannot carry a
 * provider built from it. `tokenEndpoint` is the usual answer: the route your
 * server mounts with `createFluidTokenHandler`, which the server can name in
 * the join payload because a URL is not a secret. `tokenProvider` stays for
 * callers minting tokens some other way.
 */
export type AzureTokenSource =
  | { tokenProvider: AzureTokenProvider; tokenEndpoint?: string }
  | { tokenProvider?: undefined; tokenEndpoint: string };

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
