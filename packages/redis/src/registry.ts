import { randomUUID } from "node:crypto";
import type {
  Lease,
  WorkspaceRecord,
  WorkspaceRegistry,
  WorkspaceState,
} from "@collabnode/hub";
import { createRedisClient, type RedisLike } from "./client.js";

/**
 * Extend a lease only if we still hold it. `GET` then `PEXPIRE` from the client
 * would leave a window in which the lease expires, another replica claims it,
 * and this one renews the winner's lease out from under it.
 */
export const LUA_HEARTBEAT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

/** Same reason as heartbeat: never delete a lease token that is not ours. */
export const LUA_RELEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface RedisRegistryOptions {
  /** Connection URL. Use `rediss://` for Azure. Ignored when `client` is given. */
  url?: string;
  /** An existing client — anything with the `RedisLike` command surface. */
  client?: RedisLike;
  /** Key namespace. Defaults to `collabnode`. */
  prefix?: string;
}

/**
 * `WorkspaceRegistry` over Redis: the same leasing, the same reaper, and the
 * same idempotent `hub.open()` as `memoryRegistry()`, but shared by every
 * replica instead of private to one process.
 *
 * Three key shapes, all single-key per command:
 *
 * - `{prefix}:ws:{id}`    the `WorkspaceRecord`, as JSON
 * - `{prefix}:lease:{id}` the lease token, with the TTL doing the expiry
 * - `{prefix}:index`      the set of known ids, for `list()` and `due()`
 * - `{prefix}:doc:{docId}` the id of the workspace on that collab document
 *
 * The lease is a plain `SET NX PX`, so expiry is Redis's job rather than a
 * timer in some process that may already be gone.
 */
export class RedisWorkspaceRegistry implements WorkspaceRegistry {
  private readonly redis: RedisLike;
  private readonly prefix: string;
  private readonly ownsClient: boolean;

  constructor(client: RedisLike, options: { prefix?: string; ownsClient?: boolean } = {}) {
    this.redis = client;
    this.prefix = options.prefix ?? "collabnode";
    this.ownsClient = options.ownsClient ?? false;
  }

  async claim(id: string, ttlMs: number): Promise<Lease | undefined> {
    const token = randomUUID();
    const result = await this.redis.set(this.leaseKey(id), token, "PX", ttlMs, "NX");
    if (result === null || result === undefined) {
      return undefined;
    }
    const expiresAt = Date.now() + ttlMs;

    // Mirror the lease onto the record when there is one, so an operator
    // reading the registry sees who holds it without a second lookup.
    const record = await this.get(id);
    if (record) {
      await this.put({ ...record, leaseToken: token, leaseExpiresAt: expiresAt });
    }
    return { id, token, expiresAt };
  }

  async heartbeat(lease: Lease, ttlMs: number): Promise<boolean> {
    const held = await this.redis.eval(LUA_HEARTBEAT, 1, this.leaseKey(lease.id), lease.token, ttlMs);
    if (Number(held) !== 1) {
      return false;
    }
    const expiresAt = Date.now() + ttlMs;
    lease.expiresAt = expiresAt;

    const record = await this.get(lease.id);
    if (record && record.leaseToken === lease.token) {
      await this.put({ ...record, leaseExpiresAt: expiresAt });
    }
    return true;
  }

  async release(lease: Lease): Promise<void> {
    const released = await this.redis.eval(LUA_RELEASE, 1, this.leaseKey(lease.id), lease.token);
    if (Number(released) !== 1) {
      return;
    }
    const record = await this.get(lease.id);
    if (record && record.leaseToken === lease.token) {
      const { leaseToken: _token, leaseExpiresAt: _expires, ...rest } = record;
      await this.put(rest);
    }
  }

