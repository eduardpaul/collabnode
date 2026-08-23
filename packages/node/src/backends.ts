import type { ChildProcess } from "node:child_process";
import { AgeGraphStore } from "@collabnode/age";
import { AzureFluidCollabBackend, azureRelayFromEnv, staticKeyTokenProvider } from "@collabnode/azure";
import { InMemoryCollabBackend, type CollabBackend } from "@collabnode/collab";
import { FluidCollabBackend } from "@collabnode/fluid";
import { ensureTinylicious, releaseTinylicious } from "@collabnode/fluid/node";
import { localEmbeddings } from "@collabnode/embeddings";
import { InMemoryGraphStore, type EmbeddingProvider, type GraphStore } from "@collabnode/graph";
import {
  DEFAULT_HOCUSPOCUS_PORT,
  HocuspocusCollabBackend,
  hocuspocusUrl,
} from "@collabnode/hocuspocus";
import { ensureHocuspocus, stopHocuspocus } from "@collabnode/hocuspocus/node";
import { LadybugGraphStore } from "@collabnode/ladybug";
import type { CollabKind, EmbeddingsKind, GraphKind } from "./options.js";

export type CollabJoin =
  | { kind: "memory" }
  | { kind: "custom" }
  | { kind: "fluid"; relay: "tinylicious"; domain: string; port: number }
  | { kind: "fluid"; relay: "azure"; tenantId: string; endpoint: string; tokenEndpoint?: string }
  | { kind: "hocuspocus"; url: string };

export interface OpenedCollab {
  backend: CollabBackend;
  child?: ChildProcess;
  join: CollabJoin;
  /** Release this process's lease on a spawned collab server. */
  close: () => Promise<void> | void;
}

const noopClose = (): void => undefined;

export async function openCollab(
  collab: CollabKind,
  actorId?: string,
): Promise<OpenedCollab> {
  if (collab.kind === "custom") {
    return { backend: collab.backend, join: { kind: "custom" }, close: noopClose };
  }
  if (collab.kind === "memory") {
    return { backend: new InMemoryCollabBackend(), join: { kind: "memory" }, close: noopClose };
  }
  if (collab.kind === "hocuspocus") {
    const url = collab.url ?? hocuspocusUrl(collab.port ?? DEFAULT_HOCUSPOCUS_PORT);
    const owned = collab.url ? undefined : await ensureHocuspocus(collab.port ?? DEFAULT_HOCUSPOCUS_PORT);
    let closed = false;
    return {
      backend: new HocuspocusCollabBackend({ url }),
      join: { kind: "hocuspocus", url },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await stopHocuspocus(owned);
      },
    };
  }
  if (collab.kind === "fluid") {
    const relay = collab.relay ?? "tinylicious";
    if (relay === "azure") {
      const key = process.env.AZURE_FLUID_KEY;
      if (!key) {
        throw new Error(
          "Azure Fluid Relay requires AZURE_FLUID_KEY, AZURE_FLUID_TENANT_ID, and AZURE_FLUID_ENDPOINT",
        );
      }
      const config = azureRelayFromEnv(
        staticKeyTokenProvider(key, { id: actorId ?? "collabnode", name: actorId ?? "collabnode" }),
      );
      return {
        backend: new AzureFluidCollabBackend(config),
        // The key stays here; what goes to the browser is where to ask for a
        // token. `@collabnode/web` connect() turns this into a token provider
        // on its own, so a browser peer needs no wiring of its own.
        join: {
          kind: "fluid",
          relay: "azure",
          tenantId: config.tenantId,
          endpoint: config.endpoint,
          ...(collab.tokenEndpoint ? { tokenEndpoint: collab.tokenEndpoint } : {}),
        },
        close: noopClose,
      };
    }
    const port = collab.port ?? 7070;
    const domain = collab.domain ?? "http://localhost";
    const child = await ensureTinylicious(port, { storageDir: collab.storageDir });
    let closed = false;
    return {
      backend: new FluidCollabBackend({ domain, port }),
      child,
      join: { kind: "fluid", relay: "tinylicious", domain, port },
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        releaseTinylicious(port);
      },
    };
  }
  const _never: never = collab;
  throw new Error(`unknown collab kind ${JSON.stringify(_never)}`);
}

/**
 * Resolve the embedding provider, if any. Nothing is loaded here — the provider
 * fetches its model on first use — so a graph whose schema has no `vector:`
 * fields never touches it.
 */
export function openEmbeddings(embeddings: EmbeddingsKind): EmbeddingProvider | undefined {
  if (embeddings === false) {
    return undefined;
  }
  if (embeddings.kind === "custom") {
    return embeddings.provider;
  }
  return localEmbeddings({ model: embeddings.model, dimensions: embeddings.dimensions });
}

export function openGraph(
  graph: GraphKind,
  embeddings?: EmbeddingProvider,
): GraphStore | undefined {
  if (graph.kind === "none") {
    return undefined;
  }
  if (graph.kind === "custom") {
    return graph.store;
  }
  if (graph.kind === "ladybug") {
    return new LadybugGraphStore({ path: graph.path, embeddings });
  }
  if (graph.kind === "age") {
    return new AgeGraphStore({
      url: graph.url,
      host: graph.host,
      port: graph.port,
      user: graph.user,
      password: graph.password,
      database: graph.database,
      graphName: graph.graphName,
      ssl: graph.ssl,
      reset: graph.reset,
    });
  }
  if (graph.kind === "memory") {
    return new InMemoryGraphStore({ embeddings });
  }
  const _never: never = graph;
  throw new Error(`unknown graph kind ${JSON.stringify(_never)}`);
}

export function graphKindLabel(graph: GraphKind): string {
  return graph.kind === "custom" ? "custom" : graph.kind;
}
