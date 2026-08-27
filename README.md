# collabnode

Collaborative graph runtime for Node.js **and the browser**. Describe an application graph in YAML, co-edit the **instance** through a pluggable CRDT backend, project it into a graph store, and expose a schema-driven MCP server. Describe a whole *kind* of session instead — its parameters, its starting graph, how long it lives — and the [hub](#workspace-types-and-the-hub) opens, seeds, and retires as many instances of it as you need.

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
pnpm collabnode validate packages/bench/schema.yaml
pnpm collabnode serve packages/bench/schema.yaml --backend memory
pnpm collabnode mcp packages/bench/schema.yaml --backend memory --actor agent-1
pnpm collabnode ddl packages/bench/schema.yaml --graph age --graph-name bench
```

The CLI takes a plain **schema** document — one graph, one document. A
[workspace type](#workspace-types-and-the-hub) (`type:` + `schema:` + `template:`
…) is rejected by `validate`; those are opened through the hub, not the CLI.

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
| `@collabnode/react` | React hooks: `useCollabJoin`, `useCollab`, snapshot/presence selectors |
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
| `@collabnode/hub` | `Hub`: workspace types, idempotent open, lifecycle/reaper, registry, artifacts |
| `@collabnode/redis` | Redis `WorkspaceRegistry`: leases, records, and reaping shared across replicas (`ioredis` optional peer) |
| `@collabnode/mcp` | Schema-driven MCP server |
| `@collabnode/cli` | `validate` / `ddl` / `serve` / `mcp` |
| `@collabnode/bench` | Private: hot-path metrics + users/limits ladders across Fluid/Hocuspocus × Ladybug/AGE |

## Web clients (realtime users)

Do not import `AzureClient` / SharedTree in the app. Browsers are CRDT **peers** on the same `documentId` as `init()`:

```ts
import { init, webJoinInfo, createFluidTokenHandler } from "collabnode";
import { connect } from "@collabnode/web";

// Node
const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  actorId: "api",
  // Azure: { kind: "fluid", relay: "azure", tokenEndpoint: "/api/collab/token" }
  collab: { kind: "fluid", storageDir: "data/tinylicious" }, // or { kind: "hocuspocus" }
});
// GET  /api/collab/join  → webJoinInfo(node)
// POST /api/collab/token → createFluidTokenHandler({ tenantKey, user, authorize })  // Azure only

// Browser
const join = await (await fetch("/api/collab/join")).json();
const client = await connect({
  schema: join.schema,
  documentId: join.documentId,
  actorId: currentUser.id,
  collab: join.collab,
});
client.session.onChange((_ops, snapshot) => render(snapshot));
await client.session.upsertNode({ type: "Task", properties: { title: "Draft Q3 plan" } });
```

On Azure, the tenant key is a bearer credential for the whole tenant, so it
stays on the server and the browser gets a token scoped to one document. The
join descriptor names the route (`tokenEndpoint`), and `connect()` fetches from
it — a URL is not a secret, so the browser needs no wiring of its own.

`authorize` is what makes that scoping mean something — `user()` answers *who is
asking*, never *what they may open*, and the token is minted for whatever
`documentId` the request carried:

```ts
createFluidTokenHandler({
  tenantKey: process.env.AZURE_FLUID_KEY,
  user: (request, { actorId }) => sessionUser(request) ?? guest(actorId),
  // hubDocumentAuthorizer(hub) is the floor: the document must be one this hub
  // opened. Add who may open which workspace on top of it.
  authorize: async (context) =>
    (await hubDocumentAuthorizer(hub)(context)) && mayOpen(context.user, context.documentId),
});
```

See `examples/voice-board-azure` for the whole path, relay to browser.

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

## Node identity (`identity:` / `singleton:`)

Two ways a write finds the node it means, so callers do not have to carry ids
around.

`identity: { from: [...] }` keys a type by the values of some of its properties:
an upsert with matching values updates that node instead of creating another,
and near-misses in case, accent or punctuation land on it too.

`singleton: true` is for the state a workspace *has* rather than the things it
*contains* — a status node, a settings node, a board's configuration:

```yaml
nodes:
  BoardState:
    singleton: true          # one per workspace; no identity fields to key on
    properties:
      status: { type: enum, values: [idle, planning, approved], default: idle }
      owner:  { type: string, required: true }
```

```ts
await session.upsertNode({ type: "BoardState", properties: { owner: "ada" } });
// …anywhere else, without an id, and without reading first:
await session.upsertNode({ type: "BoardState", properties: { status: "planning" } });
```

Both land on one node. Its id is derived from the schema and the type name, so
two replicas writing before either has seen the other converge on that node
rather than each minting a random id — and a node created under some other id
before the type was declared singleton is adopted instead of duplicated.

The tools follow: `upsert_node_BoardState` takes no `id` argument, its
description says there is only one, and `graph_describe` reports `singleton`.
Required properties are still enforced when the node is first created and left
alone after, so an agent can set one field without restating the rest. The two
are mutually exclusive — identity is how a type has many instances told apart,
and a singleton has none to tell apart.

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

## Workspace types and the Hub

`init()` is one document with one schema. A host that opens **many** of them — a
board per meeting, a room per incident, one per customer — describes each kind
once as a **workspace type** and lets the hub mint, seed, and retire the
instances. The type is the schema plus everything an instance needs in order to
exist on its own: the parameters it takes, the graph it starts from, when it
ends, and what survives it.

```yaml
# workspaces/retro.yaml
type: retro
version: 1
description: One team retro, from template to artifact.

