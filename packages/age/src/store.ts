import type {
  GraphOp,
  GraphStore,
  QueryResult,
  QueryRow,
  WorkspaceScope,
} from "@collabnode/graph";
import { GraphStoreError, scopeKey } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import pg from "pg";
import { decodeAgeValue } from "./agtype.js";
import { opToCypher } from "./cypher.js";
import { assertGraphName, assertLabel, scopedGraphName, sqlString } from "./names.js";
import { wrapCypher } from "./wrap.js";

export interface AgeSqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
}

export interface AgeGraphStoreOptions {
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /**
   * Base name for the AGE graphs this store creates. Each workspace gets its
   * own graph derived from it, because caller-written Cypher reaches the engine
   * unmodified and a shared graph would let one workspace's query see another's
   * nodes. Defaults to the schema id.
   */
  graphName?: string;
  ssl?: boolean;
  /** Drop and recreate the AGE graph on applySchema. Use for demos/tests only. */
  reset?: boolean;
  /** Injected in tests. When omitted, a `pg` client is opened. */
  client?: AgeSqlClient;
}

export function ageOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AgeGraphStoreOptions {
  return definedOptions({
    url: env.AGE_URL || env.DATABASE_URL,
    host: env.AGE_HOST,
    port: env.AGE_PORT ? Number(env.AGE_PORT) : undefined,
    user: env.AGE_USER,
    password: env.AGE_PASSWORD,
    database: env.AGE_DATABASE,
    graphName: env.AGE_GRAPH,
    ssl: env.AGE_SSL === "1" || env.AGE_SSL === "true" ? true : undefined,
    reset: env.AGE_RESET === "1" || env.AGE_RESET === "true" ? true : undefined,
  });
}

function definedOptions(options: AgeGraphStoreOptions): AgeGraphStoreOptions {
  const out: AgeGraphStoreOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function clientConfig(options: AgeGraphStoreOptions): pg.ClientConfig {
  if (options.url) {
    return { connectionString: options.url, ssl: options.ssl };
  }
  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 5455,
    user: options.user ?? "postgres",
    password: options.password ?? "postgres",
    database: options.database ?? "postgres",
    ssl: options.ssl,
  };
}

/** Everything this store knows about one workspace's projection. */
interface AgeScope {
  graphName: string;
  schema: GraphSchema;
}

export class AgeGraphStore implements GraphStore {
  private client: AgeSqlClient | undefined;
  private owned = false;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly scopes = new Map<string, AgeScope>();

  private readonly options: AgeGraphStoreOptions;

