import type { Workspace } from "@collabnode/hub";
import type { CollabSession } from "@collabnode/runtime";
import { resolveNodeAccess, type WorkspaceType } from "@collabnode/schema";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { getLocale, type SupportedLanguage } from "./i18n.js";
import { generatePrompts } from "./prompts.js";
import { generateResources } from "./resources.js";
import { registerSessionTools } from "./tools.js";

export interface GraphMcpServerOptions {
  graphKind?: string;
  /** Per-request actor override. Requires changeTracking.enabled; used by createGraphMcpHandler. */
  actorFrom?: (req: Request) => string | undefined;
  /** Language for prompts, tool descriptions, and resource descriptions (e.g. 'en', 'es'). */
  language?: SupportedLanguage | string;
}

export interface WorkspaceMcpServerOptions extends GraphMcpServerOptions {
  agentRole?: string;
}

export function createGraphMcpServer(
  session: CollabSession,
  options: GraphMcpServerOptions = {},
): McpServer {
  const schema = session.schema;
  const defaultLanguage = options.language;
  const t = getLocale(defaultLanguage);

  const server = new McpServer({
    name: `collabnode-${schema.config.schemaId}`,
    version: String(schema.version),
  });

  const promptArgsSchema = z.object({
    language: z
      .string()
      .optional()
      .describe(t.prompts.promptArgsDescription),
  });

  for (const prompt of generatePrompts(schema, {
    documentId: session.id,
    actorId: session.actorId,
    language: defaultLanguage,
  })) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: promptArgsSchema,
      },
      (args: { language?: string }) => {
        const callerLang = args?.language ?? defaultLanguage;
        let text = prompt.text;
        if (args?.language) {
          const callerPrompts = generatePrompts(schema, {
            documentId: session.id,
            actorId: session.actorId,
            language: callerLang,
          });
          const matched = callerPrompts.find((p) => p.name === prompt.name);
          if (matched) {
            text = matched.text;
          }
        }
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text },
            },
          ],
        };
      },
    );
  }

  registerSessionTools(schema, session, server, {
    graphKind: options.graphKind ?? "memory",
    language: defaultLanguage,
  });

  for (const resource of generateResources(schema, session, { language: defaultLanguage })) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: resource.mimeType,
            text: await resource.read(),
          },
        ],
      }),
    );
  }

  return server;
}

export function createWorkspaceMcpServer(
  workspace:
    | Workspace
    | { session: CollabSession; type?: WorkspaceType; id?: string },
  options: WorkspaceMcpServerOptions = {},
): McpServer {
  const session = "session" in workspace ? workspace.session : (workspace as unknown as CollabSession);
  const type = "type" in workspace ? workspace.type : undefined;
  const schema = type?.schema ?? session.schema;
  const id =
    "id" in workspace && typeof workspace.id === "string"
      ? workspace.id
      : session.id;
  const defaultLanguage = options.language;
  const t = getLocale(defaultLanguage);

  const server = new McpServer({
    name: `collabnode-${type ? type.name : schema.config.schemaId}`,
    version: type ? String(type.version) : String(schema.version),
  });

  const promptArgsSchema = z.object({
    language: z
      .string()
      .optional()
      .describe(t.prompts.promptArgsDescription),
  });

  for (const prompt of generatePrompts(schema, {
    documentId: id,
    actorId: session.actorId,
    type,
    agentRole: options.agentRole,
    language: defaultLanguage,
  })) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: promptArgsSchema,
      },
      (args: { language?: string }) => {
        const callerLang = args?.language ?? defaultLanguage;
        let text = prompt.text;
        if (args?.language) {
          const callerPrompts = generatePrompts(schema, {
            documentId: id,
            actorId: session.actorId,
            type,
            agentRole: options.agentRole,
            language: callerLang,
          });
          const matched = callerPrompts.find((p) => p.name === prompt.name);
          if (matched) {
            text = matched.text;
          }
        }
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text },
            },
          ],
        };
      },
    );
  }

  const access = resolveNodeAccess(schema, type?.tools, options.agentRole);

  registerSessionTools(schema, session, server, {
    graphKind: options.graphKind ?? "memory",
    policy: type?.tools,
    agentRole: options.agentRole,
    language: defaultLanguage,
    access,
  });

  for (const resource of generateResources(schema, session, {
    language: defaultLanguage,
    access,
  })) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: resource.mimeType,
            text: await resource.read(),
          },
        ],
      }),
    );
  }

  return server;
}
