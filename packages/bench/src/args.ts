import {
  BACKENDS,
  GRAPHS,
  HOT_SCENARIOS,
  SCENARIOS,
  type BackendName,
  type BenchOptions,
  type GraphName,
  type ScenarioName,
} from "./types.js";

export const USAGE = `collabnode-bench [flags]

Hot path: writes, concurrency, lag, snapshot, join.
Functional: users (concurrent-user ladder), limits (graph-size ladder).

Combinations:
  --backend memory|fluid|hocuspocus|all
                                 CRDT (default memory)
  --graph memory|ladybug|age|all projection store (default memory)
  --matrix                       shorthand for --backend all --graph all

Flags:
  --scenario <name>|all          writes|concurrency|lag|snapshot|join|users|limits
                                 (default: hot path; all includes users+limits)
  --ops <n>                      write iterations; for users = total ops at max
                                 concurrency, split per user (default 2000)
  --concurrency <n>              parallel actors / max users on the ladder (default 8)
  --size <n>                     seeded nodes / max size on the limits ladder (default 5000)
  --port <n>                     Fluid Tinylicious port (default 7070) or
                                 Hocuspocus port (default 1234)
  --json                         print JSON instead of a table
  --help

Users are "ok" when every peer's snapshot and query see all writes and lag p99
is under budget (memory 250ms, ladybug 500ms, age 1.5s, fluid/hocuspocus 3s). Limits are
"ok" when snapshot, query, and a joiner all see the seeded graph. Ladybug is
one local DB per peer in-process — a high --concurrency on --graph ladybug can
exhaust its buffer manager; that row is a functional limit, not a CRDT failure.
Apache AGE is one Postgres graph per peer (env AGE_HOST/AGE_PORT, default
127.0.0.1:5455). Start an Apache AGE container first; missing AGE is skipped.
`;

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseIntFlag(flag: string, value: string | undefined): number {
  const n = Number(requireValue(flag, value));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function parseScenario(value: string): ScenarioName[] {
  if (value === "all") {
    return [...SCENARIOS];
  }
  if (value === "hot") {
    return [...HOT_SCENARIOS];
  }
  const names = value.split(",").map((part) => part.trim()) as ScenarioName[];
  for (const name of names) {
    if (!SCENARIOS.includes(name)) {
      throw new Error(`unknown scenario '${name}'. Use ${SCENARIOS.join("|")}|all`);
    }
  }
  return names;
}

function parseList<T extends string>(flag: string, value: string, allowed: T[], all: T[]): T[] {
  if (value === "all") {
    return [...all];
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be ${allowed.join("|")}|all`);
  }
  return [value as T];
}

export function parseArgs(argv: string[]): BenchOptions {
  const args = argv[0] === "bench" ? argv.slice(1) : argv;
  const out: BenchOptions = {
    backends: ["memory"],
    graphs: ["memory"],
    backend: "memory",
    graph: "memory",
    scenarios: [...HOT_SCENARIOS],
    ops: 2000,
    concurrency: 8,
    size: 5000,
    json: false,
    port: 7070,
  };
  let portSet = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--") {
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new HelpError();
    }
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--matrix") {
      out.backends = [...BACKENDS];
      out.graphs = [...GRAPHS];
      out.backend = "memory";
      out.graph = "memory";
      continue;
    }
    if (token === "--backend") {
      const value = requireValue(token, args[++i]) as BackendName | "all";
      out.backends = parseList("--backend", value, BACKENDS, BACKENDS);
      out.backend = out.backends[0]!;
      continue;
    }
    if (token === "--graph") {
      const value = requireValue(token, args[++i]) as GraphName | "all";
      out.graphs = parseList("--graph", value, GRAPHS, GRAPHS);
      out.graph = out.graphs[0]!;
      continue;
    }
    if (token === "--scenario") {
      out.scenarios = parseScenario(requireValue(token, args[++i]));
      continue;
    }
    if (token === "--ops") {
      out.ops = parseIntFlag(token, args[++i]);
      continue;
    }
    if (token === "--concurrency") {
      out.concurrency = parseIntFlag(token, args[++i]);
      continue;
    }
    if (token === "--size") {
      out.size = parseIntFlag(token, args[++i]);
      continue;
    }
    if (token === "--port") {
      out.port = parseIntFlag(token, args[++i]);
      portSet = true;
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unknown flag ${token}`);
    }
    throw new Error(`unexpected argument ${token}`);
  }

  if (!portSet && out.backends.length === 1 && out.backends[0] === "hocuspocus") {
    out.port = 1234;
  }

  return out;
}

export class HelpError extends Error {
  constructor() {
    super(USAGE);
    this.name = "HelpError";
  }
}