schema:                        # exactly the document init() loads
  nodes:
    Item:
      identity: { from: [title] }
      properties:
        title: { type: string, required: true }
        column:
          type: enum
          values: [went-well, to-improve]
          default: went-well

params:                        # supplied per instance, at open time
  team:                        # string | number | boolean | array | object | json
    type: string
    required: true

template:                      # seeded once, on the first open of an id
  nodes:
    - type: Item
      as: opener
      properties:
        title: "{team} retro"

lifecycle:                     # how it ends with nobody saying so
  idleTimeout: 30m
  maxDuration: 4h
  # endWhen: MATCH (i:Item) RETURN count(i) >= 20

projection: memory             # none | memory | shared
retention:
  onEnd: keep                  # delete | keep | archive
  artifact: required
```

Template properties interpolate `{param}`. An entry fans out with
`forEach: members` (`{item}`, `{index}`, renameable via `itemVar` / `indexVar`)
and is skipped by a falsy `when:`; `as:` names a node so a `template.edges` entry
can point its `from` / `to` at it.

`tools:` — `expose`, `named`, and per-role `agents` — lives on the same document
and is covered under [MCP](#mcp-agents). `description`, `guidelines`, `ui.label`,
`display.title`, and param descriptions all accept a per-language map
(`en:` / `es:`) instead of a plain string.

```ts
import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";

const { backend, close } = await openCollab(
  { kind: "fluid", storageDir: "data/tinylicious" },
  "server",
);

const hub = await createHub({
  collab: backend,                 // a CollabBackend; in-memory when omitted
  onEnd: async (artifact) => archive.put(artifact.id, artifact),
});

hub.define(await loadWorkspaceTypeFile("workspaces/retro.yaml"));

const ws = await hub.open("retro", {
  id: "retro-2026-08",             // minted from the type name when omitted
  params: { team: "Payments" },    // defaults applied, wrong shape rejected
  actorId: "server",
});

await ws.upsertNode({ type: "Item", properties: { title: "Deploys got quieter" } });

// shutdown
await hub.close();   // closes every live workspace; ends none of them
close();             // stop Tinylicious, if this process spawned it
```

That is the one-backend-many-documents shape the `init()` note above tells you to
build by hand, with the lifecycle already attached.

`hub.open()` is **create-or-join on one id**, not two calls. The first caller in
claims a registry lease, seeds the template, and flips the record to `active`;
anyone arriving mid-seed waits for that and joins the same document. So a request
handler can `open()` on every hit without first asking whether the room exists.
`hub.get(id)` and `hub.list({ state, typeName })` read the registry;
`hub.getLiveWorkspace(id)` returns only what this process currently holds open.

A `Workspace` forwards the whole `CollabSession` surface — `upsertNode`, `query`,
`search`, `collabText` — and stamps the activity clock the reaper reads on every
write. It has no exported name of its own: `Workspace` from `collabnode` is the
runtime's unrelated type, so annotate with `Awaited<ReturnType<Hub["open"]>>`.

### Ending, and what survives

Four triggers, three of them automatic: `idleTimeout` (no peers **and** no writes
for that long), `maxDuration` (wall clock since open), `endWhen` (a predicate
re-evaluated on every change), and `ws.end("explicit")`. The automatic three run
in a reaper the hub starts for itself; `sweepIntervalMs: 0` turns that timer off
for a host that would rather drive `hub.sweep()` from cron. Both paths take the
same registry lease `open()` does, so two replicas cannot reap one workspace
twice.

Termination is ordered, and the order is the point: drain the projector, capture
the snapshot, capture history, build the `WorkspaceArtifact`, **await your `onEnd`
hooks**, then apply `retention.onEnd` — `delete` destroys the document, `keep` /
`archive` close it. Only then does the registry record flip to `ended`. An
`onEnd` that persists the artifact has therefore always run before the live copy
can go away.

```ts
const artifact = await ws.end("explicit");
artifact.snapshot;       // nodes + edges as they finished
artifact.history;        // only when changeTracking is on
artifact.participants;   // who was in it, human or agent, joined and left

const review = await hub.reopen(artifact);                 // read-only remount, in memory
const next = await hub.open("retro", { from: artifact });  // seed the next one from it
```

A review is genuinely read-only and detached: it reports the artifact's id so a
UI can say what it is showing, but writes are refused rather than dropped into a
copy nobody reads, and closing it touches neither the registry nor the live
workspace that may have reused that id. Use `from: artifact` to carry one
forward.

`ws.close()` is the other exit: this process leaves, the workspace stays alive
for everyone else. `hub.close()` closes every live workspace without ending any.

### Registry

`memoryRegistry()` is the default, and it is per process — fine for one host,
wrong for two. `@collabnode/redis` is the shared one:

```ts
import { redisRegistry } from "@collabnode/redis";

