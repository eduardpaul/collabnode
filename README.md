# collabnode

Collaborative graph runtime for Node.js **and the browser**. Describe an application graph in YAML, co-edit the **instance** through a pluggable CRDT backend, project it into a graph store, and expose a schema-driven MCP server.

```
YAML schema  →  CollabBackend (memory / Fluid / Hocuspocus)  →  GraphStore (memory / Ladybug / Apache AGE)
                     ▲ writes                                 ▲ Cypher / MATCH
          browser @collabnode/web                 Node init() / agents / MCP
```

The YAML is versioned config. All peers load the same file. Fluid or Hocuspocus is the source of truth for node/edge data; Ladybug and Apache AGE are query projections.

## Use it as a library

Requires Node.js **22.12** or newer.

```bash
npm install collabnode            # Node: init(), MCP, Ladybug
npm install @collabnode/web       # browser: connect()
npm install @collabnode/graph-view # browser: <collab-graph> canvas
# optional, only if you enable these kinds:
npm install @ladybugdb/core
npm install @fluidframework/azure-client
```

```ts
import { createServer } from "node:http";
import { init, toWebRequest, writeWebResponse } from "collabnode";

const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  actorId: "api",
  collab: { kind: "memory" },       // or { kind: "fluid", storageDir: "data/tinylicious" } / { kind: "hocuspocus" }
  graph: { kind: "memory" },        // or ladybug / age
  mcp: true,                        // in-process MCP fetch handler
});

await node.session.upsertNode({
  type: "Task",
  properties: { title: "From my server", status: "doing" },
});

createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp") && node.handleMcp) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const request = toWebRequest(req, Buffer.concat(chunks));
    const response = await node.handleMcp(request);
    await writeWebResponse(res, response);
    return;
  }
  res.end("ok");
}).listen(3000);
```

`init()` starts the collab session (and optional MCP) as server-side dependencies. You do not run `pnpm collabnode` in production.

| `mcp` option | Behavior |
| --- | --- |
| `true` (default) | `node.handleMcp(Request) → Response` for your HTTP framework |
| `{ listen: "127.0.0.1:3937" }` | also binds Streamable HTTP |
| `false` | session only, no MCP |

Join an existing document with `documentId`. Inject your own backend/store with `collab: { kind: "custom", backend }` / `graph: { kind: "custom", store }`.

`init()` is a **one-document** convenience. A host with many Fluid documents (one per workspace) should open **one** backend and call `CollabSession.create` / `join` per document. Do not `init()` per workspace — each call builds its own graph store (and MCP handler unless `mcp: false`), and a naive `close()` would have stopped Tinylicious for every document.

```ts
import { openCollab, CollabSession, InMemoryGraphStore } from "collabnode";

const { backend, close } = await openCollab(
  { kind: "fluid", storageDir: "data/tinylicious" },
  "server",
);

async function openWorkspace(schema, documentId) {
  const graph = new InMemoryGraphStore();
  const opts = { schema, collab: backend, graph, actorId: "server" };
  return documentId ? CollabSession.join(documentId, opts) : CollabSession.create(opts);
}

const session = await openWorkspace(schema);
await session.close(); // does not stop Tinylicious
close();               // last openCollab/init user: stop only if this process spawned it
```

Pin `collab.storageDir` (for example `data/tinylicious`) so `documentId`s survive a process restart. If Tinylicious is already listening on the port with a known volume, `ensureTinylicious` does not spawn another child. `CollabSession.close()` never stops Tinylicious; `init().close()` / `openCollab().close()` stop it only when this process spawned it **and** no other `openCollab`/`init` users remain. Session count is not tracked: close sessions first, then `openCollab().close()`.

## CLI (optional)

For local REPL / stdio MCP hosts (Cursor, Claude Desktop):

```bash
pnpm collabnode validate examples/voice-board/workspaces/voice-board.yaml
pnpm collabnode serve examples/voice-board/workspaces/voice-board.yaml --backend memory
pnpm collabnode mcp examples/voice-board/workspaces/voice-board.yaml --backend memory --actor agent-1
pnpm collabnode ddl examples/voice-board/workspaces/voice-board.yaml --graph age --graph-name voice_board
```

