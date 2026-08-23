import {
  createFluidTokenHandler,
  createHub,
  loadWorkspaceTypeFile,
  createHubMcpHandler,
  openCollab,
  openEmbeddings,
  SchemaError,
  systemPromptText,
  toWebRequest,
  writeWebResponse,
  type EmbeddingsKind,
} from "collabnode";
import { createRedisClient, redisRegistry } from "@collabnode/redis";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { redisBoardNames } from "./board-names.ts";
import { BoardDirectory, UnknownBoardTypeError, type HubWorkspace } from "./boards.ts";
import { azureFluidConfig, loadDotEnv, redisPrefix, redisUrl, voiceLiveConfig } from "./env.ts";
import { strings, uiLanguage } from "./i18n.ts";
import { VoiceCall, type CallLog } from "./voice-live.ts";
import { voiceToolset } from "./voice-tools.ts";

loadDotEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.VOICE_BOARD_PORT ?? 4175);

/**
 * Both hosted services are read before anything else starts. Missing
 * configuration is a boot failure here, not a board that silently comes up on
 * an in-process backend nobody else can reach.
 */
const fluid = azureFluidConfig();
const redisConnection = redisUrl();
const prefix = redisPrefix();
/** Language used when a request does not ask for one. `VOICE_BOARD_LANG=es` flips the default. */
const defaultLanguage = uiLanguage(process.env.VOICE_BOARD_LANG);

/**
 * Semantic search runs a small model on this machine, and transformers.js is an
 * optional dependency, so the board works either way: with it, Echo can answer
 * "what did we say about hiring"; without it, search matches wording only.
 *
 * `openEmbeddings` turns the descriptor into the actual provider. The Hub wants
 * a provider, not a descriptor — handing it `{ kind: "local" }` type-checks
 * nowhere (this example has no tsconfig) and fails at the first query with
 * `embed is not a function`, which reads as "no semantic search" rather than as
 * a wiring bug.
 */
async function localEmbeddingsIfInstalled(): Promise<EmbeddingsKind> {
  try {
    await import("@huggingface/transformers");
    return { kind: "local" };
  } catch {
    return false;
  }
}

const embeddings = openEmbeddings(await localEmbeddingsIfInstalled());

/**
 * Azure Fluid Relay, not Tinylicious: nothing is spawned locally, and
 * `close()` has nothing to stop. `openCollab` mints this process's tokens from
 * AZURE_FLUID_KEY — the key stays here, and browsers get per-document tokens
 * from /api/fluid/token below.
 */
const { backend: collabBackend, join: collabJoin, close: closeCollab } = await openCollab(
  { kind: "fluid", relay: "azure" },
  "server",
);

/**
 * One Redis connection, two jobs: the workspace registry the Hub leases and
 * reaps through, and the board names the homepage shows. Sharing the client
 * keeps this to a single TLS connection per replica.
 */
const redis = await createRedisClient(redisConnection);
const registry = await redisRegistry({ client: redis, prefix });

// One read, before anything depends on it. Without this the first symptom of an
// unreachable cache is an ioredis retry error three hops inside `hub.open()`,
// which reads as a bug in the Hub rather than as a firewall rule.
try {
  await registry.list({ state: "active" });
} catch (error) {
  throw new Error(
    `Cannot reach Redis at ${redisHost(redisConnection)}: ` +
      `${error instanceof Error ? error.message : String(error)} ` +
      "Check the access key, and that this host is allowed by the cache's firewall " +
      "(Azure Managed Redis blocks everything until you add a rule).",
  );
}

/**
 * The registry is what makes a second replica possible: leases, records, and
 * the reaper's view of what is due all live in Redis rather than in this
 * process, so `hub.open()` stays idempotent across hosts.
 *
 * `sweepIntervalMs: 0` leaves the reaper timer off; with more than one replica
 * exactly one of them should drive `hub.sweep()`, from a cron or a leader
 * election, rather than all of them racing.
 *
 * No `graph`: both board types declare `projection: memory`, so each board gets
 * its own in-memory store. A hub-level `graph` is for `projection: shared`, and
 * it takes a GraphStore instance rather than a descriptor.
 */
const hub = await createHub({
  collab: collabBackend,
  registry,
  embeddings,
  sweepIntervalMs: 0,
});

