import type { Collabnode } from "collabnode";
import type { BenchOptions, BenchRow } from "../types.js";
import {
  lagBudgetMs,
  lagTimeoutMs,
  latencyStats,
  nowNs,
  nsToMs,
  opsPerSec,
  settleMs,
  userLadder,
} from "../stats.js";
import {
  loadBenchSchema,
  nextStatus,
  openWorld,
  taskCount,
  taskTitle,
  waitUntil,
  withTimeout,
  type World,
} from "../setup.js";

async function measureLag(
  writer: Collabnode,
  observer: Collabnode,
  title: string,
  timeoutMs: number,
): Promise<number> {
  let stop = (): void => {};
  const seen = new Promise<bigint>((resolve) => {
    stop = observer.session.onChange((ops) => {
      if (ops.some((op) => op.kind === "upsertNode" && op.properties.title === title)) {
        stop();
        resolve(nowNs());
      }
    });
  });
  const t0 = nowNs();
  try {
    await writer.session.upsertNode({
      type: "Task",
      properties: { title, status: "todo" },
    });
    const arrived = await withTimeout(seen, timeoutMs, `lag timeout waiting for "${title}"`);
    return nsToMs(arrived - t0);
  } finally {
    stop();
  }
}

export async function runUsers(options: BenchOptions): Promise<BenchRow[]> {
  const schema = await loadBenchSchema();
  const perUser = Math.max(1, Math.floor(options.ops / options.concurrency));
  const budget = lagBudgetMs(options.backend, options.graph);
  const timeoutMs = lagTimeoutMs(options.backend, options.graph);
  const rows: BenchRow[] = [];

  for (const users of userLadder(options.concurrency)) {
    let world: World | undefined;
    const samples: number[] = [];
    const lagSamples: number[] = [];
    let errors = 0;
    let detail: string | undefined;

    try {
      const opened = await openWorld(options, schema, "user-0");
      world = opened;
      const sessions: Collabnode[] = [opened.host];
      for (let i = 1; i < users; i += 1) {
        sessions.push(await opened.joinPeer(`user-${i}`));
      }
      const observer = sessions[sessions.length - 1]!;
      const expected = users * perUser;

      const wallStart = nowNs();
      await Promise.all(
        sessions.map(async (node, actor) => {
          for (let i = 0; i < perUser; i += 1) {
            const t0 = nowNs();
            try {
              await node.session.upsertNode({
                type: "Task",
                properties: {
                  title: taskTitle(`u${users}-${actor}`, i),
                  status: nextStatus(i),
                },
              });
              samples.push(nsToMs(nowNs() - t0));
            } catch {
              errors += 1;
            }
          }
        }),
      );
      const wall = nowNs() - wallStart;

      const settled = await waitUntil(async () => {
        const counts = await Promise.all(sessions.map(taskCount));
        return counts.every((count) => count.snapshot >= expected && count.query >= expected);
      }, settleMs(options.backend, options.graph));

      const counts = await Promise.all(sessions.map(taskCount));
      const mismatch = counts.filter(
        (count) => count.snapshot < expected || count.query < expected,
      ).length;
      if (!settled || mismatch > 0) {
        errors += 1;
        detail = `peers ${counts.map((c) => `${c.snapshot}/${c.query}`).join(",")} expected ${expected}`;
      }

      const lagN = Math.min(5, perUser);
      for (let i = 0; i < lagN; i += 1) {
        try {
          lagSamples.push(
            await measureLag(opened.host, observer, taskTitle(`lag-${users}`, i), timeoutMs),
          );
        } catch {
          errors += 1;
        }
      }

      const writeStats = latencyStats(samples);
      const lagStats = latencyStats(lagSamples);
      const lagOk = lagSamples.length > 0 && lagStats.p99Ms <= budget;
      const ok = errors === 0 && mismatch === 0 && lagOk;
      if (!ok && !detail) {
        detail = `lag p99 ${lagStats.p99Ms.toFixed(1)}ms budget ${budget}ms`;
      }

      rows.push({
        scenario: "users",
        backend: options.backend,
        graph: options.graph,
        opsPerSec: opsPerSec(samples.length, wall),
        p50Ms: lagStats.n > 0 ? lagStats.p50Ms : writeStats.p50Ms,
        p99Ms: lagStats.n > 0 ? lagStats.p99Ms : writeStats.p99Ms,
        n: samples.length,
        errors,
        param: `${users}u`,
        ok,
        detail,
      });
    } catch (error) {
      errors += 1;
      rows.push({
        scenario: "users",
        backend: options.backend,
        graph: options.graph,
        opsPerSec: null,
        p50Ms: 0,
        p99Ms: 0,
        n: samples.length,
        errors,
        param: `${users}u`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await world?.close();
    }
  }

  return rows;
}
