import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgeGraphStore,
  init,
  InMemoryCollabBackend,
  loadSchemaFile,
  type CollabKind,
  type Collabnode,
  type GraphKind,
  type GraphSchema,
} from "collabnode";
import type { BackendName, BenchOptions, GraphName } from "./types.js";

const schemaPath = fileURLToPath(new URL("../schema.yaml", import.meta.url));

export async function loadBenchSchema(): Promise<GraphSchema> {
  return loadSchemaFile(schemaPath);
}

let ladybugProbe: Promise<boolean> | undefined;
let ageProbe: Promise<boolean> | undefined;

export async function ladybugAvailable(): Promise<boolean> {
  ladybugProbe ??= (async () => {
    try {
      await import("@ladybugdb/core");
      return true;
    } catch {
      return false;
    }
  })();
  return ladybugProbe;
}

export async function ageAvailable(): Promise<boolean> {
  ageProbe ??= (async () => {
    try {
      const schema = await loadBenchSchema();
      const store = new AgeGraphStore({ graphName: "cn_probe", reset: true });
      await store.applySchema(
        { workspaceId: "probe", schemaId: schema.config.schemaId },
        schema,
      );
      await store.close();
      return true;
    } catch {
      return false;
    }
  })();
  return ageProbe;
}

export interface World {
  readonly host: Collabnode;
  readonly schema: GraphSchema;
  readonly backend: BackendName;
  readonly graph: GraphName;
  joinPeer(actorId: string): Promise<Collabnode>;
  close(): Promise<void>;
}

export async function openWorld(
  options: Pick<BenchOptions, "backend" | "graph" | "port">,
  schema: GraphSchema,
  actorId: string,
): Promise<World> {
  if (options.graph === "ladybug" && !(await ladybugAvailable())) {
    throw new Error(
      "Ladybug is not installed. Add @ladybugdb/core or pass --graph memory.",
    );
  }
  if (options.graph === "age" && !(await ageAvailable())) {
    throw new Error(
      "Apache AGE is not reachable. Start an Apache AGE container or pass --graph memory.",
    );
  }
  const dir =
    options.graph === "ladybug"
      ? await mkdtemp(join(tmpdir(), "collabnode-bench-"))
      : undefined;
  const sessionKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const shared = options.backend === "memory" ? new InMemoryCollabBackend() : undefined;

  const open = async (id: string, documentId?: string): Promise<Collabnode> =>
    init({
      schema,
      actorId: id,
      documentId,
      collab: collabKind(options.backend, shared, options.port),
      graph: graphKind(options.graph, dir, sessionKey, id),
      mcp: false,
    });

  let host: Collabnode;
  try {
    host = await open(actorId);
  } catch (error) {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
  const peers: Collabnode[] = [];

  return {
    host,
    schema,
    backend: options.backend,
    graph: options.graph,
    async joinPeer(peerActorId: string): Promise<Collabnode> {
      const peer = await open(peerActorId, host.documentId);
      peers.push(peer);
      return peer;
    },
    async close(): Promise<void> {
      for (const peer of peers.reverse()) {
        await peer.close();
      }
      await host.close();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function collabKind(
  backend: BackendName,
  shared: InMemoryCollabBackend | undefined,
  port: number,
): CollabKind {
  if (backend === "memory") {
    if (!shared) {
      throw new Error("memory backend requires a shared InMemoryCollabBackend");
    }
    return { kind: "custom", backend: shared };
  }
  if (backend === "hocuspocus") {
    return { kind: "hocuspocus", port: port === 7070 ? 1234 : port };
  }
  return { kind: "fluid", port };
}

function ageGraphName(sessionKey: string, actorId: string): string {
  const raw = `bn_${sessionKey}_${actorId}`.replaceAll(/[^A-Za-z0-9_]/g, "_");
  return raw.slice(0, 63);
}

function graphKind(
  graph: GraphName,
  dir: string | undefined,
  sessionKey: string,
  actorId: string,
): GraphKind {
  if (graph === "memory") {
    return { kind: "memory" };
  }
  if (graph === "age") {
    return { kind: "age", graphName: ageGraphName(sessionKey, actorId), reset: true };
  }
  if (!dir) {
    throw new Error("ladybug graph requires a temp directory");
  }
  return { kind: "ladybug", path: join(dir, `${actorId}.lbdb`) };
}

const STATUSES = ["todo", "doing", "done"] as const;

export function taskTitle(prefix: string, i: number): string {
  return `${prefix}-${i}`;
}

export function nextStatus(i: number): (typeof STATUSES)[number] {
  return STATUSES[i % STATUSES.length]!;
}

export async function seedTasks(
  node: Collabnode,
  count: number,
  prefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = await node.session.upsertNode({
      type: "Task",
      properties: { title: taskTitle(prefix, i), status: "todo" },
    });
    ids.push(id);
  }
  return ids;
}

export async function seedBlocks(node: Collabnode, ids: string[], every = 10): Promise<number> {
  let edges = 0;
  for (let i = 0; i + 1 < ids.length; i += every) {
    await node.session.upsertEdge({
      type: "BLOCKS",
      from: ids[i]!,
      to: ids[i + 1]!,
    });
    edges += 1;
  }
  return edges;
}

export async function taskCount(node: Collabnode): Promise<{ snapshot: number; query: number }> {
  const snapshot = node.session.snapshot().nodes.filter((record) => record.type === "Task").length;
  const query = await node.session.query("MATCH (n:Task) RETURN n");
  return { snapshot, query: query.rows.length };
}

export async function edgeCount(node: Collabnode): Promise<{ snapshot: number; query: number }> {
  const snapshot = node.session.snapshot().edges.length;
  const query = await node.session.query("MATCH (a)-[r:BLOCKS]->(b) RETURN a");
  return { snapshot, query: query.rows.length };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}