`serve --backend fluid` will try Tinylicious on port 7070 (same as `init({ collab: { kind: "fluid" } })`). Spawned Tinylicious uses a temp snapshot directory unless you pin `collab.storageDir` (for example `data/tinylicious`); winston stays off unless `TINYLICIOUS_LOG_LEVEL` is set. Close leftover browser tabs after a restart — they keep asking for the previous `documentId`. Azure Fluid Relay is a provisioned Azure service — pass `relay: "azure"` / `--relay azure` with env `AZURE_FLUID_TENANT_ID`, `AZURE_FLUID_ENDPOINT`, `AZURE_FLUID_KEY`.

`serve --backend hocuspocus` (or `init({ collab: { kind: "hocuspocus" } })`) starts an in-process Hocuspocus server on port 1234. Pass `url: "wss://…"` to join an existing Hocuspocus instead of listening locally. `--port` overrides the local listen port.

## Benchmarks

Hot-path metrics (writes/s, concurrent peers, replication lag, snapshot, join) and **functional** ladders (how many concurrent users stay consistent, how large a graph still queries/joins) across CRDT × projection combinations:

```bash
pnpm build
pnpm bench                                          # memory+memory, hot path
pnpm bench -- --backend fluid --graph ladybug --scenario users --ops 40 --concurrency 8
pnpm bench -- --graph age --ops 400 --concurrency 4 --size 400
pnpm bench -- --matrix --scenario users,limits --ops 16 --concurrency 4 --size 100
pnpm bench -- --json
```

`--graph age` needs Apache AGE on `127.0.0.1:5455` (`pnpm --filter @collabnode/example-age-board compose:up`). `users` is ok when every peer’s snapshot **and** query see all writes and lag p99 stays under budget (memory 250ms, ladybug 500ms, age 1.5s, fluid/hocuspocus 3s). `limits` is ok when snapshot, query, and a joiner all see the seeded graph. `--matrix` runs memory/fluid/hocuspocus × memory/ladybug/age (skips ladybug if `@ladybugdb/core` is missing, skips age if Postgres+AGE is down).

## Packages

Host apps should depend on **`collabnode`**. Scoped packages are for advanced wiring.

| Package | Role |
| --- | --- |
| `collabnode` | **`init()`** / **`openCollab()`** + `webJoinInfo` / Fluid token handler |
| `@collabnode/web` | Browser **`connect()`**, `<collab-change-feed>` |
| `@collabnode/graph-view` | `<collab-graph>` canvas web component (bundles `vis-network`) |
| `@collabnode/schema` | YAML → `GraphSchema` + `schemaHash` |
| `@collabnode/graph` | `GraphOp`, `GraphStore`, in-memory store |
| `@collabnode/collab` | `CollabBackend` interface |
| `@collabnode/fluid` | Fluid SharedTree + Tinylicious client (process spawn is `@collabnode/fluid/node`) |
| `@collabnode/hocuspocus` | Yjs graph + Hocuspocus provider (in-process server is `@collabnode/hocuspocus/node`) |
| `@collabnode/azure` | Azure Fluid Relay transport (Node) |
| `@collabnode/ladybug` | Ladybug `GraphStore` (`@ladybugdb/core` optional peer) |
| `@collabnode/age` | Apache AGE `GraphStore` (`pg` + Postgres AGE extension) |
| `@collabnode/embeddings` | Local text embeddings for semantic search (`@huggingface/transformers` optional peer) |
| `@collabnode/runtime` | `CollabSession` |
| `@collabnode/mcp` | Schema-driven MCP server |
| `@collabnode/cli` | `validate` / `ddl` / `serve` / `mcp` |
| `@collabnode/bench` | Private: hot-path metrics + users/limits ladders across Fluid/Hocuspocus × Ladybug/AGE |

## Web clients (realtime users)

Do not import `AzureClient` / SharedTree in the app. Browsers are CRDT **peers** on the same `documentId` as `init()`:

```ts
import { init, webJoinInfo, createFluidTokenHandler } from "collabnode";
import { connect, httpTokenProvider } from "@collabnode/web";

// Node
const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  actorId: "api",
  collab: { kind: "fluid", storageDir: "data/tinylicious" }, // or azure / { kind: "hocuspocus" }
});
// GET  /api/collab/join  → webJoinInfo(node)
// POST /api/collab/token → createFluidTokenHandler({ tenantKey, user })  // Azure only

// Browser
const join = await (await fetch("/api/collab/join")).json();
const client = await connect({
  schema: join.schema,
  documentId: join.documentId,
  actorId: currentUser.id,
  collab: join.collab.relay === "azure"
    ? { ...join.collab, tokenProvider: httpTokenProvider("/api/collab/token") }
    : join.collab,
});
client.session.onChange((_ops, snapshot) => render(snapshot));
await client.session.upsertNode({ type: "Task", properties: { title: "Draft Q3 plan" } });
```

