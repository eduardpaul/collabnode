import { InMemoryCollabBackend } from "@collabnode/collab";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  CollabSession,
  bindGraphTools,
  diffSnapshotsToMarkdown,
} from "../src/index.ts";

const schemaYaml = `
name: AgentToolsSchema
version: 1
config:
  schemaId: agent-tools
  idStrategy: uuid
  changeTracking:
    enabled: true
    mode: last-write
nodes:
  Feature:
    description: "Software feature"
    properties:
      title: { type: string, required: true }
      status: { type: enum, values: [todo, doing, done], default: todo }
  Bug:
    description: "Software defect"
    properties:
      title: { type: string, required: true }
      severity: { type: string, default: "medium" }
edges:
  BLOCKS:
    from: [Bug]
    to: [Feature]
`;

describe("Agent Diffing & Bound Graph Tools", () => {
  it("computes readable diffs between snapshots using session.diffSince()", async () => {
    const schema = parseSchemaDocument(schemaYaml);
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, { schema, collab });

    const initialSnapshot = session.snapshot();

    // Turn 1: Add a feature
    const featId = await session.upsertNode(
      { type: "Feature", properties: { title: "Realtime Sync", status: "todo" } },
      { actorId: "ai-manager" },
    );

    const diff1 = session.diffSince(initialSnapshot);
    expect(diff1.hasChanges).toBe(true);
    expect(diff1.ops.length).toBe(1);
    expect(diff1.markdown).toContain("Added Nodes (1)");
    expect(diff1.markdown).toContain("Realtime Sync");

    const snapshotAfterTurn1 = session.snapshot();

    // Turn 2: Architect updates status and adds a blocking bug
    await session.upsertNode(
      { type: "Feature", properties: { title: "Realtime Sync", status: "doing" }, id: featId },
      { actorId: "ai-architect" },
    );
    const bugId = await session.upsertNode(
      { type: "Bug", properties: { title: "Memory Leak", severity: "high" } },
      { actorId: "ai-architect" },
    );
    await session.upsertEdge(
      { type: "BLOCKS", from: bugId, to: featId },
      { actorId: "ai-architect" },
    );

    const diff2 = session.diffSince(snapshotAfterTurn1);
    expect(diff2.hasChanges).toBe(true);
    expect(diff2.markdown).toContain("Modified Nodes (1)");
    expect(diff2.markdown).toContain('status: "todo" → "doing"');
    expect(diff2.markdown).toContain("Added Nodes (1)");
    expect(diff2.markdown).toContain("Memory Leak");
    expect(diff2.markdown).toContain("Added Relationships (1)");
    expect(diff2.markdown).toContain("BLOCKS");
  });

  it("bindGraphTools includes graphApplyBatch and graphDiffSince", async () => {
    const schema = parseSchemaDocument(schemaYaml);
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, {
      schema,
      collab,
      actorId: "test-actor",
    });

    const tools = bindGraphTools(session);

    const snap0 = session.snapshot();

    const batchRes = await tools.graphApplyBatch({
      ops: [
        { op: "upsertNode", type: "Feature", properties: { title: "Auth" }, ref: "f1" },
        { op: "upsertNode", type: "Bug", properties: { title: "JWT Expired" }, ref: "b1" },
        { op: "upsertEdge", type: "BLOCKS", from: { ref: "b1" }, to: { ref: "f1" } },
      ],
    });

    expect(batchRes.applied).toBe(3);

    const diff = tools.graphDiffSince({ previousSnapshot: snap0 });
    expect(diff.hasChanges).toBe(true);
    expect(diff.ops.length).toBe(3);
    expect(diff.markdown).toContain("Auth");
    expect(diff.markdown).toContain("JWT Expired");
  });
});
