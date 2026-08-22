import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { createHub, type WorkspaceArtifact } from "../src/index.ts";

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
    - type: Item
      as: item_1
      properties: { body: "Shipped v1", votes: 0 }
  edges:
    - type: IN_COLUMN
      from: item_1
      to: went_well
lifecycle:
  idleTimeout: 50ms
  maxDuration: 200ms
  endWhen: "MATCH (i:Item) WHERE i.votes = 0 RETURN count(i) = 0"
projection: memory
retention:
  onEnd: delete
  artifact: required
`;

describe("Workspace Lifecycle & Termination Ordering", () => {
  it("terminates explicitly via ws.end() following strict §6.5 ordering", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    let hookArtifact: WorkspaceArtifact | undefined;

    const hub = await createHub({
      sweepIntervalMs: 0, // manual sweep
      onEnd: (art) => {
        hookArtifact = art;
      },
    });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-explicit-1",
      params: { sprint: 1 },
      actorId: "ada",
    });

    expect(ws.state).toBe("active");
    expect(ws.snapshot().nodes).toHaveLength(2);

    const artifact = await ws.end("explicit");

    expect(artifact.id).toBe("retro-explicit-1");
    expect(artifact.type).toBe("retro");
    expect(artifact.version).toBe(1);
    expect(artifact.endedBy).toBe("explicit");
    expect(artifact.params).toEqual({ sprint: 1 });
    expect(artifact.snapshot.nodes).toHaveLength(2);
    expect(artifact.participants.map((p) => p.actorId)).toContain("ada");

    // Verified onEnd hook was executed
    expect(hookArtifact).toBeDefined();
    expect(hookArtifact?.id).toBe("retro-explicit-1");

    // Retention policy 'delete' destroyed the document
    expect(ws.state).toBe("ended");
    await hub.close();
  });

  it("reaps workspace on idleTimeout when no peers and no writes exist", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-idle-1",
      params: { sprint: 1 },
      actorId: "client-1",
    });

    // While client-1 is connected, presence prevents idle reap even after 70ms
    await new Promise((r) => setTimeout(r, 70));
    expect(await hub.sweep()).toHaveLength(0);

    // Client disconnects
    await ws.close();

    // Immediately sweeping should not reap yet (idle window starts from last activity/leave)
    expect(await hub.sweep()).toHaveLength(0);

    // Wait for idleTimeout (50ms)
    await new Promise((r) => setTimeout(r, 70));

    const swept = await hub.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.id).toBe("retro-idle-1");
    expect(swept[0]?.endedBy).toBe("idle");

    await hub.close();
  });



  it("reaps workspace on maxDuration cap", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-duration-1",
      params: { sprint: 1 },
      actorId: "peer-connected", // presence is connected
    });

    // Wait for maxDuration (200ms)
    await new Promise((r) => setTimeout(r, 220));

    const swept = await hub.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.id).toBe("retro-duration-1");
    expect(swept[0]?.endedBy).toBe("duration");

    await hub.close();
  });

  it("triggers predicate termination when endWhen query is satisfied", async () => {
    const retroType = parseWorkspaceTypeDocument(RETRO_TYPE_YAML);
    let endedArtifact: WorkspaceArtifact | undefined;

    const hub = await createHub({
      sweepIntervalMs: 0,
      onEnd: (art) => {
        endedArtifact = art;
      },
    });
    hub.define(retroType);

    const ws = await hub.open("retro", {
      id: "retro-predicate-1",
      params: { sprint: 1 },
      actorId: "ada",
    });

    expect(ws.state).toBe("active");

    // Update item_1 votes to 1 so that `count(i WHERE votes = 0) = 0` becomes true!
    const itemNode = ws.snapshot().nodes.find((n) => n.type === "Item");
    expect(itemNode).toBeDefined();

    await ws.upsertNode({
      id: itemNode!.id,
      type: "Item",
      properties: { body: "Shipped v1", votes: 1 },
    });

    // Wait a brief tick for async predicate evaluation
    await new Promise((r) => setTimeout(r, 60));

    expect(endedArtifact).toBeDefined();
    expect(endedArtifact?.id).toBe("retro-predicate-1");
    expect(endedArtifact?.endedBy).toBe("predicate");
    expect(ws.state).toBe("ended");

    await hub.close();
  });
});
