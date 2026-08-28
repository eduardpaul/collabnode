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
import { collabnodeTypes } from "collabnode/vite";
import { config as loadDotEnv } from "dotenv";
import {
  startPlannerWorkflow,
  startRevisionWorkflow,
  resumePlannerWithValidation,
  runSingleAgentStep,
  getPlannerState,
} from "./agent/graph.ts";
import { dirtyNodes } from "./agent/dirty.ts";
import { singletonOfType } from "collabnode";
import type { PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";
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
/**
 * The hub serves any workspace type, so the session it hands back is untyped.
 * This is the one place this app's own schema goes back on.
 */
function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

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
  // Save `solution-planner.yaml` and `src/workspace.types.ts` is rewritten
  // before you have switched windows. Nothing to run by hand: the editor's
  // TypeScript server picks the file up from disk, so a renamed property or a
  // narrowed enum goes red across the app on save.
  plugins: [
    collabnodeTypes({
      input: join(root, "workspaces/solution-planner.yaml"),
      output: join(root, "src/workspace.types.ts"),
      name: "SolutionPlanner",
    }),
  ],
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
        ...plannerStateFromGraph(rec.id),
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
      documentId: planner(ws).id,
      workspaceId: ws.id,
      typeName: ws.type.name,
      schema: ws.type.schema,
      // The workspace type's named slices, so the browser renders the same views
      // the agents call as `view_<name>` tools rather than re-deriving its own.
      views: ws.type.views,
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
    const result = await startPlannerWorkflow(wsId, planner(ws), description, language);
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
    const result = await resumePlannerWithValidation(wsId, planner(ws), {
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
    const dirty = dirtyNodes(planner(ws).snapshot());
    if (dirty.length === 0) {
      fail(res, 400, "no dirty nodes to revise");
      return true;
    }

    const reviewMessage =
      typeof payload?.reviewMessage === "string" ? payload.reviewMessage.trim() : "";
    const result = await startRevisionWorkflow(wsId, planner(ws), reviewMessage || undefined);
    json(res, result);
    return true;
  }

  if (path === "/api/planner/step" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;
    const actor = payload?.actor === "architect" ? "architect" : "manager";

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const result = await runSingleAgentStep(wsId, planner(ws), actor);
    json(res, result);
    return true;
  }

  if (path === "/api/planner/reset" && method === "POST") {
    const payload = parseJson(await readBody(req));
    const wsId = typeof payload?.workspaceId === "string" ? payload.workspaceId : defaultWorkspaceId;

    const ws = await hub.open("solution-planner", { id: wsId, actorId: "server" });
    const snap = planner(ws).snapshot();

    // Delete edges first, then nodes (except SolutionState which is reset)
    for (const edge of snap.edges) {
      await planner(ws).deleteEdge(edge.id);
    }
    for (const node of snap.nodes) {
      if (node.type !== "SolutionState") {
        await planner(ws).deleteNode(node.id);
      }
    }

    // `SolutionState` is a singleton in the workspace YAML, so this lands on
    // the node that is already there rather than adding a second one.
    await planner(ws).upsertNode({
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
    // Logs only exist on the run; everything else is read back off the graph.
    json(res, { ...(getPlannerState(wsId) ?? { status: "idle", logs: [] }), ...plannerStateFromGraph(wsId) });
    return true;
  }

  return false;
}

/**
 * Consensus state as the graph holds it.
 *
 * The LangGraph run state only knows what the *agents* last decided. A human
 * editing a node in the browser breaks consensus by writing to the CRDT, and
 * the run never hears about it — so reading agreement from the run reports a
 * plan as approved while the board shows dirty nodes and two agents mid-review.
 * The SolutionState node is the one that both sides actually write to.
 *
 * Returns nothing for a workspace that is not open: there is no graph to read.
 */
function plannerStateFromGraph(wsId: string): Record<string, unknown> | undefined {
  const live = hub.getLiveWorkspace(wsId);
  const snapshot = live?.session.as<SolutionPlanner>().snapshot();
  const props = snapshot && singletonOfType(snapshot, "SolutionState")?.properties;
  if (!props) {
    return undefined;
  }
  return {
    status: props.status ?? "idle",
    managerAgrees: props.managerAgrees === true,
    architectAgrees: props.architectAgrees === true,
    iteration: Number(props.iteration ?? 0),
    activeAssumptionId: props.pendingAssumptionId ?? undefined,
    activeAgent: props.activeAgent ?? "none",
  };
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
