import type { CollaborativeGraph } from "@collabnode/collab";
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

/** Debounce CRDT-only sink writes so the graph store is not updated per keystroke. */
export const CRDT_PROJECT_DEBOUNCE_MS = 250;

export class Projector {
  private previous: GraphSnapshot | undefined;
  private pending: GraphSnapshot | undefined;
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
    this.unsubscribe = this.graph.subscribe((next) => {
      this.applying = this.applying.then(() => this.handle(next));
    });
    return snapshot;
  }

  private async handle(next: GraphSnapshot): Promise<void> {
    if (!this.wanted()) {
      // Nothing consumes the diff, so do not compute one. This is the whole of
      // what `projection: none` saves on a write-heavy workspace: diffing is
      // linear in graph size and ran on every change.
      this.previous = next;
      return;
    }
    const baseline = this.previous ?? { ...next, nodes: [], edges: [] };
    const ops = diffSnapshots(baseline, next);
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
    const baseline = this.previous ?? { ...next, nodes: [], edges: [] };
    const ops = diffSnapshots(baseline, next);
    if (ops.length === 0) {
      return;
    }
    await this.commit(ops, next);
  }

  private async commit(ops: GraphOp[], snapshot: GraphSnapshot): Promise<void> {
    this.previous = snapshot;
    await this.store?.applyBatch(this.scope, ops);
    for (const listener of this.listeners) {
      listener(ops, snapshot);
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
