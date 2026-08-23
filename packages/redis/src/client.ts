/**
 * The slice of a Redis client this registry uses.
 *
 * Deliberately narrow, and shaped like `ioredis` — variadic command arguments
 * rather than node-redis's options objects — so that a client can be handed in
 * from the outside without this package taking a hard dependency on any driver.
 *
 * Every command below addresses exactly one key. That is what lets the same
 * code run against a single node, an OSS-cluster endpoint, and Azure Managed
 * Redis: there is no multi-key `MGET` to land on the wrong slot.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface CreateRedisClientOptions {
  /**
   * Connection-level errors, which arrive as events rather than as rejections.
   * The failing command still rejects on its own; this is only about what gets
   * logged while the client retries. Defaults to one line on `console.error`.
   */
  onError?: (error: Error) => void;
}

/**
 * Opens an `ioredis` client for `url`.
 *
 * `rediss://` selects TLS, which is what Azure Cache for Redis (port 6380) and
 * Azure Managed Redis (port 10000) both require; the access key goes in the
 * password position:
 *
 *   rediss://:<access-key>@my-cache.redis.cache.windows.net:6380
 *   rediss://:<access-key>@my-cache.<region>.redis.azure.net:10000
 */
export async function createRedisClient(
  url: string,
  options: CreateRedisClientOptions = {},
): Promise<RedisLike> {
  let Redis: new (url: string, options?: unknown) => RedisLike;
  try {
    const mod = (await import("ioredis")) as unknown as {
      default?: new (url: string, options?: unknown) => RedisLike;
      Redis?: new (url: string, options?: unknown) => RedisLike;
    };
    const ctor = mod.Redis ?? mod.default;
    if (!ctor) {
      throw new Error("ioredis exported no Redis constructor");
    }
    Redis = ctor;
  } catch (error) {
    throw new Error(
      `Install peer dependency ioredis to open a Redis registry from a URL, or pass your own client. ${String(error)}`,
    );
  }
  const client = new Redis(url, {
    // The hub calls the registry on the request path (open, join, MCP routing),
    // so a queue that grows without bound while Redis is down turns an outage
    // into a memory leak. Fail the call instead and let the caller see it.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  // ioredis logs "Unhandled error event" with a full stack for every retry when
  // nothing is listening, which reads as a crash rather than as a cache that is
  // not answering. One line says the same thing.
  const onError =
    options.onError ??
    ((error: Error) => console.error(`[redis] ${error.message}`));
  client.on?.("error", onError);
  return client;
}
