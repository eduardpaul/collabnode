import { InMemoryCollabBackend } from "@collabnode/collab";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { CollabSession, snapshotToMarkdown } from "../src/index.ts";

const schemaYaml = `
name: BatchSchema
version: 1
config:
  schemaId: batch-schema
  idStrategy: uuid
nodes:
  Epic:
    properties:
      title: { type: string, required: true }
      priority: { type: string, default: "medium" }
  Feature:
    properties:
      title: { type: string, required: true }
edges:
  HAS_FEATURE:
    from: [Epic]
    to: [Feature]
`;

describe("CollabSession batch & snapshotToMarkdown", () => {
  it("executes multi-node and edge mutations via session.batch() fluent builder", async () => {
    const schema = parseSchemaDocument(schemaYaml);
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, { schema, collab });

    const result = await session.batch((b) => {
      b.upsertNode({ type: "Epic", properties: { title: "Authentication", priority: "high" } }, "epic-auth");
      b.upsertNode({ type: "Feature", properties: { title: "OIDC Login" } }, "feat-oidc");
      b.upsertNode({ type: "Feature", properties: { title: "MFA" } }, "feat-mfa");
      b.upsertEdge({
        type: "HAS_FEATURE",
        from: { ref: "epic-auth" },
        to: { ref: "feat-oidc" },
      });
      b.upsertEdge({
        type: "HAS_FEATURE",
        from: { ref: "epic-auth" },
        to: { ref: "feat-mfa" },
      });
    });

    expect(result.applied).toBe(5);
    expect(result.ids.length).toBe(5);
    expect(result.refs["epic-auth"]).toBeDefined();
    expect(result.refs["feat-oidc"]).toBeDefined();

    const snapshot = session.snapshot();
    expect(snapshot.nodes.length).toBe(3);
    expect(snapshot.edges.length).toBe(2);

    // Test snapshotToMarkdown
    const md = snapshotToMarkdown(snapshot);
    expect(md).toContain("### Epic (1)");
    expect(md).toContain("### Feature (2)");
    expect(md).toContain("### Relationships (2)");
    expect(md).toContain("Authentication");
    expect(md).toContain("OIDC Login");
  });

  it("supports session.applyBatch() directly", async () => {
    const schema = parseSchemaDocument(schemaYaml);
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, { schema, collab });

    const result = await session.applyBatch([
      { op: "upsertNode", type: "Epic", properties: { title: "Billing" }, ref: "epic-billing" },
      { op: "upsertNode", type: "Feature", properties: { title: "Stripe" }, ref: "feat-stripe" },
      { op: "upsertEdge", type: "HAS_FEATURE", from: { ref: "epic-billing" }, to: { ref: "feat-stripe" } },
    ]);

    expect(result.applied).toBe(3);
    const snap = session.snapshot();
    expect(snap.nodes.length).toBe(2);
    expect(snap.edges.length).toBe(1);
  });
});
