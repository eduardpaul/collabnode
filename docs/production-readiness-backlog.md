# Production-readiness backlog

Status: backlog; the P0 trio (§3.1–§3.3) and §4.1 are done — see the changelog
Date: 2026-08-23 (updated 2026-08-23)
Scope: what stands between the current tree and a collabnode a third party could
deploy. Architecture is not in question — see §1 — so every item below is an
implementation gap, not a redesign.

Source: a full read of the tree at `10e921f`, with `pnpm build`, `pnpm test:ci`
(348 tests, all passing), and `pnpm lint` (95 errors, all `sonarjs` complexity,
non-blocking by design in `.github/workflows/ci.yml`) run against it.

## 1. What is not on this list

The architecture holds up and none of the work below asks to change it. Three
decisions in particular should survive:

- **The CRDT is the source of truth; the graph store is a projection.** That one
  decision is what makes `projection: none | memory | shared` a per-type knob
  rather than a rewrite, and it is applied consistently — `Projector` diffs
  snapshots into `GraphOp`s and every store is a sink plus a query engine.
- **`GraphStore` takes a `WorkspaceScope` on every call**, rather than carrying a
  `workspace_id` column. Caller-written Cypher cannot escape a boundary it is
  never handed.
- **MCP is scoped by URL path, not by tool argument** (`hub-handler.ts`). An
  agent is never given a workspace id it could tamper with.

The `hidden` / `readOnly` node policy is also sound, including its refusal to
offer `graph_query` to a concealing role.

## 2. Priorities

P0 blocks any deployment. P1 blocks a second replica or an untrusted caller. P2
is scale and operability work that a small deployment survives without.

| # | Item | Priority | Kind | Rough size |
|---|---|---|---|---|
| 3.1 | ~~Azure Fluid Relay tokens are unsigned~~ **done** | P0 | Correctness / security | S |
| 3.2 | ~~Token handler does not authorize `documentId`~~ **done** | P0 | Security | S |
| 3.3 | ~~Per-request MCP server and transport leak~~ **done** | P0 | Correctness | S |
| 4.1 | ~~No durable `WorkspaceRegistry` implementation~~ **done** | P1 | Scale | M |
| 4.2 | Replicas double-write a shared AGE projection | P1 | Correctness at scale | M |
| 4.3 | `autoOpenType` is unauthenticated workspace creation | P1 | Security | S |
| 4.4 | `graph_query` read-only guard is a regex deny-list | P1 | Security / UX | M |
| 4.5 | Schema property names are not identifier-validated | P1 | Security (latent) | S |
| 5.1 | Fluid and AGE are the least-tested backends | P2 | Confidence | L |
| 5.2 | Projector diffs the whole graph on every change | P2 | Scale | L |
| 5.3 | No observability seam | P2 | Operability | M |
| 5.4 | Ladybug is one workspace per store | P2 | Documentation | S |

---

## 3. P0 — blocks deployment

### 3.1 Azure Fluid Relay tokens are unsigned

`packages/azure/src/backend.ts:91-108`

`encodeDemoJwt` emits a JWT with `alg: "none"` and an empty signature segment,
and puts the first four characters of the tenant key into the payload as
`keyHint`. Azure Fluid Relay requires HS256 signed with the tenant key, so this
does not authenticate against a real relay — the Azure path, which the README
presents as the production transport, cannot work as shipped.

Two problems, and the second is the worse one. The code is a demo stub; nothing
in `README.md` or `packages/azure/README.md` says so, and the surrounding
narrative ("Never put the Azure tenant key in Vite env") reads as production
guidance. A reader has no way to learn this except by opening the file.

- Sign with HS256 using the tenant key.
- Drop `keyHint` — it leaks key material into a token the browser holds.
- Set `exp`, and scope `scopes` to what the caller actually needs rather than
  always `["doc:read", "doc:write", "summary:write"]`.
