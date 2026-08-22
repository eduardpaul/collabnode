import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { CollabSession } from "@collabnode/runtime";
import { createGraphMcpServer, type GraphMcpServerOptions } from "./server.js";

export interface GraphMcpHandlerOptions extends GraphMcpServerOptions {
  /** Extract or select a language for the incoming request. */
  languageFrom?: (req: Request) => string | undefined;
}

export function createGraphMcpHandler(
  session: CollabSession,
  options: GraphMcpHandlerOptions = {},
): McpHttpHandler {
  const resolveLanguage = (req?: Request): string | undefined => {
    if (!req) {
      return options.language;
    }
    if (options.languageFrom) {
      const fromFn = options.languageFrom(req);
      if (fromFn) {
        return fromFn;
      }
    }
    try {
      const url = new URL(req.url);
      const qLang = url.searchParams.get("lang") ?? url.searchParams.get("language");
      if (qLang) {
        return qLang;
      }
    } catch {}
    const headerLang = req.headers.get("accept-language");
    if (headerLang) {
      return headerLang;
    }
    return options.language;
  };

  return createMcpHandler((ctx) => {
    const actorId = ctx.requestInfo ? options.actorFrom?.(ctx.requestInfo) : undefined;
    const language = resolveLanguage(ctx.requestInfo);
    const bound = actorId ? session.runAs(actorId) : session;
    return createGraphMcpServer(bound, { ...options, language });
  });
}
