# Voice Board on Azure

The [voice-board](../voice-board) sample, unchanged as an application, wired to
hosted infrastructure instead of a local one:

| | voice-board | voice-board-azure |
| --- | --- | --- |
| CRDT transport | Tinylicious, spawned on `localhost:7070` | **Azure Fluid Relay** |
| Workspace registry | `memoryRegistry()`, private to one process | **Redis**, shared by every replica |
| Browser credentials | none needed | **per-document token** from `/api/fluid/token` |
| Replicas | exactly one | as many as you like |

Everything else — the boards, the voice agent, the MCP mounts, the two
languages, the generated tools — is the same code. For how the app itself works,
read [the original sample's README](../voice-board/README.md); this one is about
what it takes to deploy it.

```bash
pnpm build
cp examples/voice-board-azure/.env.example examples/voice-board-azure/.env   # then fill it in
pnpm --filter @collabnode/example-voice-board-azure start
```

- http://127.0.0.1:4176?as=ada
- http://127.0.0.1:4176?as=chidi

## Configuration

```
AZURE_FLUID_TENANT_ID=<tenant-guid>
AZURE_FLUID_ENDPOINT=https://<region>.fluidrelay.azure.com
AZURE_FLUID_KEY=<primary-or-secondary-key>

REDIS_URL=rediss://:<access-key>@<host>:10000
REDIS_PREFIX=voice-board
```

Tenant id, endpoint, and key are on the Fluid Relay resource's **Access
Information** blade. The Redis URL is `rediss://` — TLS — because neither Azure
Managed Redis (port 10000) nor Azure Cache for Redis (port 6380) accepts a
plaintext connection; the access key goes in the password position with no
username in front of it.

Both are read at boot and both throw if absent. That is deliberate: a board that
quietly falls back to Tinylicious and an in-process registry looks like it works
right up until the second replica disagrees with the first about what exists.

Voice Live is still optional. Without it the boards work and the mic button does
not.

## The tenant key never reaches the browser

The Fluid tenant key is a bearer credential for the *whole tenant*: whoever
holds it can read and write every document in it. So the server keeps it, and
browsers ask [`/api/fluid/token`](src/server.ts) for a token scoped to one
document.

That route is `createFluidTokenHandler`, and it takes two callbacks that answer
two different questions:

```ts
const fluidToken = createFluidTokenHandler({
  tenantId: fluid.tenantId,
  tenantKey: fluid.key,
  user: (_request, { actorId }) => ({ id: actorId || "guest" }),  // who is asking
  authorize: hubDocumentAuthorizer(hub),                          // may they have it
});
```

`authorize` is required, and it is the whole point of the route. Without it the
handler mints a writable token for whatever `documentId` the caller put in the
request body — including documents belonging to a different app in the same
tenant. `hubDocumentAuthorizer` is the narrowest useful check: a token is only
issued for a document *this hub actually opened*. It asks the registry by
document id, so it costs one lookup rather than a scan of every live board.

The `actorId` the browser sends is this sample's stand-in for a login and is
exactly as trustworthy as that sounds. A real deployment resolves the user from
a session or a bearer token and adds a board-membership check on top of
`hubDocumentAuthorizer`. What the authorizer guarantees regardless is that the
document is one of ours.

The browser side is nothing at all. The server names the route when it opens the
relay:

```ts
await openCollab({ kind: "fluid", relay: "azure", tokenEndpoint: "/api/fluid/token" }, "server");
```

That travels in the join descriptor — a URL is not a secret — and
[`connect()`](src/client.ts) builds the token provider from it, sending the
`actorId` it was given. Delete the `.env` and the same app runs on Tinylicious,
which needs no token at all.

## Redis is what makes a second replica possible

The Hub coordinates through a `WorkspaceRegistry`: leases for create-or-join
mutual exclusion, records of what is open, and the reaper's view of what is due
to end. `memoryRegistry()` keeps all of that in one process, which is correct
right up to the moment there are two.

```ts
const redis = await createRedisClient(redisConnection);
const hub = await createHub({
  collab: collabBackend,
  registry: await redisRegistry({ client: redis, prefix }),
  sweepIntervalMs: 0,
});
```

Three things follow from that swap:

- **`hub.open()` is idempotent across hosts.** The lease is a `SET NX PX`, so
  expiry is Redis's job rather than a timer inside a process that may already be
  gone. Two replicas racing to open the same board: one seeds it, the other
  waits and joins.
- **`collabDocId` survives.** Fluid mints its own document ids, so the mapping
  from workspace id to Fluid document lives in the registry record. In memory,
  restarting the process orphans every board. In Redis, a new replica finds them.
- **The reaper needs an owner.** `sweepIntervalMs: 0` leaves the internal timer
  off; with more than one replica, exactly one should drive `hub.sweep()` — from
  a cron, or from a replica that has elected itself by claiming a lease — rather
  than all of them racing. Termination *is* lease-guarded either way, so the
  worst case is wasted work, not a double-ended board.

Board names ride along on the record. Ids have to stay URL- and MCP-path-safe,
so the name someone typed cannot be one; `hub.open({ label })` stores it on the
`WorkspaceRecord`, which means the homepage shows boards created on another
replica under their real names without a second store to keep in step.

## What a second replica actually looks like

```bash
VOICE_BOARD_PORT=4176 pnpm --filter @collabnode/example-voice-board-azure start
VOICE_BOARD_PORT=4177 pnpm --filter @collabnode/example-voice-board-azure start
```

(Vite's HMR socket binds one fixed port, so the second process logs
`Port 24678 is already in use` and carries on without hot reload. That is a dev
server artifact of running two replicas on one machine, not a deployment
concern.)

Create a board on 4176 and it appears on 4177's homepage, because the registry
record is shared. Opening it there is a *join*: `hub.open()` reads
`collabDocId` from the record and attaches to the same Fluid document rather
than creating a second one. Type into both tabs and the text merges — that part
was always true; what is new is that the two servers agree on which document
they are talking about.

The homepage does that join lazily, in
[`BoardDirectory.list()`](src/boards.ts) — a card needs live node and edge
counts, and a replica can only count a board it has attached to.

## Things worth knowing

- **Projections stay per-replica.** Both board types declare
  `projection: memory`, so each replica builds its own in-memory index of the
  same CRDT. That is fine — the CRDT is the source of truth and the projection
  is disposable — but it means `graph_search` results are per-replica-warm, and
  it is *not* the arrangement you want with `projection: shared` against one
  store, where two projectors writing the same graph duplicate edges.
- **Shutdown flushes.** Fluid sends ops asynchronously and `dispose()` drops
  whatever has not been acknowledged. On localhost that window is invisible;
  against a hosted relay it is a network round trip, long enough to lose the
  last write of a replica that is shutting down. `close()` waits for the
  container to go clean first (bounded by a timeout, so an unreachable relay
  cannot hang the shutdown).
- **Redis is on the request path.** `open`, `join`, and MCP routing all consult
  the registry, so the client is configured with a bounded retry rather than an
  unbounded queue: an outage should surface as failing requests, not as a
  process quietly growing until it dies.
- **One connection, two jobs.** The registry and the board-name store share a
  client, so each replica holds one TLS connection to Redis.
- **Clustering is accounted for.** Azure Managed Redis can be clustered, so
  every command the registry issues addresses exactly one key — there is no
  multi-key `MGET` to land on the wrong slot.
- **MCP points at a board, not at the app.** Each board is its own endpoint —
  `/mcp/w/<board-id>` — so an agent is never handed a workspace id it could
  tamper with, and `?lang=es` on that URL gets a Spanish tool surface out of the
  same board.

## What was actually verified

Against the real services, not only in tests:

| | |
| --- | --- |
| Signed tokens open a container | yes — created, attached, and written to on `eu.fluidrelay.azure.com` |
| A second peer joins with a `/api/fluid/token` token | yes — same document, same contents |
| An unauthorized `documentId` | 403; a missing one, 400 |
| Both boards seed on the relay at boot | yes |
| `collabDocId` persists in the registry | yes — replica 2 joins the same document id, not a new one |
| A board created on one replica appears on the other, by name | yes |
| Shutdown does not lose the last write | yes — reproduced the loss, then the fix |
| A full MCP session against a board | yes — `initialize` → `tools/list` → `tools/call`, and the write landed |
| The listed Azure Managed Redis endpoint | **no** — unreachable, see below |

The Redis work was verified against a local Redis 7, because the Azure Managed
Redis instance it was pointed at refused connections on both 10000 and 6380 from
outside its firewall. Outbound traffic on those ports was fine from the test
host, so that is an access rule on the cache rather than a client problem. The
registry contract is covered by tests; the TLS handshake and connection string
against Azure specifically are not yet proven.