- Either rename the demo provider so its name carries the warning, or delete it
  in favour of the signed one.

Done when a token minted by this package is accepted by a provisioned Azure
Fluid Relay tenant, and a test asserts the signature verifies against the key.

### 3.2 Token handler does not authorize `documentId`

`packages/node/src/token.ts:22-27`

`createFluidTokenHandler` reads a `documentId` from the query string or body and
mints a `doc:read` / `doc:write` token for it. `options.user(request)` answers
*who is calling* and is never asked *may they open this document*. Any
authenticated user can request a token for any document id — a plain IDOR, and
in a multi-tenant host it is a full cross-tenant read/write.

A caller can work around it today by re-parsing the request inside `user()` and
throwing, but the API shape invites the hole and the README example
(`createFluidTokenHandler({ tenantKey, user })`) demonstrates exactly the unsafe
form.

- Add a required `authorize(user, documentId): boolean | Promise<boolean>` hook,
  or fold the check into `user()` by passing the resolved `documentId` to it.
- Refuse with 403 when it returns false, and refuse when `documentId` is absent
  rather than minting a tenant-wide token.
- Update the README example to show the authorized form.

Done when a request for a document the user cannot reach returns 403, covered by
a test.

### 3.3 Per-request MCP server and transport leak

`packages/mcp/src/hub-handler.ts:101-111`

The hub handler builds a fresh `createWorkspaceMcpServer` **and** a fresh
`WebStandardStreamableHTTPServerTransport` on every request, and closes neither.
The single-document path in `packages/mcp/src/http.ts:55-56` gets this right —
one server, connected once, reused across requests.

Beyond the leak, it breaks Streamable HTTP session semantics: `sessionIdGenerator`
mints a new session id per request, so nothing can resume against it and the
initialize/notify handshake has no server to land on.

- Cache the server and transport per workspace id, keyed alongside the live
  workspace, and dispose both when the workspace closes or ends.
- Keep the per-request work to what actually varies: `actorId`, `agentRole`,
  `language`. Note that the generated tool surface depends on `agentRole` and
  `language`, so the cache key must include them or the surface must be applied
  per request rather than baked at construction.

Done when N requests to one workspace construct one server, and an MCP client can
complete an initialize-then-call session against the hub endpoint.

**Reproduced 2026-08-23** against a running `examples/voice-board-azure`, which
raises this from a code reading to a confirmed break:

```
POST /mcp/w/voice-board-1  initialize  → 200, mcp-session-id: f728155c-…
POST /mcp/w/voice-board-1  tools/list  → {"error":{"code":-32000,
                                          "message":"Bad Request: Server not initialized"}}
```

The session id comes back and then means nothing, because the next request gets
a different transport. The hub MCP endpoint is unusable past `initialize` by any
compliant client — this is not merely a leak.

---

## 4. P1 — blocks a second replica or an untrusted caller

### 4.1 No durable `WorkspaceRegistry` implementation

`packages/hub/src/registry.ts`

`MemoryWorkspaceRegistry` is the only implementation that ships. The README is
honest — "fine for one host, wrong for two" — but the consequence is that
**collabnode cannot run two replicas today** without the consumer writing the
registry themselves.

The protocol is already designed for it and `Hub.open` uses it correctly
(`packages/hub/src/hub.ts:116` claims a lease, waits out a concurrent seeder,
releases at line 180). What is missing is a backing store.

- Ship a Postgres `WorkspaceRegistry` (`claim` / `heartbeat` / `release`, `get` /
  `put` / `delete` / `list` / `due`) — Postgres because `@collabnode/age`
  already pulls `pg`, so it adds no new dependency for the AGE-shaped consumer.
- Lease claim must be atomic and expiry-aware in one statement
  (`INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now()`), not read-then-write.
- `due()` needs an index on `(state, …)` — the memory implementation scans, which
  is fine in a Map and not fine in a table.
