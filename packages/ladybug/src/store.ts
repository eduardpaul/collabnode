import type {
  EmbeddingProvider,
  GraphOp,
  GraphSearchHit,
  GraphSearchModes,
  GraphSearchRequest,
  GraphStore,
  GraphVectorRequest,
  PropertyMap,
  QueryResult,
  QueryRow,
  WorkspaceScope,
} from "@collabnode/graph";
import { aboveFloor, GraphStoreError, scopeKey, searchTerms, vectorText } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import { opToCypher } from "./cypher.js";
import { schemaToDdl } from "./ddl.js";
import {
  addSearchColumnStatement,
  createIndexStatement,
  dropIndexStatement,
  ftsPlan,
  queryIndexStatement,
  reconcileIndexes,
  searchColumnValues,
  type FtsIndexPlan,
} from "./fts.js";
import {
  addVectorColumnStatement,
  createIndexStatement as createVectorIndexStatement,
  dropColumnStatement,
  dropIndexStatement as dropVectorIndexStatement,
  orphanColumns,
  pendingStatement,
  queryIndexStatement as queryVectorIndexStatement,
  reconcileIndexes as reconcileVectorIndexes,
  setVectorStatement,
  vectorPlan,
  type VectorIndexPlan,
} from "./vector.js";

interface QueryHandle {
  getAll?: () => Promise<unknown[]>;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

interface LadybugConnection {
  query(statement: string): Promise<QueryHandle | unknown[] | undefined>;
}

interface LadybugDatabase {
  close?: () => void | Promise<void>;
}

export interface LadybugGraphStoreOptions {
  path: string;
  /** Injected in tests. When omitted, `@ladybugdb/core` is loaded dynamically. */
  open?: (path: string) => Promise<{ db: LadybugDatabase; conn: LadybugConnection }>;
  /** Without one, nothing is embedded and `searchVector` reports no index. */
  embeddings?: EmbeddingProvider;
  /**
   * How long writes must be quiet before the WAL is folded into the database
   * file. Lower shrinks the window in which a hard kill leaves an unopenable
   * database; higher costs less on write-heavy workloads.
   */
  checkpointDelayMs?: number;
}

const DEFAULT_CHECKPOINT_DELAY_MS = 1_000;

/** Rows re-embedded per round of the backfill. Big enough to be worth a batch, small enough to yield. */
const BACKFILL_BATCH = 64;

async function defaultOpen(
  path: string,
): Promise<{ db: LadybugDatabase; conn: LadybugConnection }> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("@ladybugdb/core")) as Record<string, unknown>;
  } catch {
    try {
      mod = (await import("lbug")) as Record<string, unknown>;
    } catch (error) {
      throw new GraphStoreError(
        `Ladybug is not installed. Add peer dependency @ladybugdb/core (or use { kind: "memory" }). ${String(error)}`,
      );
    }
  }
  const Database = (mod.Database ?? mod.default) as
    | (new (p: string) => LadybugDatabase)
    | undefined;
  const Connection = mod.Connection as (new (db: LadybugDatabase) => LadybugConnection) | undefined;
  if (!Database || !Connection) {
    throw new GraphStoreError("Ladybug module does not export Database and Connection");
  }
  const db = new Database(path);
  const conn = new Connection(db);
  return { db, conn };
}

async function rowsFrom(result: QueryHandle | unknown[] | undefined): Promise<unknown[]> {
  if (!result) {
    return [];
  }
  if (Array.isArray(result)) {
    return result;
  }
  if (typeof result.getAll === "function") {
    return result.getAll();
  }
  if (typeof result[Symbol.asyncIterator] === "function") {
    const rows: unknown[] = [];
    for await (const row of result as AsyncIterable<unknown>) {
      rows.push(row);
    }
    return rows;
  }
  return [];
}