Drop-in graph UI (any schema) — same `session` as `connect()`:

```html
<script type="module">
  import { CollabGraph } from "@collabnode/graph-view";
  document.querySelector("collab-graph").session = client.session;
</script>
<collab-graph style="height: 70vh"></collab-graph>
```

`ui.label` / `ui.color` / `ui.icon` on the YAML drive labels, colors, and shapes. `editable="false"` is watch-only. Layout stays local to the tab; node/edge edits go through `CollabSession`.

Hocuspocus uses the same join payload with `collab.kind: "hocuspocus"` and a WebSocket `url`. Rooms are created on the server; browsers always **join**. Never put the Azure tenant key in Vite env.

## Collab backends

`CollabBackend` is the seam. Fluid and Hocuspocus (Yjs) both implement it; Loro can later. The web package uses that seam so UI code does not change with the CRDT vendor.

```ts
const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  collab: { kind: "hocuspocus" }, // local ws://127.0.0.1:1234
});
// or { kind: "hocuspocus", url: "wss://collab.example.com" }
```

## Live property types (`text` / `map` / `array`)

`string` is last-write-wins. `text` is a character CRDT (Y.Text on Hocuspocus, SharedString on Fluid). `map` and `array` are collaborative collections. They are ordinary node properties: same `upsert_node_*` tools, same snapshot, same projector into Ladybug/AGE.

```yaml
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
```

Typing still merges concurrently. The CRDT updates on every keystroke; the graph sink (Ladybug/AGE) **debounces** CRDT-only diffs (~250ms, flushed on `query()` / `upsert`) so a burst of typing is one `MERGE` of the latest `body`. That is last-write *state*, not a version history. `meta.updatedBy` stamps on `upsertNode`, including a body-only upsert when change tracking is on — not on each keystroke.

Apps can still bind the live type:

```ts
session.collabText(noteId, "body");
```

See `examples/voice-board`. Fluid documents created before this container schema (`graph` + `collab` SharedTrees) cannot be joined; create a new room.

## Search (`search:` / `vector:`)

`graph_search` is answered by the graph store's own indexes, not by a scan. Properties opt in per type:

```yaml
nodes:
  Note:
    identity: { from: [title] }
    properties:
      title:
        type: string
        search: { boost: 6 }   # full text; boost outranks body prose
        vector: true           # embedded
      body:
        type: text
        search: true
        vector: true
```

On Ladybug, index updates live in the write-ahead log until a checkpoint, and replaying them on the next open crashes the process — so the store checkpoints when writes settle and again on `close()`. Shut down through `close()` (the CLI and examples do, including on SIGINT); a `kill -9` inside the checkpoint window can leave a database that will not reopen.

`search:` matches **wording** — case, accents, punctuation, word order and plurals, so `Stand-Up` finds a note titled `Standup`. Ladybug serves it from its FTS extension, the in-memory store from an equivalent scan. Omit `search:` everywhere in a type and every text-ish property is indexed by default.

`vector:` matches **meaning** — "what did we decide about hiring" finds a note called *Q3 headcount* that never uses the word. Ladybug serves it from an HNSW index, the in-memory store from a cosine scan. When both are on, `graph_search` fuses the two rankings and each hit reports `match: "text" | "vector" | "both"`; `graph_similar` takes a node id instead of a query, for "more like this".

Embeddings are opt-in, because they cost a model:

```ts
const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  embeddings: { kind: "local" },   // bge-small-en-v1.5 via transformers.js
});
```

`local` needs `@huggingface/transformers` installed and runs entirely in-process; pass `{ kind: "custom", provider }` for anything else. A vector index has no notion of "no match" — asked about something the graph never mentions, it still returns its nearest neighbours — so a provider declares the similarity below which it considers two texts unrelated (`minSimilarity`, 0.5 for bge-small). The related and unrelated ranges overlap slightly, so that number errs towards silence: raise it for quieter search, lower it for wider recall. Without it, `vector:` properties are simply not embedded and search stays lexical. Apache AGE has no `search()` yet and falls back to an unranked substring scan; the tool description tells the model which of the three it is talking to.

