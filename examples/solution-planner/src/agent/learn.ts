import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  StreamableHttpMcpClient,
  stringifyMcpToolResult,
  type FetchFn,
  type McpToolDef,
} from "./mcp-http.ts";

const DEFAULT_LEARN_MCP = "https://learn.microsoft.com/api/mcp";
const DEFAULT_TOKEN_BUDGET = "2000";

export interface LoadedMcpTools {
  tools: StructuredToolInterface[];
  instructions: string;
  serverName: string;
  close: () => Promise<void>;
}

function emptyTools(): LoadedMcpTools {
  return { tools: [], instructions: "", serverName: "", close: async () => {} };
}

function learnMcpEnabled(): boolean {
  const flag = process.env.MICROSOFT_LEARN_MCP?.trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

export function microsoftLearnMcpUrl(): string {
  const raw = process.env.MICROSOFT_LEARN_MCP_URL?.trim() || DEFAULT_LEARN_MCP;
  const url = new URL(raw);
  if (!url.searchParams.has("maxTokenBudget")) {
    url.searchParams.set("maxTokenBudget", DEFAULT_TOKEN_BUDGET);
  }
  return url.toString();
}

const OPAQUE_ARGS = z.object({}).passthrough();

function wrapMcpTool(client: StreamableHttpMcpClient, def: McpToolDef): StructuredToolInterface {
  const advertised = def.inputSchema;
  const schema =
    advertised && typeof advertised === "object" && advertised.type === "object"
      ? (advertised as Record<string, unknown>)
      : OPAQUE_ARGS;
  return tool(
    async (args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const result = await client.callTool(def.name, record);
      return stringifyMcpToolResult(result);
    },
    {
      name: def.name,
      description: def.description || def.name,
      schema: schema as never,
    },
  );
}

export async function loadMicrosoftLearnTools(options?: {
  url?: string;
  fetchFn?: FetchFn;
}): Promise<LoadedMcpTools> {
  if (!learnMcpEnabled()) {
    return emptyTools();
  }

  const client = new StreamableHttpMcpClient({
    url: options?.url ?? microsoftLearnMcpUrl(),
    clientName: "solution-planner-architect",
    clientVersion: "0.1.0",
    fetchFn: options?.fetchFn,
  });

  try {
    const init = await client.initialize();
    const defs = await client.listTools();
    return {
      tools: defs.map((def) => wrapMcpTool(client, def)),
      instructions: init.instructions?.trim() ?? "",
      serverName: init.serverInfo?.name ?? "Microsoft Learn MCP Server",
      close: () => client.close(),
    };
  } catch (err) {
    console.warn("Microsoft Learn MCP unavailable, architect will plan without docs:", err);
    await client.close().catch(() => {});
    return emptyTools();
  }
}

let sharedTools: Promise<LoadedMcpTools> | undefined;

export function sharedMicrosoftLearnTools(): Promise<LoadedMcpTools> {
  sharedTools ??= loadMicrosoftLearnTools().then((loaded) => {
    if (loaded.tools.length === 0) {
      sharedTools = undefined;
    }
    return loaded;
  });
  return sharedTools;
}
