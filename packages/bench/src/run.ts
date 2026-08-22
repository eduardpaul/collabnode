import { runConcurrency } from "./scenarios/concurrency.js";
import { runJoin } from "./scenarios/join.js";
import { runLag } from "./scenarios/lag.js";
import { runLimits } from "./scenarios/limits.js";
import { runSnapshot } from "./scenarios/snapshot.js";
import { runUsers } from "./scenarios/users.js";
import { runWrites } from "./scenarios/writes.js";
import { ageAvailable, ladybugAvailable } from "./setup.js";
import type { BenchOptions, BenchRow, ScenarioName } from "./types.js";

type Runner = (options: BenchOptions) => Promise<BenchRow | BenchRow[]>;

const runners: Record<ScenarioName, Runner> = {
  writes: runWrites,
  concurrency: runConcurrency,
  lag: runLag,
  snapshot: runSnapshot,
  join: runJoin,
  users: runUsers,
  limits: runLimits,
};

export async function runBench(options: BenchOptions): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  let skippedLadybug = false;
  let skippedAge = false;
  for (const backend of options.backends) {
    for (const graph of options.graphs) {
      if (graph === "ladybug" && !(await ladybugAvailable())) {
        if (!skippedLadybug) {
          process.stderr.write("skip ladybug: @ladybugdb/core is not installed\n");
          skippedLadybug = true;
        }
        continue;
      }
      if (graph === "age" && !(await ageAvailable())) {
        if (!skippedAge) {
          process.stderr.write(
            "skip age: Apache AGE is not reachable (start an Apache AGE container)\n",
          );
          skippedAge = true;
        }
        continue;
      }
      const combo: BenchOptions = { ...options, backend, graph };
      for (const scenario of options.scenarios) {
        const result = await runners[scenario](combo);
        if (Array.isArray(result)) {
          rows.push(...result);
        } else {
          rows.push(result);
        }
      }
    }
  }
  return rows;
}
