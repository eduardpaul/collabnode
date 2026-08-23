import type {
  CollabArray,
  CollabMap,
  CollabText,
  Presence,
} from "@collabnode/collab";
import type {
  GraphNodeRecord,
  GraphSearchHit,
  GraphSearchRequest,
  GraphSnapshot,
  GraphVectorRequest,
  PropertyMap,
  QueryResult,
} from "@collabnode/graph";
import {
  CollabSession,
  type ApplyOpsResult,
  type GraphOpInput,
  type MutationOptions,
  type UpsertEdgeInput,
  type UpsertNodeInput,
} from "@collabnode/runtime";
import { evaluateExpression, type WorkspaceType } from "@collabnode/schema";


import type { Hub } from "./hub.js";
import type {
  EndReason,
  OpenWorkspaceOptions,
  Participant,
  WorkspaceArtifact,
  WorkspaceRecord,
  WorkspaceState,
} from "./types.js";

export class Workspace {
  readonly id: string;
  readonly type: WorkspaceType;
  readonly params: Record<string, unknown>;
  /** What a person called this workspace, when a person named it. */
  readonly label: string | undefined;
  readonly openedAt: string;
  readonly mcpUrl: string;
  readonly session: CollabSession;
  readonly hub: Hub;
  readonly options: OpenWorkspaceOptions;

  /**
   * A review mount of a finished artifact: its document is a throwaway
   * in-memory copy, and it borrows the artifact's id so it can say what it is
   * showing. It must therefore touch none of the hub state keyed by that id —
   * a live workspace may be running under the same id right now.
   */
  private readonly review: boolean;
  private _state: WorkspaceState = "seeding";
  private _lastWriteAt: string;
  private _lastActivityAt: string;
  private readonly participantsMap = new Map<string, Participant>();
  private terminationPromise?: Promise<WorkspaceArtifact>;
  private endedArtifact?: WorkspaceArtifact;

  constructor(args: {
    id: string;
    type: WorkspaceType;
    params: Record<string, unknown>;
    openedAt: string;
    /** Display name from the registry record, or from this open's options. */
    label?: string;
    session: CollabSession;
    hub: Hub;
    options: OpenWorkspaceOptions;
    mcpMount?: string;
    /** Mount an ended artifact for reading only; see `review`. */
    review?: boolean;
  }) {
    this.id = args.id;
    this.type = args.type;
    this.params = args.params;
    this.label = args.label ?? args.options.label;
    this.openedAt = args.openedAt;
    this._lastWriteAt = args.openedAt;
    this._lastActivityAt = args.openedAt;
    this.session = args.session;
    this.hub = args.hub;
    this.options = args.options;
    this.review = args.review ?? false;

    const mount = args.mcpMount ?? "/mcp";
    this.mcpUrl = `${mount.replace(/\/+$/, "")}/w/${this.id}`;

    // Track initial actor
    if (args.options.actorId) {
      this.recordParticipantJoin(args.options.actorId, args.options.peerKind ?? "human");
    }

    // Subscribe to presence events if supported by the collab backend
    if (this.session.capabilities.presence) {
      try {
        const presence = this.session.presence();
        presence.on("join", (peer) => {
          this.recordParticipantJoin(peer.actorId, peer.kind ?? "human");
          this.touchActivity();
        });
        presence.on("leave", (peer) => {
          this.recordParticipantLeave(peer.actorId);
          this.touchActivity();
        });
      } catch {
        // Backend does not support presence
      }
    }


    // Subscribe to graph changes for predicate evaluation & activity tracking.
    // A review has no lifecycle to run: its workspace already ended.
    if (!this.review) {
      this.session.onChange(() => {
        this.touchWrite();
        void this.evaluateEndWhen();
      });
    }
  }

  get state(): WorkspaceState {
    return this._state;
  }

  get lastWriteAt(): string {
    return this._lastWriteAt;
  }

  get lastActivityAt(): string {
    return this._lastActivityAt;
  }

  markActive(): void {
    if (this._state === "seeding") {
      this._state = "active";
    }
  }

  markFailed(): void {
    this._state = "failed";
  }

  touchWrite(): void {
    const now = new Date().toISOString();
    this._lastWriteAt = now;
    this._lastActivityAt = now;
  }

  touchActivity(): void {
    this._lastActivityAt = new Date().toISOString();
  }

  snapshot(): GraphSnapshot {
    return this.session.snapshot();
  }

  peers() {
    return this.session.peers();
  }

  presence(): Presence {
    return this.session.presence();
  }

  async applyOps(
    inputs: GraphOpInput[],
    options?: MutationOptions,
  ): Promise<ApplyOpsResult> {
    this.assertWritable();
    const result = await this.session.applyOps(inputs, options);
    this.touchWrite();
    await this.evaluateEndWhen();
    return result;
  }

