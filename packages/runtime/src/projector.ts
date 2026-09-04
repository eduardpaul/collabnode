import { isVersioned, type CollaborativeGraph, type VersionToken } from "@collabnode/collab";
import {
  diffSnapshots,
  snapshotToOps,
  type GraphOp,
  type GraphSnapshot,
  type GraphStore,
  type WorkspaceScope,
} from "@collabnode/graph";
import {
  lwwProperties,
  type AnyGraph,
  type GraphSchema,
  type GraphTypeMap,
} from "@collabnode/schema";

export type ProjectorListener<S extends GraphTypeMap = AnyGraph> = (
  ops: GraphOp[],
  snapshot: GraphSnapshot<S>,
) => void;

/**
 * A snapshot together with the version it was read at.
 *
 * The two travel as a pair on purpose. The version is captured in the same
 * synchronous turn as the snapshot, so a diff computed against it describes
 * exactly the state the snapshot shows — not whatever has landed by the time
 * the debounced projection actually runs.
 */
interface PendingSnapshot {
  snapshot: GraphSnapshot;
  version: VersionToken | undefined;
}

/** Debounce CRDT-only sink writes so the graph store is not updated per keystroke. */
export const CRDT_PROJECT_DEBOUNCE_MS = 250;

export class Projector {
  private previous: GraphSnapshot | undefined;
  /**
   * The version `previous` was read at, on a backend that can name one.
   *
   * Holding it is what lets the diff be asked of the CRDT instead of computed
   * by walking two snapshots: `diffSnapshots` is linear in the size of the
   * graph and stringifies every property of every node on every change, while
   * `diffSince` is linear in what actually changed. On a backend without
   * versions this stays undefined and nothing below it changes.
   */
  private previousVersion: VersionToken | undefined;
  private pending: PendingSnapshot | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<ProjectorListener>();
  private applying = Promise.resolve();

  constructor(
    private readonly schema: GraphSchema,
    private readonly scope: WorkspaceScope,
    private readonly graph: CollaborativeGraph,
    /**
     * Omitted for `projection: none`. The CRDT holds the truth and the store is
     * a query accelerator; a workspace that is only ever read through snapshots
     * should not pay to maintain one. Change listeners still fire without it -
     * they are fed by the diff, not by the store.
     */
    private readonly store: GraphStore | undefined,
    private readonly debounceMs: number = CRDT_PROJECT_DEBOUNCE_MS,
  ) {}

  /** Whether anything downstream would notice this diff being computed. */
  private wanted(): boolean {
    return this.store !== undefined || this.listeners.size > 0;
  }

  on(listener: ProjectorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<GraphSnapshot> {
    await this.store?.applySchema(this.scope, this.schema);
    const snapshot = this.graph.snapshot();
    if (this.store) {
      await this.store.applyBatch(this.scope, snapshotToOps(snapshot));
    }
    this.previous = snapshot;
    this.previousVersion = isVersioned(this.graph) ? this.graph.version() : undefined;
    this.unsubscribe = this.graph.subscribe((next) => {
      const version = isVersioned(this.graph) ? this.graph.version() : undefined;
      this.applying = this.applying.then(() => this.handle({ snapshot: next, version }));
    });
    return snapshot;
  }

  private async handle(next: PendingSnapshot): Promise<void> {
    if (!this.wanted()) {
      // Nothing consumes the diff, so do not compute one. This is the whole of
      // what `projection: none` saves on a write-heavy workspace: diffing is
      // linear in graph size and ran on every change.
      this.previous = next.snapshot;
      this.previousVersion = next.version;
      return;
    }
    const baseline = this.previous ?? { ...next.snapshot, nodes: [], edges: [] };
    const ops = this.opsFor(baseline, next);
    if (ops.length === 0) {
      this.clearTimer();
      this.pending = undefined;
      return;
    }
    if (this.debounceMs > 0 && isCrdtOnlyDiff(this.schema, baseline, ops)) {
      this.pending = next;
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.applying = this.applying.then(() => this.flushPending());
      }, this.debounceMs);
      return;
    }
    this.clearTimer();
    this.pending = undefined;
    await this.commit(ops, next);
  }

  /**
   * Ask the document what changed; walk both snapshots only if it cannot say.
   *
   * The fallback is not a rare path to be tolerated — it is what every
   * unversioned backend takes, and what a versioned one takes after its history
   * has been shallow-trimmed past the last projected version. Both have to
   * produce the same ops, which is why `diffSince` emits them in
   * `diffSnapshots` order.
   */
  private opsFor(baseline: GraphSnapshot, next: PendingSnapshot): GraphOp[] {
    if (this.previousVersion && next.version && isVersioned(this.graph)) {
      const ops = this.graph.diffSince(this.previousVersion, next.version);
      if (ops !== undefined) {
        return ops;
      }
    }
    return diffSnapshots(baseline, next.snapshot);
  }

  /** Discard this workspace's projected copy. Called when the workspace ends. */
  async drop(): Promise<void> {
    await this.store?.dropScope(this.scope);
  }

  private async flushPending(): Promise<void> {
    const next = this.pending;
    this.pending = undefined;
    this.clearTimer();
    if (!next) {
      return;
    }
    const baseline = this.previous ?? { ...next.snapshot, nodes: [], edges: [] };
    const ops = this.opsFor(baseline, next);
    if (ops.length === 0) {
      return;
    }
    await this.commit(ops, next);
  }

  private async commit(ops: GraphOp[], next: PendingSnapshot): Promise<void> {
    this.previous = next.snapshot;
    this.previousVersion = next.version;
    await this.store?.applyBatch(this.scope, ops);
    for (const listener of this.listeners) {
      listener(ops, next.snapshot);
    }
  }

  async drain(): Promise<void> {
    await this.flushPending();
    await this.applying;
    await this.flushPending();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function isCrdtOnlyDiff(schema: GraphSchema, previous: GraphSnapshot, ops: GraphOp[]): boolean {
  if (ops.length === 0) {
    return true;
  }
  const prevNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const op of ops) {
    if (op.kind !== "upsertNode") {
      return false;
    }
    const before = prevNodes.get(op.id);
    if (!before || before.type !== op.type) {
      return false;
    }
    if (stable(before.meta) !== stable(op.meta)) {
      return false;
    }
    if (stable(before.tags ?? []) !== stable(op.tags ?? [])) {
      return false;
    }
    const def = schema.nodes[op.type];
    if (!def) {
      return false;
    }
    for (const key of Object.keys(lwwProperties(def))) {
      if (stable(before.properties[key]) !== stable(op.properties[key])) {
        return false;
      }
    }
  }
  return true;
}