- Run the existing `packages/hub/tests/registry.test.ts` against both
  implementations from one shared suite.

Done when two hub processes against one Postgres open the same id concurrently,
seed exactly once, and reap exactly once.

### 4.2 Replicas double-write a shared AGE projection

`benchmark_results.md` records it plainly: "Two projectors on the same AGE graph
duplicate edges."

Each `Projector` independently diffs its own CRDT view and writes the result to
the store. With `projection: shared` and two replicas holding the same workspace
open, both write, and `upsertEdge` — which deletes then re-creates
(`packages/age/src/cypher.ts:58-64`) — races into duplicates.

Together with §4.1 this means horizontal scaling is unsolved rather than merely
unimplemented, so the two should be scheduled together.

Options, cheapest first:

- **Elect a projector per workspace** off the same registry lease that §4.1
  provides. One replica projects; the others run `projection: none` and read
  through the shared store. Smallest change, keeps the lease as the single
  coordination primitive.
- Make edge upsert genuinely idempotent (`MERGE` on `collabId` rather than
  delete-then-create), which narrows the window but does not close it for
  concurrent property writes.

Done when two replicas holding one workspace produce a projection identical to
one replica's, asserted against live AGE.

### 4.3 `autoOpenType` is unauthenticated workspace creation

`packages/mcp/src/hub-handler.ts:62-68`

With `autoOpenType` set, any caller hitting `/mcp/w/<any-id>` mints a workspace.
There is no cap, no rate limit, and no authentication in the default path —
`agentRoleFrom` is opt-in and the fallback is a caller-supplied `?role=`.

- Require `actorFrom` (or an explicit opt-out) before `autoOpenType` will open
  anything.
- Add a per-hub cap on live workspaces and a per-actor open rate limit, both
  refusing with 429 rather than allocating.
- Document that `?role=` steers a cooperative agent and confines nothing — the
  README says this; the handler's defaults do not reflect it.

Done when an unauthenticated caller cannot cause an allocation.

### 4.4 `graph_query` read-only guard is a regex deny-list

`packages/runtime/src/tools.ts:78-79`, and the limit at `:973` / `:983`

```
/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD\s+CSV|WRITE)\b/i
```

A deny-list regex is the wrong shape for a boundary standing in front of an LLM.
It is over-inclusive in practice — `MATCH (n:Note) WHERE n.title = 'Delete me'
RETURN n` is refused because the keyword appears in a string literal — and a
deny-list can only ever be as complete as its author's memory of the dialect.

Separately, `limit` is applied *after* the full result materializes: `clampLimit`
at line 973 is only consulted at line 983 to slice rows the engine has already
returned. A cartesian `MATCH (a),(b),(c)` exhausts memory before the limit is
ever reached.

- Enforce read-only at the engine: a read-only Postgres role or
  `SET TRANSACTION READ ONLY` for AGE, and the equivalent for Ladybug.
- Push `LIMIT` into the query rather than slicing afterwards.
- Set a statement timeout, so a pathological query fails instead of hanging.
- Keep the regex, demoted to a fast friendly error — not the boundary.

Done when a write query is refused by the engine with the guard disabled, and a
cartesian query fails on timeout rather than on memory.

### 4.5 Schema property names are not identifier-validated

`packages/schema/src/parse.ts:30-36`, `packages/age/src/cypher.ts:18-29`

`assignments()` interpolates property *names* into Cypher unescaped
(`${alias}.${key} = ${literal(value)}`). Values are escaped; names are not.
`assertPropertyMap` rejects only `id` and `_`-prefixed names — there is no
identifier pattern, so a property named `x} SET n.admin = true //` reaches the
engine intact.

This is contained today, because schemas are trusted operator config rather than
user input. It stops being contained the moment a host lets tenants upload their
own workspace-type YAML — which the hub's whole shape invites.

