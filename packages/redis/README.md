# @collabnode/redis

Redis-backed [`WorkspaceRegistry`](https://github.com/eduardpaul/collabnode/tree/main/packages/hub) for [collabnode](https://github.com/eduardpaul/collabnode).

The Hub's default registry is `memoryRegistry()` — per process, which is correct
right up to the moment there are two. Swap this in and the same leasing, the
same reaper, and the same idempotent `hub.open()` hold across replicas.

```bash
npm install @collabnode/redis ioredis
```

`ioredis` is an optional peer dependency: install it to open a client from a
URL, or pass your own.

## Usage

```ts
import { createHub } from "collabnode";
import { redisRegistry } from "@collabnode/redis";

const hub = await createHub({
  collab: backend,
  registry: await redisRegistry({ url: process.env.REDIS_URL }),
  // With more than one replica, drive sweep() from a cron or one elected
  // replica rather than letting every process run its own timer.
  sweepIntervalMs: 0,
});
```

Azure requires TLS, so the scheme is `rediss://` and the access key goes in the
password position:

```
rediss://:<access-key>@my-cache.redis.cache.windows.net:6380   # Azure Cache for Redis
rediss://:<access-key>@my-cache.<region>.redis.azure.net:10000 # Azure Managed Redis
```

Sharing one client across the registry and your own keys is fine, and saves a
connection:

```ts
const redis = await createRedisClient(process.env.REDIS_URL);
const registry = await redisRegistry({ client: redis, prefix: "my-app" });
```

## What it stores

| Key | Holds |
| --- | --- |
| `{prefix}:ws:{id}` | the `WorkspaceRecord`, as JSON |
| `{prefix}:lease:{id}` | the lease token, with the TTL doing the expiry |
| `{prefix}:index` | the set of known ids, for `list()` and `due()` |

The lease is a plain `SET NX PX`, so expiry belongs to Redis rather than to a
timer in a process that may already be gone. Heartbeat and release are
compare-and-set through Lua: a replica never renews or deletes a lease it does
not hold.

Every command addresses exactly one key, which is what lets the same code run
against a single node, an OSS-cluster endpoint, and Azure Managed Redis.

## Exports

- `redisRegistry`, `RedisWorkspaceRegistry`, `RedisRegistryOptions` — the registry
- `createRedisClient`, `RedisLike` — the client, and the command surface it needs

`RedisLike` is deliberately narrow and shaped like `ioredis`, so any client with
those commands works without this package depending on a driver.

---

Part of [collabnode](https://github.com/eduardpaul/collabnode).

MIT © Eduard Paul
