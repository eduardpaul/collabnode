import type { BackendName, GraphName, LatencyStats } from "./types.js";

export function nowNs(): bigint {
  return process.hrtime.bigint();
}

export function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sorted[lo]!;
  }
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}

export function latencyStats(samplesMs: number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const meanMs = n === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / n;
  return {
    n,
    p50Ms: quantile(sorted, 0.5),
    p99Ms: quantile(sorted, 0.99),
    p999Ms: quantile(sorted, 0.999),
    meanMs,
  };
}

export function opsPerSec(count: number, wallNs: bigint): number | null {
  if (count <= 0) {
    return null;
  }
  const seconds = Number(wallNs) / 1e9;
  if (seconds <= 0) {
    return null;
  }
  return count / seconds;
}

export function warmupCount(ops: number, requested = 50): number {
  if (ops <= 1) {
    return 0;
  }
  if (ops >= requested * 2) {
    return requested;
  }
  return Math.min(requested, Math.max(0, Math.floor(ops * 0.1)));
}

/** 1, 2, 4, ... max (always includes max). */
export function userLadder(max: number): number[] {
  const out: number[] = [];
  for (let n = 1; n < max; n *= 2) {
    out.push(n);
  }
  out.push(max);
  return out;
}

/** Size steps up to max (always includes max). */
export function sizeLadder(max: number): number[] {
  const steps = [100, 500, 2000, 5000, 10000];
  const out = steps.filter((step) => step < max);
  out.push(max);
  return out;
}

export function lagBudgetMs(backend: BackendName, graph: GraphName): number {
  if (backend === "fluid" || backend === "hocuspocus") {
    return 3_000;
  }
  if (graph === "age") {
    return 1_500;
  }
  if (graph === "ladybug") {
    return 500;
  }
  return 250;
}

export function lagTimeoutMs(backend: BackendName, graph: GraphName): number {
  if (backend === "fluid" || backend === "hocuspocus") {
    return 10_000;
  }
  if (graph === "age") {
    return 8_000;
  }
  if (graph === "ladybug") {
    return 3_000;
  }
  return 1_000;
}

export function settleMs(backend: BackendName, graph: GraphName = "memory"): number {
  if (backend === "fluid" || backend === "hocuspocus") {
    return 15_000;
  }
  if (graph === "age") {
    return 8_000;
  }
  return 1_000;
}
