import { describe, expect, it } from "vitest";
import { memoryRegistry } from "../src/index.ts";

describe("memoryRegistry", () => {
  it("claims a lease and prevents concurrent claims until released or expired", async () => {
    const registry = memoryRegistry();
    const lease1 = await registry.claim("ws-1", 1000);
    expect(lease1).toBeDefined();
    expect(lease1?.id).toBe("ws-1");

    // Concurrent claim while lease is active returns undefined
    const lease2 = await registry.claim("ws-1", 1000);
    expect(lease2).toBeUndefined();

    // Release lease
    await registry.release(lease1!);

    // Can claim again after release
    const lease3 = await registry.claim("ws-1", 1000);
    expect(lease3).toBeDefined();
  });

  it("allows heartbeat to extend lease", async () => {
    const registry = memoryRegistry();
    const lease = (await registry.claim("ws-heartbeat", 100))!;
    const initialExpires = lease.expiresAt;

    await new Promise((r) => setTimeout(r, 20));
    const ok = await registry.heartbeat(lease, 500);
    expect(ok).toBe(true);
    expect(lease.expiresAt).toBeGreaterThan(initialExpires);

    // Heartbeat with wrong lease token fails
    const fakeLease = { id: "ws-heartbeat", token: "wrong-token", expiresAt: 0 };
    expect(await registry.heartbeat(fakeLease, 500)).toBe(false);
  });

  it("stores, retrieves, lists, and deletes records", async () => {
    const registry = memoryRegistry();
    await registry.put({
      id: "retro-1",
      typeName: "retro",
      version: 1,
      params: { sprint: 42 },
      state: "active",
      openedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastWriteAt: new Date().toISOString(),
    });

    const record = await registry.get("retro-1");
    expect(record?.typeName).toBe("retro");
    expect(record?.params).toEqual({ sprint: 42 });

    const activeList = await registry.list({ state: "active" });
    expect(activeList).toHaveLength(1);

    const retroList = await registry.list({ typeName: "retro" });
    expect(retroList).toHaveLength(1);

    const due = await registry.due(Date.now());
    expect(due).toHaveLength(1);

    await registry.delete("retro-1");
    expect(await registry.get("retro-1")).toBeUndefined();
  });
});
