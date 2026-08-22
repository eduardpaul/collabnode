import { describe, expect, it } from "vitest";
import { runBench } from "../src/run.ts";
import {
  ageAvailable,
  edgeCount,
  ladybugAvailable,
  loadBenchSchema,
  openWorld,
  taskCount,
  waitUntil,
} from "../src/setup.ts";
import { settleMs } from "../src/stats.ts";
import type { BackendName, BenchOptions, GraphName } from "../src/types.ts";

const hasLadybug = await ladybugAvailable();
const hasAge = await ageAvailable();

const COMBOS: { backend: BackendName; graph: GraphName }[] = [
  { backend: "memory", graph: "memory" },
  ...(hasLadybug ? [{ backend: "memory" as const, graph: "ladybug" as const }] : []),
  ...(hasAge ? [{ backend: "memory" as const, graph: "age" as const }] : []),
  { backend: "fluid", graph: "memory" },
  ...(hasLadybug ? [{ backend: "fluid" as const, graph: "ladybug" as const }] : []),
  ...(hasAge ? [{ backend: "fluid" as const, graph: "age" as const }] : []),
  { backend: "hocuspocus", graph: "memory" },
  ...(hasLadybug ? [{ backend: "hocuspocus" as const, graph: "ladybug" as const }] : []),
  ...(hasAge ? [{ backend: "hocuspocus" as const, graph: "age" as const }] : []),
];

function options(
  combo: { backend: BackendName; graph: GraphName },
  overrides: Partial<BenchOptions> = {},
): BenchOptions {
  return {
    backends: [combo.backend],
    graphs: [combo.graph],
    backend: combo.backend,
    graph: combo.graph,
    scenarios: ["users"],
    ops: 4,
    concurrency: 2,
    size: 12,
    json: true,
    port: combo.backend === "hocuspocus" ? 1234 : 7075,
    ...overrides,
  };
}

function timeoutFor(backend: BackendName, graph: GraphName): number {
  if (backend === "fluid" || backend === "hocuspocus") {
    return 90_000;
  }
  return graph === "age" ? 60_000 : 30_000;
}

describe.sequential("functional combinations", () => {
  for (const combo of COMBOS) {
    const label = `${combo.backend}+${combo.graph}`;

    describe(label, () => {
      it(
        "two users share nodes, BLOCKS edges, and queries",
        async () => {
          const schema = await loadBenchSchema();
          const world = await openWorld(options(combo), schema, "ada");
          try {
            const chidi = await world.joinPeer("chidi");
            await world.host.session.upsertNode({
              type: "Task",
              properties: { title: "Ada task", status: "todo" },
            });
            await chidi.session.upsertNode({
              type: "Task",
              properties: { title: "Chidi task", status: "doing" },
            });
            const tasksReady = await waitUntil(async () => {
              const ada = await taskCount(world.host);
              const other = await taskCount(chidi);
              return ada.snapshot >= 2 && ada.query >= 2 && other.snapshot >= 2 && other.query >= 2;
            }, settleMs(combo.backend, combo.graph));
            expect(tasksReady, `${label} both peers should query 2 tasks`).toBe(true);

            const adaId = world.host
              .session.snapshot()
              .nodes.find((node) => node.properties.title === "Ada task")?.id;
            const chidiId = world.host
              .session.snapshot()
              .nodes.find((node) => node.properties.title === "Chidi task")?.id;
            expect(adaId).toBeTruthy();
            expect(chidiId).toBeTruthy();
            await world.host.session.upsertEdge({
              type: "BLOCKS",
              from: adaId!,
              to: chidiId!,
            });
            const edgesReady = await waitUntil(async () => {
              const ada = await edgeCount(world.host);
              const other = await edgeCount(chidi);
              return ada.query >= 1 && other.query >= 1;
            }, settleMs(combo.backend, combo.graph));
            expect(edgesReady, `${label} both peers should query the BLOCKS edge`).toBe(true);
          } finally {
            await world.close();
          }
        },
        timeoutFor(combo.backend, combo.graph),
      );

      it(
        "concurrent-user ladder stays consistent",
        async () => {
          const users = combo.backend === "memory" && combo.graph === "memory" ? 4 : 2;
          const rows = await runBench(
            options(combo, { scenarios: ["users"], concurrency: users, ops: users * 2 }),
          );
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.scenario).toBe("users");
            expect(row.backend).toBe(combo.backend);
            expect(row.graph).toBe(combo.graph);
            expect(row.errors, row.detail ?? `${row.param} errors`).toBe(0);
            expect(row.ok, row.detail ?? `${row.param} not ok`).toBe(true);
          }
        },
        timeoutFor(combo.backend, combo.graph),
      );

      it(
        "graph-size limit still snapshots, queries, and joins",
        async () => {
          const size = combo.backend === "fluid" ? 8 : 20;
          const rows = await runBench(options(combo, { scenarios: ["limits"], size }));
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.scenario).toBe("limits");
            expect(row.errors, row.detail ?? `${row.param} errors`).toBe(0);
            expect(row.ok, row.detail ?? `${row.param} not ok`).toBe(true);
            expect(row.n).toBeGreaterThan(0);
          }
        },
        timeoutFor(combo.backend, combo.graph),
      );
    });
  }
});
