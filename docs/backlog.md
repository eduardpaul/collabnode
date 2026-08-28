# Projection and embedding backlog

Status: backlog, nothing started
Date: 2026-08-24
Scope: how many projections, snapshots, and embeddings this framework builds,
and how that count moves when many users and agents work on the same workspace.
Everything below is an implementation gap; the CRDT-as-truth / store-as-projection
split is not in question.

Source: a structural read of the tree at `e483387`, following the path a second
peer takes from `Hub.open` through `CollabSession.connect`, `Projector.start`,
and into each `GraphStore`.

Companion to [`production-readiness-backlog.md`](./production-readiness-backlog.md).
Where an item here refines one there, it says so rather than restating it.

## 1. The sharing boundary, as built

`Hub.liveWorkspaces` (`packages/hub/src/hub.ts:98-101`) is the whole of it: one
entry per workspace id, per process. Everything downstream — the Fluid
container, the `Projector` and its retained snapshot, the `GraphStore`, the
embedding cache — hangs off that one `CollabSession`. There is no sharing above
it and none below it.

With R replicas, B live boards, U browser tabs, A agents, and N nodes per board:

| Resource | Count | Where |
|---|---|---|
| Fluid container (server) | R × B | `packages/fluid/src/backend.ts:179-226` — no container cache |
| `Projector` + retained snapshot (server) | R × B | `packages/runtime/src/session.ts:630` |
| `InMemoryGraphStore` (server, `projection: memory`) | R × B | `packages/hub/src/hub.ts:326-329` |
| Embedding vectors (server) | R × B × N | `packages/graph/src/memory.ts:63` |
| Embedding *model* | R | one provider per process, shared across boards |
| Per MCP agent | **0 extra** | `runAs()` shares handle, store, and projector |
| Per browser tab | 1 container + 1 projector + 1 full store | `packages/web/src/connect.ts:24-25` |

Two things follow. Agents on one replica genuinely do share one projection and
one embedding set — `runAs` (`packages/runtime/src/session.ts:711-730`) is the
part of this design that works as intended. Browser tabs share nothing, and
nothing at all crosses the replica boundary: Redis carries registry records,
never projections or vectors.

## 2. Priorities

P1 blocks a second replica, a shared projection, or more than a handful of tabs.
P2 is scale and operability work a small deployment survives without.

| # | Item | Priority | Kind | Rough size |
|---|---|---|---|---|
| 3.1 | `applySchema` wipes the partition, and every join calls it | P1 | Correctness | S |
| 3.2 | Concurrent joins race and leak a whole session | P1 | Correctness | S |
| 3.3 | Every browser tab builds a full projection it rarely uses | P1 | Scale | S |
| 3.4 | Browser search has no semantic path and no server route | P1 | Capability / scale | M |
| 4.1 | Embedding cache is process-local, so cold start re-embeds everything | P2 | Scale / cost | M |
| 4.2 | The projector debounce does not protect the expensive part | P2 | Scale | M |
| 4.3 | Join is O(N) sequential awaits | P2 | Latency | S |
| 4.4 | Fluid reports `presence: false` and the Workspace swallows it | P2 | Operability | M |
| 4.5 | `projection: shared` accepts a store that cannot partition | P2 | UX | S |

---

## 3. P1 — blocks shared projections and multi-tab use

### 3.1 `applySchema` wipes the partition, and every join calls it

`packages/runtime/src/projector.ts:52-58`, `packages/graph/src/memory.ts:86-96`

`Projector.start()` calls `store.applySchema(scope, schema)` and then re-projects
the entire snapshot. `InMemoryGraphStore.applySchema` is a reset —
`partitions.set(scopeKey(scope), emptyPartition(schema))` — so with
`projection: shared`, a second session joining an already-live workspace **erases
that workspace's projection and every cached vector**, then re-embeds all N nodes
from scratch.

The re-embed is the cheap half of the problem. The first session's
`Projector.previous` still holds the pre-wipe snapshot, so its next diff emits
only deltas into a store that just lost everything. The shared projection stays
permanently incomplete — `graph_query` and `search` answer from a partial graph —
until every node happens to be edited again. Nothing reports this.