// Load and register multiple declarative workspace schemas
const voiceBoardType = await loadWorkspaceTypeFile(join(root, "workspaces/voice-board.yaml"));
const c4ArchitectureType = await loadWorkspaceTypeFile(join(root, "workspaces/c4-architecture.yaml"));

hub.define(voiceBoardType);
hub.define(c4ArchitectureType);

/**
 * Boards are opened on demand from the homepage rather than fixed at boot, so
 * the directory — not a `const` per workspace — is what the routes below read.
 */
const boards = new BoardDirectory(hub, {
  mcpBase: "/mcp",
  names: redisBoardNames(redis, prefix),
});

/**
 * Two boards still come up seeded, one of each type. They are only a starting
 * point: they use the ids the README links to, and they are created through the
 * same `hub.open` path the homepage's create button uses, so nothing about them
 * is special except that nobody had to click anything.
 */
const wsVoice = boards.adopt(
  await hub.open("voice-board", {
    id: "voice-board-1",
    actorId: "server",
    params: { author: "Ada" },
  }),
  "Ada's Board",
);

boards.adopt(
  await hub.open("c4-architecture", {
    id: "c4-architecture-1",
    actorId: "server",
    params: { systemName: "Collabnode Platform", primaryUser: "Software Engineer" },
  }),
  "Collabnode Platform",
);

/**
 * `createHubMcpHandler` already reads `?lang=` and `Accept-Language` off each
 * request, so an MCP client that asks for Spanish gets Spanish tool
 * descriptions and prompts out of the same workspace. `language` is only the
 * fallback for clients that say nothing.
 */
const mcpHandler = createHubMcpHandler(hub, {
  mount: "/mcp",
  language: defaultLanguage,
});
const config = voiceLiveConfig(defaultLanguage);

/**
 * Fluid tokens for browser peers.
 *
 * The tenant key opens every document in the tenant, so it stays in this
 * process and each browser gets a token scoped to one document instead.
 * `authorize` is what makes that scoping mean something: without it the route
 * would mint a writable token for whatever `documentId` the caller typed,
 * including documents belonging to a different app in the same tenant.
 *
 * `?as=` is this sample's stand-in for a login, and it is exactly as
 * trustworthy as that sounds — a real deployment resolves the user from a
 * session or a bearer token and checks board membership inside `authorize`.
 * What the check below does guarantee, spoofed identity or not, is that the
 * document is one this hub actually opened.
 */
const fluidToken = createFluidTokenHandler({
  tenantId: fluid.tenantId,
  tenantKey: fluid.key,
  user: (request) => {
    const who = new URL(request.url).searchParams.get("as")?.trim();
    return { id: who || "guest", name: who || "guest" };
  },
  authorize: async ({ documentId }) => {
    const records = await hub.list({ state: "active" });
    return records.some((record) => record.collabDocId === documentId);
  },
});

const calls = new Map<string, VoiceCall>();
const logStreams = new Set<ServerResponse>();

const vite = await createViteServer({
  root,
  appType: "spa",
  server: { middlewareMode: true },
});

const http = createServer((req, res) => {
  void route(req, res);
});

http.listen(port, "127.0.0.1", () => {
  console.log(`Boards homepage             → http://127.0.0.1:${port}?as=ada`);
  console.log(`Voice Board (Notes & Tasks) → http://127.0.0.1:${port}?workspace=voice-board-1&as=ada`);
  console.log(`C4 Architecture Model       → http://127.0.0.1:${port}?workspace=c4-architecture-1&as=ada`);
  console.log(`MCP Voice Board Hub         → http://127.0.0.1:${port}/mcp/w/voice-board-1`);
  console.log(`MCP C4 Architecture Hub     → http://127.0.0.1:${port}/mcp/w/c4-architecture-1`);
  console.log(`Fluid Relay                 → ${fluid.endpoint} (tenant ${fluid.tenantId})`);
  console.log(`Workspace registry          → ${redisHost(redisConnection)} (prefix ${prefix})`);
  if (!config) {
    console.log("Voice idle                  → set AZURE_VOICE_LIVE_ENDPOINT and AZURE_VOICE_LIVE_API_KEY");
  } else {
    console.log(`Voice ready                 → ${config.model} / ${config.voice}`);
  }
});

