import { InMemoryCollabBackend, type CollabBackend } from "@collabnode/collab";
import {
  InMemoryGraphStore,
  type EmbeddingProvider,
  type GraphSnapshot,
  type GraphStore,
} from "@collabnode/graph";
import { CollabSession, type GraphOpInput } from "@collabnode/runtime";
import {
  generateId,
  validateParams,
  validateWorkspaceType,
  type WorkspaceType,
} from "@collabnode/schema";
import { memoryRegistry } from "./registry.js";
import { Reaper, sweepWorkspaces } from "./reaper.js";
import type {
  HubOptions,
  OpenWorkspaceOptions,
  ReopenOptions,
  WorkspaceArtifact,
  WorkspaceRecord,
  WorkspaceRegistry,
  WorkspaceState,
} from "./types.js";
import { Workspace } from "./workspace.js";

export class Hub {
  readonly registry: WorkspaceRegistry;
  readonly options: HubOptions;
  private readonly collab: CollabBackend;
  private readonly graphStore?: GraphStore;
  private readonly embeddings?: EmbeddingProvider;
  private readonly typesMap = new Map<string, WorkspaceType>();
  private readonly liveWorkspaces = new Map<string, Workspace>();
  private readonly reaper: Reaper;
  private closed = false;

  constructor(options: HubOptions = {}) {
    this.options = options;
    this.registry = options.registry ?? memoryRegistry();
    this.graphStore = options.graph;
    this.embeddings = options.embeddings;

    if (!options.collab) {
      this.collab = new InMemoryCollabBackend();
    } else if (typeof (options.collab as CollabBackend).open === "function") {
      this.collab = options.collab as CollabBackend;
    } else {
      this.collab = new InMemoryCollabBackend();
    }

    const interval = options.sweepIntervalMs ?? 10_000;
    this.reaper = new Reaper(this, interval);
    this.reaper.start();
  }

  define(type: WorkspaceType): void {
    validateWorkspaceType(type);
    this.typesMap.set(type.name, type);
  }

  getType(name: string): WorkspaceType | undefined {
    return this.typesMap.get(name);
  }

  types(): WorkspaceType[] {
    return Array.from(this.typesMap.values());
  }

  getLiveWorkspace(id: string): Workspace | undefined {
    return this.liveWorkspaces.get(id);
  }

  removeLiveWorkspace(id: string): void {
    this.liveWorkspaces.delete(id);
  }

  /**
   * Opens or joins a collaborative workspace instance.
   * Concurrent calls for the same id coordinate via registry leasing so that
   * template seeding runs exactly once.
   */
  async open(
    typeName: string,
    options: OpenWorkspaceOptions = {},
  ): Promise<Workspace> {
    this.assertOpen();
    const type = this.getType(typeName);
    if (!type) {
      throw new Error(`WorkspaceType '${typeName}' is not registered with this hub`);
    }

    const id = options.id ?? `${typeName}-${generateId("uuid")}`;
    const params = validateParams(type.params, options.params ?? {});

    // Check if already open locally in this process
    const cached = this.liveWorkspaces.get(id);
    if (cached && cached.state === "active") {
      return cached;
    }

    // Coordinate with registry for create-or-join mutual exclusion
    const existing = await this.registry.get(id);

    if (existing && existing.state === "active") {
      return this.joinActiveWorkspace(id, type, params, options);
    }

    if (existing && existing.state === "seeding") {
      await this.awaitActiveState(id);
      return this.joinActiveWorkspace(id, type, params, options);
    }

    // Try to claim lease to seed the workspace
    const lease = await this.registry.claim(id, 15_000);

    if (!lease) {
      // Another process or fiber is seeding; await and join
      await this.awaitActiveState(id);
      return this.joinActiveWorkspace(id, type, params, options);
    }

    // Winner of the race: mark seeding and instantiate
    const openedAt = new Date().toISOString();
    const initialRecord: WorkspaceRecord = {
      id,
      ...(options.label ? { label: options.label } : {}),
      typeName: type.name,
      version: type.version,
      params,
      state: "seeding",
      openedAt,
      lastActivityAt: openedAt,
      lastWriteAt: openedAt,
    };
    await this.registry.put(initialRecord);

    try {
      const session = await this.openSession(id, type, options);
      const ws = new Workspace({
        id,
        type,
        params,
        ...(options.label ? { label: options.label } : {}),
        openedAt,
        session,
        hub: this,
        options,
        mcpMount: this.options.mcp?.mount,
      });

      // Seed from artifact or template
      if (options.from) {
        const ops = snapshotToGraphOpInputs(options.from.snapshot);
        await ws.applyOps(ops);
      } else if (type.template) {
        await ws.session.seedTemplate(type, params);
      }

      ws.markActive();
      this.liveWorkspaces.set(id, ws);

      // Update registry to active
      await this.registry.put({
        ...initialRecord,
        collabDocId: session.id,
        state: "active",
        lastActivityAt: new Date().toISOString(),
        lastWriteAt: new Date().toISOString(),
      });

      return ws;
    } catch (err) {
      await this.registry.put({
        ...initialRecord,
        state: "failed",
      });

      throw err;
    } finally {
      await this.registry.release(lease);
    }
  }

