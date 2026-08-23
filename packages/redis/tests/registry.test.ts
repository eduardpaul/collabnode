import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "@collabnode/hub";
import { redisRegistry, RedisWorkspaceRegistry } from "../src/index.ts";
import { FakeRedis } from "./fake-redis.ts";

function registry(prefix = "test"): RedisWorkspaceRegistry {
  return new RedisWorkspaceRegistry(new FakeRedis(), { prefix });
}

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const now = new Date().toISOString();
  return {
    id: "retro-1",
    typeName: "retro",
    version: 1,
    params: { sprint: 42 },
    state: "active",
    openedAt: now,
    lastActivityAt: now,
    lastWriteAt: now,
    ...overrides,
  };
}

// The assertions mirror packages/hub/tests/registry.test.ts on purpose: both
// implementations answer to the same WorkspaceRegistry contract, and the hub
// cannot tell them apart.
describe("RedisWorkspaceRegistry", () => {
  it("claims a lease and prevents concurrent claims until released or expired", async () => {
    const reg = registry();
    const lease1 = await reg.claim("ws-1", 1000);
    expect(lease1).toBeDefined();
    expect(lease1?.id).toBe("ws-1");

    const lease2 = await reg.claim("ws-1", 1000);
    expect(lease2).toBeUndefined();

    await reg.release(lease1!);

    const lease3 = await reg.claim("ws-1", 1000);
    expect(lease3).toBeDefined();
  });

  it("lets the lease expire on its own so a dead replica does not hold it", async () => {
    const reg = registry();
    const lease = await reg.claim("ws-expiry", 20);
    expect(lease).toBeDefined();

    await new Promise((r) => setTimeout(r, 40));
    // Nothing released it: the TTL did, which is the point of putting expiry in
    // Redis rather than in a timer inside the process that took the lease.
    expect(await reg.claim("ws-expiry", 1000)).toBeDefined();
  });

  it("allows heartbeat to extend lease", async () => {
    const reg = registry();
    const lease = (await reg.claim("ws-heartbeat", 100))!;
    const initialExpires = lease.expiresAt;

    await new Promise((r) => setTimeout(r, 20));
    const ok = await reg.heartbeat(lease, 500);
    expect(ok).toBe(true);
    expect(lease.expiresAt).toBeGreaterThan(initialExpires);

    const fakeLease = { id: "ws-heartbeat", token: "wrong-token", expiresAt: 0 };
    expect(await reg.heartbeat(fakeLease, 500)).toBe(false);
  });

  it("refuses to release a lease held by someone else", async () => {
    const reg = registry();
    const held = (await reg.claim("ws-steal", 1000))!;

    await reg.release({ id: "ws-steal", token: "not-the-holder", expiresAt: 0 });

    // The real holder still has it.
    expect(await reg.claim("ws-steal", 1000)).toBeUndefined();
    expect(await reg.heartbeat(held, 1000)).toBe(true);
  });

  it("stores, retrieves, lists, and deletes records", async () => {
    const reg = registry();
    await reg.put(record());

    const stored = await reg.get("retro-1");
    expect(stored?.typeName).toBe("retro");
    expect(stored?.params).toEqual({ sprint: 42 });

    expect(await reg.list({ state: "active" })).toHaveLength(1);
    expect(await reg.list({ typeName: "retro" })).toHaveLength(1);
    expect(await reg.list({ state: "ended" })).toHaveLength(0);
    expect(await reg.due(Date.now())).toHaveLength(1);

    await reg.delete("retro-1");
    expect(await reg.get("retro-1")).toBeUndefined();
    expect(await reg.list()).toHaveLength(0);
  });

  it("caps due() at the requested limit", async () => {
    const reg = registry();
    for (let i = 0; i < 5; i++) {
      await reg.put(record({ id: `ws-${i}` }));
    }
    expect(await reg.due(Date.now(), 2)).toHaveLength(2);
  });

  it("records the lease on the workspace record and clears it on release", async () => {
    const reg = registry();
    await reg.put(record({ id: "ws-lease" }));

    const lease = (await reg.claim("ws-lease", 1000))!;
    expect((await reg.get("ws-lease"))?.leaseToken).toBe(lease.token);

    await reg.release(lease);
    expect((await reg.get("ws-lease"))?.leaseToken).toBeUndefined();
  });

  it("keeps namespaces apart", async () => {
    const shared = new FakeRedis();
    const a = new RedisWorkspaceRegistry(shared, { prefix: "app-a" });
    const b = new RedisWorkspaceRegistry(shared, { prefix: "app-b" });

    await a.put(record({ id: "same-id" }));
    expect(await b.get("same-id")).toBeUndefined();
    expect(await b.claim("same-id", 1000)).toBeDefined();
    expect(await a.claim("same-id", 1000)).toBeDefined();
  });

  it("requires a url or a client", async () => {
    await expect(redisRegistry({})).rejects.toThrow(/url.*client/i);
  });

  it("accepts an injected client", async () => {
    const reg = await redisRegistry({ client: new FakeRedis(), prefix: "injected" });
    expect(await reg.claim("ws-injected", 1000)).toBeDefined();
  });
});

describe("RedisWorkspaceRegistry document index", () => {
  it("finds a workspace by the document it is running on", async () => {
    const reg = registry();
    await reg.put(record({ id: "retro-1", collabDocId: "doc-abc" }));

    const found = await reg.findByCollabDocId("doc-abc");
    expect(found?.id).toBe("retro-1");
    expect(await reg.findByCollabDocId("doc-nope")).toBeUndefined();
  });

  it("drops the pointer when the workspace is deleted", async () => {
    const reg = registry();
    await reg.put(record({ id: "retro-1", collabDocId: "doc-abc" }));
    await reg.delete("retro-1");

    expect(await reg.findByCollabDocId("doc-abc")).toBeUndefined();
  });

  it("ignores a pointer whose record is gone", async () => {
    const redis = new FakeRedis();
    const reg = new RedisWorkspaceRegistry(redis, { prefix: "test" });
    await reg.put(record({ id: "retro-1", collabDocId: "doc-abc" }));

    // An eviction takes the record but leaves the pointer behind.
    await redis.del("test:ws:retro-1");
    expect(await reg.findByCollabDocId("doc-abc")).toBeUndefined();
    // …and the stale pointer is not left to be answered a second time.
    expect(await redis.get("test:doc:doc-abc")).toBeNull();
  });

  it("round-trips the label a person gave the workspace", async () => {
    const reg = registry();
    await reg.put(record({ id: "retro-1", label: "Sprint 42 retro" }));

    expect((await reg.get("retro-1"))?.label).toBe("Sprint 42 retro");
    expect((await reg.list())[0]?.label).toBe("Sprint 42 retro");
  });
});