/** `?lang=` on the request, then the server default. */
function resolveLanguage(req: IncomingMessage, explicit?: string): string {
  if (explicit) {
    return uiLanguage(explicit);
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  return uiLanguage(url.searchParams.get("lang") ?? defaultLanguage);
}

/**
 * The board a request is about, or `undefined` when the id names nothing live.
 *
 * With boards created and deleted at runtime, an id in a bookmarked URL can
 * simply be gone. Falling back to a default board would silently hand someone
 * else's notes to a stale link, so callers turn `undefined` into a 404 and the
 * page offers the homepage instead.
 */
function resolveWorkspace(req: IncomingMessage, explicitWorkspaceId?: string): HubWorkspace | undefined {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const reqId = explicitWorkspaceId ?? url.searchParams.get("workspace")?.trim();
  return reqId ? boards.get(reqId) : undefined;
}

/**
 * One dispatcher, three route tables: the MCP mount, the board API the
 * homepage talks to, the voice API a board talks to, and Vite for everything
 * else. The `*Api` helpers return whether they handled the request, so adding a
 * route does not add a branch here.
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  try {
    if (path.startsWith("/mcp")) {
      if (path === "/mcp" || path === "/mcp/") {
        req.url = `/mcp/w/${wsVoice.id}`;
      }
      const request = toWebRequest(req, await readBody(req));
      const mcpResponse = await mcpHandler.fetch(request);
      await writeWebResponse(res, mcpResponse);
      return;
    }

    if (await fluidApi(path, req, res)) {
      return;
    }

    if (await boardApi(path, req, res)) {
      return;
    }

    if (await voiceApi(path, req, res)) {
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

/** The one route a browser needs before it can join a document on the relay. */
async function fluidApi(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path !== "/api/fluid/token" || req.method !== "POST") {
    return false;
  }
  const request = toWebRequest(req, await readBody(req));
  await writeWebResponse(res, await fluidToken(request));
  return true;
}

/**
 * What the homepage reads and writes. Titles, blurbs, and the create form's
 * fields all come out of the workspace YAML, so adding a third board type is a
 * new file in `workspaces/` plus one `hub.define` — no change here, and no
 * change in the client.
 */
async function boardApi(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";

  if (path === "/api/board-types") {
    json(res, boards.types(resolveLanguage(req)));
    return true;
  }

  if (path === "/api/boards" && method === "GET") {
    json(res, await boards.list(resolveLanguage(req)));
    return true;
  }

  if (path === "/api/boards" && method === "POST") {
    await handleCreateBoard(req, res);
    return true;
  }

  if (path.startsWith("/api/boards/") && method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/boards/".length));
    json(res, { deleted: await boards.remove(id) });
    return true;
  }

  if (path === "/api/collab/join") {
    const ws = resolveWorkspace(req);
    if (!ws) {
      fail(res, 404, "board not found");
      return true;
    }
    json(res, {
      documentId: ws.session.id,
      workspaceId: ws.id,
      typeName: ws.type.name,
      schema: ws.type.schema,
      collab: collabJoin,
    });
    return true;
  }

  return false;
}

/** Voice Live: what a board's mic button needs from this process. */
async function voiceApi(path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path === "/api/voice/status") {
    const ws = resolveWorkspace(req);
    if (!ws) {
      fail(res, 404, "board not found");
      return true;
    }
    const lang = resolveLanguage(req);
    const toolset = voiceToolset(ws.session, "echo", "memory", lang);
    json(res, {
      ready: Boolean(config),
      workspaceId: ws.id,
      typeName: ws.type.name,
      language: lang,
      model: config?.model,
      voice: voiceLiveConfig(lang)?.voice,
      tools: toolset.names,
      mcp: `http://127.0.0.1:${port}/mcp/w/${ws.id}`,
    });
    return true;
  }

  if (path === "/api/voice/log") {
    streamLog(res);
    return true;
  }

  if (path === "/api/voice/offer" && req.method === "POST") {
    await handleOffer(req, res);
    return true;
  }

  if (path === "/api/voice/hangup" && req.method === "POST") {
    await handleHangup(req, res);
    return true;
  }

  return false;
}

/**
 * The browser gathers ICE, then posts its SDP offer here. We relay it to Voice
 * Live over the WebSocket control channel and hand the answer back.
 */