  async upsertNode(
    input: UpsertNodeInput,
    options?: MutationOptions,
  ): Promise<string> {
    this.assertWritable();
    const id = await this.session.upsertNode(input, options);
    this.touchWrite();
    await this.evaluateEndWhen();
    return id;
  }

  async upsertEdge(
    input: UpsertEdgeInput,
    options?: MutationOptions,
  ): Promise<string> {
    this.assertWritable();
    const id = await this.session.upsertEdge(input, options);
    this.touchWrite();
    await this.evaluateEndWhen();
    return id;
  }

  async deleteNode(id: string, options?: MutationOptions): Promise<void> {
    this.assertWritable();
    await this.session.deleteNode(id, options);
    this.touchWrite();
    await this.evaluateEndWhen();
  }

  async deleteEdge(id: string, options?: MutationOptions): Promise<void> {
    this.assertWritable();
    await this.session.deleteEdge(id, options);
    this.touchWrite();
    await this.evaluateEndWhen();
  }

  async query(cypher: string, params?: PropertyMap): Promise<QueryResult> {
    return this.session.query(cypher, params);
  }

  async search(request: GraphSearchRequest): Promise<GraphSearchHit[] | undefined> {
    return this.session.search(request);
  }

  async searchVector(request: GraphVectorRequest): Promise<GraphSearchHit[] | undefined> {
    return this.session.searchVector(request);
  }

  collabText(nodeId: string, property: string): CollabText {
    return this.session.collabText(nodeId, property);
  }

  collabMap(nodeId: string, property: string): CollabMap {
    return this.session.collabMap(nodeId, property);
  }

  collabArray(nodeId: string, property: string): CollabArray {
    return this.session.collabArray(nodeId, property);
  }

  /**
   * Evaluates the lifecycle `endWhen` predicate query against the workspace's projected graph.
   * If the predicate is met, initiates workspace termination with reason "predicate".
   */
  async evaluateEndWhen(): Promise<boolean> {
    if (this._state !== "active") {
      return false;
    }
    const endWhen = this.type.lifecycle?.endWhen;
    if (!endWhen) {
      return false;
    }

    try {
      if (this.session.projected) {
        try {
          const result = await this.session.query(endWhen);
          if (result.rows.length > 0) {
            const firstRow = result.rows[0];
            if (firstRow) {
              const matched = Object.values(firstRow).some((v) => v === true || v === 1);
              if (matched) {
                void this.end("predicate");
                return true;
              }
            }
          }
        } catch {
          // Fall through to snapshot evaluation if backend query runner is minimal
        }
      }

      // Evaluate predicate over current snapshot
      const matched = evaluatePredicateOverSnapshot(endWhen, this.snapshot());
      if (matched) {
        void this.end("predicate");
        return true;
      }
    } catch {
      // Cypher query errors (e.g. mid-transaction or syntax) do not fail the workspace
    }
    return false;
  }


  /**
   * Terminates this workspace following the §6.5 termination ordering:
   * 1. Drain projector
   * 2. Capture final snapshot
   * 3. Capture history (if enabled)
   * 4. Build durable WorkspaceArtifact
   * 5. Await consumer onEnd hooks
   * 6. Apply retention policy (delete / keep / archive)
   * 7. Update registry record and release lease
   */
  async end(reason: EndReason = "explicit"): Promise<WorkspaceArtifact> {
    if (this.review) {
      throw new Error(
        `Workspace ${this.id} is a read-only review and has nothing to end; ` +
          "its artifact already exists. Use close() to drop the review.",
      );
    }
    if (this.endedArtifact) {
      return this.endedArtifact;
    }
    if (this.terminationPromise) {
      return this.terminationPromise;
    }

    this.terminationPromise = this.performEnd(reason);
    return this.terminationPromise;
  }

  private async performEnd(reason: EndReason): Promise<WorkspaceArtifact> {
    this._state = "ending";

    try {
      // Step 1: Drain projector
      await this.session.drain();


      // Step 2: Capture snapshot
      const snapshot = this.session.snapshot();

      // Step 3: Capture history
      const history = this.session.history();

      // Step 4: Build artifact
      const artifact: WorkspaceArtifact = {
        id: this.id,
        type: this.type.name,
        version: this.type.version,
        params: this.params,
        openedAt: this.openedAt,
        endedAt: new Date().toISOString(),
        endedBy: reason,
        participants: this.getParticipants(),
        snapshot,
        history: history.length > 0 ? history : undefined,
      };

      // Step 5: Await consumer onEnd hooks
      if (this.options.onEnd) {
        await this.options.onEnd(artifact);
      }
      if (this.hub.options.onEnd) {
        await this.hub.options.onEnd(artifact);
      }

      // Step 6: Apply retention policy
      const retentionMode = this.type.retention?.onEnd ?? "delete";
      if (retentionMode === "delete") {
        await this.session.destroy();
      } else {
        await this.session.close();
      }

      // Step 7: Update registry record
      const record: WorkspaceRecord = {
        id: this.id,
        typeName: this.type.name,
        version: this.type.version,
        params: this.params,
        state: "ended",
        openedAt: this.openedAt,
        lastActivityAt: this._lastActivityAt,
        lastWriteAt: this._lastWriteAt,
        endedAt: artifact.endedAt,
        endedBy: reason,
      };
      await this.hub.registry.put(record);

      this._state = "ended";
      this.endedArtifact = artifact;
      this.hub.removeLiveWorkspace(this.id);
      return artifact;
    } catch (err) {
      this._state = "failed";
      throw err;
    }
  }

