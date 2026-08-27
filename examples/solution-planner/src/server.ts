import {
  createHub,
  loadWorkspaceTypeFile,
  createHubMcpHandler,
  openCollab,
  readBody,
  toWebRequest,
  writeWebResponse,
  memoryRegistry,
} from "collabnode";
import { createRedisClient, redisRegistry } from "@collabnode/redis";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { config as loadDotEnv } from "dotenv";
import {
  startPlannerWorkflow,
  startRevisionWorkflow,
  resumePlannerWithValidation,
  runSingleAgentStep,
  getPlannerState,
} from "./agent/graph.ts";
import { dirtyNodes } from "./agent/dirty.ts";
import { detectLanguage } from "./agent/llm.ts";

loadDotEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? process.env.PLANNER_PORT ?? 4180);
const redisUrl = process.env.REDIS_URL;

/**
 * `COLLAB_BACKEND` picks the transport, and a bad one is a boot failure rather
 * than a silent downgrade: a planner that quietly falls back to an in-process
 * backend looks like it works right up until a second browser joins and sees
 * an empty graph.
 */
const collabKind = (process.env.COLLAB_BACKEND ?? "fluid") as "fluid" | "hocuspocus" | "memory";
const {
  backend: collabBackend,
  join: collabJoin,
  close: closeCollab,
} = await openCollab(
  collabKind === "fluid" ? { kind: "fluid", storageDir: "data/tinylicious" } : { kind: collabKind },
  "server",
);

/**
 * Redis when `REDIS_URL` is set, in-process otherwise — and a `REDIS_URL` that
 * does not answer is a boot failure, for the same reason. The prefix carries no
 * trailing colon: the registry adds its own separators.
 */
const redisClient = redisUrl ? await createRedisClient(redisUrl) : undefined;
const registry = redisClient
  ? await redisRegistry({ client: redisClient, prefix: "collabnode:planner" })
  : memoryRegistry();
if (redisClient) {
  // One read before anything depends on it, so an unreachable cache says so
  // here instead of three hops inside hub.open().
  await registry.list({ state: "active" });
  console.log(`Workspace registry     → Redis (${new URL(redisUrl!).host})`);
}

// Hub instance
const hub = await createHub({
  collab: collabBackend,
  registry,
  sweepIntervalMs: 0,
});

// Load workspace schema
const plannerType = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
hub.define(plannerType);

// One workspace comes up seeded, on the id the README links to. Everything
// else is created from the UI through the same `hub.open` path.
const defaultWorkspaceId = "solution-planner-1";
await hub.open("solution-planner", {
  id: defaultWorkspaceId,
  label: "Solution Planner Main",
  actorId: "server",
  params: { appName: "Solution Planner Main", language: "en" },
});

const mcpHandler = createHubMcpHandler(hub, {
  mount: "/mcp",
  language: "en",
});

const http = createServer((req, res) => {
  void route(req, res);
});

const vite = await createViteServer({
  root,
  appType: "spa",
  server: {
    middlewareMode: true,
    hmr: { server: http },
  },
});