## Change tracking (opt-in)

```yaml
config:
  changeTracking:
    enabled: true
    mode: last-write
```

Requires `actorId` on `init()`. Stamps `meta.createdBy/At` and `meta.updatedBy/At`.

## MCP (agents)

Prompts, tools, and resources are generated from the YAML (`graph-system`, `work-on-Task`, `upsert_node_Task`, `collabnode://schema`, …). Restart / re-`init` after schema changes.

Stdio MCP is CLI-only (it owns stdin). In an API process, use `init({ mcp: true })` and mount `handleMcp`, or use `@collabnode/hub` with `createHubMcpHandler` for scoped multi-workspace routing (`/mcp/w/:workspaceId`).

### Per-agent node policy

A workspace type can give each agent role a different reach over node types. Two
powers, because "may not change it" and "may not know it exists" are different
requirements:

```yaml
tools:
  agents:
    - role: facilitator          # no policy: full reach
      actorId: facilitator-bot
    - role: reviewer
      actorId: reviewer-bot
      nodes:
        readOnly: [Decision]     # see but no touch
        hidden: [PrivateNote]    # does not see, cannot learn it exists
    - role: observer
      actorId: observer-bot
      nodes:
        readOnly: ["*"]          # reads everything, writes nothing
```

`*` stands for every node type; `hidden` wins wherever the two lists overlap.
Both lists are validated against the schema at parse time, so a typo is a load
error rather than a silently open door. The role is matched by `role` or by
`actorId` — the same lookup `tools` filtering and role prompts already use.

**`readOnly`** — the type still appears in `graph_describe` (marked
`readOnly: true`), `graph_list`, `graph_search` and the rest. What goes away is
`upsert_node_<Type>`, deletes of those nodes, and any named tool that
`creates:` one. Edges count as touching their endpoints, so an edge write with a
read-only endpoint is refused too: `upsert_edge_<Type>` disappears when no
instance of it could be written, and is checked per call when only some could.

**`hidden`** — the type never reaches the role at all. It is struck from the
schema resource, the generated prompts, the tool surface, and every read result
(`graph_list`, `graph_search`, `graph_similar`, `graph_snapshot`,
`graph_neighbors`, `graph_get`, `graph_history`, `graph_changes`,
`collabnode://snapshot`), along with edges that touch a hidden node. Ids of
hidden nodes answer `unknown id`, exactly as ids that never existed do, and a
unique-prefix or identity lookup cannot prove otherwise. A role with hidden types
gets no `graph_query`: Cypher runs against the projection, which cannot be scoped
to one role's view, and a filtered result set is no defence against an aggregate.

Policy applies to the MCP surface — the tools, prompts, and resources an agent is
given. It is not a substitute for transport auth: a caller that can reach the
document directly through `CollabSession` is not bound by it. On the hub
endpoint the role defaults to the caller-supplied `?role=`, which is fine for
steering a cooperative agent but not for confining an untrusted one — pass
`agentRoleFrom` to `createHubMcpHandler` to derive the role from your own auth.

## Example: Voice Board (Voice Live + WebRTC + Multi-Workspace)

Dictate notes, track tasks, and collaborate in real-time by voice (Azure Voice Live over WebRTC) and live text:

```bash
pnpm --filter @collabnode/example-voice-board start
```

Open http://127.0.0.1:4175?as=ada and http://127.0.0.1:4175?as=chidi. Tap the mic to dictate or edit markdown cards directly.

Supports multiple workspace types:
- `examples/voice-board/workspaces/voice-board.yaml` (Notes & Tasks)
- `examples/voice-board/workspaces/c4-architecture.yaml` (C4 Architecture diagrams)

## Publishing

Public packages live under `packages/` (`collabnode` and `@collabnode/*`). Examples and `@collabnode/bench` are private.

```bash
pnpm build
pnpm test
pnpm publish:check    # npm pack --dry-run for each public package
# first time: npm login, and create the @collabnode org on npm
pnpm -r --filter "./packages/**" publish --access public
```

`workspace:*` dependencies are rewritten to real versions on publish. Fluid rooms created before the `graph` + `collab` container schema cannot be joined; create a new room.

## License

MIT. See `LICENSE`.
