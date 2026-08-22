import { createServer } from "node:net";
import { parseSchemaDocument } from "@collabnode/schema";
import { Server } from "@hocuspocus/server";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HocuspocusCollabBackend } from "../src/backend.ts";
import { deleteHocuspocusDocument, stopHocuspocus } from "../src/server.ts";
import { hocuspocusUrl } from "../src/url.ts";

const schema = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

/**
 * A stand-in for the SQLite or Redis persistence any real deployment runs.
 * Without one a document evaporates when the last peer leaves, which hides the
 * question these tests exist to ask: what survives termination?
 */
function persistence(disk: Map<string, Uint8Array>) {
  return {
    async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      disk.set(documentName, Y.encodeStateAsUpdate(document));
    },
    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const stored = disk.get(documentName);
      if (stored) {
        Y.applyUpdate(document, stored);
      }
      return document;
    },
  };
}

describe("HocuspocusCollabBackend ephemeral workspaces", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await stopHocuspocus(server);
    server = undefined;
  });

  it("leaves nothing readable behind after delete, even with persistence on", async () => {
    const port = await freePort();
    const disk = new Map<string, Uint8Array>();
    server = new Server({
      port,
      address: "127.0.0.1",
      quiet: true,
      stopOnSignals: false,
      extensions: [persistence(disk)],
    });
    await server.listen();
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });

    const handle = await backend.open("retro-acme-s42", schema);
    handle.graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "payroll credentials" },
      meta: {},
    });
    await handle.close();

    expect(await backend.exists("retro-acme-s42")).toBe(true);
    await backend.delete("retro-acme-s42");
    await deleteHocuspocusDocument(server, "retro-acme-s42", (name) => {
      disk.delete(name);
    });

    // The whole point of `delete`: whoever holds the id reads back nothing.
    const snoop = await backend.open("retro-acme-s42", schema);
    expect(snoop.graph.snapshot().nodes).toHaveLength(0);
    await snoop.close();
  });

  it("commits a batch as one transaction and one subscriber notification", async () => {
    const port = await freePort();
    server = new Server({ port, address: "127.0.0.1", quiet: true, stopOnSignals: false });
    await server.listen();
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });
    const handle = await backend.open("batched", schema);

    let notifications = 0;
    handle.graph.subscribe(() => {
      notifications += 1;
    });
    handle.graph.applyBatch(
      Array.from({ length: 25 }, (_, i) => ({
        kind: "upsertNode" as const,
        id: `t${i}`,
        type: "Task",
        properties: { title: `seed ${i}` },
        meta: {},
      })),
    );

    expect(handle.graph.snapshot().nodes).toHaveLength(25);
    expect(notifications).toBe(1);
    await handle.close();
  });

  it("reports both peers of a document through awareness", async () => {
    const port = await freePort();
    server = new Server({ port, address: "127.0.0.1", quiet: true, stopOnSignals: false });
    await server.listen();
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });

    const host = await backend.open("room", schema, { actorId: "ada" });
    const agent = await backend.open("room", schema, {
      actorId: "triage-bot",
      peerKind: "agent",
    });

    const seen = await waitFor(
      () => host.presence().peers(),
      (peers) => peers.length === 2,
    );
    expect(seen.map((peer) => peer.actorId).sort()).toEqual(["ada", "triage-bot"]);
    expect(seen.find((peer) => peer.actorId === "triage-bot")?.kind).toBe("agent");
    expect(seen.find((peer) => peer.actorId === "ada")?.self).toBe(true);

    await agent.close();
    const alone = await waitFor(
      () => host.presence().peers(),
      (peers) => peers.length === 1,
    );
    expect(alone.map((peer) => peer.actorId)).toEqual(["ada"]);
    await host.close();
  });
});

async function waitFor<T>(
  read: () => T,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const start = Date.now();
  let value = read();
  while (!done(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}