http.listen(port, "127.0.0.1", () => {
  console.log(`🚀 Solution Planner running → http://127.0.0.1:${port}`);
  console.log(`🌐 MCP endpoint          → http://127.0.0.1:${port}/mcp/w/${defaultWorkspaceId}`);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  try {
    if (path.startsWith("/mcp")) {
      if (path === "/mcp" || path === "/mcp/") {
        req.url = `/mcp/w/${defaultWorkspaceId}`;
      }
      const request = toWebRequest(req, await readBody(req));
      const mcpResponse = await mcpHandler.fetch(request);
      await writeWebResponse(res, mcpResponse);
      return;
    }

    if (await apiRoutes(path, req, res)) {
      return;
    }

    vite.middlewares(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }
}

async function apiRoutes(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";

  if (path === "/api/workspaces" && method === "GET") {
    const records = await hub.list({ typeName: "solution-planner" });
    const list = records.map((rec) => {
      const state = getPlannerState(rec.id);
      return {
        id: rec.id,
        appName: rec.label ?? String(rec.params?.appName ?? rec.id),
        language: (rec.params?.language as "en" | "es") ?? "en",
        status: state?.status ?? "idle",
        iteration: state?.iteration ?? 0,
        managerAgrees: state?.managerAgrees ?? false,
        architectAgrees: state?.architectAgrees ?? false,
      };
    });
    json(res, list);
    return true;
  }

  if (path === "/api/workspaces" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const appName =
      typeof payload?.appName === "string" && payload.appName.trim()
        ? payload.appName.trim()
        : "New Solution";
    const language = payload?.language === "es" ? "es" : "en";
    const rawId =
      typeof payload?.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : `solution-${Date.now().toString(36)}`;
    const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

    await hub.open("solution-planner", {
      id,
      label: appName,
      actorId: "server",
      params: { appName, language },
    });

    json(res, { id, appName, language });
    return true;
  }

  if (path.startsWith("/api/workspaces/") && method === "DELETE") {
    const wsId = decodeURIComponent(path.replace("/api/workspaces/", "")).trim();
    if (wsId && wsId !== defaultWorkspaceId) {
      // `end()` first: dropping the record alone leaves this process holding a
      // live document, its lease, and its relay connection for good.
      const live = hub.getLiveWorkspace(wsId);
      if (live) {
        await live.end("explicit");
      }
      await hub.registry.delete(wsId);
    }
    json(res, { deleted: wsId });
    return true;
  }

  if (path === "/api/collab/join") {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const wsId = url.searchParams.get("workspace")?.trim() || defaultWorkspaceId;
    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });

    json(res, {
      documentId: ws.session.id,
      workspaceId: ws.id,
      typeName: ws.type.name,
      schema: ws.type.schema,
      collab: collabJoin,
    });
    return true;
  }

  if (path === "/api/planner/start" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;
    const description = typeof payload?.description === "string" ? payload.description.trim() : "";
    let language = typeof payload?.language === "string" ? (payload.language as "en" | "es") : undefined;

    if (!description) {
      fail(res, 400, "description is required");
      return true;
    }

    if (!language) {
      language = detectLanguage(description);
    }

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const result = await startPlannerWorkflow(wsId, ws.session, description, language);
    json(res, result);
    return true;
  }

  if (path === "/api/planner/validate" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;
    const assumptionId = typeof payload?.assumptionId === "string" ? payload.assumptionId : "";
    const approved = Boolean(payload?.approved);
    const comment = typeof payload?.comment === "string" ? payload.comment : undefined;

    if (!assumptionId) {
      fail(res, 400, "assumptionId is required");
      return true;
    }

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const result = await resumePlannerWithValidation(wsId, ws.session, {
      assumptionId,
      approved,
      comment,
    });
    json(res, result);
    return true;
  }

  if (path === "/api/planner/revise" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;
    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const dirty = dirtyNodes(ws.session.snapshot());
    if (dirty.length === 0) {
      fail(res, 400, "no dirty nodes to revise");
      return true;
    }

    const reviewMessage =
      typeof payload?.reviewMessage === "string" ? payload.reviewMessage.trim() : "";
    const result = await startRevisionWorkflow(wsId, ws.session, reviewMessage || undefined);
    json(res, result);
    return true;
  }

  if (path === "/api/planner/step" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;
    const actor = payload?.actor === "architect" ? "architect" : "manager";

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const result = await runSingleAgentStep(wsId, ws.session, actor);
    json(res, result);
    return true;
  }

  if (path === "/api/planner/reset" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const snap = ws.session.snapshot();

    // Delete edges first, then nodes (except SolutionState which is reset)
    for (const edge of snap.edges) {
      await ws.session.deleteEdge(edge.id);
    }
    for (const node of snap.nodes) {
      if (node.type !== "SolutionState") {
        await ws.session.deleteNode(node.id);
      }
    }

    // `SolutionState` is a singleton in the workspace YAML, so this lands on
    // the node that is already there rather than adding a second one.
    await ws.session.upsertNode({
      type: "SolutionState",
      properties: {
        appName: "Solution Planner Demo",
        description: "Initial solution workspace",
        language: "en",
        status: "idle",
        managerAgrees: false,
        architectAgrees: false,
        iteration: 0,
        mode: "initial",
      },
    });

    json(res, { reset: true });
    return true;
  }

  if (path === "/api/planner/status" && method === "GET") {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const wsId = url.searchParams.get("workspace")?.trim() || defaultWorkspaceId;
    const state = getPlannerState(wsId);
    json(res, state ?? { status: "idle", logs: [] });
    return true;
  }

  return false;
}

function parseJson(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8") || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

const shutdown = async () => {
  http.close();
  await vite.close();
  await hub.close();
  await closeCollab();
  await redisClient?.quit?.();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
