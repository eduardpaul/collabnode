import { createHub } from "@collabnode/hub";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  buildTools,
  createHubMcpHandler,
  generatePrompts,
  serveHubMcpHttp,
  systemPromptText,
} from "../src/index.ts";

const RETRO_TYPE_YAML = `
type: retro
version: 1
schema:
  nodes:
    Column:
      properties:
        title: { type: string, required: true }
    Item:
      properties:
        body: { type: string, required: true }
        votes: { type: number, default: 0 }
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
params:
  sprint: { type: number, required: true }
template:
  nodes:
    - type: Column
      as: went_well
      properties: { title: "Went well" }
tools:
  expose:
    - graph_search
    - graph_neighbors
    - graph_describe
  named:
    add_item:
      description: "Add a retro item directly into a column"
      creates: Item
      into: IN_COLUMN
  agents:
    - role: facilitator
      actorId: bot-facilitator
      description: "Facilitator agent that groups and summarizes feedback"
      systemPrompt: "You are the retro facilitator. Guide the team through reflections."
      tools:
        - add_item
        - graph_search
`;

async function parseJsonRpcResponse(res: Response): Promise<any> {

  const text = await res.text();
  if (text.startsWith("event:") || text.includes("data:")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine) {
      return JSON.parse(dataLine.slice(5).trim());
    }
  }
  return JSON.parse(text);
}

