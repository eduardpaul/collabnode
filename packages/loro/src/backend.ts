import {
  assertSchemaMatch,
  type CollabBackend,
  type CollabBackendCapabilities,
  type CollabHandle,
  type DocExportMode,
  type OpenOptions,
  type Peer,
} from "@collabnode/collab";
import type { GraphSchema } from "@collabnode/schema";
import { LoroDoc } from "loro-crdt";
import { initializeIfNeeded, rootMap, snapshotOf } from "./doc.js";
import { LoroCollaborativeGraph } from "./graph.js";
import { LoroPresence, emitPresence, emptyRoom, type LoroRoom } from "./presence.js";
import { LORO_KIND } from "./version.js";

/**
 * Where documents live between processes.
 *
 * Loro has no I/O of its own, so persistence is a hook rather than a
 * dependency. Anything with get/put semantics works: a directory, S3, a Redis
 * blob, the same table the workspace registry already uses.
 */
export interface LoroDocStore {
  load(id: string): Promise<Uint8Array | undefined>;
  save(id: string, bytes: Uint8Array): Promise<void>;
  delete(id: string): Promise<void>;
  exists?(id: string): Promise<boolean>;
}

export interface LoroCollabBackendOptions {
  /** Durable home for documents. Without one this backend is process-local. */
  store?: LoroDocStore;
  /**
   * How a document is written back to the store. `shallow` keeps the artifact
   * small at the cost of being unable to fork versions older than the save;
   * `snapshot`, the default, keeps the whole DAG.
   */
  persistAs?: DocExportMode;
  /**
   * Debounce for writes to the store, in ms. Default 250. `0` saves on every
   * commit, which is right for a test and wrong for a keystroke.
   */
  persistDebounceMs?: number;
}

interface LiveDoc {
  doc: LoroDoc;
  room: LoroRoom;
  connections: number;
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
  saving: Promise<void>;
}

const DEFAULT_PERSIST_DEBOUNCE_MS = 250;

/**
 * Loro collab backend: the one that can answer version questions.
 *
 * Scope, stated plainly, because it is the difference that matters when
 * choosing between this and the Yjs/Fluid backends: this is an **in-process**
 * backend with optional persistence. Two handles opened on the same id in this
 * process share a document; two *processes* do not, because Loro ships no
 * transport and none is invented here. `LoroCollaborativeGraph` exposes
 * `exportUpdate`/`importUpdate`/`onLocalUpdate` so a relay can be built on it,
 * and until one exists this backend is for single-host hubs, agent runtimes,
 * and everything that wants `history()`, `diffSince()`, and real artifacts
 * without a second server.
 */
export class LoroCollabBackend implements CollabBackend {
  readonly kind = LORO_KIND;
  readonly capabilities: CollabBackendCapabilities = {
    namedDocuments: true,
    deletion: true,
    // Honest for an in-process backend: this process sees every peer of this
    // document, because every peer of this document is in it.
    presence: true,
    versioning: true,
  };

  private readonly docs = new Map<string, LiveDoc>();
  private readonly store?: LoroDocStore;
  private readonly persistAs: DocExportMode;
  private readonly persistDebounceMs: number;

  constructor(options: LoroCollabBackendOptions = {}) {
    this.store = options.store;
    this.persistAs = options.persistAs ?? "snapshot";
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  }

  async open(
    id: string | undefined,
    schema: GraphSchema,
    options: OpenOptions = {},
  ): Promise<CollabHandle> {
    const name = id ?? crypto.randomUUID();
    let live = this.docs.get(name);
    if (!live) {
      live = await this.load(name);
      this.docs.set(name, live);
    }
    initializeIfNeeded(live.doc, schema);
    assertSchemaMatch(schema, snapshotOf(live.doc));
    return this.connect(name, live, schema, options);
  }

