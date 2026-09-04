import { LoroCollabBackend } from "@collabnode/loro";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { createHub } from "../src/index.ts";

const RETRO_TYPE_YAML = `
type: retro
version: 1
schema:
  config:
    schemaId: retro
    changeTracking:
      enabled: true
      mode: history
  nodes:
    Item:
      properties:
        body: { type: string, required: true }
        votes: { type: number, default: 0 }
params:
  sprint: { type: number, required: true }
retention:
  onEnd: keep
`;

function retroHub(options: { artifactExport?: "snapshot" | "shallow" } = {}) {
  const hub = createHub({
    collab: new LoroCollabBackend(),
    sweepIntervalMs: 0,
    ...(options.artifactExport ? { artifactExport: options.artifactExport } : {}),
  });
  return hub;
}

describe("versioned artifacts", () => {
  it("carries the document and its version out of a finished workspace", async () => {
    const hub = await retroHub();
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const ws = await hub.open("retro", { id: "r1", params: { sprint: 1 }, actorId: "ada" });
    await ws.upsertNode({ type: "Item", properties: { body: "Shipped v1" } });
    await ws.upsertNode({ type: "Item", properties: { body: "Deploys got quieter" } });

    const artifact = await ws.end("explicit");
    expect(artifact.snapshot.nodes).toHaveLength(2);
    expect(artifact.documentVersion?.kind).toBe("loro");
    expect(artifact.bytes).toBeInstanceOf(Uint8Array);
    expect(artifact.history).toHaveLength(2);
    await hub.close();
  });

  it("reopens as a checkout, with the history and the past the workspace had", async () => {
    const hub = await retroHub();
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const ws = await hub.open("retro", { id: "r2", params: { sprint: 1 }, actorId: "ada" });
    await ws.upsertNode({ id: "i1", type: "Item", properties: { body: "First" } });
    const afterFirst = ws.session.version();
    await ws.upsertNode({ id: "i2", type: "Item", properties: { body: "Second" } });
    const artifact = await ws.end("explicit");

    const review = await hub.reopen(artifact);
    expect(review.session.snapshot().nodes).toHaveLength(2);
    // A re-seeded review would report none of this: the ops that made the
    // workspace are the artifact's, not a replay's.
    expect(review.session.history()).toHaveLength(2);
    expect(review.session.version()).toBeDefined();

    review.session.checkout(afterFirst);
    expect(review.session.snapshot().nodes.map((n) => n.id)).toEqual(["i1"]);
    await review.close();
    await hub.close();
  });

  it("mounts an artifact already rewound with `at`", async () => {
    const hub = await retroHub();
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const ws = await hub.open("retro", { id: "r3", params: { sprint: 1 }, actorId: "ada" });
    await ws.upsertNode({ id: "i1", type: "Item", properties: { body: "First" } });
    const afterFirst = ws.session.version()!;
    await ws.upsertNode({ id: "i2", type: "Item", properties: { body: "Second" } });
    const artifact = await ws.end("explicit");

    const review = await hub.reopen(artifact, { at: afterFirst });
    expect(review.session.snapshot().nodes.map((n) => n.id)).toEqual(["i1"]);
    await review.close();
    await hub.close();
  });

  it("refuses `at` on an artifact from a backend without versions", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const ws = await hub.open("retro", { id: "r4", params: { sprint: 1 }, actorId: "ada" });
    await ws.upsertNode({ type: "Item", properties: { body: "First" } });
    const artifact = await ws.end("explicit");
    expect(artifact.bytes).toBeUndefined();
    expect(artifact.documentVersion).toBeUndefined();

    await expect(
      hub.reopen(artifact, { at: { kind: "loro", encoded: "AAAA" } }),
    ).rejects.toThrow(/carries no document bytes/);

    // Reopening without `at` still works, as a re-seed.
    const review = await hub.reopen(artifact);
    expect(review.session.snapshot().nodes).toHaveLength(1);
    await review.close();
    await hub.close();
  });

  it("carries a finished workspace into the next one", async () => {
    const hub = await retroHub();
    hub.define(parseWorkspaceTypeDocument(RETRO_TYPE_YAML));

    const first = await hub.open("retro", { id: "r5", params: { sprint: 1 }, actorId: "ada" });
    await first.upsertNode({ type: "Item", properties: { body: "Carry me" } });
    const artifact = await first.end("explicit");

    const next = await hub.open("retro", { id: "r6", params: { sprint: 2 }, from: artifact });
    expect(next.session.snapshot().nodes.map((n) => n.properties.body)).toEqual(["Carry me"]);
    await hub.close();
  });
});
