import { describe, expect, it } from "vitest";
import { HelpError, parseArgs } from "../src/args.ts";
import { formatTable } from "../src/report.ts";
import {
  lagBudgetMs,
  latencyStats,
  opsPerSec,
  quantile,
  sizeLadder,
  userLadder,
  warmupCount,
} from "../src/stats.ts";
import type { BenchRow } from "../src/types.ts";

describe("stats", () => {
  it("interpolates quantiles", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([4], 0.99)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it("summarizes latency and throughput", () => {
    const stats = latencyStats([1, 2, 3, 4, 100]);
    expect(stats.n).toBe(5);
    expect(stats.p50Ms).toBe(3);
    expect(stats.p99Ms).toBeGreaterThan(stats.p50Ms);
    expect(opsPerSec(2000, 1_000_000_000n)).toBe(2000);
    expect(opsPerSec(0, 1_000_000_000n)).toBeNull();
  });

  it("scales warmup down for short runs", () => {
    expect(warmupCount(2000)).toBe(50);
    expect(warmupCount(20)).toBe(2);
    expect(warmupCount(1)).toBe(0);
  });

  it("builds user and size ladders that include the max", () => {
    expect(userLadder(8)).toEqual([1, 2, 4, 8]);
    expect(userLadder(6)).toEqual([1, 2, 4, 6]);
    expect(sizeLadder(20)).toEqual([20]);
    expect(sizeLadder(5000)).toEqual([100, 500, 2000, 5000]);
  });

  it("uses a wider lag budget for AGE than in-memory", () => {
    expect(lagBudgetMs("memory", "memory")).toBe(250);
    expect(lagBudgetMs("memory", "ladybug")).toBe(500);
    expect(lagBudgetMs("memory", "age")).toBe(1_500);
    expect(lagBudgetMs("fluid", "age")).toBe(3_000);
    expect(lagBudgetMs("hocuspocus", "memory")).toBe(3_000);
  });
});

describe("args", () => {
  it("defaults to the hot-path memory suite", () => {
    expect(parseArgs([])).toMatchObject({
      backend: "memory",
      graph: "memory",
      backends: ["memory"],
      graphs: ["memory"],
      ops: 2000,
      concurrency: 8,
      size: 5000,
      json: false,
    });
    expect(parseArgs([]).scenarios).toEqual(["writes", "concurrency", "lag", "snapshot", "join"]);
  });

  it("expands --matrix across backends and graphs", () => {
    expect(parseArgs(["--matrix", "--scenario", "users"])).toMatchObject({
      backends: ["memory", "fluid", "hocuspocus"],
      graphs: ["memory", "ladybug", "age"],
      scenarios: ["users"],
    });
  });

  it("parses Apache AGE graph", () => {
    expect(parseArgs(["--graph", "age", "--scenario", "writes", "--ops", "200"])).toMatchObject({
      graph: "age",
      graphs: ["age"],
      scenarios: ["writes"],
      ops: 200,
    });
  });

  it("parses fluid writes", () => {
    expect(
      parseArgs(["--", "--backend", "fluid", "--scenario", "writes", "--ops", "200", "--json"]),
    ).toMatchObject({
      backend: "fluid",
      scenarios: ["writes"],
      ops: 200,
      json: true,
    });
  });

  it("prints help", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpError);
  });
});

describe("report", () => {
  it("renders a table with a dash for missing ops/s", () => {
    const row: BenchRow = {
      scenario: "lag",
      backend: "memory",
      graph: "ladybug",
      opsPerSec: null,
      p50Ms: 0.04,
      p99Ms: 0.12,
      n: 500,
      errors: 0,
    };
    const table = formatTable([row]);
    expect(table).toContain("lag");
    expect(table).toContain("ladybug");
    expect(table).toContain("-");
    expect(table).toContain("0.04ms");
  });
});