  /**
   * Disconnects this client from the workspace session without terminating the workspace.
   */
  async close(): Promise<void> {
    await this.session.close();
    if (this.review) {
      // Nothing of this mount is registered under `id`, and whatever is may
      // still be live.
      return;
    }
    this.touchActivity();
    const existing = await this.hub.registry.get(this.id);
    if (existing && existing.state === "active") {
      await this.hub.registry.put({
        ...existing,
        lastActivityAt: this._lastActivityAt,
        lastWriteAt: this._lastWriteAt,
      });
    }
    this.hub.removeLiveWorkspace(this.id);
  }


  /**
   * This workspace as a registry record.
   *
   * `hub.get()` answers from here for anything live, so what it leaves out is
   * what a caller silently loses whenever the workspace happens to be open in
   * this process — which is why `label` and `collabDocId` are on it. Reading a
   * board's name, or the document a token has to be scoped to, must not depend
   * on which replica is asked.
   */
  toRecord(): WorkspaceRecord {
    return {
      id: this.id,
      ...(this.label ? { label: this.label } : {}),
      typeName: this.type.name,
      version: this.type.version,
      params: this.params,
      state: this._state,
      openedAt: this.openedAt,
      lastActivityAt: this._lastActivityAt,
      lastWriteAt: this._lastWriteAt,
      collabDocId: this.session.id,
      endedAt: this.endedArtifact?.endedAt,
      endedBy: this.endedArtifact?.endedBy,
    };
  }

  private recordParticipantJoin(actorId: string, kind: "human" | "agent"): void {
    const existing = this.participantsMap.get(actorId);
    if (existing) {
      delete existing.leftAt;
    } else {
      this.participantsMap.set(actorId, {
        actorId,
        kind,
        joinedAt: new Date().toISOString(),
      });
    }
  }

  private recordParticipantLeave(actorId: string): void {
    const existing = this.participantsMap.get(actorId);
    if (existing) {
      existing.leftAt = new Date().toISOString();
    }
  }

  private getParticipants(): Participant[] {
    return Array.from(this.participantsMap.values());
  }

  private assertWritable(): void {
    if (this.review) {
      throw new Error(
        `Workspace ${this.id} is a read-only review of a finished artifact. ` +
          "Open a new workspace with `from: artifact` to continue from it.",
      );
    }
    if (this._state === "ended" || this._state === "ending") {
      throw new Error(`Workspace ${this.id} is ${this._state} and cannot be modified`);
    }
  }
}

function evaluatePredicateOverSnapshot(
  cypherOrExpr: string,
  snapshot: GraphSnapshot,
): boolean {
  const trimmed = cypherOrExpr.trim();
  const match = trimmed.match(
    /^MATCH\s+\((\w+):(\w+)\)(?:\s+WHERE\s+(.+?))?\s+RETURN\s+(.+)$/i,
  );
  if (match) {
    const alias = match[1]!;
    const type = match[2]!;
    const whereClause = match[3];
    const returnClause = match[4]!;

    let matchingNodes = snapshot.nodes.filter((n) => n.type === type);

    if (whereClause) {
      const normalizedWhere = whereClause.replace(/(?<![!=><])=(?!=)/g, "==");
      matchingNodes = matchingNodes.filter((n) => {
        try {
          return Boolean(
            evaluateExpression(normalizedWhere, {
              [alias]: n.properties,
              ...n.properties,
            }),
          );
        } catch {
          return false;
        }
      });
    }

    const countPattern = new RegExp(`count\\s*\\(\\s*${alias}\\s*\\)`, "gi");
    const countReplaced = returnClause.replace(
      countPattern,
      String(matchingNodes.length),
    );
    const normalizedReturn = countReplaced.replace(/(?<![!=><])=(?!=)/g, "==");

    try {
      return Boolean(evaluateExpression(normalizedReturn, {}));
    } catch {
      return false;
    }
  }

  try {
    const normalized = trimmed.replace(/(?<![!=><])=(?!=)/g, "==");
    return Boolean(evaluateExpression(normalized, { snapshot }));
  } catch {
    return false;
  }
}

