import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { createHub } from "../src/index.ts";

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
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
params:
  sprint: { type: number, required: true }
  members: { type: array, of: string }
template:
  nodes:
    - type: Column
      as: went_well
      properties: { title: "Went well" }
    - forEach: members
      as: "member_{item}"
      type: Column
      properties: { title: "Notes for {item}" }
projection: memory
retention:
  onEnd: keep
`;

describe("Hub", () => {
  it("opens workspace idempotently under concurrency", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    // Two concurrent opens for the same id
    const [ws1, ws2] = await Promise.all([
      hub.open("retro", {
        id: "retro-concurrent-42",
        params: { sprint: 42, members: ["Ada", "Bob"] },
        actorId: "client-1",
      }),
      hub.open("retro", {
        id: "retro-concurrent-42",
        params: { sprint: 42, members: ["Ada", "Bob"] },
        actorId: "client-2",
      }),
    ]);

    expect(ws1.id).toBe("retro-concurrent-42");
    expect(ws2.id).toBe("retro-concurrent-42");

    // Template was seeded exactly once
    expect(ws1.snapshot().nodes).toHaveLength(3); // 1 went_well + 2 member columns
    expect(ws2.snapshot().nodes).toHaveLength(3);

    // MCP URL is scoped
    expect(ws1.mcpUrl).toBe("/mcp/w/retro-concurrent-42");

    await hub.close();
  });

  it("seeds from artifact snapshot (loop closure: output -> template)", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    // Run first workspace and terminate it to produce an artifact
    const wsOriginal = await hub.open("retro", {
      id: "retro-original",
      params: { sprint: 1, members: ["Ada"] },
    });
    await wsOriginal.upsertNode({
      type: "Item",
      properties: { body: "Shipped initial prototype" },
    });
    const artifact = await wsOriginal.end("explicit");

    expect(artifact.snapshot.nodes).toHaveLength(3); // 2 columns + 1 item

    // Now open a new workspace seeded from the artifact
    const wsForked = await hub.open("retro", {
      id: "retro-forked-from-artifact",
      from: artifact,
      params: { sprint: 2, members: ["Ada"] },
    });

    expect(wsForked.snapshot().nodes).toHaveLength(3);
    const itemNode = wsForked.snapshot().nodes.find((n) => n.type === "Item");
    expect(itemNode?.properties.body).toBe("Shipped initial prototype");

    await wsForked.end();
    await hub.close();
  });

  it("reopens artifact read-only for review without persistent document", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-for-review",
      params: { sprint: 10, members: ["Grace"] },
    });
    const artifact = await ws.end("explicit");

    // Reopen for review
    const reviewWs = await hub.reopen(artifact, { actorId: "auditor" });
    expect(reviewWs.id).toBe("retro-for-review");
    expect(reviewWs.snapshot().nodes).toHaveLength(2);

    await reviewWs.close();
    await hub.close();
  });
});