  /**
   * Rebuild a finished document from its bytes, with no live copy and no
   * persistence behind it.
   *
   * The document keeps its history, so the handle this returns can be rewound
   * with `checkout` and forked — which is what separates reviewing an artifact
   * from replaying its snapshot into a fresh document.
   */
  async restore(
    bytes: Uint8Array,
    schema: GraphSchema,
    options: OpenOptions = {},
  ): Promise<CollabHandle> {
    const doc = new LoroDoc();
    doc.import(bytes);
    initializeIfNeeded(doc, schema);
    assertSchemaMatch(schema, snapshotOf(doc));
    const live: LiveDoc = {
      doc,
      room: emptyRoom(),
      connections: 0,
      unsubscribe: () => undefined,
      saving: Promise.resolve(),
    };
    return this.connect(`restored-${crypto.randomUUID()}`, live, schema, options, {
      detached: true,
    });
  }

  async delete(id: string): Promise<void> {
    const live = this.docs.get(id);
    if (live) {
      live.unsubscribe();
      this.clearTimer(live);
      await live.saving;
      // Empty the live copy as well as dropping it, so a handle still holding
      // this document reads an empty one rather than a stale live one.
      const root = rootMap(live.doc);
      root.ensureMergeableMap("nodes").clear();
      root.ensureMergeableMap("edges").clear();
      live.doc.commit();
      this.docs.delete(id);
    }
    await this.store?.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    if (this.docs.has(id)) {
      return true;
    }
    if (!this.store) {
      return false;
    }
    if (this.store.exists) {
      return this.store.exists(id);
    }
    return (await this.store.load(id)) !== undefined;
  }

  /** Flush every pending save. Call before the process exits. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.docs.entries()].map(async ([id, live]) => {
        this.clearTimer(live);
        await this.save(id, live);
      }),
    );
  }

  private async load(id: string): Promise<LiveDoc> {
    const doc = new LoroDoc();
    const bytes = await this.store?.load(id);
    if (bytes) {
      doc.import(bytes);
    }
    const live: LiveDoc = {
      doc,
      room: emptyRoom(),
      connections: 0,
      unsubscribe: () => undefined,
      saving: Promise.resolve(),
    };
    if (this.store) {
      live.unsubscribe = doc.subscribe(() => {
        this.schedulePersist(id, live);
      });
    }
    return live;
  }

  private schedulePersist(id: string, live: LiveDoc): void {
    if (!this.store) {
      return;
    }
    if (this.persistDebounceMs <= 0) {
      live.saving = live.saving.then(() => this.save(id, live));
      return;
    }
    this.clearTimer(live);
    live.timer = setTimeout(() => {
      live.timer = undefined;
      live.saving = live.saving.then(() => this.save(id, live));
    }, this.persistDebounceMs);
  }

  private clearTimer(live: LiveDoc): void {
    if (live.timer !== undefined) {
      clearTimeout(live.timer);
      live.timer = undefined;
    }
  }

  private async save(id: string, live: LiveDoc): Promise<void> {
    if (!this.store || live.doc.isDetached()) {
      return;
    }
    const bytes =
      this.persistAs === "shallow"
        ? live.doc.export({ mode: "shallow-snapshot", frontiers: live.doc.frontiers() })
        : live.doc.export({ mode: "snapshot" });
    await this.store.save(id, bytes);
  }

  private connect(
    id: string,
    live: LiveDoc,
    schema: GraphSchema,
    options: OpenOptions,
    flags: { detached?: boolean } = {},
  ): CollabHandle {
    const connectionId = crypto.randomUUID();
    const peer: Peer = {
      actorId: options.actorId ?? connectionId,
      kind: options.peerKind ?? "human",
      since: new Date().toISOString(),
      state: {},
      self: true,
    };
    live.room.peers.set(connectionId, peer);
    live.connections += 1;
    emitPresence(live.room, "join", peer);
    let closed = false;
    return {
      id,
      graph: new LoroCollaborativeGraph(live.doc, schema),
      presence: () => new LoroPresence(live.room, connectionId),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        live.room.peers.delete(connectionId);
        live.connections -= 1;
        emitPresence(live.room, "leave", peer);
        if (flags.detached) {
          live.unsubscribe();
          return;
        }
        // Last one out writes the document back. A debounced save that never
        // fired because the process closed the handle first is the one way a
        // persisted backend silently loses the final edit.
        if (live.connections <= 0) {
          this.clearTimer(live);
          await this.save(id, live);
        }
      },
    };
  }
}