export class LadybugGraphStore implements GraphStore {
  private db: LadybugDatabase | undefined;
  private conn: LadybugConnection | undefined;
  private schema: GraphSchema | undefined;
  private ftsIndexes: FtsIndexPlan[] = [];
  private vectorIndexes: VectorIndexPlan[] = [];
  /** Text each node was last embedded from, so an unrelated edit does not re-embed it. */
  private readonly vectorTexts = new Map<string, string>();
  private backfill: Promise<void> | undefined;
  private embedFailed = false;
  /** Serializes every use of the one connection. See `serialize`. */
  private lock: Promise<void> = Promise.resolve();
  /**
   * The one workspace this store serves.
   *
   * Ladybug is an embedded engine: one database is one file, its tables are
   * typed per node label, and `query` hands caller-written Cypher straight to
   * it - so there is no discriminator column that could keep two workspaces
   * apart from a user query's point of view. Serving many workspaces means one
   * database file each, which is a file lifecycle (create, evict, delete, clean
   * up after a crash) that belongs with the hub's retention policy rather than
   * inside a store. Until then this refuses a second scope out loud instead of
   * mixing two workspaces into one file.
   */
  private scope: string | undefined;
  private walDirty = false;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LadybugGraphStoreOptions) {}

  private async connection(): Promise<LadybugConnection> {
    if (this.conn) {
      return this.conn;
    }
    const open = this.options.open ?? defaultOpen;
    const opened = await open(this.options.path);
    this.db = opened.db;
    this.conn = opened.conn;
    return this.conn;
  }

  /**
   * Run one unit of database work, never overlapping another.
   *
   * Everything here shares a single Ladybug connection, and three things now
   * want it at unpredictable times: foreground reads and writes, the background
   * vector backfill, and the debounced checkpoint below. Serializing them is
   * cheaper than reasoning about whether the native connection tolerates
   * concurrent queries — and, given what it does when it does not like
   * something, safer.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Fold the write-ahead log into the database file.
   *
   * Not an optimization — a correctness fix. Updates to a full-text or vector
   * index sit in the WAL until a checkpoint, and **replaying them on the next
   * open segfaults the process** rather than raising: an app that writes to an
   * indexed table and exits cannot reopen its own database. Checkpointing folds
   * them in, leaving nothing to replay.
   */
  private async checkpoint(): Promise<void> {
    if (!this.walDirty || !this.conn) {
      return;
    }
    this.walDirty = false;
    try {
      await this.conn.query("CHECKPOINT");
    } catch (error) {
      // Leave it dirty so the next write, or close, tries again.
      this.walDirty = true;
      console.warn(`[collabnode] Ladybug checkpoint failed: ${String(error)}`);
    }
  }

  /**
   * Checkpointing costs about the same whether one row or a hundred are
   * pending, so it waits for a burst of writes to settle instead of running per
   * batch. A hard kill inside that window still leaves a database that cannot
   * be reopened; only a graceful close is fully safe.
   */
  private scheduleCheckpoint(): void {
    if (!this.indexed() || !this.walDirty) {
      return;
    }
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(() => {
      void this.serialize(() => this.checkpoint());
    }, this.options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS);
    // Never a reason to hold the process open.
    this.checkpointTimer.unref?.();
  }

  /** Whether any index exists whose WAL entries would break the next open. */
  private indexed(): boolean {
    return this.ftsIndexes.length > 0 || this.vectorIndexes.length > 0;
  }

  async applySchema(scope: WorkspaceScope, schema: GraphSchema): Promise<void> {
    this.claim(scope);
    return this.serialize(() => this.applySchemaLocked(schema));
  }

  /** Bind this store to one workspace, or refuse a second. */
  private claim(scope: WorkspaceScope): void {
    const key = scopeKey(scope);
    if (this.scope === undefined) {
      this.scope = key;
      return;
    }
    if (this.scope !== key) {
      throw new GraphStoreError(
        `this Ladybug store is already serving workspace '${this.scope}' and cannot also serve '${key}'. ` +
          "Open one LadybugGraphStore per workspace, or project to a store that partitions (memory, age).",
      );
    }
  }

  private assertScope(scope: WorkspaceScope): void {
    const key = scopeKey(scope);
    if (this.scope !== key) {
      throw new GraphStoreError(
        this.scope === undefined
          ? `applySchema must be called for workspace '${scope.workspaceId}' before it is used`
          : `this Ladybug store serves workspace '${this.scope}', not '${key}'`,
      );
    }
  }

  /**
   * Empty this workspace's projection. The database file itself stays, since
   * it is the caller's to place and remove; what leaves is every projected row
   * and every vector derived from one.
   */
  async dropScope(scope: WorkspaceScope): Promise<void> {
    if (this.scope !== scopeKey(scope)) {
      return;
    }
    await this.serialize(async () => {
      const conn = await this.connection();
      await conn.query("MATCH (n) DETACH DELETE n");
      this.vectorTexts.clear();
      this.walDirty = true;
    });
    this.scheduleCheckpoint();
  }

  private async applySchemaLocked(schema: GraphSchema): Promise<void> {
    this.schema = schema;
    const conn = await this.connection();
    for (const statement of schemaToDdl(schema)) {
      await conn.query(statement);
    }
    this.ftsIndexes = await this.prepareFts(conn, schema);
    this.vectorIndexes = await this.prepareVectors(conn, schema);
    // Deliberately not awaited. A database written before vectors existed, or
    // one whose model just changed, needs every node re-embedded; that is
    // minutes of work on a large graph and must not hold up a server boot.
    // Search works throughout and simply improves as this lands.
    if (this.vectorIndexes.length > 0) {
      this.backfill = this.runBackfill().catch((error) => {
        console.warn(`[collabnode] Ladybug vector backfill stopped: ${String(error)}`);
      });
    }
  }

  /**
   * Bring the FTS extension and one index per boost tier up, and report which
   * indexes are usable. Ladybug downloads the extension on first `INSTALL`, so
   * an offline machine fails here — that leaves `ftsIndexes` empty, `search`
   * returns undefined, and the caller falls back to its own scan rather than
   * the store failing to open.
   */
  private async prepareFts(
    conn: LadybugConnection,
    schema: GraphSchema,
  ): Promise<FtsIndexPlan[]> {
    const plans = ftsPlan(schema);
    if (plans.length === 0) {
      return [];
    }
    try {
      await conn.query("INSTALL FTS");
      await conn.query("LOAD FTS");
    } catch (error) {
      console.warn(
        `[collabnode] Ladybug full-text search unavailable, falling back to substring matching: ${String(error)}`,
      );
      return [];
    }
    for (const plan of plans) {
      await conn.query(addSearchColumnStatement(plan));
    }
    const shown = await rowsFrom(await conn.query("CALL SHOW_INDEXES() RETURN *"));
    const { create, drop } = reconcileIndexes(plans, shown);
    for (const plan of drop) {
      await conn.query(dropIndexStatement(plan));
    }
    for (const plan of create) {
      await conn.query(createIndexStatement(plan));
    }
    return plans;
  }

  /**
   * Bring the vector extension and one HNSW index per embedded node table up.
   *
   * The `try` around `LOAD VECTOR` is not decoration: calling
   * `QUERY_VECTOR_INDEX` on a connection that never loaded the extension
   * segfaults the process rather than throwing. Returning an empty plan list
   * when the load fails is what guarantees no query is ever issued.
   */
  private async prepareVectors(
    conn: LadybugConnection,
    schema: GraphSchema,
  ): Promise<VectorIndexPlan[]> {
    const provider = this.options.embeddings;
    if (!provider) {
      return [];
    }
    const plans = vectorPlan(schema, provider);
    if (plans.length === 0) {
      return [];
    }
    try {
      await conn.query("INSTALL VECTOR");
      await conn.query("LOAD VECTOR");
    } catch (error) {
      console.warn(
        `[collabnode] Ladybug vector search unavailable, search stays lexical: ${String(error)}`,
      );
      return [];
    }
    for (const plan of plans) {
      await conn.query(addVectorColumnStatement(plan));
      await this.dropOrphanColumns(conn, plan);
    }
    const shown = await rowsFrom(await conn.query("CALL SHOW_INDEXES() RETURN *"));
    const { create, drop } = reconcileVectorIndexes(plans, shown);
    for (const index of drop) {
      await conn.query(dropVectorIndexStatement(index.table, index.name));
    }
    for (const plan of create) {
      await conn.query(createVectorIndexStatement(plan));
    }
    // Loading the model during the first user-facing write would show up as a
    // multi-second pause in whatever triggered it. Not awaited, and a failure
    // here says nothing the first embed will not report.
    void provider.warm?.().catch(() => {});
    return plans;
  }

  /** Vectors from a model this store no longer uses are dead weight on disk. */
  private async dropOrphanColumns(conn: LadybugConnection, plan: VectorIndexPlan): Promise<void> {
    const info = await rowsFrom(await conn.query(`CALL TABLE_INFO('${plan.table}') RETURN *`));
    const columns = info.map((row) => String((row as { name?: unknown }).name ?? ""));
    for (const column of orphanColumns(plan, columns)) {
      await conn.query(dropColumnStatement(plan.table, column));
    }
  }

  async apply(scope: WorkspaceScope, op: GraphOp): Promise<void> {
    await this.applyBatch(scope, [op]);
  }

  /**
   * Fill the companion search columns for a node write. They are derived, so
   * they are computed here rather than asked of the caller — the projector
   * knows nothing about how a particular store indexes text.
   */
  private withSearchColumns(op: GraphOp): GraphOp {
    if (op.kind !== "upsertNode" || this.ftsIndexes.length === 0) {
      return op;
    }
    const plans = this.ftsIndexes.filter((plan) => plan.table === op.type);
    if (plans.length === 0) {
      return op;
    }
    return {
      ...op,
      properties: { ...op.properties, ...searchColumnValues(plans, op.properties) },
    };
  }

  async applyBatch(scope: WorkspaceScope, ops: GraphOp[]): Promise<void> {
    if (ops.length === 0) {
      return;
    }
    this.assertScope(scope);
    await this.serialize(async () => {
      const conn = await this.connection();
      for (const op of ops) {
        for (const statement of opToCypher(this.withSearchColumns(op))) {
          await conn.query(statement);
        }
      }
      await this.embedNodes(conn, ops);
      this.walDirty = true;
    });
    this.scheduleCheckpoint();
  }

  /**
   * Embed whatever these ops changed, in one call for the whole batch.
   *
   * The vector goes in its own `SET` rather than riding along in
   * `op.properties`, because `literal()` in cypher.ts would quote the array as
   * a string — and because a separate statement is what lets an edit that did
   * not touch any vectorized field skip the model entirely.
   */
  private async embedNodes(conn: LadybugConnection, ops: GraphOp[]): Promise<void> {
    const provider = this.options.embeddings;
    if (!provider || this.vectorIndexes.length === 0) {
      return;
    }
    const pending: Array<{ plan: VectorIndexPlan; id: string; text: string }> = [];
    for (const op of ops) {
      if (op.kind === "deleteNode") {
        this.vectorTexts.delete(op.id);
        continue;
      }
      if (op.kind !== "upsertNode") {
        continue;
      }
      const plan = this.vectorIndexes.find((item) => item.table === op.type);
      if (!plan) {
        continue;
      }
      const text = vectorText(this.schema?.nodes[op.type], op.properties);
      if (!text || this.vectorTexts.get(op.id) === text) {
        continue;
      }
      pending.push({ plan, id: op.id, text });
    }
    if (pending.length === 0) {
      return;
    }
    let vectors: Float32Array[];
    try {
      vectors = await provider.embed(
        pending.map((item) => item.text),
        "document",
      );
    } catch (error) {
      // The node is written either way. A missing vector costs it semantic
      // reachability until the next backfill, not the write itself.
      if (!this.embedFailed) {
        this.embedFailed = true;
        console.warn(`[collabnode] embedding failed, semantic search is incomplete: ${String(error)}`);
      }
      return;
    }
    for (const [index, item] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) {
        continue;
      }
      await conn.query(setVectorStatement(item.plan, item.id, vector));
      this.vectorTexts.set(item.id, item.text);
    }
  }

  /**
   * Embed every node whose vector column is still NULL. Three things leave one
   * behind: a database written before this schema declared `vector:`, an
   * embedding model that changed (a new column starts empty), and writes made
   * while the provider was failing.
   *
   * `applySchema` starts this in the background; call it directly to wait for a
   * fully populated index.
   */
  async reindexVectors(): Promise<void> {
    await this.backfill;
    this.backfill = this.runBackfill();
    await this.backfill;
  }

  private async runBackfill(): Promise<void> {
    const provider = this.options.embeddings;
    if (!provider || this.vectorIndexes.length === 0) {
      return;
    }
    for (const plan of this.vectorIndexes) {
      // Each round re-runs the same query; rows just embedded are no longer
      // NULL, so the window advances without paging state. One round holds the
      // connection at a time, so a burst of backfill cannot starve a write.
      for (;;) {
        if (!(await this.backfillRound(plan, provider))) {
          break;
        }
      }
    }
    this.scheduleCheckpoint();
  }

  /** One window of un-embedded rows. Returns false when there is no more to do. */
  private async backfillRound(
    plan: VectorIndexPlan,
    provider: EmbeddingProvider,
  ): Promise<boolean> {
    const rows = await this.serialize(async () => {
      const conn = await this.connection();
      return rowsFrom(await conn.query(pendingStatement(plan, BACKFILL_BATCH)));
    });
    if (rows.length === 0) {
      return false;
    }
    const pending: Array<{ id: string; text: string }> = [];
    for (const row of rows) {
      const record = row as { id?: unknown } & PropertyMap;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) {
        continue;
      }
      const text = vectorText(this.schema?.nodes[plan.table], record as PropertyMap);
      if (text) {
        pending.push({ id, text });
      }
    }
    if (pending.length === 0) {
      // Every row in this window is unembeddable — empty text, nothing to
      // index — and re-reading it would spin forever.
      return false;
    }
    // Embedding happens outside the lock: it is the slow part, and it needs no
    // database.
    const vectors = await provider.embed(
      pending.map((item) => item.text),
      "document",
    );
    await this.serialize(async () => {
      const conn = await this.connection();
      for (const [index, item] of pending.entries()) {
        const vector = vectors[index];
        if (vector) {
          await conn.query(setVectorStatement(plan, item.id, vector));
          this.vectorTexts.set(item.id, item.text);
        }
      }
      this.walDirty = true;
    });
    return rows.length >= BACKFILL_BATCH;
  }

  async query(scope: WorkspaceScope, cypher: string): Promise<QueryResult> {
    this.assertScope(scope);
    if (!this.schema) {
      throw new GraphStoreError("applySchema must be called before query");
    }
    return this.serialize(() => this.queryLocked(cypher));
  }

  private async queryLocked(cypher: string): Promise<QueryResult> {
    const conn = await this.connection();
    const raw = await rowsFrom(await conn.query(cypher));
    const rows: QueryRow[] = raw.map((row) => {
      if (row !== null && typeof row === "object" && !Array.isArray(row)) {
        return row as QueryRow;
      }
      if (Array.isArray(row)) {
        const object: QueryRow = {};
        row.forEach((value, index) => {
          object[String(index)] = value;
        });
        return object;
      }
      return { value: row };
    });
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows };
  }

  /**
   * BM25 over the FTS indexes built in `applySchema`. Ladybug keeps them current
   * as rows are written, so there is nothing to rebuild here — the projector's
   * writes are already in the index by the time this runs.
   */
  async search(
    scope: WorkspaceScope,
    request: GraphSearchRequest,
  ): Promise<GraphSearchHit[] | undefined> {
    if (this.scope !== scopeKey(scope) || !this.schema || this.ftsIndexes.length === 0) {
      return undefined;
    }
    return this.serialize(() => this.searchLocked(request));
  }

  private async searchLocked(request: GraphSearchRequest): Promise<GraphSearchHit[] | undefined> {
    const terms = searchTerms(request.q);
    if (terms.length === 0) {
      return [];
    }
    const wanted = request.types
      ? this.ftsIndexes.filter((plan) => request.types?.includes(plan.table))
      : this.ftsIndexes;
    if (wanted.length === 0) {
      return [];
    }
    const conn = await this.connection();
    const best = new Map<string, number>();
    for (const plan of wanted) {
      const rows = await rowsFrom(await conn.query(queryIndexStatement(plan, terms, request.limit)));
      for (const row of rows) {
        const hit = row as { id?: unknown; score?: unknown };
        const id = typeof hit.id === "string" ? hit.id : undefined;
        const score = Number(hit.score);
        if (!id || !Number.isFinite(score)) {
          continue;
        }
        // A node can hit in more than one tier; its strongest claim wins.
        const scaled = score * plan.boost;
        const previous = best.get(id);
        if (previous === undefined || scaled > previous) {
          best.set(id, scaled);
        }
      }
    }
    return [...best]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, request.limit);
  }

  /**
   * Nearest neighbours from the HNSW indexes built in `applySchema`. Ladybug
   * keeps them current as rows are written, so a note written a moment ago is
   * already in here — but note that it does *not* order its rows by distance,
   * so the sort below is doing real work.
   */
  async searchVector(
    scope: WorkspaceScope,
    request: GraphVectorRequest,
  ): Promise<GraphSearchHit[] | undefined> {
    if (this.scope !== scopeKey(scope) || !this.schema || this.vectorIndexes.length === 0) {
      return undefined;
    }
    return this.serialize(() => this.searchVectorLocked(request));
  }

  private async searchVectorLocked(
    request: GraphVectorRequest,
  ): Promise<GraphSearchHit[] | undefined> {
    const wanted = request.types
      ? this.vectorIndexes.filter((plan) => request.types?.includes(plan.table))
      : this.vectorIndexes;
    if (wanted.length === 0) {
      return [];
    }
    const query = await this.queryVector(request);
    if (!query) {
      return undefined;
    }
    const conn = await this.connection();
    const best = new Map<string, number>();
    for (const plan of wanted) {
      const rows = await rowsFrom(
        await conn.query(queryVectorIndexStatement(plan, query, request.limit)),
      );
      for (const row of rows) {
        const hit = row as { id?: unknown; distance?: unknown };
        const id = typeof hit.id === "string" ? hit.id : undefined;
        const distance = Number(hit.distance);
        // "More like this" means other things, not the thing itself.
        if (!id || id === request.likeId || !Number.isFinite(distance)) {
          continue;
        }
        // Vectors are normalized and the metric is cosine, so this is a
        // similarity in [-1, 1] — higher is closer, like every other score here.
        const score = 1 - distance;
        const previous = best.get(id);
        if (previous === undefined || score > previous) {
          best.set(id, score);
        }
      }
    }
    const hits = [...best]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return aboveFloor(hits, this.options.embeddings).slice(0, request.limit);
  }

  /** The vector to rank against: a node's own stored one, or a freshly embedded query. */
  private async queryVector(request: GraphVectorRequest): Promise<Float32Array | undefined> {
    if (request.likeId !== undefined) {
      return this.storedVector(request.likeId);
    }
    const text = request.q?.trim();
    if (!text) {
      return undefined;
    }
    try {
      return (await this.options.embeddings?.embed([text], "query"))?.[0];
    } catch (error) {
      console.warn(`[collabnode] could not embed the query, falling back: ${String(error)}`);
      return undefined;
    }
  }

  private async storedVector(id: string): Promise<Float32Array | undefined> {
    const conn = await this.connection();
    const literal = `'${id.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    for (const plan of this.vectorIndexes) {
      const rows = await rowsFrom(
        await conn.query(`MATCH (n:${plan.table} {id: ${literal}}) RETURN n.${plan.column} AS vector`),
      );
      const value = (rows[0] as { vector?: unknown } | undefined)?.vector;
      if (Array.isArray(value) && value.length === plan.dimensions) {
        return Float32Array.from(value as number[]);
      }
    }
    return undefined;
  }

  searchModes(scope: WorkspaceScope): GraphSearchModes {
    if (this.scope !== scopeKey(scope)) {
      return { text: false, vector: false };
    }
    return { text: this.ftsIndexes.length > 0, vector: this.vectorIndexes.length > 0 };
  }

  async close(): Promise<void> {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    // The backfill holds the same connection; closing under it would take down
    // the process rather than raise.
    await this.backfill;
    this.backfill = undefined;
    // The last thing done to this database, and the thing that decides whether
    // it can be opened again.
    await this.serialize(() => this.checkpoint());
    await this.db?.close?.();
    this.db = undefined;
    this.conn = undefined;
    this.schema = undefined;
    this.ftsIndexes = [];
    this.vectorIndexes = [];
    this.vectorTexts.clear();
  }
}
