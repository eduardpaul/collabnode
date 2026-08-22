import { createServer, type Server as HttpServer } from "node:http";
import type { Hub, Workspace } from "@collabnode/hub";
import type { CollabSession } from "@collabnode/runtime";
import type { WorkspaceType } from "@collabnode/schema";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
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

/**
 * Creates a Web Standard HTTP request handler that routes MCP requests scoped by path:
 * `/mcp/w/:workspaceId` (or `${mount}/w/:workspaceId`).
 *
 * Scopes MCP tool surfaces per-workspace entirely at the transport and auth layer,
 * so the AI agent context never receives workspace IDs as arguments (§11.1).
 */
export function createHubMcpHandler(
  hub: Hub,
  options: HubMcpHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const mount = (options.mount ?? "/mcp").replace(/\/+$/, "");
  const pattern = new RegExp(`^${mount}/w/([^/]+)(?:/(.*))?$`);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = url.pathname.match(pattern);
    if (!match) {
      return new Response(
        `Not found: MCP hub endpoint expects path like ${mount}/w/:workspaceId`,
        { status: 404 },
      );
    }

    const workspaceId = match[1]!;
    let ws: Workspace | undefined = hub.getLiveWorkspace(workspaceId);
    if (!ws) {
      const record = await hub.registry.get(workspaceId);
      if (record && (record.state === "active" || record.state === "seeding")) {
        ws = await hub.open(record.typeName, {
          id: workspaceId,
          params: record.params,
        });
      } else if (options.autoOpenType) {
        ws = await hub.open(options.autoOpenType, {
          id: workspaceId,
          params: options.defaultParams,
        });
      } else {
        return new Response(
          `Workspace '${workspaceId}' not found. Open it first or configure autoOpenType.`,
          { status: 404 },
        );
      }
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

    let target:
      | Workspace
      | { session: CollabSession; type?: WorkspaceType; id?: string } = ws;

    if (actorId && ws.session.schema.config.changeTracking.enabled) {
      const boundSession = ws.session.runAs(actorId);
      target = {
        session: boundSession,
        type: ws.type,
        id: ws.id,
      };
    }

    const server = createWorkspaceMcpServer(target, {
      graphKind: options.graphKind,
      agentRole,
      language,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
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
        const response = await handler(request);
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
    },
  };
}
