import {
  assertSchemaMatch,
  type CollabBackend,
  type CollabBackendCapabilities,
  type CollabHandle,
  type OpenOptions,
} from "@collabnode/collab";
import type { GraphSchema } from "@collabnode/schema";
import { HocuspocusCollaborativeGraph } from "./graph.js";
import { HocuspocusPresence } from "./presence.js";
import { destroyProvider, openProvider, waitUntilFlushed, waitUntilSynced } from "./provider.js";
import { hocuspocusUrl } from "./url.js";
import { initializeIfNeeded, rootMap, snapshotOf } from "./ydoc.js";

export interface HocuspocusCollabBackendOptions {
  /** WebSocket URL of a Hocuspocus server. Defaults to ws://127.0.0.1:1234. */
  url?: string;
}

export class HocuspocusCollabBackend implements CollabBackend {
  readonly kind = "hocuspocus";
  readonly capabilities: CollabBackendCapabilities = {
    namedDocuments: true,
    deletion: true,
    presence: true,
    versioning: false,
  };
  private readonly url: string;

  constructor(options: HocuspocusCollabBackendOptions = {}) {
    this.url = options.url ?? hocuspocusUrl();
  }

  async open(
    id: string | undefined,
    schema: GraphSchema,
    options: OpenOptions = {},
  ): Promise<CollabHandle> {
    return this.connect(id ?? crypto.randomUUID(), schema, options);
  }

  /**
   * Empty the document and flush, so the server's persistence extension stores
   * an empty state and the next reader of this id finds nothing.
   *
   * This is what a client can do. It is enough for the privacy question — the
   * content is gone from the durable copy — but the document *name* survives as
   * an empty record. Reclaiming the row itself is a server-side operation;
   * `deleteHocuspocusDocument` in `@collabnode/hocuspocus/node` does that for a
   * server this process owns.
   */
  async delete(id: string): Promise<void> {
    const { provider, document } = openProvider({ url: this.url, name: id });
    try {
      await waitUntilSynced(provider);
      document.transact(() => {
        rootMap(document).clear();
      });
      await waitUntilFlushed(provider);
    } finally {
      await destroyProvider(provider);
      document.destroy();
    }
  }

  /**
   * Whether this id names an initialized collabnode document.
   *
   * Hocuspocus creates a document on connect, so asking the question leaves an
   * empty document behind on the server for an id that had none. That is why
   * the ephemeral path uses `open` — which is idempotent — rather than checking
   * first and then opening.
   */
  async exists(id: string): Promise<boolean> {
    const { provider, document } = openProvider({ url: this.url, name: id });
    try {
      await waitUntilSynced(provider);
      return rootMap(document).has("schemaId");
    } finally {
      await destroyProvider(provider);
      document.destroy();
    }
  }

  private async connect(
    id: string,
    schema: GraphSchema,
    options: OpenOptions,
  ): Promise<CollabHandle> {
    const { provider, document } = openProvider({ url: this.url, name: id });
    try {
      await waitUntilSynced(provider);
      initializeIfNeeded(document, schema);
      await waitUntilFlushed(provider);
      assertSchemaMatch(schema, snapshotOf(document));
    } catch (error) {
      await destroyProvider(provider);
      document.destroy();
      throw error;
    }
    const presence = new HocuspocusPresence(provider, {
      actorId: options.actorId ?? `peer-${provider.awareness?.clientID ?? crypto.randomUUID()}`,
      kind: options.peerKind ?? "human",
    });
    return {
      id,
      graph: new HocuspocusCollaborativeGraph(document, schema),
      presence: () => presence,
      close: async () => {
        await destroyProvider(provider);
        document.destroy();
      },
    };
  }
}