  /**
   * Mounts a terminated WorkspaceArtifact for review and inspection: a
   * throwaway in-memory document seeded from the artifact's snapshot, with no
   * live document and no registry record of its own.
   *
   * It is **read-only** and detached. It reports the artifact's id so a UI can
   * say what it is showing, but the hub state under that id belongs to whatever
   * is live there now — which may be a new workspace that reused the id. Writes
   * are refused rather than dropped into a copy nobody will read, and `close()`
   * touches neither the registry nor the live map. To carry an artifact
   * forward, open a new workspace with `from: artifact`.
   */
  async reopen(
    artifact: WorkspaceArtifact,
    options: ReopenOptions = {},
  ): Promise<Workspace> {
    this.assertOpen();
    const resolvedType: WorkspaceType = this.getType(artifact.type) ?? {
      name: artifact.type,
      version: artifact.version,
      schema: {
        name: artifact.type,
        version: artifact.version,
        schemaHash: artifact.snapshot.schemaHash,
        nodes: {},
        edges: {},
        config: {
          schemaId: artifact.snapshot.schemaId,
          idStrategy: "uuid",
          changeTracking: { enabled: false, mode: "last-write" },
        },
      },
    };


    const reviewId = `review-${artifact.id}-${generateId("uuid")}`;
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(reviewId, {
      schema: resolvedType.schema,
      collab,
      actorId: options.actorId ?? "reviewer",
    });

    const ops = snapshotToGraphOpInputs(artifact.snapshot);
    await session.applyOps(ops);

    const ws = new Workspace({
      id: artifact.id,
      type: resolvedType,
      params: artifact.params,
      openedAt: artifact.openedAt,
      session,
      hub: this,
      options: { actorId: options.actorId },
      mcpMount: this.options.mcp?.mount,
      review: true,
    });
    ws.markActive();
    return ws;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    const live = this.liveWorkspaces.get(id);
    if (live) {
      return live.toRecord();
    }
    return this.registry.get(id);
  }

  async list(filter?: {
    state?: WorkspaceState;
    typeName?: string;
  }): Promise<WorkspaceRecord[]> {
    return this.registry.list(filter);
  }

  async sweep(now = Date.now()): Promise<WorkspaceArtifact[]> {
    return sweepWorkspaces(this, now);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reaper.stop();

    // Close open workspaces
    for (const ws of this.liveWorkspaces.values()) {
      try {
        await ws.close();
      } catch {
        // ignore on shutdown
      }
    }
    this.liveWorkspaces.clear();
  }

  private async joinActiveWorkspace(
    id: string,
    type: WorkspaceType,
    params: Record<string, unknown>,
    options: OpenWorkspaceOptions,
  ): Promise<Workspace> {
    const record = await this.registry.get(id);
    // Joining with a label renames; joining without one leaves the name the
    // workspace already has, so a replica that never saw the name cannot erase
    // it by opening the workspace.
    if (record && options.label && options.label !== record.label) {
      await this.registry.put({ ...record, label: options.label });
    }
    const session = await this.openSession(id, type, options, record?.collabDocId);
    const label = options.label ?? record?.label;
    const ws = new Workspace({
      id,
      type,
      params,
      ...(label ? { label } : {}),
      openedAt: record?.openedAt ?? new Date().toISOString(),
      session,
      hub: this,
      options,
      mcpMount: this.options.mcp?.mount,
    });
    ws.markActive();
    this.liveWorkspaces.set(id, ws);
    return ws;
  }

  private async openSession(
    id: string,
    type: WorkspaceType,
    options: OpenWorkspaceOptions,
    collabDocId?: string,
  ): Promise<CollabSession> {
    const projection = type.projection ?? "none";
    let store: GraphStore | undefined;
    let ownsStore = false;

    if (projection === "memory") {
      store = new InMemoryGraphStore({ embeddings: this.embeddings });
      ownsStore = true;
    } else if (projection === "shared") {
      if (!this.graphStore) {
        throw new Error(
          `WorkspaceType '${type.name}' declares projection: shared, but this hub was created ` +
            "without a `graph` store. Pass one to createHub(), or set projection to 'memory' or 'none'.",
        );
      }
      store = this.graphStore;
      ownsStore = false;
    }

    const actorId =
      options.actorId ??
      (type.schema.config.changeTracking.enabled ? "system" : undefined);

    const docId = this.collab.capabilities.namedDocuments
      ? id
      : collabDocId;

    return CollabSession.open(docId, {
      schema: type.schema,
      collab: this.collab,
      graph: store,
      ownsStore,
      actorId,
      peerKind: options.peerKind,
    });
  }


  private async awaitActiveState(id: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const record = await this.registry.get(id);
      if (record && record.state === "active") {
        return;
      }
      if (record && (record.state === "failed" || record.state === "ended")) {
        throw new Error(`Workspace '${id}' reached state '${record.state}' during initialization`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for workspace '${id}' to finish seeding`);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Hub is closed");
    }
  }
}

export function snapshotToGraphOpInputs(snapshot: GraphSnapshot): GraphOpInput[] {
  const ops: GraphOpInput[] = [];
  for (const node of snapshot.nodes) {
    ops.push({
      op: "upsertNode",
      id: node.id,
      type: node.type,
      properties: node.properties,
      tags: node.tags && node.tags.length > 0 ? [...node.tags] : undefined,

    });
  }
  for (const edge of snapshot.edges) {
    ops.push({
      op: "upsertEdge",
      id: edge.id,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      properties: edge.properties,
    });
  }
  return ops;
}

export async function createHub(options: HubOptions = {}): Promise<Hub> {
  return new Hub(options);
}
