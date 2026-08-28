import { tool, type StructuredToolInterface } from "@langchain/core/tools";
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
  return {
    tools: [],
    instructions: "",
    serverName: "",
    close: async () => {},
  };
}

function learnMcpEnabled(): boolean {
  const flag = process.env.MICROSOFT_LEARN_MCP?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return true;
}

export function microsoftLearnMcpUrl(): string {
  const raw = process.env.MICROSOFT_LEARN_MCP_URL?.trim() || DEFAULT_LEARN_MCP;
  const url = new URL(raw);
  if (!url.searchParams.has("maxTokenBudget")) {
    url.searchParams.set("maxTokenBudget", DEFAULT_TOKEN_BUDGET);
  }
  return url.toString();
}

import { z } from "zod";

/** Last-resort shape when a server advertises a tool with no input schema. */
const OPAQUE_ARGS = z.object({}).passthrough();

function wrapMcpTool(client: StreamableHttpMcpClient, def: McpToolDef): StructuredToolInterface {
  // The server's own `inputSchema` is the contract. Hardcoding shapes here
  // would send the wrong parameters to every tool but the ones we guessed.
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

/**
 * Connect to Microsoft Learn MCP and expose its tools as LangChain tools.
 * Failures return an empty set so planning still runs without docs.
 */
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
    const tools = defs.map((def) => wrapMcpTool(client, def));
    return {
      tools,
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

/**
 * Process-wide Learn MCP connection. The Streamable HTTP client is stateless
 * between calls, so one `initialize` serves every architect turn — reconnecting
 * per turn cost two round-trips and left a session open on every early return.
 * A failed connect is not cached, so a later turn retries.
 */
export function sharedMicrosoftLearnTools(): Promise<LoadedMcpTools> {
  sharedTools ??= loadMicrosoftLearnTools().then((loaded) => {
    if (loaded.tools.length === 0) {
      sharedTools = undefined;
    }
    return loaded;
  });
  return sharedTools;
}
