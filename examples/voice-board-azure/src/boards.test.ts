import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub, loadWorkspaceTypeFile } from "collabnode";
import { BoardDirectory, UnknownBoardTypeError } from "./boards.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const hub = await createHub({ sweepIntervalMs: 0 });
hub.define(await loadWorkspaceTypeFile(join(root, "workspaces/voice-board.yaml")));
hub.define(await loadWorkspaceTypeFile(join(root, "workspaces/c4-architecture.yaml")));

const boards = new BoardDirectory(hub, { mcpBase: "/mcp" });

// The homepage's type tiles come from the YAML, including the create form's fields.
const types = boards.types("en");
assert.equal(types.length, 2);

const c4Type = types.find((type) => type.typeName === "c4-architecture");
assert.ok(c4Type);
assert.equal(c4Type.title, "C4 Architecture Model");
assert.ok(c4Type.description.length > 0);
assert.deepEqual(
  c4Type.params.map((param) => param.name).sort(),
  ["primaryUser", "systemDescription", "systemName", "userRole"],
);
assert.equal(c4Type.params.find((param) => param.name === "systemName")?.default, "My Software System");

// Spanish is a query parameter, not a second code path.
assert.equal(boards.types("es").find((type) => type.typeName === "c4-architecture")?.title, "Modelo de Arquitectura C4");

// Creating a board seeds it from the type template with the params supplied.
const c4 = await boards.create({
  typeName: "c4-architecture",
  name: "Payments Platform",
  params: { systemName: "Payments", primaryUser: "Merchant" },
});
assert.equal(c4.id, "c4-architecture-payments-platform");
assert.equal(c4.type.name, "c4-architecture");

const c4Snapshot = c4.session.snapshot();
assert.equal(c4Snapshot.nodes.length, 2); // Person + SoftwareSystem
assert.equal(c4Snapshot.nodes.find((n) => n.type === "SoftwareSystem")?.properties.name, "Payments");
assert.equal(c4Snapshot.nodes.find((n) => n.type === "Person")?.properties.name, "Merchant");
// Params the form left alone still come through, because `validateParams`
// applies the YAML defaults.
assert.equal(c4.params.userRole, "Uses the system to perform business workflows");

// A second board of the same type is a separate graph, on a separate id.
const voice = await boards.create({ typeName: "voice-board", name: "Ada's Board", params: { author: "Ada" } });
assert.equal(voice.id, "voice-board-ada-s-board");
assert.equal(voice.session.snapshot().nodes.length, 6);

// Same name twice: the id gets a counter rather than colliding onto the first board.
const dup = await boards.create({ typeName: "c4-architecture", name: "Payments Platform" });
assert.equal(dup.id, "c4-architecture-payments-platform-2");
assert.notEqual(dup.session.id, c4.session.id);

// A name that slugs to nothing still produces a usable id.
const emoji = await boards.create({ typeName: "voice-board", name: "🎙️🎙️" });
assert.equal(emoji.id, "voice-board");

// An unknown type is a 400 on the wire, not a crash.
await assert.rejects(
  () => boards.create({ typeName: "kanban", name: "Nope" }),
  UnknownBoardTypeError,
);

// The gallery lists every live board, oldest first, with live counts.
const listed = await boards.list("en");
assert.deepEqual(listed.map((board) => board.id), [
  "c4-architecture-payments-platform",
  "voice-board-ada-s-board",
  "c4-architecture-payments-platform-2",
  "voice-board",
]);

const paymentsCard = listed[0];
assert.equal(paymentsCard?.name, "Payments Platform");
assert.equal(paymentsCard?.typeTitle, "C4 Architecture Model");
assert.equal(paymentsCard?.emoji, "🏗️");
assert.equal(paymentsCard?.nodes, 2);
assert.equal(paymentsCard?.edges, 1);
assert.equal(paymentsCard?.mcp, "/mcp/w/c4-architecture-payments-platform");

// Counts are read live, not frozen at creation.
await c4.session.upsertNode({
  type: "Container",
  properties: { name: "Ledger API", description: "Double-entry ledger", technology: "Go" },
});
assert.equal((await boards.list("en"))[0]?.nodes, 3);

// A board opened outside the directory (the two the server seeds at boot) still lists.
const adopted = boards.adopt(
  await hub.open("voice-board", { id: "voice-board-1", actorId: "server", params: { author: "Ada" } }),
  "Seeded Board",
);
assert.equal((await boards.list("en")).find((board) => board.id === adopted.id)?.name, "Seeded Board");

// Deleting frees the id and drops the board from the gallery.
assert.equal(await boards.remove("c4-architecture-payments-platform-2"), true);
assert.equal(await boards.remove("c4-architecture-payments-platform-2"), false);
assert.equal(boards.get("c4-architecture-payments-platform-2"), undefined);
assert.ok(!(await boards.list("en")).some((board) => board.id === "c4-architecture-payments-platform-2"));

const reused = await boards.create({ typeName: "c4-architecture", name: "Payments Platform" });
assert.equal(reused.id, "c4-architecture-payments-platform-2");

await hub.close();

console.log("boards.test.ts ok: boards are created, listed, and deleted from the homepage directory");