Invisible today only because every workspace type in `examples/` declares
`projection: memory`, where the store is freshly constructed per session anyway.

- Make `applySchema` idempotent: create the partition when absent, and reconcile
  rather than replace when the schema hash is unchanged.
- Reset only on an actual schema change, and treat that as the migration it is.
- The same reasoning applies to any store reached by more than one projector; the
  memory store is just where it is provable.

Done when two sessions opening one `projection: shared` workspace in sequence
leave the projection equal to what one session produces, asserted on node count
and on vector count.

### 3.2 Concurrent joins race and leak a whole session

`packages/hub/src/hub.ts:98-113`, `:284-313`

`open()` coordinates *seeding* through a registry lease, and coordinates
*joining* not at all. Two calls arriving together for a workspace this replica
has not yet opened both miss the `liveWorkspaces` check at `:98`, both find an
`active` registry record, and both run `joinActiveWorkspace` — which ends with
`this.liveWorkspaces.set(id, ws)` at `:311`, overwriting the other without
closing it.

The loser is orphaned and unreachable: still subscribed to the CRDT, still
projecting, still holding a Fluid container and a full embedding set, and never
reaped, because the reaper works from registry records and `getLiveWorkspace`.
It survives until the process does.

Trivially reachable. `openWorkspace()` in
`packages/mcp/src/hub-handler.ts:153-176` runs per MCP request, so two agents
connecting to the same board at the same moment on a cold replica is enough.
Every subsequent write is then projected twice on this replica, which is the
in-process form of §4.2 in the production-readiness backlog.

- Hold an in-flight `Map<string, Promise<Workspace>>` in `open()`, populated
  before the first `await` and cleared in a `finally`. Both callers then await
  one promise and get one workspace.
- Guard the assignment as well: if `liveWorkspaces` already holds an entry when
  `joinActiveWorkspace` finishes, close the new session and return the existing
  one rather than overwriting.

Done when N concurrent `hub.open()` calls for one id produce one `Workspace`,
one container, and one projector, asserted by identity and by a leak check on
close.

### 3.3 Every browser tab builds a full projection it rarely uses

`packages/web/src/connect.ts:24-25`, `packages/web/src/options.ts:40`

`WebGraphKind` is `{ kind: "memory" } | { kind: "custom" }`. There is no `none`,
though the server's `GraphKind` has one and documents it as the right choice for
a workspace that is never queried. So `connect()` always constructs an
`InMemoryGraphStore`, and every tab keeps a second full copy of the graph plus a
per-change diff to maintain it.

Most UIs in this repo read `session.snapshot()` and never call `search` or
`query` — `graph-view`, `change-feed`, and the React hook all read the snapshot
handed to `onChange`. The projection is pure overhead for them, and it scales
with tabs rather than with users doing anything.

- Add `{ kind: "none" }` to `WebGraphKind` and pass `graph: undefined` through to
  `CollabSession.open`, which already supports the omitted store.
- Consider making it the default for browsers and requiring `memory` to be asked
  for, since the browser store gets no embeddings provider
  (`connect()` never passes one) and so answers lexically only.

Done when a tab opened with `graph: { kind: "none" }` serves the graph-view and
change-feed unchanged, and `session.projected` is false.

### 3.4 Browser search has no semantic path and no server route

`packages/web/src/connect.ts:24-25`, `packages/graph/src/memory.ts:186-258`

The natural objection to §3.3 is that a browser user may well want to search or
query the graph live, so the tab's store is earning its keep. It is not, and the
reason decides where each kind of query belongs.

`InMemoryGraphStore.search` is a linear scan, not an index — deliberately, and
the comment at `:191-200` says so. `searchVector` is the same, brute force over
every stored vector. So the tab duplicates the whole graph in order to scan it,
while already holding that graph as `session.snapshot()`. The store buys the
browser no lookup speed at all; it buys a second copy and a diff to maintain it.

