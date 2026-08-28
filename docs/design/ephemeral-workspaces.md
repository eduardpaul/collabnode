# Re-design: collabnode as an ephemeral-workspace runtime

Status: proposal; steps 1-6 of §15 implemented
Date: 2026-08-22
Updated: 2026-08-22 — §16 records what implementing steps 1-6 changed about the design.
Scope: greenfield — this document assumes no backward-compatibility obligation.




## 1. Context

collabnode today is *a runtime for a graph document*. Its center of gravity is
`init()`: one process, one schema, one document, one graph store, with MCP bolted
onto the side. Everything else in the library is arranged around that single
long-lived document.

The proposed purpose is different: **ephemeral collaboration workspaces created
from templates, with MCP and tooling provisioned automatically.** A consumer
defines a handful of *workspace types* (a retro, an incident room, a design
review) and their application starts and ends instances of those types
continuously — dozens or thousands per day, each living for minutes to hours,
each ending with a graph worth keeping.

That is not the same product. `init()` describes a mechanism; ephemeral
workspaces describe a job. The central object must move from "a session over a
document" to **a host that knows workspace types and mints, supervises, and reaps
instances of them.**

This document specifies that redesign. Section 2 records the measurements that
justify it, because three of the design decisions below are driven by numbers
rather than taste.

## 2. Validation

Measured on this machine (WSL2, Node 24) against the current implementation,
using `packages/bench/schema.yaml`. Scripts are reproducible; see §13.

### 2.1 Cold start per workspace

Open → seed 25-node template → 10 writes → snapshot → close, 20 iterations:

| Backend | open (mean) | open (p95) | full churn (mean) | full churn (p95) |
|---|---|---|---|---|
| memory | 0.1 ms | 0.6 ms | 7.1 ms | 15.5 ms |
| hocuspocus (Yjs) | 21.9 ms | 38.7 ms | 38.9 ms | 66.8 ms |
| fluid (Tinylicious) | **178.9 ms** | 371.2 ms (max) | 213.8 ms | — |

Tinylicious process spawn is an additional one-time 1824 ms.

**Conclusion: the premise is viable, and the backend choice is not free.**
Hocuspocus at ~22 ms open supports high-frequency workspace churn directly.
Fluid at ~179 ms mean and 371 ms worst case is 8× slower and unsuitable for
frequent ephemeral workspaces without a pre-warmed container pool. This settles
a question the current library leaves open by treating all backends as
interchangeable: **Yjs/Hocuspocus is the default for ephemeral workspaces;
Fluid is for long-lived durable documents.**

### 2.2 Template seeding is quadratic

Seeding via the only API available today — a loop of `upsertNode` — costs:

| Template size | seed time | per node | vs. linear |
|---|---|---|---|
| 25 | 6.5 ms | 261 µs | 1.00× |
| 100 | 27.1 ms | 271 µs | 1.04× |
| 200 | 58.7 ms | 294 µs | 1.12× |
| 400 | 225.7 ms | 564 µs | 2.16× |
| 800 | 856.1 ms | 1070 µs | **4.10×** |

Each `upsertNode` takes a full snapshot and linearly scans it for identity
resolution (`existingNodeForUpsert`), then awaits a projector drain. Both costs
are per-call. An 800-node template takes 856 ms to instantiate — on every
workspace open.

**Conclusion: templates need a bulk path.** This is the single largest
implementation-level defect for the new purpose. *Fixed in step 1-3; measured
outcome in §16.2.*

### 2.3 Termination leaves data behind — or destroys it

Two configurations, both wrong for this product:

*Without a persistence extension* (the library's current default): after 10
open/close cycles, 0 documents remain resident after ~1.5 s and a rejoin of a
closed workspace returns **0 nodes**. The graph is gone the moment the last peer
disconnects. There is no crash recovery and no post-hoc access.

*With persistence enabled* (what any real deployment runs): 5 of 5 terminated
workspaces were retained, and rejoining a terminated workspace by id returned its
content verbatim — the test read back a node titled `"secret 0"` from a workspace
that had been closed.

`CollabBackend` exposes `create` and `join`. There is no `delete`. Removing a
terminated workspace requires reaching past the library into the persistence
layer directly.

**Conclusion: this is a privacy defect, not merely a storage leak.** An
ephemeral-workspace product whose workspaces cannot be destroyed does not deliver
what its name promises. `delete` must be in the backend contract from day one.
*Fixed in step 1; measured outcome in §16.1.*

### 2.4 Projection costs ~18% of churn

Same churn loop with the graph store replaced by a no-op:

| Backend | with memory store | with no projection | overhead |
|---|---|---|---|
| memory | 7.1 ms | 6.7 ms | 6% |
| hocuspocus | 38.9 ms | 31.8 ms | **18%** |

Real but not dominant. It justifies making projection *optional* rather than
urgent — worth doing because many ephemeral workspaces never issue a query at
all, but it is not the headline cost.

### 2.5 Presence is available and unused

`y-protocols/awareness` is a transitive dependency; the Hocuspocus server exposes
`documents`, `getDocumentsCount()`, `unloadDocument()`, `closeConnections()`, and
`onAwarenessUpdate`/`beforeUnloadDocument` hooks. collabnode exposes none of it.
Presence is a prerequisite for idle-based termination (§7), so it must become a
first-class capability.

**No stopper was found.** Every risk is either cleared or has a concrete fix
inside the library's control.

## 3. Core model

Four objects replace today's `init()`/`CollabSession` pair.

```
Hub ──defines──> WorkspaceType ──instantiates──> Workspace ──ends as──> Artifact
 │                                                   │                      │
 └── registry, reaper, MCP endpoint                   └── session, presence  └── seeds a new Workspace
```

**Hub** — process-level, long-lived. Owns one collab backend connection, the
shared graph store pool, the embedding model, the workspace registry, the reaper,
and one MCP endpoint. Consumers construct exactly one.

**WorkspaceType** — a declarative definition, registered once at startup. Not
just a schema (§4).

**Workspace** — a live instance: a graph document, its participants, its
lifecycle state, its scoped tool surface.

**Artifact** — what termination produces: the final snapshot plus metadata, in a
format that is simultaneously the export, the review format, and a template
source (§8).

```ts
const hub = await createHub({
  collab: { kind: "hocuspocus", url: process.env.HOCUSPOCUS_URL },
  registry: redisRegistry(redis),        // in-process default; see §7.4
  mcp: { mount: "/mcp" },
});

hub.define(retroType);
hub.define(incidentType);

const ws = await hub.open("retro", {
  id: `retro-${team}-s${sprint}`,        // caller's own id
  params: { sprint, members },
});

ws.mcpUrl;   // "/mcp/w/retro-acme-s42" — scoped, provisioned, ready
await ws.end();                          // or let the lifecycle policy do it
```

### 3.1 Idempotent open, not create-vs-join

`hub.open(type, { id })` is **open-or-join** and safe under concurrency.

Today's `create()`/`join()` split forces the caller to know whether a document
already exists — a race no web application can win, since N browser tabs open the
same workspace simultaneously. It also forces consumers to store the
library-minted `documentId` alongside their own primary key, a mapping table
nobody wants.

Caller-supplied ids fix both. The id is the consumer's own (`retro-acme-s42`);
the hub maps it to a backend document internally. Concurrent `open()` calls for
the same id resolve to the same workspace, with seeding performed exactly once
(§6.3).

## 4. The WorkspaceType

The central conceptual change: **a workspace type is not a schema.** It is a
bundle of six facets, all declarable in one YAML document, because the entire
premise is that a consumer describes "a retro" once and starts a thousand of them.

```yaml
type: retro
version: 3

schema:                 # (1) what can exist — today's node/edge definitions
  nodes:
    Column: { properties: { title: { type: string, required: true } } }
    Item:   { properties: { body: { type: text }, votes: { type: number, default: 0 } } }
  edges:
    IN_COLUMN: { from: [Item], to: [Column] }

params:                 # (2) what varies per instance
  sprint:  { type: number, required: true }
  members: { type: array, of: string }

template:               # (3) what exists at t=0
  nodes:
    - { type: Column, as: went_well, properties: { title: "Went well" } }
    - { type: Column, as: to_improve, properties: { title: "To improve" } }
    - forEach: members
      as: "member_{item}"
      type: Person
      properties: { name: "{item}" }

lifecycle:              # (4) when it ends
  idleTimeout: 30m
  maxDuration: 4h
  endWhen: "MATCH (i:Item) WHERE i.votes = 0 RETURN count(i) = 0"

tools:                  # (5) what agents can do
  expose: [graph_search, graph_neighbors]
  named:
    add_item:
      description: Add a retro item to a column
      creates: Item
      into: IN_COLUMN
  agents:
    - { role: facilitator, actorId: facilitator-bot }
    - role: summarizer
      actorId: summarizer-bot
      nodes:
        readOnly: [Item]      # reads items, never edits them
        hidden: [Person]      # summarizes without knowing who is in the room

projection: none        # (6) how it is queried — none | memory | shared
retention:
  onEnd: delete         # delete | keep | archive
  artifact: required    # termination must produce a durable artifact
```

Each facet is examined below. The `version` field replaces today's schema-hash
handshake: peers negotiate on `type@version`, and a version bump makes existing
workspaces of the old version read-only rather than failing their peers.

## 5. Templates

### 5.1 Parameterized, or ornamental

A static seed graph is nearly useless. A retro needs the sprint number and the
participant list; an incident room needs the alert payload. Templates therefore
require interpolation (`"{item}"`), iteration (`forEach`), symbolic node
references (`as:` / edge endpoints by alias rather than by generated id), and
conditionals.

Two authoring paths, declarative primary:

- **Declarative YAML** (above) — serializable, validatable at `define()` time,
  inspectable, authorable by non-developers, and — critically — round-trippable
  with the termination artifact (§8).
- **`seed(ws, params)` function** — the escape hatch for anything the declarative
  form cannot express. Always available, never required.

### 5.2 One expression dialect

`packages/schema/src/expr.ts` today parses arithmetic only: numbers, identifiers,
and `+ - * /`. Templates need string interpolation, comparison, and boolean
logic for conditionals.

**Decision: extend the existing expression parser rather than introduce a second
mini-language.** The YAML already has `derived:` expressions; if templates grow
an incompatible dialect, the schema language becomes twice as hard to learn for
no benefit. One grammar, used by `derived:`, `template:` conditionals, and
`lifecycle.endWhen` guards.

### 5.3 Seeding must be a bulk operation

Per §2.2, seeding through per-node `upsertNode` is quadratic and dominated by
repeated snapshot scans plus per-call projector drains.

The runtime gains a bulk path:

```ts
interface CollaborativeGraph {
  applyBatch(ops: GraphOp[]): void;   // one CRDT transaction
}
```

`Workspace.applyOps(ops)` validates the whole batch, resolves identity **once**
against a single snapshot using an index rather than a linear scan, commits one
CRDT transaction, and drains the projector **once**. Fluid already wraps `apply`
in `Tree.runTransaction`; Yjs has `doc.transact`. Both backends support this
natively — the current one-op-at-a-time interface is what prevents using it.

Template instantiation becomes one `applyOps` call. Expected effect: 800-node
template from 856 ms to roughly the cost of one op batch.

The existing `snapshotToOps` in `@collabnode/graph` is exactly the compiler
target — a compiled template *is* a `GraphOp[]`, which is also what an artifact
deserializes to (§8). The three paths converge on one representation.

## 6. Workspace lifecycle

### 6.1 States

```
     open()
       │
       ▼
   seeding ──> active ──> ending ──> ended
       │          │          │
       └──────────┴──> failed┘
```

`seeding` is observable so that peers joining a workspace mid-instantiation wait
rather than seeing a half-built graph. `ending` runs the consumer's `onEnd` hook
before teardown and is the only state in which the final artifact exists.

### 6.2 Four termination triggers

| Trigger | Requirement |
|---|---|
| `idleTimeout` | No writes **and** no connected peers for the interval — requires presence (§9) |
| `maxDuration` | Absolute wall-clock cap; the safety net that makes leaks impossible |
| `endWhen` | A predicate over the workspace's own graph |
| `ws.end()` | Explicit |

`endWhen` is the trigger only a graph runtime can offer, and it is the
differentiating feature of this design. "End when every item has been voted on"
is a query plus a subscription — both of which the projector already provides.
It re-evaluates on commit, not on a timer.

### 6.3 Seeding happens exactly once

Under concurrent `open()` for the same id, exactly one caller seeds. The registry
(§6.4) provides the mutual exclusion: the winner transitions `absent → seeding`
and instantiates the template; the others await `active`. Without this, two tabs
opening a retro simultaneously produce a double-seeded board.

### 6.4 Who runs the timer: the production fork

In-process timers are correct for one Node process and **wrong** the moment the
consumer runs two replicas — both reap the same workspace, both fire `onEnd`,
the consumer's database gets two conflicting writes.

This must not be hidden. The design surfaces it:

```ts
interface WorkspaceRegistry {
  claim(id: string, ttlMs: number): Promise<Lease | undefined>;  // mutual exclusion
  heartbeat(lease: Lease): Promise<void>;
  release(lease: Lease): Promise<void>;
  due(now: number, limit: number): Promise<WorkspaceRecord[]>;   // reap candidates
  put(record: WorkspaceRecord): Promise<void>;
}
```

- **Default:** `memoryRegistry()` — in-process timers, correct for single-process
  deployments and development.
- **Production:** the consumer backs it with Redis or Postgres and drives
  `hub.sweep()` from a cron or a single elected replica.

Deciding this on day one is nearly free. Retrofitting distributed lifecycle onto
in-process timers is a rewrite, because every assumption about "the process that
owns this workspace" is baked into the reaping path.

### 6.5 Termination ordering

`end()` must, in order:

1. drain the projector,
2. capture the final snapshot,
3. build the artifact,
4. **await** the consumer's `onEnd(artifact)` hook,
5. tear down the session, then
6. apply the retention policy (delete / keep / archive).

Step 4 being awaited is what makes the artifact durable: a failed persist blocks
reaping and retries, rather than silently losing the workspace. Today's
`close(): Promise<void>` inverts this — it destroys the handle and returns
nothing, so the snapshot must be captured beforehand by a caller who happens to
know the ordering rule. That trap disappears when `end()` returns the artifact.

## 7. Snapshot and the termination artifact

Termination produces one serializable object, used for three purposes:

```ts
interface WorkspaceArtifact {
  id: string;
  type: string;
  version: number;
  params: Record<string, unknown>;
  openedAt: string;
  endedAt: string;
  endedBy: "idle" | "duration" | "predicate" | "explicit" | "error";
  participants: Participant[];
  snapshot: GraphSnapshot;        // CRDT values hydrated to plain JSON
  history?: HistoryEntry[];       // when changeTracking.mode = history
}
```

Its three uses:

1. **Persist** — the consumer writes it to their own database in `onEnd`.
2. **Review** — `hub.reopen(artifact)` mounts it read-only, with the same tool
   surface, for post-hoc inspection. No live document required.
3. **Seed** — `hub.open(type, { from: artifact })` uses it as the template.

The third closes the loop the consumer described: **today's output is tomorrow's
template.** A team that runs a good retro can fork it. An incident room can be
replayed from its own record. Because a compiled template and a deserialized
artifact are both `GraphOp[]` (§5.3), this requires no additional machinery — it
is a consequence of choosing one representation.

Snapshots already hydrate CRDT fields to plain values in every backend, so the
artifact is genuinely self-contained and needs no CRDT runtime to read.

## 8. Projection becomes optional

Today `Projector.start()` is unconditional and every mutation awaits `drain()`.
For ephemeral workspaces this is backwards: **the CRDT holds the truth, and the
projection is an optional query accelerator.** Many short-lived workspaces are
written and read entirely through snapshots and never issue a Cypher query;
paying projection on every write, per workspace, multiplied by N concurrent
workspaces, is waste — measured at 18% of churn time (§2.4).

Three modes, declared per type:

| `projection` | Behavior | For |
|---|---|---|
| `none` | No store. `snapshot()`, list/get/neighbors answer from the CRDT. **Default for ephemeral types.** | Most workspaces |
| `memory` | Per-workspace in-memory store; Cypher and text search available | Query-heavy workspaces |
| `shared` | One process-level store, partitioned by workspace id | Cross-workspace analytics, durable types |

The `shared` mode requires an interface change: `GraphStore` methods take a
workspace scope rather than the store being instantiated per workspace.

```ts
interface GraphStore {
  applyBatch(scope: WorkspaceScope, ops: GraphOp[]): Promise<void>;
  query(scope: WorkspaceScope, cypher: string, params?: object): Promise<QueryResult>;
  dropScope(scope: WorkspaceScope): Promise<void>;   // termination
}
```

This is load-bearing for scale. Per-workspace AGE graphs mean per-workspace DDL —
untenable for thousands of ephemeral rooms. A single graph with a `workspace_id`
discriminator and one connection pool is the correct shape, and it is only
achievable if scope is a parameter rather than a constructor argument.

It also fixes a live defect: `AgeGraphStore` defaults `graphName` to
`schema.config.schemaId`, so N concurrent workspaces of the same type silently
collide into one AGE graph today.

## 9. Presence

New core capability, prerequisite for idle termination (§6.2), available in both
backends and exposed by neither.

```ts
interface CollabHandle {
  presence(): Presence;
}
interface Presence {
  peers(): Peer[];                        // { actorId, kind: "human" | "agent", since }
  on(event: "join" | "leave", fn): () => void;
  set(state: Record<string, unknown>): void;   // cursor, selection, typing
}
```

Backed by `y-protocols/awareness` for Hocuspocus and the container audience for
Fluid. Beyond lifecycle, this is what makes the product feel collaborative:
`ws.peers()` is the first thing any real consumer asks for, and every consumer
currently has to reach past the library into the CRDT vendor to get it.

## 10. Backend contract changes

```ts
interface CollabBackend {
  readonly kind: string;
  open(id: string, type: WorkspaceType): Promise<CollabHandle>;  // open-or-create
  delete(id: string): Promise<void>;                             // NEW — §2.3
  exists(id: string): Promise<boolean>;
}

interface CollaborativeGraph {
  applyBatch(ops: GraphOp[]): void;   // NEW — §5.3
  presence(): Presence;               // NEW — §9
}
```

`create`/`join` collapse into `open` (§3.1). `delete` is mandatory for every
backend: Hocuspocus implements it via `unloadDocument()` plus a persistence-layer
removal (both available, verified in §2.3); Fluid via the relay's delete API;
memory by dropping the map entry. **A backend that cannot delete cannot host
ephemeral workspaces**, and the contract should say so rather than letting the
consumer discover it in production.

## 11. MCP and tooling

### 11.1 One endpoint, scoped by transport

"Auto MCP" for a fleet means one hub endpoint where the workspace is selected
**per request** — by URL path (`/mcp/w/:workspaceId`) or by an auth claim.

**Decision: never make the workspace a tool argument.** Doing so leaks
multi-tenancy into the model's context window and gives an agent the vocabulary
to address another tenant's workspace. Scope belongs to the transport and auth
layer; the agent sees exactly one workspace's tool surface and has no way to name
another.

### 11.2 Type-declared tool policy

Schema-derived tools are already the right instinct. The workspace type extends
it with:

- **`expose`** — which generated graph / upsert tools are available (a retro
  does not need `graph_query`). `*` exposes every generated tool, which is also
  the default when the list is omitted,
- **`named`** — type-specific tools: `add_item(column, body)` rather than
  `upsert_node(type="Item", ...)`. Named, narrow tools measurably outperform
  generic ones for tool-use accuracy, and the schema already has the type
  information needed to generate them,
- **`agents`** — auto-attached participants. "Every incident room starts with a
  triage agent" is declarative, and the agent joins as a real peer with its own
  `actorId`, appearing in presence and in change attribution like any human.
- **`agents[].nodes`** — per-role reach over node types, in two independent
  lists: `readOnly` (visible, unwritable) and `hidden` (not visible at all).

Per-node `guidelines` (already in the schema) becomes the source of the system
prompt for the workspace's tool surface.

**Decision: two policies, not one permission level.** A single `write: false`
flag would conflate the two requests people actually make of a shared workspace.
"The reviewer reads decisions but does not edit them" needs the type to stay in
the contract, so the model knows what it is looking at and why it cannot change
it — that is `readOnly`, and `graph_describe` marks it so the refusal is
predicted rather than discovered. "The outside agent must not learn that the
legal note exists" needs the opposite: the type struck from the schema view, the
prompts, the resources and every read, with hidden ids answering `unknown id`
exactly as absent ids do. A hidden type that leaked through an error message, an
ambiguous id prefix, or an identity probe would be no policy at all, so
resolution runs against the filtered snapshot rather than checking results after
the fact.

Two consequences fall out of taking `hidden` seriously. `graph_query` is not
offered to a concealing role: Cypher executes in the projection, which has no
notion of a role, and post-filtering rows cannot undo an aggregate that counted
hidden ones. And an edge write is treated as touching both endpoints — attaching
or detaching an edge changes how a node reads to everyone — so a read-only
endpoint refuses the write, per type where no instance could be written and per
call where only some could.

This is a policy on the *tool surface*, which is where an agent's whole world
comes from. It is not transport auth: anything holding the `CollabSession`
itself is outside it.

Auto-attached agents are the strongest differentiator in this design. A generic
CRDT library cannot offer them, because it has no concept of a workspace type
with a membership policy.

## 12. Package layout

| Package | Change |
|---|---|
| `@collabnode/hub` | **New.** Hub, WorkspaceType, Workspace, registry, reaper, artifact |
| `@collabnode/schema` | Absorbs type definition: params, template, lifecycle, tools; expression dialect extended (§5.2) |
| `@collabnode/runtime` | `CollabSession` → `Workspace`; gains `applyOps`, presence, artifact |
| `@collabnode/graph` | `GraphStore` becomes scope-parameterized (§8) |
| `@collabnode/collab` | `open`/`delete`/`exists`, `applyBatch`, `presence` (§10) |
| `@collabnode/mcp` | Hub-level endpoint with path scoping; named tools; agent attachment |
| `@collabnode/hocuspocus` | Promoted to default backend; implements delete + presence |
| `@collabnode/fluid` | Repositioned for durable long-lived documents; container pool if ephemeral use is needed |
| `collabnode` | `init()` removed — it is `hub.open()` on a single-type hub |
| `@collabnode/cli` | Shrinks to a dev tool: validate a type, run a hub, inspect an artifact |

What survives unchanged: the `GraphOp`/snapshot/diff model, the projector's
diff-based design, schema-derived tooling, and backend pluggability. These are
the parts of the current library that were built right, and the redesign is
mostly a change of what sits *above* them.

## 13. Reproducing the measurements

The validation scripts are committed under `docs/design/validation/` and should
be promoted into `packages/bench` as a `churn` scenario:

- `churn.mjs` — open/seed/write/snapshot/close across backends, with and without projection
- `scaling.mjs` — seed cost vs. template size (the quadratic result)
- `residency.mjs` — document residency after close, unpersisted
- `persisted.mjs` — retention and re-readability after termination, persisted
- `fluid.mjs` — Fluid container cold start

`bench --scenario churn` becomes a permanent regression guard: cold start and
seed cost are now product-defining numbers, not incidental ones.

## 14. Open questions

1. **Fluid's role.** At 179 ms mean open, is Fluid worth keeping for ephemeral
   workspaces at all, or is it explicitly the durable-document backend? A
   container pool is a substantial subsystem; it should not be built on
   speculation.
2. **Artifact storage.** Does the hub ship a default artifact store (filesystem,
   S3), or is `onEnd` always the consumer's responsibility? Shipping one makes
   the happy path complete; not shipping one keeps the library unopinionated.
3. **Template versioning.** When `retro@3` is deployed while `retro@2` workspaces
   are live, the proposal makes old workspaces read-only. Is migration of a live
   workspace ever required, or is "finish on the old version" always acceptable?
4. **Named-tool generation.** Fully derived from the schema, fully hand-written,
   or derived with hand-written overrides? Affects how much of §11.2 is
   generated versus authored.
5. **Presence identity.** Does the hub authenticate participants, or does it
   accept a caller-supplied `actorId` and leave auth to the consumer? The latter
   is simpler and probably right, but it means presence cannot be trusted for
   authorization decisions.

## 15. Implementation sequence

Ordered so that each step is independently useful and the risky items land early.

1. **Backend contract** — `open`/`delete`/`exists`, `applyBatch`, `presence`, on
   memory + hocuspocus. Unblocks everything; resolves the §2.3 privacy defect.
2. **Bulk apply in the runtime** — `Workspace.applyOps`, indexed identity
   resolution, single drain. Fixes the quadratic seed (§2.2) and is a
   self-contained win.
3. **Optional projection** — `projection: none` and scope-parameterized
   `GraphStore`. Largest scaling change; do it before anything depends on the old
   store shape.
4. **WorkspaceType + templates** — schema extension, expression dialect, template
   compiler to `GraphOp[]`.
5. **Hub, registry, lifecycle, artifact** — the reaper, the four triggers, the
   `end()` ordering.
6. **MCP hub endpoint** — path scoping, tool policy, named tools.
7. **Auto-attached agents** — the differentiating feature, built once the surface
   underneath it is stable.

Steps 1–3 are pure improvements that stand on their own merits regardless of
whether the repositioning proceeds. Step 4 is the point of no return.

## 16. What steps 1–3 changed about this design

Steps 1–3 of §15 are implemented. Everything below is measured on the same
machine and schema as §2, and the whole suite (353 tests) is green. Two things
the implementation contradicted are recorded here rather than quietly edited
into the sections above, because the reasoning matters more than the conclusion.

### 16.1 The privacy defect is closed

`CollabBackend` is now `open` / `delete` / `exists`, and it declares what it can
do:

```ts
interface CollabBackendCapabilities {
  namedDocuments: boolean;  // `open` can *create* under a caller-chosen id
  deletion: boolean;        // `delete` removes content and its persisted copy
  presence: boolean;        // `presence()` reports real remote peers
}
```

Re-running `validation/persisted.mjs` against a Hocuspocus server with
persistence enabled — the configuration in which §2.3 read back `"secret 0"`
from a terminated workspace:

```
backend capabilities: {"namedDocuments":true,"deletion":true,"presence":true}
destroy() returned the final snapshot: 1 node(s), "secret 0"
resident documents:  0
persisted documents: 5
bytes retained:      780
nodes inside them:   0   <-- content, as opposed to framing

reopening a terminated workspace by id reads back: 0 node(s)  <-- nothing left
```

780 bytes across five documents is Yjs framing: a persistence extension
debounces its writes, so an empty state can land after the purge. The record
survives as a tombstone; the content does not. That distinction is in
`HocuspocusCollabBackend.delete`'s own documentation, because a caller who needs
the row itself gone needs the server-side half —
`deleteHocuspocusDocument(server, name, onPurge)` in
`@collabnode/hocuspocus/node`, which unloads the document and hands the
persistence layer its name.

`CollabSession.destroy()` is the runtime entry point, and it returns the final
snapshot. That is the §6.5 ordering made unavoidable rather than documented:
drain, snapshot, drop the projection, close, delete. `close()` still exists and
still means "this peer is leaving".

**The capability flags are load-bearing, not decorative.** Fluid declares
`namedDocuments: false`, `deletion: false`, `presence: false`, and its `delete`
and `presence` throw rather than pretending. A first implementation had
`CollabSession.open` refuse *any* caller-supplied id on such a backend, which
broke every Fluid peer-join in the bench suite — `namedDocuments: false` means
"cannot create under a chosen id", and joining an id the relay minted is a
different question. The flag's contract is now written to that distinction.

### 16.2 The quadratic seed is gone

`CollaborativeGraph.applyBatch(ops)` commits one CRDT transaction, and
`CollabSession.applyOps(inputs)` plans a whole batch against one `SnapshotIndex`
— id, identity, normalized-near-miss, and edge-endpoint lookups become maps
instead of the three array scans each write used to do. The index is mutable, so
an entry can name itself with `ref` and a later edge can point at it with
`{ ref }` before the batch commits.

Seeding a template, `validation/scaling.mjs`:

| Template | per-node loop | `applyOps` | speedup |
|---|---|---|---|
| 25 | 6.4 ms (255 µs/node) | 1.1 ms (42 µs/node) | 6× |
| 100 | 15.8 ms (158 µs/node) | 0.5 ms (5.5 µs/node) | 29× |
| 400 | 221.3 ms (553 µs/node) | 2.4 ms (6.0 µs/node) | 93× |
| 800 | 667.8 ms (835 µs/node) | 4.3 ms (**5.4 µs/node**) | **154×** |

The batch path is flat. The 800-node template that cost 856 ms on every
workspace open in §2.2 now costs 4.3 ms. Absolute times move with machine load —
a second run under load read 3277 ms vs. 17.2 ms, a 191× ratio — so the claim to
hold onto is the shape: constant µs/node against a curve that keeps climbing. The loop improved too (1070 → 835
µs/node) because single writes use the index as well, but it stays super-linear
by construction: calling one at a time means one snapshot and one drain each,
and no index can fix that.

Full churn — open, seed 25 nodes + 24 edges, 10 writes, snapshot, close:

| Configuration | mean | p95 |
|---|---|---|
| hocuspocus, per-node seed, projected | 46.9 ms | 83.5 ms |
| hocuspocus, batch seed, projected | 26.2 ms | 32.0 ms |
| hocuspocus, batch seed, `projection: none` | **20.1 ms** | **25.3 ms** |
| memory, per-node seed, projected | 8.4 ms | 15.3 ms |
| memory, batch seed, `projection: none` | **1.6 ms** | **2.1 ms** |

2.3× on the mean and 3.3× on the p95 for the backend that matters. The seed
phase itself went from 16.8 ms to 1.0 ms.

### 16.3 Projection is optional, and cheaper off than §2.4 predicted

`CollabSessionOptions.graph` is optional and `GraphKind` gained `{ kind: "none" }`.
Omitting the store does more than skip store writes: the projector stops
diffing entirely when nothing consumes the diff, which is where the extra saving
over §2.4's measured 18% comes from. `query()` refuses with a clear message
rather than answering from a store that does not exist; `search` returns
`undefined`, which is already its "no index here" answer. Change listeners still
fire — they are fed by the diff, not by the store — so `onChange` works on an
unprojected workspace and the projector resumes diffing the moment one is added.

### 16.4 Correction: a discriminator column would have leaked

§8 proposed "a single graph with a `workspace_id` discriminator". Implementing
it showed that this is wrong for any store backed by a real Cypher engine, and
the reason is `query`:

> `query(scope, cypher)` passes **caller-written Cypher** to the engine
> unmodified. A discriminator column is enforced only on the ops collabnode
> generates. Every user query — every `graph_query` tool call an agent makes —
> would be silently unscoped.

A discriminator would therefore have produced a tenancy boundary that holds for
writes and fails open for reads, which is worse than no boundary at all, because
it looks like one. The store is scope-parameterized as §8 required — that part
was right and is what made the rest possible — but each backend draws the
boundary where its engine can actually hold it:

| Store | Boundary | `dropScope` |
|---|---|---|
| `InMemoryGraphStore` | one `Partition` per scope | delete the partition |
| `AgeGraphStore` | one AGE graph per workspace, `base_<hash>` | `drop_graph(name, true)` |
| `LadybugGraphStore` | one workspace per store, refused out loud | `MATCH (n) DETACH DELETE n` |

AGE also gains the fix §8 predicted: `graphName` no longer defaults to
`schemaId`, so N concurrent workspaces of one type no longer collide into one
graph. `graphName` is now the *base* of a per-workspace name.

Ladybug is the honest exception. It is an embedded engine: one database is one
file, tables are typed per node label, and there is no discriminator that a user
query would respect either. Serving many workspaces means one file each, which
is a file lifecycle — create, evict, delete, clean up after a crash — that
belongs with the hub's retention policy in step 5, not inside a store. Until
then it refuses a second scope with a message naming the alternatives, rather
than mixing two workspaces into one file. **The interface change is what makes
that a later addition instead of another break**, which was the point of doing
step 3 before step 4.

### 16.5 Presence

`CollabHandle.presence()` returns `peers()` / `set()` / `on("join"|"leave"|"change")`,
backed by `y-protocols/awareness` for Hocuspocus and an in-process peer table
for memory. Peers carry `actorId`, `kind: "human" | "agent"`, `since`, `state`,
and `self`, so an auto-attached agent (§11.2) appears in the room as a real peer.
A peer that has not published a collabnode identity is not counted — otherwise
`peers()` would be a connection count, which is not what callers ask it for.

This is the prerequisite §2.5 identified for idle-based termination. The reaper
itself is step 5.

### 16.6 What this leaves for step 4

`init()` still works, `CollabSession` is still the object, and no hub exists yet.
What changed is everything underneath: `open` is idempotent, batches are one
transaction, projection is optional and scoped, workspaces can be destroyed, and
peers are visible. Step 4 — WorkspaceType, params, templates compiled to
`GraphOp[]` — now has `applyOps` as its compiler target, which is what §5.3
asked for.

### 16.7 Step 4: WorkspaceType, expression dialect, and template compilation

Step 4 is implemented and all tests are green:

- **Expression dialect extended (§5.2)**: `packages/schema/src/expr.ts` now supports
  the unified grammar: booleans (`true`/`false`), string literals (`"..."`, `'...'`),
  `null`, numbers, identifiers, member access (`obj.property`), unary operators
  (`+`, `-`, `!`), comparisons (`==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`),
  logical operators (`&&`, `||`), and arithmetic (`+`, `-`, `*`, `/`, `%`). String
  interpolation (`interpolateTemplate`) and value evaluation (`evaluateValue`) evaluate
  `{expr}` patterns with nested property access.
- **WorkspaceType schema (§4)**: `packages/schema` parses full workspace type
  documents (`parseWorkspaceTypeDocument`, `loadWorkspaceTypeFile`), supporting type
  names, versions, schemas, parameter declarations with types and defaults, templates
  with node and edge definitions, lifecycle duration caps, tools policies, retention
  policies, and projection settings.
- **Template compiler to `GraphOpInput[]` (§5.3)**: `compileTemplate` resolves
  parameters, evaluates iterations (`forEach`), processes conditionals (`when`/`if`),
  maps symbolic aliases (`as:`) to batch `ref`s, and links edge `from`/`to` endpoints
  to declared refs.
- **Runtime execution**: `CollabSession.seedTemplate(type, params)` / `Workspace`
  applies compiled operations in a single CRDT transaction, single snapshot index
  pass, and single drain.

### 16.8 Step 5: Hub, registry, lifecycle, and artifact

Step 5 is implemented in the new `@collabnode/hub` package and re-exported by `collabnode`:

- **Hub coordinator & factory (§3)**: `createHub` / `Hub` owns registered `WorkspaceType`s,
  collab backend, shared graph store, embedding provider, workspace registry, reaper, and
  scoped MCP endpoint routing.
- **Idempotent open with concurrency coordination (§3.1, §6.3)**: `hub.open(type, { id })`
  coordinates create-or-join via registry leasing (`registry.claim(id, ttl)`). The winning
  process seeds the template, while concurrent callers await active state and join without
  duplicate seeding.
- **WorkspaceRegistry (§6.4)**: `WorkspaceRegistry` interface with `claim`, `heartbeat`,
  `release`, `due`, `get`, `put`, `delete`, and `list`. Built-in `memoryRegistry()` provides
  in-process leases and state tracking for development and single-replica runtimes.
- **Four termination triggers (§6.2)**:
  - `idleTimeout`: Evaluates when no connected peers exist and no writes have occurred
    for the duration cap. Connected peers (via `ws.presence()`) prevent idle reaping.
  - `maxDuration`: Enforces an absolute wall-clock lifespan on open workspaces.
  - `endWhen`: Evaluates Cypher graph queries and snapshot expressions on graph mutations.
  - `ws.end()`: Explicit termination.
- **Strict termination ordering & Artifact (§6.5, §7)**:
  `end()` drains the projector, captures the final snapshot and history, constructs the
  `WorkspaceArtifact`, awaits consumer `onEnd` hooks, applies retention policy (`delete`
  destroying the CRDT document or `keep`), and updates registry state.
- **Artifact loop closure (§7.2, §7.3)**:
  - Review: `hub.reopen(artifact)` mounts a read-only workspace from an artifact snapshot.
  - Seed: `hub.open(type, { from: artifact })` forks/replays a new workspace from a prior
    artifact snapshot via `snapshotToGraphOpInputs`.

### 16.9 Step 6: MCP Hub endpoint, path scoping, tool policy, and named tools

Step 6 is implemented in `@collabnode/mcp` and re-exported by `collabnode`:

- **Path-scoped hub endpoint (§11.1)**: `createHubMcpHandler(hub, options)` routes MCP
  requests per workspace at `/mcp/w/:workspaceId` (or `${mount}/w/:workspaceId`), never
  leaking workspace identity as a tool argument into LLM context.
- **Tool policy & expose filtering (§11.2)**: `tools.expose` declarations in `WorkspaceType`
  filter generic graph tools so that domain-specific workspaces only expose relevant
  primitives (e.g. `[graph_search, graph_neighbors, graph_describe]`).
- **Type-specific named tools (§11.2, §14.4)**: `tools.named` declarations generate narrow,
  named tools (e.g. `add_item` with `creates: Item` and `into: IN_COLUMN`), allowing agents
  to create nodes and link them into container hierarchies in a single atomic tool call.
- **Per-role node policy (§11.2)**: `tools.agents[].nodes.readOnly` / `.hidden`,
  resolved once per request into a `NodeAccessPolicy` (`@collabnode/schema`) and
  enforced across tools, prompts, and resources (`@collabnode/mcp`).
- **Agent role prompts & tool scoping (§11.2)**: `tools.agents` declarations generate
  role-specific MCP prompts (e.g. `agent-facilitator`) and scope available tools to each
  agent's designated capability set.
- **Live HTTP serving**: `serveHubMcpHttp(hub, listen, options)` serves the multi-tenant,
  path-routed MCP endpoint over standard HTTP/SSE transports.