const hub = await createHub({
  collab: backend,
  registry: await redisRegistry({ url: process.env.REDIS_URL }),
  sweepIntervalMs: 0,   // one replica drives sweep(), not all of them
});
```

The lease becomes a `SET NX PX`, so expiry belongs to Redis rather than to a
timer in a process that may already be gone, and `collabDocId` — the mapping
from workspace id to the document a backend minted — outlives the replica that
created it. Any other store works the same way: implement `WorkspaceRegistry`
(`claim` / `heartbeat` / `release`, `get` / `put` / `delete` / `list` / `due`)
and the same leasing, the same reaper, and the same idempotent `open()` hold
across replicas.

### Projection, per type

Most short-lived workspaces are written and read through snapshots and never
issue a Cypher query, so the store is opt-in per type:

| `projection` | What answers queries | Lifetime |
| --- | --- | --- |
| `none` (default) | the CRDT snapshot; no `graph_query` | nothing to clean up |
| `memory` | a private `InMemoryGraphStore` — `graph_search`, `graph_similar`, and the `MATCH` forms that store answers | dies with the workspace |
| `shared` | the `graph` store passed to `createHub()` | one pool for all of them |

A type asking for `shared` on a hub created without a `graph` store is refused at
`open()` rather than quietly downgraded to no projection.

`GraphStore` takes a workspace scope on every call, so `shared` is one store with
a partition per workspace rather than a `workspace_id` column — caller-written
Cypher cannot escape a boundary the store never hands it. `InMemoryGraphStore`
partitions in memory, `AgeGraphStore` gives each workspace its own AGE graph, and
Ladybug is one workspace per store and refuses a second out loud. `embeddings`
passed to `createHub()` reaches every `memory` projection.

## MCP (agents)

Prompts, tools, and resources are generated from the YAML (`graph-system`, `work-on-Task`, `upsert_node_Task`, `collabnode://schema`, …). Restart / re-`init` after schema changes.

Stdio MCP is CLI-only (it owns stdin). In an API process, use `init({ mcp: true })`
and mount `handleMcp`.

### One endpoint, scoped by path

A [hub](#workspace-types-and-the-hub) serves every workspace from a single
handler, scoped by **path** rather than by a tool argument — so an agent is never
handed a workspace id it could change:

```ts
import { createHubMcpHandler } from "collabnode";   // or serveHubMcpHttp(hub, "127.0.0.1:3937")

const mcp = createHubMcpHandler(hub, {
  mount: "/mcp",                                    // → /mcp/w/:workspaceId
  autoOpenType: "retro",                            // open on first hit; 404 without it
  actorFrom: (req) => authenticate(req)?.userId,    // stamps meta.updatedBy
  agentRoleFrom: (req) => authenticate(req)?.role,  // trusted role, instead of ?role=
});

// mcp.fetch(request) → Response; mcp.close() on shutdown
```

The surface is generated per request from that workspace's type: `tools.expose`
filters it, `tools.named` adds the type's own verbs (`dictate_note`, `add_task`),
and the caller's role applies the node policy below. `?lang=` / `Accept-Language`
picks the language for tool descriptions and prompts, falling back through the
bare subtag (`es-MX` → `es`) to `en`.

```yaml
tools:
  expose:
    - *                    # every generated graph / upsert tool (the default)
  # or a narrower allowlist:
  # - graph_search
  # - graph_neighbors
  named:
    add_item:
      creates: Item
      into: IN_COLUMN
```

`*` in `expose` (and in `agents[].tools`) means every generated tool. Omit the
list for the same default. YAML aliases cannot be empty, so a bare `- *` is
quoted at parse time; `- "*"` and `expose: ["*"]` work too.

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

Open http://127.0.0.1:4175?as=ada and http://127.0.0.1:4175?as=chidi. The
homepage lists the live boards and opens new ones; the create form is generated
from the chosen type's `params:`, the board id is a slug of the name you type,
and that id is also its MCP mount (`/mcp/w/<board-id>`). Tap the mic to dictate,
or edit the markdown cards directly. **Delete** runs the hub's termination
sequence, so `retention.onEnd: keep` hands back a `WorkspaceArtifact` rather than
dropping the graph.

Two workspace types ship with it, one file each in
`examples/voice-board/workspaces/`:
- `voice-board.yaml` — Notes & Tasks
- `c4-architecture.yaml` — C4 architecture diagrams

A third is a new YAML plus one `hub.define`: its tile, its create form, its voice
tools, its MCP mount, and its starter graph all follow from the document, and
neither the server nor the client learns its name. English and Spanish come from
`en:` / `es:` keys in the same file (`?lang=es`).

`examples/voice-board-azure` is the same application on hosted infrastructure:
Azure Fluid Relay instead of Tinylicious, a Redis registry instead of the
in-process one, and per-document tokens from `/api/fluid/token` instead of no
credentials at all. It is the shortest read on what deploying this actually
takes.

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