Node and edge *types* are already checked (`assertLabel`,
`packages/age/src/names.ts:36`). Properties should match.

- Require `/^[A-Za-z][A-Za-z0-9_]*$/` on property names at parse time, so the
  failure is a load error naming the property rather than a query error.

Small, permanent, and closes the door before anyone opens it.

---

## 5. P2 — scale and operability

### 5.1 Fluid and AGE are the least-tested backends

Coverage is inverted relative to risk. The two backends a consumer would actually
deploy are the two with the least verification behind them:

| Package | src | test | What the tests actually cover |
|---|---:|---:|---|
| `fluid` | 1402 | 325 | Codec round-trips, Tinylicious process management, one text-peer test. **No multi-peer replication.** |
| `age` | 732 | 216 | An injected fake client. **Never a live Postgres in CI.** |
| `hocuspocus` | 1145 | 461 | Genuine two-peer replication, hash mismatch, joining a populated document. |

`hocuspocus` is the model to copy.

- Port the `hocuspocus/tests/backend.test.ts` scenarios to Fluid against
  Tinylicious: two peers replicate, a joiner sees prior state, a hash mismatch
  is refused, text properties merge.
- Add an AGE service container to CI and run the store tests against it. The
  `examples/age-board` Compose file already provisions one.

### 5.2 Projector diffs the whole graph on every change

`packages/runtime/src/projector.ts:73` and `:106`

Every CRDT change calls `graph.snapshot()` and then `diffSnapshots()` — both
linear in graph size, per change. The code comments acknowledge this, and the
250 ms debounce softens keystroke bursts but not concurrent structural writes,
which do not take the debounce path.

Fine at retro-board scale. A wall at a few thousand nodes with active writers.

- Have `CollaborativeGraph.subscribe` deliver the changed keys alongside the
  snapshot; both the Yjs and SharedTree layers know them and currently discard
  the information.
- Fall back to a full diff only when a backend cannot report them.

Worth measuring before building: `packages/bench` already has the harness, and
the crossover point decides whether this is P2 or lower.

### 5.3 No observability seam

Ten hardcoded `console.warn` calls across `packages/graph/src/memory.ts:181`,
`packages/ladybug/src/store.ts` (six), and
`packages/fluid/src/tinylicious-process.ts:87`. No logger injection, no metrics,
no tracing.

The sharpest case is `packages/hub/src/reaper.ts:44`, which swallows every sweep
exception to keep the timer alive. That is the right behaviour and the wrong
ending: workspaces would silently stop being reaped with nothing to observe.

- Accept an optional logger on `init()` / `createHub()` and thread it through;
  default to the current `console` behaviour so nothing changes for a consumer
  who does not pass one.
- Give `Reaper` an `onError` hook.
- Counters worth having: workspaces open, sweeps run, sweep failures, projection
  lag, query duration.

### 5.4 Ladybug is one workspace per store

`packages/ladybug` refuses a second workspace out loud, and
`benchmark_results.md` records a process-local ceiling near four in-process
databases (mmap) — a Ladybug limit, not a CRDT failure. It is also a 0.19.x
dependency.

No code change. The README should say plainly that Ladybug is single-workspace
and experimental, so it is not selected for a hub that opens many.

---

## 6. Suggested order

1. **§3.1, §3.2, §3.3** together — three contained fixes, and the two security
   ones are the only items on this list that are actively misleading rather than
   merely missing.
2. **§4.5** alongside them: five lines, and it closes a door permanently.
3. **§4.1 then §4.2** as one piece of work — the elected-projector fix in §4.2
   wants the durable lease from §4.1, so doing them apart means doing the
   coordination twice.
4. **§4.3, §4.4** before any untrusted caller reaches the MCP endpoint.
5. **§5.1** before trusting any of the above under load; **§5.2** only after
   measuring where the crossover actually is.

---

## 7. Changelog

### 2026-08-23 — §3.1, §3.2, §4.1 landed