  async due(_now: number, limit = 50): Promise<WorkspaceRecord[]> {
    const active = await this.list({ state: "active" });
    return active.slice(0, limit);
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    const raw = await this.redis.get(this.recordKey(id));
    return raw ? (JSON.parse(raw) as WorkspaceRecord) : undefined;
  }

  async put(record: WorkspaceRecord): Promise<void> {
    await this.redis.set(this.recordKey(record.id), JSON.stringify(record));
    await this.redis.sadd(this.indexKey(), record.id);
    if (record.collabDocId) {
      // Reverse index for `findByCollabDocId`. Written on every put rather than
      // once, because the document id only exists after the workspace attaches
      // and the record is put again to mark it active.
      await this.redis.set(this.docKey(record.collabDocId), record.id);
    }
  }

  async delete(id: string): Promise<void> {
    const record = await this.get(id);
    await this.redis.del(this.recordKey(id));
    await this.redis.del(this.leaseKey(id));
    await this.redis.srem(this.indexKey(), id);
    if (record?.collabDocId) {
      await this.redis.del(this.docKey(record.collabDocId));
    }
  }

  /**
   * One GET, then the record. This is on the request path of every browser
   * asking for a relay token, which is why it is not a `list()` scan.
   */
  async findByCollabDocId(collabDocId: string): Promise<WorkspaceRecord | undefined> {
    const id = await this.redis.get(this.docKey(collabDocId));
    if (!id) {
      return undefined;
    }
    const record = await this.get(id);
    // The pointer can outlive its record — an eviction, or a crash between the
    // two deletes — so a stale one is dropped rather than believed.
    if (!record || record.collabDocId !== collabDocId) {
      await this.redis.del(this.docKey(collabDocId));
      return undefined;
    }
    return record;
  }

  async list(filter?: { state?: WorkspaceState; typeName?: string }): Promise<WorkspaceRecord[]> {
    const ids = await this.redis.smembers(this.indexKey());
    // One GET per id rather than one MGET: the ids hash to different slots, and
    // a clustered endpoint (Azure Managed Redis) refuses a cross-slot MGET.
    const records = await Promise.all(ids.map(async (id) => ({ id, record: await this.get(id) })));

    const results: WorkspaceRecord[] = [];
    const orphans: string[] = [];
    for (const { id, record } of records) {
      if (!record) {
        orphans.push(id);
        continue;
      }
      if (filter?.state && record.state !== filter.state) {
        continue;
      }
      if (filter?.typeName && record.typeName !== filter.typeName) {
        continue;
      }
      results.push(record);
    }
    // A record can be evicted or expire out from under the index; drop the
    // dangling ids rather than paying for them on every later list().
    await Promise.all(orphans.map((id) => this.redis.srem(this.indexKey(), id)));
    return results;
  }

  /** Closes the client, but only if this registry opened it. */
  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit?.();
    }
  }

  private recordKey(id: string): string {
    return `${this.prefix}:ws:${id}`;
  }

  private leaseKey(id: string): string {
    return `${this.prefix}:lease:${id}`;
  }

  private indexKey(): string {
    return `${this.prefix}:index`;
  }

  private docKey(collabDocId: string): string {
    return `${this.prefix}:doc:${collabDocId}`;
  }
}

export async function redisRegistry(
  options: RedisRegistryOptions,
): Promise<RedisWorkspaceRegistry> {
  if (options.client) {
    const settings: { prefix?: string; ownsClient?: boolean } = { ownsClient: false };
    if (options.prefix !== undefined) {
      settings.prefix = options.prefix;
    }
    return new RedisWorkspaceRegistry(options.client, settings);
  }
  if (!options.url) {
    throw new Error("redisRegistry requires either a `url` or an existing `client`");
  }
  const client = await createRedisClient(options.url);
  const settings: { prefix?: string; ownsClient?: boolean } = { ownsClient: true };
  if (options.prefix !== undefined) {
    settings.prefix = options.prefix;
  }
  return new RedisWorkspaceRegistry(client, settings);
}