async function handleOffer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config) {
    fail(res, 503, "Set AZURE_VOICE_LIVE_ENDPOINT and AZURE_VOICE_LIVE_API_KEY in examples/voice-board/.env");
    return;
  }
  const payload = parseJson(await readBody(req));
  const sdpOffer = typeof payload?.sdp === "string" ? payload.sdp : undefined;
  if (!sdpOffer) {
    fail(res, 400, "sdp is required");
    return;
  }

  const explicitWorkspaceId = typeof payload?.workspaceId === "string" ? payload.workspaceId : undefined;
  const ws = resolveWorkspace(req, explicitWorkspaceId);
  if (!ws) {
    fail(res, 404, "board not found");
    return;
  }
  const lang = resolveLanguage(req, typeof payload?.language === "string" ? payload.language : undefined);
  const t = strings(lang);
  const toolset = voiceToolset(ws.session, "echo", "memory", lang);
  // The role is declared by the workspace YAML's `tools.agents`, so a board
  // type added later brings its own agent along instead of needing a branch.
  const agentRole = ws.type.tools?.agents?.[0]?.role ?? "voice-live";

  // Three layers, all in the caller's language: the app's persona, then the
  // schema-generated contract (node descriptions, guidelines, tool names),
  // whose text comes from the `es:` keys in the workspace YAML.
  const persona = t.persona[ws.type.name === "c4-architecture" ? "c4" : "voiceBoard"];

  const instructions = [
    persona,
    systemPromptText(
      ws.session.schema,
      {
        documentId: ws.id,
        actorId: "echo",
        type: ws.type,
        agentRole,
      },
      lang,
    ),
  ].join("\n\n");

  const langConfig = voiceLiveConfig(lang) ?? config;

  try {
    const { call, sdpAnswer } = await VoiceCall.start({
      config: langConfig,
      toolset,
      instructions,
      language: t.transcribeLanguage,
      sdpOffer,
      onLog: broadcast,
    });
    calls.set(call.id, call);
    json(res, { callId: call.id, sdpAnswer, voice: langConfig.voice, model: langConfig.model });
  } catch (error) {
    fail(res, 502, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Opens a board from the homepage form. The Hub does the real work — mint,
 * seed from the type's `template:` with these params, lease, register — so all
 * this adds is turning a bad type name or a bad param into a 400 rather than a
 * stack trace.
 */
async function handleCreateBoard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJson(await readBody(req));
  const typeName = typeof payload?.typeName === "string" ? payload.typeName : undefined;
  if (!typeName) {
    fail(res, 400, "typeName is required");
    return;
  }
  const name = typeof payload?.name === "string" ? payload.name : undefined;
  const params =
    payload?.params && typeof payload.params === "object"
      ? (payload.params as Record<string, unknown>)
      : {};

  try {
    const ws = await boards.create({ typeName, name, params });
    json(res, boards.summarize(ws, resolveLanguage(req)));
  } catch (error) {
    if (error instanceof UnknownBoardTypeError || error instanceof SchemaError) {
      fail(res, 400, error.message);
      return;
    }
    throw error;
  }
}

async function handleHangup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJson(await readBody(req));
  const callId = typeof payload?.callId === "string" ? payload.callId : undefined;
  const call = callId ? calls.get(callId) : undefined;
  call?.close();
  if (callId) {
    calls.delete(callId);
  }
  json(res, { closed: Boolean(call) });
}

/** Server-sent events: what the voice agent did to the graph, as it happens. */
function streamLog(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  logStreams.add(res);
  res.on("close", () => logStreams.delete(res));
}

function broadcast(entry: CallLog): void {
  const frame = `data: ${JSON.stringify(entry)}\n\n`;
  for (const stream of logStreams) {
    stream.write(frame);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
  for (const call of calls.values()) {
    call.close();
  }
  http.close();
  await vite.close();
  // `hub.close()` closes every live board, however many the homepage opened.
  // The registry records stay in Redis on purpose: they are what the next
  // replica reads to find the boards this one was serving.
  await hub.close();
  await closeCollab();
  await redis.quit?.();
};

/** Host and port only — the access key is in there and must not reach a log. */
function redisHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "redis";
  }
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
