import { describe, expect, it } from "vitest";
import { runBench } from "../src/run.ts";
import type { BenchOptions } from "../src/types.ts";

function memoryHot(overrides: Partial<BenchOptions> = {}): BenchOptions {
  return {
    backends: ["memory"],
    graphs: ["memory"],
    backend: "memory",
    graph: "memory",
    scenarios: ["writes", "concurrency", "lag", "snapshot", "join"],
    ops: 20,
    concurrency: 2,
    size: 20,
    json: true,
    port: 7070,
    ...overrides,
  };
}

describe("bench smoke", () => {
  it("runs every hot-path scenario on memory without errors", async () => {
    const rows = await runBench(memoryHot());
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.backend).toBe("memory");
      expect(row.graph).toBe("memory");
      expect(row.errors).toBe(0);
      expect(row.n).toBeGreaterThan(0);
      expect(row.p50Ms).toBeGreaterThanOrEqual(0);
    }
    const writes = rows.find((row) => row.scenario === "writes");
    expect(writes?.opsPerSec).toBeGreaterThan(0);
  }, 30_000);
});