describe("MCP Hub Endpoint, Policy & Named Tools", () => {


  it("enforces tool policy expose filtering and generates named tools", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-mcp-1",
      params: { sprint: 1 },
      actorId: "ada",
    });

    const tools = buildTools(ws.session.schema, ws.session, {
      policy: ws.type.tools,
    });
    const toolNames = tools.map((t) => t.name);

    // Generic tools filtered by expose list
    expect(toolNames).toContain("graph_search");
    expect(toolNames).toContain("graph_neighbors");
    expect(toolNames).toContain("graph_describe");
    expect(toolNames).not.toContain("graph_query");
    expect(toolNames).not.toContain("graph_delete_node");

    // Named tool generated
    expect(toolNames).toContain("add_item");
    const addItemTool = tools.find((t) => t.name === "add_item")!;
    expect(addItemTool.description).toBe("Add a retro item directly into a column");

    // Find the went_well column
    const column = ws.snapshot().nodes.find((n) => n.type === "Column")!;
    expect(column).toBeDefined();

    // Call add_item named tool: creates Item node AND links via IN_COLUMN edge
    const result = await addItemTool.handler({
      body: "CI pipeline is faster",
      votes: 3,
      into: column.id,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      created: boolean;
      id: string;
      edgeId: string;
      type: string;
      into: string;
    };
    expect(payload.created).toBe(true);
    expect(payload.type).toBe("Item");
    expect(payload.into).toBe("IN_COLUMN");
    expect(payload.edgeId).toBeDefined();

    // Verify snapshot contains both node and edge
    const snap = ws.snapshot();
    expect(snap.nodes).toHaveLength(2); // 1 column + 1 item
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]?.type).toBe("IN_COLUMN");
    expect(snap.edges[0]?.from).toBe(payload.id);
    expect(snap.edges[0]?.to).toBe(column.id);

    await hub.close();
  });

  it("exposes every generated tool when expose is *", async () => {
    const allType = parseWorkspaceTypeDocument(`
type: retro
version: 1
schema:
  nodes:
    Column:
      properties:
        title: { type: string, required: true }
    Item:
      properties:
        body: { type: string, required: true }
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
tools:
  expose:
    - *
  advanced: [graph_query]
  named:
    add_item:
      description: "Add a retro item directly into a column"
      creates: Item
      into: IN_COLUMN
  agents:
    - role: facilitator
      actorId: bot-facilitator
      tools:
        - *
`);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(allType);

    const ws = await hub.open("retro", {
      id: "retro-mcp-all",
      params: {},
      actorId: "ada",
    });

    const tools = buildTools(ws.session.schema, ws.session, {
      policy: ws.type.tools,
    });
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("graph_search");
    expect(toolNames).toContain("graph_query");
    // `expose: *` means every *generated* tool, and the advanced ones are not
    // generated unless named: this fixture asked for graph_query and not the
    // other three, so the wildcard must not smuggle them back in.
    expect(toolNames).not.toContain("graph_snapshot");
    expect(toolNames).not.toContain("graph_diff_since");
    expect(toolNames).not.toContain("graph_apply_batch");
    expect(toolNames).toContain("graph_delete_node");
    expect(toolNames).toContain("upsert_node_Column");
    expect(toolNames).toContain("upsert_node_Item");
    expect(toolNames).toContain("upsert_edge_IN_COLUMN");
    expect(toolNames).toContain("add_item");

    const facilitatorTools = buildTools(ws.session.schema, ws.session, {
      policy: ws.type.tools,
      agentRole: "facilitator",
    });
    expect(facilitatorTools.map((t) => t.name)).toEqual(toolNames);

    await hub.close();
  });

  it("scopes tools and prompts for specific agent roles", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-mcp-agent",
      params: { sprint: 1 },
      actorId: "ada",
    });

    // Scoped tools for facilitator role
    const facilitatorTools = buildTools(ws.session.schema, ws.session, {
      policy: ws.type.tools,
      agentRole: "facilitator",
    });
    const toolNames = facilitatorTools.map((t) => t.name);
    expect(toolNames).toEqual(["graph_search", "add_item"]);

    // Scoped system prompt and prompts
    const sysPrompt = systemPromptText(ws.session.schema, {
      documentId: ws.id,
      type: ws.type,
      agentRole: "facilitator",
    });
    expect(sysPrompt).toContain("## Role: facilitator");
    expect(sysPrompt).toContain("You are the retro facilitator.");

    const prompts = generatePrompts(ws.session.schema, {

      documentId: ws.id,
      type: ws.type,
    });
    expect(prompts.map((p) => p.name)).toContain("agent-facilitator");

    await hub.close();
  });

  it("handles path-scoped requests at /mcp/w/:workspaceId without workspace tool argument", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    await hub.open("retro", {
      id: "retro-scoped-42",
      params: { sprint: 42 },
      actorId: "ada",
    });

    const handler = createHubMcpHandler(hub, {
      actorFrom: (req, wsId) => `actor-for-${wsId}`,
    });

    // 1. Valid workspace path JSON-RPC initialize request
    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    };

    const req = new Request("http://127.0.0.1/mcp/w/retro-scoped-42", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });

    const res = await handler.fetch(req);

    expect(res.status).toBe(200);
    const resBody = await parseJsonRpcResponse(res);
    expect(resBody.result.serverInfo.name).toBe("collabnode-retro");

    // 2. Request for non-existent workspace returns 404
    const notFoundReq = new Request("http://127.0.0.1/mcp/w/unknown-workspace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });
    const notFoundRes = await handler.fetch(notFoundReq);
    expect(notFoundRes.status).toBe(404);

    // 3. Request for invalid path returns 404
    const invalidPathReq = new Request("http://127.0.0.1/mcp/invalid", {
      method: "POST",
      headers: { "Accept": "application/json, text/event-stream" },
    });
    const invalidRes = await handler.fetch(invalidPathReq);
    expect(invalidRes.status).toBe(404);

    await hub.close();
  });

  it("serves a whole session, not just initialize", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", { id: "retro-session", params: { sprint: 7 } });
    const column = ws.snapshot().nodes.find((n) => n.type === "Column")!;

    const handler = createHubMcpHandler(hub);
    const post = (payload: unknown): Promise<Response> =>
      handler.fetch(
        new Request("http://127.0.0.1/mcp/w/retro-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
          },
          body: JSON.stringify(payload),
        }),
      );

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    });
    expect(init.status).toBe(200);

    // The regression this test exists for: the second request used to land on a
    // transport that had never seen an initialize, and answered
    // `Server not initialized` to every method a client actually calls.
    const listed = await parseJsonRpcResponse(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(listed.error).toBeUndefined();
    const toolNames = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("graph_search");
    expect(toolNames).toContain("add_item");

    const called = await parseJsonRpcResponse(
      await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "add_item",
          arguments: { body: "Deploys are still manual", into: column.id },
        },
      }),
    );
    expect(called.error).toBeUndefined();
    expect(called.result.isError).toBeFalsy();

    // The call reached the workspace this path names, not a copy of it.
    const snap = ws.snapshot();
    expect(snap.nodes.filter((n) => n.type === "Item")).toHaveLength(1);
    expect(snap.edges).toHaveLength(1);

    const prompts = await parseJsonRpcResponse(await post({ jsonrpc: "2.0", id: 4, method: "prompts/list" }));
    expect(prompts.error).toBeUndefined();
    expect(prompts.result.prompts.map((p: { name: string }) => p.name)).toContain("agent-facilitator");

    await handler.close();
    await hub.close();
  });

  it("serves live Hub MCP over HTTP with serveHubMcpHttp", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    await hub.open("retro", {
      id: "retro-live-http",
      params: { sprint: 100 },
    });

    const server = await serveHubMcpHttp(hub, "127.0.0.1:0");

    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-live-client", version: "1.0" },
      },
    };

    const res = await fetch(`${server.url}/w/retro-live-http`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });

    expect(res.status).toBe(200);
    const body = await parseJsonRpcResponse(res);
    expect(body.result.serverInfo.name).toBe("collabnode-retro");


    await server.close();
    await hub.close();
  });
});