Done as one piece of work, driven by an actual deployment target (Azure Fluid
Relay `eu.fluidrelay.azure.com` plus Azure Managed Redis). `examples/voice-board-azure`
is the voice-board sample on that infrastructure, and it is what exercises all
three.

**§3.1 — tokens are signed.** `packages/azure/src/token.ts` is new:
`signAzureFluidToken` emits an HS256 JWT carrying the claims the relay fixes
(`documentId`, `scopes`, `tenantId`, `user`, `iat`, `exp`, `ver`, `jti`).
`staticKeyTokenProvider` uses it, and the `keyHint` leak is gone.
`azureRelayFromEnv()` will now build a provider from `AZURE_FLUID_KEY` when no
explicit one is passed.

Verified against the live relay, not only in tests: a container was created and
attached, written to, and rejoined by a second peer.

**§3.2 — the token route authorizes.** `createFluidTokenHandler` now requires an
`authorize({ documentId, user, request })` callback and refuses to construct
without one; a missing `documentId` is a 400 rather than a tenant-wide token, a
throwing `user()` is a 401, and a rejected `authorize` is a 403. The old
signature is a breaking change on purpose — a silent default would have been a
deny-list of one.

**§4.1 — `@collabnode/redis`.** `RedisWorkspaceRegistry` implements the full
`WorkspaceRegistry` contract over three key shapes; the lease is a `SET NX PX`,
so expiry belongs to Redis rather than to a timer in a process that may already
be gone, and heartbeat/release are compare-and-set through Lua. Every command
addresses exactly one key, so a clustered endpoint is fine. Tests mirror
`packages/hub/tests/registry.test.ts` against an in-process fake.

*Not* verified against the live Redis: the endpoint refuses connections from
outside its firewall. The registry contract is covered by tests; the connection
string and TLS handling are not yet proven end to end.

**Also fixed, found on the way:** `FluidCollabBackend`'s `close()` called
`container.dispose()` immediately, dropping ops that had not yet been
acknowledged. Invisible against Tinylicious on localhost; against a hosted relay
it is a network round trip, and a write made just before shutdown was lost.
`close()` now waits for the container to go clean, bounded by a timeout.
Reproduced and confirmed fixed against the live relay.

**Still open from the original P0 trio:** §3.3, the per-request MCP server and
transport leak. Untouched.

### 2026-08-23 — §3.3 landed

`createHubMcpHandler` now serves through `createMcpHandler`, the SDK's own
handler entry — the same one `createGraphMcpHandler` already used on the
single-document path. The hand-rolled
`WebStandardStreamableHTTPServerTransport` per request is gone, and with it both
symptoms: nothing is constructed that is never closed, and a client's follow-up
requests are answered by the SDK's stateless legacy fallback instead of landing
on a transport that has never seen an `initialize`.

This resolves the item differently from how §3.3 proposed it. The proposal was
to cache one server per workspace; the fix constructs per request, as the
single-document path does. That is deliberate. The defect was never
per-request construction — it was construction without lifecycle. Caching would
also have had to key on `agentRole` and `language`, which the item itself flags,
and `?lang=es` returning a Spanish tool surface from the same workspace is
behaviour worth keeping simple.

**Breaking:** `createHubMcpHandler` returns an `McpHttpHandler` — `{ fetch,
close, notify, bus }` — rather than a bare function, matching
`createGraphMcpHandler`. Call sites move from `handler(request)` to
`handler.fetch(request)`. `serveHubMcpHttp` is unchanged from the outside and
now closes the handler on shutdown.

Covered by a regression test that walks `initialize` → `tools/list` →
`tools/call` → `prompts/list` and asserts the call reached the workspace the
path names; it fails against the previous implementation. Confirmed live against
a running `examples/voice-board-azure`, including a write through
`upsert_node_Note` that showed up in the board, and `?lang=es` still switching
the tool surface per request.