  constructor(options: AgeGraphStoreOptions = {}) {
    this.options = { ...ageOptionsFromEnv(), ...definedOptions(options) };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async connection(): Promise<AgeSqlClient> {
    if (this.client) {
      return this.client;
    }
    if (this.options.client) {
      this.client = this.options.client;
      return this.client;
    }
    const client = new pg.Client(clientConfig(this.options));
    try {
      await client.connect();
    } catch (error) {
      throw new GraphStoreError(
        `Apache AGE is not reachable. Start an Apache AGE container with docker, or pass graph: { kind: "age", host, port, ... }. ${String(error)}`,
      );
    }
    this.client = client;
    this.owned = true;
    return this.client;
  }

  private async exec(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const client = await this.connection();
    try {
      return await client.query(sql, values);
    } catch (error) {
      throw new GraphStoreError(`AGE query failed: ${String(error)}\n${sql}`);
    }
  }

  private async prepareSession(): Promise<void> {
    await this.exec("CREATE EXTENSION IF NOT EXISTS age");
    await this.exec("LOAD 'age'");
    await this.exec('SET search_path = ag_catalog, "$user", public');
  }

  private async graphExists(graphName: string): Promise<boolean> {
    const result = await this.exec("SELECT 1 AS ok FROM ag_catalog.ag_graph WHERE name = $1", [
      graphName,
    ]);
    return result.rows.length > 0;
  }

  private async ensureGraph(graphName: string): Promise<void> {
    const g = sqlString(graphName);
    if (this.options.reset && (await this.graphExists(graphName))) {
      await this.exec(`SELECT drop_graph(${g}, true)`);
    }
    if (!(await this.graphExists(graphName))) {
      await this.exec(`SELECT create_graph(${g})`);
    }
  }

  private async existingLabels(graphName: string): Promise<Set<string>> {
    try {
      const existing = await this.exec(
        `SELECT l.name AS name, l.kind AS kind
         FROM ag_catalog.ag_label l
         JOIN ag_catalog.ag_graph g ON g.graphid = l.graph
         WHERE g.name = $1`,
        [graphName],
      );
      return new Set(existing.rows.map((row) => `${String(row.kind).trim()}:${String(row.name)}`));
    } catch {
      return new Set();
    }
  }

  private async tryCatalog(sql: string): Promise<void> {
    try {
      await this.exec(sql);
    } catch (error) {
      if (!/already exists/i.test(String(error))) {
        throw error;
      }
    }
  }

  private async ensureLabels(graphName: string, schema: GraphSchema): Promise<void> {
    const have = await this.existingLabels(graphName);
    const g = sqlString(graphName);
    for (const name of Object.keys(schema.nodes)) {
      const label = assertLabel(name);
      if (!have.has(`v:${label}`) && !have.has(`vertex:${label}`)) {
        await this.tryCatalog(`SELECT create_vlabel(${g}, ${sqlString(label)})`);
      }
    }
    for (const name of Object.keys(schema.edges)) {
      const label = assertLabel(name);
      if (!have.has(`e:${label}`) && !have.has(`edge:${label}`)) {
        await this.tryCatalog(`SELECT create_elabel(${g}, ${sqlString(label)})`);
      }
    }
  }

  /** The AGE graph backing `scope`. One per workspace; see `scopedGraphName`. */
  graphNameFor(scope: WorkspaceScope): string {
    return scopedGraphName(
      this.options.graphName ? assertGraphName(this.options.graphName) : scope.schemaId,
      scope.workspaceId,
    );
  }

  async applySchema(scope: WorkspaceScope, schema: GraphSchema): Promise<void> {
    return this.exclusive(async () => {
      const graphName = this.graphNameFor(scope);
      this.scopes.set(scopeKey(scope), { graphName, schema });
      await this.prepareSession();
      await this.ensureGraph(graphName);
      await this.ensureLabels(graphName, schema);
    });
  }

  async apply(scope: WorkspaceScope, op: GraphOp): Promise<void> {
    await this.applyBatch(scope, [op]);
  }

  async applyBatch(scope: WorkspaceScope, ops: GraphOp[]): Promise<void> {
    if (ops.length === 0) {
      return;
    }
    return this.exclusive(async () => {
      const entry = this.require(scope);
      if (this.closed) {
        throw new GraphStoreError("AGE store is closed");
      }
      await this.exec("BEGIN");
      try {
        for (const op of ops) {
          for (const cypher of opToCypher(op)) {
            const wrapped = wrapCypher(entry.graphName, cypher);
            await this.exec(wrapped.sql, wrapped.values);
          }
        }
        await this.exec("COMMIT");
      } catch (error) {
        try {
          await this.exec("ROLLBACK");
        } catch {
          // ignore rollback failures; the original error is what matters
        }
        throw error;
      }
    });
  }

  async query(
    scope: WorkspaceScope,
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<QueryResult> {
    return this.exclusive(async () => {
      const entry = this.require(scope);
      const wrapped = wrapCypher(entry.graphName, cypher, params);
      const raw = await this.exec(wrapped.sql, wrapped.values);
      const rows: QueryRow[] = raw.rows.map((row) => {
        const out: QueryRow = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] = decodeAgeValue(value);
        }
        return out;
      });
      const asMatch = /\sAS\s+\((.+)\)\s*$/i.exec(wrapped.sql.trim());
      const declared = asMatch
        ? asMatch[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!).filter(Boolean)
        : [];
      const columns = rows[0] ? Object.keys(rows[0]) : declared;
      return { columns, rows };
    });
  }

  /** Drop the workspace's graph outright. AGE reclaims the labels with it. */
  async dropScope(scope: WorkspaceScope): Promise<void> {
    return this.exclusive(async () => {
      const key = scopeKey(scope);
      const entry = this.scopes.get(key);
      this.scopes.delete(key);
      if (!entry || this.closed) {
        return;
      }
      await this.prepareSession();
      if (await this.graphExists(entry.graphName)) {
        await this.exec(`SELECT drop_graph(${sqlString(entry.graphName)}, true)`);
      }
    });
  }

  private require(scope: WorkspaceScope): AgeScope {
    const entry = this.scopes.get(scopeKey(scope));
    if (!entry) {
      throw new GraphStoreError(
        `applySchema must be called for workspace '${scope.workspaceId}' before it is used`,
      );
    }
    return entry;
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      this.closed = true;
      if (this.owned) {
        await this.client?.end?.();
      }
      this.client = undefined;
      this.owned = false;
      this.scopes.clear();
    });
  }
}