Split by query kind, the answers differ:

| Query kind | Belongs | Why |
|---|---|---|
| Lexical / prefix / filter | Client, over the snapshot | Same O(N) scan either way, without a round trip or a staleness window |
| Semantic / vector | Server | The only place embeddings exist |
| Cypher `query` | Server | The client has `runMinimalQuery` (`:186-189`), a subset |

**Semantic search in the browser is silently dead today.** `connect()` never
passes an embeddings provider, so `vectorized()` is false and `searchVector`
returns `undefined` rather than saying why. The alternative to routing is
shipping a ~30 MB ONNX model into every tab and embedding every node there, per
tab, which is not a design anyone would choose.

Lexical is the case where routing would be a regression, and not for latency.
`CollabSession.search()` drains its own projector first
(`packages/runtime/src/session.ts:745-751`), but it cannot drain a write still
travelling from the browser: a tab's edit reaches the server projection through
relay propagation, then the server's subscribe, then the 250 ms debounce, then an
async `applyBatch`. So "I just typed this note, now find it" can miss on a
server-routed query and never misses on a snapshot scan. Semantic search does not
suffer the same way — nobody semantic-searches text they typed two seconds ago,
and the embedding is asynchronous regardless.

- **Extract the scan.** `scoreNode` is module-private
  (`packages/graph/src/memory.ts:352`). Lift it and the loop into
  `searchSnapshot(schema, snapshot, request)` in `@collabnode/graph`, have
  `InMemoryGraphStore.search` call it, and export it. One implementation, two
  callers, identical ranking client and server — which also removes the risk of a
  tab and an agent disagreeing about what matches.
- **Make `{ kind: "none" }` the browser default** once the scan is available
  without a store. §3.3 then resolves fully rather than becoming opt-in.
- **Add a server search route, not an MCP call.** `/mcp/w/:id` already exposes
  `graph_search`, but it is JSON-RPC shaped for agents and carries the
  `agentRole` visibility policy (`packages/mcp/src/visibility.ts`). A signed-in
  human is a different principal with different visibility rules, and the
  envelope buys a UI nothing. A plain `POST /api/boards/:id/search` fits the
  routes the sample already has (`examples/voice-board-azure/src/server.ts:298-320`)
  and should take the same `authorize({ documentId, user, request })` callback
  the Fluid token handler established.

Raises the stakes on §3.1 rather than lowering them: once tabs read the server
projection, a wiped shared projection is visible to every user rather than only
to agents.

Done when a browser with no local store answers lexical search from the snapshot
with ranking identical to the server's, and semantic search through the route —
and when a tab that has just written a note finds it immediately in lexical
search.

---

## 4. P2 — scale, cost, and operability

### 4.1 Embedding cache is process-local, so cold start re-embeds everything

`packages/graph/src/memory.ts:52-63,141-183`,
`packages/ladybug/src/store.ts:126-128,439-465`

Both stores already avoid redundant work correctly *within* a process: each keeps
the text a node was last embedded from and skips the model when it is unchanged.
The gap is where that cache lives — a `Map` on the store instance, keyed by node
id — so it is per store, per process, and gone on restart.

The consequences compound with the table in §1. A replica cold-starting a board
embeds all N nodes; scaling out to R replicas embeds every board R times; a
deploy re-embeds everything. None of it is shared, and none of it is durable,
even though the input is deterministic.

The material is already content-addressable. Identity ids are
`sha256(schemaId:type:values)` (`packages/schema/src/identity.ts:118-119`), and
the provider exposes a stable `id` precisely so vectors from two models are
never compared (`packages/graph/src/vector.ts:12-17`).

- Rekey the cache on `sha256(provider.id + text)` rather than on node id. Two
  nodes with the same text then cost one embedding, which is common in seeded
  templates.
- Put it behind a small interface — `get(key)` / `setMany(entries)` — with the
  current `Map` as the default and Redis as the implementation that makes it
  shared and durable.
- Worth measuring first: bge-small q8 on CPU, batched at 32, is the number that
  decides whether this is P2 or lower.

