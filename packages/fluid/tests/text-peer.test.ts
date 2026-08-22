import { createServer } from "node:net";
import { parseSchemaDocument } from "@collabnode/schema";
import { afterEach, describe, expect, it } from "vitest";
import { FluidCollabBackend } from "../src/backend.ts";
import { ensureTinylicious, releaseTinylicious } from "../src/node.ts";

const notes = parseSchemaDocument(`
name: Notes
version: 1
config:
  schemaId: notes-fluid-peer
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for Fluid text replication");
}

describe("Fluid text peers", () => {
  let port: number | undefined;

  afterEach(async () => {
    if (port !== undefined) {
      await releaseTinylicious(port);
      port = undefined;
    }
  });

  it("lets a peer bind and read body without ensureCollab", async () => {
    port = await freePort();
    await ensureTinylicious(port);
    const backend = new FluidCollabBackend({ port });
    const a = await backend.open(undefined, notes);
    const b = await backend.open(a.id, notes);
    b.graph.subscribe(() => {});
    a.graph.apply({
      kind: "upsertNode",
      id: "n1",
      type: "Note",
      properties: { title: "Log" },
      meta: {},
    });
    await a.graph.ensureCollab("n1", "Note");
    a.graph.collabText("n1", "body").insert(0, "hello");
    await waitFor(() => b.graph.snapshot().nodes.some((node) => node.id === "n1"));
    expect(() => b.graph.collabText("n1", "body")).not.toThrow();
    await waitFor(() => b.graph.collabText("n1", "body").toString() === "hello");
    expect(b.graph.snapshot().nodes[0]?.properties.body).toBe("hello");
    await a.close();
    await b.close();
  }, 30_000);
});
