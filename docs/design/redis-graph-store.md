# Analysis: Redis as a `GraphStore`

Status: analysis; recommendation is *do not build*
Date: 2026-08-23
Scope: whether `@collabnode/redis` should grow a `GraphStore` implementation
usable in place of `InMemoryGraphStore` — and, if not, where the same Redis
effort belongs instead.

Source: a read of `packages/graph/src/{store,memory,query}.ts`,
`packages/runtime/src/projector.ts`, `packages/hub/src/hub.ts`, and the existing
`packages/redis` tree, against `docs/production-readiness-backlog.md`.

## 1. Recommendation

**No — not as a replacement for `InMemoryGraphStore`.** It would cost real work
and give back nothing the architecture does not already have. Section 6 records
the one narrow variant worth keeping on the table; section 7 records the much
better place to spend the same Redis effort.

## 2. The usual motivation does not apply

The reason to put Redis behind a store is durability, or state shared between
processes. Neither is on the table here, because **the graph store is not state
— it is a derived index.**

`packages/runtime/src/projector.ts:51-58` rebuilds the entire projection from the
CRDT on every `start()`:

```ts
await this.store?.applySchema(this.scope, this.schema);
const snapshot = this.graph.snapshot();
await this.store.applyBatch(this.scope, snapshotToOps(snapshot));
```

…and `drop()` (`:92-94`) calls `dropScope` when the workspace ends. The backlog
states it as decision #1 in its own §1: *"The CRDT is the source of truth; the
graph store is a projection."*

Persisting a projection in Redis therefore buys a warm start that `snapshot()`
already gives for free, on data that Fluid or Hocuspocus already holds durably.

## 3. The blocking problem: Redis has no query engine

`query(scope, cypher)` is the centre of the `GraphStore` interface. Redis cannot
answer Cypher — RedisGraph was deprecated and reached end of support in January
2025. That leaves two possible shapes, both of which lose:

| Approach | What actually happens |
|---|---|
| Fetch the partition, run `runMinimalQuery` in-process | `InMemoryGraphStore` semantics exactly, plus a network round-trip per query |
| Keep a local mirror, write through to Redis | The local copy answers everything; Redis holds a redundant copy of what the CRDT already holds |

This is the diagnostic for the whole question. `AgeGraphStore` and
`LadybugGraphStore` earn their place because they bring **openCypher** — per
`benchmark_results.md`, AGE is what makes the two-hop Harbor Lanes query possible
at all, a path "not supported by the in-memory query parser." Redis brings data
structures, not a query engine, so a Redis store lands strictly *below* the
in-memory store on the one axis that matters.

## 4. It does not fix `projection: shared` either

The plausible pitch is "Redis as the `shared` store, so replicas share one
projection." But backlog §4.2 already documents that this is broken at the
*projector* level, not the store level: each replica diffs its own CRDT view and
writes the result independently, so `upsertEdge` races into duplicates.

A Redis store inherits that bug identically. It re-hosts the problem rather than
solving it. The fix already identified in §4.2 — elect one projector per
workspace off the registry lease — works with the stores that exist today.

## 5. Smaller frictions, for completeness

- **`searchModes()` is synchronous** (`packages/graph/src/store.ts:71`), and is
  consumed at `packages/runtime/src/tools.ts:603` and
  `packages/mcp/src/tools.ts:307` to decide whether to advertise `graph_similar`
  to a model. A remote store needs a local cache of applied schemas to answer it
  at all. Solvable — cache on `applySchema` — but it signals that the interface
  assumes local knowledge.
- **Single-key discipline.** Every command in `RedisLike`
  (`packages/redis/src/client.ts:13-28`) is deliberately single-key so the same
  code runs against a single node, an OSS-cluster endpoint, and Azure Managed
  Redis. A graph partition is inherently multi-key; preserving that property
  would need hash tags on `scopeKey` and Lua for atomic batches.

## 6. The one variant that is not silly

`search` / `searchVector` — not `query`.

Redis Stack's `FT.SEARCH` gives real BM25, and its HNSW vector index gives real
ANN, replacing the brute-force scans at `packages/graph/src/memory.ts:206` and
`:236`. But the comment already in that file argues against it convincingly:

> a CRDT document is small enough that a scan beats an HNSW index nobody has to
> keep in sync

That holds until graphs get large, and backlog §5.2 says to measure before
optimising. There is also a deployment constraint: RediSearch exists only on
Azure's Enterprise and Managed tiers, not Basic/Standard/Premium, so this would
be a conditionally-available backend whose `search`/`searchVector` must return
`undefined` and fall back when the module is absent.

Park it behind a measurement. It is not a reason to build a `GraphStore`.

## 7. Where the Redis effort belongs instead

The right thing is already built and merely untracked.
`packages/redis/src/registry.ts` is Redis used where Redis is genuinely best:
small coordination records, TTL-native leases, single-key atomics via Lua. That
is backlog §4.1, currently listed as *"No durable `WorkspaceRegistry`
implementation"* and blocking a second replica outright.

**The backlog is stale on this point.** §4.1 proposes *Postgres*, reasoning that
`@collabnode/age` already pulls `pg` so it adds no new dependency. The Redis
implementation in the tree is a legitimate alternative — arguably better, since
lease expiry becomes Redis's job rather than a timer in a process that may
already be gone. Worth reconciling the doc with the tree either way.

Concretely, in priority order:

1. Wire `packages/redis` into the `@collabnode/node` exports and run
   `packages/hub/tests/registry.test.ts` against both implementations from one
   shared suite — §4.1's stated "done when".
2. Build the **elected projector** on top of that lease (§4.2). One replica
   projects; the others run `projection: none` and read through the shared
   store. That is what actually unlocks horizontal scaling, and it makes
   `projection: shared` correct with AGE, already benchmarked at 25 concurrent
   users.
3. Revisit Redis-backed search (§6) only if §5.2's measurement shows the scan is
   the wall.

## 8. Summary

Redis is the right tool for the **coordination** layer in this architecture and
the wrong tool for the **query** layer. It is already pointed at the right one.