Done when a replica restart on a warm cache issues zero `embed` calls for
unchanged nodes, and two replicas holding one board embed each node once between
them.

### 4.2 The projector debounce does not protect the expensive part

`packages/runtime/src/projector.ts:69-88`

Refines §5.2 of the production-readiness backlog, which names the whole-graph
diff. The narrower point: `handle()` runs `diffSnapshots` on *every* change and
only then asks `isCrdtOnlyDiff` whether to debounce. `diffSnapshots` JSON-
stringifies `properties`, `tags`, and `meta` for every node on both sides
(`packages/graph/src/ops.ts:172-178`).

So the 250 ms debounce saves the store write and nothing else. One keystroke in
one card still costs O(N × property size) of serialization, per session, per
change. Where §5.2 proposes changed-key delivery from the CRDT layer as the real
fix, this is the argument for why the existing debounce does not already cover
the common case — and a changed-key signal would let `handle()` decide whether to
debounce *before* diffing, which is most of §5.2's value for a fraction of the
work.

### 4.3 Join is O(N) sequential awaits

`packages/runtime/src/session.ts:620-623`

`CollabSession.connect` loops every node in the snapshot awaiting
`ensureCollab` one at a time before the session is usable. On Fluid each
iteration may load a `SharedString`, so join latency grows linearly with the
graph and pays a round trip per collab field.

- Batch: collect the ids needing collab fields and await them together.
- Or make it lazy — `collabText`/`collabMap` already resolve a field on demand,
  so the eager pass may only be needed for nodes a caller will actually open.

### 4.4 Fluid reports `presence: false` and the Workspace swallows it

`packages/fluid/src/backend.ts:161-165`, `packages/hub/src/workspace.ts:97-109`

`FluidCollabBackend` declares no presence, and `Workspace` wraps its presence
subscription in a bare `catch {}`. On the Azure path — the one the README
presents as production — participant tracking therefore reduces to whichever
actor opened the workspace, silently.

Two things degrade with it: `peers()` and anything a UI builds from it, and
`lastActivityAt`, which then only moves on writes. A board with people reading
and talking but not yet writing looks idle to the reaper, so `idleTimeout` can
end a workspace that is in use.

- Either implement presence over Fluid's audience/signals, or say plainly in the
  workspace type docs that `idleTimeout` measures writes on this backend.
- Either way the `catch {}` should log once rather than never.

### 4.5 `projection: shared` accepts a store that cannot partition

`packages/hub/src/hub.ts:326-340`, `packages/ladybug/src/store.ts:233-246`

Refines §5.4 of the production-readiness backlog, which asks for a README note.
The narrower gap is in the Hub: `openSession` hands `this.graphStore` to any type
declaring `projection: shared` without checking that the store partitions.
Ladybug `claim()`s exactly one scope and refuses a second — with a good error
message, but at the second workspace rather than at `createHub`.

- Add an optional `partitioned: boolean` to `GraphStore`, and have `createHub`
  refuse a non-partitioning store at construction when any registered type
  declares `projection: shared`.
- The error then names the schema and the store together, which is the pair the
  reader has to change.

---

## 5. Suggested order

1. **§3.2** first. It is the smallest fix on the list, it is reachable today with
   two simultaneous agents, and what it leaks is an entire projection.
2. **§3.3** next, for the same reason in reverse: one added union member, and it
   removes a per-tab cost that grows with the audience rather than with the work.
3. **§3.4** immediately after, as the other half of it. §3.3 alone makes the
   local store optional; §3.4 is what makes turning it off free, and it is the
   only item here that adds a capability — browser semantic search — rather than
   reclaiming one.
4. **§3.1** before anyone uses `projection: shared` in earnest. It is the only
   item here that loses data rather than repeating work.
5. **§4.2** and §5.2 of the production-readiness backlog as one piece — a
   changed-key signal from the CRDT answers both.
6. **§4.1** only after measuring; the numbers may put it above §4.2 or well
   below it.
7. **§4.3, §4.4, §4.5** as they are passed.
