import { AzureChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import {
  parseMcpSseOrJson,
  stringifyMcpToolResult,
  StreamableHttpMcpClient,
  unwrapJsonRpc,
} from "./agent/mcp-http.ts";
import { loadMicrosoftLearnTools, microsoftLearnMcpUrl } from "./agent/microsoft-learn.ts";
import { invokeStructured, toBindableTools } from "@collabnode/deepagents";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function testSseParser() {
  console.log("▶ MCP SSE / JSON parser");

  const sse = `event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"microsoft_docs_search"}]}}

`;
  const fromSse = parseMcpSseOrJson(sse) as { tools: Array<{ name: string }> };
  assert(fromSse.tools[0]?.name === "microsoft_docs_search", "SSE result tools not parsed");

  const json = parseMcpSseOrJson(
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }),
  ) as { ok: boolean };
  assert(json.ok === true, "raw JSON-RPC result not unwrapped");

  try {
    unwrapJsonRpc({ error: { message: "boom", code: -32000 } });
    throw new Error("expected JSON-RPC error to throw");
  } catch (err) {
    assert(err instanceof Error && err.message === "boom", "JSON-RPC error message mismatch");
  }

  const text = stringifyMcpToolResult({
    content: [{ type: "text", text: "docs chunk" }],
  });
  assert(text === "docs chunk", `expected docs chunk, got ${text}`);
  console.log("✓ SSE/JSON parser");
}

async function testMcpHttpClient() {
  console.log("▶ Streamable HTTP MCP client (mock transport)");
  const calls: Array<{ url: string; body: { method?: string }; headers: Record<string, string> }> = [];

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as {
      method?: string;
      id?: number;
    };
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, body, headers });

    if (body.method === "initialize") {
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            instructions: "Search then fetch.",
            serverInfo: { name: "Microsoft Learn MCP Server", version: "1.0.0" },
          },
        })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "sess-1",
          },
        },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: { "mcp-session-id": "sess-1" } });
    }
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "microsoft_docs_search",
                description: "Search official Microsoft docs",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } },
      );
    }
    if (body.method === "tools/call") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "Azure Container Apps auth uses /.auth/" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  const client = new StreamableHttpMcpClient({
    url: "https://learn.microsoft.com/api/mcp",
    fetchFn,
  });
  const init = await client.initialize();
  assert(init.instructions === "Search then fetch.", "initialize instructions missing");
  const tools = await client.listTools();
  assert(tools.length === 1 && tools[0]?.name === "microsoft_docs_search", "tools/list mismatch");
  const result = stringifyMcpToolResult(
    await client.callTool("microsoft_docs_search", { query: "Container Apps auth" }),
  );
  assert(result.includes("/.auth/"), `tool result missing excerpt: ${result}`);

  const listCall = calls.find((c) => c.body.method === "tools/list");
  assert(listCall?.headers["mcp-session-id"] === "sess-1", "session id not sent after initialize");
  console.log("✓ MCP client session + tools/call");
}

async function testLearnToolWrapper() {
  console.log("▶ Microsoft Learn tools wrap as LangChain tools");
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as {
      method?: string;
      id?: number;
    };
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { instructions: "Use search first.", serverInfo: { name: "Learn" } },
        }),
        { status: 200, headers: { "mcp-session-id": "s" } },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "microsoft_docs_search",
                description: "search",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (body.method === "tools/call") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "found" }] },
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 500 });
  };

  const loaded = await loadMicrosoftLearnTools({
    url: "https://learn.microsoft.com/api/mcp",
    fetchFn,
  });
  assert(loaded.tools.length === 1, "expected one wrapped tool");
  assert(loaded.tools[0]?.name === "microsoft_docs_search", "wrapped tool name");
  const out = await loaded.tools[0]!.invoke({ query: "aks" });
  assert(out === "found", `wrapped invoke got ${out}`);

  const azure = new AzureChatOpenAI({
    azureOpenAIApiKey: "test",
    azureOpenAIEndpoint: "https://example.openai.azure.com",
    azureOpenAIApiDeploymentName: "gpt",
    azureOpenAIApiVersion: "2024-08-01-preview",
  });
  azure.bindTools(loaded.tools);
  azure.bindTools(toBindableTools(loaded.tools));

  await loaded.close();
  console.log("✓ Learn MCP tools wrap");
}

async function testInvokeStructuredIsSingleShot() {
  console.log("▶ invokeStructured is one shot — no bindTools");

  const planSchema = z.object({
    title: z.string(),
    grounded: z.boolean(),
  });

  let bound = false;
  let schemaSent: unknown;
  const model = {
    bindTools() {
      bound = true;
      return { invoke: async () => ({}) };
    },
    withStructuredOutput(schema: unknown) {
      schemaSent = schema;
      return {
        invoke: async () => ({ title: "C4 Container Diagram", grounded: true }),
      };
    },
  };

  const parsed = await invokeStructured(
    model as never,
    planSchema,
    "Design auth for a Container Apps API.",
    "architect_plan",
    { system: "You are the architect." },
  );

  assert(!bound, "invokeStructured must not bind tools");
  assert(
    schemaSent !== undefined && typeof schemaSent === "object" && !("_zod" in (schemaSent as object)),
    "provider must receive JSON Schema, not Zod internals",
  );
  assert(parsed.title === "C4 Container Diagram" && parsed.grounded === true, "structured plan mismatch");
  console.log("✓ Structured output is a single shot");
}

async function testLearnUrlBudget() {
  const previous = process.env.MICROSOFT_LEARN_MCP_URL;
  delete process.env.MICROSOFT_LEARN_MCP_URL;
  const url = new URL(microsoftLearnMcpUrl());
  assert(url.searchParams.get("maxTokenBudget") === "2000", "default token budget missing");
  process.env.MICROSOFT_LEARN_MCP_URL = previous;
  console.log("✓ Learn MCP URL includes maxTokenBudget");
}

async function run() {
  console.log("▶ Testing Learn MCP wiring + single-shot structured output...");
  await testSseParser();
  await testMcpHttpClient();
  await testLearnToolWrapper();
  await testInvokeStructuredIsSingleShot();
  await testLearnUrlBudget();
  console.log("🎉 Architect MCP + structured-output tests passed");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
