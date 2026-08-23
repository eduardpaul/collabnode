import { createServer, type Server as HttpServer } from "node:http";
import type { Hub, Workspace } from "@collabnode/hub";
import type { CollabSession } from "@collabnode/runtime";
import type { WorkspaceType } from "@collabnode/schema";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { readBody, toWebRequest, writeWebResponse } from "./http.js";
import type { SupportedLanguage } from "./i18n.js";
import { createWorkspaceMcpServer } from "./server.js";

export interface HubMcpHandlerOptions {
  /** Base mount path, defaults to "/mcp". Routes requests to `${mount}/w/:workspaceId`. */
  mount?: string;
  /** Underlying graph backend kind for query description hint (e.g. "ladybug", "age", "memory"). */
  graphKind?: string;
  /** Extract or authenticate an actorId for the incoming request and workspace. */
  actorFrom?: (req: Request, workspaceId: string) => string | undefined;
  /** Extract or select an agent role for the incoming request and workspace. */
  agentRoleFrom?: (req: Request, workspaceId: string) => string | undefined;
  /** Default workspace type to auto-open if workspace does not exist in registry yet. */
  autoOpenType?: string;
  /** Custom default parameters when auto-opening a workspace. */
  defaultParams?: Record<string, unknown>;
  /** Default language for prompts, tool descriptions, and resources (e.g. 'en', 'es'). */
  language?: SupportedLanguage | string;
  /** Extract or select a language for the incoming request and workspace. */
  languageFrom?: (req: Request, workspaceId: string) => string | undefined;
}

/** What `createWorkspaceMcpServer` accepts: a live workspace, or a session bound to an actor. */
type McpTarget =
  | Workspace
  | { session: CollabSession; type?: WorkspaceType; id?: string };

interface ResolvedRequest {
  target: McpTarget;
  agentRole: string | undefined;
  language: string | undefined;
}

/**
 * Creates a Web Standard MCP handler that routes requests scoped by path:
 * `/mcp/w/:workspaceId` (or `${mount}/w/:workspaceId`).
 *
 * Scopes MCP tool surfaces per-workspace entirely at the transport and auth
 * layer, so the AI agent context never receives workspace IDs as arguments
 * (§11.1).
 *
 * Serving is `createMcpHandler` — the same entry the single-document handler
 * uses — rather than a hand-rolled transport. That is what makes a session work
 * past `initialize`: the SDK owns instance lifetime and era routing, so a 2025
 * client's follow-up requests are answered by the stateless fallback instead of
 * landing on a transport that has never seen an `initialize`.
 */
export function createHubMcpHandler(
  hub: Hub,
  options: HubMcpHandlerOptions = {},
): McpHttpHandler {
  const mount = (options.mount ?? "/mcp").replace(/\/+$/, "");
  const pattern = new RegExp(`^${mount}/w/([^/]+)(?:/(.*))?$`);

  /**
   * Resolution is done in `fetch`, because an unknown workspace has to become a
   * 404 before any server is constructed, and handed to the factory here.
   * Keyed weakly on the request so nothing outlives the exchange, with a
   * re-resolve as the fallback: the SDK is free to hand the factory a clone of
   * the request rather than the object `fetch` was given.
   */
  const inFlight = new WeakMap<Request, ResolvedRequest>();

  const resolve = async (req: Request): Promise<ResolvedRequest | undefined> => {
    const url = new URL(req.url);
    const workspaceId = url.pathname.match(pattern)?.[1];
    if (!workspaceId) {
      return undefined;
    }
    const ws = await openWorkspace(hub, workspaceId, options);
    if (!ws) {
      return undefined;
    }

    const actorId = options.actorFrom?.(req, workspaceId);
    const agentRole =
      options.agentRoleFrom?.(req, workspaceId) ??
      url.searchParams.get("role") ??
      undefined;
    const language =
      options.languageFrom?.(req, workspaceId) ??
      url.searchParams.get("lang") ??
      url.searchParams.get("language") ??
      req.headers.get("accept-language") ??
      options.language;

    const target: McpTarget =
      actorId && ws.session.schema.config.changeTracking.enabled
        ? { session: ws.session.runAs(actorId), type: ws.type, id: ws.id }
        : ws;

    return { target, agentRole, language };
  };

  const inner = createMcpHandler(async (ctx) => {
    const req = ctx.requestInfo;
    if (!req) {
      throw new Error(
        "createHubMcpHandler serves HTTP only: the workspace is taken from the request path, and there is no path without a request.",
      );
    }
    const entry = inFlight.get(req) ?? (await resolve(req));
    if (!entry) {
      // `fetch` already refused unknown workspaces, so reaching here means the
      // workspace ended between that check and this construction.
      throw new Error(`Workspace for '${new URL(req.url).pathname}' is no longer available`);
    }
    return createWorkspaceMcpServer(entry.target, {
      graphKind: options.graphKind,
      agentRole: entry.agentRole,
      language: entry.language,
    });
  });

  const fetch: McpHttpHandler["fetch"] = async (req, requestOptions) => {
    const url = new URL(req.url);
    const match = url.pathname.match(pattern);
    if (!match) {
      return new Response(
        `Not found: MCP hub endpoint expects path like ${mount}/w/:workspaceId`,
        { status: 404 },
      );
    }

    const entry = await resolve(req);
    if (!entry) {
      return new Response(
        `Workspace '${match[1]}' not found. Open it first or configure autoOpenType.`,
        { status: 404 },
      );
    }
    inFlight.set(req, entry);

    return requestOptions === undefined
      ? inner.fetch(req)
      : inner.fetch(req, requestOptions);
  };

  return {
    fetch,
    close: () => inner.close(),
    notify: inner.notify,
    bus: inner.bus,
  };
}

/** The live workspace for `workspaceId`, joining or auto-opening as configured. */
async function openWorkspace(
  hub: Hub,
  workspaceId: string,
  options: HubMcpHandlerOptions,
): Promise<Workspace | undefined> {
  const live = hub.getLiveWorkspace(workspaceId);
  if (live) {
    return live;
  }
  const record = await hub.registry.get(workspaceId);
  if (record && (record.state === "active" || record.state === "seeding")) {
    return hub.open(record.typeName, { id: workspaceId, params: record.params });
  }
  if (options.autoOpenType) {
    return hub.open(options.autoOpenType, {
      id: workspaceId,
      params: options.defaultParams,
    });
  }
  return undefined;
}

/**
 * Serves the multi-workspace Hub MCP HTTP endpoint on a given host/port.
 */
export async function serveHubMcpHttp(
  hub: Hub,
  listen: string,
  options: HubMcpHandlerOptions = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const [host, portRaw] = listen.includes(":") ? listen.split(":") : ["127.0.0.1", listen];
  const port = Number(portRaw);
  const handler = createHubMcpHandler(hub, options);

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const request = toWebRequest(req, body);
        const response = await handler.fetch(request);
        await writeWebResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.on("error", reject);
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const mount = (options.mount ?? "/mcp").replace(/\/+$/, "");
  return {
    url: `http://${host}:${actualPort}${mount}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await handler.close();
    },
  };
}
