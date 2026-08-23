import { LUA_HEARTBEAT, LUA_RELEASE, type RedisLike } from "../src/index.ts";

/**
 * An in-process stand-in for a Redis server, covering exactly the commands
 * `RedisWorkspaceRegistry` issues — including key expiry, which is what the
 * lease depends on.
 *
 * The two Lua scripts are recognised by identity against the constants the
 * registry exports rather than interpreted, so this fake stays honest about
 * *which* script ran while not pretending to be a Lua VM. The compare-and-set
 * semantics it implements are the ones those scripts have on a real server.
 */
export class FakeRedis implements RedisLike {
  private readonly strings = new Map<string, { value: string; expiresAt?: number }>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  async set(key: string, value: string): Promise<unknown>;
  async set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<unknown>;
  async set(
    key: string,
    value: string,
    mode?: "PX",
    ttlMs?: number,
    condition?: "NX",
  ): Promise<unknown> {
    if (condition === "NX" && this.read(key) !== null) {
      return null;
    }
    const entry: { value: string; expiresAt?: number } = { value };
    if (mode === "PX" && ttlMs !== undefined) {
      entry.expiresAt = Date.now() + ttlMs;
    }
    this.strings.set(key, entry);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<unknown> {
    const set = this.sets.get(key) ?? new Set<string>();
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.sets.set(key, set);
    return added;
  }

  async srem(key: string, member: string): Promise<unknown> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    const token = String(args[1]);
    if (this.read(key) !== token) {
      return 0;
    }
    if (script === LUA_HEARTBEAT) {
      const entry = this.strings.get(key)!;
      entry.expiresAt = Date.now() + Number(args[2]);
      return 1;
    }
    if (script === LUA_RELEASE) {
      this.strings.delete(key);
      return 1;
    }
    throw new Error("FakeRedis received an unknown script");
  }

  private read(key: string): string | null {
    const entry = this.strings.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }
}
