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

  it("refuses writes to a review, which would land in a copy nobody reads", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const ws = await hub.open("retro", { id: "retro-readonly", params: { sprint: 3, members: [] } });
    const artifact = await ws.end("explicit");

    const review = await hub.reopen(artifact, { actorId: "auditor" });
    await expect(
      review.upsertNode({ type: "Item", properties: { body: "afterthought" } }),
    ).rejects.toThrow(/read-only review/);
    await expect(review.end("explicit")).rejects.toThrow(/read-only review/);
    expect(review.snapshot().nodes).toHaveLength(1);

    await review.close();
    await hub.close();
  });

  it("keeps a review detached from the live workspace that reused its id", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    // A workspace ends with retention: keep, then the id is opened again.
    const first = await hub.open("retro", { id: "retro-shared-id", params: { sprint: 1, members: [] } });
    const artifact = await first.end("explicit");
    const live = await hub.open("retro", { id: "retro-shared-id", params: { sprint: 2, members: [] } });

    // Reviewing the old artifact must not evict or end the live workspace.
    const review = await hub.reopen(artifact, { actorId: "auditor" });
    await review.close();

    expect(hub.getLiveWorkspace("retro-shared-id")).toBe(live);
    expect((await hub.registry.get("retro-shared-id"))?.state).toBe("active");

    await hub.close();
  });

  it("refuses projection: shared on a hub with no graph store", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(
      parseWorkspaceTypeDocument(RETRO_TYPE_YAML.replace("projection: memory", "projection: shared")),
    );

    await expect(hub.open("retro", { id: "retro-shared", params: { sprint: 1, members: [] } })).rejects.toThrow(
      /projection: shared.*without a `graph` store/s,
    );

    await hub.close();
  });
});
