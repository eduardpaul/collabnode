export type BackendName = "memory" | "fluid" | "hocuspocus";
export type GraphName = "memory" | "ladybug" | "age";
export type ScenarioName =
  | "writes"
  | "concurrency"
  | "lag"
  | "snapshot"
  | "join"
  | "users"
  | "limits";

export const BACKENDS: BackendName[] = ["memory", "fluid", "hocuspocus"];
export const GRAPHS: GraphName[] = ["memory", "ladybug", "age"];
export const HOT_SCENARIOS: ScenarioName[] = ["writes", "concurrency", "lag", "snapshot", "join"];
export const SCENARIOS: ScenarioName[] = [...HOT_SCENARIOS, "users", "limits"];

export interface BenchOptions {
  backends: BackendName[];
  graphs: GraphName[];
  backend: BackendName;
  graph: GraphName;
  scenarios: ScenarioName[];
  ops: number;
  concurrency: number;
  size: number;
  json: boolean;
  port: number;
}

export interface BenchRow {
  scenario: ScenarioName;
  backend: BackendName;
  graph: GraphName;
  opsPerSec: number | null;
  p50Ms: number;
  p99Ms: number;
  n: number;
  errors: number;
  /** Concurrent writers (users) or seeded node count (limits). */
  param?: string;
  /** Functional budget met: no errors, peers agree, lag under SLA. */
  ok?: boolean;
  detail?: string;
}

export interface LatencyStats {
  n: number;
  p50Ms: number;
  p99Ms: number;
  p999Ms: number;
  meanMs: number;
}
